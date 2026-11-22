/**
 * Names for the SQL box: the view a Parquet/CSV file is exposed as (named after the file, so
 * `sales_2024.parquet` is `select * from sales_2024`) and when an identifier must be quoted.
 * Kept free of any `vscode` import so it can be unit-tested from `test/unit/`.
 */

/**
 * Every DuckDB keyword that is not `unreserved` (reserved, type/function and column-name
 * keywords): used as a table name they need quotes, or at least are not worth the risk. A test
 * compares this with `duckdb_keywords()`, so an engine upgrade that adds one fails there.
 */
export const DUCKDB_NON_UNRESERVED_KEYWORDS: ReadonlySet<string> = new Set(
  (
    'all analyse analyze and anti any array as asc asof asymmetric at authorization between bigint ' +
    'binary bit boolean both by case cast char character check coalesce collate collation column columns ' +
    'concurrently constraint create cross dec decimal default deferrable desc describe distinct ' +
    'do else end except exists extract false fetch float for foreign freeze from full generated ' +
    'glob group grouping grouping_id having ilike in initially inner inout int integer ' +
    'intersect interval into is isnull join lambda lateral leading left like limit map national ' +
    'natural nchar none not notnull null nullif numeric offset on only or order out outer overlaps ' +
    'overlay pivot pivot_longer pivot_wider placing position positional precision primary qualify real ' +
    'references returning right row select semi setof show similar smallint some struct substring ' +
    'summarize symmetric table tablesample then time timestamp to trailing treat trim true try_cast ' +
    'tuple union unique unpack unpivot using values varchar variadic verbose when where ' +
    'window with xmlattributes xmlconcat xmlelement xmlexists xmlforest xmlnamespaces xmlparse xmlpi ' +
    'xmlroot xmlserialize xmltable'
  ).split(' ')
);

const PLAIN_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Longest view name used; a longer file name is clipped (the clip is still a valid name). */
const MAX_NAME_LENGTH = 100;

/** Used when a file name has no usable stem (`.csv`, an empty name). */
export const FALLBACK_VIEW_NAME = 'data';

/** `name`, double-quoted (embedded quotes doubled), always. */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * `name` as it is written in SQL: bare when it is a plain identifier (letters, digits and
 * underscores, not starting with a digit) that is not a keyword, quoted otherwise.
 * DuckDB folds the case of bare names, so `Sales` and `sales` are the same table.
 */
export function quoteIdentifierIfNeeded(name: string): string {
  return PLAIN_IDENTIFIER.test(name) && !DUCKDB_NON_UNRESERVED_KEYWORDS.has(name.toLowerCase())
    ? name
    : quoteIdentifier(name);
}

/**
 * The name of the view a file is exposed as: the file name without its last extension
 * (`sales-2024.final.csv` -> `sales-2024.final`), control characters removed and long names
 * clipped. A name with nothing left (`.csv` alone, an empty name) is `data`. The result is a
 * *name*, not SQL: write it with `quoteIdentifierIfNeeded`.
 */
export function viewNameForFile(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  const stem = dot >= 0 ? base.slice(0, dot) : base;
  const cleaned = Array.from(stem)
    .filter((ch) => ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) !== 127)
    .join('')
    .trim();
  const clipped = Array.from(cleaned).slice(0, MAX_NAME_LENGTH).join('');
  // A name that is only dots would be a legal quoted name but is never what the user means.
  return clipped === '' || /^\.+$/.test(clipped) ? FALLBACK_VIEW_NAME : clipped;
}

/** The starting query of the box for a file exposed as `viewName`. */
export function suggestQueryFor(viewName: string): string {
  return `select * from ${quoteIdentifierIfNeeded(viewName)} limit 5`;
}
