import * as assert from 'assert';
import {
  bucketIndex,
  clipStat,
  ColumnStatsAccumulator,
  computeStringTableStats,
  DistinctBudget,
  emptyColumnStats,
  exceedsStatsCellCap,
  histogramFromCounts,
  MAX_STAT_STRING_LENGTH,
  MAX_TRACKED_DISTINCT,
  planHistogram,
  reportStatsFailure,
  skippedStats,
  StatsCache,
  statsHooks,
  statsLimits,
} from '../../src/columnStats';

function inferAll(values: string[]) {
  const acc = new ColumnStatsAccumulator();
  for (const v of values) {
    acc.addInferred(v);
  }
  const plan = acc.histogramPlan();
  if (plan) {
    for (const v of values) {
      if (v.trim() !== '') {
        acc.addHistogramValue(Number(v));
      }
    }
  }
  return acc.finalize();
}

describe('planHistogram', () => {
  it('returns undefined for a constant column', () => {
    assert.strictEqual(planHistogram(5, 5, true), undefined);
  });

  it('returns undefined for non-finite bounds', () => {
    assert.strictEqual(planHistogram(0, Infinity, false), undefined);
    assert.strictEqual(planHistogram(NaN, 1, false), undefined);
  });

  it('gives a small integer span one bin per value', () => {
    const plan = planHistogram(0, 1, true)!;
    assert.strictEqual(plan.bins, 2);
    assert.strictEqual(plan.width, 1);
  });

  it('caps an integer span at 10 bins', () => {
    const plan = planHistogram(0, 100, true)!;
    assert.strictEqual(plan.bins, 10);
    assert.strictEqual(bucketIndex(plan, 100), 9);
    assert.strictEqual(bucketIndex(plan, 0), 0);
  });

  it('uses 10 equal-width bins for floats and clamps the max into the last bin', () => {
    const plan = planHistogram(0, 1, false)!;
    assert.strictEqual(plan.bins, 10);
    assert.strictEqual(bucketIndex(plan, 1), 9);
    assert.strictEqual(bucketIndex(plan, 0.05), 0);
    assert.strictEqual(bucketIndex(plan, 0.5), 5);
  });

  it('returns undefined when the width underflows', () => {
    assert.strictEqual(planHistogram(0, Number.MIN_VALUE, false), undefined);
  });
});

describe('histogramFromCounts', () => {
  it('zero-fills missing bins and ignores out-of-range buckets', () => {
    const plan = planHistogram(0, 100, true)!;
    const hist = histogramFromCounts(plan, [
      [0, 3],
      [9, 2],
      [10, 99],
      [-1, 99],
    ]);
    assert.deepStrictEqual(hist.counts, [3, 0, 0, 0, 0, 0, 0, 0, 0, 2]);
    assert.strictEqual(hist.lo, 0);
    assert.strictEqual(hist.hi, 100);
  });
});

describe('clipStat / limits helpers', () => {
  it('leaves short strings alone and clips long ones with an ellipsis', () => {
    assert.strictEqual(clipStat('abc'), 'abc');
    const clipped = clipStat('x'.repeat(MAX_STAT_STRING_LENGTH + 50));
    assert.strictEqual(clipped.length, MAX_STAT_STRING_LENGTH + 1);
    assert.ok(clipped.endsWith('…'));
  });

  it('emptyColumnStats is an empty column with zero counts', () => {
    assert.deepStrictEqual(emptyColumnStats(), { type: 'empty', nullCount: 0, distinctCount: 0 });
  });

  it('skippedStats carries a reason and no columns', () => {
    assert.deepStrictEqual(skippedStats('nope'), { columns: [], skippedReason: 'nope' });
  });

  it('exceedsStatsCellCap accepts an explicit cap', () => {
    assert.strictEqual(exceedsStatsCellCap(5, 2, 10), false);
    assert.strictEqual(exceedsStatsCellCap(6, 2, 10), true);
  });

  it('exceedsStatsCellCap honours statsLimits.maxCells', () => {
    const original = statsLimits.maxCells;
    try {
      statsLimits.maxCells = 10;
      assert.strictEqual(exceedsStatsCellCap(5, 2), false);
      assert.strictEqual(exceedsStatsCellCap(6, 2), true);
    } finally {
      statsLimits.maxCells = original;
    }
  });
});

