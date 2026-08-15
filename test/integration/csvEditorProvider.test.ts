import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';
import type { TablasApi } from '../../src/extension';
import type { CsvParseOutcome } from '../../src/csvParser';

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
 * Opens a fixture through the real `tablas.csvViewer` custom editor and
 * waits for `onDidPostCsvData` — i.e. for the extension host to actually
 * finish the ready-handshake and post `csv-data` to the webview. Just
 * awaiting `vscode.openWith` isn't enough: `resolveCustomEditor`'s
 * `onDidReceiveMessage` handler is async and unawaited, so a broken
 * handshake wouldn't make `openWith`'s promise reject.
 */
function openCsvAndAwaitOutcome(name: string): Promise<CsvParseOutcome> {
  const api = getApi();
  return new Promise<CsvParseOutcome>((resolve, reject) => {
    const subscription = api.onDidPostCsvData((outcome) => {
      subscription.dispose();
      resolve(outcome);
    });
    vscode.commands
      .executeCommand('vscode.openWith', fixtureUri(name), 'tablas.csvViewer')
      .then(undefined, (err) => {
        subscription.dispose();
        reject(err);
      });
  });
}

describe('CsvEditorProvider Integration', () => {
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

  it('extension is present', () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    assert.ok(ext, 'Extension should be installed in Extension Development Host');
  });

  it('extension activates successfully', async () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    assert.ok(ext, 'Extension should be installed');
    await ext.activate();
    assert.strictEqual(ext.isActive, true, 'Extension should be active');
  });

  it('tablas.csvViewer opens a CSV file', async () => {
    await openCsvAndAwaitOutcome('simple.csv');
    assert.ok(
      vscode.window.tabGroups.all.some((group) =>
        group.tabs.some((tab) => tab.label.includes('simple.csv'))
      ),
      'simple.csv should be open in a tab'
    );
  });

  it('posts parsed csv-data for simple.csv', async () => {
    const outcome = await openCsvAndAwaitOutcome('simple.csv');
    assert.strictEqual(outcome.success, true, 'Parsing simple.csv should succeed');
    if (outcome.success) {
      assert.ok(outcome.data.rowCount > 0, 'simple.csv should parse at least one row');
      assert.ok(outcome.data.columnCount > 0, 'simple.csv should parse at least one column');
    }
  });

  it('posts parsed csv-data for empty.csv', async () => {
    const outcome = await openCsvAndAwaitOutcome('empty.csv');
    assert.strictEqual(outcome.success, true, 'Parsing empty.csv should succeed');
    if (outcome.success) {
      assert.strictEqual(outcome.data.rowCount, 0);
      assert.strictEqual(outcome.data.columnCount, 0);
    }
  });

  it('posts parsed csv-data for quoted.csv', async () => {
    const outcome = await openCsvAndAwaitOutcome('quoted.csv');
    assert.strictEqual(outcome.success, true, 'Parsing quoted.csv should succeed');
    if (outcome.success) {
      assert.ok(outcome.data.rowCount > 0, 'quoted.csv should parse at least one row');
    }
  });
});
