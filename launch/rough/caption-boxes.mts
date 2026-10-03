// Where each burned-in caption word sits in a cutroom export frame, so the compositor can fly
// transcript words into their exact final boxes (s09 caption lift), and draw a word mid-flight
// that lands pixel-identical on the export. Layout and drawing are cutroom's own
// (layoutCaptionPage / captionFrame / drawCaptionWord in src/core/shared/captions.ts, the code
// drawCaptionFrame runs), measured with @napi-rs/canvas like render.ts does.
//
// Clock: render.ts draws a caption PNG at each sample time and feeds the PNGs to ffmpeg's concat
// demuxer. Its image2 streams carry a 1/25 s time base, so each PNG starts on the nearest 40 ms
// tick (two can share one). An output frame then shows the last PNG stamped before it, or, if
// some are stamped exactly on it, the first of those (measured frame by frame on a real export:
// launch/rough/caption-boxes-check.mts). By default the boxes are those of the PNG on screen in
// the export frame containing timelineTime, i.e. the real burned-in state; { exact: true }
// evaluates the animation at timelineTime instead.
//
// Usage:
//   const { project, transcripts } = loadCaptionProject("launch/out/rough/project", "launch/out/rough/snapshots/v4.json");
//   const boxes = captionWordBoxes(project, transcripts, 3.2, 1080, 1920);
//   for (const w of boxes.words) renderCaptionWord(ctx, w, { x, y, fontSize: 40, color: "#8d8983" });  // mid-flight
//   for (const w of boxes.words) renderCaptionWord(ctx, w);  // landed: identical to the burned-in word
// Check against a real export: npx tsx launch/rough/caption-boxes-check.mts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";
import { captionFrame, captionSampleTimes, drawCaptionWord, type CaptionPage, type CaptionWordFrame, type Ctx2D } from "../../src/core/shared/captions.ts";
import { hookSampleTimes } from "../../src/core/shared/hook.ts";
import { buildPlan } from "../../src/core/shared/plan.ts";
import { chunkRanges } from "../../src/core/render.ts";
import { registerProjectFonts } from "../../src/core/fonts.ts";
import type { ProjectStore } from "../../src/core/project.ts";
import { DEFAULT_CAPTIONS, DEFAULT_HOOK, PROJECT_FILE, type CaptionStyle, type Project, type Transcript } from "../../src/core/shared/types.ts";

export type Box = { x: number; y: number; width: number; height: number };
type Transcripts = Record<string, Transcript | undefined>;
/** The style fields drawCaptionWord reads, carried by every word so a word (or a copy, or JSON) can draw itself. */
export type CaptionPaint = Pick<CaptionStyle, "strokeWidth" | "strokeColor" | "glow" | "highlightStyle" | "highlightColor" | "boxColor">;

export interface CaptionWordBox {
  /** Index in page.words, and the line (0 = top) the word sits on. */
  i: number;
  line: number;
  /** Transcript text, and the text as drawn (uppercased for presets like pop). */
  text: string;
  displayText: string;
  /** Timeline seconds the word is spoken. */
  start: number;
  end: number;
  /** Ink box of the glyph fill as drawn at that time (animation scale included), output px. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The ink box grown by the stroke (half its line width each side). */
  outer: Box;
  /** Anchor: centre of the word's advance box on the line's middle. Words scale around it. */
  cx: number;
  cy: number;
  /** The anchor relative to the ink box's top-left (cx - x, cy - y): how renderCaptionWord places the word from x, y. */
  ax: number;
  ay: number;
  /** Advance width at fontSize (before scale), and the animation scale at that time. */
  advance: number;
  scale: number;
  /** Layout font size in px (drawn size = fontSize × scale), and the CSS font it is drawn with. */
  fontSize: number;
  font: string;
  fontFamily: string;
  fontWeight: number;
  /** Fill as drawn: highlight colour for the spoken word, emphasis colour, or the caption colour. */
  color: string;
  strokeColor: string | null;
  /** Stroke line width in px at fontSize. */
  strokeWidth: number;
  alpha: number;
  isActive: boolean;
  paint: CaptionPaint;
}