describe('ColumnStatsAccumulator type inference (CSV strings)', () => {
  it('infers integers with min/max/mean/histogram', () => {
    const stats = inferAll(['1', '2', '3']);
    assert.strictEqual(stats.type, 'integer');
    assert.strictEqual(stats.nullCount, 0);
    assert.strictEqual(stats.distinctCount, 3);
    assert.strictEqual(stats.min, '1');
    assert.strictEqual(stats.max, '3');
    assert.strictEqual(stats.mean, 2);
    assert.deepStrictEqual(stats.histogram, { lo: 1, hi: 3, counts: [1, 1, 1] });
  });

  it('widens integer + float to float and keeps original text for min/max', () => {
    const stats = inferAll(['1', '2.50', '-0.5']);
    assert.strictEqual(stats.type, 'float');
    assert.strictEqual(stats.min, '-0.5');
    assert.strictEqual(stats.max, '2.50');
    assert.ok(stats.histogram);
    assert.strictEqual(stats.histogram!.counts.length, 10);
    assert.strictEqual(
      stats.histogram!.counts.reduce((a, b) => a + b, 0),
      3
    );
  });

  it('treats leading-zero ids as text, not integers', () => {
    assert.strictEqual(inferAll(['007', '008']).type, 'text');
  });

  it('accepts exponent and leading-dot floats', () => {
    assert.strictEqual(inferAll(['1e5', '.5', '+2.']).type, 'float');
  });

  it('infers booleans case-insensitively', () => {
    const stats = inferAll(['true', 'FALSE', 'True']);
    assert.strictEqual(stats.type, 'boolean');
    assert.strictEqual(stats.distinctCount, 2);
    assert.strictEqual(stats.min, undefined);
  });

  it('infers ISO dates and datetimes with original-text min/max', () => {
    const stats = inferAll(['2023-01-05', '2021-12-31', '2022-06-01 10:30:00']);
    assert.strictEqual(stats.type, 'date');
    assert.strictEqual(stats.min, '2021-12-31');
    assert.strictEqual(stats.max, '2023-01-05');
  });

  it('accepts a datetime with a zone offset, with or without colon', () => {
    const stats = inferAll(['2023-01-05T10:00:00+02:00', '2023-01-05T10:00:00+0200']);
    assert.strictEqual(stats.type, 'date');
    assert.strictEqual(stats.distinctCount, 1);
  });

  it('rejects impossible dates as text', () => {
    assert.strictEqual(inferAll(['2023-13-45']).type, 'text');
  });

  it('gives lexicographic min/max for text', () => {
    const stats = inferAll(['pear', 'apple', 'zebra']);
    assert.strictEqual(stats.type, 'text');
    assert.strictEqual(stats.min, 'apple');
    assert.strictEqual(stats.max, 'zebra');
    assert.strictEqual(stats.histogram, undefined);
    assert.strictEqual(stats.mean, undefined);
  });

  it('marks numbers + text as mixed with no min/max/mean/histogram', () => {
    const stats = inferAll(['1', '2', 'N/A']);
    assert.strictEqual(stats.type, 'mixed');
    assert.strictEqual(stats.min, undefined);
    assert.strictEqual(stats.max, undefined);
    assert.strictEqual(stats.mean, undefined);
    assert.strictEqual(stats.histogram, undefined);
    assert.strictEqual(stats.distinctCount, 3);
  });

  it('counts blank and whitespace-only cells as null', () => {
    const stats = inferAll(['1', '', '  ', '3']);
    assert.strictEqual(stats.nullCount, 2);
    assert.strictEqual(stats.type, 'integer');
  });

  it('reports an all-null column as empty', () => {
    const stats = inferAll(['', '']);
    assert.deepStrictEqual(stats, { type: 'empty', nullCount: 2, distinctCount: 0 });
  });

  it('omits the histogram for a constant numeric column', () => {
    const stats = inferAll(['4', '4', '4']);
    assert.strictEqual(stats.histogram, undefined);
    assert.strictEqual(stats.distinctCount, 1);
    assert.strictEqual(stats.mean, 4);
  });

  it('keeps the exact text for integers beyond 2^53 as min/max and distinct keys', () => {
    const stats = inferAll(['9007199254740993', '9007199254740992']);
    assert.strictEqual(stats.type, 'integer');
    assert.strictEqual(stats.distinctCount, 2);
    assert.strictEqual(stats.max, '9007199254740993');
  });
});

