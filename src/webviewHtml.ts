import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';

/** HTML shell shared by the lyrics panel and the compact sidebar view. */
export function getWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, { compact }: { compact: boolean }): string {
  const asset = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...path));
  const nonce = randomBytes(16).toString('base64');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'webview.css')}">
</head>
<body class="${compact ? 'compact' : ''}">
  <header><div id="title">Codify</div><div id="artist"></div></header>
  <main id="lyrics"><p class="message">Waiting for Spotify…</p></main>
  <script nonce="${nonce}" src="${asset('dist', 'webview.js')}"></script>
</body>
</html>`;
}

/** Folders a webview may load files from. */
export function webviewResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media'), vscode.Uri.joinPath(extensionUri, 'dist')];
}
