#!/usr/bin/env node
/**
 * Regenerates the binary .duckdb fixtures under test/fixtures/.
 *
 * DuckDB files are binary and can't be hand-authored like the CSV fixtures,
 * so this script exists to make them reproducible instead of opaque
 * committed binaries. Like the xlsx fixture script, this is a plain Node
 * script using the `@duckdb/node-api` dependency already added for
 * src/duckdbParser.ts -- no second new dependency just for fixture
 * generation. Run from the repo root:
 *
 *     node scripts/generate-duckdb-fixtures.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { DuckDBInstance } = require('@duckdb/node-api');

const FIXTURES_DIR = path.join(__dirname, '..', 'test', 'fixtures');

async function write(name, statements) {
  const filePath = path.join(FIXTURES_DIR, name);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  const instance = await DuckDBInstance.create(filePath);
  const connection = await instance.connect();
  try {
    for (const sql of statements) {
      await connection.run(sql);
    }
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
  console.log(`wrote ${filePath}`);
}

async function main() {
  // simple.duckdb -- mixed types mirroring simple.csv/simple.parquet/
  // simple.db's shape, so readDuckdbTable/stringifyDuckdbCell get real
  // coverage of DuckDB's typed columns (INTEGER/VARCHAR/DOUBLE/BOOLEAN).
  await write('simple.duckdb', [
    'CREATE TABLE people (id INTEGER, name VARCHAR, score DOUBLE, active BOOLEAN)',
    `INSERT INTO people VALUES
       (1, 'Alice', 9.5, true),
       (2, 'Bob', 4.0, false),
       (3, 'Carol', 7.25, true)`,
  ]);

  // empty.duckdb -- valid schema, zero rows (mirrors empty.db's intent:
  // headers must come from the query's column metadata, not from row data).
  await write('empty.duckdb', ['CREATE TABLE items (id INTEGER, label VARCHAR)']);

  // multi-table.duckdb -- two tables plus one view, to exercise the
  // dropdown and the table/view distinction in listDuckdbTables.
  await write('multi-table.duckdb', [
    'CREATE TABLE customers (id INTEGER, name VARCHAR)',
    `INSERT INTO customers VALUES (1, 'Acme'), (2, 'Globex')`,
    'CREATE TABLE orders (id INTEGER, customer_id INTEGER, total DOUBLE)',
    'INSERT INTO orders VALUES (1, 1, 19.99), (2, 1, 5.5), (3, 2, 42.0)',
    `CREATE VIEW customer_totals AS
       SELECT customers.name, SUM(orders.total) AS total
       FROM customers JOIN orders ON orders.customer_id = customers.id
       GROUP BY customers.name`,
  ]);

  // nulls.duckdb -- null-heavy, mirrors nulls.db's intent.
  await write('nulls.duckdb', [
    'CREATE TABLE readings (a INTEGER, b VARCHAR)',
    `INSERT INTO readings VALUES (1, NULL), (NULL, NULL), (3, 'x')`,
  ]);

  // dates-and-decimals.duckdb -- DATE/TIMESTAMP/DECIMAL/BIGINT columns, to
  // exercise stringifyDuckdbCell's handling of the types getRowsJson()
  // reduces to strings (unlike sql.js, DuckDB has real DATE/DECIMAL/BIGINT
  // types instead of collapsing everything into INTEGER/REAL/TEXT).
  await write('dates-and-decimals.duckdb', [
    'CREATE TABLE events (id INTEGER, happened_on DATE, amount DECIMAL(10,2), big_id BIGINT)',
    `INSERT INTO events VALUES
       (1, DATE '2023-11-14', 1234.5, 9007199254740993)`,
  ]);

  // stats.duckdb -- one column per DuckDB type family readDuckdbTable's
  // column statistics care about: BIGINT beyond 2^53 and a HUGEINT (exact
  // min/max text), DOUBLE with NaN/Infinity (excluded from numeric stats),
  // DECIMAL, BOOLEAN, DATE, TIMESTAMP, VARCHAR, BLOB and LIST (unsummarised),
  // an all-NULL column, and an identifier needing quote-doubling. Plus a
  // zero-row table and a view, which take the same stats path.
  await write('stats.duckdb', [
    `CREATE TABLE mixed (
       id INTEGER, big BIGINT, huge HUGEINT, ratio DOUBLE, amount DECIMAL(10,2),
       flag BOOLEAN, day DATE, ts TIMESTAMP, label VARCHAR, payload BLOB,
       tags INTEGER[], all_null INTEGER, "odd ""name""" INTEGER)`,
    `INSERT INTO mixed VALUES
       (1, 9007199254740993, 170141183460469231731687303715884105727, 1.5, 1.50, true,
        DATE '2020-01-01', TIMESTAMP '2020-01-01 10:00:00', 'b', '\\x00\\xff'::BLOB, [1], NULL, 10),
       (2, 1, 2, 2.5, 2.25, false,
        DATE '2021-01-01', TIMESTAMP '2021-06-01 12:30:00', 'a', '\\x00\\xff'::BLOB, [2, 3], NULL, 20),
       (3, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 30),
       (4, 3, 4, 4.0, 10.00, true,
        DATE '2019-01-01', TIMESTAMP '2019-03-01 00:00:00', 'c', '\\x01'::BLOB, [], NULL, 40),
       (5, 4, 5, 'NaN', 3.10, false,
        DATE '2020-01-01', TIMESTAMP '2020-01-01 10:00:00', 'a', NULL, [4], NULL, 50),
       (6, 5, 6, 'Infinity', 0.05, true,
        DATE '2020-06-01', TIMESTAMP '2020-06-01 00:00:00', 'b', NULL, [5], NULL, 60)`,
    'CREATE TABLE empty_table (a INTEGER, b VARCHAR)',
    'CREATE VIEW label_counts AS SELECT label, COUNT(*) AS n FROM mixed GROUP BY label',
  ]);

  // filter.duckdb -- the shared "filter parity" table (same logical rows as
  // filter.csv/.parquet/.xlsx/.db; test/unit/filterParity.test.ts asserts
  // every format filters it identically). Also a DOUBLE column holding whole
  // numbers, whose DuckDB text form ("10.0") differs from the table cell text
  // ("10") -- the one documented difference between the SQL and JS engines.
  // `d`/`ts` are real DATE/TIMESTAMP columns (their display differs per
  // format; they pin the day-precision date compare).
  await write('filter.duckdb', [
    'CREATE TABLE items (id INTEGER, name VARCHAR, city VARCHAR, qty INTEGER, price DOUBLE, day VARCHAR, d DATE, ts TIMESTAMP)',
    `INSERT INTO items VALUES
       (1, 'Alice', 'Rome', 10, 9.5, '2024-01-15', DATE '2024-01-01', TIMESTAMP '2024-01-01 10:30:00'),
       (2, 'bob', 'Paris', 9, 120.25, '2023-12-31', DATE '2023-12-31', TIMESTAMP '2023-12-31 23:59:59'),
       (3, '\u00c9mile', 'Oslo', 100, 7.75, '2024-03-01', DATE '2024-01-02', TIMESTAMP '2024-01-02 00:00:00'),
       (4, 'CAROL', 'rome', NULL, 1000.5, '2024-03-01', DATE '2024-01-01', TIMESTAMP '2024-01-01 00:00:00'),
       (5, 'Dave', NULL, 5, NULL, NULL, NULL, NULL),
       (6, 'Zo\u00eb', 'Lima', 20, 45.5, '2022-07-04', DATE '2022-07-04', TIMESTAMP '2022-07-04 12:00:00'),
       (7, 'Smith, Jo', 'New York', 1, 0.5, '2024-12-31', DATE '2024-12-31', TIMESTAMP '2024-12-31 23:59:59')`,
    'CREATE TABLE whole_numbers (n DOUBLE)',
    'INSERT INTO whole_numbers VALUES (10), (20), (NULL)',
  ]);

  // no-tables.duckdb -- a valid DuckDB database (openable) with zero
  // tables/views left. Distinct from a 0-byte file: this exercises
  // parseDuckdb's "opened fine, nothing to show" branch specifically.
  await write('no-tables.duckdb', ['CREATE TABLE tmp (x INTEGER)', 'DROP TABLE tmp']);

  // corrupt.duckdb -- not a DuckDB file at all, to exercise openDuckdbDatabase's
  // error handling when the native open call itself rejects it.
  const corruptPath = path.join(FIXTURES_DIR, 'corrupt.duckdb');
  fs.writeFileSync(corruptPath, 'this is not a valid duckdb database');
  console.log(`wrote ${corruptPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
