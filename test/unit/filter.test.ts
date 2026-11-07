import * as assert from 'assert';
import {
  compileCellPredicate,
  filterErrorPayload,
  filterPayload,
  filterStringRows,
  hasUnknownColumn,
  parseColumnFilter,
  parseNumber,
  resolveFilters,
  type ColumnFilter,
} from '../../src/filter';

function parse(text: string): ColumnFilter {
  const parsed = parseColumnFilter(text);
  if ('error' in parsed) {
    assert.fail(`expected "${text}" to parse, got error: ${parsed.error}`);
  }
  return parsed.filter;
}

function matches(text: string, cell: string): boolean {
  return compileCellPredicate(parse(text))(cell);
}

describe('parseColumnFilter', () => {
  const cases: Array<[string, ColumnFilter]> = [
    ['abc', { op: 'contains', value: 'abc' }],
    ['  abc  ', { op: 'contains', value: 'abc' }],
    ['a b', { op: 'contains', value: 'a b' }],
    ['!abc', { op: 'notContains', value: 'abc' }],
    ['=abc', { op: 'equals', value: 'abc' }],
    ['= abc', { op: 'equals', value: ' abc' }],
    ['!=abc', { op: 'notEquals', value: 'abc' }],
    ['=', { op: 'empty', value: '' }],
    ['!=', { op: 'notEmpty', value: '' }],
    ['>5', { op: 'gt', value: '5' }],
    ['>=5', { op: 'gte', value: '5' }],
    ['<5', { op: 'lt', value: '5' }],
    ['<=5', { op: 'lte', value: '5' }],
    ['>  5', { op: 'gt', value: '5' }],
    ['>=2024-01-01', { op: 'gte', value: '2024-01-01' }],
    ['\\>5', { op: 'contains', value: '>5' }],
    ['\\=x', { op: 'contains', value: '=x' }],
    ['\\!x', { op: 'contains', value: '!x' }],
    ['\\', { op: 'contains', value: '' }],
    ['!', { op: 'contains', value: '!' }],
  ];
  for (const [text, expected] of cases) {
    it(`parses ${JSON.stringify(text)}`, () => {
      assert.deepStrictEqual(parse(text), expected);
    });
  }

  it('reports a comparison with nothing after it', () => {
    for (const text of ['>', '>=', '<', '<=', '>   ', '<=  ']) {
      const parsed = parseColumnFilter(text);
      assert.ok('error' in parsed, text);
    }
  });

  it('names the operator in the error', () => {
    const parsed = parseColumnFilter('>=');
    assert.ok('error' in parsed && parsed.error.includes('>='));
  });

  it('rejects blank text (callers drop blank boxes before parsing)', () => {
    assert.ok('error' in parseColumnFilter(''));
    assert.ok('error' in parseColumnFilter('   '));
  });
});

describe('parseNumber', () => {
  it('accepts integers, decimals, signs, exponents and leading zeros', () => {
    const accepted: Array<[string, number]> = [
      ['5', 5], ['-5', -5], ['+5', 5], ['007', 7], ['3.14', 3.14], ['.5', 0.5], ['5.', 5], ['1e3', 1000], ['-2.5E-1', -0.25], [' 42 ', 42],
    ];
    for (const [text, value] of accepted) {
      assert.strictEqual(parseNumber(text), value, text);
    }
  });

  it('rejects text, hex, separators, infinity and out-of-range numbers', () => {
    for (const text of ['', ' ', 'abc', '1,000', '0x10', 'Infinity', 'NaN', '1e999', '--1', '1.2.3', '5%', '$5']) {
      assert.strictEqual(parseNumber(text), undefined, JSON.stringify(text));
    }
  });
});

