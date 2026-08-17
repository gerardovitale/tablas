import {
  bigIntToSafeNumber,
  clampMaxRows,
  type ParsedTable,
  type ParseError,
  type TableParseOutcome,
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
