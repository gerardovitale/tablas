import * as vscode from 'vscode';
import * as path from 'path';
import * as crypto from 'crypto';
import { parseCsv } from './csvParser';

class CsvDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

export class CsvEditorProvider
  implements vscode.CustomReadonlyEditorProvider<CsvDocument>
{
  public static readonly viewType = 'tablas.csvViewer';

  public static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(
      CsvEditorProvider.viewType,
      new CsvEditorProvider(context),
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      }
    );
  }

  constructor(private readonly context: vscode.ExtensionContext) {}

  openCustomDocument(uri: vscode.Uri): CsvDocument {
    return new CsvDocument(uri);
  }

  async resolveCustomEditor(
    document: CsvDocument,
    webviewPanel: vscode.WebviewPanel
  ): Promise<void> {
    const webview = webviewPanel.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.file(path.join(this.context.extensionPath, 'media')),
      ],
    };

    // Generate a per-request nonce for CSP
    const nonce = crypto.randomBytes(16).toString('hex');

    webview.html = this.buildWebviewHtml(webview, nonce);

    // Wait for 'ready' from webview, then send data
    const disposable = webview.onDidReceiveMessage(async (message) => {
      if (message?.type === 'ready') {
        disposable.dispose();
        const outcome = await this.loadAndParseCsv(document.uri);
        webview.postMessage({ type: 'csv-data', payload: outcome });
      }
    });
  }

  private async loadAndParseCsv(uri: vscode.Uri) {
    try {
      const bytes = await vscode.workspace.fs.readFile(uri);
      const rawContent = new TextDecoder('utf-8').decode(bytes);
      return parseCsv(rawContent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        success: false as const,
        errors: [{ type: 'IOError', code: 'ReadFailed', message }],
      };
    }
  }

  private buildWebviewHtml(webview: vscode.Webview, nonce: string): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this.context.extensionPath, 'media', 'webview.js')
      )
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.file(
        path.join(this.context.extensionPath, 'media', 'styles.css')
      )
    );
    const csp = webview.cspSource;

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none';
             img-src ${csp} data:;
             style-src ${csp};
             script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>CSV Viewer</title>
</head>
<body>
  <div id="app">
    <p class="message">Loading…</p>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
