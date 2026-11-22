import * as assert from 'assert';
import {
  isCloseResultMessage,
  isRunQueryMessage,
  queryDataMessage,
  queryPayload,
  type RunQueryMessage,
} from '../../src/queryMessage';

describe('queryMessage', () => {
  describe('isRunQueryMessage', () => {
    const ok = { type: 'run-query', seq: 3, sql: 'SELECT 1' };

    it('accepts a well-formed request, including seq 0 and an empty text (the host answers that itself)', () => {
      assert.strictEqual(isRunQueryMessage(ok), true);
      assert.strictEqual(isRunQueryMessage({ ...ok, seq: 0 }), true);
      assert.strictEqual(isRunQueryMessage({ ...ok, sql: '' }), true);
    });

    it('rejects anything that is not an object, or has another type', () => {
      for (const bad of [undefined, null, 'run-query', 7, [], { ...ok, type: 'filter' }, { ...ok, type: undefined }]) {
        assert.strictEqual(isRunQueryMessage(bad), false, JSON.stringify(bad));
      }
    });

    it('rejects a seq that is not a non-negative safe integer', () => {
      for (const seq of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 2, '3', null, undefined]) {
        assert.strictEqual(isRunQueryMessage({ ...ok, seq }), false, String(seq));
      }
    });

    it('rejects an sql that is not a string', () => {
      for (const sql of [undefined, null, 1, ['SELECT 1'], { toString: () => 'SELECT 1' }]) {
        assert.strictEqual(isRunQueryMessage({ ...ok, sql }), false, String(sql));
      }
    });
  });

  describe('isCloseResultMessage', () => {
    it('accepts a non-negative integer seq', () => {
      assert.strictEqual(isCloseResultMessage({ type: 'close-result', seq: 0 }), true);
      assert.strictEqual(isCloseResultMessage({ type: 'close-result', seq: 12 }), true);
    });

    it('rejects anything else', () => {
      for (const bad of [undefined, null, 'close-result', { type: 'run-query', seq: 1 }, { type: 'close-result' },
        { type: 'close-result', seq: -1 }, { type: 'close-result', seq: 1.5 }, { type: 'close-result', seq: '1' }]) {
        assert.strictEqual(isCloseResultMessage(bad), false, JSON.stringify(bad));
      }
    });
  });

  describe('queryPayload', () => {
    it('carries the result address, its row count and the capped flag only when there is a result', () => {
      const m: RunQueryMessage = { type: 'run-query', seq: 4, sql: 'SELECT 1' };
      const d = { headers: ['a'], rows: [['1']], rowCount: 1, columnCount: 1 };
      assert.deepStrictEqual(queryPayload(m, { data: d, truncated: false, elapsedMs: 2, result: 4, materializedRows: 1 }), {
        seq: 4, data: d, truncated: false, elapsedMs: 2, result: 4, materializedRows: 1,
      });
      assert.deepStrictEqual(
        queryPayload(m, { data: d, truncated: true, elapsedMs: 2, result: 4, materializedRows: 100, capped: true }),
        { seq: 4, data: d, truncated: true, elapsedMs: 2, result: 4, materializedRows: 100, capped: true }
      );
      assert.deepStrictEqual(queryPayload(m, { data: d, truncated: false, elapsedMs: 2 }), {
        seq: 4, data: d, truncated: false, elapsedMs: 2,
      });
    });

    const message: RunQueryMessage = { type: 'run-query', seq: 9, sql: 'SELECT 1' };
    const data = { headers: ['a'], rows: [['1']], rowCount: 1, columnCount: 1 };

    it('echoes seq and carries the rows, truncation and timing of a result', () => {
      assert.deepStrictEqual(queryPayload(message, { data, truncated: true, elapsedMs: 12 }), {
        seq: 9,
        data,
        truncated: true,
        elapsedMs: 12,
      });
    });

    it('carries only the error text of a failure', () => {
      assert.deepStrictEqual(queryPayload(message, { error: 'nope' }), { seq: 9, error: 'nope' });
    });

    it('is JSON-safe, since it crosses postMessage', () => {
      const payload = queryPayload(message, { data, truncated: false, elapsedMs: 0 });
      assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), payload);
    });
  });

  it('queryDataMessage wraps a payload for the webview', () => {
    assert.deepStrictEqual(queryDataMessage({ seq: 1, error: 'x' }), {
      type: 'query-data',
      payload: { seq: 1, error: 'x' },
    });
  });
});
