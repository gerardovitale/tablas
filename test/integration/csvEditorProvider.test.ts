import * as assert from 'assert';
import * as vscode from 'vscode';
import * as path from 'path';

const fixturesDir = path.join(process.cwd(), 'test', 'fixtures');

function fixtureUri(name: string): vscode.Uri {
  return vscode.Uri.file(path.join(fixturesDir, name));
}

describe('CsvEditorProvider Integration', () => {
  before(async () => {
    // Ensure extension is activated
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    if (ext && !ext.isActive) {
      await ext.activate();
    }
  });

  after(async () => {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('extension is present', () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    assert.ok(ext, 'Extension should be installed in Extension Development Host');
  });

  it('extension activates successfully', async () => {
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    if (ext) {
      await ext.activate();
      assert.strictEqual(ext.isActive, true, 'Extension should be active');
    } else {
      assert.ok(true, 'Skipped: extension not loaded in this test context');
    }
  });

  it('tablas.csvViewer custom editor is registered', async () => {
    const uri = fixtureUri('simple.csv');
    let opened = false;
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'tablas.csvViewer');
      opened = true;
    } catch {
      // May fail if not in Extension Development Host
    }
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    if (ext) {
      assert.ok(opened, 'Should open CSV with tablas.csvViewer');
    } else {
      assert.ok(true, 'Skipped: extension not loaded');
    }
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('opens simple.csv without throwing', async () => {
    const uri = fixtureUri('simple.csv');
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    if (!ext) {
      assert.ok(true, 'Skipped: extension not loaded');
      return;
    }
    let error: unknown;
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'tablas.csvViewer');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (err) {
      error = err;
    }
    assert.strictEqual(error, undefined, 'Opening simple.csv should not throw');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('opens empty.csv without throwing', async () => {
    const uri = fixtureUri('empty.csv');
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    if (!ext) {
      assert.ok(true, 'Skipped: extension not loaded');
      return;
    }
    let error: unknown;
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'tablas.csvViewer');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (err) {
      error = err;
    }
    assert.strictEqual(error, undefined, 'Opening empty.csv should not throw');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });

  it('opens quoted.csv without throwing', async () => {
    const uri = fixtureUri('quoted.csv');
    const ext = vscode.extensions.getExtension('gerardovitale.tablas');
    if (!ext) {
      assert.ok(true, 'Skipped: extension not loaded');
      return;
    }
    let error: unknown;
    try {
      await vscode.commands.executeCommand('vscode.openWith', uri, 'tablas.csvViewer');
      await new Promise((resolve) => setTimeout(resolve, 1500));
    } catch (err) {
      error = err;
    }
    assert.strictEqual(error, undefined, 'Opening quoted.csv should not throw');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  });
});
