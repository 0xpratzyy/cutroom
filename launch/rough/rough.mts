// "Rough Cut": the launch film Claude edits while you watch. The film opens as its own rough
// cut; a cursor points at what's wrong on the picture; Claude, connected over MCP, edits the
// film you're watching (cuts the false start, turns the box into a 9:16 Short, grades and
// captions it); then the camera pulls back to the real cutroom project and the film ends
// inside a live wait_for_feedback call.
//
// Every picture state is a genuine cutroom export of a real Claude session (states.mts); the
// MCP log lines are the real calls (mcp-log.jsonl), time-compressed only on frozen frames; the
// transitions between states (fold, bloom, caption lift, rewind) are composited here.
//
// Usage: npx tsx launch/rough/rough.mts [--cues] [--only=1.2,14] -> launch/out/rough/film-video.mp4
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts, loadImage, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { computeCrop } from "../../src/core/shared/timeline.ts";
import { bindPremium, clamp, CORAL, expo, INK, line, stage } from "../premium.mts";

const OUT = "launch/out/rough";
const W = 1920, H = 1080, FPS = 60, INNER_FPS = 24;
const LIME = "#e8f47c", BONE = "#f4f2ef", GREY = "#8d8983";
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNS.ttf", "SF");
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNSMono.ttf", "SFMono");
GlobalFonts.registerFromPath("node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "Inter");

// ---------------------------------------------------------------- data
type Box = { x: number; y: number; width: number; height: number };
type Word = { text: string; start: number; end: number; i: number };
const cap = JSON.parse(readFileSync(join(OUT, "capture/frames.json"), "utf8")) as { frames: { file: string; t: number }[]; events: { name: string; t: number }[]; rects: Record<string, Box> };
const t0 = cap.events.find((e) => e.name === "start")!.t;
const ev = Object.fromEntries(cap.events.map((e) => [e.name, e.t - t0])) as Record<string, number>;
const rects = cap.rects;
const capTimes = cap.frames.map((f) => f.t - t0);
function capFile(c: number) {
  let lo = 0, hi = capTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (capTimes[mid] <= c) lo = mid;
    else hi = mid - 1;
  }
  return join(OUT, "capture", cap.frames[lo].file);
}
const statesWords = JSON.parse(readFileSync(join(OUT, "states/words.json"), "utf8")) as Record<string, Word[]> & { duration: Record<string, number> };
const snap = (v: string) => JSON.parse(readFileSync(join(OUT, `snapshots/${v}.json`), "utf8"));
const v3snap = snap("v3");
const feedback = (() => {
  const f = join(OUT, "project/.cutroom/feedback.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).items as { n: number; note: string; region?: { x: number; y: number; w: number; h: number } | null; replies?: { author: string; text: string }[] }[]) : [];
})();

// The MCP conversation: every tools/call with its result, in order.
type Call = { t: number; tRes: number; name: string; args: Record<string, unknown>; result: { content?: { type: string; text?: string; data?: string }[] } };
const calls: Call[] = (() => {
  const f = join(OUT, "mcp-log.jsonl");
  if (!existsSync(f)) return [];
  const reqs = new Map<unknown, { t: number; name: string; args: Record<string, unknown> }>();
  const out: Call[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const o = JSON.parse(l) as { t: number; dir: string; msg: { id?: unknown; method?: string; params?: { name: string; arguments?: Record<string, unknown> }; result?: Call["result"] } };
    if (o.dir === "req" && o.msg.method === "tools/call") reqs.set(o.msg.id, { t: o.t - t0, name: o.msg.params!.name, args: o.msg.params!.arguments ?? {} });
    else if (o.dir === "res" && reqs.has(o.msg.id)) {
      const r = reqs.get(o.msg.id)!;
      out.push({ ...r, tRes: o.t - t0, result: o.msg.result ?? {} });
    }
  }
  return out.sort((a, b) => a.t - b.t);
})();
const short = (v: unknown) => (typeof v === "number" ? String(Math.round(v * 100) / 100) : typeof v === "string" ? `"${v}"` : JSON.stringify(v));
function opText(op: Record<string, unknown>) {
  const { op: name, ...rest } = op;
  if (name === "remove_words") return `remove_words ${rest.from}–${rest.to}`;
  const keys = Object.keys(rest).filter((k) => k !== "mediaId");
  const body = keys.slice(0, 3).map((k) => `${k}: ${short(rest[k])}`).join(", ");
  const s = `${name} { ${body}${keys.length > 3 ? ", …" : ""} }`;
  return s.length > 44 ? `${s.slice(0, 42)}… }` : s;
}
/** What Claude did for note n: the wait that delivered it (with its frame), the edit ops and the reply. */
function noteStory(n: number) {
  const note = feedback.find((f) => f.n === n);
  const wait = calls.find((c) => c.name === "wait_for_feedback" && (c.result.content ?? []).some((x) => x.text?.includes(`#${n}`)));
  let thumb: string | undefined;
  if (wait?.result.content) {
    const items = wait.result.content;
    const k = items.findIndex((x) => x.text?.startsWith(`Frame for #${n}`));
    if (k >= 0 && items[k + 1]?.data) thumb = items[k + 1].data;
  }
  const resolved = calls.find((c) => c.name === "update_feedback" && String(c.args.id) === String(n) && c.args.status === "resolved") ?? calls.find((c) => c.name === "update_feedback" && c.args.status === "resolved" && String(c.args.id).includes(String(n)));
  const working = calls.find((c) => c.name === "update_feedback" && c.args.status === "working" && (String(c.args.id) === String(n)));
  const edits = calls.filter((c) => c.name === "edit" && (!working || c.t >= working.t - 0.01) && (!resolved || c.t <= resolved.t));
  const ops = edits.flatMap((c) => ((c.args.ops as Record<string, unknown>[]) ?? []).map(opText));
  const reply = (resolved?.args.reply as string) ?? note?.replies?.find((r) => r.author === "agent")?.text ?? "";
  return { n, note: note?.note ?? "", region: note?.region ?? null, thumb, ops: ops.length ? ops : ["edit"], reply };
}
const story = [1, 2, 3].map(noteStory);

// ---------------------------------------------------------------- inner film (genuine exports)
function decode(state: string, size: string) {
  const d = join(OUT, "frames", state);
  if (!existsSync(d) || readdirSync(d).length < 5) {
    mkdirSync(d, { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(OUT, "states", `${state}.mp4`), "-vf", `fps=${INNER_FPS},scale=${size}:flags=lanczos`, "-q:v", "2", join(d, "%05d.jpg")]);
  }
  const n = readdirSync(d).length;
  return (tl: number) => join(d, `${String(Math.min(n - 1, Math.max(0, Math.floor(tl * INNER_FPS + 1e-6))) + 1).padStart(5, "0")}.jpg`);
}
const inner = { v1: decode("v1", "1920:1080"), v2: decode("v2", "1920:1080"), v3: decode("v3", "1080:1920"), v4b: decode("v4b", "1080:1920"), v4: decode("v4", "1080:1920") };
const dur = statesWords.duration;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z']/g, "");
const wordsOf = (v: string) => (statesWords[v] ?? []) as Word[];
const V1 = wordsOf("v1"), V2 = wordsOf("v2"), V3 = wordsOf("v3"), V4 = wordsOf("v4");
// The false start is whatever note 1 removed: v1 words that are gone in v2.
const keptIdx = new Set(V2.map((w) => w.i));
const cutIdx = new Set(V1.filter((w) => !keptIdx.has(w.i)).map((w) => w.i));
const firstKept = V1.findIndex((w) => keptIdx.has(w.i));
// Freeze points, always at word ends.
const TL1 = firstKept > 0 ? (V1[firstKept - 1].end + V1[firstKept].start) / 2 : 2.4; // end of the stammer
const iCutroom = V2.findIndex((w) => /cutroom|room/.test(norm(w.text)));
const TL2 = iCutroom >= 0 ? V2[iCutroom].end + 0.08 : 2.2;
const iClaude = V3.findIndex((w) => norm(w.text) === "claude");
const TL3 = iClaude >= 0 ? V3[iClaude].end + 0.04 : TL2 + 2.1;
const V4DUR = dur.v4 ?? 6;
const iFixes = V4.findIndex((w) => norm(w.text) === "fixes");

// ---------------------------------------------------------------- timeline (beat sheet, adapted to the take)
const D2 = Math.max(1.6, TL2) - 2.2; // pass 2 longer/shorter than planned
const D3 = D2 + (Math.max(1.4, TL3 - TL2) - 2.15);
const D4 = D3 + (V4DUR - 5.8);
const T = {
  poster: 0, noteOpen: 0.55, noteSend: 1.35,
  turn1: 1.4, wait1: 1.45, working1: 1.95, edit1: 2.75, strike1: 3.15, fold1: 3.35, resolved1: 3.8,
  rewind: 4.2, pass2: 4.9, claude: 5.4, claude2: 6.0,
  freeze2: 4.9 + Math.max(1.6, TL2), copyLeave: 8.2 + D2,
  box: 8.4 + D2, boxDown: 9.05 + D2, boxUp: 9.8 + D2, note2Open: 10.0 + D2, note2Send: 11.0 + D2,
  wait2: 11.1 + D2, working2: 11.7 + D2, edit2: 12.9 + D2,
  fold: 13.3 + D2, glide: 13.95 + D2, glideEnd: 15.25 + D2, resolved2: 15.3 + D2, pass3: 15.4 + D2,
  cursorUp: 17.3 + D3, cmdK: 17.55 + D3, palette: 17.6 + D3, askSend: 19.4 + D3, cursorOut: 19.55 + D3,
  wait3: 19.7 + D3, working3: 20.3 + D3, edit3a: 21.0 + D3, edit3b: 21.6 + D3, still: 22.0 + D3, bloom: 22.5 + D3, liftEnd: 23.6 + D3, resolved3: 24.0 + D3,
  snap: 24.6 + D3, final: 24.95 + D3, finalEnd: 24.95 + D3 + V4DUR,
  reveal: 25.2 + D4 + 0.0, // set below
  review: 0, end: 0, filmEnd: 0,
};
T.reveal = T.finalEnd + 0.25;
T.review = T.reveal + 5;
const reviewLen = Math.max(3.2, (ev["after-click"] ?? 0) + 1.5 - ((ev["before-click"] ?? 0) - 0.4));
T.end = T.review + reviewLen + 0.1;
T.filmEnd = T.end + 6.5;
const DUR = T.filmEnd;
void D4;

// ---------------------------------------------------------------- canvas + helpers
const canvas = createCanvas(W, H);
const x = canvas.getContext("2d") as SKRSContext2D;
const icon = await loadImage("assets/brand/icon-1024.png");
bindPremium(x, { sans: "SF", mono: "SFMono", icon });
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * clamp(u) + 2, 3) / 2);
const prog = (t: number, a: number, d: number) => clamp((t - a) / d);
const spacing = (px: number) => ((x as unknown as { letterSpacing: string }).letterSpacing = `${px}px`);
const imgCache = new Map<string, Image>();
async function img(path: string) {
  let i = imgCache.get(path);
  if (!i) {
    i = await loadImage(readFileSync(path));
    if (imgCache.size > 24) imgCache.delete(imgCache.keys().next().value!);
    imgCache.set(path, i);
  }
  return i;
}
const thumbs = await Promise.all(story.map(async (s) => (s.thumb ? loadImage(Buffer.from(s.thumb, "base64")) : null)));
function rrect(px: number, py: number, w: number, h: number, r: number) {
  x.beginPath();
  x.roundRect(px, py, w, h, r);
}
function cursor(px: number, py: number, s = 1.4, alpha = 1) {
  if (alpha <= 0) return;
  x.save();
  x.globalAlpha = alpha;
  x.translate(px, py);
  x.scale(s, s);
  x.shadowColor = "rgba(0,0,0,0.45)";
  x.shadowBlur = 8;
  x.shadowOffsetY = 2;
  x.beginPath();
  x.moveTo(0, 0); x.lineTo(0, 19); x.lineTo(5, 14.5); x.lineTo(8.5, 22); x.lineTo(11.6, 20.6); x.lineTo(8.2, 13.3); x.lineTo(15, 13.3); x.closePath();
  x.fillStyle = "#fff";
  x.fill();
  x.shadowColor = "transparent";
  x.lineWidth = 1.2;
  x.strokeStyle = "#111";
  x.lineJoin = "round";
  x.stroke();
  x.restore();
}
/** A cutroom note pin: coral while open/working (with a turning ring), lime once resolved. */
function pin(px: number, py: number, n: number, t: number, o: { working?: [number, number]; resolvedAt?: number; alpha?: number; scale?: number }) {
  const a = o.alpha ?? 1;
  if (a <= 0) return;
  const done = o.resolvedAt !== undefined && t >= o.resolvedAt;
  const s = o.scale ?? 1;
  x.save();
  x.globalAlpha = a;
  x.translate(px, py);
  x.scale(s, s);
  if (o.working && t >= o.working[0] && !done) {
    const ang = (t - o.working[0]) * 0.6 * Math.PI * 2;
    x.strokeStyle = CORAL;
    x.lineWidth = 2.5;
    x.beginPath();
    x.arc(0, 0, 21, ang, ang + Math.PI * 1.3);
    x.stroke();
  }
  if (done) {
    const p = prog(t, o.resolvedAt!, 0.6);
    if (p < 1) {
      x.strokeStyle = `rgba(232,244,124,${0.9 * (1 - p)})`;
      x.lineWidth = 2;
      x.beginPath();
      x.arc(0, 0, 14 + p * 14, 0, Math.PI * 2);
      x.stroke();
    }
  }
  x.beginPath();
  x.arc(0, 0, 14, 0, Math.PI * 2);
  x.fillStyle = done ? LIME : CORAL;
  x.fill();
  x.fillStyle = done ? "#141210" : "#fff";
  x.font = "700 15px Inter";
  const label = String(n);
  x.fillText(label, -x.measureText(label).width / 2, 5.5);
  x.restore();
}
/** Claude's reply, unsigned until the film names it: a pill with a lime dot. */
function chip(px: number, py: number, text: string, t: number, at: number, alpha = 1) {
  const u = expo(prog(t, at, 0.5)) * alpha;
  if (u <= 0 || !text) return;
  x.save();
  x.globalAlpha = u;
  x.font = "500 26px Inter";
  const w = x.measureText(text).width + 62;
  const yy = py + (1 - u) * 8;
  rrect(px, yy, w, 50, 25);
  x.fillStyle = "rgba(20,18,16,0.88)";
  x.fill();
  x.strokeStyle = "rgba(255,255,255,0.10)";
  x.lineWidth = 1;
  x.stroke();
  x.fillStyle = LIME;
  x.beginPath();
  x.arc(px + 24, yy + 25, 6, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "rgba(255,255,255,0.88)";
  x.fillText(text, px + 42, yy + 34);
  x.restore();
}
function mono(size: number, weight = 500) {
  x.font = `${weight} ${size}px SFMono`;
}
const fmtTC = (s: number) => {
  const f = Math.floor((s % 1) * 24);
  const total = Math.floor(s);
  return `00:00:${String(total).padStart(2, "0")}:${String(f).padStart(2, "0")}`;
};
const fmtDur = (s: number) => `0:${(Math.round(s * 10) / 10).toFixed(1).padStart(4, "0")}`;

// ---------------------------------------------------------------- the transcript line
/** Lay words out on one centred line; returns per-word boxes (x, width) in film px. */
function layoutLine(words: Word[], size: number, cx: number, collapse?: { idx: Set<number>; u: number }) {
  mono(size);
  spacing(0);
  const space = x.measureText(" ").width;
  const items = words.map((w) => ({ w, width: x.measureText(w.text).width }));
  const widthOf = (it: (typeof items)[number]) => (collapse?.idx.has(it.w.i) ? it.width * (1 - collapse.u) : it.width);
  const gapOf = (it: (typeof items)[number]) => (collapse?.idx.has(it.w.i) ? space * (1 - collapse.u) : space);
  const total = items.reduce((a, it) => a + widthOf(it) + gapOf(it), 0) - space;
  let px = cx - total / 2;
  return items.map((it) => {
    const box = { w: it.w, x: px, width: it.width, shown: widthOf(it) };
    px += widthOf(it) + gapOf(it);
    return box;
  });
}
function drawLine(boxes: ReturnType<typeof layoutLine>, y: number, size: number, tl: number, o: { alpha?: number; strike?: { idx: Set<number>; u: number }; fade?: { idx: Set<number>; u: number }; select?: { idx: Set<number>; u: number } } = {}) {
  const a = o.alpha ?? 1;
  if (a <= 0) return;
  mono(size);
  x.save();
  x.globalAlpha = a;
  // selection behind the words
  if (o.select && o.select.u > 0) {
    const sel = boxes.filter((b) => o.select!.idx.has(b.w.i));
    if (sel.length) {
      const x0 = sel[0].x - 8, x1 = sel[sel.length - 1].x + sel[sel.length - 1].width + 8;
      x.fillStyle = "rgba(255,95,79,0.35)";
      rrect(x0, y - size * 0.95, (x1 - x0) * o.select.u, size * 1.3, 4);
      x.fill();
    }
  }
  for (const b of boxes) {
    const fading = o.fade?.idx.has(b.w.i) ? o.fade.u : 0;
    if (fading >= 1) continue;
    x.save();
    x.globalAlpha = a * (1 - fading);
    if (fading > 0.02) x.filter = `blur(${(fading * 6).toFixed(1)}px)`;
    x.fillStyle = b.w.start <= tl ? BONE : GREY;
    if (fading > 0 && b.shown < b.width) {
      x.beginPath();
      x.rect(b.x, y - size * 1.1, b.shown, size * 1.5);
      x.clip();
    }
    x.fillText(b.w.text, b.x, y);
    x.restore();
    if (o.strike?.idx.has(b.w.i) && o.strike.u > 0 && fading < 1) {
      x.fillStyle = CORAL;
      x.globalAlpha = a * (1 - fading);
      x.fillRect(b.x, y - size * 0.32, b.shown * clamp(o.strike.u * 1.05), 3);
      x.globalAlpha = a;
    }
  }
  x.restore();
}

// ---------------------------------------------------------------- HUD
function hud(t: number, o: { version: string; aspect: string; durS: number; tl: number; paused: boolean; alpha?: number; frame?: Box; flashDur?: number; flashAspect?: number; final?: boolean }) {
  const a = o.alpha ?? 1;
  if (a <= 0) return;
  const f = o.frame ?? { x: 0, y: 0, width: W, height: H };
  x.save();
  x.globalAlpha = a * 0.6;
  mono(24);
  spacing(2);
  x.shadowColor = "rgba(0,0,0,0.6)";
  x.shadowBlur = 6;
  const parts = o.final ? ["LAUNCH FILM · FINAL"] : ["LAUNCH FILM · ROUGH CUT ", o.version, " · ", o.aspect, " · ", fmtDur(o.durS)];
  let px = f.x + 40, py = f.y + 52;
  const column = f.width < W;
  if (column) {
    mono(20);
    spacing(1.5);
    const head = o.final ? "LAUNCH FILM" : "LAUNCH FILM";
    const tail = o.final ? "FINAL" : `ROUGH CUT ${o.version} · ${o.aspect} · ${fmtDur(o.durS)}`;
    x.fillStyle = "#fff";
    x.globalAlpha = a * 0.45;
    x.fillText(head, f.x - 28 - x.measureText(head).width, f.y + 22);
    const flash = o.flashAspect !== undefined && t >= o.flashAspect && t < o.flashAspect + 0.4;
    x.globalAlpha = a * (flash ? 1 : 0.6);
    x.fillStyle = flash ? LIME : "#fff";
    x.fillText(tail, f.x - 28 - x.measureText(tail).width, f.y + 50);
    if (!o.final) {
      const tc = `${o.paused ? "❚❚  " : ""}${fmtTC(o.tl)}`;
      x.globalAlpha = a * 0.6;
      x.fillStyle = "#fff";
      x.fillText(tc, f.x + f.width + 28, f.y + 22);
    }
    spacing(0);
    x.restore();
    return;
  }
  for (const [k, p] of parts.entries()) {
    const flash = (k === 3 && o.flashAspect !== undefined && t >= o.flashAspect && t < o.flashAspect + 0.4) || (k === 5 && o.flashDur !== undefined && t >= o.flashDur && t < o.flashDur + 0.4);
    x.fillStyle = flash ? LIME : "#fff";
    x.globalAlpha = a * (flash ? 1 : 0.6);
    x.fillText(p, px, py);
    px += x.measureText(p).width;
  }
  if (!o.final) {
    const tc = `${o.paused ? "❚❚  " : ""}${fmtTC(o.tl)}`;
    x.globalAlpha = a * 0.6;
    x.fillStyle = "#fff";
    const tw = x.measureText(tc).width;
    x.fillText(tc, column ? f.x + f.width + 28 : W - 40 - tw, py);
  }
  spacing(0);
  x.restore();
}
/** Soft darkening on the right two-thirds so Claude's log and the copy read over the picture. */
function scrim(alpha: number) {
  if (alpha <= 0) return;
  const g = x.createLinearGradient(820, 0, W, 0);
  g.addColorStop(0, "rgba(6,6,7,0)");
  g.addColorStop(0.35, `rgba(6,6,7,${0.42 * alpha})`);
  g.addColorStop(1, `rgba(6,6,7,${0.62 * alpha})`);
  x.fillStyle = g;
  x.fillRect(820, 0, W - 820, H);
}

// ---------------------------------------------------------------- Claude's log (cutroom's own typography, real calls)
type LogLine = { at: number; text: string; dim?: boolean; thumb?: Image | null; ok?: boolean; summary?: boolean };
function logLines(t: number): { header: number; lines: LogLine[] } {
  const L: LogLine[] = [];
  const s1 = story[0], s2 = story[1], s3 = story[2];
  const beat2 = t >= T.wait2, beat3 = t >= T.wait3;
  if (!beat2) {
    L.push({ at: T.wait1, text: `→ wait_for_feedback   #1 “${s1.note}”`, thumb: thumbs[0] });
    L.push({ at: T.working1, text: `→ update_feedback   #1 working` });
    s1.ops.slice(0, 1).forEach((o) => L.push({ at: T.edit1, text: `→ edit   ${o}` }));
    L.push({ at: T.resolved1, text: `✓ #1 resolved`, ok: true });
  } else {
    L.push({ at: 0, text: `✓ #1 ${s1.reply || "resolved"}`, summary: true, ok: true });
    if (!beat3) {
      L.push({ at: T.wait2, text: `→ wait_for_feedback   #2 “${s2.note}”`, thumb: thumbs[1] });
      L.push({ at: T.working2, text: `→ update_feedback   #2 working` });
      s2.ops.slice(0, 2).forEach((o, k) => L.push({ at: T.edit2 + k * 0.12, text: `${k ? "        " : "→ edit   "}${o}` }));
      L.push({ at: T.resolved2, text: `✓ #2 resolved`, ok: true });
    } else {
      L.push({ at: 0, text: `✓ #2 ${s2.reply || "resolved"}`, summary: true, ok: true });
      L.push({ at: T.wait3, text: `→ wait_for_feedback   #3 “${s3.note}”`, thumb: thumbs[2] });
      L.push({ at: T.working3, text: `→ update_feedback   #3 working` });
      s3.ops.slice(0, 2).forEach((o, k) => L.push({ at: k ? T.edit3b : T.edit3a, text: `→ edit   ${o}` }));
      L.push({ at: T.resolved3, text: `✓ #3 resolved`, ok: true });
    }
  }
  return { header: T.claude2, lines: L };
}
function drawLog(t: number, alpha: number, still = false) {
  if (alpha <= 0) return;
  const { header, lines } = logLines(t);
  const left = 1080;
  let y = 196;
  x.save();
  x.globalAlpha = alpha;
  // header appears once the agent is named
  const hu = expo(prog(t, header, 0.8));
  if (hu > 0) {
    x.save();
    x.globalAlpha = alpha * hu * 0.5;
    mono(22);
    spacing(1);
    x.fillStyle = "#fff";
    x.fillText("Claude · over MCP", left + 22, y);
    x.fillStyle = LIME;
    x.beginPath();
    x.arc(left + 6, y - 7, 5, 0, Math.PI * 2);
    x.fill();
    spacing(0);
    x.restore();
  }
  y += 56;
  const visible = lines.filter((l) => t >= l.at);
  const recent = visible.slice(-5);
  for (const [k, l] of recent.entries()) {
    const u = l.summary ? 1 : expo(prog(t, l.at, 0.5));
    const older = k < recent.length - 4 || l.summary;
    x.save();
    x.globalAlpha = alpha * u * (older ? 0.32 : 0.92) * (still ? 0.45 : 1);
    if (u < 1) x.filter = `blur(${((1 - u) * 8).toFixed(1)}px)`;
    mono(l.summary ? 22 : 26);
    x.fillStyle = l.ok ? LIME : "#fff";
    const text = l.text.length > 50 ? `${l.text.slice(0, 49)}…”` : l.text;
    x.fillText(text, left, y + (1 - u) * 10);
    if (l.thumb) {
      const tw = 132, th = 74, tx = left + 4, ty = y + 16;
      x.save();
      rrect(tx, ty, tw, th, 6);
      x.clip();
      x.drawImage(l.thumb, tx, ty, tw, th);
      x.restore();
      x.strokeStyle = "rgba(255,255,255,0.18)";
      x.lineWidth = 1;
      rrect(tx, ty, tw, th, 6);
      x.stroke();
      y += th + 18;
    }
    x.restore();
    y += l.summary ? 40 : 50;
  }
  x.restore();
}

// ---------------------------------------------------------------- capture crops (the real composer and palette)
async function capCrop(c: number, r: Box, dx: number, dy: number, scale: number, alpha = 1, unfold = 1) {
  if (alpha <= 0 || !r) return;
  const frame = await img(capFile(c));
  const k = frame.width / 1440;
  x.save();
  x.globalAlpha = alpha;
  const w = r.width * scale, h = r.height * scale;
  x.translate(dx, dy + h / 2);
  x.scale(1, unfold);
  x.translate(0, -h / 2);
  x.shadowColor = "rgba(0,0,0,0.55)";
  x.shadowBlur = 40;
  x.shadowOffsetY = 14;
  rrect(0, 0, w, h, 14 * scale);
  x.fillStyle = "#141210";
  x.fill();
  x.shadowColor = "transparent";
  rrect(0, 0, w, h, 14 * scale);
  x.clip();
  x.drawImage(frame, r.x * k, r.y * k, r.width * k, r.height * k, 0, 0, w, h);
  x.restore();
}

// ---------------------------------------------------------------- the fold geometry (cutroom's real 9:16 crop)
const focus = (v3snap.clips?.[0]?.focus ?? v3snap.focus ?? { x: 0.5, y: 0.5 }) as { x: number; y: number };
const srcW = 1920, srcH = 1080;
const crop = computeCrop(srcW, srcH, 1080, 1920, 1, focus);
const CROP = { x: (crop.x / crop.width) * W, y: 0, width: (1080 / crop.width) * W, height: H };
// While Claude works the Short sits left of centre so its log has room; the final pass centres it.
const COL = { x: 470, y: 100, width: 495, height: 880 };
const COLF = { x: (W - 495) / 2, y: 100, width: 495, height: 880 };
const COLCX = COL.x + COL.width / 2;
const region2 = story[1].region ?? { x: CROP.x / W, y: 0, w: CROP.width / W, h: 1 };
const BOX = { x: region2.x * W, y: region2.y * H, width: region2.w * W, height: region2.h * H };
const lerpBox = (a: Box, b: Box, u: number): Box => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), width: lerp(a.width, b.width, u), height: lerp(a.height, b.height, u) });

