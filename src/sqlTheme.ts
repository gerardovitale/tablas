/**
 * Colours for the SQL box, taken from the user's active colour theme.
 *
 * A webview gets the workbench colours as CSS variables (`--vscode-editor-background`, ...)
 * but not the *syntax* colours of the theme (its TextMate `tokenColors`), so the host reads
 * them and sends the few the SQL box needs. This file is the vscode-free core, unit-tested
 * from `test/unit/`; `sqlThemeHost.ts` is the part that finds the theme and its files.
 *
 * Scope matching is a deliberate simplification of TextMate's: a rule's selector matches a
 * token scope by dotted prefix (`keyword` matches `keyword.other.sql`), the longest selector
 * wins and, among equals, the later rule. Selectors with a parent part (`source.sql keyword`)
 * must have that parent in the scope stack (`source.sql`); selectors with exclusions (`-`) or
 * groups are ignored. That is enough for how themes colour SQL in practice.
 */

/** The active theme's brightness class, as `vscode.ColorThemeKind` names it. */
export type ThemeKind = 'light' | 'dark' | 'high-contrast' | 'high-contrast-light';

/** The `workbench.*` / `window.*` settings that decide which theme is active. */
export interface ThemeSettings {
  colorTheme?: unknown;
  preferredDarkColorTheme?: unknown;
  preferredLightColorTheme?: unknown;
  preferredHighContrastColorTheme?: unknown;
  preferredHighContrastLightColorTheme?: unknown;
  autoDetectColorScheme?: unknown;
  autoDetectHighContrast?: unknown;
}

/**
 * Names of the themes that may be the active one, most likely first. `workbench.colorTheme` is
 * only the active theme when the colour scheme is not auto-detected: with
 * `window.autoDetectColorScheme` (or `autoDetectHighContrast`, on by default) VS Code switches to
 * the matching `workbench.preferred*ColorTheme` and leaves `colorTheme` holding the *other* one.
 * The host takes the first candidate whose own brightness (`uiTheme`) equals the active `kind`.
 */
