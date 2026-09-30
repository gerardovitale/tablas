import type { ColumnKind, ColumnStats, HistogramStats, TableStats } from './tableData';

/**
 * Format-agnostic column statistics building blocks. Parsers that see native
 * values before stringification (CSV, XLSX, Parquet) feed a
 * `ColumnStatsAccumulator`; SQL-backed parsers (SQLite, DuckDB) compute the
 * same `ColumnStats` shape with aggregate queries and reuse `planHistogram` /
 * `histogramFromCounts` so all five formats bucket identically.
 *
 * No `vscode` import here on purpose: this module must stay loadable from
 * `test/unit/` (see CLAUDE.md's test setup notes).
 */

export const HISTOGRAM_BINS = 10;
export const MAX_TRACKED_DISTINCT = 100_000;
export const MAX_STAT_STRING_LENGTH = 200;

export const STATS_TOO_LARGE_REASON = 'Table is too large to compute column statistics.';
export const STATS_TIMED_OUT_REASON = 'Column statistics timed out.';

/**
 * Mutable so tests can drive the "skipped" paths without huge fixtures.
 * Production code never writes to it.
 */
export const statsLimits = {
  /**
   * rows x columns above which CSV/XLSX/Parquet stats are skipped. These run
   * in-process at roughly 0.15 us/cell (a 10M-cell CSV added ~1.4 s), so 20M
   * cells is a few seconds of extension-host time.
   */
  maxCells: 20_000_000,
  /**
   * SQLite's own, much lower cap: sql.js runs synchronously on the shared
   * extension-host thread and can't be interrupted, at roughly 1 us/cell
   * (a 10M-cell table took ~10 s, mostly COUNT(DISTINCT)). 3M cells is ~3 s.
   */
  sqliteMaxCells: 3_000_000,
  /** Wall-clock budget for DuckDB's stats queries before they're interrupted. */
  duckdbTimeoutMs: 15_000,
  /**
   * Distinct values tracked across *all* columns of one table (see
   * `DistinctBudget`). MAX_TRACKED_DISTINCT bounds a single column, but 200
   * mostly-unique columns would otherwise hold 200 x 100k keys (>1 GB).
   */
  distinctBudget: 2_000_000,
};

export function exceedsStatsCellCap(
  rowCount: number,
  columnCount: number,
  maxCells: number = statsLimits.maxCells
): boolean {
  return rowCount * columnCount > maxCells;
}

export function skippedStats(reason: string): TableStats {
  return { columns: [], skippedReason: reason };
}

/**
 * Stats are best-effort: a failure must never break showing the table, so
 * every compute path catches and returns `undefined`. This is the one place
 * those catches report to, so a real bug leaves a trace instead of silently
 * making the Statistics control unavailable. Mutable so tests can observe or
 * silence it (`log` exists separately because VS Code's extension host makes
 * `console.warn` itself unassignable, so tests can't stub it there).
 */
export const statsHooks = {
  onError: (err: unknown): void => {
    statsHooks.log('[tablas] column statistics failed:', err);
  },
  log: (...args: unknown[]): void => {
    console.warn(...args);
  },
};

export function reportStatsFailure(err: unknown): void {
  statsHooks.onError(err);
}

/**
 * Per-owner, per-table memo of stats results (owner = a SQLite/DuckDB handle
 * or an XLSX worksheet; those are read-only for a document's lifetime, so
 * results never go stale). It remembers *every* outcome, including
 * `skippedStats` (timeouts) and failures -- otherwise re-selecting a table
 * whose stats timed out would repeat the whole expensive attempt each time.
 */
export class StatsCache<K extends object> {
  private readonly entries = new WeakMap<K, Map<string, TableStats | null>>();

  /** `hit: false` = never computed; `stats: undefined` = a previous attempt failed. */
  lookup(owner: K, table: string): { hit: false } | { hit: true; stats: TableStats | undefined } {
    const cached = this.entries.get(owner)?.get(table);
    if (cached === undefined) {
      return { hit: false };
    }
    return { hit: true, stats: cached ?? undefined };
  }

  store(owner: K, table: string, stats: TableStats | undefined): void {
    let perOwner = this.entries.get(owner);
    if (!perOwner) {
      perOwner = new Map();
      this.entries.set(owner, perOwner);
    }
    perOwner.set(table, stats ?? null);
  }
}

export function clipStat(value: string): string {
  return value.length > MAX_STAT_STRING_LENGTH
    ? value.slice(0, MAX_STAT_STRING_LENGTH) + '…'
    : value;
}

export function emptyColumnStats(): ColumnStats {
  return { type: 'empty', nullCount: 0, distinctCount: 0 };
}

