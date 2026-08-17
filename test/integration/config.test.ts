import * as assert from 'assert';
import * as vscode from 'vscode';
import { getMaxRowsSetting, DEFAULT_MAX_ROWS, MAX_ROWS_CEILING } from '../../src/config';

describe('getMaxRowsSetting Integration', () => {
  afterEach(async () => {
    // Reset so this suite doesn't leak configuration into other test files.
    await vscode.workspace
      .getConfiguration('tablas')
      .update('maxRows', undefined, vscode.ConfigurationTarget.Global);
  });

  it('returns the package.json default when unset', () => {
    assert.strictEqual(getMaxRowsSetting(), DEFAULT_MAX_ROWS);
  });

  it('honors a configured value within range', async () => {
    await vscode.workspace
      .getConfiguration('tablas')
      .update('maxRows', 42, vscode.ConfigurationTarget.Global);
    assert.strictEqual(getMaxRowsSetting(), 42);
  });

  it('clamps a value above the ceiling -- workspace settings cannot fully disable the row cap', async () => {
    await vscode.workspace
      .getConfiguration('tablas')
      .update('maxRows', 999_999_999, vscode.ConfigurationTarget.Global);
    assert.strictEqual(getMaxRowsSetting(), MAX_ROWS_CEILING);
  });

  it('clamps a negative configured value up to 1', async () => {
    await vscode.workspace
      .getConfiguration('tablas')
      .update('maxRows', -10, vscode.ConfigurationTarget.Global);
    assert.strictEqual(getMaxRowsSetting(), 1);
  });
});
