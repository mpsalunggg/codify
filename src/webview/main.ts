import type { ExtensionMessage, LyricLine, Lyrics, Track, WebviewMessage } from '../shared/types';

declare function acquireVsCodeApi(): { postMessage(message: WebviewMessage): void };

const vscode = acquireVsCodeApi();
const $lyrics = document.getElementById('lyrics')!;
const $title = document.getElementById('title')!;
const $artist = document.getElementById('artist')!;

// The sidebar ("compact") scrolls inside #lyrics and keeps the active line near the top third;
// the panel scrolls the whole page and centers the active line.
const compact = document.body.classList.contains('compact');
// Where the active line sits in the sidebar, as a fraction of the visible height.
const ANCHOR = 1 / 3;
// Height of the faded edges in px; must match the mask-image in media/webview.css.
const FADE_TOP = 10;
const FADE_BOTTOM = 20;
// After a manual scroll, wait this long before snapping back to the active line.
const RESUME_AFTER_MS = 2500;

const MESSAGES: Record<'loading' | 'none' | 'instrumental' | 'ad', string> = {
  loading: 'Loading lyrics…',
  none: 'No lyrics found for this track.',
  instrumental: '♪ Instrumental ♪',
  ad: 'Spotify ad — lyrics will be back after the ad.',
};

let lineEls: HTMLElement[] = [];
let activeLine = -1;
let userScrollUntil = 0;
let autoScrolling = false;

function setHeader(track: Track | null): void {
  $title.textContent = track ? track.name : 'Codify';
  $artist.textContent = track ? track.artist : '';
  if (track?.album) {
    const album = document.createElement('span');
    album.className = 'album';
    album.textContent = ` · ${track.album}`;
    $artist.appendChild(album);
  }
}

function reset(className: string): void {
  lineEls = [];
  activeLine = -1;
  $lyrics.className = className;
  $lyrics.replaceChildren();
}

function showMessage(text: string): void {
  reset('');
  const p = document.createElement('p');
  p.className = 'message';
  p.textContent = text;
  $lyrics.appendChild(p);
}

function renderLyrics(lyrics: Lyrics): void {
  switch (lyrics.kind) {
    case 'synced':
      return renderSynced(lyrics.lines);
    case 'plain':
      reset('plain');
      $lyrics.textContent = lyrics.text;
      return;
    case 'error':
      return showMessage(`Failed to load lyrics: ${lyrics.message}`);
    default:
      return showMessage(MESSAGES[lyrics.kind]);
  }
}

function renderSynced(lines: LyricLine[]): void {
  reset('synced');
  lineEls = lines.map((line) => {
    const p = document.createElement('p');
    p.className = 'line';
    p.textContent = line.text || '♪';
    return p;
  });
  if (compact) {
    $lyrics.append(createSpacer(), ...lineEls, createSpacer());
    updateSpacers();
    $lyrics.scrollTop = 0;
  } else {
    $lyrics.append(...lineEls);
    window.scrollTo({ top: 0 });
  }
}

// Spacers (not padding) let the first and last lines reach the anchor position
// without stopping the scroll area from shrinking with the sidebar section.
function createSpacer(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'spacer';
  return div;
}

function updateSpacers(): void {
  if (!compact || !$lyrics.classList.contains('synced')) return;
  const [top, bottom] = $lyrics.querySelectorAll<HTMLElement>(':scope > .spacer');
  top.style.height = `${Math.round($lyrics.clientHeight * ANCHOR)}px`;
  bottom.style.height = `${Math.round($lyrics.clientHeight * (1 - ANCHOR))}px`;
}

function scrollToActive(smooth: boolean): void {
  const el = lineEls[activeLine];
  if (!el) return;
  const behavior: ScrollBehavior = smooth ? 'smooth' : 'auto';
  if (!compact) {
    el.scrollIntoView({ behavior, block: 'center' });
    return;
  }
  if (Date.now() < userScrollUntil) return;
  // Ideally the line sits at ANCHOR, but it is clamped so the whole line
  // (including wrapped text) stays visible outside the faded edges.
  const height = $lyrics.clientHeight;
  const lineHeight = el.offsetHeight;
  const maxTop = height - lineHeight - FADE_BOTTOM;
  const top = maxTop < FADE_TOP
    ? 0
    : Math.min(Math.max(height * ANCHOR - lineHeight / 2, FADE_TOP), maxTop);
  autoScrolling = true;
  $lyrics.scrollTo({ top: el.offsetTop - top, behavior });
  setTimeout(() => { autoScrolling = false; }, smooth ? 600 : 50);
}

function setActiveLine(index: number): void {
  if (index === activeLine) return;
  activeLine = index;
  lineEls.forEach((el, i) => {
    el.classList.toggle('past', i < index);
    el.classList.toggle('active', i === index);
  });
  scrollToActive(true);
}

if (compact) {
  // Re-anchor the active line whenever the sidebar section is resized.
  new ResizeObserver(() => {
    updateSpacers();
    scrollToActive(false);
  }).observe($lyrics);

  // Let the user scroll around freely, then return to the active line.
  let resumeTimer: number | undefined;
  const onUserScroll = () => {
    userScrollUntil = Date.now() + RESUME_AFTER_MS;
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => scrollToActive(true), RESUME_AFTER_MS + 50);
  };
  $lyrics.addEventListener('wheel', onUserScroll, { passive: true });
  $lyrics.addEventListener('touchmove', onUserScroll, { passive: true });
  $lyrics.addEventListener('scroll', () => { if (!autoScrolling) onUserScroll(); }, { passive: true });
}

window.addEventListener('message', ({ data }: MessageEvent<ExtensionMessage>) => {
  switch (data.type) {
    case 'track':
      setHeader(data.track);
      renderLyrics(data.lyrics);
      break;
    case 'line':
      setActiveLine(data.index);
      break;
    case 'align':
      document.body.dataset.align = data.align;
      break;
    case 'idle':
      setHeader(null);
      showMessage(data.message);
      break;
  }
});

vscode.postMessage({ type: 'ready' });
