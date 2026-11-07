import type { FilterRequest } from '../../src/filterMessage';

/**
 * The filter-parity table: one list of filters and the `id`s of the rows each
 * must keep from the shared `filter.*` fixtures (same 7 logical rows in CSV,
 * Parquet, XLSX, SQLite and DuckDB). Columns: 0 id, 1 name, 2 city, 3 qty,
 * 4 price, 5 day. Every format's tests assert these, which is what keeps the
 * JS engine and the SQL push-downs saying the same thing.
 */
export interface FilterCase {
  name: string;
  filters: FilterRequest[];
  ids: number[];
}

const f = (column: number, text: string): FilterRequest => ({ column, text });

export const FILTER_CASES: FilterCase[] = [
  { name: 'contains is case-insensitive', filters: [f(2, 'rome')], ids: [1, 4] },
  { name: 'contains folds non-ASCII case', filters: [f(1, 'émile')], ids: [3] },
  { name: 'contains folds non-ASCII case (upper needle)', filters: [f(1, 'ZOË')], ids: [6] },
  { name: 'contains matches inside a quoted CSV cell', filters: [f(1, ', ')], ids: [7] },
  { name: 'does not contain keeps empty cells', filters: [f(2, '!rome')], ids: [2, 3, 5, 6, 7] },
  { name: 'equals is exact and case-sensitive', filters: [f(1, '=bob')], ids: [2] },
  { name: 'equals does not match another case', filters: [f(1, '=Bob')], ids: [] },
  { name: 'not equals keeps empty cells', filters: [f(2, '!=Rome')], ids: [2, 3, 4, 5, 6, 7] },
  { name: 'is empty', filters: [f(2, '=')], ids: [5] },
  { name: 'is empty on a numeric column', filters: [f(3, '=')], ids: [4] },
  { name: 'is not empty', filters: [f(2, '!=')], ids: [1, 2, 3, 4, 6, 7] },
  { name: 'integer greater-than is numeric', filters: [f(3, '>9')], ids: [1, 3, 6] },
  { name: 'integer greater-or-equal', filters: [f(3, '>=10')], ids: [1, 3, 6] },
  { name: 'integer less-than skips empty cells', filters: [f(3, '<10')], ids: [2, 5, 7] },
  { name: 'float less-than', filters: [f(4, '<10')], ids: [1, 3, 7] },
  { name: 'float less-or-equal', filters: [f(4, '<=9.5')], ids: [1, 3, 7] },
  { name: 'float greater-than', filters: [f(4, '>100')], ids: [2, 4] },
  { name: 'ISO date greater-or-equal', filters: [f(5, '>=2024-01-01')], ids: [1, 3, 4, 7] },
  { name: 'ISO date less-than', filters: [f(5, '<2024-01-01')], ids: [2, 6] },
  { name: 'numeric compare on a text column matches nothing', filters: [f(1, '>1')], ids: [] },
  { name: 'ANDs filters across columns', filters: [f(2, 'rome'), f(3, '>9')], ids: [1] },
  { name: 'ANDs three filters', filters: [f(5, '>=2024-01-01'), f(3, '>=10'), f(4, '<100')], ids: [1, 3] },
  { name: 'a backslash makes an operator literal', filters: [f(1, '\\>1')], ids: [] },
  { name: 'blank boxes are ignored', filters: [f(0, ''), f(2, '  '), f(1, 'alice')], ids: [1] },
  { name: 'nothing matches', filters: [f(1, 'zzz')], ids: [] },
];

/** The first cell (`id`) of every row, as numbers. */
export function idsOf(rows: readonly string[][]): number[] {
  return rows.map((row) => Number(row[0]));
}
