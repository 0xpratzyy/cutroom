// Pure timeline math shared by the engine and the web editor.
import { FILLER_PATTERN, FILLER_WORDS, type Clip, type Focus, type Project, type Transcript, type Word } from "./types.js";

export const EPS = 1e-3;

export interface PlacedClip {
  clip: Clip;
  index: number;
  start: number;
  end: number;
}

export function placeClips(project: Pick<Project, "clips">): PlacedClip[] {
  let t = 0;
  return project.clips.map((clip, index) => {
    const start = t;
    t += clip.out - clip.in;
    return { clip, index, start, end: t };
  });
}

export function timelineDuration(project: Pick<Project, "clips">): number {
  return project.clips.reduce((sum, c) => sum + (c.out - c.in), 0);
}

export function timelineToSource(project: Pick<Project, "clips">, t: number): { placed: PlacedClip; src: number } | null {
  const placed = placeClips(project);
  for (const p of placed) {
    if (t >= p.start - EPS && t < p.end - EPS) return { placed: p, src: p.clip.in + (t - p.start) };
  }
  const last = placed[placed.length - 1];
  if (last && Math.abs(t - last.end) <= EPS) return { placed: last, src: last.clip.out };
  return null;
}

/** First timeline position where `src` of `mediaId` is visible, or null if it was cut. */
export function sourceToTimeline(project: Pick<Project, "clips">, mediaId: string, src: number): number | null {
  for (const p of placeClips(project)) {
    if (p.clip.mediaId === mediaId && src >= p.clip.in - EPS && src <= p.clip.out + EPS) {
      return p.start + Math.min(Math.max(src - p.clip.in, 0), p.clip.out - p.clip.in);
    }
  }
  return null;
}

export interface TimelineWord {
  word: Word;
  mediaId: string;
  kept: boolean;
  /** Timeline position; only meaningful when kept. */
  start: number;
  end: number;
}

/** Map every transcript word onto the timeline. A word is kept if its midpoint survives the edit. */
// Word midpoints are sorted for any sane transcript, so each clip's words are a contiguous run we
// can find by binary search: O(clips · log words) instead of O(clips · words).
const midCache = new WeakMap<Transcript, Float64Array | null>();
function mids(t: Transcript): Float64Array | null {
  let m = midCache.get(t);
  if (m === undefined) {
    const arr = Float64Array.from(t.words, (w) => (w.start + w.end) / 2);
    let sorted = true;
    for (let i = 1; i < arr.length && sorted; i++) if (arr[i] < arr[i - 1]) sorted = false;
    m = sorted ? arr : null;
    midCache.set(t, m);
  }
  return m;
}

function lowerBound(arr: Float64Array, x: number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Indices of words whose midpoint is in [from, to). */
function wordsIn(t: Transcript, from: number, to: number): [number, number] {
  const m = mids(t)!;
  return [lowerBound(m, from), lowerBound(m, to)];
}

/** Map every transcript word onto the timeline. A word is kept if its midpoint survives the edit. */
export function mapWords(project: Pick<Project, "clips">, transcript: Transcript): TimelineWord[] {
  const placed = placeClips(project).filter((p) => p.clip.mediaId === transcript.mediaId);
  const out: TimelineWord[] = transcript.words.map((word) => ({ word, mediaId: transcript.mediaId, kept: false, start: 0, end: 0 }));
  const place = (i: number, p: PlacedClip) => {
    const word = transcript.words[i];
    out[i] = { word, mediaId: transcript.mediaId, kept: true, start: p.start + Math.max(word.start, p.clip.in) - p.clip.in, end: p.start + Math.min(word.end, p.clip.out) - p.clip.in };
  };
  if (mids(transcript)) {
    // First clip in timeline order wins when a source range is used twice.
    for (const p of placed) {
      const [a, b] = wordsIn(transcript, p.clip.in, p.clip.out);
      for (let i = a; i < b; i++) if (!out[i].kept) place(i, p);
    }
    return out;
  }
  transcript.words.forEach((word, i) => {
    const mid = (word.start + word.end) / 2;
    const p = placed.find((pc) => mid >= pc.clip.in && mid < pc.clip.out);
    if (p) place(i, p);
  });
  return out;
}

/**
 * Words that play on the timeline, in timeline order, across all transcribed main-track media.
 * A word appears once per clip that plays it, so reused source ranges (e.g. a cold-open hook) are captioned each time.
 */
export function timelineWords(project: Pick<Project, "clips">, transcripts: Record<string, Transcript | undefined>): TimelineWord[] {
  const out: TimelineWord[] = [];
  const placed = placeClips(project);
  for (const t of Object.values(transcripts)) {
    if (!t) continue;
    const sorted = !!mids(t);
    for (const p of placed) {
      if (p.clip.mediaId !== t.mediaId) continue;
      const [a, b] = sorted ? wordsIn(t, p.clip.in, p.clip.out) : [0, t.words.length];
      for (let i = a; i < b; i++) {
        const word = t.words[i];
        const mid = (word.start + word.end) / 2;
        if (mid < p.clip.in || mid >= p.clip.out) continue;
        out.push({ word, mediaId: t.mediaId, kept: true, start: p.start + Math.max(word.start, p.clip.in) - p.clip.in, end: p.start + Math.min(word.end, p.clip.out) - p.clip.in });
      }
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

export interface Crop {
  /** Scaled source size before cropping. */
  width: number;
  height: number;
  /** Top-left of the crop window inside the scaled source. */
  x: number;
  y: number;
}

/**
 * Cover-fit a source frame into the output frame, optionally zoomed, keeping `focus`
 * as close to the center as the frame edges allow. Same math is used by the
 * ffmpeg renderer and the browser preview, so they always agree.
 */
export function computeCrop(srcW: number, srcH: number, outW: number, outH: number, zoom = 1, focus: Focus = { x: 0.5, y: 0.5 }): Crop {
  const scale = Math.max(outW / srcW, outH / srcH) * Math.max(zoom, 1);
  const width = even(srcW * scale);
  const height = even(srcH * scale);
  const x = clamp(focus.x * width - outW / 2, 0, width - outW);
  const y = clamp(focus.y * height - outH / 2, 0, height - outH);
  return { width, height, x: Math.round(x), y: Math.round(y) };
}

export function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2);
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), Math.max(lo, hi));
}

export function normalizeWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, "");
}

export function isFiller(text: string, fillers: readonly string[] = FILLER_WORDS): boolean {
  const w = normalizeWord(text);
  return fillers.includes(w) || FILLER_PATTERN.test(w);
}

export function uid(prefix: string): string {
  return prefix + Math.random().toString(36).slice(2, 8);
}

export function formatTime(t: number): string {
  const sign = t < 0 ? "-" : "";
  t = Math.abs(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return `${sign}${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Merge overlapping/adjacent [start, end] ranges. */
export function mergeRanges(ranges: { start: number; end: number }[], gap = EPS): { start: number; end: number }[] {
  const sorted = ranges.filter((r) => r.end - r.start > EPS).sort((a, b) => a.start - b.start);
  const out: { start: number; end: number }[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end);
    else out.push({ ...r });
  }
  return out;
}
