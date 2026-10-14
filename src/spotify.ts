import { execFile } from 'node:child_process';
import type { PlayerState, Track } from './shared/types';

export interface PlayerSnapshot {
  state: PlayerState;
  /** Null unless a track is loaded. */
  track: Track | null;
  positionMs: number;
}

const FIELD_SEPARATOR = '\u001f';

// Checks that Spotify is running first so reading the state never launches the app.
const READ_STATE_SCRIPT = `
if application "Spotify" is running then
  tell application "Spotify"
    if player state is stopped then return "stopped"
    set t to current track
    set sep to ASCII character 31
    return (id of t) & sep & (name of t) & sep & (artist of t) & sep & (album of t) & sep & ((duration of t) as integer as string) & sep & (((player position) * 1000) as integer as string) & sep & (player state as string)
  end tell
else
  return "not_running"
end if`;

function runAppleScript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 3000 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}

export async function readPlayerState(): Promise<PlayerSnapshot> {
  const output = await runAppleScript(READ_STATE_SCRIPT);
  if (output === 'not_running' || output === 'stopped') {
    return { state: output, track: null, positionMs: 0 };
  }
  const [id, name, artist, album, durationMs, positionMs, state] = output.split(FIELD_SEPARATOR);
  return {
    state: state as PlayerState,
    track: { id, name, artist, album, durationMs: Number(durationMs) },
    positionMs: Number(positionMs),
  };
}

export type PlayerCommand = 'playpause' | 'play' | 'pause' | 'next track' | 'previous track';

export function sendPlayerCommand(command: PlayerCommand): Promise<string> {
  return runAppleScript(`tell application "Spotify" to ${command}`);
}

/** macOS refuses Apple Events until the user allows the editor to control Spotify. */
export function isAuthorizationError(err: Error): boolean {
  return /-1743|Not authorized/.test(err.message);
}

/** Ads on the free tier show up as tracks with a "spotify:ad:" id. */
export function isAd(track: Track): boolean {
  return track.id.startsWith('spotify:ad:');
}
