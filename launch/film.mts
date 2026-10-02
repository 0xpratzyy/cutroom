// Composites the launch film: the problem, the turn, the real editor (captured by capture.mts,
// with Claude editing over MCP), a before/after of the real export, the punchline and the end
// card. No voice: picture, type, music and quiet sound design.
// Usage: npx tsx launch/film.mts [--cues] [--only=12.5,16]  ->  launch/out/film-video.mp4 (+ cues.json)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { bindPremium, clamp, CORAL, expo, OPEN, PROMPT, REVEAL, sceneEnd, sceneOpen, scenePrompt, scenePunch, sceneReveal, sceneWhat, stage } from "./premium.mts";

const OUT = "launch/out";
const W = 1920, H = 1080, FPS = 60;
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNS.ttf", "SF");
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNSMono.ttf", "SFMono");

// ---------------------------------------------------------------- capture timing
type Box = { x: number; y: number; width: number; height: number };
const cap = JSON.parse(readFileSync(join(OUT, "capture/frames.json"), "utf8")) as { frames: { file: string; t: number }[]; events: { name: string; t: number }[]; rects?: Record<string, Box> };
const t0 = cap.events.find((e) => e.name === "start")!.t;
const ev = Object.fromEntries(cap.events.map((e) => [e.name, e.t - t0])) as Record<string, number>;
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

type Cam = { x: number; y: number; z: number };
const rects = cap.rects ?? {};
const BASE = 1.2; // film px per window px at zoom 1 (the window is 1440×900 CSS px, captured at 2×)
/** Camera that fits a UI element into `fill` of the frame, capped so the 2× capture stays sharp. */
function fit(r: Box | undefined, fill: number, fallback: Cam, maxZ = 2.05, vw = W, vh = H): Cam {
  if (!r) return fallback;
  const k = Math.min((vw * fill) / r.width, (vh * fill) / r.height);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, z: Math.min(maxZ, k / BASE) };
}
const union = (a?: Box, b?: Box): Box | undefined =>
  a && b ? { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(a.x + a.width, b.x + b.width) - Math.min(a.x, b.x), height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y) } : (a ?? b);
const grow = (c: Cam, by: number, dx = 0, dy = 0): Cam => ({ x: c.x + dx, y: c.y + dy, z: c.z * by });

const PANEL: Box = { x: 1104, y: 112, width: 336, height: 560 };
/** Where the editor sits when Claude's MCP log is shown beside it. */
const SPLIT = { x: 60, y: 110, w: 1120, h: 780 };
const LOG = { x: 1220, y: 110, w: 640, h: 780 };
const FRAME = fit(rects.frame, 0.86, { x: 740, y: 316, z: 2.0 });
const BOXED = fit(union(rects.frame, rects.composer1), 0.84, { x: 850, y: 380, z: 1.8 });
const WORDS = fit(union(rects.words, rects.composer2), 0.86, { x: 420, y: 360, z: 1.6 });
const ASKED = fit(rects.palette, 0.6, { x: 720, y: 190, z: 1.9 });
// In the split view: the shot, and the transcript with the timeline under it.
const S_FRAME = fit(union(rects.frame, rects.review), 0.94, { x: 740, y: 320, z: 1.6 }, 2.05, SPLIT.w, SPLIT.h);
const S_TEXT = fit({ x: 20, y: 120, width: 780, height: 420 }, 0.96, { x: 410, y: 330, z: 1.3 }, 2.05, SPLIT.w, SPLIT.h);

