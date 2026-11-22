import * as assert from 'assert';
import { isGetStatsMessage, statsDataMessage } from '../../src/statsMessage';

describe('isGetStatsMessage', () => {
  it('accepts a request without a table (CSV/Parquet)', () => {
    assert.strictEqual(isGetStatsMessage({ type: 'get-stats' }), true);
  });

  it('accepts a request naming a table or sheet', () => {
    assert.strictEqual(isGetStatsMessage({ type: 'get-stats', table: 'orders' }), true);
    assert.strictEqual(isGetStatsMessage({ type: 'get-stats', table: '' }), true);
  });

  it('accepts a numeric seq, and rejects any other kind', () => {
    assert.strictEqual(isGetStatsMessage({ type: 'get-stats', seq: 7 }), true);
    assert.strictEqual(isGetStatsMessage({ type: 'get-stats', table: 't', seq: 0 }), true);
    for (const seq of ['1', null, {}, true]) {
      assert.strictEqual(isGetStatsMessage({ type: 'get-stats', seq }), false, JSON.stringify(seq));
    }
  });

  it('rejects a table that is not a string', () => {
    for (const table of [1, null, {}, ['a'], true]) {
      assert.strictEqual(isGetStatsMessage({ type: 'get-stats', table }), false, JSON.stringify(table));
    }
  });

  it('accepts a query result address, but never together with a table', () => {
    assert.strictEqual(isGetStatsMessage({ type: 'get-stats', result: 4 }), true);
    assert.strictEqual(isGetStatsMessage({ type: 'get-stats', result: 0, seq: 2 }), true);
    assert.strictEqual(isGetStatsMessage({ type: 'get-stats', result: 4, table: 't' }), false);
    for (const result of [-1, 1.5, NaN, '4', null, {}, 2 ** 60]) {
      assert.strictEqual(isGetStatsMessage({ type: 'get-stats', result }), false, String(result));
    }
  });

  it('rejects other message types and non-objects', () => {
    for (const message of [{ type: 'ready' }, { type: 'select-table', table: 't' }, {}, null, undefined, 'get-stats', 42]) {
      assert.strictEqual(isGetStatsMessage(message), false, JSON.stringify(message));
    }
  });
});

describe('statsDataMessage', () => {
  it('wraps the payload under the stats-data type', () => {
    const payload = { table: 't', stats: { columns: [] } };
    assert.deepStrictEqual(statsDataMessage(payload), { type: 'stats-data', payload });
  });

  it("echoes the request's seq in the payload, and adds nothing when there is none", () => {
    assert.deepStrictEqual(statsDataMessage({ table: 't' }, 5), { type: 'stats-data', payload: { table: 't', seq: 5 } });
    assert.deepStrictEqual(statsDataMessage({ table: 't' }, 0), { type: 'stats-data', payload: { table: 't', seq: 0 } });
    assert.deepStrictEqual(statsDataMessage({ table: 't' }), { type: 'stats-data', payload: { table: 't' } });
  });

  it('survives a JSON round-trip (it crosses postMessage)', () => {
    const message = statsDataMessage({ table: 't', stats: { columns: [{ type: 'integer', nullCount: 0 }] } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(message)), message);
  });

  it('carries a failed computation as a payload without stats', () => {
    assert.deepStrictEqual(statsDataMessage({ table: 't' }), { type: 'stats-data', payload: { table: 't' } });
  });
});