describe('compileCellPredicate', () => {
  describe('contains / notContains', () => {
    it('is case-insensitive, including non-ASCII', () => {
      assert.strictEqual(matches('abc', 'xxABCxx'), true);
      assert.strictEqual(matches('ÉCOLE', 'une école'), true);
      assert.strictEqual(matches('abc', 'ab'), false);
    });

    it('matches the empty needle against everything', () => {
      assert.strictEqual(matches('\\', 'anything'), true);
      assert.strictEqual(matches('\\', ''), true);
    });

    it('negates for notContains, and empty cells then match', () => {
      assert.strictEqual(matches('!abc', 'xyz'), true);
      assert.strictEqual(matches('!abc', 'xABCx'), false);
      assert.strictEqual(matches('!abc', ''), true);
    });

    it('treats operator characters after a backslash literally', () => {
      assert.strictEqual(matches('\\>5', 'a>5b'), true);
      assert.strictEqual(matches('\\>5', '10'), false);
    });
  });

  describe('equals / notEquals', () => {
    it('is exact and case-sensitive', () => {
      assert.strictEqual(matches('=Rome', 'Rome'), true);
      assert.strictEqual(matches('=Rome', 'rome'), false);
      assert.strictEqual(matches('=Rome', 'Rome '), false);
    });

    it('keeps text after the = literal, operators included', () => {
      assert.strictEqual(matches('=>5', '>5'), true);
      assert.strictEqual(matches('==', '='), true);
    });

    it('negates for notEquals', () => {
      assert.strictEqual(matches('!=Rome', 'Paris'), true);
      assert.strictEqual(matches('!=Rome', 'Rome'), false);
      assert.strictEqual(matches('!=Rome', ''), true);
    });
  });

  describe('empty / notEmpty', () => {
    it('treats blank and whitespace-only cells as empty', () => {
      assert.strictEqual(matches('=', ''), true);
      assert.strictEqual(matches('=', '   '), true);
      assert.strictEqual(matches('=', '0'), false);
      assert.strictEqual(matches('!=', ''), false);
      assert.strictEqual(matches('!=', ' '), false);
      assert.strictEqual(matches('!=', 'x'), true);
    });
  });

  describe('numeric comparison', () => {
    it('compares as numbers, not text', () => {
      assert.strictEqual(matches('>9', '10'), true); // "10" < "9" as text
      assert.strictEqual(matches('<10', '9'), true);
      assert.strictEqual(matches('>=10', '10'), true);
      assert.strictEqual(matches('>10', '10'), false);
      assert.strictEqual(matches('<=10', '10'), true);
      assert.strictEqual(matches('<10', '10'), false);
    });

    it('handles negatives, decimals, leading zeros and surrounding spaces in cells', () => {
      assert.strictEqual(matches('>-1', '-0.5'), true);
      assert.strictEqual(matches('<0.5', '.25'), true);
      assert.strictEqual(matches('>=7', '007'), true);
      assert.strictEqual(matches('>1', ' 2 '), true);
    });

    it('never matches cells that are not numbers, or are empty', () => {
      for (const op of ['>', '>=', '<', '<=']) {
        for (const cell of ['abc', '', ' ', '1,000', '5%']) {
          assert.strictEqual(matches(`${op}5`, cell), false, `${op}5 vs ${JSON.stringify(cell)}`);
        }
      }
    });
  });

  describe('string comparison (operand is not a number)', () => {
    it('orders ISO dates by time', () => {
      assert.strictEqual(matches('>=2024-01-01', '2024-03-01'), true);
      assert.strictEqual(matches('>=2024-01-01', '2023-12-31'), false);
      assert.strictEqual(matches('<2024-01-01', '2023-12-31'), true);
      assert.strictEqual(matches('<=2024-01-01', '2024-01-01'), true);
      assert.strictEqual(matches('>2024-01-01', '2024-01-01'), false);
    });

    it('compares by code unit, so case matters', () => {
      assert.strictEqual(matches('>M', 'a'), true);
      assert.strictEqual(matches('>M', 'A'), false);
    });

    it('never matches empty cells', () => {
      assert.strictEqual(matches('<z', ''), false);
      assert.strictEqual(matches('<z', '   '), false);
    });
  });
});

describe('resolveFilters', () => {
  it('drops blank boxes and parses the rest', () => {
    const resolved = resolveFilters([
      { column: 0, text: '' },
      { column: 1, text: '  ' },
      { column: 2, text: '>5' },
    ]);
    assert.deepStrictEqual(resolved, { specs: [{ column: 2, filter: { op: 'gt', value: '5' } }] });
  });

  it('returns no specs when everything is blank', () => {
    assert.deepStrictEqual(resolveFilters([{ column: 0, text: '' }]), { specs: [] });
    assert.deepStrictEqual(resolveFilters([]), { specs: [] });
  });

  it('reports every invalid box and runs nothing', () => {
    const resolved = resolveFilters([
      { column: 0, text: 'ok' },
      { column: 1, text: '>' },
      { column: 3, text: '<=' },
    ]);
    assert.ok('errors' in resolved);
    assert.deepStrictEqual(resolved.errors.map((e) => e.column), [1, 3]);
    assert.ok(resolved.errors.every((e) => e.message.length > 0));
  });
});