// Caption word boxes for the lift (exact positions of the burned-in words in the v4 export).
type CapWord = { text: string; displayText: string; x: number; y: number; w: number; h: number; fontSize: number; fontFamily: string; fontWeight: number | string; color: string; isActive: boolean };
let capWords: CapWord[] = [];
let renderCapWord: ((ctx: SKRSContext2D, w: CapWord, o: Record<string, unknown>) => void) | null = null;
try {
  const mod = await import("./caption-boxes.mts");
  const v4 = snap("v4");
  const transcripts: Record<string, unknown> = {};
  for (const m of v4.media ?? []) {
    const f = join(OUT, "project/.cutroom/cache", m.id, "transcript.json");
    if (existsSync(f)) transcripts[m.id] = JSON.parse(readFileSync(f, "utf8"));
  }
  const res = mod.captionWordBoxes(v4, transcripts, TL3, 1080, 1920);
  capWords = res.words;
  renderCapWord = mod.renderCaptionWord ?? null;
} catch (e) {
  console.warn("caption boxes unavailable:", (e as Error).message);
}

// ---------------------------------------------------------------- scenes
function innerFull(path: string, push = 1) {
  return img(path).then((f) => {
    x.save();
    x.translate(W / 2, H / 2);
    x.scale(push, push);
    x.drawImage(f, -W / 2, -H / 2, W, H);
    x.restore();
  });
}
/** Motion-blurred playback: average k sub-frames of an inner state between tl0 and tl1. */
const acc = createCanvas(W, H), accX = acc.getContext("2d") as SKRSContext2D;
async function blurred(state: keyof typeof inner, tls: number[], dest: Box) {
  accX.clearRect(0, 0, W, H);
  for (let k = 0; k < tls.length; k++) {
    const f = await img(inner[state](tls[k]));
    accX.globalAlpha = 1 / (k + 1);
    accX.drawImage(f, dest.x, dest.y, dest.width, dest.height);
  }
  accX.globalAlpha = 1;
  x.drawImage(acc, 0, 0);
}

