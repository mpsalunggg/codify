import { name, version } from '../package.json';
import type { LyricLine, Lyrics, Track } from './shared/types';

const LRCLIB_API = 'https://lrclib.net/api/';
const USER_AGENT = `${name}/${version}`;

/** The subset of an LRCLIB record that Codify uses. */
interface LrclibRecord {
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
}

async function lrclibRequest<T>(endpoint: 'get' | 'search', params: Record<string, string>): Promise<T | null> {
  const query = new URLSearchParams(params).toString();
  const res = await fetch(`${LRCLIB_API}${endpoint}?${query}`, { headers: { 'User-Agent': USER_AGENT } });
  // 400 means incomplete parameters (e.g. empty album or zero duration): treat it as "not found".
  if (res.status === 404 || res.status === 400) return null;
  if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Parses LRC text into lines sorted by time. */
export function parseLrc(lrc: string): LyricLine[] {
  const lines: LyricLine[] = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const [, minutes, seconds] of stamps) {
      lines.push({ timeMs: Math.round((Number(minutes) * 60 + Number(seconds)) * 1000), text });
    }
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}

/** Looks up lyrics for a track on LRCLIB. */
export async function fetchLyrics(track: Track): Promise<Lyrics> {
  let match = await lrclibRequest<LrclibRecord>('get', {
    track_name: track.name,
    artist_name: track.artist,
    album_name: track.album,
    duration: String(Math.round(track.durationMs / 1000)),
  });
  if (!match || (!match.syncedLyrics && !match.plainLyrics)) {
    // Fall back to a looser search without album/duration, preferring synced results.
    const results = (await lrclibRequest<LrclibRecord[]>('search', { track_name: track.name, artist_name: track.artist })) ?? [];
    match = results.find((r) => r.syncedLyrics) ?? results.find((r) => r.plainLyrics) ?? match;
  }
  if (!match) return { kind: 'none' };
  if (match.instrumental) return { kind: 'instrumental' };
  if (match.syncedLyrics) return { kind: 'synced', lines: parseLrc(match.syncedLyrics) };
  if (match.plainLyrics) return { kind: 'plain', text: match.plainLyrics };
  return { kind: 'none' };
}

/** Index of the last line that started at or before `positionMs`, or -1 before the first line. */
export function findActiveLine(lines: LyricLine[], positionMs: number): number {
  let low = 0;
  let high = lines.length - 1;
  let index = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (lines[mid].timeMs <= positionMs) {
      index = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }
  return index;
}
