import { statsHooks } from './columnStats';
import type { FilterError, FilterMessage, FilterPayload, FilterRequest } from './filterMessage';

/**
 * Column filtering engine shared by every format. Kept free of any `vscode`
 * import so it can be unit-tested from `test/unit/`.
 *
 * A filter box holds one small expression, evaluated against the cell's
 * *displayed text* (every parser already maps NULL to `''`):
 *
 *   abc      contains, case-insensitive          !abc     does not contain
 *   =abc     equals exactly (case-sensitive)     !=abc    does not equal
 *   =        cell is empty                       !=       cell is not empty
 *   >x >=x <x <=x   numeric compare when `x` is a number (cells that are not
 *            numbers never match). When `x` is a day (exactly `YYYY-MM-DD`),
 *            a date compare at day precision: only cells that start with an
 *            ISO date (`2024-01-01`, `2024-01-01 10:30:00`,
 *            `2024-01-01T00:00:00.000Z`) take part, compared by their first 10
 *            characters -- so `<=2024-01-01` keeps every time on that day --
 *            and any other cell never matches. Any other `x` is a string
 *            compare by code unit. Empty cells never match.
 *   \...     a leading backslash makes the rest a literal "contains"
 *
 * There is deliberately no regex operator: user input never reaches a regex
 * engine on the host, so there is no ReDoS surface.
 */

/**
 * Mutable so tests can drive the "too large" and "timed out" paths without
 * huge fixtures. Production code never writes to it.
 */
export const filterLimits = {
  /** rows x columns above which CSV/XLSX/Parquet filtering refuses (same as the stats cap). */
  maxCells: 20_000_000,
  /**
   * Tables up to this many cells keep their parsed string rows on the document
   * while a filter is active, so typing in a filter box doesn't re-parse the
   * file on every keystroke. Larger ones are re-parsed per request.
   */
  maxCachedCells: 5_000_000,
  /**
   * SQLite filters run a JS callback per row on sql.js, which is synchronous
   * and uninterruptible on the shared extension-host thread. Cap on rows x
   * filtered columns; above it the filter is refused. Measured at roughly
   * 0.15-0.3 us per predicate call (1M rows x 3 filtered columns: ~0.4 s), so
   * 5M is ~1.3 s worst case -- lower than the stats budget because a filter
   * re-runs as the user types.
   */
  sqliteMaxCells: 5_000_000,
  /** Wall-clock budget for DuckDB's filter queries before they're interrupted. */
  duckdbTimeoutMs: 15_000,
  /** Longest filter text accepted from the webview. */
  maxTextLength: 1000,
};

export const FILTER_TOO_LARGE_REASON = 'Table is too large to filter.';
export const FILTER_TIMED_OUT_REASON = 'Filtering timed out.';
export const FILTER_FAILED_REASON = 'Filtering failed for this table.';
export const FILTER_UNKNOWN_TABLE_REASON = 'This table is not available to filter.';
export const FILTER_UNKNOWN_COLUMN_REASON = 'Filter refers to a column this table does not have.';

export type FilterOp =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEquals'
  | 'empty'
  | 'notEmpty'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte';

export type CompareOp = 'gt' | 'gte' | 'lt' | 'lte';

/** A parsed filter box. `value` is the operand exactly as written (unused for empty/notEmpty). */
export interface ColumnFilter {
  op: FilterOp;
  value: string;
}

/** A filter bound to a column. */
export interface ColumnFilterSpec {
  column: number;
  filter: ColumnFilter;
}

/** What every format's filter entry point returns on success. */
export interface FilterResult {
  rows: string[][];
  matchCount: number;
}

/** What every format's filter entry point returns: a result, or why there isn't one. Never throws. */
export type FilterOutcome = FilterResult | { failedReason: string };

export function isFailedFilter(outcome: FilterOutcome): outcome is { failedReason: string } {
  return 'failedReason' in outcome;
}

/**
 * Numbers are recognised with one pattern everywhere (the JS engine here, and
 * DuckDB through RE2 -- see duckdbParser.ts). Leading zeros are allowed,
 * thousands separators and hex are not.
 */
export const NUMBER_PATTERN = '^[+-]?([0-9]+(\\.[0-9]*)?|\\.[0-9]+)([eE][+-]?[0-9]+)?$';
const NUMBER_RE = new RegExp(NUMBER_PATTERN);

/**
 * A cell that starts with an ISO day, followed by the end of the text or a
 * date/time separator. Deliberately matched on the untrimmed text so the JS
 * engine and DuckDB's RE2 agree (SQL `trim()` strips only spaces). Shared with
 * DuckDB the way `NUMBER_PATTERN` is -- see duckdbParser.ts.
 */
