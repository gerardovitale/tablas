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

  it('rejects a table that is not a string', () => {
    for (const table of [1, null, {}, ['a'], true]) {
      assert.strictEqual(isGetStatsMessage({ type: 'get-stats', table }), false, JSON.stringify(table));
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

  it('survives a JSON round-trip (it crosses postMessage)', () => {
    const message = statsDataMessage({ table: 't', stats: { columns: [{ type: 'integer', nullCount: 0 }] } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(message)), message);
  });

  it('carries a failed computation as a payload without stats', () => {
    assert.deepStrictEqual(statsDataMessage({ table: 't' }), { type: 'stats-data', payload: { table: 't' } });
  });
});