export interface CaptionBoxes {
  /** The caption page on screen, or null between pages. */
  page: CaptionPage | null;
  /** Caption-clock time the page is drawn at (the export's sample on screen, or timelineTime if exact). */
  sampleTime: number | null;
  style: CaptionStyle;
  width: number;
  height: number;
  words: CaptionWordBox[];
}

let measurer: Ctx2D | null = null;
const measureCtx = () => (measurer ??= createCanvas(4, 4).getContext("2d") as unknown as Ctx2D);

// Ink extents of `text` drawn from the text origin (left end, middle baseline), in unscaled px.
// Rasterised at 4× and cut at half coverage, i.e. where the drawn outline is. @napi-rs/canvas's
// actualBoundingBox* can't be used: it ignores kerning, so "HEY," or "AT" end ~6-8 px early.
const INK_SS = 4;
const inks = new Map<string, { l: number; r: number; t: number; b: number }>();
function inkOf(font: string, size: number, text: string) {
  const key = `${font}|${text}`;
  const hit = inks.get(key);
  if (hit) return hit;
  const m = measureCtx();
  m.font = font;
  const adv = m.measureText(text).width;
  const ox = size, oy = 1.5 * size;
  const cw = Math.ceil((adv + 2 * ox) * INK_SS), ch = Math.ceil(2 * oy * INK_SS);
  const c = createCanvas(cw, ch);
  const x = c.getContext("2d");
  x.scale(INK_SS, INK_SS);
  x.font = font;
  x.textBaseline = "middle";
  x.textAlign = "left";
  x.fillStyle = "#fff";
  x.fillText(text, ox, oy);
  const a = x.getImageData(0, 0, cw, ch).data;
  let x0 = cw, x1 = -1, y0 = ch, y1 = -1;
  for (let py = 0; py < ch; py++)
    for (let px = 0, i = py * cw * 4 + 3; px < cw; px++, i += 4)
      if (a[i] >= 128) {
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py < y0) y0 = py;
        y1 = py;
      }
  // Whitespace has no ink: fall back to the advance box.
  const ink = x1 < 0 ? { l: 0, r: adv, t: -size / 2, b: size / 2 } : { l: x0 / INK_SS - ox, r: (x1 + 1) / INK_SS - ox, t: y0 / INK_SS - oy, b: (y1 + 1) / INK_SS - oy };
  inks.set(key, ink);
  return ink;
}

// ---------------------------------------------------------------- the export's caption clock
/** One caption PNG: its start as the concat demuxer stamps it (seconds), and what it draws (page at caption time t). */
export type CaptionEntry = { pts: number; t: number; page: CaptionPage | null };
type Entry = CaptionEntry;
type Stream = { from: number; to: number; entries: Entry[] };
const clocks = new WeakMap<Project, { transcripts: Transcripts; style: CaptionStyle; streams: Stream[] }>();

/** Fill fields added in later project versions, as ProjectStore.load() does. */
function normalize(project: Project): Project {
  return { ...project, captions: { ...DEFAULT_CAPTIONS, ...project.captions }, hook: { ...DEFAULT_HOOK, ...project.hook }, overlays: project.overlays ?? [], zooms: project.zooms ?? [] };
}

/**
 * The caption PNG list render.ts writes for one graph (renderTextStream: same sample times, same
 * page lookup, same skip of near-duplicate times). Each entry's start is stamped as ffmpeg's concat
 * demuxer does: running sum of the 4-decimal durations in µs, rounded to its 1/25 s time base.
 */
