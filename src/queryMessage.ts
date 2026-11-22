import type { ParsedTable } from './tableData';

/**
 * The ad-hoc SQL protocol between the DuckDB webview and its provider. The
 * webview sends the text exactly as typed; the host checks it only runs reads
 * (see `duckdbRunQuery`), runs it, and answers with at most `tablas.maxRows`
 * rows. `seq` is one counter per webview: a reply is only applied if it carries
 * the newest number, and a request that a newer one overtook while queued is
 * never run.
 *
 * Kept free of any `vscode` import so it can be unit-tested from `test/unit/`.
 */

/** webview -> host. */
export interface RunQueryMessage {
  type: 'run-query';
  seq: number;
  sql: string;
}

/** Shown (as a stats/filter failure) when a result was dropped: a newer run, a reload or a close. */
export const RESULT_GONE_REASON = 'This result is no longer available; run the query again.';

/**
 * What running a query produced; `error` is text for the user, never a stack.
 *
 * A result that has columns is also kept by the host as a table (`result`, the
 * `run-query` seq that made it), so the table-keyed `get-stats`/`filter` requests
 * can address it. `materializedRows` is how many rows that table holds: all of
 * them, or the first `queryLimits.maxResultRows`+ when `capped` (the query had
 * more). `truncated` is the older, simpler fact: the query had more rows than
 * `data` carries. A result without `result` is rows only (no table could be made).
 */
export type QueryOutcome =
  | {
      data: ParsedTable;
      truncated: boolean;
      elapsedMs: number;
      result?: number;
      materializedRows?: number;
      capped?: boolean;
    }
  | { error: string };

/**
 * The answer, echoing `seq`. Exactly one of `data` (with `truncated`, true when
 * the query had more rows than `tablas.maxRows`, and `elapsedMs`) or `error`.
 */
export interface QueryPayload {
  seq: number;
  data?: ParsedTable;
  truncated?: boolean;
  elapsedMs?: number;
  /** The `seq` the host keeps this result's table under; absent = rows only, no stats/filters. */
  result?: number;
  /** Rows in that table (the whole result, or the first N when `capped`). */
  materializedRows?: number;
  /** The query had more rows than the table holds. */
  capped?: boolean;
  error?: string;
}

/** webview -> host: the result with this `seq` is no longer shown, so its table can go. */
export interface CloseResultMessage {
  type: 'close-result';
  seq: number;
}

/** host -> webview. */
export interface QueryDataMessage {
  type: 'query-data';
  payload: QueryPayload;
}

/** True for a well-formed `run-query`: a non-negative integer `seq` and a string `sql`. */
export function isRunQueryMessage(message: unknown): message is RunQueryMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as { type?: unknown; seq?: unknown; sql?: unknown };
  return (
    candidate.type === 'run-query' &&
    typeof candidate.seq === 'number' &&
    Number.isSafeInteger(candidate.seq) &&
    candidate.seq >= 0 &&
    typeof candidate.sql === 'string'
  );
}

/** True for a well-formed `close-result`: a non-negative integer `seq`. */
export function isCloseResultMessage(message: unknown): message is CloseResultMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as { type?: unknown; seq?: unknown };
  return (
    candidate.type === 'close-result' &&
    typeof candidate.seq === 'number' &&
    Number.isSafeInteger(candidate.seq) &&
    candidate.seq >= 0
  );
}

export function queryPayload(message: RunQueryMessage, outcome: QueryOutcome): QueryPayload {
  if ('error' in outcome) {
    return { seq: message.seq, error: outcome.error };
  }
  return {
    seq: message.seq,
    data: outcome.data,
    truncated: outcome.truncated,
    elapsedMs: outcome.elapsedMs,
    ...(outcome.result !== undefined && { result: outcome.result }),
    ...(outcome.materializedRows !== undefined && { materializedRows: outcome.materializedRows }),
    ...(outcome.capped && { capped: true }),
  };
}

export function queryDataMessage(payload: QueryPayload): QueryDataMessage {
  return { type: 'query-data', payload };
}
