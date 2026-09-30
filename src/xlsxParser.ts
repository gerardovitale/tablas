import { ValueType, Workbook, type Cell, type CellValue, type Worksheet } from 'exceljs';
import {
  ColumnStatsAccumulator,
  DistinctBudget,
  exceedsStatsCellCap,
  reportStatsFailure,
  skippedStats,
  StatsCache,
  STATS_TOO_LARGE_REASON,
} from './columnStats';
import {
  clampMaxRows,
  type MultiTableData,
  type MultiTableParseOutcome,
  type ParsedTable,
  type ParseError,
  type TableRef,
  type TableStats,
} from './tableData';

// First 2 bytes of every ZIP archive -- .xlsx files are a ZIP (OOXML)
// package. Not xlsx-specific (any zip passes), but enough to turn "not a
// zip at all" into a clear error instead of an opaque exceljs XML-parsing
// exception, mirroring hasSqliteMagic's role in sqliteParser.ts.
function hasZipMagic(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x50 && bytes[1] === 0x4b; // 'PK'
}

/** Shared "nothing to show" table shape, mirroring sqliteParser.ts's emptyParsedTable. */
export function emptyParsedTable(): ParsedTable {
  return { headers: [], rows: [], rowCount: 0, columnCount: 0 };
}

/**
 * Stringify one exceljs cell into the string-only shape the webview renders.
 * Delegates to exceljs's own `cell.text`, which already formats dates per
 * the cell's number format, resolves formulas to their cached result,
 * flattens rich text, and renders error cells (#DIV/0! etc.) and hyperlinks
 * (link text) -- no manual type-switching needed, unlike parquetParser.ts's
 * stringifyCell.
 */
export function stringifyXlsxCell(cell: Cell): string {
  return cell.text ?? '';
}

/**
 * A cell's underlying value with formulas replaced by their cached result.
 * Two exceljs quirks drive the shape of this:
 * - `cell.value` and `effectiveType` both drop falsy formula results (0, false)
 *   and report Boolean/Error results as Null, so formulas read `cell.result`
 *   (the raw cached result) instead.
 * - A merged non-master cell has type Merge; `cell.master` is the cell that
 *   owns the value (and is the cell itself when unmerged).
 */
function unwrapCellValue(cell: Cell): CellValue {
  const source = cell.master;
  if (source.type === ValueType.Formula) {
    return (source.result as CellValue | undefined) ?? null;
  }
  return source.value;
}

function addXlsxCellToStats(acc: ColumnStatsAccumulator, cell: Cell | undefined): void {
  const value = cell ? unwrapCellValue(cell) : null;
  if (cell === undefined || value === null || value === undefined) {
    acc.addNull();
  } else if (typeof value === 'number') {
    acc.addNumber(value, Number.isInteger(value));
  } else if (typeof value === 'boolean') {
    acc.addBoolean(value);
  } else if (value instanceof Date) {
    // Format lazily so only new min/max candidates pay for cell.text.
    acc.addDate(value.getTime(), () => cell.text);
  } else if (typeof value === 'string') {
    if (value.trim() === '') {
      acc.addNull();
    } else {
      acc.addText(value);
    }
  } else if ('error' in value) {
    acc.addText(value.error);
  } else if ('richText' in value) {
    const text = value.richText.map((part) => part.text).join('');
    if (text.trim() === '') {
      acc.addNull();
    } else {
      acc.addText(text);
    }
  } else if ('hyperlink' in value) {
    acc.addText(String(value.text));
  } else {
    acc.addText(cell.text);
  }
}

// Worksheets are immutable for the document's lifetime (read-only viewer), so
// asking again for an already-computed sheet's stats reuses the answer.
const statsCache = new StatsCache<Worksheet>();

/**
 * Whole-sheet column statistics (data rows 2..rowCount, regardless of
 * `tablas.maxRows`), computed on demand from native cell values before
 * stringification. `undefined` = no stats (empty sheet, or an unexpected
 * failure, reported through `statsHooks`); it never throws, so a stats bug
 * can't break showing the table.
 */
export function xlsxSheetStats(worksheet: Worksheet): TableStats | undefined {
  const columnCount = worksheet.columnCount;
  if (worksheet.rowCount === 0 || columnCount === 0) {
    return undefined;
  }
  // rowCount is the last row that has values, header included.
  const dataRowCount = worksheet.rowCount - 1;
  if (exceedsStatsCellCap(dataRowCount, columnCount)) {
    return skippedStats(STATS_TOO_LARGE_REASON);
  }
  const cached = statsCache.lookup(worksheet, '');
  if (cached.hit) {
    return cached.stats;
  }
  try {
    const budget = new DistinctBudget();
    const accs: ColumnStatsAccumulator[] = [];
    for (let col = 1; col <= columnCount; col++) {
      accs.push(new ColumnStatsAccumulator({ budget }));
    }
    const lastRow = dataRowCount + 1;
    // findRow/findCell (not getRow/getCell) so sparse sheets don't allocate
    // an empty Row/Cell for every gap.
    for (let r = 2; r <= lastRow; r++) {
      const row = worksheet.findRow(r);
      for (let col = 1; col <= columnCount; col++) {
        addXlsxCellToStats(accs[col - 1], row?.findCell(col));
      }
    }
    for (let col = 1; col <= columnCount; col++) {
      const acc = accs[col - 1];
      if (!acc.histogramPlan()) {
        continue;
      }
      for (let r = 2; r <= lastRow; r++) {
        const cell = worksheet.findRow(r)?.findCell(col);
        const value = cell ? unwrapCellValue(cell) : null;
        if (typeof value === 'number') {
          acc.addHistogramValue(value);
        }
      }
    }
    const stats: TableStats = { columns: accs.map((acc) => acc.finalize()) };
    statsCache.store(worksheet, '', stats);
    return stats;
  } catch (err) {
    reportStatsFailure(err);
    statsCache.store(worksheet, '', undefined);
    return undefined;
  }
}

