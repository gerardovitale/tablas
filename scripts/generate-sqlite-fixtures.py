#!/usr/bin/env python3
"""
Regenerates the binary .db fixtures under test/fixtures/.

SQLite files are binary and can't be hand-authored like the CSV fixtures,
so this script exists to make them reproducible instead of opaque committed
binaries. Uses only Python's stdlib sqlite3 module -- unlike the Parquet
fixture script, no extra `pip install` is needed. Run from the repo root:

    python3 scripts/generate-sqlite-fixtures.py
"""

import os
import sqlite3

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')


def write(name, build):
    path = os.path.join(FIXTURES_DIR, name)
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    try:
        build(conn)
        conn.commit()
    finally:
        conn.close()
    print(f'wrote {path}')


def main():
    # simple.db -- mixed types mirroring simple.csv/simple.parquet's shape,
    # so readSqliteTable/stringifySqliteCell get real coverage of SQLite's
    # dynamic typing (INTEGER/REAL/TEXT/BLOB).
    def build_simple(conn):
        conn.execute('CREATE TABLE people (id INTEGER, name TEXT, score REAL, active INTEGER)')
        conn.executemany(
            'INSERT INTO people VALUES (?, ?, ?, ?)',
            [
                (1, 'Alice', 9.5, 1),
                (2, 'Bob', 4.0, 0),
                (3, 'Carol', 7.25, 1),
            ],
        )
    write('simple.db', build_simple)

    # empty.db -- valid schema, zero rows (mirrors empty.parquet's intent:
    # headers must come from the schema/prepared-statement columns, not from
    # row data).
    def build_empty(conn):
        conn.execute('CREATE TABLE items (id INTEGER, label TEXT)')
    write('empty.db', build_empty)

    # multi-table.db -- two tables plus one view, to exercise the dropdown
    # and the table/view distinction in listSqliteTables.
    def build_multi_table(conn):
        conn.execute('CREATE TABLE customers (id INTEGER, name TEXT)')
        conn.executemany('INSERT INTO customers VALUES (?, ?)', [(1, 'Acme'), (2, 'Globex')])
        conn.execute('CREATE TABLE orders (id INTEGER, customer_id INTEGER, total REAL)')
        conn.executemany(
            'INSERT INTO orders VALUES (?, ?, ?)',
            [(1, 1, 19.99), (2, 1, 5.5), (3, 2, 42.0)],
        )
        conn.execute('CREATE VIEW customer_totals AS '
                      'SELECT customers.name, SUM(orders.total) AS total '
                      'FROM customers JOIN orders ON orders.customer_id = customers.id '
                      'GROUP BY customers.name')
    write('multi-table.db', build_multi_table)

    # nulls.db -- null-heavy, mirrors nulls.parquet's intent.
    def build_nulls(conn):
        conn.execute('CREATE TABLE readings (a INTEGER, b TEXT)')
        conn.executemany(
            'INSERT INTO readings VALUES (?, ?)',
            [(1, None), (None, None), (3, 'x')],
        )
    write('nulls.db', build_nulls)

    # no-tables.db -- a valid SQLite database (correct header, openable)
    # with zero tables/views. Distinct from a 0-byte file: this exercises
    # parseSqlite's "opened fine, nothing to show" branch specifically.
    def build_no_tables(conn):
        # sqlite3.connect() alone doesn't write the SQLite header to disk
        # until something is actually persisted, so force a page write by
        # creating and dropping a table -- final state is a valid, openable
        # database with zero rows in sqlite_master.
        conn.execute('CREATE TABLE tmp (x)')
        conn.execute('DROP TABLE tmp')
    write('no-tables.db', build_no_tables)

    # corrupt.db -- not a SQLite file at all, to exercise the magic-byte
    # sniff in openSqliteDatabase.
    corrupt_path = os.path.join(FIXTURES_DIR, 'corrupt.db')
    with open(corrupt_path, 'wb') as f:
        f.write(b'this is not a valid sqlite database')
    print(f'wrote {corrupt_path}')


if __name__ == '__main__':
    main()