function textStream(pages: CaptionPage[], style: CaptionStyle, hook: Project["hook"] | null, duration: number, fps: number): Entry[] {
  const times = new Set<number>([0]);
  for (const page of pages) {
    for (const x of captionSampleTimes(page, style, fps)) times.add(x);
    times.add(page.end);
  }
  if (hook) for (const x of hookSampleTimes(hook, fps)) times.add(x);
  const sorted = [...times].filter((x) => x >= 0 && x < duration).sort((a, b) => a - b);
  const out: Entry[] = [];
  let us = 0;
  let pi = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const next = i + 1 < sorted.length ? sorted[i + 1] : duration + 1;
    if (next - t < 0.0005) continue;
    while (pi < pages.length && pages[pi].end <= t) pi++;
    const page = pages[pi] && t >= pages[pi].start && t < pages[pi].end ? pages[pi] : null;
    out.push({ pts: Math.round(us / 40000) * 0.04, t, page });
    us += Math.round(Number((next - t).toFixed(4)) * 1e6);
  }
  return out;
}

/** Caption streams of an export: one, or one per slice when render.ts splits a long timeline. */
function exportClock(project: Project, transcripts: Transcripts): Stream[] {
  const hit = clocks.get(project);
  if (hit && hit.transcripts === transcripts && hit.style === project.captions) return hit.streams;
  const p = normalize(project);
  const fps = p.settings.fps;
  const plan = buildPlan(p, transcripts);
  const chunks = chunkRanges(plan, fps);
  const streams: Stream[] = chunks.length
    ? chunks.map((r) => {
        // As renderChunked: pages keep their real times relative to the slice; the hook is clipped to it.
        const pages = plan.captions
          .filter((pg) => pg.end > r.start && pg.start < r.end)
          .map((pg) => ({ start: pg.start - r.start, end: pg.end - r.start, words: pg.words.map((w) => ({ ...w, start: w.start - r.start, end: w.end - r.start })) }));
        const hook = buildPlan(p, transcripts, r).hook;
        return { from: r.start, to: r.end, entries: textStream(pages, p.captions, hook, r.end - r.start, fps) };
      })
    : [{ from: 0, to: plan.duration, entries: textStream(plan.captions, p.captions, plan.hook, plan.duration, fps) }];
  clocks.set(project, { transcripts, style: project.captions, streams });
  return streams;
}

/** The caption PNGs of an export, per graph (one, or one per slice of a long timeline; `from` in timeline seconds). */
export function exportCaptionEntries(project: Project, transcripts: Transcripts): { from: number; to: number; entries: CaptionEntry[] }[] {
  return exportClock(project, transcripts);
}

/** The caption page and caption-clock time the export shows in the frame containing timeline time `tl`. */
export function exportCaptionState(project: Project, transcripts: Transcripts, tl: number): { page: CaptionPage | null; t: number | null; frame: number } {
  const fps = project.settings.fps;
  const frame = Math.floor(tl * fps + 1e-6);
  const streams = exportClock(project, transcripts);
  const s = streams.find((x) => frame >= Math.round(x.from * fps) && frame < Math.round(x.to * fps)) ?? streams[streams.length - 1];
  const ft = (frame - Math.round(s.from * fps)) / fps;
  // Last PNG stamped before the frame, unless some are stamped on it: then the first of those.
  let lo = -1;
  for (let i = 0; i < s.entries.length && s.entries[i].pts <= ft + 1e-6; i++) {
    const tied = Math.abs(s.entries[i].pts - ft) <= 1e-6;
    if (!tied || lo < 0 || Math.abs(s.entries[lo].pts - ft) > 1e-6) lo = i;
  }
  if (lo < 0) return { page: null, t: null, frame };
  const e = s.entries[lo];
  if (!e.page) return { page: null, t: null, frame };
  // Back on the timeline clock (slice-relative pages are shifted back).
  const off = s.from;
  return { page: off ? { start: e.page.start + off, end: e.page.end + off, words: e.page.words.map((w) => ({ ...w, start: w.start + off, end: w.end + off })) } : e.page, t: e.t + off, frame };
}

