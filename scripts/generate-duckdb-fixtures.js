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
