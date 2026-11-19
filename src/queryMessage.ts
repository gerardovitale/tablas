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

/** What running a query produced; `error` is text for the user, never a stack. */
export type QueryOutcome =
  | { data: ParsedTable; truncated: boolean; elapsedMs: number }
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
  error?: string;
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

export function queryPayload(message: RunQueryMessage, outcome: QueryOutcome): QueryPayload {
  return 'error' in outcome
    ? { seq: message.seq, error: outcome.error }
    : { seq: message.seq, data: outcome.data, truncated: outcome.truncated, elapsedMs: outcome.elapsedMs };
}

export function queryDataMessage(payload: QueryPayload): QueryDataMessage {
  return { type: 'query-data', payload };
}
