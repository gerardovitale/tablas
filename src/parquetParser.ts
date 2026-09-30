// hyparquet is ESM-only; the resolution-mode attribute lets this CJS file
// import its types (the runtime import stays the dynamic import() below).
import type {
  AsyncBuffer,
  FileMetaData,
  SchemaTree,
} from 'hyparquet' with { 'resolution-mode': 'import' };
import {
  ColumnStatsAccumulator,
  DistinctBudget,
  exceedsStatsCellCap,
  reportStatsFailure,
  skippedStats,
  STATS_TOO_LARGE_REASON,
} from './columnStats';
import {
  bigIntToSafeNumber,
  clampMaxRows,
  type ColumnKind,
  type ParsedTable,
  type ParseError,
  type TableParseOutcome,
  type TableStats,
} from './tableData';

export type ParsedParquet = ParsedTable;
export type { ParseError };
export type ParquetParseOutcome = TableParseOutcome;

/**
 * Stringify one decoded Parquet cell into the string-only shape the webview
 * renders. Struct/list/map values are flattened into a single JSON cell
 * rather than expanded into extra columns, since lists vary in length and
 * struct fields are optional per row -- expansion would break the
 * fixed-headers/rectangular-table invariant.
 */
export function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'object') {
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v));
  }
  return String(value);
}

// Avoids an unnecessary full-file copy in the common case (the backing
// buffer is already a plain ArrayBuffer spanning the whole view, true for
// virtually every vscode.workspace.fs.readFile result). Falls back to a
// copy only when the view is a slice of a larger buffer or backed by a
// SharedArrayBuffer -- the `instanceof ArrayBuffer` check is what makes
// returning `bytes.buffer` directly type-safe in the common branch.
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (
    bytes.byteOffset === 0 &&
    bytes.byteLength === bytes.buffer.byteLength &&
    bytes.buffer instanceof ArrayBuffer
  ) {
    return bytes.buffer;
  }
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * Column kind implied by the schema alone. Only used as the fallback type for
 * columns that turn out to hold no values (zero rows, or all null); any
 * column with values is typed from the values themselves.
 */
export function declaredKind(column: SchemaTree): ColumnKind {
  const { element, children } = column;
  if (children.length > 0 || element.repetition_type === 'REPEATED') {
    return 'other'; // struct / list / map
  }
  const logical = element.logical_type?.type;
  const converted = element.converted_type;
  if (logical === 'DECIMAL' || converted === 'DECIMAL' || logical === 'FLOAT16') {
    return 'float';
  }
  if (logical === 'DATE' || logical === 'TIMESTAMP' || converted === 'DATE' ||
      converted === 'TIMESTAMP_MILLIS' || converted === 'TIMESTAMP_MICROS') {
    return 'date';
  }
  if (logical === 'JSON' || logical === 'BSON' || converted === 'JSON' || converted === 'BSON' ||
      logical === 'TIME' || converted === 'TIME_MILLIS' || converted === 'TIME_MICROS') {
    return 'other';
  }
  switch (element.type) {
    case 'BOOLEAN':
      return 'boolean';
    case 'INT32':
    case 'INT64':
      return 'integer';
    case 'FLOAT':
    case 'DOUBLE':
      return 'float';
    case 'INT96':
      return 'date';
    case 'BYTE_ARRAY':
      return 'text';
    default:
      return logical === 'UUID' ? 'text' : 'other'; // FIXED_LEN_BYTE_ARRAY
  }
}

function addParquetValue(acc: ColumnStatsAccumulator, value: unknown, declared: ColumnKind): void {
  if (value === null || value === undefined) {
    acc.addNull();
  } else if (typeof value === 'bigint') {
    const n = Number(value);
    // Keep the exact text only where Number() would have rounded it.
    acc.addNumber(n, true, Number.isSafeInteger(n) ? undefined : value.toString());
  } else if (typeof value === 'number') {
    acc.addNumber(value, declared === 'integer');
  } else if (typeof value === 'boolean') {
    acc.addBoolean(value);
  } else if (value instanceof Date) {
    acc.addDate(value.getTime()); // ISO display, same as stringifyCell
  } else if (typeof value === 'string') {
    acc.addText(value);
  } else {
    acc.addOther(); // nested / binary
  }
}

type ReadObjects = (options: {
  file: AsyncBuffer;
  metadata: FileMetaData;
  rowStart: number;
  rowEnd: number;
  columns?: string[];
}) => Promise<Record<string, unknown>[]>;

/**
 * Whole-file stats, decoded one row group at a time so peak memory stays at a
 * row group rather than the whole table, yielding to the extension host's
 * event loop between groups. Pass 1 gathers type/min/max/mean/distinct; pass 2
 * re-reads only the numeric columns to bucket the histogram. Footer
 * `statistics` are deliberately unused: distinct/mean/histogram need the data
 * anyway, and one code path is simpler than merging two.
 */
