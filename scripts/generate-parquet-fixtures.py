#!/usr/bin/env python3
"""
Regenerates the binary .parquet fixtures under test/fixtures/.

Parquet files are binary and can't be hand-authored like the CSV fixtures,
so this script exists to make them reproducible instead of opaque committed
binaries. Run from the repo root:

    python3 scripts/generate-parquet-fixtures.py

Requires pyarrow (`pip install pyarrow`).
"""

import datetime
import decimal
import os

import pyarrow as pa
import pyarrow.parquet as pq

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')

# Compression is pinned explicitly to snappy (rather than relying on
# pyarrow's default) since that's the one compressed codec hyparquet's
# built-in decompression supports without the separate, WASM-based
# hyparquet-compressors package -- see src/parquetParser.ts.
COMPRESSION = 'snappy'


def write(name, table, **kwargs):
    path = os.path.join(FIXTURES_DIR, name)
    pq.write_table(table, path, compression=COMPRESSION, **kwargs)
    print(f'wrote {path}')


def main():
    # simple.parquet -- mixed types mirroring simple.csv's row/column intent,
    # but deliberately covering int64 (-> bigint in JS), double, bool,
    # string, so parseParquet's stringifyCell gets real coverage.
    write('simple.parquet', pa.table({
        'id': pa.array([1, 2, 3], type=pa.int64()),
        'name': pa.array(['Alice', 'Bob', 'Carol'], type=pa.string()),
        'score': pa.array([9.5, 4.0, 7.25], type=pa.float64()),
        'active': pa.array([True, False, True], type=pa.bool_()),
    }))

    # empty.parquet -- valid schema, zero rows (mirrors headers-only.csv's
    # intent: headers must come from schema, not from row data).
    write('empty.parquet', pa.table({
        'id': pa.array([], type=pa.int64()),
        'name': pa.array([], type=pa.string()),
    }))

    # nulls.parquet -- null-heavy, all-nullable columns.
    write('nulls.parquet', pa.table({
        'a': pa.array([1, None, 3], type=pa.int64()),
        'b': pa.array([None, None, 'x'], type=pa.string()),
    }))

    # nested.parquet -- a struct column, to exercise stringifyCell's
    # JSON-flattening path end-to-end (not just with hand-built JS objects).
    struct_type = pa.struct([('x', pa.int64()), ('y', pa.string())])
    write('nested.parquet', pa.table({
        'id': pa.array([1, 2], type=pa.int64()),
        'info': pa.array([{'x': 1, 'y': 'a'}, {'x': 2, 'y': 'b'}], type=struct_type),
    }))

    # stats.parquet -- one column per type parseParquet's column statistics
    # care about, in 3 row groups (2 + 2 + 1 rows) so the per-row-group read
    # loop is exercised. Includes an int64 beyond 2^53 (exact min/max text),
    # a NaN, nulls in every nullable column, a list (unsummarised), and an
    # all-null column (falls back to its declared type).
    D = decimal.Decimal
    dt = datetime.datetime
    write('stats.parquet', pa.table({
        'id': pa.array([1, 2, 3, 4, 5], type=pa.int64()),
        'big': pa.array([9007199254740993, 1, None, 3, 4], type=pa.int64()),
        'score': pa.array([1.5, 2.5, None, 4.0, float('nan')], type=pa.float64()),
        'flag': pa.array([True, False, None, True, False], type=pa.bool_()),
        'ts': pa.array([dt(2020, 1, 1), dt(2021, 6, 1), None, dt(2019, 3, 1), dt(2020, 1, 1)], type=pa.timestamp('ms')),
        'day': pa.array([datetime.date(2020, 1, 1), datetime.date(2021, 1, 1), None,
                         datetime.date(2019, 1, 1), datetime.date(2020, 1, 1)], type=pa.date32()),
        'name': pa.array(['b', 'a', None, 'c', 'a'], type=pa.string()),
        'amount': pa.array([D('1.50'), D('2.25'), None, D('10.00'), D('3.10')], type=pa.decimal128(10, 2)),
        'tags': pa.array([['a'], ['b', 'c'], None, [], ['d']], type=pa.list_(pa.string())),
        'all_null': pa.array([None, None, None, None, None], type=pa.int64()),
    }), row_group_size=2)

    # unsupported-codec.parquet -- gzip-compressed, deliberately NOT written
    # via write() (which pins snappy): hyparquet only decompresses
    # UNCOMPRESSED/Snappy, so this exercises parseParquet's error path.
    gzip_path = os.path.join(FIXTURES_DIR, 'unsupported-codec.parquet')
    pq.write_table(pa.table({'x': pa.array([1, 2, 3], type=pa.int64())}), gzip_path, compression='gzip')
    print(f'wrote {gzip_path}')

    # corrupt.parquet -- not a parquet file at all, to exercise the same
    # error path via a bad-footer failure instead of an unsupported codec.
    corrupt_path = os.path.join(FIXTURES_DIR, 'corrupt.parquet')
    with open(corrupt_path, 'wb') as f:
        f.write(b'this is not a valid parquet file')
    print(f'wrote {corrupt_path}')


if __name__ == '__main__':
    main()
