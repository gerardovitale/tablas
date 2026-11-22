import * as path from 'path';
import * as vscode from 'vscode';
import { openFileSqlEngine, type FileSqlFormat } from './fileSqlEngine';
import { QuerySession } from './querySession';
import { suggestQueryFor, viewNameForFile } from './sqlNames';
import type { SingleTableQueryInfo } from './tableData';

/**
 * The vscode half of the SQL box for a Parquet or CSV document (the logic is in `querySession.ts`,
 * `fileSqlEngine.ts` and `sqlNames.ts`): which file it queries, and what the webview is told so it
 * offers the box. Excluded from coverage like the providers.
 */

/** Said under the box for a CSV: DuckDB reads the file on its own (PapaParse draws the table). */
export const CSV_QUERY_NOTE =
  'Column types are detected by DuckDB, so a value can print differently from the table (for example 9.50 as 9.5).';

function fileNameOf(uri: vscode.Uri): string {
  return path.posix.basename(uri.path);
}

/** A session that queries `uri` (opened on the first query): in place for a local file, else from a copy of its bytes. */
export function createFileQuerySession(uri: vscode.Uri, format: FileSqlFormat): QuerySession {
  return new QuerySession(() =>
    openFileSqlEngine({
      format,
      fileName: fileNameOf(uri),
      fsPath: uri.scheme === 'file' ? uri.fsPath : undefined,
      readBytes: async () => vscode.workspace.fs.readFile(uri),
    })
  );
}

/** What the payload says about the box: it is available, starts on the file's view, and (CSV) the note. */
export function queryInfoFor(uri: vscode.Uri, format: FileSqlFormat): SingleTableQueryInfo {
  return {
    capabilities: { query: true },
    querySuggestion: suggestQueryFor(viewNameForFile(fileNameOf(uri))),
    ...(format === 'csv' && { queryNote: CSV_QUERY_NOTE }),
  };
}