async function computeParquetStats(
  readObjects: ReadObjects,
  file: AsyncBuffer,
  metadata: FileMetaData,
  columns: SchemaTree[],
  totalRows: number
): Promise<TableStats | undefined> {
  if (columns.length === 0) {
    return undefined;
  }
  if (exceedsStatsCellCap(totalRows, columns.length)) {
    return skippedStats(STATS_TOO_LARGE_REASON);
  }
  try {
    const names = columns.map((c) => c.element.name);
    const declared = columns.map(declaredKind);
    const budget = new DistinctBudget();
    const accs = declared.map((kind) => new ColumnStatsAccumulator({ declared: kind, budget }));

    const forEachRowGroup = async (
      readColumns: string[] | undefined,
      visit: (rows: Record<string, unknown>[]) => void
    ): Promise<void> => {
      let groupStart = 0;
      for (const group of metadata.row_groups) {
        const groupRows = bigIntToSafeNumber(group.num_rows);
        if (groupRows > 0) {
          const rows = await readObjects({
            file,
            metadata,
            rowStart: groupStart,
            rowEnd: groupStart + groupRows,
            columns: readColumns,
          });
          visit(rows);
        }
        groupStart += groupRows;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
    };

    await forEachRowGroup(undefined, (rows) => {
      for (const row of rows) {
        for (let c = 0; c < names.length; c++) {
          addParquetValue(accs[c], row[names[c]], declared[c]);
        }
      }
    });

    const numeric = accs.map((acc, c) => (acc.histogramPlan() ? c : -1)).filter((c) => c >= 0);
    if (numeric.length > 0) {
      await forEachRowGroup(
        numeric.map((c) => names[c]),
        (rows) => {
          for (const row of rows) {
            for (const c of numeric) {
              const value = row[names[c]];
              if (typeof value === 'number') {
                accs[c].addHistogramValue(value);
              } else if (typeof value === 'bigint') {
                accs[c].addHistogramValue(Number(value));
              }
            }
          }
        }
      );
    }
    return { columns: accs.map((acc) => acc.finalize()) };
  } catch (err) {
    // A stats failure must never break showing the table.
    reportStatsFailure(err);
    return undefined;
  }
}

/**
 * Whole-file column statistics, computed on demand (the editor re-reads the
 * file when the user first opens the Statistics view, so this takes the raw
 * bytes and re-derives the footer/schema itself -- parsing a footer is
 * cheap). `undefined` = no stats (empty input, no columns, or a failure,
 * reported through `statsHooks`); it never throws.
 */
export async function parquetStats(bytes: Uint8Array): Promise<TableStats | undefined> {
  if (bytes.byteLength === 0) {
    return undefined;
  }
  try {
    const { parquetMetadataAsync, parquetReadObjects, parquetSchema } = await import('hyparquet');
    const file = toArrayBuffer(bytes);
    const metadata = await parquetMetadataAsync(file);
    const schema = parquetSchema(metadata);
    return await computeParquetStats(
      parquetReadObjects as ReadObjects,
      file,
      metadata,
      schema.children,
      bigIntToSafeNumber(metadata.num_rows)
    );
  } catch (err) {
    reportStatsFailure(err);
    return undefined;
  }
}

export async function parseParquet(
  bytes: Uint8Array,
  maxRowsInput?: number
): Promise<ParquetParseOutcome> {
  const maxRows = clampMaxRows(maxRowsInput);
  if (bytes.byteLength === 0) {
    return {
      success: true,
      data: { headers: [], rows: [], rowCount: 0, columnCount: 0 },
      errors: [],
    };
  }

  try {
    // hyparquet is ESM-only; dynamic import() is TS's recommended way to
    // consume it from this CommonJS file.
    const { parquetMetadataAsync, parquetReadObjects, parquetSchema } = await import(
      'hyparquet'
    );
    // A plain ArrayBuffer structurally satisfies hyparquet's AsyncBuffer
    // interface ({byteLength, slice(start, end?)}), so no asyncBufferFromFile
    // wrapper is needed for bytes already in memory.
    const file = toArrayBuffer(bytes);
    const metadata = await parquetMetadataAsync(file);
    const schema = parquetSchema(metadata);
    // Headers from the schema tree, not Object.keys(row) -- the latter
    // breaks for 0-row files (mirrors csvParser's use of result.meta?.fields).
    const headers: string[] = schema.children.map((child) => child.element.name);

    // metadata.num_rows is a bigint; hyparquet's rowStart/rowEnd are plain
    // numbers, so this also bounds the row count read below.
    const totalRows = bigIntToSafeNumber(metadata.num_rows);
    const rowEnd = maxRows != null ? Math.min(maxRows, totalRows) : totalRows;

    // rowStart/rowEnd caps how many rows hyparquet decodes at all -- the
    // actual perf win, not just a slice of an already-fully-decoded result.
    const objectRows = await parquetReadObjects({ file, metadata, rowStart: 0, rowEnd });
    const rows: string[][] = objectRows.map((row) =>
      headers.map((h) => stringifyCell(row[h]))
    );

    return {
      success: true,
      data: {
        headers,
        rows,
        rowCount: rows.length,
        columnCount: headers.length,
        totalRowCount: totalRows,
      },
      errors: [],
    };
  } catch (err) {
    // hyparquet has no partial-success-with-warnings outcome -- a read
    // either resolves cleanly or rejects (bad footers, corrupt data, or an
    // unsupported codec like GZip/ZSTD -- hyparquet only decompresses
    // UNCOMPRESSED/Snappy), so a single catch is the correct mirror.
    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      errors: [{ type: 'ParquetError', code: 'ParseFailed', message }],
    };
  }
}
