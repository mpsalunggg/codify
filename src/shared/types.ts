// Types shared by the extension host (src/*.ts) and the webview (src/webview/main.ts).

export interface Track {
  id: string;
  name: string;
  artist: string;
  album: string;
  durationMs: number;
}

export type PlayerState = 'playing' | 'paused' | 'stopped' | 'not_running';

export interface LyricLine {
  timeMs: number;
  text: string;
}

export type Lyrics =
  | { kind: 'loading' }
  | { kind: 'none' }
  | { kind: 'instrumental' }
  | { kind: 'ad' }
  | { kind: 'plain'; text: string }
  | { kind: 'synced'; lines: LyricLine[] }
  | { kind: 'error'; message: string };

export type LyricsKind = Lyrics['kind'];

export type Alignment = 'left' | 'right';

/** Messages sent from the extension to a webview. */
export type ExtensionMessage =
  | { type: 'track'; track: Track; lyrics: Lyrics }
  | { type: 'line'; index: number }
  | { type: 'align'; align: Alignment }
  | { type: 'idle'; message: string };

/** Messages sent from a webview to the extension. */
export type WebviewMessage = { type: 'ready' };
