import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import {
  candidateThemeNames,
  customizationRules,
  parseJsonc,
  resolveSqlColors,
  sqlThemeMessage,
  UI_THEME_OF_KIND,
  type SqlColors,
  type ThemeKind,
  type TokenRule,
} from './sqlTheme';

/**
 * The vscode-dependent half of `sqlTheme.ts`: finds the active colour theme's file among the
 * installed extensions, reads its `tokenColors` (following `include`s), adds the user's
 * `editor.tokenColorCustomizations`, and resolves the SQL colours. Excluded from coverage like
 * the providers; the logic that can be tested lives in `sqlTheme.ts`.
 */

/** Settings whose change can change the SQL colours (a webview re-requests them on any of these). */
export const SQL_THEME_SETTINGS: readonly string[] = [
  'workbench.colorTheme',
  'workbench.preferredDarkColorTheme',
  'workbench.preferredLightColorTheme',
  'workbench.preferredHighContrastColorTheme',
  'workbench.preferredHighContrastLightColorTheme',
  'window.autoDetectColorScheme',
  'window.autoDetectHighContrast',
  'editor.tokenColorCustomizations',
];

const MAX_THEME_BYTES = 5 * 1024 * 1024;
const MAX_INCLUDE_DEPTH = 6;

/** The theme called `name` (its label or id) from any installed extension: its file and declared brightness. */
function findTheme(name: string): { file: string; uiTheme: string | undefined } | undefined {
  for (const extension of vscode.extensions.all) {
    const themes: unknown = (extension.packageJSON as { contributes?: { themes?: unknown } } | undefined)?.contributes?.themes;
    if (!Array.isArray(themes)) {
      continue;
    }
    for (const theme of themes) {
      const entry = theme as { id?: unknown; label?: unknown; path?: unknown; uiTheme?: unknown } | null;
      if (entry && (entry.id === name || entry.label === name) && typeof entry.path === 'string') {
        return {
          file: path.join(extension.extensionPath, entry.path),
          uiTheme: typeof entry.uiTheme === 'string' ? entry.uiTheme : undefined,
        };
      }
    }
  }
  return undefined;
}

function activeThemeKind(): ThemeKind {
  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Light:
      return 'light';
    case vscode.ColorThemeKind.HighContrast:
      return 'high-contrast';
    case vscode.ColorThemeKind.HighContrastLight:
      return 'high-contrast-light';
    default:
      return 'dark';
  }
}

/**
 * The active theme. VS Code has no API for its name, and `workbench.colorTheme` is not it when the
 * scheme is auto-detected, so try the candidates from the settings and take the first whose
 * declared brightness is the active kind (else the first one that exists at all).
 */
function findActiveTheme(): { name: string; file: string } | undefined {
  const workbench = vscode.workspace.getConfiguration('workbench');
  const kind = activeThemeKind();
  const names = candidateThemeNames(
    {
      colorTheme: workbench.get('colorTheme'),
      preferredDarkColorTheme: workbench.get('preferredDarkColorTheme'),
      preferredLightColorTheme: workbench.get('preferredLightColorTheme'),
      preferredHighContrastColorTheme: workbench.get('preferredHighContrastColorTheme'),
      preferredHighContrastLightColorTheme: workbench.get('preferredHighContrastLightColorTheme'),
      autoDetectColorScheme: vscode.workspace.getConfiguration('window').get('autoDetectColorScheme'),
      autoDetectHighContrast: vscode.workspace.getConfiguration('window').get('autoDetectHighContrast'),
    },
    kind,
  );
  let fallback: { name: string; file: string } | undefined;
  for (const name of names) {
    const theme = findTheme(name);
    if (!theme) {
      continue;
    }
    if (theme.uiTheme === undefined || theme.uiTheme === UI_THEME_OF_KIND[kind]) {
      return { name, file: theme.file };
    }
    fallback ??= { name, file: theme.file };
  }
  return fallback;
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
    const active = findActiveTheme();
    const name = active?.name;
    const customizations = vscode.workspace.getConfiguration('editor').get<unknown>('tokenColorCustomizations');
    const key = `${name ?? ''}\n${active?.file ?? ''}\n${JSON.stringify(customizations ?? null)}`;
    if (cached && cached.key === key) {
      return cached.colors;
    }
    const themeRules = active ? await readThemeRules(active.file) : [];
    const colors = resolveSqlColors([...themeRules, ...customizationRules(customizations, name)]);
    cached = { key, colors };
    return colors;
  } catch {
    return {};
  }
}

/**
 * Keeps a webview's SQL box coloured with the active theme: `send()` posts the colours now
 * (call it after the webview's ready handshake) and they are posted again whenever the theme or
 * one of `SQL_THEME_SETTINGS` changes, until `dispose()`.
 */
export function watchSqlTheme(post: (message: unknown) => void): { send: () => Promise<void>; dispose: () => void } {
  const send = async (): Promise<void> => {
    post(sqlThemeMessage(await loadSqlColors()));
  };
  const subscriptions = [
    vscode.window.onDidChangeActiveColorTheme(() => void send()),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (SQL_THEME_SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
        void send();
      }
    }),
  ];
  return { send, dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
}
