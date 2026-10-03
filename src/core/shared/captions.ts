// Caption paging and drawing. drawCaptionPage() takes any Canvas 2D context, so the
// exporter (@napi-rs/canvas) and the browser preview draw pixel-identical captions.
import type { CaptionStyle } from "./types.js";
import type { TimelineWord } from "./timeline.js";

export interface CaptionWord {
  text: string;
  start: number;
  end: number;
}

export interface CaptionPage {
  start: number;
  end: number;
  words: CaptionWord[];
}

const SENTENCE_END = /[.?!…]["')\]]*$/;

export function paginateCaptions(words: TimelineWord[], style: CaptionStyle): CaptionPage[] {
  const pages: CaptionPage[] = [];
  let cur: CaptionWord[] = [];
  const flush = () => {
    if (cur.length) pages.push({ start: cur[0].start, end: cur[cur.length - 1].end, words: cur });
    cur = [];
  };
  for (const w of words) {
    const text = w.word.text.trim();
    if (!text) continue;
    const prev = cur[cur.length - 1];
    const chars = cur.reduce((n, x) => n + x.text.length + 1, 0) + text.length;
    if (prev && (cur.length >= style.maxWords || chars > style.maxChars || w.start - prev.end > 0.8)) flush();
    cur.push({ text, start: w.start, end: w.end });
    if (SENTENCE_END.test(text)) flush();
  }
  flush();
  // Hold each page until the next one starts if the gap is short, so captions don't flicker.
  for (let i = 0; i < pages.length; i++) {
    const next = pages[i + 1];
    const end = pages[i].end;
    pages[i].end = next ? (next.start - end < 0.6 ? next.start : end + 0.25) : end + 0.25;
  }
  return pages;
}

/** Index of the word being spoken at time t (page-relative to the timeline), or -1. */
export function activeWordIndex(page: CaptionPage, t: number): number {
  let idx = -1;
  page.words.forEach((w, i) => {
    if (t >= w.start - 0.02) idx = i;
  });
  return idx;
}

/** Minimal subset of CanvasRenderingContext2D used for drawing. */
export interface Ctx2D {
  font: string;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineJoin: string;
  textBaseline: string;
  textAlign: string;
  globalAlpha: number;
  shadowColor: string;
  shadowBlur: number;
  measureText(text: string): { width: number };
  fillText(text: string, x: number, y: number): void;
  strokeText(text: string, x: number, y: number): void;
  beginPath(): void;
  roundRect?(x: number, y: number, w: number, h: number, r: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  scale(x: number, y: number): void;
}

/** Seconds an entrance animation takes. */
export function animationDuration(style: CaptionStyle): number {
  return style.animation === "bounce" ? 0.32 : style.animation === "none" ? 0 : 0.2;
}

const easeOutBack = (t: number) => {
  const c = 1.9;
  return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
};
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBounce = (t: number) => {
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
};
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const norm = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}'-]+/gu, "");

/** Where the words of a caption page sit before any animation. Measuring is its only use of ctx. */
export interface CaptionLayout {
  /** Font size in px. */
  size: number;
  /** CSS font shorthand the page is drawn with. */
  font: string;
  /** Words as drawn (uppercased if the style says so). */
  words: string[];
  /** Advance width of each word, unscaled. */
  widths: number[];
  space: number;
  lines: { idx: number[]; width: number }[];
  lineH: number;
  blockH: number;
  /** Middle of the first line, before the page's entrance offset. */
  top: number;
}

/** Lay out a caption page: font size, greedy line wrapping and the block's vertical position. Leaves ctx.font set. */
export function layoutCaptionPage(ctx: Ctx2D, width: number, height: number, page: CaptionPage, style: CaptionStyle): CaptionLayout {
  const size = Math.round(style.fontSize * height);
  const font = `${style.fontWeight} ${size}px ${style.fontFamily}`;
  ctx.font = font;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";
  const words = page.words.map((w) => (style.uppercase ? w.text.toUpperCase() : w.text));
  // Word gap: a space plus room for the outline, so stroked words never touch.
  const space = ctx.measureText(" ").width + (style.strokeWidth ? style.strokeWidth * size * 0.5 : 0);
  const maxLine = width * 0.86;

  // Greedy line wrapping on unscaled widths, so animations never reflow the text.
  const widths = words.map((w) => ctx.measureText(w).width);
  const lines: { idx: number[]; width: number }[] = [];
  let line: number[] = [];
  let lineW = 0;
  words.forEach((_, i) => {
    if (line.length && lineW + space + widths[i] > maxLine) {
      lines.push({ idx: line, width: lineW });
      line = [];
      lineW = 0;
    }
    lineW += (line.length ? space : 0) + widths[i];
    line.push(i);
  });
  if (line.length) lines.push({ idx: line, width: lineW });

  const lineH = size * 1.22;
  const blockH = lineH * lines.length;
  return { size, font, words, widths, space, lines, lineH, blockH, top: style.position * height - blockH / 2 + lineH / 2 };
}

/** One word of a caption page as drawn at some time t. */
export interface CaptionWordFrame {
  /** Index in page.words. */
  i: number;
  /** Text as drawn. */
  text: string;
  /** Advance width, unscaled. */
  width: number;
  /** Centre of the word's advance box on the line's middle: the point it is drawn and scaled around. */
  cx: number;
  cy: number;
  scale: number;
  /** Page alpha × word alpha. */
  alpha: number;
  /** The spoken word, highlighted (style.highlight on). */
  isActive: boolean;
  fill: string;
}

export interface CaptionFrame {
  layout: CaptionLayout;
  /** Page-level entrance alpha and vertical offset. */
  alpha: number;
  dy: number;
  /** Visible words only ("reveal" hides the unspoken ones). */
  words: CaptionWordFrame[];
}

/** Everything drawCaptionFrame() draws for a page at time t, without drawing it. */
export function captionFrame(ctx: Ctx2D, width: number, height: number, page: CaptionPage, style: CaptionStyle, t: number): CaptionFrame {
  const layout = layoutCaptionPage(ctx, width, height, page, style);
  const { size, words, widths, space, lines, lineH } = layout;
  const dur = animationDuration(style);
  const active = activeWordIndex(page, t);
  const emph = new Set(style.emphasisWords.map(norm));

  // Page-level entrance.
  const pageAge = dur ? clamp01((t - page.start) / dur) : 1;
  let alpha = 1;
  let dy = 0;
  if (style.animation === "fade") alpha = easeOutCubic(pageAge);
  if (style.animation === "rise") {
    alpha = easeOutCubic(pageAge);
    dy = (1 - easeOutCubic(pageAge)) * size * 0.6;
  }
  if (style.animation === "bounce") dy = (1 - easeOutBounce(pageAge)) * size * 1.2;

  const out: CaptionWordFrame[] = [];
  let y = layout.top + dy;
  for (const l of lines) {
    // Scales first: a word that grows (pop, scale highlight) makes room on the line instead of
    // overlapping its neighbours. Wrapping stays on unscaled widths, so nothing reflows.
    const scales = l.idx.map((i) => {
      const isActive = style.highlight && i === active;
      const wordAge = dur ? clamp01((t - page.words[i].start) / dur) : 1;
      let scale = 1;
      if (style.animation === "reveal") scale = i <= active ? 0.7 + 0.3 * easeOutBack(wordAge) : 1;
      else if (style.animation === "pop" && i === active) scale = 1 + 0.16 * (1 - easeOutCubic(wordAge)) + 0.04;
      if (isActive && style.highlightStyle === "scale") scale *= 1.14;
      return scale;
    });
    const grow = l.idx.reduce((sum, i, k) => sum + Math.max(0, scales[k] - 1) * widths[i], 0);
    let x = (width - l.width - grow) / 2;
    l.idx.forEach((i, k) => {
      const ww = widths[i];
      const spoken = i <= active;
      const isActive = style.highlight && i === active;
      const wordAge = dur ? clamp01((t - page.words[i].start) / dur) : 1;
      const scale = scales[k];
      const advance = ww * Math.max(1, scale);
      let wAlpha = 1;
      if (style.animation === "reveal") {
        if (!spoken) {
          x += ww + space;
          return;
        }
        wAlpha = easeOutCubic(Math.min(1, wordAge * 2));
      }

      let fill = style.color;
      if (emph.has(norm(page.words[i].text))) fill = style.emphasisColor;
      if (isActive && style.highlightStyle !== "box") fill = style.highlightColor;
      out.push({ i, text: words[i], width: ww, cx: x + advance / 2, cy: y, scale, alpha: alpha * wAlpha, isActive, fill });
      x += advance + space;
    });
    y += lineH;
  }
  return { layout, alpha, dy, words: out };
}

/**
 * Draw one caption word: highlight box, stroke, fill (with glow) and underline, scaled around its
 * anchor. Expects ctx.font, textBaseline "middle", textAlign "left" and lineJoin "round" to be set.
 */
export function drawCaptionWord(ctx: Ctx2D, w: CaptionWordFrame, size: number, style: CaptionStyle): void {
  const ww = w.width;
  ctx.save();
  ctx.globalAlpha = w.alpha;
  ctx.translate(w.cx, w.cy);
  ctx.scale(w.scale, w.scale);

  if (w.isActive && style.highlightStyle === "box") {
    const padX = size * 0.18;
    const padY = size * 0.1;
    ctx.fillStyle = style.boxColor;
    ctx.beginPath();
    const bw = ww + padX * 2;
    const bh = size * 1.0 + padY * 2;
    if (ctx.roundRect) ctx.roundRect(-bw / 2, -bh / 2, bw, bh, size * 0.18);
    else ctx.rect(-bw / 2, -bh / 2, bw, bh);
    ctx.fill();
  }
  if (style.strokeWidth > 0) {
    ctx.lineWidth = size * style.strokeWidth;
    ctx.strokeStyle = style.strokeColor;
    ctx.strokeText(w.text, -ww / 2, 0);
  }
  if (style.glow) {
    ctx.shadowColor = style.glow;
    ctx.shadowBlur = size * 0.45;
  }
  ctx.fillStyle = w.fill;
  ctx.fillText(w.text, -ww / 2, 0);
  ctx.shadowBlur = 0;
  if (w.isActive && style.highlightStyle === "underline") {
    ctx.fillStyle = style.highlightColor;
    ctx.beginPath();
    ctx.rect(-ww / 2, size * 0.48, ww, size * 0.12);
    ctx.fill();
  }
  ctx.restore();
}

/**
 * Draw one caption page as it looks at time t (seconds, same clock as the page's words).
 * Used by the preview every frame and by the exporter at sampled times.
 */
export function drawCaptionFrame(ctx: Ctx2D, width: number, height: number, page: CaptionPage, style: CaptionStyle, t: number): void {
  const f = captionFrame(ctx, width, height, page, style, t);
  const { size, lines, lineH, blockH } = f.layout;

  ctx.save();
  ctx.globalAlpha = f.alpha;
  if (style.background) {
    const widest = Math.max(...lines.map((l) => l.width));
    const padX = size * 0.45;
    const padY = size * 0.28;
    ctx.fillStyle = style.background;
    ctx.beginPath();
    const bx = (width - widest) / 2 - padX;
    const by = f.layout.top + f.dy - lineH / 2 - padY;
    if (ctx.roundRect) ctx.roundRect(bx, by, widest + padX * 2, blockH + padY * 2, size * 0.3);
    else ctx.rect(bx, by, widest + padX * 2, blockH + padY * 2);
    ctx.fill();
  }

  ctx.lineJoin = "round";
  for (const w of f.words) drawCaptionWord(ctx, w, size, style);
  ctx.restore();
}

/**
 * Times at which an exported caption page must be redrawn: every word change, plus the
 * frames of each entrance animation. Between samples the frame holds.
 */
export function captionSampleTimes(page: CaptionPage, style: CaptionStyle, fps: number): number[] {
  const dur = animationDuration(style);
  const events = [page.start, ...page.words.map((w) => w.start).filter((s) => s > page.start)];
  const out = new Set<number>();
  for (const e of events) {
    out.add(e);
    if (dur) for (let k = 1; k <= Math.ceil(dur * fps); k++) out.add(e + k / fps);
  }
  return [...out].filter((x) => x >= page.start && x < page.end).sort((a, b) => a - b);
}

export interface CaptionPreset {
  id: string;
  name: string;
  style: Partial<CaptionStyle>;
}

/** Caption templates. Applying one sets these fields; everything stays tweakable afterwards. */
export const CAPTION_PRESETS: CaptionPreset[] = [
  {
    id: "pop",
    name: "Pop",
    style: { maxWords: 3, maxChars: 20, uppercase: true, fontFamily: "Helvetica Neue, Arial, sans-serif", fontWeight: 900, fontSize: 0.062, position: 0.72, color: "#ffffff", highlight: true, highlightStyle: "color", highlightColor: "#ffd60a", strokeColor: "#000000", strokeWidth: 0.17, background: null, glow: null, animation: "pop" },
  },
  {
    id: "karaoke",
    name: "Karaoke",
    style: { maxWords: 4, maxChars: 26, uppercase: true, fontFamily: "Helvetica Neue, Arial, sans-serif", fontWeight: 800, fontSize: 0.055, position: 0.74, color: "#ffffff", highlight: true, highlightStyle: "box", boxColor: "#7c3aed", strokeColor: "#000000", strokeWidth: 0, background: null, glow: "rgba(0,0,0,0.55)", animation: "pop" },
  },
  {
    id: "bold",
    name: "One word",
    style: { maxWords: 1, maxChars: 14, uppercase: true, fontFamily: "Arial Black, Helvetica Neue, sans-serif", fontWeight: 900, fontSize: 0.095, position: 0.62, color: "#ffffff", highlight: false, highlightStyle: "color", strokeColor: "#000000", strokeWidth: 0.14, background: null, glow: null, animation: "bounce", emphasisColor: "#4ade80" },
  },
  {
    id: "reveal",
    name: "Typewriter",
    style: { maxWords: 6, maxChars: 34, uppercase: false, fontFamily: "Avenir Next, Helvetica Neue, sans-serif", fontWeight: 700, fontSize: 0.05, position: 0.78, color: "#ffffff", highlight: false, highlightStyle: "color", strokeColor: "#000000", strokeWidth: 0.12, background: null, glow: null, animation: "reveal" },
  },
  {
    id: "boxed",
    name: "Boxed",
    style: { maxWords: 7, maxChars: 40, uppercase: false, fontFamily: "Helvetica Neue, Arial, sans-serif", fontWeight: 600, fontSize: 0.042, position: 0.86, color: "#ffffff", highlight: false, highlightStyle: "color", strokeColor: "#000000", strokeWidth: 0, background: "rgba(0,0,0,0.72)", glow: null, animation: "rise" },
  },
  {
    id: "underline",
    name: "Underline",
    style: { maxWords: 4, maxChars: 26, uppercase: false, fontFamily: "Futura, Avenir Next, sans-serif", fontWeight: 800, fontSize: 0.056, position: 0.76, color: "#ffffff", highlight: true, highlightStyle: "underline", highlightColor: "#fb923c", strokeColor: "#000000", strokeWidth: 0.12, background: null, glow: null, animation: "rise" },
  },
  {
    id: "neon",
    name: "Neon",
    style: { maxWords: 3, maxChars: 22, uppercase: true, fontFamily: "Futura, Avenir Next, sans-serif", fontWeight: 800, fontSize: 0.058, position: 0.74, color: "#e0f7ff", highlight: true, highlightStyle: "scale", highlightColor: "#f0abfc", strokeColor: "#000000", strokeWidth: 0, background: null, glow: "#22d3ee", animation: "fade" },
  },
  {
    id: "clean",
    name: "Subtitle",
    style: { maxWords: 8, maxChars: 44, uppercase: false, fontFamily: "Helvetica Neue, Arial, sans-serif", fontWeight: 600, fontSize: 0.04, position: 0.88, color: "#ffffff", highlight: false, highlightStyle: "color", strokeColor: "#000000", strokeWidth: 0, background: null, glow: "rgba(0,0,0,0.85)", animation: "fade" },
  },
];
