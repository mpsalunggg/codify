import * as vscode from 'vscode';
import * as spotify from './spotify';
import { fetchLyrics, findActiveLine } from './lyrics';
import { getWebviewHtml, webviewResourceRoots } from './webviewHtml';
import type { Alignment, ExtensionMessage, Lyrics, LyricsKind, PlayerState, Track, WebviewMessage } from './shared/types';

const TICK_MS = 200;
const MIN_POLL_MS = 300;
const STATUS_MAX_LENGTH = 90;
// Never a real line index, so the next tick always re-sends the active line.
const NO_LINE = -2;

const STATUS_SUFFIX: Record<Exclude<LyricsKind, 'synced' | 'ad'>, string> = {
  loading: 'loading lyrics…',
  none: 'no lyrics found',
  plain: 'lyrics (not synced)',
  instrumental: 'instrumental',
  error: 'failed to load lyrics',
};

/**
 * Polls Spotify, loads lyrics for the current track and keeps the status bar
 * and every open webview (panel and sidebar) in sync with the playback position.
 */
export class LyricsController implements vscode.WebviewViewProvider, vscode.Disposable {
  private state: PlayerState | 'error' = 'not_running';
  private track: Track | null = null;
  private lyrics: Lyrics = { kind: 'loading' };
  private readonly cache = new Map<string, Lyrics>();
  // Last position reported by Spotify; the position in between polls is extrapolated from it.
  private positionMs = 0;
  private positionAt = 0;
  private lastLine = NO_LINE;
  private playing: boolean | null = null;
  private warningShown = false;
  private statusText = '';
  private readonly webviews = new Set<vscode.Webview>();
  private panel: vscode.WebviewPanel | null = null;
  private sidebarView: vscode.WebviewView | null = null;
  private disposed = false;
  private pollTimer: NodeJS.Timeout | undefined;
  private readonly ticker: NodeJS.Timeout;
  private readonly statusItem: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -100);
    this.statusItem.command = 'codify.showPanel';
    this.statusItem.tooltip = 'Codify — click to open the lyrics panel';

    this.ticker = setInterval(() => this.tick(), TICK_MS);
    this.schedulePoll(0);
  }

  private get config(): vscode.WorkspaceConfiguration {
    return vscode.workspace.getConfiguration('codify');
  }

  // --- Spotify polling -------------------------------------------------------

  private schedulePoll(delay: number): void {
    this.pollTimer = setTimeout(async () => {
      await this.poll();
      if (!this.disposed) this.schedulePoll(Math.max(MIN_POLL_MS, this.config.get('pollIntervalMs', 1000)));
    }, delay);
  }

  async poll(): Promise<void> {
    let player: spotify.PlayerSnapshot;
    try {
      player = await spotify.readPlayerState();
    } catch (err) {
      this.handlePollError(err as Error);
      return;
    }
    this.warningShown = false;
    this.state = player.state;
    this.setPlayingContext(player.state === 'playing');

    if (!player.track) {
      this.track = null;
      this.setStatus(player.state === 'not_running' ? '' : '$(music) Spotify is stopped');
      this.broadcast(this.idleMessage());
      return;
    }
    this.positionMs = player.positionMs;
    this.positionAt = Date.now();
    if (this.track?.id !== player.track.id) {
      this.track = player.track;
      this.lastLine = NO_LINE;
      await this.loadLyrics();
    }
  }

  private handlePollError(err: Error): void {
    this.state = 'error';
    this.setPlayingContext(false);
    this.setStatus('$(warning) Codify: cannot read Spotify');
    if (this.warningShown) return;
    this.warningShown = true;
    vscode.window.showWarningMessage(spotify.isAuthorizationError(err)
      ? 'Codify needs Automation access. Open System Settings → Privacy & Security → Automation and allow your editor to control Spotify.'
      : `Codify: ${err.message}`);
  }

  // Context key that swaps the play/pause button in the LYRICS view title.
  private setPlayingContext(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    vscode.commands.executeCommand('setContext', 'codify.playing', playing);
  }

  private estimatedPositionMs(): number {
    const elapsed = this.state === 'playing' ? Date.now() - this.positionAt : 0;
    return this.positionMs + elapsed + this.config.get('offsetMs', 0);
  }

  // --- Lyrics ------------------------------------------------------------------

  private async loadLyrics(force = false): Promise<void> {
    const track = this.track;
    if (!track) return;
    if (spotify.isAd(track)) {
      this.lyrics = { kind: 'ad' };
    } else if (!force && this.cache.has(track.id)) {
      this.lyrics = this.cache.get(track.id)!;
    } else {
      this.lyrics = { kind: 'loading' };
      this.sendTrack();
      let lyrics: Lyrics;
      try {
        lyrics = await fetchLyrics(track);
        this.cache.set(track.id, lyrics);
      } catch (err) {
        lyrics = { kind: 'error', message: (err as Error).message };
      }
      if (this.track !== track) return; // the track changed while fetching
      this.lyrics = lyrics;
    }
    this.lastLine = NO_LINE;
    this.sendTrack();
  }

  reloadLyrics(): Promise<void> {
    return this.loadLyrics(true);
  }

  // --- Status bar --------------------------------------------------------------

  private tick(): void {
    if (!this.track) return;
    const lyrics = this.lyrics;
    if (lyrics.kind === 'ad') {
      this.setStatus('$(megaphone) Spotify ad');
      return;
    }
    if (lyrics.kind !== 'synced') {
      this.setStatus(`$(music) ${this.trackLabel(this.track)} · ${STATUS_SUFFIX[lyrics.kind]}`);
      return;
    }
    const line = findActiveLine(lyrics.lines, this.estimatedPositionMs());
    if (line === this.lastLine) return;
    this.lastLine = line;
    const text = line >= 0 ? lyrics.lines[line].text : '';
    this.setStatus(text ? `$(music) ${text}` : `$(music) ♪ ${this.trackLabel(this.track)}`);
    this.broadcast({ type: 'line', index: line });
  }

  private trackLabel(track: Track): string {
    return `${track.name} — ${track.artist}`;
  }

  private setStatus(text: string): void {
    this.statusText = text;
    if (!text || !this.config.get('showInStatusBar', true)) {
      this.statusItem.hide();
      return;
    }
    this.statusItem.text = text.length > STATUS_MAX_LENGTH ? `${text.slice(0, STATUS_MAX_LENGTH - 1)}…` : text;
    this.statusItem.show();
  }

  /** Re-applies the status bar after `codify.showInStatusBar` changes. */
  refreshStatus(): void {
    this.lastLine = NO_LINE;
    this.setStatus(this.statusText);
    this.tick();
  }

  // --- Webviews ------------------------------------------------------------------

  private broadcast(message: ExtensionMessage): void {
    for (const webview of this.webviews) webview.postMessage(message);
  }

  private idleMessage(): ExtensionMessage {
    return { type: 'idle', message: this.state === 'not_running' ? 'Spotify is not running' : 'Nothing is playing' };
  }

  /** Messages that bring a webview up to date with the current track and line. */
  private trackMessages(): ExtensionMessage[] {
    if (!this.track) return [this.idleMessage()];
    const messages: ExtensionMessage[] = [{ type: 'track', track: this.track, lyrics: this.lyrics }];
    if (this.lyrics.kind === 'synced') {
      messages.push({ type: 'line', index: findActiveLine(this.lyrics.lines, this.estimatedPositionMs()) });
    }
    return messages;
  }

  private sendTrack(): void {
    for (const message of this.trackMessages()) this.broadcast(message);
  }

  private sidebarAlignment(): Alignment {
    const align = this.config.get<Alignment | 'auto'>('sidebarAlign', 'auto');
    if (align !== 'auto') return align;
    return vscode.workspace.getConfiguration('workbench').get<string>('sideBar.location') === 'right' ? 'right' : 'left';
  }

  sendAlignment(): void {
    const message: ExtensionMessage = { type: 'align', align: this.sidebarAlignment() };
    this.sidebarView?.webview.postMessage(message);
  }

  private attachWebview(webview: vscode.Webview, compact: boolean): vscode.Disposable {
    const { extensionUri } = this.context;
    webview.options = { enableScripts: true, localResourceRoots: webviewResourceRoots(extensionUri) };
    webview.html = getWebviewHtml(webview, extensionUri, { compact });
    this.webviews.add(webview);
    const subscription = webview.onDidReceiveMessage((message: WebviewMessage) => {
      if (message.type !== 'ready') return;
      for (const m of this.trackMessages()) webview.postMessage(m);
      if (compact) this.sendAlignment();
    });
    return new vscode.Disposable(() => {
      this.webviews.delete(webview);
      subscription.dispose();
    });
  }

  /** WebviewViewProvider for the LYRICS view in the Explorer sidebar. */
  resolveWebviewView(view: vscode.WebviewView): void {
    this.sidebarView = view;
    const attachment = this.attachWebview(view.webview, true);
    view.onDidDispose(() => {
      attachment.dispose();
      if (this.sidebarView === view) this.sidebarView = null;
    });
  }

  showPanel(): void {
    if (this.panel) {
      this.panel.reveal(vscode.ViewColumn.Beside, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'codify.panel',
      'Lyrics',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { retainContextWhenHidden: true },
    );
    // ThemeIcon is not accepted for webview panels in VS Code 1.80 (our minimum), so use SVG files.
    const icon = (variant: string) => vscode.Uri.joinPath(this.context.extensionUri, 'media', `music-${variant}.svg`);
    panel.iconPath = { light: icon('light'), dark: icon('dark') };
    const attachment = this.attachWebview(panel.webview, false);
    panel.onDidDispose(() => {
      attachment.dispose();
      this.panel = null;
    });
    this.panel = panel;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.pollTimer);
    clearInterval(this.ticker);
    this.panel?.dispose();
    this.statusItem.dispose();
  }
}
