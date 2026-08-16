#!/usr/bin/env python3
"""
Regenerates the binary .parquet fixtures under test/fixtures/.

Parquet files are binary and can't be hand-authored like the CSV fixtures,
so this script exists to make them reproducible instead of opaque committed
binaries. Run from the repo root:

    python3 scripts/generate-parquet-fixtures.py

Requires pyarrow (`pip install pyarrow`).
"""

import os

import pyarrow as pa
import pyarrow.parquet as pq

FIXTURES_DIR = os.path.join(os.path.dirname(__file__), '..', 'test', 'fixtures')

# Compression is pinned explicitly to snappy (rather than relying on
# pyarrow's default) since that's the one compressed codec hyparquet's
# built-in decompression supports without the separate, WASM-based
# hyparquet-compressors package -- see src/parquetParser.ts.
COMPRESSION = 'snappy'


def write(name, table):
    path = os.path.join(FIXTURES_DIR, name)
    pq.write_table(table, path, compression=COMPRESSION)
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