export const ISO_DATE_PREFIX_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}([T ]|$)';
const ISO_DATE_PREFIX_RE = new RegExp(ISO_DATE_PREFIX_PATTERN);
const ISO_DAY_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
/** How many leading characters of a cell make up its `YYYY-MM-DD` day. Also used by DuckDB's SQL mirror. */
export const ISO_DAY_LENGTH = 10;

/** True when a comparison operand is exactly a `YYYY-MM-DD` day (not calendar-validated). */
export function isIsoDateOperand(value: string): boolean {
  return ISO_DAY_RE.test(value);
}

/** The numeric value of `text` (surrounding whitespace ignored), or undefined if it isn't a finite number. */
export function parseNumber(text: string): number | undefined {
  const trimmed = text.trim();
  if (!NUMBER_RE.test(trimmed)) {
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

const COMPARE_OPERATORS: ReadonlyArray<readonly [string, CompareOp]> = [
  ['>=', 'gte'],
  ['<=', 'lte'],
  ['>', 'gt'],
  ['<', 'lt'],
];

/**
 * Parses one filter box. `text` is trimmed first; empty text is not a filter
 * (callers drop it before getting here -- see `resolveFilters`). The only
 * error is a comparison operator with nothing after it.
 */
export function parseColumnFilter(text: string): { filter: ColumnFilter } | { error: string } {
  const t = text.trim();
  if (t === '') {
    return { error: 'Filter is empty.' };
  }
  if (t.startsWith('\\')) {
    return { filter: { op: 'contains', value: t.slice(1) } };
  }
  if (t.startsWith('!=')) {
    const rest = t.slice(2);
    return { filter: rest === '' ? { op: 'notEmpty', value: '' } : { op: 'notEquals', value: rest } };
  }
  if (t.startsWith('=')) {
    const rest = t.slice(1);
    return { filter: rest === '' ? { op: 'empty', value: '' } : { op: 'equals', value: rest } };
  }
  for (const [symbol, op] of COMPARE_OPERATORS) {
    if (t.startsWith(symbol)) {
      const rest = t.slice(symbol.length).trim();
      if (rest === '') {
        return { error: `"${symbol}" needs a value after it.` };
      }
      return { filter: { op, value: rest } };
    }
  }
  // A lone "!" has nothing to negate: search for the character itself.
  if (t.startsWith('!') && t.length > 1) {
    return { filter: { op: 'notContains', value: t.slice(1) } };
  }
  return { filter: { op: 'contains', value: t } };
}

function compareNumbers(op: CompareOp, a: number, b: number): boolean {
  switch (op) {
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    default:
      return a <= b;
  }
}

function compareStrings(op: CompareOp, a: string, b: string): boolean {
  switch (op) {
    case 'gt':
      return a > b;
    case 'gte':
      return a >= b;
    case 'lt':
      return a < b;
    default:
      return a <= b;
  }
}

/** Turns a parsed filter into a function over one cell's text. */
export function compileCellPredicate(filter: ColumnFilter): (cell: string) => boolean {
  const { op, value } = filter;
  switch (op) {
    case 'contains': {
      const needle = value.toLowerCase();
      return (cell) => cell.toLowerCase().includes(needle);
    }
    case 'notContains': {
      const needle = value.toLowerCase();
      return (cell) => !cell.toLowerCase().includes(needle);
    }
    case 'equals':
      return (cell) => cell === value;
    case 'notEquals':
      return (cell) => cell !== value;
    case 'empty':
      return (cell) => cell.trim() === '';
    case 'notEmpty':
      return (cell) => cell.trim() !== '';
    default: {
      const operand = parseNumber(value);
      if (operand !== undefined) {
        return (cell) => {
          const n = parseNumber(cell);
          return n !== undefined && compareNumbers(op, n, operand);
        };
      }
      if (isIsoDateOperand(value)) {
        return (cell) =>
          ISO_DATE_PREFIX_RE.test(cell) && compareStrings(op, cell.slice(0, ISO_DAY_LENGTH), value);
      }
      return (cell) => cell.trim() !== '' && compareStrings(op, cell, value);
    }
  }
}

/**
 * Parses the webview's filter boxes: blank boxes are dropped (no filter), the
 * rest are parsed. Either every box was understood (`specs`, possibly empty =
 * "no filtering") or at least one wasn't (`errors`, one per bad box) -- never
 * a partial run on a half-understood request.
 */
export function resolveFilters(
  requests: readonly FilterRequest[]
): { specs: ColumnFilterSpec[] } | { errors: FilterError[] } {
  const specs: ColumnFilterSpec[] = [];
  const errors: FilterError[] = [];
  for (const { column, text } of requests) {
    if (text.trim() === '') {
      continue;
    }
    const parsed = parseColumnFilter(text);
    if ('error' in parsed) {
      errors.push({ column, message: parsed.error });
    } else {
      specs.push({ column, filter: parsed.filter });
    }
  }
  return errors.length > 0 ? { errors } : { specs };
}

/** True when some spec names a column the table doesn't have. */
export function hasUnknownColumn(specs: readonly ColumnFilterSpec[], columnCount: number): boolean {
  return specs.some((spec) => spec.column >= columnCount);
}

/**
 * Filters already-stringified rows: one pass, AND across columns, keeping the
 * first `maxRows` matches and counting the rest. A spec for a column the table
 * doesn't have is the caller's bug to check (`hasUnknownColumn`); here it sees
 * `undefined` and so never matches.
 */
export function filterStringRows(
  rows: readonly string[][],
  specs: readonly ColumnFilterSpec[],
  maxRows: number
): FilterResult {
  const tests = specs.map((spec) => ({ column: spec.column, test: compileCellPredicate(spec.filter) }));
  const matched: string[][] = [];
  let matchCount = 0;
  for (const row of rows) {
    let ok = true;
    for (const { column, test } of tests) {
      if (!test(row[column] ?? '')) {
        ok = false;
        break;
      }
    }
    if (ok) {
      matchCount++;
      if (matched.length < maxRows) {
        matched.push(row);
      }
    }
  }
  return { rows: matched, matchCount };
}

/**
 * Filtering is best-effort like statistics: an unexpected failure is reported
 * here (so a real bug leaves a trace) and shown to the user as a failed
 * filter, never thrown. Goes through `statsHooks.log` so tests can silence or
 * observe it the same way.
 */
export function reportFilterFailure(err: unknown): void {
  statsHooks.log('[tablas] column filter failed:', err);
}

/** A table whose cells are already strings (CSV, Parquet, XLSX once parsed). */
export interface FilterableRows {
  columnCount: number;
  rows: string[][];
}

export function exceedsFilterCellCap(
  rowCount: number,
  columnCount: number,
  maxCells: number = filterLimits.maxCells
): boolean {
  return rowCount * columnCount > maxCells;
}

/** Whether a parsed table is small enough to keep on the document between keystrokes. */
export function fitsFilterCache(table: FilterableRows): boolean {
  return table.rows.length * table.columnCount <= filterLimits.maxCachedCells;
}

/** Filters a string table, refusing a filter on a column it doesn't have. */
export function filterTable(
  table: FilterableRows,
  specs: readonly ColumnFilterSpec[],
  maxRows: number
): FilterOutcome {
  if (hasUnknownColumn(specs, table.columnCount)) {
    return { failedReason: FILTER_UNKNOWN_COLUMN_REASON };
  }
  return filterStringRows(table.rows, specs, maxRows);
}

/**
 * What a provider does with a `filter` request, decided once for all formats:
 * `cleared` (nothing to filter -- release any cache, send no reply), `invalid`
 * (some box couldn't be parsed -- send this reply, run nothing) or `run`.
 */
export type FilterPlan =
  | { kind: 'cleared' }
  | { kind: 'invalid'; payload: FilterPayload }
  | { kind: 'run'; specs: ColumnFilterSpec[] };

export function planFilter(message: FilterMessage): FilterPlan {
  const resolved = resolveFilters(message.filters);
  if ('errors' in resolved) {
    return { kind: 'invalid', payload: filterErrorPayload(message, resolved.errors) };
  }
  return resolved.specs.length === 0 ? { kind: 'cleared' } : { kind: 'run', specs: resolved.specs };
}

/** Wraps an outcome into the reply for `message`, echoing its `seq` and `table`. */
export function filterPayload(message: FilterMessage, outcome: FilterOutcome): FilterPayload {
  const base: FilterPayload = { seq: message.seq };
  if (message.table !== undefined) {
    base.table = message.table;
  }
  return isFailedFilter(outcome)
    ? { ...base, failedReason: outcome.failedReason }
    : { ...base, rows: outcome.rows, matchCount: outcome.matchCount };
}

/** The reply for a request that held invalid filter texts. */
export function filterErrorPayload(message: FilterMessage, errors: FilterError[]): FilterPayload {
  const base: FilterPayload = { seq: message.seq };
  if (message.table !== undefined) {
    base.table = message.table;
  }
  return { ...base, errors };
}
