import * as assert from 'assert';
import {
  customizationRules,
  isHexColor,
  parseJsonc,
  resolveSqlColors,
  sqlThemeMessage,
  SQL_TOKEN_CLASSES,
  type TokenRule,
} from '../../src/sqlTheme';

describe('isHexColor', () => {
  it('accepts #rgb, #rgba, #rrggbb and #rrggbbaa, in either case', () => {
    for (const color of ['#fff', '#FFFA', '#c586c0', '#C586C0', '#c586c080']) {
      assert.strictEqual(isHexColor(color), true, color);
    }
  });

  it('rejects anything else, including CSS that is not a plain colour', () => {
    for (const value of ['red', '#ggg', '#12345', 'rgb(0,0,0)', '#fff; background: url(x)', '', undefined, null, 5, {}]) {
      assert.strictEqual(isHexColor(value), false, String(value));
    }
  });
});

describe('resolveSqlColors', () => {
  const rules: TokenRule[] = [
    { scope: 'keyword', settings: { foreground: '#C586C0' } },
    { scope: ['comment', 'punctuation.definition.comment'], settings: { foreground: '#6A9955' } },
    { scope: 'string', settings: { foreground: '#CE9178' } },
    { scope: 'constant.numeric', settings: { foreground: '#B5CEA8' } },
    { scope: 'entity.name.function, support.function', settings: { foreground: '#DCDCAA' } },
    { scope: 'storage.type', settings: { foreground: '#569CD6' } },
    { scope: 'keyword.operator', settings: { foreground: '#D4D4D4' } },
    { scope: 'constant.language', settings: { foreground: '#569CD6' } },
  ];

  it('colours each kind of token by the theme rule its scope falls under, lower-cased', () => {
    assert.deepStrictEqual(resolveSqlColors(rules), {
      keyword: '#c586c0',
      function: '#dcdcaa',
      string: '#ce9178', // string.quoted.single.sql under `string`
      number: '#b5cea8',
      comment: '#6a9955',
      type: '#569cd6',
      operator: '#d4d4d4',
      identifier: '#ce9178', // string.quoted.double.sql, also under `string`
      constant: '#569cd6',
    });
  });

  it('prefers the more specific selector, and the later rule when they are equally specific', () => {
    const colors = resolveSqlColors([
      { scope: 'keyword', settings: { foreground: '#111111' } },
      { scope: 'keyword.other', settings: { foreground: '#222222' } },
      { scope: 'keyword.other', settings: { foreground: '#333333' } },
      { scope: 'keyword.other.sql', settings: { foreground: '#444444' } },
      { scope: 'keyword', settings: { foreground: '#555555' } }, // later, but less specific
    ]);
    assert.strictEqual(colors.keyword, '#444444');
    assert.strictEqual(
      resolveSqlColors([
        { scope: 'keyword.other', settings: { foreground: '#222222' } },
        { scope: 'keyword.other', settings: { foreground: '#333333' } },
      ]).keyword,
      '#333333'
    );
  });

  it('matches whole dotted segments only', () => {
    // `keyword.oth` is not a prefix of `keyword.other.sql` segment-wise; `key` is not `keyword`.
    assert.deepStrictEqual(
      resolveSqlColors([
        { scope: 'keyword.oth', settings: { foreground: '#111111' } },
        { scope: 'key', settings: { foreground: '#222222' } },
      ]),
      {}
    );
  });

  it('lets a theme that colours functions as entity.name.function win over nothing', () => {
    assert.strictEqual(
      resolveSqlColors([{ scope: 'entity.name.function', settings: { foreground: '#abcdef' } }]).function,
      '#abcdef'
    );
  });

  it('honours a parent selector only when it is in the SQL scope stack', () => {
    assert.strictEqual(
      resolveSqlColors([{ scope: 'source.sql keyword', settings: { foreground: '#123456' } }]).keyword,
      '#123456'
    );
    assert.strictEqual(
      resolveSqlColors([{ scope: 'source.python keyword', settings: { foreground: '#123456' } }]).keyword,
      undefined
    );
  });

  it('ignores selectors it does not support instead of guessing', () => {
    for (const scope of ['keyword - keyword.other', 'keyword | string', '(keyword)', 'keyword -comment']) {
      assert.deepStrictEqual(resolveSqlColors([{ scope, settings: { foreground: '#123456' } }]), {}, scope);
    }
  });

  it('leaves out a kind no rule colours, and ignores rules without a usable foreground', () => {
    const colors = resolveSqlColors([
      { scope: 'keyword', settings: { foreground: 'red' } },
      { scope: 'string', settings: { foreground: '#123456; background: url(x)' } },
      { scope: 'comment', settings: {} },
      { settings: { foreground: '#123456' } },
      { scope: 5 as unknown as string, settings: { foreground: '#123456' } },
      null as unknown as TokenRule,
    ]);
    assert.deepStrictEqual(colors, {});
  });

  it('keeps hyphens inside scope names, which are not exclusions', () => {
    assert.strictEqual(
      resolveSqlColors([{ scope: 'comment.line.double-dash', settings: { foreground: '#00ff00' } }]).comment,
      '#00ff00'
    );
  });

  it('only ever returns known kinds with plain hex colours', () => {
    const colors = resolveSqlColors(rules);
    for (const [kind, color] of Object.entries(colors)) {
      assert.ok((SQL_TOKEN_CLASSES as readonly string[]).includes(kind));
      assert.ok(isHexColor(color));
    }
  });
});