// ---------------------------------------------------------------- boxes
/**
 * Boxes of every caption word on screen at timeline time `timelineTime`, in output pixels of an
 * outW×outH export (e.g. 1080×1920 for 9:16). Same layout as the burned-in captions: font size
 * round(fontSize·outH), greedy wrap at 86% width, words centred per line, animation scale.
 * Register project fonts first (registerCaptionFonts) if the project has a fonts/ folder.
 */
export function captionWordBoxes(project: Project, transcripts: Transcripts, timelineTime: number, outW: number, outH: number, opts: { exact?: boolean } = {}): CaptionBoxes {
  const style: CaptionStyle = { ...DEFAULT_CAPTIONS, ...project.captions };
  const empty: CaptionBoxes = { page: null, sampleTime: null, style, width: outW, height: outH, words: [] };
  if (!style.enabled) return empty;
  let page: CaptionPage | null;
  let t: number | null;
  if (opts.exact) {
    page = buildPlan(normalize(project), transcripts).captions.find((pg) => timelineTime >= pg.start && timelineTime < pg.end) ?? null;
    t = page ? timelineTime : null;
  } else ({ page, t } = exportCaptionState(project, transcripts, timelineTime));
  if (!page || t === null) return empty;

  const ctx = measureCtx();
  const f = captionFrame(ctx, outW, outH, page, style, t);
  const { size, font, lines } = f.layout;
  const lineOf = new Map<number, number>();
  lines.forEach((l, n) => l.idx.forEach((i) => lineOf.set(i, n)));
  const pad = style.strokeWidth > 0 ? (size * style.strokeWidth) / 2 : 0;
  const paint: CaptionPaint = { strokeWidth: style.strokeWidth, strokeColor: style.strokeColor, glow: style.glow, highlightStyle: style.highlightStyle, highlightColor: style.highlightColor, boxColor: style.boxColor };
  const words = f.words.map((fw): CaptionWordBox => {
    // Ink relative to the anchor, placed and scaled as drawCaptionWord draws it (text starts at -width/2).
    const ink = inkOf(font, size, fw.text);
    const s = fw.scale;
    const x0 = fw.cx + s * (-fw.width / 2 + ink.l);
    const x1 = fw.cx + s * (-fw.width / 2 + ink.r);
    const y0 = fw.cy + s * ink.t;
    const y1 = fw.cy + s * ink.b;
    const src = page!.words[fw.i];
    return {
      i: fw.i,
      line: lineOf.get(fw.i) ?? 0,
      text: src.text,
      displayText: fw.text,
      start: src.start,
      end: src.end,
      x: x0,
      y: y0,
      w: x1 - x0,
      h: y1 - y0,
      outer: { x: x0 - pad * s, y: y0 - pad * s, width: x1 - x0 + 2 * pad * s, height: y1 - y0 + 2 * pad * s },
      cx: fw.cx,
      cy: fw.cy,
      ax: fw.cx - x0,
      ay: fw.cy - y0,
      advance: fw.width,
      scale: s,
      fontSize: size,
      font,
      fontFamily: style.fontFamily,
      fontWeight: style.fontWeight,
      color: fw.fill,
      strokeColor: style.strokeWidth > 0 ? style.strokeColor : null,
      strokeWidth: pad * 2,
      alpha: fw.alpha,
      isActive: fw.isActive,
      paint,
    };
  });
  return { page, sampleTime: t, style, width: outW, height: outH, words };
}

