import * as assert from 'assert';
import { filterLimits } from '../../src/filter';
import { filterDataMessage, isFilterMessage } from '../../src/filterMessage';

const valid = { type: 'filter', seq: 1, filters: [{ column: 0, text: 'abc' }] };

describe('isFilterMessage', () => {
  it('accepts a request without a table (CSV/Parquet)', () => {
    assert.strictEqual(isFilterMessage(valid), true);
  });

  it('accepts a request naming a table or sheet', () => {
    assert.strictEqual(isFilterMessage({ ...valid, table: 'orders' }), true);
    assert.strictEqual(isFilterMessage({ ...valid, table: '' }), true);
  });

  it('accepts an empty filter list (all cleared) and empty filter text', () => {
    assert.strictEqual(isFilterMessage({ ...valid, filters: [] }), true);
    assert.strictEqual(isFilterMessage({ ...valid, filters: [{ column: 2, text: '' }] }), true);
  });

  it('rejects a bad seq', () => {
    for (const seq of [undefined, '1', 1.5, -1, NaN, Infinity, null, 2 ** 60]) {
      assert.strictEqual(isFilterMessage({ ...valid, seq }), false, String(seq));
    }
  });

  it('rejects a table that is not a string', () => {
    for (const table of [1, null, {}, ['a'], true]) {
      assert.strictEqual(isFilterMessage({ ...valid, table }), false, JSON.stringify(table));
    }
  });

  it('rejects filters that are not an array', () => {
    for (const filters of [undefined, null, {}, 'x', 1]) {
      assert.strictEqual(isFilterMessage({ ...valid, filters }), false, JSON.stringify(filters));
    }
  });

  it('rejects a malformed entry', () => {
    const bad: unknown[] = [
      null,
      'x',
      {},
      { column: 0 },
      { text: 'a' },
      { column: -1, text: 'a' },
      { column: 1.5, text: 'a' },
      { column: '0', text: 'a' },
      { column: 0, text: 5 },
      { column: 0, text: null },
    ];
    for (const entry of bad) {
      assert.strictEqual(isFilterMessage({ ...valid, filters: [entry] }), false, JSON.stringify(entry));
    }
  });

  it('rejects the same column twice', () => {
    assert.strictEqual(
      isFilterMessage({ ...valid, filters: [{ column: 1, text: 'a' }, { column: 1, text: 'b' }] }),
      false
    );
  });

  it('rejects filter text over the length limit, accepts text at it', () => {
    const limit = filterLimits.maxTextLength;
    assert.strictEqual(isFilterMessage({ ...valid, filters: [{ column: 0, text: 'x'.repeat(limit) }] }), true);
    assert.strictEqual(isFilterMessage({ ...valid, filters: [{ column: 0, text: 'x'.repeat(limit + 1) }] }), false);
  });

  it('rejects other message types and non-objects', () => {
    for (const message of [{ type: 'ready' }, { type: 'get-stats' }, { ...valid, type: 'select-table' }, {}, null, undefined, 'filter', 42]) {
      assert.strictEqual(isFilterMessage(message), false, JSON.stringify(message));
    }
  });
});

describe('filterDataMessage', () => {
  it('wraps the payload under the filter-data type', () => {
    const payload = { seq: 3, table: 't', rows: [['a']], matchCount: 1 };
    assert.deepStrictEqual(filterDataMessage(payload), { type: 'filter-data', payload });
  });
});