describe('ColumnStatsAccumulator native values', () => {
  it('excludes non-finite floats from min/max/mean/histogram but counts them distinct', () => {
    const acc = new ColumnStatsAccumulator();
    acc.addNumber(1, false);
    acc.addNumber(3, false);
    acc.addNumber(NaN, false);
    acc.addNumber(Infinity, false);
    const plan = acc.histogramPlan();
    assert.ok(plan);
    for (const n of [1, 3, NaN, Infinity]) {
      acc.addHistogramValue(n);
    }
    const stats = acc.finalize();
    assert.strictEqual(stats.type, 'float');
    assert.strictEqual(stats.distinctCount, 4);
    assert.strictEqual(stats.min, '1');
    assert.strictEqual(stats.max, '3');
    assert.strictEqual(stats.mean, 2);
    assert.strictEqual(
      stats.histogram!.counts.reduce((a, b) => a + b, 0),
      2
    );
  });

  it('uses the supplied display for date min/max, else ISO', () => {
    const withDisplay = new ColumnStatsAccumulator();
    withDisplay.addDate(Date.UTC(2020, 0, 1), '1/1/2020');
    withDisplay.addDate(Date.UTC(2021, 0, 1), '1/1/2021');
    const a = withDisplay.finalize();
    assert.deepStrictEqual([a.type, a.min, a.max], ['date', '1/1/2020', '1/1/2021']);

    const iso = new ColumnStatsAccumulator();
    iso.addDate(Date.UTC(2020, 0, 1));
    const b = iso.finalize();
    assert.strictEqual(b.min, '2020-01-01T00:00:00.000Z');
  });

  it('treats an invalid date as an unsummarised value', () => {
    const acc = new ColumnStatsAccumulator();
    acc.addDate(NaN);
    const stats = acc.finalize();
    assert.strictEqual(stats.type, 'other');
    assert.strictEqual(stats.distinctCount, undefined);
  });

  it('reports other-only columns without a distinct count', () => {
    const acc = new ColumnStatsAccumulator();
    acc.addOther();
    acc.addNull();
    assert.deepStrictEqual(acc.finalize(), { type: 'other', nullCount: 1 });
  });

  it('falls back to the declared type when no values were seen', () => {
    const acc = new ColumnStatsAccumulator({ declared: 'integer' });
    assert.strictEqual(acc.finalize().type, 'integer');
  });

  it('lets seen values win over the declared type', () => {
    const acc = new ColumnStatsAccumulator({ declared: 'integer' });
    acc.addText('x');
    assert.strictEqual(acc.finalize().type, 'text');
  });

  it('caps distinct tracking and flags the count as a lower bound', () => {
    const acc = new ColumnStatsAccumulator();
    for (let i = 0; i < MAX_TRACKED_DISTINCT + 5; i++) {
      acc.addText(`v${i}`);
    }
    const stats = acc.finalize();
    assert.strictEqual(stats.distinctCount, MAX_TRACKED_DISTINCT);
    assert.strictEqual(stats.distinctIsLowerBound, true);
  });

  it('does not flag the cap when repeated values arrive after it is reached', () => {
    const acc = new ColumnStatsAccumulator();
    for (let i = 0; i < MAX_TRACKED_DISTINCT; i++) {
      acc.addText(`v${i}`);
    }
    acc.addText('v0');
    assert.strictEqual(acc.finalize().distinctIsLowerBound, undefined);
  });

  it('clips long text min/max', () => {
    const acc = new ColumnStatsAccumulator();
    acc.addText('a'.repeat(MAX_STAT_STRING_LENGTH * 2));
    const stats = acc.finalize();
    assert.strictEqual(stats.min!.length, MAX_STAT_STRING_LENGTH + 1);
  });

  it('survives a JSON round-trip unchanged', () => {
    const acc = new ColumnStatsAccumulator();
    acc.addNumber(1, true);
    acc.addNumber(2, true);
    acc.addNull();
    acc.histogramPlan();
    acc.addHistogramValue(1);
    acc.addHistogramValue(2);
    const stats = acc.finalize();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(stats)), stats);
  });
});

