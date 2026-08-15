import * as vscode from 'vscode';
import { CsvEditorProvider } from './csvEditorProvider';
import type { CsvParseOutcome } from './csvParser';

/** Public API returned from `activate()`, retrievable via `extension.exports`. */
export interface TablasApi {
  /** Fires with the parsed outcome whenever `csv-data` has been posted to a webview. */
  onDidPostCsvData: vscode.Event<CsvParseOutcome>;
}

export function activate(context: vscode.ExtensionContext): TablasApi {
  const { disposable, provider } = CsvEditorProvider.register(context);
  context.subscriptions.push(disposable, provider);
  return { onDidPostCsvData: provider.onDidPostCsvData };
}

export function deactivate(): void {}
