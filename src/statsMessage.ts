import type { TableStats } from './tableData';

/**
 * The lazy column-statistics protocol between an editor's webview and its
 * provider. Row data (`*-data` messages) never carries stats; the webview asks
 * for them the first time the user turns the Statistics view on, so tables
 * that never use it pay nothing at open time.
 *
 * Kept free of any `vscode` import so it can be unit-tested from `test/unit/`.
 */

/** webview -> host. `table` is the selected table/sheet, omitted for CSV/Parquet. */
export interface GetStatsMessage {
  type: 'get-stats';
  table?: string;
}

/**
 * The answer. `table` echoes the request so the webview can drop a reply that
 * arrived after the user moved on to another table. `stats` undefined means
 * the computation failed; a `skippedReason` inside it means it was
 * deliberately skipped (too large, timed out).
 */
export interface StatsPayload {
  table?: string;
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
  const candidate = message as { type?: unknown; table?: unknown };
  return candidate.type === 'get-stats' && (candidate.table === undefined || typeof candidate.table === 'string');
}

export function statsDataMessage(payload: StatsPayload): StatsDataMessage {
  return { type: 'stats-data', payload };
}
