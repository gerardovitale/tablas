import { reportStatsFailure } from './columnStats';
import {
  duckdbDropResult,
  duckdbResultFilter,
  duckdbResultStats,
  duckdbRunQuery,
  runExclusive,
  type DuckdbHandle,
} from './duckdbParser';
import type { FileSqlError } from './fileSqlEngine';
import { filterPayload, planFilter, reportFilterFailure, FILTER_FAILED_REASON } from './filter';
import type { FilterMessage, FilterPayload } from './filterMessage';
import { queryPayload, RESULT_GONE_REASON, type QueryPayload, type RunQueryMessage } from './queryMessage';
import type { StatsPayload } from './statsMessage';

/**
 * The SQL box of a document that has no database of its own (a Parquet or CSV file): the engine
 * is opened *lazily*, on the first query (opening a file costs nothing until the user asks), and
 * every request is answered from it with the same functions a DuckDB file's provider uses. One
 * body for both formats' providers. Kept free of any `vscode` import so it can be unit-tested
 * from `test/unit/`.
 */
export class QuerySession {
  private engine: Promise<DuckdbHandle | FileSqlError> | undefined;
  /** `seq` of the newest `run-query` / `filter`; an older one still queued behind it never runs. */
  private querySeq = 0;
  private filterSeq = 0;
  private disposed = false;

  /** `open` creates the engine (see `openFileSqlEngine`); it is called at most once per success. */
  constructor(private readonly open: () => Promise<DuckdbHandle | FileSqlError>) {}

  private opened(): Promise<DuckdbHandle | FileSqlError> {
    if (this.disposed) {
      // Never open an engine nobody will close.
      return Promise.resolve({ error: 'The editor was closed.' });
    }
    if (!this.engine) {
      const attempt = this.open().then(
        (opened) => {
          if ('error' in opened) {
            // Not kept: the next run tries again (the file may have been fixed or replaced).
            this.engine = undefined;
          }
          return opened;
        },
        (err): FileSqlError => {
          this.engine = undefined;
          return { error: err instanceof Error ? err.message : String(err) };
        }
      );
      this.engine = attempt;
    }
    return this.engine;
  }

  /** The engine if it is already open (a request about a result implies one was). */
  private async ready(): Promise<DuckdbHandle | undefined> {
    const opened = this.engine && !this.disposed ? await this.engine : undefined;
    return opened && !('error' in opened) ? opened : undefined;
  }

  /**
   * Runs the query text (reads only; see `duckdbRunQuery`), opening the engine first if this is the
   * first one. `undefined` = nothing to post (a newer request overtook this one, or the session
   * was disposed).
   */
  public async runQuery(message: RunQueryMessage, maxRows: number): Promise<QueryPayload | undefined> {
    this.querySeq = message.seq;
    const opened = await this.opened();
    if (this.disposed || this.querySeq !== message.seq) {
      return undefined;
    }
    if ('error' in opened) {
      return queryPayload(message, { error: opened.error });
    }
    const outcome = await duckdbRunQuery(opened, message.sql, maxRows, {
      shouldRun: () => !this.disposed && this.querySeq === message.seq,
      resultSeq: message.seq,
    });
    return outcome === undefined ? undefined : queryPayload(message, outcome);
  }

  /** Statistics of a result kept as a table; `stats` undefined if it is gone or failed. */
  public async resultStats(result: number): Promise<StatsPayload> {
    try {
      const handle = await this.ready();
      return { result, stats: handle ? await duckdbResultStats(handle, result) : undefined };
    } catch (err) {
      reportStatsFailure(err);
      return { result, stats: undefined };
    }
  }

  /** Filters a result kept as a table (`message.result`); see `FilterMessage`. */
  public async resultFilter(message: FilterMessage, maxRows: number): Promise<FilterPayload | undefined> {
    this.filterSeq = message.seq;
    const plan = planFilter(message);
    if (plan.kind === 'cleared') {
      return undefined;
    }
    if (plan.kind === 'invalid') {
      return plan.payload;
    }
    try {
      const handle = await this.ready();
      if (!handle || message.result === undefined) {
        return filterPayload(message, { failedReason: RESULT_GONE_REASON });
      }
      // Wait in the connection's queue first: that is where a stale request is overtaken.
      await runExclusive(handle, async () => undefined);
      if (this.disposed || this.filterSeq !== message.seq) {
        return undefined;
      }
      return filterPayload(message, await duckdbResultFilter(handle, message.result, plan.specs, maxRows));
    } catch (err) {
      reportFilterFailure(err);
      return filterPayload(message, { failedReason: FILTER_FAILED_REASON });
    }
  }

  /** The webview stopped showing the result made by run `seq`. */
  public async closeResult(seq: number): Promise<void> {
    const handle = await this.ready();
    if (handle) {
      await duckdbDropResult(handle, seq);
    }
  }

  /** Closes the engine (after what is queued on it finished) and deletes its temp folder. */
  public dispose(): void {
    this.disposed = true;
    const engine = this.engine;
    this.engine = undefined;
    void engine?.then((opened) => {
      if (!('error' in opened)) {
        void runExclusive(opened, async () => undefined).then(() => opened.close());
      }
    });
  }
}