interface Shot {
  from: number;
  to: number;
  c0: number;
  c1: number;
  cam0: Cam;
  cam1: Cam;
  step?: string;
  caption?: string;
  /** Claude's turn: the editor shares the frame with the MCP log for this beat. */
  beat?: number;
}
const P0 = REVEAL.to + 3.6; // after "built for Claude"
const WHAT = { from: REVEAL.to, to: P0 };
const plan: Omit<Shot, "from" | "to">[] = [
  { c0: ev["annotate-key"] - 0.5, c1: ev["note1-send"] + 0.25, cam0: grow(FRAME, 0.82), cam1: BOXED, step: "01", caption: "Point at the frame." },
  { c0: ev["agent-working-1"] - 1.0, c1: ev["agent-resolved-1"] + 1.1, cam0: S_FRAME, cam1: grow(S_FRAME, 1.04), caption: "Claude reframes the shot.", beat: 0 },
  { c0: ev["select-down"] - 0.6, c1: ev["note2-send"] + 0.25, cam0: WORDS, cam1: grow(WORDS, 1.04), step: "02", caption: "Or select the words." },
  { c0: ev["agent-working-2"] - 0.4, c1: ev["agent-resolved-2"] + 1.1, cam0: S_TEXT, cam1: grow(S_TEXT, 1.04), caption: "Claude cuts them.", beat: 1 },
  { c0: ev["palette"] - 0.35, c1: ev["ask-send"] + 0.35, cam0: ASKED, cam1: grow(ASKED, 1.04), step: "03", caption: "Or just ask." },
  { c0: ev["agent-working-3"] - 0.4, c1: ev["agent-resolved-3"] + 1.5, cam0: S_FRAME, cam1: grow(S_FRAME, 1.05), caption: "Claude adds the captions.", beat: 2 },
];
// Close to real time: the user's turns play at 1.1×, Claude's at 1×.
const shots: Shot[] = [];
{
  let at = P0;
  for (const p of plan) {
    const dur = (p.c1 - p.c0) / (p.beat === undefined ? 1.1 : 1);
    shots.push({ ...p, from: at, to: at + dur });
    at += dur;
  }
}
const PRODUCT_END = shots[shots.length - 1].to;
const BA = { from: PRODUCT_END, to: PRODUCT_END + 3.8 };
const PUNCH = { from: BA.to, to: BA.to + 2.6 };
const END = PUNCH.to;
const DUR = END + 4.4;
const XFADE = 0.3;
/** Film time at which capture time `c` is shown, if any shot shows it. */
function filmAt(c: number): number | null {
  for (const s of shots) if (c >= s.c0 && c <= s.c1) return s.from + ((c - s.c0) / (s.c1 - s.c0)) * (s.to - s.from);
  return null;
}

// What Claude does over MCP, beat by beat (the real tool calls capture.mts made).
type LogLine = { at: number; text: string; sub?: boolean; ok?: boolean };
const LOGS: LogLine[][] = [
  [
    { at: ev["note1-send"], text: "wait_for_feedback" },
    { at: ev["note1-send"], text: "#1 “speaker's cut off, center them”", sub: true },
    { at: ev["agent-working-1"], text: "update_feedback  #1 → working" },
    { at: ev["agent-edit-1"] - 0.3, text: "edit  set_focus { x: 0.29 }" },
    { at: ev["agent-resolved-1"], text: "update_feedback  #1 → resolved", ok: true },
  ],
  [
    { at: ev["note2-send"], text: "wait_for_feedback" },
    { at: ev["note2-send"], text: "#2 “cut this” on “Umm,”", sub: true },
    { at: ev["agent-working-2"], text: "update_feedback  #2 → working" },
    { at: ev["agent-edit-2"] - 0.3, text: "edit  remove_words · remove_silences" },
    { at: ev["agent-resolved-2"], text: "update_feedback  #2 → resolved", ok: true },
  ],
  [
    { at: ev["ask-send"], text: "wait_for_feedback" },
    { at: ev["ask-send"], text: "#3 “make the captions pop”", sub: true },
    { at: ev["agent-working-3"], text: "update_feedback  #3 → working" },
    { at: ev["agent-edit-3"] - 0.3, text: "edit  set_captions { preset: \"pop\" }" },
    { at: ev["agent-resolved-3"], text: "update_feedback  #3 → resolved", ok: true },
  ],
];

// ---------------------------------------------------------------- sound cues for music.mts (effects only, no voice)
const sfx: { name: string; at: number; gain?: number; dur?: number }[] = [];
sfx.push({ name: "typing", at: PROMPT.typeFrom, dur: PROMPT.typeTo - PROMPT.typeFrom, gain: 0.35 });
sfx.push({ name: "click", at: PROMPT.selectAt, gain: 0.5 });
sfx.push({ name: "click", at: PROMPT.deleteAt, gain: 0.6 });
sfx.push({ name: "impact", at: REVEAL.from, gain: 0.55 });
sfx.push({ name: "click", at: REVEAL.from + 1.1, gain: 0.5 });
sfx.push({ name: "impact", at: WHAT.from, gain: 0.4 });
sfx.push({ name: "impact", at: P0, gain: 0.4 });
for (const [e, name, g] of [["box-down", "click", 0.5], ["select-down", "click", 0.5], ["note1-send", "send", 0.35], ["note2-send", "send", 0.35], ["ask-send", "send", 0.35], ["agent-resolved-1", "chime", 0.3], ["agent-resolved-2", "chime", 0.3], ["agent-resolved-3", "chime", 0.3]] as const) {
  const at = ev[e] !== undefined ? filmAt(ev[e]) : null;
  if (at !== null) sfx.push({ name, at, gain: g });
}
sfx.push({ name: "impact", at: END, gain: 0.6 });
writeFileSync(join(OUT, "cues.json"), JSON.stringify({ duration: DUR, dialogue: [], sfx: sfx.sort((a, b) => a.at - b.at), sections: { open: OPEN.from, prompt: PROMPT.from, reveal: REVEAL.from, what: WHAT.from, product: P0, ba: BA.from, punch: PUNCH.from, end: END } }));
if (process.argv.includes("--cues")) process.exit(0);

