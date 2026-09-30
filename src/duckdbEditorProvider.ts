import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import {
  duckdbTableStats,
  emptyParsedTable,
  listDuckdbTables,
  openDuckdbDatabase,
  readSelectedTable,
  type DuckdbHandle,
} from './duckdbParser';
import { reportStatsFailure } from './columnStats';
import { isGetStatsMessage, statsDataMessage, type StatsPayload } from './statsMessage';
import type { MultiTableParseOutcome } from './tableData';
import { buildWebviewHtml } from './webviewHtml';
import { getMaxRowsSetting } from './config';

class DuckdbDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  /**
   * Unlike CsvDocument/ParquetDocument's bare stubs, this holds the live
   * database handle (and its backing temp file) for the document's
   * lifetime: switching tables re-queries the already-open database instead
   * of re-reading and re-opening the whole file on every dropdown change.
   * Undefined until the ready-handshake completes (or forever, if opening
   * the file/database failed).
   */
  handle?: DuckdbHandle;
  dispose(): void {
    this.handle?.close();
  }
}

export class DuckdbEditorProvider
  implements vscode.CustomReadonlyEditorProvider<DuckdbDocument>
{
  public static readonly viewType = 'tablas.duckdbViewer';

  /**
   * Registers the provider and returns both the disposable (for
   * `context.subscriptions`) and the provider instance itself, so callers
   * — namely `extension.ts`'s public API — can observe
   * `onDidPostDuckdbData`. Integration tests subscribe to that event to
   * verify the extension-host/webview handshake actually completes, since
   * `vscode.commands.executeCommand('vscode.openWith', ...)` resolving
   * doesn't imply the webview ever received data: the
   * `onDidReceiveMessage` handler below is async and unawaited by
   * `resolveCustomEditor`, so an error inside it can't reject that
   * command's promise.
   */
  public static register(context: vscode.ExtensionContext): {
    disposable: vscode.Disposable;
    provider: DuckdbEditorProvider;
  } {
    const provider = new DuckdbEditorProvider(context);
    const disposable = vscode.window.registerCustomEditorProvider(
      DuckdbEditorProvider.viewType,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
    return { disposable, provider };
  }

  private readonly _onDidPostDuckdbData = new vscode.EventEmitter<MultiTableParseOutcome>();
  /**
   * Fires whenever `duckdb-data` has been posted to a webview, with the
   * parsed outcome -- on the initial load *and* on every subsequent table
   * switch (unlike CSV/Parquet's equivalent events, which only fire once).
   */
  public readonly onDidPostDuckdbData: vscode.Event<MultiTableParseOutcome> =
    this._onDidPostDuckdbData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this._onDidPostDuckdbData.dispose();
  }

  openCustomDocument(uri: vscode.Uri): DuckdbDocument {
    return new DuckdbDocument(uri);
  }

  async resolveCustomEditor(
    document: DuckdbDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };

    // Generate a per-request nonce for CSP
    const nonce = crypto.randomBytes(16).toString('hex');

    webview.html = buildWebviewHtml(webview, this.context.extensionPath, nonce, 'DuckDB Viewer');

    // Unlike CSV/Parquet's one-shot 'ready' listener (which disposes
    // itself), this stays registered for the document's lifetime: it also
    // handles every subsequent 'select-table' request against the same
    // already-open database.
    let hasLoadedInitial = false;
    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        // A real webview only posts 'ready' once per panel lifetime, but
        // guard against a duplicate anyway: without this, re-entering
        // loadInitial would open a second database (and write a second
        // temp file) and overwrite document.handle without closing the
        // first one, leaking both for the process's lifetime.
        if (hasLoadedInitial) {
          return;
        }
        hasLoadedInitial = true;
        const outcome = await this.loadInitial(document);
        await webview.postMessage({ type: 'duckdb-data', payload: outcome });
        this._onDidPostDuckdbData.fire(outcome);
      } else if (message?.type === 'select-table' && typeof message.table === 'string') {
        const outcome = await this.handleSelectTable(document, message.table);
        // undefined means the database isn't open yet (shouldn't happen
        // given the ready-gate above, but cheap to guard) -- no-op.
        if (outcome) {
          await webview.postMessage({ type: 'duckdb-data', payload: outcome });
          this._onDidPostDuckdbData.fire(outcome);
        }
      } else if (isGetStatsMessage(message)) {
        const payload = await this.handleGetStats(document, message.table);
        if (payload) {
          await webview.postMessage(statsDataMessage(payload));
        }
      }
    });
  }

  /** First load: reads the file, opens the database, stashes the handle, reads the first table. */
  private async loadInitial(document: DuckdbDocument): Promise<MultiTableParseOutcome> {
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      if (bytes.byteLength === 0) {
        return {
          success: true,
          data: { tables: [], selectedTable: '', data: emptyParsedTable() },
          errors: [],
        };
      }

      const opened = await openDuckdbDatabase(bytes);
      if ('error' in opened) {
        return { success: false, errors: [opened.error] };
      }
      document.handle = opened;

      const tables = await listDuckdbTables(opened);
      const data = await readSelectedTable(opened, tables, undefined, getMaxRowsSetting());
      return { success: true, data, errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ type: 'IOError', code: 'ReadFailed', message }],
      };
    }
  }

  /**
   * Re-queries the already-open database for a different table. Exposed as
   * a directly-callable, public method (rather than folded straight into
   * the message listener) specifically so a unit test can exercise the
   * table-switch logic without a real webview -- `vscode-test`/
   * `@vscode/test-electron` has no way to drive a real webview's `<select>`
   * from Node-side test code. See test/integration/duckdbEditorProvider.test.ts
   * (it can't live under test/unit/ -- this file imports 'vscode', which
   * only exists inside a real Extension Development Host).
   *
   * Returns `undefined` (a no-op for the caller) if the document's database
   * isn't open yet.
   */
  public async handleSelectTable(
    document: DuckdbDocument,
    table: string
  ): Promise<MultiTableParseOutcome | undefined> {
    if (!document.handle) {
      return undefined;
    }
    try {
      const tables = await listDuckdbTables(document.handle);
      const data = await readSelectedTable(document.handle, tables, table, getMaxRowsSetting());
      return { success: true, data, errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ type: 'DuckdbError', code: 'ReadFailed', message }],
      };
    }
  }

  /**
   * Column statistics for one table, computed against the already-open
   * database when the webview first asks for them. Like `handleSelectTable`,
   * public so an integration test can call it without a real webview.
   * Returns `undefined` if the database isn't open yet; an unknown or
   * missing table (or a failure) yields a payload without `stats`. Stats
   * queue behind any other query on the same connection (see
   * `runExclusive`), so a slow scan can't collide with a table switch.
   */
  public async handleGetStats(document: DuckdbDocument, table?: string): Promise<StatsPayload | undefined> {
    if (!document.handle) {
      return undefined;
    }
    try {
      const known = table !== undefined && (await listDuckdbTables(document.handle)).some((t) => t.name === table);
      return { table, stats: known ? await duckdbTableStats(document.handle, table) : undefined };
    } catch (err) {
      reportStatsFailure(err);
      return { table, stats: undefined };
    }
  }
}