export interface RenderWordOptions {
  /** Ink box top-left to draw at, in the ctx's current space. Default: the word's x, y. */
  x?: number;
  y?: number;
  /** Or place by the anchor (centre of the advance box on the line's middle) instead. */
  anchor?: { x: number; y: number };
  /** Drawn font size in px; the word grows from its box's top-left. Default: fontSize × scale, as exported. */
  fontSize?: number;
  /** Fill override (e.g. the transcript grey on the way in). */
  color?: string;
  /** Alpha override (multiplied by ctx.globalAlpha either way). */
  alpha?: number;
  /** Text override (e.g. the transcript's case before the uppercase switch), centred on the same anchor. */
  text?: string;
  /** Highlight treatment on or off (box / underline / scale styles). Default: the word's. */
  active?: boolean;
  /** Multiplies the stroke width: 0 = no stroke, 1 = as exported. */
  strokeScale?: number;
}

/**
 * Draw one caption word the way the export does (same font, stroke, fill, glow and highlight,
 * drawn by cutroom's drawCaptionWord), with its ink box's top-left at word.x, word.y. Unchanged
 * and under an identity transform it lands pixel-identical on the burned-in word; move it by
 * changing x, y (on a copy, or via opts) and resize it with opts.fontSize.
 */
export function renderCaptionWord(ctx: SKRSContext2D | Ctx2D, word: CaptionWordBox, opts: RenderWordOptions = {}): void {
  const c = ctx as unknown as Ctx2D;
  const k = opts.strokeScale ?? 1;
  const style: CaptionStyle = { ...DEFAULT_CAPTIONS, ...word.paint, strokeWidth: word.paint.strokeWidth * k };
  const scale = (opts.fontSize ?? word.fontSize * word.scale) / word.fontSize;
  const grow = scale / word.scale;
  const text = opts.text ?? word.displayText;
  c.save();
  c.font = word.font;
  c.textBaseline = "middle";
  c.textAlign = "left";
  c.lineJoin = "round";
  const frame: CaptionWordFrame = {
    i: word.i,
    text,
    width: text === word.displayText ? word.advance : c.measureText(text).width,
    cx: opts.anchor?.x ?? (opts.x ?? word.x) + word.ax * grow,
    cy: opts.anchor?.y ?? (opts.y ?? word.y) + word.ay * grow,
    scale,
    alpha: (opts.alpha ?? word.alpha) * c.globalAlpha,
    isActive: opts.active ?? word.isActive,
    fill: opts.color ?? word.color,
  };
  drawCaptionWord(c, frame, word.fontSize, style);
  c.restore();
}

/** Every word of `boxes`, drawn as the export draws them (captions without a page background). */
export function renderCaptionWords(ctx: SKRSContext2D | Ctx2D, boxes: CaptionBoxes): void {
  for (const w of boxes.words) renderCaptionWord(ctx, w);
}

/** Map a box from an outW×outH export frame onto `dest`, where that frame is drawn (e.g. the 9:16 column). */
export function mapBox(b: { x: number; y: number; w: number; h: number }, outW: number, outH: number, dest: Box): Box {
  const sx = dest.width / outW;
  const sy = dest.height / outH;
  return { x: dest.x + b.x * sx, y: dest.y + b.y * sy, width: b.w * sx, height: b.h * sy };
}

// ---------------------------------------------------------------- loading
/**
 * Project and transcripts from a project folder, read-only (no ProjectStore, no writes). `snapshot`
 * swaps in another cutroom.json (e.g. launch/out/rough/snapshots/v4.json) over the same transcripts.
 */
export function loadCaptionProject(dir: string, snapshot?: string): { project: Project; transcripts: Transcripts } {
  const project = normalize(JSON.parse(readFileSync(snapshot ?? join(dir, PROJECT_FILE), "utf8")) as Project);
  const transcripts: Transcripts = {};
  for (const m of project.media) {
    const file = join(dir, ".cutroom", "cache", m.id, "transcript.json");
    if (existsSync(file)) transcripts[m.id] = JSON.parse(readFileSync(file, "utf8")) as Transcript;
  }
  return { project, transcripts };
}

/** Register the project's fonts/ folder the way render.ts does, so custom caption fonts measure the same. */
export async function registerCaptionFonts(dir: string): Promise<void> {
  await registerProjectFonts({ dir } as ProjectStore);
}