// Act 1: the poster, note 1, Claude's first turn, the rewind, pass 2 named.
const SEL = new Set(cutIdx);
const lineV1 = V1.slice(0, Math.max(firstKept + 6, iCutroom >= 0 ? firstKept + iCutroom + 1 : 10));
const lineV2 = V2.slice(0, iCutroom >= 0 ? iCutroom + 1 : 6);
async function act1(t: number) {
  const pushing = t >= T.turn1 && t < T.rewind ? 1 + 0.012 * ((t - T.turn1) / (T.rewind - T.turn1)) : 1;
  if (t < T.rewind) await innerFull(inner.v1(TL1), pushing);
  else if (t < T.pass2) {
    // the only rewind: v1 backward from TL1 to 0, speeding up, with real motion blur
    const u = (t - T.rewind) / (T.pass2 - T.rewind);
    const at = (uu: number) => TL1 * (1 - (Math.pow(uu, 2.2) * 0.85 + uu * 0.15));
    const k = 6, span = 1 / (FPS * (T.pass2 - T.rewind)) * 0.5;
    await blurred("v1", Array.from({ length: k }, (_, i) => at(clamp(u + (i / (k - 1) - 0.5) * span * 6))), { x: 0, y: 0, width: W, height: H });
  } else {
    const tl = Math.min(TL2, t - T.pass2);
    await innerFull(inner.v2(tl), t > T.freeze2 ? 1 + 0.01 * prog(t, T.freeze2, 3) : 1);
    if (t < T.pass2 + 2 / FPS) {
      x.fillStyle = "rgba(0,0,0,0.82)";
      x.fillRect(0, 0, W, H);
    }
  }
  const tlNow = t < T.rewind ? TL1 : t < T.pass2 ? TL1 * (1 - Math.pow((t - T.rewind) / (T.pass2 - T.rewind), 2.2)) : Math.min(TL2, t - T.pass2);
  scrim((t < T.rewind ? expo(prog(t, T.turn1, 0.6)) : 1) * (t >= T.claude - 0.3 && t < T.copyLeave + 0.5 ? 1.45 : 1));
  hud(t, { version: t < T.pass2 - 0.15 ? "v1" : "v2", aspect: "16:9", durS: t < T.pass2 - 0.15 ? dur.v1 : dur.v2, tl: tlNow, paused: t < T.rewind || t > T.freeze2, flashDur: T.pass2 - 0.1 });
  // playhead hairline during the rewind
  if (t >= T.rewind && t < T.pass2) {
    x.fillStyle = LIME;
    x.fillRect(0, H - 3, (tlNow / dur.v1) * W, 2);
  }
  // transcript line
  const y = 1000, size = 40;
  if (t < T.pass2) {
    const foldU = expo(prog(t, T.fold1, 0.4));
    const boxes = layoutLine(lineV1, size, W / 2, { idx: SEL, u: foldU });
    const selU = t < 0.5 ? 0.35 + 0.65 * expo(t / 0.5) : 1;
    drawLine(boxes, y, size, TL1, { select: t < T.strike1 ? { idx: SEL, u: selU } : undefined, strike: { idx: SEL, u: prog(t, T.strike1, 0.2) }, fade: { idx: SEL, u: foldU } });
    // cursor mid-drag at frame 0, then idles right
    const sel = boxes.filter((b) => SEL.has(b.w.i));
    if (sel.length) {
      const sx0 = sel[0].x, sx1 = sel[sel.length - 1].x + sel[sel.length - 1].width;
      const pinX = sx0 - 4, pinY = y - size - 22;
      const cu = t < 0.5 ? lerp(0.35, 1, expo(t / 0.5)) : 1;
      const drift = expo(prog(t, T.turn1, 0.8));
      cursor(lerp(sx0, sx1, cu) + drift * 60, y - 12 + drift * 10, 1.4, t < T.rewind ? 1 : 1 - prog(t, T.rewind, 0.2));
      // the note card: the real composer, unfolding under the selection, typing, then folding into pin 1
      if (t >= T.noteOpen && t < T.noteSend + 0.2) {
        const c = lerp((ev["select-up"] ?? 0) + 0.6, (ev["note1-send"] ?? 0) - 0.02, prog(t, T.noteOpen + 0.15, T.noteSend - T.noteOpen - 0.15));
        const r = rects.composer1;
        const scale = 1.3;
        const out = prog(t, T.noteSend, 0.2);
        await capCrop(c, r, clamp(sx0 - 20, 40, W - r.width * scale - 40), y - size - 40 - r.height * scale, scale * (1 - out * 0.6), 1 - out, expo(prog(t, T.noteOpen, 0.25)));
      }
      if (t >= T.noteSend) pin(pinX, pinY, 1, t, { working: [T.working1, T.resolved1], resolvedAt: T.resolved1, alpha: (t < T.rewind ? 1 : 1 - prog(t, T.rewind, 0.2)) * expo(prog(t, T.noteSend, 0.25)) });
      if (t < T.rewind + 0.2) chip(pinX - 14, pinY - 78, story[0].reply, t, T.resolved1, t < T.rewind ? 1 : 1 - prog(t, T.rewind, 0.2));
    }
  } else {
    const boxes = layoutLine(lineV2, size, W / 2);
    drawLine(boxes, y, size, Math.min(TL2, t - T.pass2));
  }
  drawLog(t, (t < T.rewind ? 1 : t < T.pass2 ? 0.5 : 1) * expo(prog(t, T.wait1 - 0.05, 0.4)));
  // naming the agent
  if (t >= T.pass2) {
    line("", 1080, 600, 64, t, T.claude, { align: "left", leave: T.copyLeave, runs: [{ text: "That was Claude.", color: "gradient" }] });
    line("", 1080, 660, 34, t, T.claude2, { align: "left", weight: 500, leave: T.copyLeave, runs: [{ text: "cutroom is a video editor Claude drives over MCP.", color: GREY }] });
  }
}

