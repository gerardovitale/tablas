import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { customizationRules, parseJsonc, resolveSqlColors, type SqlColors, type TokenRule } from './sqlTheme';

/**
 * The vscode-dependent half of `sqlTheme.ts`: finds the active colour theme's file among the
 * installed extensions, reads its `tokenColors` (following `include`s), adds the user's
 * `editor.tokenColorCustomizations`, and resolves the SQL colours. Excluded from coverage like
 * the providers; the logic that can be tested lives in `sqlTheme.ts`.
 */

const MAX_THEME_BYTES = 5 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 6;

/** The file of the theme called `name` (its label or id), from any installed extension. */
function findThemeFile(name: string): string | undefined {
  for (const extension of vscode.extensions.all) {
    const themes: unknown = (extension.packageJSON as { contributes?: { themes?: unknown } } | undefined)?.contributes?.themes;
    if (!Array.isArray(themes)) {
      continue;
    }
    for (const theme of themes) {
      const entry = theme as { id?: unknown; label?: unknown; path?: unknown } | null;
      if (entry && (entry.id === name || entry.label === name) && typeof entry.path === 'string') {
        return path.join(extension.extensionPath, entry.path);
      }
    }
  }
  return undefined;
}

/**
 * A theme file's rules, its `include`d theme's first (so its own win). A file that is not JSON
 * (an old XML `.tmTheme`) or is missing contributes nothing.
 */
async function readThemeRules(file: string, depth = 0): Promise<TokenRule[]> {
  if (depth > MAX_INCLUDE_DEPTH) {
    return [];
  }
  try {
    if ((await fs.promises.stat(file)).size > MAX_THEME_BYTES) {
      return [];
    }
    const theme = parseJsonc(await fs.promises.readFile(file, 'utf8')) as {
      include?: unknown;
      tokenColors?: unknown;
      settings?: unknown;
    };
    const rules: TokenRule[] = [];
    if (typeof theme.include === 'string') {
      rules.push(...(await readThemeRules(path.resolve(path.dirname(file), theme.include), depth + 1)));
    }
    if (typeof theme.tokenColors === 'string') {
      // `tokenColors` may also name another file holding the rules.
      rules.push(...(await readThemeRules(path.resolve(path.dirname(file), theme.tokenColors), depth + 1)));
    } else if (Array.isArray(theme.tokenColors)) {
      rules.push(...(theme.tokenColors as TokenRule[]));
    } else if (Array.isArray(theme.settings)) {
      rules.push(...(theme.settings as TokenRule[]));
    }
    return rules;
  } catch {
    return [];
  }
}

let cached: { key: string; colors: SqlColors } | undefined;

/**
 * The SQL colours of the active theme with the user's customizations applied. Never throws: any
 * failure (no such theme, an unreadable file) gives `{}`, and the webview keeps its own defaults.
 */
export async function loadSqlColors(): Promise<SqlColors> {
  try {
    const name = vscode.workspace.getConfiguration('workbench').get<string>('colorTheme');
    const customizations = vscode.workspace.getConfiguration('editor').get<unknown>('tokenColorCustomizations');
    const key = `${name ?? ''}\n${JSON.stringify(customizations ?? null)}`;
    if (cached && cached.key === key) {
      return cached.colors;
    }
    const file = name ? findThemeFile(name) : undefined;
    const themeRules = file ? await readThemeRules(file) : [];
    const colors = resolveSqlColors([...themeRules, ...customizationRules(customizations, name)]);
    cached = { key, colors };
    return colors;
  } catch {
    return {};
  }
}
