import { filterLimits } from './filter';

/**
 * The column-filter protocol between an editor's webview and its provider.
 * The webview sends the filter text exactly as the user typed it; the host
 * parses it (see filter.ts), runs it over the whole table and answers with the
 * first `tablas.maxRows` matching rows plus the exact match count.
 *
 * Kept free of any `vscode` import so it can be unit-tested from `test/unit/`.
 */

/** One column's filter box. `column` is a 0-based index into the table's headers. */
export interface FilterRequest {
  column: number;
  text: string;
}

/**
 * webview -> host. `table` is the selected table/sheet, omitted for CSV/Parquet.
 * `seq` is one counter per webview; a newer request supersedes older ones. An
 * empty `filters` array means "all filters cleared" -- the host only uses it to
 * release anything it cached, and does not answer.
 */
export interface FilterMessage {
  type: 'filter';
  seq: number;
  table?: string;
  filters: FilterRequest[];
}

/** A filter box whose text could not be understood. */
export interface FilterError {
  column: number;
  message: string;
}

/**
 * The answer. `seq` and `table` echo the request so the webview can drop a
 * reply that was overtaken by a newer request or by a table switch. Exactly
 * one of these shapes is used:
 * - `rows` + `matchCount`: success. `rows` holds at most `tablas.maxRows`
 *   matches; `matchCount` is the exact total.
 * - `errors`: at least one filter text was invalid; nothing was run.
 * - `failedReason`: the filter could not be run (too large, timed out, failed).
 */
export interface FilterPayload {
  seq: number;
  table?: string;
  rows?: string[][];
  matchCount?: number;
  errors?: FilterError[];
  failedReason?: string;
}

/** host -> webview. */
export interface FilterDataMessage {
  type: 'filter-data';
  payload: FilterPayload;
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * True for a well-formed `filter` request: integer `seq`, `table` (when
 * present) a string, and `filters` an array of {integer column, string text of
 * at most `filterLimits.maxTextLength` characters} with no column repeated.
 * Whether a column exists in the table is the host's business, not this guard's.
 */
export function isFilterMessage(message: unknown): message is FilterMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as { type?: unknown; seq?: unknown; table?: unknown; filters?: unknown };
  if (candidate.type !== 'filter' || !isIndex(candidate.seq)) {
    return false;
  }
  if (candidate.table !== undefined && typeof candidate.table !== 'string') {
    return false;
  }
  if (!Array.isArray(candidate.filters)) {
    return false;
  }
  const seen = new Set<number>();
  for (const entry of candidate.filters as unknown[]) {
    if (typeof entry !== 'object' || entry === null) {
      return false;
    }
    const { column, text } = entry as { column?: unknown; text?: unknown };
    if (!isIndex(column) || typeof text !== 'string' || text.length > filterLimits.maxTextLength) {
      return false;
    }
    if (seen.has(column)) {
      return false;
    }
    seen.add(column);
  }
  return true;
}

export function filterDataMessage(payload: FilterPayload): FilterDataMessage {
  return { type: 'filter-data', payload };
}