// ---------------------------------------------------------------------------
// Histogram planning
// ---------------------------------------------------------------------------

export interface HistogramPlan {
  lo: number;
  hi: number;
  bins: number;
  width: number;
}

/**
 * Bin layout for a numeric column spanning [lo, hi], or `undefined` when
 * there's nothing to draw (constant column, non-finite bounds, degenerate
 * width). Integer columns get one bin per value when the span is small, so a
 * 0/1 flag renders as two bars rather than ten mostly-empty ones.
 */
export function planHistogram(lo: number, hi: number, integer: boolean): HistogramPlan | undefined {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || !(hi > lo)) {
    return undefined;
  }
  let bins: number;
  let width: number;
  if (integer) {
    bins = Math.min(HISTOGRAM_BINS, Math.floor(hi - lo) + 1);
    width = (hi - lo + 1) / bins;
  } else {
    bins = HISTOGRAM_BINS;
    width = (hi - lo) / bins;
  }
  if (!(width > 0) || !Number.isFinite(width) || bins < 2) {
    return undefined;
  }
  return { lo, hi, bins, width };
}

/**
 * Bucket for value `x`. The upper clamp is what puts a float column's max
 * value in the last bin (it lands exactly on the top edge); the SQL bucket
 * expressions in sqliteParser/duckdbParser mirror it.
 */
export function bucketIndex(plan: HistogramPlan, x: number): number {
  return Math.min(plan.bins - 1, Math.max(0, Math.floor((x - plan.lo) / plan.width)));
}

/** Zero-fills bins not present in `entries` (bucket index, row count). */
export function histogramFromCounts(
  plan: HistogramPlan,
  entries: Iterable<readonly [number, number]>
): HistogramStats {
  const counts = new Array<number>(plan.bins).fill(0);
  for (const [bucket, count] of entries) {
    if (Number.isInteger(bucket) && bucket >= 0 && bucket < plan.bins) {
      counts[bucket] += count;
    }
  }
  return { lo: plan.lo, hi: plan.hi, counts };
}

// ---------------------------------------------------------------------------
// CSV-style string inference
// ---------------------------------------------------------------------------

type InferredKind = 'integer' | 'float' | 'boolean' | 'date' | 'text';

const INTEGER_RE = /^[+-]?(0|[1-9]\d*)$/;
const FLOAT_RE = /^[+-]?((0|[1-9]\d*)(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
const BOOLEAN_RE = /^(true|false)$/i;
const DATE_RE =
  /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)(Z|[+-]\d{2}:?\d{2})?)?$/;

/**
 * True when `YYYY-MM-DD` names a day that exists. Date.parse alone isn't
 * enough: V8 rolls `2024-02-30` over to 1 March instead of rejecting it.
 */
function isRealCalendarDate(date: string): boolean {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  // setUTCFullYear (not Date.UTC) so years 0000-0099 aren't mapped to 19xx.
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
}

/** Epoch ms for an ISO-8601 date/datetime string (no zone => UTC), else NaN. */
function parseIsoDate(s: string): number {
  const m = DATE_RE.exec(s);
  if (!m) {
    return NaN;
  }
  const [, date, time, zone] = m;
  if (!isRealCalendarDate(date)) {
    return NaN;
  }
  if (!time) {
    return Date.parse(date);
  }
  let z = zone ?? 'Z';
  if (z.length === 5) {
    z = `${z.slice(0, 3)}:${z.slice(3)}`;
  }
  return Date.parse(`${date}T${time}${z}`);
}

interface Inferred {
  kind: InferredKind;
  value: number;
}

const TEXT: Inferred = { kind: 'text', value: 0 };

// Cheap first-character pre-check keeps the regexes off plain-text cells,
// which dominate most tables. `s` is trimmed and non-empty.
function inferKind(s: string): Inferred {
  const first = s.charCodeAt(0);
  const isDigit = first >= 48 && first <= 57;
  if (isDigit || first === 43 /* + */ || first === 45 /* - */ || first === 46 /* . */) {
    if (INTEGER_RE.test(s)) {
      return { kind: 'integer', value: Number(s) };
    }
    if (FLOAT_RE.test(s)) {
      return { kind: 'float', value: Number(s) };
    }
    if (isDigit && s.length >= 10) {
      const ms = parseIsoDate(s);
      if (!Number.isNaN(ms)) {
        return { kind: 'date', value: ms };
      }
    }
    return TEXT;
  }
  // t/T/f/F
  if ((first === 116 || first === 84 || first === 102 || first === 70) && BOOLEAN_RE.test(s)) {
    return { kind: 'boolean', value: s.toLowerCase() === 'true' ? 1 : 0 };
  }
  return TEXT;
}