describe('hasUnknownColumn', () => {
  const spec = (column: number) => ({ column, filter: { op: 'contains' as const, value: 'x' } });
  it('detects a column past the end', () => {
    assert.strictEqual(hasUnknownColumn([spec(0), spec(2)], 3), false);
    assert.strictEqual(hasUnknownColumn([spec(0), spec(3)], 3), true);
    assert.strictEqual(hasUnknownColumn([], 0), false);
  });
});

describe('filterStringRows', () => {
  const rows = [
    ['Alice', '30', 'Rome'],
    ['Bob', '25', 'Paris'],
    ['Carol', '35', 'rome'],
    ['Dave', '', 'Oslo'],
  ];
  const spec = (column: number, text: string) => {
    const resolved = resolveFilters([{ column, text }]);
    if ('errors' in resolved) {
      assert.fail('bad filter');
    }
    return resolved.specs[0];
  };

  it('keeps matching rows and counts them', () => {
    const result = filterStringRows(rows, [spec(2, 'rome')], 100);
    assert.deepStrictEqual(result.rows, [rows[0], rows[2]]);
    assert.strictEqual(result.matchCount, 2);
  });

  it('ANDs filters across columns', () => {
    const result = filterStringRows(rows, [spec(2, 'rome'), spec(1, '>30')], 100);
    assert.deepStrictEqual(result.rows, [rows[2]]);
    assert.strictEqual(result.matchCount, 1);
  });

  it('keeps the first maxRows matches but counts them all', () => {
    const result = filterStringRows(rows, [spec(1, '>=0')], 2);
    assert.deepStrictEqual(result.rows, [rows[0], rows[1]]);
    assert.strictEqual(result.matchCount, 3);
  });

  it('returns nothing when nothing matches', () => {
    const result = filterStringRows(rows, [spec(0, 'zzz')], 100);
    assert.deepStrictEqual(result, { rows: [], matchCount: 0 });
  });

  it('returns every row (up to maxRows) when there are no filters', () => {
    const result = filterStringRows(rows, [], 3);
    assert.strictEqual(result.rows.length, 3);
    assert.strictEqual(result.matchCount, 4);
  });

  it('sees a missing cell as empty', () => {
    const ragged = [['a'], ['b', 'x']];
    assert.deepStrictEqual(filterStringRows(ragged, [spec(1, '=')], 10).rows, [['a']]);
  });

  it('does not mutate its input', () => {
    const copy = JSON.parse(JSON.stringify(rows));
    filterStringRows(rows, [spec(2, 'rome')], 1);
    assert.deepStrictEqual(rows, copy);
  });
});

describe('filterPayload / filterErrorPayload', () => {
  const message = { type: 'filter' as const, seq: 7, table: 't', filters: [] };

  it('echoes seq and table on success', () => {
    assert.deepStrictEqual(filterPayload(message, { rows: [['a']], matchCount: 9 }), {
      seq: 7,
      table: 't',
      rows: [['a']],
      matchCount: 9,
    });
  });

  it('omits table when the request had none', () => {
    const payload = filterPayload({ type: 'filter', seq: 1, filters: [] }, { rows: [], matchCount: 0 });
    assert.ok(!('table' in payload));
  });

  it('carries a failure as failedReason only', () => {
    assert.deepStrictEqual(filterPayload(message, { failedReason: 'nope' }), { seq: 7, table: 't', failedReason: 'nope' });
  });

  it('carries parse errors without rows', () => {
    assert.deepStrictEqual(filterErrorPayload(message, [{ column: 1, message: 'bad' }]), {
      seq: 7,
      table: 't',
      errors: [{ column: 1, message: 'bad' }],
    });
  });

  it('survives a JSON round-trip (it crosses postMessage)', () => {
    const payload = filterPayload(message, { rows: [['a', '']], matchCount: 1 });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(payload)), payload);
  });
});
