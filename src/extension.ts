import * as vscode from 'vscode';
import { CsvEditorProvider } from './csvEditorProvider';
import { ParquetEditorProvider } from './parquetEditorProvider';
import { SqliteEditorProvider } from './sqliteEditorProvider';
import { XlsxEditorProvider } from './xlsxEditorProvider';
import type { CsvParseOutcome } from './csvParser';
import type { ParquetParseOutcome } from './parquetParser';
import type { MultiTableParseOutcome } from './tableData';

/** Public API returned from `activate()`, retrievable via `extension.exports`. */
export interface TablasApi {
  /** Fires with the parsed outcome whenever `csv-data` has been posted to a webview. */
  onDidPostCsvData: vscode.Event<CsvParseOutcome>;
  /** Fires with the parsed outcome whenever `parquet-data` has been posted to a webview. */
  onDidPostParquetData: vscode.Event<ParquetParseOutcome>;
  /** Fires with the parsed outcome whenever `sqlite-data` has been posted to a webview (initial load or table switch). */
  onDidPostSqliteData: vscode.Event<MultiTableParseOutcome>;
  /** Fires with the parsed outcome whenever `xlsx-data` has been posted to a webview (initial load or sheet switch). */
  onDidPostXlsxData: vscode.Event<MultiTableParseOutcome>;
}

export function activate(context: vscode.ExtensionContext): TablasApi {
  const csv = CsvEditorProvider.register(context);
  const parquet = ParquetEditorProvider.register(context);
  const sqlite = SqliteEditorProvider.register(context);
  const xlsx = XlsxEditorProvider.register(context);
  context.subscriptions.push(
    csv.disposable,
    csv.provider,
    parquet.disposable,
    parquet.provider,
    sqlite.disposable,
    sqlite.provider,
    xlsx.disposable,
    xlsx.provider
  );
  return {
    onDidPostCsvData: csv.provider.onDidPostCsvData,
    onDidPostParquetData: parquet.provider.onDidPostParquetData,
    onDidPostSqliteData: sqlite.provider.onDidPostSqliteData,
    onDidPostXlsxData: xlsx.provider.onDidPostXlsxData,
  };
}

export function deactivate(): void {}