// Act 2: note 2 (the box), Claude's second turn, the fold into a vertical Short.
async function act2(t: number) {
  const tl = TL2;
  const foldStart = T.fold, glideU = inOut(prog(t, T.glide, T.glideEnd - T.glide));
  const dark = inOut(prog(t, foldStart + 0.05, 0.6));
  const ease = inOut(prog(t, foldStart + 0.05, 0.4));
  const boxNow = t < foldStart ? BOX : lerpBox(BOX, CROP, ease);
  // picture
  if (t < T.glide) {
    await innerFull(inner.v2(tl), 1 + 0.008 * prog(t, T.box, 5));
    if (dark > 0) {
      x.fillStyle = `rgba(6,6,7,${dark})`;
      const b = boxNow;
      x.fillRect(0, 0, W, b.y);
      x.fillRect(0, b.y + b.height, W, H - b.y - b.height);
      x.fillRect(0, b.y, b.x, b.height);
      x.fillRect(b.x + b.width, b.y, W - b.x - b.width, b.height);
    }
  } else {
    stage(0);
    const dest = lerpBox(CROP, COL, glideU);
    const playing = t >= T.pass3;
    const f = await img(inner.v3(playing ? Math.min(TL3, tl + (t - T.pass3)) : tl));
    x.drawImage(f, dest.x, dest.y, dest.width, dest.height);
    x.strokeStyle = "rgba(255,240,230,0.16)";
    x.lineWidth = 1;
    x.strokeRect(dest.x + 0.5, dest.y + 0.5, dest.width - 1, dest.height - 1);
  }
  const colNow = t < T.glide ? CROP : lerpBox(CROP, COL, glideU);
  if (t < T.glide) scrim(1 - dark);
  // the box being drawn, then breathing while Claude works, then the crop window
  if (t >= T.boxDown && t < T.glide) {
    const du = expo(prog(t, T.boxDown + 0.05, T.boxUp - T.boxDown));
    const b = t < T.boxUp ? { x: BOX.x, y: BOX.y, width: BOX.width * du, height: BOX.height * du } : boxNow;
    const breathe = t >= T.working2 && t < T.fold ? 0.7 + 0.3 * Math.abs(Math.sin((t - T.working2) * Math.PI * 1.667)) : 1;
    const bright = t >= T.fold && t < T.fold + 2 / FPS;
    x.save();
    x.globalAlpha = breathe;
    x.fillStyle = `rgba(255,95,79,${bright ? 0.1 : 0.06 * (1 - ease)})`;
    x.fillRect(b.x, b.y, b.width, b.height);
    const hair = ease;
    x.strokeStyle = hair > 0 ? `rgba(${Math.round(lerp(255, 255, hair))},${Math.round(lerp(95, 240, hair))},${Math.round(lerp(79, 230, hair))},${lerp(1, 0.16, hair)})` : CORAL;
    x.lineWidth = lerp(2, 1, hair);
    rrect(b.x, b.y, b.width, b.height, 6 * (1 - hair));
    x.stroke();
    x.restore();
    if (t >= T.boxUp + 0.05 && ease < 1) {
      // the real marker tag
      x.fillStyle = CORAL;
      rrect(b.x + b.width - 34, b.y + 8, 26, 26, 6);
      x.fill();
      x.fillStyle = "#fff";
      x.font = "700 15px Inter";
      x.fillText("2", b.x + b.width - 25.5, b.y + 26.5);
    }
  }
  // composer for note 2 (real pixels), typing, folding into the pin
  if (t >= T.note2Open && t < T.note2Send + 0.2) {
    const c = lerp((ev["box-up"] ?? 0) + 0.45, (ev["note2-send"] ?? 0) - 0.02, prog(t, T.note2Open + 0.15, T.note2Send - T.note2Open - 0.15));
    const r = rects.composer2;
    const out = prog(t, T.note2Send, 0.2);
    await capCrop(c, r, Math.max(40, BOX.x - r.width * 1.3 - 26), BOX.y + 300, 1.3 * (1 - out * 0.6), 1 - out, expo(prog(t, T.note2Open, 0.25)));
  }
  // pin 2 rides the box corner, then the column corner
  if (t >= T.note2Send) pin(colNow.x + colNow.width - 4, colNow.y + 18 + (t >= T.glide ? -36 * glideU : 0), 2, t, { working: [T.working2, T.resolved2], resolvedAt: T.resolved2, alpha: expo(prog(t, T.note2Send, 0.25)) });
  if (t >= T.resolved2) chip(colNow.x + colNow.width + 24, colNow.y + 40, story[1].reply, t, T.resolved2);
  // cursor: enters, drags, parks right
  const curIn = expo(prog(t, T.box, 0.6));
  let cx = lerp(W + 40, BOX.x, curIn), cy = lerp(H * 0.7, BOX.y + 2, curIn);
  if (t >= T.boxDown) {
    const du = expo(prog(t, T.boxDown + 0.05, T.boxUp - T.boxDown));
    cx = BOX.x + BOX.width * du;
    cy = BOX.y + 2 + (BOX.height - 6) * du;
  }
  if (t >= T.note2Send) {
    const park = expo(prog(t, T.note2Send, 0.8));
    cx = lerp(BOX.x + BOX.width, 1780, park);
    cy = lerp(BOX.y + BOX.height - 4, 760, park);
  }
  cursor(cx, cy, 1.4, curIn);
  // HUD follows the picture into the column
  const colFrame = t < T.glide ? undefined : colNow;
  hud(t, { version: t < T.resolved2 ? "v2" : "v3", aspect: t < T.resolved2 ? "16:9" : "9:16", durS: dur.v2, tl: t >= T.pass3 ? Math.min(TL3, tl + (t - T.pass3)) : tl, paused: t < T.pass3, frame: colFrame && glideU > 0.98 ? colFrame : undefined, alpha: t >= T.glide && glideU < 0.98 ? 1 - Math.sin(Math.PI * glideU) * 0.8 : 1, flashAspect: T.resolved2 });
  // transcript: the v2 line under the full frame, reflowing under the column
  if (t < T.glide) drawLine(layoutLine(lineV2, 40, W / 2), 1000, 40, tl, { alpha: 1 });
  else drawColumnTranscript(t, Math.min(TL3, tl + Math.max(0, t - T.pass3)), glideU);
  drawLog(t, 1);
}
/** The words around the playhead, in two lines under the 9:16 column. */
function columnLines() {
  const rest = V3.filter((w) => w.start >= TL2 - 0.05);
  const mid = Math.ceil(rest.length / 2);
  return [rest.slice(0, mid), rest.slice(mid)];
}
function drawColumnTranscript(t: number, tl: number, alpha: number, lift?: { u: number }, cx = COLCX) {
  const [a, b] = columnLines();
  const size = 34;
  const y0 = COL.y + COL.height + 38;
  drawLine(layoutLine(a, size, cx), y0, size, tl, { alpha: alpha * (lift ? 1 - lift.u : 1) });
  drawLine(layoutLine(b, size, cx), y0 + 44, size, tl, { alpha: alpha * (lift ? 1 - lift.u : 1) });
}

