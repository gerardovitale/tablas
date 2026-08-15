import * as vscode from 'vscode';
import { CsvEditorProvider } from './csvEditorProvider';

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(CsvEditorProvider.register(context));
}

export function deactivate(): void {}
