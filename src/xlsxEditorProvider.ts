import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import type { Workbook } from 'exceljs';
import {
  emptyParsedTable,
  listXlsxSheets,
  openXlsxWorkbook,
  readSelectedSheet,
  xlsxSheetStats,
} from './xlsxParser';
import { reportStatsFailure } from './columnStats';
import { isGetStatsMessage, statsDataMessage, type StatsPayload } from './statsMessage';
import type { MultiTableParseOutcome } from './tableData';
import { buildWebviewHtml } from './webviewHtml';
import { getMaxRowsSetting } from './config';

class XlsxDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  /**
   * Unlike CsvDocument/ParquetDocument's bare stubs, this holds the parsed
   * workbook for the document's lifetime: switching sheets re-reads the
   * already-parsed workbook instead of re-reading and re-parsing the whole
   * file on every dropdown change. Undefined until the ready-handshake
   * completes (or forever, if reading the file/parsing the workbook
   * failed). No resource to close on dispose -- exceljs holds nothing
   * external once `.xlsx.load()` resolves.
   */
  workbook?: Workbook;
  dispose(): void {}
}

export class XlsxEditorProvider implements vscode.CustomReadonlyEditorProvider<XlsxDocument> {
  public static readonly viewType = 'tablas.xlsxViewer';

  /**
   * Registers the provider and returns both the disposable (for
   * `context.subscriptions`) and the provider instance itself, so callers
   * — namely `extension.ts`'s public API — can observe
   * `onDidPostXlsxData`. Integration tests subscribe to that event to
   * verify the extension-host/webview handshake actually completes, since
   * `vscode.commands.executeCommand('vscode.openWith', ...)` resolving
   * doesn't imply the webview ever received data: the
   * `onDidReceiveMessage` handler below is async and unawaited by
   * `resolveCustomEditor`, so an error inside it can't reject that
   * command's promise.
   */
  public static register(context: vscode.ExtensionContext): {
    disposable: vscode.Disposable;
    provider: XlsxEditorProvider;
  } {
    const provider = new XlsxEditorProvider(context);
    const disposable = vscode.window.registerCustomEditorProvider(
      XlsxEditorProvider.viewType,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
    return { disposable, provider };
  }

  private readonly _onDidPostXlsxData = new vscode.EventEmitter<MultiTableParseOutcome>();
  /**
   * Fires whenever `xlsx-data` has been posted to a webview, with the
   * parsed outcome -- on the initial load *and* on every subsequent sheet
   * switch (unlike CSV/Parquet's equivalent events, which only fire once).
   */
  public readonly onDidPostXlsxData: vscode.Event<MultiTableParseOutcome> =
    this._onDidPostXlsxData.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  dispose(): void {
    this._onDidPostXlsxData.dispose();
  }

  openCustomDocument(uri: vscode.Uri): XlsxDocument {
    return new XlsxDocument(uri);
  }

  async resolveCustomEditor(
    document: XlsxDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(path.join(this.context.extensionPath, 'media'))],
    };

    // Generate a per-request nonce for CSP
    const nonce = crypto.randomBytes(16).toString('hex');

    webview.html = buildWebviewHtml(webview, this.context.extensionPath, nonce, 'Excel Viewer');

    // Unlike CSV/Parquet's one-shot 'ready' listener (which disposes
    // itself), this stays registered for the document's lifetime: it also
    // handles every subsequent 'select-table' request against the same
    // already-parsed workbook.
    let hasLoadedInitial = false;
    webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        // A real webview only posts 'ready' once per panel lifetime, but
        // guard against a duplicate anyway: without this, re-entering
        // loadInitial would re-parse the file and overwrite
        // document.workbook, doing the parse work twice for nothing.
        if (hasLoadedInitial) {
          return;
        }
        hasLoadedInitial = true;
        const outcome = await this.loadInitial(document);
        await webview.postMessage({ type: 'xlsx-data', payload: outcome });
        this._onDidPostXlsxData.fire(outcome);
      } else if (message?.type === 'select-table' && typeof message.table === 'string') {
        const outcome = this.handleSelectTable(document, message.table);
        // undefined means the workbook isn't parsed yet (shouldn't happen
        // given the ready-gate above, but cheap to guard) -- no-op.
        if (outcome) {
          await webview.postMessage({ type: 'xlsx-data', payload: outcome });
          this._onDidPostXlsxData.fire(outcome);
        }
      } else if (isGetStatsMessage(message)) {
        const payload = await this.handleGetStats(document, message.table);
        if (payload) {
          await webview.postMessage(statsDataMessage(payload));
        }
      }
    });
  }

  /** First load: reads the file, parses the workbook, stashes it, reads the first sheet. */
  private async loadInitial(document: XlsxDocument): Promise<MultiTableParseOutcome> {
    try {
      const bytes = await vscode.workspace.fs.readFile(document.uri);
      if (bytes.byteLength === 0) {
        return {
          success: true,
          data: { tables: [], selectedTable: '', data: emptyParsedTable() },
          errors: [],
        };
      }

      const opened = await openXlsxWorkbook(bytes);
      if ('error' in opened) {
        return { success: false, errors: [opened.error] };
      }
      document.workbook = opened.workbook;

      const tables = listXlsxSheets(opened.workbook);
      const data = readSelectedSheet(opened.workbook, tables, undefined, getMaxRowsSetting());
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
   * Re-reads the already-parsed workbook for a different sheet. Exposed as
   * a directly-callable, public method (rather than folded straight into
   * the message listener) specifically so a unit test can exercise the
   * sheet-switch logic without a real webview -- `vscode-test`/
   * `@vscode/test-electron` has no way to drive a real webview's `<select>`
   * from Node-side test code. See test/integration/xlsxEditorProvider.test.ts
   * (it can't live under test/unit/ -- this file imports 'vscode', which
   * only exists inside a real Extension Development Host).
   *
   * Returns `undefined` (a no-op for the caller) if the document's workbook
   * isn't parsed yet.
   */
  public handleSelectTable(
    document: XlsxDocument,
    table: string
  ): MultiTableParseOutcome | undefined {
    if (!document.workbook) {
      return undefined;
    }
    try {
      const tables = listXlsxSheets(document.workbook);
      const data = readSelectedSheet(document.workbook, tables, table, getMaxRowsSetting());
      return { success: true, data, errors: [] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        errors: [{ type: 'XlsxError', code: 'ReadFailed', message }],
      };
    }
  }

  /**
   * Column statistics for one sheet, computed from the already-parsed
   * workbook when the webview first asks for them. Like `handleSelectTable`,
   * public so an integration test can call it without a real webview.
   * Returns `undefined` if the workbook isn't parsed yet; an unknown or
   * missing sheet (or a failure) yields a payload without `stats`.
   */
  public async handleGetStats(document: XlsxDocument, table?: string): Promise<StatsPayload | undefined> {
    if (!document.workbook) {
      return undefined;
    }
    try {
      const worksheet = table !== undefined ? document.workbook.getWorksheet(table) : undefined;
      return { table, stats: worksheet ? xlsxSheetStats(worksheet) : undefined };
    } catch (err) {
      reportStatsFailure(err);
      return { table, stats: undefined };
    }
  }
}