// ---------------------------------------------------------------- assets
function frames(dir: string, src: string, vf: string, dur: number) {
  const d = join(OUT, dir);
  if (!existsSync(d) || readdirSync(d).length < 10) {
    mkdirSync(d, { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-t", String(dur), "-vf", `${vf},fps=${FPS}`, "-q:v", "2", join(d, "%04d.jpg")]);
  }
  const n = readdirSync(d).length;
  return (t: number) => join(d, `${String(Math.min(Math.max(0, Math.floor(t * FPS)), n - 1) + 1).padStart(4, "0")}.jpg`);
}
const FOOTAGE = existsSync(join(OUT, "footage.webm")) ? join(OUT, "footage.webm") : join(OUT, "speaker.webm");
const probe = (k: string) => Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", `stream=${k}`, "-of", "csv=p=0", FOOTAGE], { encoding: "utf8" }).trim());
const srcW = probe("width"), srcH = probe("height");
const cropW = Math.round((srcH * 9) / 16 / 2) * 2;
const beforeAt = frames("before", FOOTAGE, `crop=${cropW}:${srcH}:${Math.round((srcW - cropW) / 2)}:0,scale=720:1280`, 5);
const afterAt = frames("after", join(OUT, "after.mp4"), "scale=720:1280", 5);
const icon = await loadImage("assets/brand/icon-1024.png");
const imgCache = new Map<string, Image>();
async function img(path: string) {
  let i = imgCache.get(path);
  if (!i) {
    i = await loadImage(readFileSync(path));
    if (imgCache.size > 16) imgCache.delete(imgCache.keys().next().value!);
    imgCache.set(path, i);
  }
  return i;
}

const canvas = createCanvas(W, H);
const x = canvas.getContext("2d") as SKRSContext2D;
bindPremium(x, { sans: "SF", mono: "SFMono", icon });
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * clamp(u) + 2, 3) / 2);
const prog = (t: number, a: number, d: number) => clamp((t - a) / d);
const spacing = (px: number) => ((x as unknown as { letterSpacing: string }).letterSpacing = `${px}px`);
function rrect(px: number, py: number, w: number, h: number, r: number) {
  x.beginPath();
  x.roundRect(px, py, w, h, r);
}