// Act 3: ⌘K, Claude's third turn, the stillness, the bloom and the caption lift.
const faceInCol = { x: COL.x + ((focus.x * crop.width - crop.x) / 1080) * COL.width, y: COL.y + COL.height * 0.3 };
async function act3(t: number) {
  stage(0);
  const playEnd = T.pass3 + (TL3 - TL2);
  const tl = t < playEnd ? TL2 + (t - T.pass3) : TL3;
  const v3f = await img(inner.v3(Math.min(TL3, tl)));
  const paletteOpen = t >= T.palette && t < T.askSend + 0.2;
  x.save();
  if (paletteOpen) x.filter = "blur(6px)";
  x.drawImage(v3f, COL.x, COL.y, COL.width, COL.height);
  x.restore();
  // the bloom: the real graded frame (v4b) grows out of Reed's face
  if (t >= T.bloom) {
    const u = expo(prog(t, T.bloom, 1.0));
    const r = u * Math.hypot(COL.width, COL.height);
    const off = createCanvas(COL.width, COL.height), o = off.getContext("2d") as SKRSContext2D;
    const graded = await img(inner.v4b(TL3));
    o.drawImage(graded, 0, 0, COL.width, COL.height);
    if (u < 1) {
      o.globalCompositeOperation = "destination-in";
      const g = o.createRadialGradient(faceInCol.x - COL.x, faceInCol.y - COL.y, Math.max(0, r - 140), faceInCol.x - COL.x, faceInCol.y - COL.y, Math.max(1, r));
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      o.fillStyle = g;
      o.fillRect(0, 0, COL.width, COL.height);
    }
    x.drawImage(off, COL.x, COL.y);
    // the real burned-in captions take over at the end of the lift
    const cross = prog(t, T.liftEnd - 0.15, 0.15);
    if (cross > 0) {
      x.globalAlpha = cross;
      x.drawImage(await img(inner.v4(TL3)), COL.x, COL.y, COL.width, COL.height);
      x.globalAlpha = 1;
    }
  }
  x.strokeStyle = "rgba(255,240,230,0.16)";
  x.lineWidth = 1;
  x.strokeRect(COL.x + 0.5, COL.y + 0.5, COL.width - 1, COL.height - 1);
  const still = t >= T.still && t < T.bloom;
  const hudA = still ? 0.4 : t > T.bloom && t < T.resolved3 + 0.1 ? 0.4 + 0.6 * prog(t, T.resolved3, 0.3) : 1;
  hud(t, { version: t < T.resolved3 ? "v3" : "v4", aspect: "9:16", durS: dur.v3, tl, paused: t >= playEnd, frame: COL, alpha: hudA });
  // transcript under the column, lifting into the captions
  const liftU = t >= T.bloom ? prog(t, T.bloom, T.liftEnd - T.bloom) : 0;
  drawColumnTranscript(t, tl, hudA, capWords.length ? { u: Math.min(1, liftU * 1.4) } : undefined);
  if (capWords.length && t >= T.bloom && t < T.liftEnd) await captionLift(t, tl);
  // pins
  pin(COL.x + COL.width - 4, COL.y - 18, 2, t, { resolvedAt: 0, alpha: hudA });
  if (t >= T.askSend) pin(COL.x - 4, COL.y + COL.height + 24, 3, t, { working: [T.working3, T.resolved3], resolvedAt: T.resolved3, alpha: expo(prog(t, T.askSend, 0.25)) * (still ? 0.4 : 1) });
  if (t >= T.resolved3) chip(COL.x + COL.width + 24, COL.y + 40, story[2].reply, t, T.resolved3);
  // ⌘K: the real palette, typing
  if (t >= T.cmdK && t < T.cmdK + 0.4) {
    x.save();
    x.globalAlpha = 0.5 * (1 - prog(t, T.cmdK + 0.2, 0.2));
    mono(34, 600);
    x.fillStyle = "#fff";
    x.fillText("⌘K", 120, H - 110);
    x.restore();
  }
  if (paletteOpen) {
    const c = lerp((ev["palette"] ?? 0) + 0.45, (ev["ask-send"] ?? 0) - 0.02, prog(t, T.palette + 0.1, T.askSend - T.palette - 0.1));
    const r = rects.palette;
    const scale = Math.min(1.2, (COL.width + 260) / r.width);
    const out = prog(t, T.askSend, 0.2);
    await capCrop(c, r, COLCX - (r.width * scale) / 2, COL.y + 40, scale * (1 - out * 0.4), (1 - out) * expo(prog(t, T.palette, 0.25)), 1);
  }
  // cursor: up to the column, then out of the bottom edge for good
  if (t < T.cursorOut + 0.6) {
    const up = expo(prog(t, T.cursorUp, 0.5));
    const outU = inOut(prog(t, T.cursorOut, 0.5));
    cursor(lerp(1780, COLCX + 120, up), lerp(760, COL.y - 30, up) + outU * 1100, 1.4);
  }
  drawLog(t, 1, still);
}
/** Grey transcript words fly up into the exact boxes of their burned-in caption words. */
async function captionLift(t: number, tl: number) {
  const [a, b] = columnLines();
  const size = 34, y0 = COL.y + COL.height + 38;
  const boxes = [...layoutLine(a, size, COLCX).map((bx) => ({ ...bx, y: y0 })), ...layoutLine(b, size, COLCX).map((bx) => ({ ...bx, y: y0 + 44 }))];
  const sx = COL.width / 1080;
  capWords.forEach((cw, k) => {
    const src = boxes.find((bx) => norm(bx.w.text) === norm(cw.text));
    if (!src) return;
    const u = inOut(prog(t, T.bloom + k * 0.045, 0.85));
    if (u <= 0) return;
    // (bx, by) is the word's baseline-left: the grey word's baseline, then the caption's ink bottom.
    const tx = COL.x + cw.x * sx, ty = COL.y + (cw.y + cw.h) * sx;
    const p0 = { x: src.x, y: src.y }, p2 = { x: tx, y: ty }, p1 = { x: (p0.x + p2.x) / 2, y: Math.min(p0.y, p2.y) - 120 };
    const bx = (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x;
    const by = (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y;
    const fs = lerp(size, cw.fontSize * sx, u);
    x.save();
    if (renderCapWord && u > 0.5) {
      // ink box top-left (box height scales with fs), so at u = 1 it lands on the burned-in word
      x.translate(bx, by - (cw.h * fs) / cw.fontSize);
      x.scale(fs / (cw.fontSize * sx) * sx, fs / (cw.fontSize * sx) * sx);
      renderCapWord(x, { ...cw, x: 0, y: 0 }, {});
    } else {
      mono(fs);
      x.fillStyle = u > 0.5 ? (cw.isActive ? LIME : "#fff") : src.w.start <= tl ? BONE : GREY;
      x.fillText(u > 0.5 ? cw.displayText : src.w.text, bx, by);
    }
    x.restore();
  });
}

// Act 4: snap to the top, the final pass, untouched.
async function act4(t: number) {
  stage(1.2);
  const push = 1 + 0.02 * prog(t, T.final, V4DUR);
  const slide = inOut(prog(t, T.snap, 0.6));
  const cxNow = lerp(COLCX, W / 2, slide);
  const dest = { x: cxNow - (COL.width * push) / 2, y: COL.y + COL.height / 2 - (COL.height * push) / 2, width: COL.width * push, height: COL.height * push };
  if (t < T.final) {
    const u = prog(t, T.snap, T.final - T.snap);
    const tlA = TL3 * (1 - inOut(u));
    await blurred("v4", Array.from({ length: 5 }, (_, i) => clamp(tlA - i * 0.08, 0, TL3)), dest);
  } else x.drawImage(await img(inner.v4(Math.min(V4DUR - 0.01, t - T.final))), dest.x, dest.y, dest.width, dest.height);
  x.strokeStyle = "rgba(255,240,230,0.12)";
  x.lineWidth = 1;
  x.strokeRect(dest.x + 0.5, dest.y + 0.5, dest.width - 1, dest.height - 1);
  const fade = 1 - prog(t, T.snap, 0.4);
  hud(t, { version: "v4", aspect: "9:16", durS: dur.v4, tl: 0, paused: false, frame: { ...COL, x: cxNow - COL.width / 2 }, alpha: 1, final: true });
  if (fade > 0) {
    drawLog(t, fade);
    drawColumnTranscript(t, TL3, fade, undefined, cxNow);
  }
}

// Act 5: pull back into the real editor; the pins fly home; then the review; then the end.
const BASE = 1.2;
type Cam = { x: number; y: number; z: number };
const fitCam = (r: Box, fill: number): Cam => ({ x: r.x + r.width / 2, y: r.y + r.height / 2, z: Math.min((W * fill) / r.width, (H * fill) / r.height) / BASE });
function camRect(cam: Cam, r: Box): Box {
  const k = BASE * cam.z;
  return { x: W / 2 + (r.x - cam.x) * k, y: H / 2 + (r.y - cam.y) * k, width: r.width * k, height: r.height * k };
}
async function drawEditor(c: number, cam: Cam, alpha = 1) {
  const k = BASE * cam.z;
  const frame = await img(capFile(c));
  x.save();
  x.globalAlpha = alpha;
  x.translate(W / 2, H / 2);
  x.scale(k, k);
  x.translate(-cam.x, -cam.y);
  x.shadowColor = "rgba(0,0,0,0.75)";
  x.shadowBlur = 90;
  x.shadowOffsetY = 30;
  rrect(0, 0, 1440, 900, 14);
  x.fillStyle = "#0e0d0c";
  x.fill();
  x.shadowColor = "transparent";
  x.save();
  rrect(0, 0, 1440, 900, 14);
  x.clip();
  x.imageSmoothingQuality = "high";
  x.drawImage(frame, 0, 0, 1440, 900);
  x.restore();
  x.strokeStyle = "rgba(255,255,255,0.12)";
  x.lineWidth = 1.2 / k;
  rrect(0, 0, 1440, 900, 14);
  x.stroke();
  x.restore();
}
const F916 = rects.frame916 ?? rects.frame;
const camStart: Cam = { x: F916.x + F916.width / 2, y: F916.y + F916.height / 2, z: COLF.height / (F916.height * BASE) };
const camWide = fitCam({ x: 0, y: 0, width: 1440, height: 900 }, 0.74);
// shift the wide shot up a little so the copy has room underneath
camWide.y += 40;
const camReview = fitCam({ x: Math.min(F916.x, rects.review?.x ?? F916.x) - 20, y: (rects.review?.y ?? F916.y) - 20, width: Math.max(F916.x + F916.width, (rects.review?.x ?? 0) + (rects.review?.width ?? 0)) - Math.min(F916.x, rects.review?.x ?? F916.x) + 40, height: F916.y + F916.height - (rects.review?.y ?? F916.y) + 40 }, 0.7);
camReview.y += 46;
async function act5(t: number) {
  stage(1.2);
  if (t < T.review) {
    // the pull-back
    const u = expo(prog(t, T.reveal, 1.8));
    const cam: Cam = { x: lerp(camStart.x, camWide.x, u), y: lerp(camStart.y, camWide.y, u), z: Math.exp(lerp(Math.log(camStart.z), Math.log(camWide.z), u)) };
    const c = (ev["reveal"] ?? 0) + (t - T.reveal);
    await drawEditor(c, cam);
    // keep the preview sharp until the camera is far enough out
    const pr = camRect(cam, F916);
    const sharp = cam.z > 1.6 ? 1 : 1 - prog(cam.z, 1.6, -0.3) * 0 - clamp((1.6 - cam.z) / 0.3);
    if (sharp > 0) {
      x.globalAlpha = clamp(sharp);
      x.drawImage(await img(inner.v4(V4DUR - 0.05)), pr.x, pr.y, pr.width, pr.height);
      x.globalAlpha = 1;
    }
    // the pins fly home to their resolved cards
    const starts = [{ x: W / 2 - 300, y: 960 }, { x: COLF.x + COLF.width - 4, y: COLF.y - 18 }, { x: COLF.x - 4, y: COLF.y + COLF.height + 24 }];
    for (let n = 1; n <= 3; n++) {
      const card = rects[`card${n}`];
      if (!card) continue;
      const at = T.reveal + 0.2 + (n - 1) * 0.11;
      const pu = inOut(prog(t, at, 0.9));
      const target = camRect(cam, { x: card.x + card.width - 26, y: card.y + 16, width: 0, height: 0 });
      const s = starts[n - 1], p1 = { x: s.x, y: s.y - 220 }, p2 = { x: target.x, y: target.y - 160 };
      const bez = (a: number, b: number, c2: number, d: number) => (1 - pu) ** 3 * a + 3 * (1 - pu) ** 2 * pu * b + 3 * (1 - pu) * pu * pu * c2 + pu ** 3 * d;
      const fadeIn = expo(prog(t, T.reveal, 0.3));
      if (pu < 1) pin(bez(s.x, p1.x, p2.x, target.x), bez(s.y, p1.y, p2.y, target.y), n, t, { resolvedAt: 0, alpha: fadeIn });
      else if (t < at + 0.9 + 0.6) {
        const p = prog(t, at + 0.9, 0.6);
        x.strokeStyle = `rgba(232,244,124,${0.9 * (1 - p)})`;
        x.lineWidth = 2;
        x.beginPath();
        x.arc(target.x, target.y, 8 + p * 12, 0, Math.PI * 2);
        x.stroke();
      }
    }
    line("", W / 2, 1010, 44, t, T.reveal + 2.2, { leave: T.review - 0.4, runs: [{ text: "Every edit you just watched was a note.", color: "gradient" }] });
    line("", W / 2, 1058, 30, t, T.reveal + 2.8, { weight: 500, leave: T.review - 0.4, runs: [{ text: "Claude made them, over MCP.", color: GREY }] });
  } else if (t < T.end) {
    // review it like a pull request (the real Before/After)
    const u = inOut(prog(t, T.review, 0.5));
    const cam: Cam = { x: lerp(camWide.x, camReview.x, u), y: lerp(camWide.y, camReview.y, u), z: lerp(camWide.z, camReview.z, u) };
    const c = (ev["before-click"] ?? 0) - 0.4 + (t - T.review);
    const fadeOut = 1 - inOut(prog(t, T.end - 0.6, 0.6));
    await drawEditor(c, cam, fadeOut);
    const bc = ev["before-click"] ?? 0, ac = ev["after-click"] ?? 0;
    if (ev["before-not-unfolded"] !== undefined && c >= bc + 0.05 && c < ac + 0.05) {
      const pr = camRect(cam, F916);
      x.save();
      x.globalAlpha = fadeOut;
      x.fillStyle = "#000";
      x.fillRect(pr.x, pr.y, pr.width, pr.height);
      const h = (pr.width * 9) / 16;
      x.drawImage(await img(inner.v1(Math.min(dur.v1 - 0.05, c - bc))), pr.x, pr.y + (pr.height - h) / 2, pr.width, h);
      // the real review bar stays on top
      const rb = rects.review;
      if (rb) {
        const f = await img(capFile(c));
        const k = f.width / 1440, rr = camRect(cam, rb);
        x.drawImage(f, rb.x * k, rb.y * k, rb.width * k, rb.height * k, rr.x, rr.y, rr.width, rr.height);
      }
      x.restore();
    }
    const g = x.createLinearGradient(0, H - 200, 0, H);
    g.addColorStop(0, "rgba(6,6,7,0)");
    g.addColorStop(1, "rgba(6,6,7,0.85)");
    x.fillStyle = g;
    x.fillRect(0, H - 200, W, 200);
    line("", W / 2, 1030, 44, t, T.review + 2.2, { leave: T.end - 0.5, runs: [{ text: "Review it like a pull request.", color: "gradient" }] });
  }
}
function act6(t: number) {
  stage(1.6);
  const lt = t - T.end;
  const iu = expo(prog(lt, 0.3, 1.1));
  const size = 200;
  x.save();
  x.globalAlpha = iu;
  const g = x.createRadialGradient(W / 2, H / 2 - 170, 0, W / 2, H / 2 - 170, 420);
  g.addColorStop(0, `rgba(255,95,79,${0.22 * iu})`);
  g.addColorStop(1, "rgba(255,95,79,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  x.translate(W / 2, H / 2 - 170);
  const s = lerp(0.9, 1, iu);
  x.scale(s, s);
  if (1 - iu > 0.02) x.filter = `blur(${((1 - iu) * 14).toFixed(1)}px)`;
  x.drawImage(icon, -size / 2, -size / 2, size, size);
  x.restore();
  line("", W / 2, H / 2 + 40, 112, lt, 0.8, { weight: 700, runs: [{ text: "cutroom", color: "gradient" }] });
  line("", W / 2, H / 2 + 108, 44, lt, 1.2, { weight: 500, runs: [{ text: "Point at it. Claude fixes it.", color: GREY }] });
  const pu = expo(prog(lt, 1.7, 0.8));
  if (pu > 0) {
    x.save();
    x.globalAlpha = pu;
    mono(30);
    const cmd = "claude mcp add cutroom -- npx -y cutroom mcp";
    const cw = x.measureText(cmd).width + 64;
    const py = H / 2 + 160 + (1 - pu) * 12;
    rrect(W / 2 - cw / 2, py, cw, 66, 33);
    x.fillStyle = "rgba(255,255,255,0.06)";
    x.fill();
    x.strokeStyle = "rgba(255,255,255,0.14)";
    x.lineWidth = 1.5;
    x.stroke();
    x.fillStyle = "#e9e6e1";
    x.fillText(cmd, W / 2 - cw / 2 + 32, py + 43);
    x.restore();
  }
  // the film ends inside a live MCP call, waiting for your note
  const wu = expo(prog(lt, 2.6, 0.7));
  if (wu > 0) {
    x.save();
    x.globalAlpha = wu;
    mono(28);
    const a = "→ wait_for_feedback   ";
    const b = "waiting for your note   ";
    const secs = Math.max(0, Math.floor(lt - 2.6));
    const c = `0:${String(secs).padStart(2, "0")}`;
    const total = x.measureText(a + "●  " + b + c).width;
    let px = W / 2 - total / 2;
    const py = H / 2 + 290;
    x.fillStyle = "#cfcbc5";
    x.fillText(a, px, py);
    px += x.measureText(a).width;
    const pulse = 0.5 + 0.5 * Math.sin(((lt - 2.6) / 1.2) * Math.PI * 2 - Math.PI / 2);
    x.fillStyle = CORAL;
    x.globalAlpha = wu * (1 - 0.6 * (1 - pulse));
    x.beginPath();
    x.arc(px + 9, py - 9, 7 * (1 + 0.35 * pulse), 0, Math.PI * 2);
    x.fill();
    x.globalAlpha = wu;
    px += x.measureText("●  ").width;
    x.fillStyle = "#8d8983";
    x.fillText(b, px, py);
    px += x.measureText(b).width;
    x.fillStyle = "#6f6b65";
    x.fillText(c, px, py);
    x.restore();
  }
  line("", W / 2, H - 70, 24, lt, 3.4, { weight: 500, runs: [{ text: "Open source  ·  MIT  ·  runs locally  ·  github.com/0xpratzyy/cutroom", color: "#5f5b56" }] });
}

async function render(t: number) {
  x.globalAlpha = 1;
  x.filter = "none";
  if (t < T.box) await act1(t);
  else if (t < T.wait3 - 0.1 && t < T.pass3 + (TL3 - TL2) + 0.01 && t < T.cursorUp) await act2(t);
  else if (t < T.snap) await act3(t);
  else if (t < T.reveal) await act4(t);
  else if (t < T.end) await act5(t);
  else act6(t);
  // the stillness: nothing moves for half a second
  void INK;
}

// ---------------------------------------------------------------- cues for music-rough.mts
const filmOf = (c: number | undefined, from: number, c0: number) => (c === undefined ? null : from + (c - c0));
const cues = {
  duration: DUR,
  sections: Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v])),
  layers: [
    { at: 0, name: "L0" },
    { at: T.pass2, name: "L1" },
    { at: T.wait2, name: "L2" },
    { at: T.final, name: "full" },
    { at: T.review + ((ev["before-click"] ?? 0) - ((ev["before-click"] ?? 0) - 0.4)), name: "demo" },
    { at: T.review + ((ev["after-click"] ?? 0) - ((ev["before-click"] ?? 0) - 0.4)), name: "restore" },
  ],
  working: [[T.working1, T.resolved1], [T.working2, T.fold], [T.working3, T.still]],
  chimes: [{ at: T.resolved1, midi: 76 }, { at: T.resolved2, midi: 80 }, { at: T.resolved3, midi: 83 }],
  silence: [T.still, T.bloom],
  arrival: T.bloom,
  tonicAt: iFixes >= 0 ? T.final + V4[iFixes].start : T.finalEnd - 1,
  endPulses: [T.end + 2.6, T.end + 3.8, T.end + 5.0],
  rewind: { from: T.rewind, to: T.pass2 },
  sfx: [
    { name: "release", at: 0.5 },
    ...Array.from({ length: 6 }, (_, i) => ({ name: "key", at: T.noteOpen + 0.18 + i * 0.1 })),
    { name: "tock", at: T.noteSend },
    { name: "fold", at: T.fold1 },
    { name: "click", at: T.boxDown },
    { name: "release", at: T.boxUp },
    ...Array.from({ length: 8 }, (_, i) => ({ name: "key", at: T.note2Open + 0.15 + i * 0.09 })),
    { name: "tock", at: T.note2Send },
    { name: "breath", at: T.glide, dur: T.glideEnd - T.glide },
    { name: "key", at: T.cmdK, gain: 1.2 },
    ...Array.from({ length: 12 }, (_, i) => ({ name: "key", at: T.palette + 0.2 + i * 0.12 })),
    { name: "tock", at: T.askSend },
    { name: "click", at: filmOf(ev["before-click"], T.review, (ev["before-click"] ?? 0) - 0.4) ?? T.review + 0.4 },
    { name: "click", at: filmOf(ev["after-click"], T.review, (ev["before-click"] ?? 0) - 0.4) ?? T.review + 2.4 },
  ],
};
writeFileSync(join(OUT, "cues.json"), JSON.stringify(cues, null, 1));
console.log(`timeline: ${DUR.toFixed(1)} s · TL1 ${TL1.toFixed(2)} TL2 ${TL2.toFixed(2)} TL3 ${TL3.toFixed(2)} · v4 ${V4DUR.toFixed(2)} s · notes: ${story.map((s) => `#${s.n} "${s.note}" → ${s.ops.join(" | ")} · "${s.reply}"`).join("  ")}`);
if (process.argv.includes("--cues")) process.exit(0);

// ---------------------------------------------------------------- output
const only = process.argv.find((a) => a.startsWith("--only="));
if (only) {
  mkdirSync(join(OUT, "stills"), { recursive: true });
  for (const s of only.slice(7).split(",").map(Number)) {
    await render(s);
    writeFileSync(join(OUT, "stills", `t${s.toFixed(2).padStart(5, "0")}.jpg`), canvas.toBuffer("image/jpeg", 92));
  }
  console.log("stills written");
  process.exit(0);
}
const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, "film-video.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
const total = Math.round(DUR * FPS);
for (let f = 0; f < total; f++) {
  await render(f / FPS);
  const buf = Buffer.from(x.getImageData(0, 0, W, H).data.buffer);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % 300 === 0) console.log(`frame ${f}/${total}`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log(`film-video.mp4 done (${DUR.toFixed(1)} s)`);
void ({} as Canvas);
