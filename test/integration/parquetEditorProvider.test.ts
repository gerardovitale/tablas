import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { ParquetParseOutcome } from '../../src/parquetParser';

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');

function fixtureUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(fixturesDir, name));
}

function getApi(): TablasApi {
  const ext = vscode.extensions.getExtension<TablasApi>('gerardovitale.tablas');
  assert.ok(ext, 'Extension should be installed in Extension Development Host');
  assert.ok(ext.isActive, 'Extension should be active');
  assert.ok(ext.exports, 'Extension should export its public API');
  return ext.exports;
}

/**
 * Opens a fixture through the real `tablas.parquetViewer` custom editor and
 * waits for `onDidPostParquetData` — i.e. for the extension host to
 * actually finish the ready-handshake and post `parquet-data` to the
 * webview. Just awaiting `vscode.openWith` isn't enough:
 * `resolveCustomEditor`'s `onDidReceiveMessage` handler is async and
 * unawaited, so a broken handshake wouldn't make `openWith`'s promise
 * reject.
 */
function openParquetAndAwaitOutcome(name: string): Promise<ParquetParseOutcome> {
  const api = getApi();
  return new Promise<ParquetParseOutcome>((resolve, reject) => {
    const subscription = api.onDidPostParquetData((outcome) => {
      subscription.dispose();
      resolve(outcome);
    });
    vscode.commands
      .executeCommand('vscode.openWith', fixtureUri(name), 'tablas.parquetViewer')
      .then(undefined, (err) => {
        subscription.dispose();
        reject(err);
      });
  });
}

describe('ParquetEditorProvider Integration', () => {
  before(async () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    assert.ok(ext, 'Extension should be installed in Extension Development Host');
    if (!ext.isActive) {
      await ext.activate();
    }
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  afterEach(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('tablas.parquetViewer opens a Parquet file', async () => {
    await openParquetAndAwaitOutcome('simple.parquet');
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label.includes('simple.parquet'))
      ),
      'simple.parquet should be open in a tab'
    );
  });

  it('posts parsed parquet-data for simple.parquet', async () => {
    const outcome = await openParquetAndAwaitOutcome('simple.parquet');
    assert.strictEqual(outcome.success, true, 'Parsing simple.parquet should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.rowCount, 3);
      assert.strictEqual(outcome.data.columnCount, 4);
    }
  });

  it('posts parsed parquet-data for empty.parquet', async () => {
    const outcome = await openParquetAndAwaitOutcome('empty.parquet');
    assert.strictEqual(outcome.success, true, 'Parsing empty.parquet should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.rowCount, 0);
      assert.ok(outcome.data.columnCount > 0, 'empty.parquet should still expose its schema');
    }
  });

  it('posts parsed parquet-data for nulls.parquet', async () => {
    const outcome = await openParquetAndAwaitOutcome('nulls.parquet');
    assert.strictEqual(outcome.success, true, 'Parsing nulls.parquet should succeed');
    if (outcome.success) {
      assert.ok(outcome.data.rowCount > 0, 'nulls.parquet should parse at least one row');
    }
  });

  it('posts a failed outcome for a corrupt file, through the real handshake', async () => {
    const outcome = await openParquetAndAwaitOutcome('corrupt.parquet');
    assert.strictEqual(outcome.success, false, 'Parsing corrupt.parquet should fail cleanly');
  });

  it('posts a failed outcome for an unsupported compression codec', async () => {
    const outcome = await openParquetAndAwaitOutcome('unsupported-codec.parquet');
    assert.strictEqual(
      outcome.success,
      false,
      'Parsing a gzip-compressed file should fail cleanly'
    );
  });
});
