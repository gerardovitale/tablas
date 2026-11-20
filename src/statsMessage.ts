import type { TableStats } from './tableData';

/**
 * The column-statistics protocol between an editor's webview and its
 * provider. Row data (`*-data` messages) never carries stats; the webview asks
 * for them in a separate request right after it renders each table, so the
 * rows never wait on the statistics.
 *
 * Kept free of any `vscode` import so it can be unit-tested from `test/unit/`.
 */

/** webview -> host. `table` is the selected table/sheet, omitted for CSV/Parquet. */
export interface GetStatsMessage {
  type: 'get-stats';
  table?: string;
  /**
   * One webview-wide counter, never reset, echoed in the answer. The table name
   * alone cannot tell a reply for the view on screen from a slower one for the
   * same table's previous view (a refresh re-renders it while the old scan runs).
   */
  seq?: number;
}

/**
 * The answer. `table` echoes the request so the webview can drop a reply that
 * arrived after the user moved on to another table. `stats` undefined means
 * the computation failed; a `skippedReason` inside it means it was
 * deliberately skipped (too large, timed out).
 */
export interface StatsPayload {
  table?: string;
  /** Echo of `GetStatsMessage.seq`. */
  seq?: number;
  stats?: TableStats;
}

/** host -> webview. */
export interface StatsDataMessage {
  type: 'stats-data';
  payload: StatsPayload;
}

/** True for a well-formed `get-stats` request; `table`, when present, must be a string. */
export function isGetStatsMessage(message: unknown): message is GetStatsMessage {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const candidate = message as { type?: unknown; table?: unknown; seq?: unknown };
  return (
    candidate.type === 'get-stats' &&
    (candidate.table === undefined || typeof candidate.table === 'string') &&
    (candidate.seq === undefined || typeof candidate.seq === 'number')
  );
}

/** The answer to a request; `seq` is the request's, so the webview can tell whose it is. */
export function statsDataMessage(payload: StatsPayload, seq?: number): StatsDataMessage {
  return { type: 'stats-data', payload: seq === undefined ? payload : { ...payload, seq } };
}