// ---------------------------------------------------------------- the editor, floating
async function drawShot(t: number, s: Shot, alpha = 1, vp = { x: 0, y: 0, w: W, h: H }) {
  const u = clamp((t - s.from) / (s.to - s.from));
  const c = lerp(s.c0, s.c1, u);
  const e = inOut(u);
  const cam = { x: lerp(s.cam0.x, s.cam1.x, e), y: lerp(s.cam0.y, s.cam1.y, e), z: lerp(s.cam0.z, s.cam1.z, e) };
  const k = BASE * cam.z;
  const halfW = vp.w / 2 / k, halfH = vp.h / 2 / k, over = 110;
  cam.x = halfW * 2 < 1440 + over * 2 ? clamp(cam.x, halfW - over, 1440 + over - halfW) : 720;
  cam.y = halfH * 2 < 900 + over * 2 ? clamp(cam.y, halfH - over, 900 + over - halfH) : 450;
  const frame = await img(capFile(c));
  x.save();
  x.globalAlpha = alpha;
  if (vp.w < W) {
    rrect(vp.x, vp.y, vp.w, vp.h, 22);
    x.clip();
  }
  x.translate(vp.x + vp.w / 2, vp.y + vp.h / 2);
  x.scale(k, k);
  x.translate(-cam.x, -cam.y);
  // warm bloom behind the window
  const g = x.createRadialGradient(720, 520, 0, 720, 520, 900);
  g.addColorStop(0, "rgba(255,95,79,0.10)");
  g.addColorStop(1, "rgba(255,95,79,0)");
  x.fillStyle = g;
  x.fillRect(-600, -500, 2640, 1900);
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
function caption(t: number, s: Shot, prevSame: boolean) {
  if (!s.caption) return;
  const g = x.createLinearGradient(0, H * 0.62, 0, H);
  g.addColorStop(0, "rgba(6,6,7,0)");
  g.addColorStop(1, "rgba(6,6,7,0.82)");
  x.fillStyle = g;
  x.fillRect(0, H * 0.62, W, H * 0.38);
  const u = prevSame ? 1 : expo(prog(t, s.from + 0.05, 0.8));
  x.save();
  x.globalAlpha = u;
  if (u < 1) x.filter = `blur(${((1 - u) * 10).toFixed(1)}px)`;
  const base = H - 96;
  let px = 110;
  if (s.step) {
    x.font = "500 30px SFMono";
    x.fillStyle = CORAL;
    x.fillText(s.step, px, base - 4);
    px += 78;
  }
  x.font = "600 50px SF";
  spacing(-1);
  x.fillStyle = "#f4f2ef";
  x.fillText(s.caption, px, base);
  spacing(0);
  x.restore();
}
const SPLIT_IN = 0.55;
/** How far into the split layout a shot is (0 = editor full frame, 1 = split with the log). */
function splitness(t: number, s: Shot) {
  if (s.beat === undefined) return 0;
  return inOut(clamp((t - s.from) / SPLIT_IN));
}
function vpFor(sp: number) {
  return { x: lerp(0, SPLIT.x, sp), y: lerp(0, SPLIT.y, sp), w: lerp(W, SPLIT.w, sp), h: lerp(H, SPLIT.h, sp) };
}
function mcpLog(t: number, s: Shot, sp: number) {
  if (s.beat === undefined || sp <= 0) return;
  const c = lerp(s.c0, s.c1, clamp((t - s.from) / (s.to - s.from)));
  x.save();
  x.globalAlpha = sp;
  x.translate((1 - sp) * 80, 0);
  rrect(LOG.x, LOG.y, LOG.w, LOG.h, 22);
  x.fillStyle = "rgba(255,255,255,0.035)";
  x.fill();
  x.strokeStyle = "rgba(255,255,255,0.10)";
  x.lineWidth = 1.5;
  x.stroke();
  // header
  x.font = "600 36px SF";
  spacing(-0.5);
  x.fillStyle = "#f4f2ef";
  x.fillText("Claude", LOG.x + 40, LOG.y + 62);
  spacing(0);
  x.font = "500 22px SFMono";
  x.fillStyle = "#77736d";
  x.fillText("connected to cutroom over MCP", LOG.x + 40, LOG.y + 98);
  x.fillStyle = "#4ade80";
  x.beginPath();
  x.arc(LOG.x + LOG.w - 44, LOG.y + 50, 7, 0, Math.PI * 2);
  x.fill();
  x.fillStyle = "rgba(255,255,255,0.08)";
  x.fillRect(LOG.x + 40, LOG.y + 128, LOG.w - 80, 1.5);
  // lines: earlier beats dimmed, this beat as it happens
  let y = LOG.y + 186;
  for (let b = 0; b <= s.beat; b++) {
    for (const l of b < s.beat ? LOGS[b].slice(0, 2) : LOGS[b]) {
      const shown = b < s.beat ? 1 : expo(clamp((c - l.at) / 0.5));
      if (b === s.beat && c < l.at) continue;
      x.save();
      x.globalAlpha = sp * shown * (b < s.beat ? 0.32 : 1);
      if (shown < 1) x.filter = `blur(${((1 - shown) * 6).toFixed(1)}px)`;
      if (l.sub) {
        x.font = "500 25px SF";
        x.fillStyle = "#b3afa9";
        x.fillText(l.text, LOG.x + 74, y - 4);
        y += 50;
      } else {
        x.fillStyle = l.ok ? "#4ade80" : CORAL;
        x.beginPath();
        x.arc(LOG.x + 50, y - 9, 6, 0, Math.PI * 2);
        x.fill();
        x.font = "500 24px SFMono";
        x.fillStyle = "#ece9e4";
        x.fillText(l.text, LOG.x + 72, y);
        y += 44;
      }
      x.restore();
    }
    y += b < s.beat ? 22 : 0;
  }
  x.restore();
}
async function sceneProduct(t: number) {
  stage(0.6);
  const i = shots.findIndex((s) => t >= s.from && t < s.to);
  const s = shots[i];
  const prev = shots[i - 1];
  const fade = prev ? clamp((t - s.from) / XFADE) : 1;
  // Claude's shots grow the log in from the right; the next user shot goes back to full frame.
  const sp = splitness(t, s);
  const prevSp = prev?.beat !== undefined ? 1 - inOut(clamp((t - s.from) / SPLIT_IN)) : 0;
  if (prev && fade < 1) await drawShot(prev.to + (t - s.from), prev, 1, vpFor(prev.beat !== undefined ? Math.max(prevSp, sp) : sp));
  await drawShot(t, s, prev ? inOut(fade) : expo(prog(t, s.from, 0.6)), vpFor(Math.max(sp, prevSp)));
  if (prev?.beat !== undefined && s.beat === undefined) mcpLog(prev.to - 0.001, prev, prevSp);
  mcpLog(t, s, sp);
  caption(t, s, !!prev && prev.caption === s.caption);
}

// ---------------------------------------------------------------- before / after (the real export)
function phone(cx: number, cy: number, h: number, f: Image, o: { alpha: number; dim?: boolean; glow?: boolean }) {
  const w = (h * 9) / 16, r = h * 0.075;
  x.save();
  x.globalAlpha = o.alpha;
  if (o.glow) {
    const g = x.createRadialGradient(cx, cy, 0, cx, cy, h * 0.9);
    g.addColorStop(0, "rgba(255,95,79,0.16)");
    g.addColorStop(1, "rgba(255,95,79,0)");
    x.fillStyle = g;
    x.fillRect(cx - h, cy - h, h * 2, h * 2);
  }
  x.shadowColor = "rgba(0,0,0,0.7)";
  x.shadowBlur = 70;
  x.shadowOffsetY = 26;
  rrect(cx - w / 2 - 14, cy - h / 2 - 14, w + 28, h + 28, r + 14);
  x.fillStyle = "#1b1a19";
  x.fill();
  x.shadowColor = "transparent";
  x.strokeStyle = "rgba(255,255,255,0.14)";
  x.lineWidth = 2;
  x.stroke();
  x.save();
  rrect(cx - w / 2, cy - h / 2, w, h, r);
  x.clip();
  if (o.dim) x.filter = "saturate(0.7) brightness(0.72)";
  x.drawImage(f, cx - w / 2, cy - h / 2, w, h);
  x.filter = "none";
  const sh = x.createLinearGradient(cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2);
  sh.addColorStop(0, "rgba(255,255,255,0.07)");
  sh.addColorStop(0.45, "rgba(255,255,255,0)");
  x.fillStyle = sh;
  x.fillRect(cx - w / 2, cy - h / 2, w, h);
  x.restore();
  rrect(cx - w * 0.14, cy - h / 2 + 16, w * 0.28, 30, 15);
  x.fillStyle = "#000";
  x.fill();
  x.restore();
}
async function sceneBA(t: number) {
  stage(1);
  const lt = t - BA.from;
  const h = 780, gap = 150;
  const out = inOut(prog(t, BA.to - 0.4, 0.4));
  for (const side of [0, 1]) {
    const u = expo(prog(lt, side * 0.18, 0.9));
    const cx = W / 2 + (side ? 1 : -1) * ((h * 9) / 32 + gap / 2);
    const cy = H / 2 + 30 + (1 - u) * 40;
    const f = await img(side ? afterAt(lt) : beforeAt(lt));
    phone(cx, cy, h, f, { alpha: u * (1 - out), dim: !side, glow: !!side });
    x.save();
    x.globalAlpha = u * (1 - out);
    x.font = "500 26px SFMono";
    spacing(4);
    const lab = side ? "AFTER" : "BEFORE";
    x.fillStyle = side ? CORAL : "#6f6b65";
    x.fillText(lab, cx - x.measureText(lab).width / 2, cy - h / 2 - 48);
    spacing(0);
    x.restore();
  }
}

async function render(t: number) {
  x.globalAlpha = 1;
  x.filter = "none";
  if (t < PROMPT.from) sceneOpen(t);
  else if (t < REVEAL.from) scenePrompt(t);
  else if (t < WHAT.from) sceneReveal(t);
  else if (t < P0) sceneWhat(t, WHAT.from, WHAT.to);
  else if (t < PRODUCT_END) await sceneProduct(t);
  else if (t < BA.to) await sceneBA(t);
  else if (t < PUNCH.to) scenePunch(t, PUNCH.from, PUNCH.to);
  else sceneEnd(t, END);
  // in from black, out to black
  const edge = Math.max(1 - t / 0.35, (t - (DUR - 0.6)) / 0.6);
  if (edge > 0) {
    x.fillStyle = `rgba(6,6,7,${clamp(edge)})`;
    x.fillRect(0, 0, W, H);
  }
}

// ---------------------------------------------------------------- output
const only = process.argv.find((a) => a.startsWith("--only="));
if (only) {
  mkdirSync(join(OUT, "stills"), { recursive: true });
  for (const s of only.slice(7).split(",").map(Number)) {
    await render(s);
    writeFileSync(join(OUT, "stills", `t${s.toFixed(2)}.jpg`), canvas.toBuffer("image/jpeg", 92));
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
