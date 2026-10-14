import * as vscode from 'vscode';
import * as spotify from './spotify';
import { LyricsController } from './controller';

export function activate(context: vscode.ExtensionContext): void {
  if (process.platform !== 'darwin') {
    vscode.window.showWarningMessage('Codify currently supports macOS only (Spotify desktop app).');
    return;
  }

  const controller = new LyricsController(context);

  // Re-read Spotify right after a control command so the play/pause icon and lyrics update immediately.
  const control = (command: spotify.PlayerCommand) => () => spotify.sendPlayerCommand(command)
    .then(() => controller.poll())
    .catch((err: Error) => vscode.window.showErrorMessage(`Codify: ${err.message}`));

  context.subscriptions.push(
    controller,
    vscode.window.registerWebviewViewProvider('codify.sidebar', controller, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('workbench.sideBar.location') || e.affectsConfiguration('codify.sidebarAlign')) {
        controller.sendAlignment();
      }
      if (e.affectsConfiguration('codify.showInStatusBar')) controller.refreshStatus();
    }),
    vscode.commands.registerCommand('codify.showPanel', () => controller.showPanel()),
    vscode.commands.registerCommand('codify.refresh', () => controller.reloadLyrics()),
    vscode.commands.registerCommand('codify.toggleStatusBar', () => {
      const config = vscode.workspace.getConfiguration('codify');
      return config.update('showInStatusBar', !config.get('showInStatusBar', true), vscode.ConfigurationTarget.Global);
    }),
    vscode.commands.registerCommand('codify.playPause', control('playpause')),
    vscode.commands.registerCommand('codify.play', control('play')),
    vscode.commands.registerCommand('codify.pause', control('pause')),
    vscode.commands.registerCommand('codify.next', control('next track')),
    vscode.commands.registerCommand('codify.previous', control('previous track')),
  );
}

export function deactivate(): void {}
