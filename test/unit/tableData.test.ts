import * as assert from 'assert';
import { bigIntToSafeNumber, clampMaxRows } from '../../src/tableData';

describe('clampMaxRows', () => {
  it('passes undefined through unchanged (no cap)', () => {
    assert.strictEqual(clampMaxRows(undefined), undefined);
  });

  it('leaves a valid positive integer unchanged', () => {
    assert.strictEqual(clampMaxRows(5000), 5000);
  });

  it('floors a fractional value', () => {
    assert.strictEqual(clampMaxRows(2.9), 2);
  });

  it('clamps zero up to 1', () => {
    assert.strictEqual(clampMaxRows(0), 1);
  });

  it('clamps a negative value up to 1, not "all but the last N"', () => {
    assert.strictEqual(clampMaxRows(-5), 1);
  });

  it('passes non-finite values through unchanged', () => {
    assert.ok(Number.isNaN(clampMaxRows(NaN)));
    assert.strictEqual(clampMaxRows(Infinity), Infinity);
  });
});

describe('bigIntToSafeNumber', () => {
  it('converts a normal row count exactly', () => {
    assert.strictEqual(bigIntToSafeNumber(132_324n), 132_324);
  });

  it('converts 0 rows', () => {
    assert.strictEqual(bigIntToSafeNumber(0n), 0);
  });

  it('converts Number.MAX_SAFE_INTEGER exactly, at the clamp boundary', () => {
    assert.strictEqual(
      bigIntToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER)),
      Number.MAX_SAFE_INTEGER
    );
  });

  it('clamps a value past Number.MAX_SAFE_INTEGER instead of silently rounding', () => {
    const wayTooLarge = BigInt(Number.MAX_SAFE_INTEGER) * 1000n;
    assert.strictEqual(bigIntToSafeNumber(wayTooLarge), Number.MAX_SAFE_INTEGER);
  });
});