export function candidateThemeNames(settings: ThemeSettings, kind: ThemeKind): string[] {
  const preferred = {
    dark: settings.preferredDarkColorTheme,
    light: settings.preferredLightColorTheme,
    'high-contrast': settings.preferredHighContrastColorTheme,
    'high-contrast-light': settings.preferredHighContrastLightColorTheme,
  }[kind];
  const autoDetect =
    kind === 'dark' || kind === 'light' ? settings.autoDetectColorScheme === true : settings.autoDetectHighContrast !== false;
  const ordered = autoDetect ? [preferred, settings.colorTheme] : [settings.colorTheme];
  const names: string[] = [];
  for (const name of ordered) {
    if (typeof name === 'string' && name !== '' && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/** The `uiTheme` a theme contribution declares for each kind. */
export const UI_THEME_OF_KIND: Record<ThemeKind, string> = {
  light: 'vs',
  dark: 'vs-dark',
  'high-contrast': 'hc-black',
  'high-contrast-light': 'hc-light',
};

/** The kinds of token the SQL box colours. */
export type SqlTokenClass =
  | 'keyword'
  | 'function'
  | 'string'
  | 'number'
  | 'comment'
  | 'type'
  | 'operator'
  | 'identifier'
  | 'constant';

export const SQL_TOKEN_CLASSES: readonly SqlTokenClass[] = [
  'keyword',
  'function',
  'string',
  'number',
  'comment',
  'type',
  'operator',
  'identifier',
  'constant',
];

/**
 * The scopes VS Code's SQL grammar gives each kind of token (the first is the usual one; the
 * best match among all of them wins, so a theme that styles `entity.name.function` instead of
 * `support.function` still colours function names).
 */
export const SQL_TOKEN_SCOPES: Record<SqlTokenClass, readonly string[]> = {
  keyword: ['keyword.other.sql', 'keyword.other.DML.sql'],
  function: ['support.function.sql', 'entity.name.function.sql'],
  string: ['string.quoted.single.sql'],
  number: ['constant.numeric.sql'],
  comment: ['comment.line.double-dash.sql', 'comment.block.sql'],
  type: ['storage.type.sql'],
  operator: ['keyword.operator.sql'],
  identifier: ['string.quoted.double.sql'],
  constant: ['constant.language.sql'],
};

/** The scope stack every SQL token sits in, below its own scope. */
const SOURCE_SCOPE = 'source.sql';

/** One entry of a theme's `tokenColors` (or of a `textMateRules` customization). */
export interface TokenRule {
  scope?: string | string[];
  settings?: { foreground?: unknown };
}

export type SqlColors = Partial<Record<SqlTokenClass, string>>;

/** host -> webview. Colours are `#rgb`/`#rrggbb`/`#rrggbbaa`; a missing class keeps the built-in default. */
export interface SqlThemeMessage {
  type: 'sql-theme';
  colors: SqlColors;
}

const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && HEX_COLOR.test(value);
}

export function sqlThemeMessage(colors: SqlColors): SqlThemeMessage {
  return { type: 'sql-theme', colors };
}

/** A rule's selectors: `scope` is a string (maybe comma-separated) or an array of them. */
function selectorsOf(scope: TokenRule['scope']): string[] {
  const list = Array.isArray(scope) ? scope : typeof scope === 'string' ? [scope] : [];
  return list
    .filter((entry): entry is string => typeof entry === 'string')
    .flatMap((entry) => entry.split(','))
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
}

function matchesScope(selector: string, scope: string): boolean {
  return scope === selector || scope.startsWith(selector + '.');
}

/**
 * How well `selector` matches a token whose own scope is `tokenScope` (under `source.sql`):
 * the length of its last part, or `undefined` for no match.
 */
function matchLength(selector: string, tokenScope: string): number | undefined {
  if (/[-|()]/.test(selector.replace(/[a-z0-9_]-[a-z0-9_]/gi, ''))) {
    return undefined; // exclusions, groups and the like: not supported
  }
  const parts = selector.split(/\s+/).filter((part) => part !== '');
  const last = parts.pop();
  if (last === undefined || !matchesScope(last, tokenScope)) {
    return undefined;
  }
  return parts.every((parent) => matchesScope(parent, SOURCE_SCOPE)) ? last.length : undefined;
}

/**
 * The colour the rules give each kind of SQL token. A kind no rule colours is left out (the
 * webview then uses its own default for the theme's brightness).
 */
export function resolveSqlColors(rules: readonly TokenRule[]): SqlColors {
  const colors: SqlColors = {};
  for (const tokenClass of SQL_TOKEN_CLASSES) {
    let bestLength = -1;
    let best: string | undefined;
    for (const tokenScope of SQL_TOKEN_SCOPES[tokenClass]) {
      for (const rule of rules) {
        const foreground = rule?.settings?.foreground;
        if (!isHexColor(foreground)) {
          continue;
        }
        for (const selector of selectorsOf(rule.scope)) {
          const length = matchLength(selector, tokenScope);
          // `>=`: among equally specific selectors the later rule wins, as in a theme.
          if (length !== undefined && length >= bestLength) {
            bestLength = length;
            best = foreground.toLowerCase();
          }
        }
      }
    }
    if (best !== undefined) {
      colors[tokenClass] = best;
    }
  }
  return colors;
}

/**
 * `editor.tokenColorCustomizations` as rules: the simple keys (`comments`, `strings`, ...), then
 * its `textMateRules`; the block for the active theme (`"[Theme Name]"`) comes after the global
 * one, so it wins.
 */
export function customizationRules(customizations: unknown, themeName: string | undefined): TokenRule[] {
  const rules: TokenRule[] = [];
  const addBlock = (block: unknown): void => {
    if (typeof block !== 'object' || block === null) {
      return;
    }
    const record = block as Record<string, unknown>;
    const simple: Array<[string, string[]]> = [
      ['comments', ['comment']],
      ['strings', ['string']],
      ['keywords', ['keyword']],
      ['numbers', ['constant.numeric']],
      ['functions', ['entity.name.function', 'support.function']],
      ['types', ['entity.name.type', 'entity.name.class', 'support.type', 'support.class', 'storage.type']],
    ];
    for (const [key, scope] of simple) {
      const value = record[key];
      const foreground = typeof value === 'string' ? value : (value as { foreground?: unknown } | undefined)?.foreground;
      if (isHexColor(foreground)) {
        rules.push({ scope, settings: { foreground } });
      }
    }
    if (Array.isArray(record.textMateRules)) {
      for (const rule of record.textMateRules) {
        if (typeof rule === 'object' && rule !== null) {
          rules.push(rule as TokenRule);
        }
      }
    }
  };
  addBlock(customizations);
  if (typeof customizations === 'object' && customizations !== null && themeName) {
    addBlock((customizations as Record<string, unknown>)[`[${themeName}]`]);
  }
  return rules;
}

/**
 * Parses JSON with comments and trailing commas, which is how theme files are written.
 * Throws on anything that is not valid after those two are removed.
 */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') {
        j += text[j] === '\\' ? 2 : 1;
      }
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') {
        i++;
      }
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  // A comma followed (after whitespace) by a closing bracket is trailing; strings are skipped.
  const cleaned = out.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (match, closing: string | undefined) =>
    closing !== undefined ? closing : match
  );
  return JSON.parse(cleaned);
}
