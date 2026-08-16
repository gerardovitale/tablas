import * as vscode from 'vscode';
import { CsvEditorProvider } from './csvEditorProvider';
import { ParquetEditorProvider } from './parquetEditorProvider';
import type { CsvParseOutcome } from './csvParser';
import type { ParquetParseOutcome } from './parquetParser';

/** Public API returned from `activate()`, retrievable via `extension.exports`. */
export interface TablasApi {
  /** Fires with the parsed outcome whenever `csv-data` has been posted to a webview. */
  onDidPostCsvData: vscode.Event<CsvParseOutcome>;
  /** Fires with the parsed outcome whenever `parquet-data` has been posted to a webview. */
  onDidPostParquetData: vscode.Event<ParquetParseOutcome>;
}

export function activate(context: vscode.ExtensionContext): TablasApi {
  const csv = CsvEditorProvider.register(context);
  const parquet = ParquetEditorProvider.register(context);
  context.subscriptions.push(csv.disposable, csv.provider, parquet.disposable, parquet.provider);
  return {
    onDidPostCsvData: csv.provider.onDidPostCsvData,
    onDidPostParquetData: parquet.provider.onDidPostParquetData,
  };
}

export function deactivate(): void {}