describe('computeStringTableStats', () => {
  it('computes parallel column stats over string rows', () => {
    const stats = computeStringTableStats(3, [
      ['1', 'a', ''],
      ['2', 'b', ''],
      ['3', 'b'],
    ]);
    assert.strictEqual(stats.columns.length, 3);
    assert.strictEqual(stats.columns[0].type, 'integer');
    assert.deepStrictEqual(stats.columns[0].histogram?.counts, [1, 1, 1]);
    assert.strictEqual(stats.columns[1].distinctCount, 2);
    assert.strictEqual(stats.columns[2].type, 'empty');
    assert.strictEqual(stats.columns[2].nullCount, 3);
  });

  it('returns empty-typed columns for zero rows', () => {
    const stats = computeStringTableStats(2, []);
    assert.deepStrictEqual(stats.columns, [emptyColumnStats(), emptyColumnStats()]);
  });
});

describe('impossible calendar dates', () => {
  it('rejects days that do not exist instead of letting Date.parse roll them over', () => {
    for (const bad of ['2024-02-30', '2023-02-29', '2023-04-31', '2023-06-31', '2023-09-31', '2024-00-10', '2024-01-00']) {
      assert.strictEqual(inferAll([bad]).type, 'text', bad);
    }
  });

  it('accepts real edge-case days', () => {
    for (const good of ['2024-02-29', '2000-02-29', '2023-02-28', '2023-12-31', '2023-04-30', '0050-06-15']) {
      assert.strictEqual(inferAll([good]).type, 'date', good);
    }
  });

  it('rejects a bad day inside a datetime too', () => {
    assert.strictEqual(inferAll(['2023-02-30 10:00:00']).type, 'text');
    assert.strictEqual(inferAll(['2023-02-28 10:00:00']).type, 'date');
  });

  it('keeps a mostly-real-date column typed date only when every value is real', () => {
    assert.strictEqual(inferAll(['2024-01-05', '2024-02-30']).type, 'mixed');
  });
});

describe('DistinctBudget', () => {
  it('stops tracking new values once spent, and flags the count as a lower bound', () => {
    const budget = new DistinctBudget(3);
    const acc = new ColumnStatsAccumulator({ budget });
    for (const v of ['a', 'b', 'c', 'd', 'e']) {
      acc.addText(v);
    }
    const stats = acc.finalize();
    assert.strictEqual(stats.distinctCount, 3);
    assert.strictEqual(stats.distinctIsLowerBound, true);
    assert.strictEqual(budget.remaining, 0);
  });

  it('is shared across the accumulators of one table', () => {
    const budget = new DistinctBudget(4);
    const first = new ColumnStatsAccumulator({ budget });
    const second = new ColumnStatsAccumulator({ budget });
    for (const v of ['a', 'b', 'c']) {
      first.addText(v);
    }
    for (const v of ['x', 'y', 'z']) {
      second.addText(v);
    }
    assert.strictEqual(first.finalize().distinctIsLowerBound, undefined, 'first column fit');
    const s = second.finalize();
    assert.strictEqual(s.distinctCount, 1);
    assert.strictEqual(s.distinctIsLowerBound, true);
  });

  it('does not spend budget on a repeated value, nor flag a repeat as capped', () => {
    const budget = new DistinctBudget(2);
    const acc = new ColumnStatsAccumulator({ budget });
    for (const v of ['a', 'b', 'a', 'b', 'a']) {
      acc.addText(v);
    }
    const stats = acc.finalize();
    assert.strictEqual(stats.distinctCount, 2);
    assert.strictEqual(stats.distinctIsLowerBound, undefined);
    assert.strictEqual(budget.remaining, 0);
  });

  it('still reports min/max/mean and nulls for a column past its budget', () => {
    const acc = new ColumnStatsAccumulator({ budget: new DistinctBudget(1) });
    acc.addNumber(1, true);
    acc.addNumber(5, true);
    acc.addNull();
    const stats = acc.finalize();
    assert.deepStrictEqual([stats.min, stats.max, stats.mean, stats.nullCount], ['1', '5', 3, 1]);
    assert.strictEqual(stats.distinctIsLowerBound, true);
  });

  it('defaults to statsLimits.distinctBudget, and computeStringTableStats spreads one budget over its columns', () => {
    const original = statsLimits.distinctBudget;
    try {
      statsLimits.distinctBudget = 5;
      assert.strictEqual(new DistinctBudget().remaining, 5);
      // 2 columns x 4 unique values = 8 distinct keys wanted, 5 allowed in total.
      // Rows are scanned row by row, so the budget runs out mid-way through the
      // third row: a,p,b,q,c get in; r, d, s do not.
      const rows = [['a', 'p'], ['b', 'q'], ['c', 'r'], ['d', 's']];
      const stats = computeStringTableStats(2, rows);
      assert.deepStrictEqual(
        stats.columns.map((c) => [c.distinctCount, c.distinctIsLowerBound]),
        [[3, true], [2, true]]
      );
    } finally {
      statsLimits.distinctBudget = original;
    }
  });
});