describe('customizationRules', () => {
  it('turns the simple keys and textMateRules into rules', () => {
    const rules = customizationRules(
      {
        comments: '#112233',
        strings: { foreground: '#223344' },
        keywords: 'not a colour',
        textMateRules: [{ scope: 'keyword.other.sql', settings: { foreground: '#334455' } }, 'junk', null],
      },
      undefined
    );
    const colors = resolveSqlColors(rules);
    assert.strictEqual(colors.comment, '#112233');
    assert.strictEqual(colors.string, '#223344');
    assert.strictEqual(colors.keyword, '#334455');
  });

  it('lets the block for the active theme override the global one', () => {
    const customizations = {
      comments: '#111111',
      '[One Dark Pro]': { comments: '#222222' },
      '[Another Theme]': { comments: '#333333' },
    };
    assert.strictEqual(resolveSqlColors(customizationRules(customizations, 'One Dark Pro')).comment, '#222222');
    assert.strictEqual(resolveSqlColors(customizationRules(customizations, 'Other')).comment, '#111111');
    assert.strictEqual(resolveSqlColors(customizationRules(customizations, undefined)).comment, '#111111');
  });

  it('beats the theme when its rules are listed after the theme own rules', () => {
    const themeRules: TokenRule[] = [{ scope: 'comment', settings: { foreground: '#00ff00' } }];
    const colors = resolveSqlColors([...themeRules, ...customizationRules({ comments: '#ff0000' }, undefined)]);
    assert.strictEqual(colors.comment, '#ff0000');
  });

  it('maps functions and types to the scopes themes use for them', () => {
    const colors = resolveSqlColors(customizationRules({ functions: '#aaaaaa', types: '#bbbbbb', numbers: '#cccccc' }, undefined));
    assert.strictEqual(colors.function, '#aaaaaa');
    assert.strictEqual(colors.type, '#bbbbbb');
    assert.strictEqual(colors.number, '#cccccc');
  });

  it('tolerates a missing or odd value', () => {
    for (const value of [undefined, null, 5, 'x', [], {}]) {
      assert.deepStrictEqual(customizationRules(value, 'T'), []);
    }
  });
});

describe('parseJsonc', () => {
  it('reads comments and trailing commas, as theme files have them', () => {
    const text = `{
      // a line comment
      "name": "T", /* a block
      comment */
      "tokenColors": [
        { "scope": "keyword", "settings": { "foreground": "#fff", }, },
      ],
    }`;
    assert.deepStrictEqual(parseJsonc(text), { name: 'T', tokenColors: [{ scope: 'keyword', settings: { foreground: '#fff' } }] });
  });

  it('leaves comment markers and commas inside strings alone', () => {
    assert.deepStrictEqual(parseJsonc('{"a": "http://x /* y */, ]", "b": "q\\" // z,}"}'), {
      a: 'http://x /* y */, ]',
      b: 'q" // z,}',
    });
  });

  it('throws on text that is not JSON', () => {
    assert.throws(() => parseJsonc('{ nope'));
    assert.throws(() => parseJsonc('<?xml version="1.0"?>'));
  });

  it('survives an unterminated block comment (it runs to the end)', () => {
    assert.deepStrictEqual(parseJsonc('{"a": 1} /* never closed'), { a: 1 });
  });
});

describe('sqlThemeMessage', () => {
  it('wraps the colours under the sql-theme type and survives JSON', () => {
    const message = sqlThemeMessage({ keyword: '#c586c0' });
    assert.deepStrictEqual(message, { type: 'sql-theme', colors: { keyword: '#c586c0' } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(message)), message);
  });
});