// ---------------------------------------------------------------------------
// Accumulator
// ---------------------------------------------------------------------------

type DistinctKey = string | number | boolean;

/** Display text for a min/max value; a thunk defers costly formatting to new extremes only. */
export type DisplaySource = string | (() => string);

function resolveDisplay(display: DisplaySource | undefined): string | undefined {
  return typeof display === 'function' ? display() : display;
}

/**
 * Shared cap on tracked distinct values across every column of one table.
 * Once spent, no column tracks any further new value and each affected column
 * reports its distinct count as a lower bound (the UI's "≥"). Which values get
 * in is simply scan order; that bias is accepted over unbounded memory.
 */
export class DistinctBudget {
  constructor(public remaining: number = statsLimits.distinctBudget) {}
}

export class ColumnStatsAccumulator {
  private readonly declared: ColumnKind | undefined;
  private readonly budget: DistinctBudget | undefined;

  private nulls = 0;
  private ints = 0;
  private floats = 0;
  private bools = 0;
  private dates = 0;
  private texts = 0;
  private others = 0;

  private readonly distinct = new Set<DistinctKey>();
  private distinctCapped = false;

  // Finite numeric extremes (display strings only kept when supplied).
  private numCount = 0;
  private numSum = 0;
  private numMin = Infinity;
  private numMax = -Infinity;
  private numMinDisplay: string | undefined;
  private numMaxDisplay: string | undefined;

  private dateMin = Infinity;
  private dateMax = -Infinity;
  private dateMinDisplay: string | undefined;
  private dateMaxDisplay: string | undefined;

  private textMin: string | undefined;
  private textMax: string | undefined;

  private plan: HistogramPlan | undefined;
  private planned = false;
  private histCounts: number[] | undefined;

  constructor(opts?: { declared?: ColumnKind; budget?: DistinctBudget }) {
    this.declared = opts?.declared;
    this.budget = opts?.budget;
  }

  private track(key: DistinctKey): void {
    if (this.distinct.size >= MAX_TRACKED_DISTINCT || (this.budget !== undefined && this.budget.remaining <= 0)) {
      if (!this.distinct.has(key)) {
        this.distinctCapped = true;
      }
      return;
    }
    const before = this.distinct.size;
    this.distinct.add(key);
    if (this.budget !== undefined && this.distinct.size > before) {
      this.budget.remaining--;
    }
  }

  addNull(): void {
    this.nulls++;
  }

  /**
   * `display` is the original text for min/max when `String(n)` wouldn't be
   * faithful (e.g. a bigint beyond 2^53, or "1.50" in a CSV). Non-finite
   * numbers count as non-null and distinct but are excluded from
   * min/max/mean/histogram.
   */
  addNumber(n: number, isInteger: boolean, display?: string): void {
    if (isInteger) {
      this.ints++;
    } else {
      this.floats++;
    }
    // The original text doubles as the distinct key for integers a double
    // can't represent exactly, so 2^53+1 and 2^53 stay distinct.
    const unsafeInt = Number.isInteger(n) && !Number.isSafeInteger(n) && display !== undefined;
    this.track(unsafeInt ? (display as string) : n);
    if (!Number.isFinite(n)) {
      return;
    }
    this.numCount++;
    this.numSum += n;
    if (n < this.numMin) {
      this.numMin = n;
      this.numMinDisplay = display;
    }
    if (n > this.numMax) {
      this.numMax = n;
      this.numMaxDisplay = display;
    }
  }

  addBoolean(b: boolean): void {
    this.bools++;
    this.track(b);
  }

  addDate(ms: number, display?: DisplaySource): void {
    if (!Number.isFinite(ms)) {
      this.others++;
      return;
    }
    this.dates++;
    this.track(`\u0000d${ms}`);
    if (ms < this.dateMin) {
      this.dateMin = ms;
      this.dateMinDisplay = resolveDisplay(display);
    }
    if (ms > this.dateMax) {
      this.dateMax = ms;
      this.dateMaxDisplay = resolveDisplay(display);
    }
  }

  addText(s: string): void {
    this.texts++;
    this.track(s);
    if (this.textMin === undefined || s < this.textMin) {
      this.textMin = s;
    }
    if (this.textMax === undefined || s > this.textMax) {
      this.textMax = s;
    }
  }

  /** Non-null value we can't summarise (nested, binary, ...): no distinct tracking. */
  addOther(): void {
    this.others++;
  }

