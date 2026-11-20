import * as assert from 'assert';
import * as vscode from 'vscode';
import { isHexColor, SQL_TOKEN_CLASSES } from '../../src/sqlTheme';
import { loadSqlColors } from '../../src/sqlThemeHost';

/**
 * The part of the SQL-box colouring that needs a real VS Code: finding the active theme among the
 * installed extensions, following its `include`s and applying the user's customizations.
 */
describe('loadSqlColors (the active theme, in a real VS Code)', () => {
  it('reads the syntax colours of the active theme, following its includes', async () => {
    const colors = await loadSqlColors();
    // The default themes colour at least keywords, strings, numbers and comments, via `include`d files.
    for (const kind of ['keyword', 'string', 'number', 'comment'] as const) {
      assert.ok(isHexColor(colors[kind]), `${kind}: ${String(colors[kind])}`);
    }
    for (const [kind, color] of Object.entries(colors)) {
      assert.ok((SQL_TOKEN_CLASSES as readonly string[]).includes(kind), kind);
      assert.ok(isHexColor(color), `${kind}: ${String(color)}`);
    }
  });

  it('applies editor.tokenColorCustomizations on top of the theme, and drops them again', async () => {
    const config = vscode.workspace.getConfiguration('editor');
    const before = config.inspect('tokenColorCustomizations')?.globalValue;
    try {
      await config.update('tokenColorCustomizations', { comments: '#ff00aa', textMateRules: [{ scope: 'keyword.other.sql', settings: { foreground: '#00ffaa' } }] }, vscode.ConfigurationTarget.Global);
      const colors = await loadSqlColors();
      assert.strictEqual(colors.comment, '#ff00aa');
      assert.strictEqual(colors.keyword, '#00ffaa');
    } finally {
      await config.update('tokenColorCustomizations', before, vscode.ConfigurationTarget.Global);
    }
    const restored = await loadSqlColors();
    assert.notStrictEqual(restored.comment, '#ff00aa');
  });

  it('never throws for a theme it cannot find', async () => {
    const config = vscode.workspace.getConfiguration('workbench');
    const before = config.inspect('colorTheme')?.globalValue;
    try {
      await config.update('colorTheme', 'No Such Theme Anywhere', vscode.ConfigurationTarget.Global);
      const colors = await loadSqlColors();
      assert.deepStrictEqual(colors, {});
    } finally {
      await config.update('colorTheme', before, vscode.ConfigurationTarget.Global);
    }
  });
});
