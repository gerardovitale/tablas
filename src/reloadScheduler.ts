/**
 * Decides *when* to re-read a file that changed on disk. No `vscode` import, so
 * it can be unit tested with fake timers.
 *
 * A `dbt build` touches the DuckDB file many times over seconds or minutes, so a
 * file event only arms a debounce timer. While DuckDB still has a write-ahead
 * log next to the file (`foo.duckdb.wal`) the writer has not checkpointed yet:
 * copying the main file then would show a half-applied state, so the scheduler
 * keeps waiting, up to `maxWaitMs` after the first event of the burst (a writer
 * that crashed leaves its log behind, and the view must not stay stale forever).
 */
export interface ReloadSchedulerOptions {
  /** Quiet period after the last event before the file is looked at. */
  debounceMs: number;
  /** Longest a burst may keep waiting for the write to finish. */
  maxWaitMs: number;
  /** True while the writer has not finished (e.g. the `.wal` file exists). */
  isWriteInProgress: () => Promise<boolean>;
  /** Re-reads the file. Never called after `dispose()`. */
  reload: () => Promise<void>;
  /** Called each time the scheduler holds back because a write is in progress. */
  onWaiting: () => void;
  // Injectable for tests; default to the real ones.
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  now?: () => number;
}

export class ReloadScheduler {
  private timer: unknown;
  private firstEventAt: number | undefined;
  private disposed = false;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly now: () => number;

  constructor(private readonly options: ReloadSchedulerOptions) {
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    this.now = options.now ?? (() => Date.now());
  }

  /** A change event arrived: (re)start the quiet period. */
  notify(): void {
    if (this.disposed) {
      return;
    }
    if (this.firstEventAt === undefined) {
      this.firstEventAt = this.now();
    }
    this.arm();
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  private arm(): void {
    if (this.timer !== undefined) {
      this.clearTimer(this.timer);
    }
    this.timer = this.setTimer(() => void this.tick(), this.options.debounceMs);
  }

  private async tick(): Promise<void> {
    this.timer = undefined;
    if (this.disposed) {
      return;
    }
    const busy = await this.options.isWriteInProgress().catch(() => false);
    // Disposed, or a newer event re-armed the timer while we were checking: that
    // timer owns the next decision.
    if (this.disposed || this.timer !== undefined) {
      return;
    }
    const waited = this.now() - (this.firstEventAt ?? this.now());
    if (busy && waited < this.options.maxWaitMs) {
      this.options.onWaiting();
      this.arm();
      return;
    }
    this.firstEventAt = undefined;
    await this.options.reload();
  }
}
