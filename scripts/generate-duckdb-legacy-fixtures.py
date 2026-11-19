#!/usr/bin/env python3
"""
Regenerates the DuckDB fixtures that must be written by a DuckDB 1.x engine.

Why not scripts/generate-duckdb-fixtures.js (which uses the bundled DuckDB 2.x)?
DuckDB 2.x rewrites a view's references to its own catalog when the view is
*created* (`FROM warehouse.main.stg` is stored as `FROM main.stg`), but files
written by DuckDB 1.x -- which is what dbt-duckdb produces -- keep the catalog
in the stored view SQL. Tablas opens a temp copy of the file, so such a view only
works if the copy keeps the source file's name (and so its catalog name). A
fixture written by 2.x cannot show that problem; this one can.

Needs `pip install "duckdb<2"` (storage version 64). Run from the repo root:

    python3 scripts/generate-duckdb-legacy-fixtures.py

Writes test/fixtures/qualified-views.duckdb. The file is built as `warehouse.duckdb`
in a temp folder, because DuckDB takes the catalog name from the file name.
"""
import os
import shutil
import sys
import tempfile

import duckdb

if int(duckdb.__version__.split(".")[0]) >= 2:
    sys.exit(f"duckdb {duckdb.__version__} found; this needs a 1.x engine (pip install 'duckdb<2')")

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "test", "fixtures")


def main() -> None:
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "warehouse.duckdb")
        con = duckdb.connect(path)
        con.execute("CREATE TABLE base (id INTEGER, label VARCHAR)")
        con.execute("INSERT INTO base VALUES (1, 'a'), (2, 'b')")
        # Like a dbt staging model, then a model that refers to it by its full name.
        con.execute("CREATE VIEW stg_invoice AS SELECT * FROM base")
        con.execute(
            "CREATE VIEW stg_invoice_line AS SELECT * FROM base "
            "WHERE id IN (SELECT id FROM warehouse.main.stg_invoice)"
        )
        stored = con.execute(
            "SELECT sql FROM duckdb_views() WHERE view_name = 'stg_invoice_line'"
        ).fetchone()[0]
        con.close()
        if "warehouse.main.stg_invoice" not in stored:
            sys.exit(f"this engine normalized the catalog away, so the fixture proves nothing: {stored}")
        target = os.path.join(FIXTURES, "qualified-views.duckdb")
        shutil.copyfile(path, target)
        print(f"wrote {os.path.normpath(target)} (duckdb {duckdb.__version__})")
        print(f"stored view SQL: {stored}")


if __name__ == "__main__":
    main()
