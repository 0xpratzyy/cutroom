// Retake detection. Talking-head creators restart lines until they land them:
//   "So today I want to... so today I want to show you how to edit."
// We split the transcript into phrases, find nearby phrases that repeat each other
// (false starts and full redos), and suggest the best take: complete, fluent, and
// usually the last attempt.
import type { Op } from "./ops.js";
import { isFiller, mapWords, normalizeWord } from "./timeline.js";
import type { Project, Transcript, Word } from "./types.js";

export interface Take {
  mediaId: string;
  /** Word index range [from, to]. */
  from: number;
  to: number;
  text: string;
  /** Source seconds. */
  start: number;
  end: number;
  /** Whether the take currently plays in the edit. */
  kept: boolean;
  fillers: number;
  /** Ends a sentence (looks finished). */
  complete: boolean;
  score: number;
}

export interface TakeGroup {
  id: string;
  takes: Take[];
  /** Index of the suggested take. */
  best: number;
}

interface Phrase {
  words: Word[];
  tokens: string[];
}

const PHRASE_GAP = 0.65;

function phrases(words: Word[]): Phrase[] {
  const out: Phrase[] = [];
  let cur: Word[] = [];
  const flush = () => {
    const content = cur.filter((w) => !isFiller(w.text));
    if (content.length) out.push({ words: cur, tokens: content.map((w) => normalizeWord(w.text)).filter(Boolean) });
    cur = [];
  };
  words.forEach((w, i) => {
    const prev = words[i - 1];
    if (prev && w.start - prev.end > PHRASE_GAP) flush();
    cur.push(w);
    // Sentence ends, and trailing-off ("to...", "the—") mark a phrase boundary too.
    if (/[.?!…]$|\.\.\.$|[-—–]$/.test(w.text)) flush();
  });
  flush();
  return out;
}

/** Length of the common prefix of two token lists. */
function commonPrefix(a: string[], b: string[]): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
}

/** Longest-common-subsequence ratio (0..1) relative to the shorter phrase. */
function similarity(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0;
  const dp = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
  return dp[a.length][b.length] / Math.min(a.length, b.length);
}

/** Is `later` a redo of `earlier`? */
function isRetake(earlier: Phrase, later: Phrase): boolean {
  const a = earlier.tokens;
  const b = later.tokens;
  if (a.length < 2 && b.length < 2) return false;
  const prefix = commonPrefix(a, b);
  // False start: the earlier attempt is (mostly) the opening of the later one.
  if (prefix >= Math.min(3, a.length) && prefix >= a.length * 0.6) return true;
  // Full redo: same sentence said again, maybe reworded a little.
  return Math.min(a.length, b.length) >= 4 && similarity(a, b) >= 0.7 && Math.max(a.length, b.length) / Math.min(a.length, b.length) <= 2.2;
}

// Whisper often punctuates a false start ("I want to."), so a sentence ending on a
// function word counts as unfinished.
const DANGLING = new Set(["a", "an", "the", "to", "and", "but", "or", "so", "of", "in", "on", "for", "with", "is", "are", "was", "i", "my", "your", "this", "that", "we", "you", "it's", "like", "um", "uh"]);
function looksFinished(words: Word[]): boolean {
  const last = words[words.length - 1].text;
  if (!/[.?!]$/.test(last) || /\.\.\.$/.test(last)) return false;
  return !DANGLING.has(normalizeWord(last));
}

function scoreTake(t: Omit<Take, "score">, index: number, count: number, maxLen: number): number {
  let s = 0;
  if (t.complete) s += 3;
  s -= t.fillers * 1.2;
  s += (t.to - t.from + 1) / Math.max(1, maxLen); // fuller takes are usually the good one
  s += (index / Math.max(1, count - 1)) * 1.5; // people redo until it's right: favor later takes
  return s;
}

export function findRetakes(project: Pick<Project, "clips">, transcripts: Record<string, Transcript | undefined>, opts: { maxDistance?: number } = {}): TakeGroup[] {
  const maxDistance = opts.maxDistance ?? 25; // seconds between attempts
  const groups: TakeGroup[] = [];
  for (const t of Object.values(transcripts)) {
    if (!t || !t.words.length) continue;
    const mapped = mapWords(project, t);
    // Only consider media that's on the main track.
    if (!mapped.some((w) => w.kept)) continue;
    const ps = phrases(t.words);
    const used = new Set<number>();
    for (let i = 0; i < ps.length; i++) {
      if (used.has(i)) continue;
      const chain = [i];
      for (let j = i + 1; j < ps.length && j <= chain[chain.length - 1] + 3; j++) {
        const last = ps[chain[chain.length - 1]];
        if (ps[j].words[0].start - last.words[last.words.length - 1].end > maxDistance) break;
        if (isRetake(last, ps[j]) || isRetake(ps[chain[0]], ps[j])) chain.push(j);
      }
      if (chain.length < 2) continue;
      chain.forEach((k) => used.add(k));
      const maxLen = Math.max(...chain.map((k) => ps[k].words.length));
      const takes = chain.map((k, idx) => {
        const words = ps[k].words;
        const base = {
          mediaId: t.mediaId,
          from: words[0].i,
          to: words[words.length - 1].i,
          text: words.map((w) => w.text).join(" "),
          start: words[0].start,
          end: words[words.length - 1].end,
          kept: words.some((w) => mapped[w.i]?.kept),
          fillers: words.filter((w) => isFiller(w.text)).length,
          complete: looksFinished(words),
        };
        return { ...base, score: scoreTake(base, idx, chain.length, maxLen) };
      });
      const best = takes.reduce((b, x, k) => (x.score > takes[b].score ? k : b), 0);
      groups.push({ id: `${t.mediaId}:${takes[0].from}`, takes, best });
    }
  }
  return groups.sort((a, b) => a.takes[0].start - b.takes[0].start);
}

/** Ops that keep one take of a group and cut the others. */
export function useTakeOps(group: TakeGroup, keep: number): Op[] {
  const ops: Op[] = [];
  group.takes.forEach((t, k) => {
    if (k === keep) {
      if (!t.kept) ops.push({ op: "restore_words", mediaId: t.mediaId, from: t.from, to: t.to });
    } else if (t.kept) ops.push({ op: "remove_words", mediaId: t.mediaId, from: t.from, to: t.to });
  });
  return ops;
}