  /** CSV path: classify a raw cell string. Blank (after trim) is null. */
  addInferred(raw: string): void {
    const s = raw.trim();
    if (s === '') {
      this.nulls++;
      return;
    }
    const inferred = inferKind(s);
    switch (inferred.kind) {
      case 'integer':
        this.addNumber(inferred.value, true, s);
        break;
      case 'float':
        this.addNumber(inferred.value, false, s);
        break;
      case 'boolean':
        this.addBoolean(inferred.value === 1);
        break;
      case 'date':
        this.addDate(inferred.value, s);
        break;
      default:
        this.addText(s);
    }
  }

  private resolveType(): ColumnKind {
    const numeric = this.ints > 0 || this.floats > 0;
    const kindCount =
      (numeric ? 1 : 0) +
      (this.bools > 0 ? 1 : 0) +
      (this.dates > 0 ? 1 : 0) +
      (this.texts > 0 ? 1 : 0) +
      (this.others > 0 ? 1 : 0);
    if (kindCount === 0) {
      return this.declared ?? 'empty';
    }
    if (kindCount > 1) {
      return 'mixed';
    }
    if (numeric) {
      return this.floats > 0 ? 'float' : 'integer';
    }
    if (this.bools > 0) {
      return 'boolean';
    }
    if (this.dates > 0) {
      return 'date';
    }
    if (this.texts > 0) {
      return 'text';
    }
    return 'other';
  }

  /**
   * Bin layout for pass 2, or `undefined` when this column doesn't get a
   * histogram (non-numeric, mixed, or constant). Cached after the first call.
   */
  histogramPlan(): HistogramPlan | undefined {
    if (!this.planned) {
      this.planned = true;
      const type = this.resolveType();
      if ((type === 'integer' || type === 'float') && this.numCount > 0) {
        this.plan = planHistogram(this.numMin, this.numMax, type === 'integer');
      }
      if (this.plan) {
        this.histCounts = new Array<number>(this.plan.bins).fill(0);
      }
    }
    return this.plan;
  }

  /** Pass 2: bucket one finite numeric value. No-op without a plan. */
  addHistogramValue(n: number): void {
    if (this.plan && this.histCounts && Number.isFinite(n)) {
      this.histCounts[bucketIndex(this.plan, n)]++;
    }
  }

  finalize(): ColumnStats {
    const type = this.resolveType();
    const stats: ColumnStats = { type, nullCount: this.nulls };
    if (type !== 'other') {
      stats.distinctCount = this.distinct.size;
      if (this.distinctCapped) {
        stats.distinctIsLowerBound = true;
      }
    }
    if ((type === 'integer' || type === 'float') && this.numCount > 0) {
      stats.min = this.numMinDisplay ?? String(this.numMin);
      stats.max = this.numMaxDisplay ?? String(this.numMax);
      const mean = this.numSum / this.numCount;
      if (Number.isFinite(mean)) {
        stats.mean = mean;
      }
      if (this.plan && this.histCounts) {
        stats.histogram = { lo: this.plan.lo, hi: this.plan.hi, counts: this.histCounts };
      }
    } else if (type === 'date') {
      stats.min = this.dateMinDisplay ?? new Date(this.dateMin).toISOString();
      stats.max = this.dateMaxDisplay ?? new Date(this.dateMax).toISOString();
    } else if (type === 'text' && this.textMin !== undefined && this.textMax !== undefined) {
      stats.min = clipStat(this.textMin);
      stats.max = clipStat(this.textMax);
    }
    return stats;
  }
}

// ---------------------------------------------------------------------------
// Whole-table helper for string-cell sources (CSV)
// ---------------------------------------------------------------------------

/**
 * Two-pass stats over already-parsed string rows: pass 1 infers types and
 * gathers min/max/mean/distinct, pass 2 buckets only the numeric columns.
 */
export function computeStringTableStats(columnCount: number, rows: readonly string[][]): TableStats {
  const budget = new DistinctBudget();
  const accs: ColumnStatsAccumulator[] = [];
  for (let c = 0; c < columnCount; c++) {
    accs.push(new ColumnStatsAccumulator({ budget }));
  }
  for (const row of rows) {
    for (let c = 0; c < columnCount; c++) {
      accs[c].addInferred(row[c] ?? '');
    }
  }
  for (let c = 0; c < columnCount; c++) {
    if (!accs[c].histogramPlan()) {
      continue;
    }
    for (const row of rows) {
      const s = (row[c] ?? '').trim();
      if (s !== '') {
        accs[c].addHistogramValue(Number(s));
      }
    }
  }
  return { columns: accs.map((a) => a.finalize()) };
}