/**
 * Lists every sheet in a workbook, in workbook order. Includes
 * hidden/very-hidden sheets too -- this is a raw data viewer, not Excel's
 * UI, so there's no reason to hide data the file actually has. Sheets have
 * no table/view distinction, so every entry is typed 'table'.
 */
export function listXlsxSheets(workbook: Workbook): TableRef[] {
  return workbook.worksheets.map((ws) => ({ name: ws.name, type: 'table' as const }));
}

/** Reads one sheet's contents, honoring `maxRowsInput` the same way CSV/Parquet/SQLite do. */
export function readXlsxSheet(worksheet: Worksheet, maxRowsInput?: number): ParsedTable {
  const maxRows = clampMaxRows(maxRowsInput);
  const columnCount = worksheet.columnCount;
  if (worksheet.rowCount === 0 || columnCount === 0) {
    return emptyParsedTable();
  }

  const headerRow = worksheet.getRow(1);
  const headers: string[] = [];
  for (let col = 1; col <= columnCount; col++) {
    headers.push(stringifyXlsxCell(headerRow.getCell(col)));
  }

  // worksheet.rowCount is the row number of the last row with values,
  // including the header -- subtract 1 for the data-row total.
  const totalRowCount = worksheet.rowCount - 1;
  const lastRow =
    maxRows != null ? Math.min(worksheet.rowCount, 1 + maxRows) : worksheet.rowCount;

  const rows: string[][] = [];
  for (let r = 2; r <= lastRow; r++) {
    const row = worksheet.getRow(r);
    const cells: string[] = [];
    for (let col = 1; col <= columnCount; col++) {
      cells.push(stringifyXlsxCell(row.getCell(col)));
    }
    rows.push(cells);
  }

  return { headers, rows, rowCount: rows.length, columnCount, totalRowCount };
}

/**
 * Selects a sheet (falling back to the first one, in workbook order, if
 * `desiredSheet` is unset or doesn't exist) and reads it, wrapping the
 * result in the `MultiTableData` shape shared by every multi-table source --
 * mirrors sqliteParser.ts's readSelectedTable.
 */
export function readSelectedSheet(
  workbook: Workbook,
  tables: TableRef[],
  desiredSheet: string | undefined,
  maxRowsInput?: number
): MultiTableData {
  if (tables.length === 0) {
    return { tables: [], selectedTable: '', data: emptyParsedTable() };
  }
  const target =
    desiredSheet && tables.some((t) => t.name === desiredSheet) ? desiredSheet : tables[0].name;
  const worksheet = workbook.getWorksheet(target);
  const data = worksheet ? readXlsxSheet(worksheet, maxRowsInput) : emptyParsedTable();
  return { tables, selectedTable: target, data };
}

/** Opens an XLSX workbook from raw file bytes, sniffing the ZIP header first. */
export async function openXlsxWorkbook(
  bytes: Uint8Array
): Promise<{ workbook: Workbook } | { error: ParseError }> {
  if (!hasZipMagic(bytes)) {
    return {
      error: {
        type: 'XlsxError',
        code: 'NotAnXlsxFile',
        message: 'File does not look like an XLSX workbook (missing ZIP header).',
      },
    };
  }
  try {
    const workbook = new Workbook();
    // exceljs's own .d.ts declares an ambient, non-generic
    // `Buffer extends ArrayBuffer` interface that merges with (and
    // conflicts with) @types/node's generic `Buffer<ArrayBufferLike>`, so a
    // real Node Buffer -- exactly what `load` expects at runtime -- no
    // longer type-checks against its own declared parameter type. `as any`
    // sidesteps the two ambient declarations fighting each other rather
    // than a real type mismatch.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await workbook.xlsx.load(Buffer.from(bytes) as any);
    return { workbook };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: { type: 'XlsxError', code: 'OpenFailed', message } };
  }
}

/**
 * One-shot convenience wrapper used by tests and any caller that doesn't
 * need to keep the workbook around across multiple sheet selections. The
 * editor provider keeps its own long-lived parsed `Workbook` instead (see
 * xlsxEditorProvider.ts) so switching sheets re-reads the already-parsed
 * workbook rather than re-parsing the file on every selection.
 */
export async function parseXlsx(
  bytes: Uint8Array,
  maxRowsInput?: number,
  selectedSheet?: string
): Promise<MultiTableParseOutcome> {
  if (bytes.byteLength === 0) {
    return {
      success: true,
      data: { tables: [], selectedTable: '', data: emptyParsedTable() },
      errors: [],
    };
  }

  const opened = await openXlsxWorkbook(bytes);
  if ('error' in opened) {
    return { success: false, errors: [opened.error] };
  }

  try {
    const tables = listXlsxSheets(opened.workbook);
    const data = readSelectedSheet(opened.workbook, tables, selectedSheet, maxRowsInput);
    return { success: true, data, errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, errors: [{ type: 'XlsxError', code: 'ReadFailed', message }] };
  }
}
