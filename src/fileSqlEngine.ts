import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DuckDBInstance, version } from '@duckdb/node-api';
import { tempCopyName, type DuckdbHandle } from './duckdbParser';
import { quoteIdentifier, viewNameForFile } from './sqlNames';

/**
 * The SQL engine behind a Parquet or CSV file: an in-memory DuckDB with the file exposed as a
 * view named after it (`sales_2024.parquet` -> `select * from sales_2024`). The file's normal
 * table view still comes from hyparquet/PapaParse; DuckDB is only what the SQL box queries, so
 * the same statement guard, limits, result tables, statistics and filters apply as for a DuckDB
 * file (everything in `duckdbParser.ts` takes the handle this returns).
 *
 * A local file is read *in place* (`read_parquet('<path>')`): no copy, so a multi-GB file costs
 * nothing until it is queried, and each query sees the file as it is then, as the table view's
 * statistics and filters (which re-read on demand) do. Only what cannot be read by path is
 * copied, into a private temp folder: a non-`file:` source (its bytes come from the
 * `FileSystemProvider`) and a path with glob characters (DuckDB would expand them). The folder
 * also holds DuckDB's spill files and goes away with `close()`. Kept free of any `vscode` import
 * so it can be unit-tested from `test/unit/`.
 */

export type FileSqlFormat = 'parquet' | 'csv';

export interface FileSqlSource {
  format: FileSqlFormat;
  /** The file's name, which names the view (and the temp copy, if one is needed). */
  fileName: string;
  /** Its path on a local disk, when it has one: read in place. */
  fsPath?: string;
  /** Its bytes, for a source without a local path (called once, when the engine opens). */
  readBytes?: () => Promise<Uint8Array>;
}

/** What `openFileSqlEngine` returns besides a handle: why it could not open, as text for the user. */
export interface FileSqlError {
  error: string;
}

/** Characters DuckDB expands in a path (`*.parquet`, `data_[0-9].csv`, `{a,b}`), so such a path is copied instead. */
const GLOB_CHARACTERS = /[*?[\]{}]/;

/** The `FROM` source of the view: how DuckDB reads the file. */
function readerSql(format: FileSqlFormat, filePath: string): string {
  const literal = `'${filePath.replace(/'/g, "''")}'`;
  // header = true: PapaParse (the table view) always takes the first row as the header, so the
  // sniffer must not decide otherwise. Types are detected (an `id` column is a number to `sum()`).
  return format === 'parquet' ? `read_parquet(${literal})` : `read_csv(${literal}, header = true)`;
}

/**
 * Opens the engine. Never throws: a file DuckDB cannot read (corrupt, not Parquet, missing)
 * comes back as `{ error }` with DuckDB's own message, because creating the view binds it.
 */
export async function openFileSqlEngine(source: FileSqlSource): Promise<DuckdbHandle | FileSqlError> {
  let tempDir: string | undefined;
  const removeTemp = (): void => {
    if (tempDir === undefined) {
      return;
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup, as for a database handle
    }
  };
  const fail = (err: unknown): FileSqlError => {
    removeTemp();
    return { error: err instanceof Error ? err.message : String(err) };
  };

  let filePath: string;
  try {
    // Private (0700) and per open: spill files and any copy of the source stay out of reach of other local users.
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tablas-sql-'));
    if (source.fsPath !== undefined && !GLOB_CHARACTERS.test(source.fsPath)) {
      filePath = source.fsPath;
    } else if (source.readBytes) {
      filePath = path.join(tempDir, tempCopyName(source.fileName));
      fs.writeFileSync(filePath, await source.readBytes(), { mode: 0o600 });
    } else if (source.fsPath !== undefined) {
      // A local path with glob characters: copy it (same bytes, a name DuckDB reads literally).
      filePath = path.join(tempDir, tempCopyName(source.fileName));
      fs.copyFileSync(source.fsPath, filePath);
      fs.chmodSync(filePath, 0o600);
    } else {
      return fail(new Error('The file has no path or contents to query.'));
    }
  } catch (err) {
    return fail(err);
  }

  let instance: DuckDBInstance;
  try {
    instance = await DuckDBInstance.create(':memory:');
  } catch (err) {
    return fail(err);
  }
  try {
    const connection = await instance.connect();
    const handle: DuckdbHandle = {
      connection,
      close: () => {
        try {
          connection.closeSync();
        } catch {
          // best-effort, nothing more to do if the connection is already gone
        }
        try {
          instance.closeSync();
        } catch {
          // best-effort, same as above
        }
        removeTemp();
      },
    };
    try {
      // Spill files go to the private folder, not the extension host's working directory; UTC so
      // timestamps print the same on every machine (a CSV timestamp has no zone of its own).
      await connection.run(`SET temp_directory = '${(tempDir as string).replace(/'/g, "''")}'`);
      await connection.run(`SET TimeZone = 'UTC'`);
      await connection.run(
        `CREATE VIEW ${quoteIdentifier(viewNameForFile(source.fileName))} AS SELECT * FROM ${readerSql(source.format, filePath)}`
      );
    } catch (err) {
      handle.close();
      return { error: cleanDuckdbMessage(err) };
    }
    return handle;
  } catch (err) {
    try {
      instance.closeSync();
    } catch {
      // best-effort, as above
    }
    return fail(err);
  }
}

/** DuckDB's text without the engine version line noise some errors carry. */
function cleanDuckdbMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return `Could not read the file with DuckDB ${version()}: ${raw}`;
}

/** True for the failure shape of `openFileSqlEngine`. */
export function isFileSqlError(opened: DuckdbHandle | FileSqlError): opened is FileSqlError {
  return 'error' in opened;
}