describe('unsafe integers', () => {
  it('keeps the original text as the distinct key, so 2^53 and 2^53+1 stay distinct', () => {
    const acc = new ColumnStatsAccumulator();
    acc.addNumber(9007199254740992, true, '9007199254740992');
    acc.addNumber(9007199254740992, true, '9007199254740993');
    assert.strictEqual(acc.finalize().distinctCount, 2);
  });
});

describe('StatsCache', () => {
  it('misses until something is stored, then hits per owner and table', () => {
    const cache = new StatsCache<object>();
    const owner = {};
    assert.deepStrictEqual(cache.lookup(owner, 't'), { hit: false });
    const stats = { columns: [] };
    cache.store(owner, 't', stats);
    const hit = cache.lookup(owner, 't');
    assert.ok(hit.hit && hit.stats === stats);
    assert.deepStrictEqual(cache.lookup(owner, 'other'), { hit: false });
    assert.deepStrictEqual(cache.lookup({}, 't'), { hit: false });
  });

  it('remembers skipped results (e.g. timeouts) so they are not recomputed', () => {
    const cache = new StatsCache<object>();
    const owner = {};
    const skipped = skippedStats('timed out');
    cache.store(owner, 't', skipped);
    const hit = cache.lookup(owner, 't');
    assert.ok(hit.hit && hit.stats === skipped);
  });

  it('remembers failures as a hit with no stats', () => {
    const cache = new StatsCache<object>();
    const owner = {};
    cache.store(owner, 't', undefined);
    assert.deepStrictEqual(cache.lookup(owner, 't'), { hit: true, stats: undefined });
  });
});

describe('reportStatsFailure', () => {
  it('forwards to statsHooks.onError', () => {
    const original = statsHooks.onError;
    const seen: unknown[] = [];
    statsHooks.onError = (err) => {
      seen.push(err);
    };
    try {
      const boom = new Error('boom');
      reportStatsFailure(boom);
      assert.deepStrictEqual(seen, [boom]);
    } finally {
      statsHooks.onError = original;
    }
  });

  it('logs a warning by default, naming the error', () => {
    const original = statsHooks.log;
    const calls: unknown[][] = [];
    statsHooks.log = (...args) => {
      calls.push(args);
    };
    try {
      reportStatsFailure('oops');
    } finally {
      statsHooks.log = original;
    }
    assert.strictEqual(calls.length, 1);
    assert.match(String(calls[0][0]), /\[tablas\] column statistics failed/);
    assert.strictEqual(calls[0][1], 'oops');
  });

  it('writes to console.warn through the default log', () => {
    // console.warn can't be stubbed inside VS Code's extension host, so just
    // check the default log is callable without throwing.
    assert.doesNotThrow(() => statsHooks.log());
  });
});
