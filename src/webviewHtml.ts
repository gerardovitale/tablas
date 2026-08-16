import * as path from 'path';
import * as vscode from 'vscode';

/** HTML shell shared by every table-viewer webview; `title` is the only per-format bit. */
export function buildWebviewHtml(
  webview: vscode.Webview,
  extensionPath: string,
  nonce: string,
  title: string
): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'media', 'webview.js'))
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.file(path.join(extensionPath, 'media', 'styles.css'))
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
  <title>${title}</title>
</head>
<body>
  <div id="app">
    <p class="message">Loading…</p>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
