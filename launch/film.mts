// Composites the launch film: kinetic type, the captured editor in a window with camera moves,
// a before/after of the real export, a feature run and the end card.
// Usage: npx tsx launch/film.mts [--cues] [--only=12.5,16]  ->  launch/out/film.mp4 (+ cues.json)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { bindMotion, HERO, HOOK, MONTAGE, PAL, sceneCard as motionCard, sceneEnd as motionEnd, sceneHero, sceneHook, sceneMontage, scenePunch, sceneRing } from "./motion.mts";

const OUT = "launch/out";
const W = 1920, H = 1080, FPS = 60, DUR = 38;
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNS.ttf", "SF");
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNSMono.ttf", "SFMono");
const FONT = "SF";
const C = { bg: "#0b0a09", lime: "#d9ff4a", coral: "#ff6b4a", agent: "#a78bfa", text: "#f5f2ee", dim: "#9a948c" };

// ---------------------------------------------------------------- capture timing
const cap = JSON.parse(readFileSync(join(OUT, "capture/frames.json"), "utf8")) as { frames: { file: string; t: number }[]; events: { name: string; t: number }[] };
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
type Box = { x: number; y: number; width: number; height: number };
const rects = ((cap as unknown as { rects?: Record<string, Box> }).rects ?? {}) as Record<string, Box>;
const BASE = 1.2; // film px per window px at zoom 1
/** Camera that fits a UI element into `fill` of the frame (capped so pixels stay sharp). */
function fit(name: string, fill: number, fallback: Cam, maxZ = 2.7): Cam {
  const r = rects[name];
  if (!r) return fallback;
  const k = Math.min((W * fill) / r.width, (H * fill) / r.height);
  return { x: r.x + r.width / 2, y: r.y + r.height / 2, z: Math.min(maxZ, k / BASE) };
}
const grow = (c: Cam, by: number): Cam => ({ ...c, z: c.z * by });
interface Shot {
  from: number;
  to: number;
  c0: number;
  c1: number;
  cam0: Cam;
  cam1: Cam;
  /** Small caption inside the shot. */
  sub?: string;
  agent?: boolean;
  typing?: boolean;
}
interface Card {
  from: number;
  to: number;
  num?: string;
  text: string;
  bg: string;
  fg: string;
  sub?: string;
}
const FRAME = fit("frame", 0.92, { x: 740, y: 330, z: 2.0 });
// The notes column: cards shift as Claude's review list appears above them, so frame the whole column.
rects.panel = { x: 1104, y: 112, width: 336, height: 560 };
const PANEL = fit("panel", 0.94, { x: 1272, y: 392, z: 1.6 });
// The story: the prompt-box gag (0–3.5), the pin arrives (3.5–6), point at anything (6–9),
// the real product (9–25.5), before/after (25.5–28.5), type ring, punchline, end card.
const P = 3; // the product section starts 3 s later than its capture-relative layout below
const cards: Card[] = [
  { from: 6 + P, to: 6.5 + P, num: "01", text: "Box it", bg: PAL.lime, fg: PAL.ink },
  { from: 9.5 + P, to: 10 + P, text: "On it", bg: PAL.violet, fg: PAL.ink },
  { from: 12 + P, to: 12.5 + P, num: "02", text: "Select it", bg: PAL.coral, fg: "#fff" },
  { from: 15 + P, to: 15.5 + P, num: "03", text: "Say it", bg: PAL.cream, fg: PAL.ink },
  { from: 19 + P, to: 19.5 + P, text: "All fixed", bg: PAL.ink, fg: "#f5f2ee" },
];
const shots: Shot[] = [
  // Box it
  { from: 6.5 + P, to: 8 + P, c0: ev["box-down"] - 0.35, c1: ev["box-up"] + 0.15, cam0: FRAME, cam1: grow(FRAME, 1.06), sub: "Drag over anything in the frame." },
  { from: 8 + P, to: 9.5 + P, c0: ev["box-up"] + 0.2, c1: ev["note1-send"] + 0.15, cam0: fit("composer1", 0.62, { x: 895, y: 437, z: 2.5 }), cam1: grow(fit("composer1", 0.62, { x: 895, y: 437, z: 2.5 }), 1.07), typing: true },
  // Claude fixes it
  { from: 10 + P, to: 11 + P, c0: ev["agent-working-1"] - 0.1, c1: ev["agent-resolved-1"] + 0.3, cam0: PANEL, cam1: grow(PANEL, 1.06), agent: true, sub: "Claude reads the note and edits the project." },
  { from: 11 + P, to: 12 + P, c0: ev["agent-edit-1"] + 0.1, c1: ev["agent-edit-1"] + 1.0, cam0: grow(FRAME, 0.98), cam1: grow(FRAME, 1.05), agent: true, sub: "Reframed." },
  // Select it
  { from: 12.5 + P, to: 14 + P, c0: ev["select-down"] - 0.35, c1: ev["select-up"] + 0.3, cam0: fit("words", 0.55, { x: 160, y: 380, z: 2.6 }), cam1: grow(fit("words", 0.55, { x: 160, y: 380, z: 2.6 }), 1.05), sub: "Highlight words in the transcript." },
  { from: 14 + P, to: 15 + P, c0: ev["select-up"] + 0.45, c1: ev["note2-send"] + 0.15, cam0: fit("composer2", 0.62, { x: 913, y: 378, z: 2.5 }), cam1: grow(fit("composer2", 0.62, { x: 913, y: 378, z: 2.5 }), 1.06), typing: true },
  // Say it
  { from: 15.5 + P, to: 16.1 + P, c0: ev["voice-down"] - 0.15, c1: ev["voice-down"] + 0.45, cam0: { ...fit("mic", 0.1, { x: 856, y: 82, z: 2.7 }), z: 2.7 }, cam1: { ...fit("mic", 0.1, { x: 856, y: 82, z: 2.7 }), z: 2.85 }, sub: "Hold V and talk over the video." },
  { from: 16.1 + P, to: 19 + P, c0: ev["voice-down"] + 0.45, c1: ev["voice-down"] + 3.35, cam0: FRAME, cam1: grow(FRAME, 1.1), sub: "Hold V and talk over the video." },
  // All fixed
  { from: 19.5 + P, to: 21 + P, c0: ev["agent-working-3"] - 0.2, c1: ev["agent-resolved-3"] + 0.45, cam0: PANEL, cam1: grow(PANEL, 1.06), agent: true, sub: "Every note gets a reply." },
  { from: 21 + P, to: 22.5 + P, c0: ev["agent-resolved-3"] + 0.4, c1: ev["agent-resolved-3"] + 1.9, cam0: FRAME, cam1: grow(FRAME, 1.08), agent: true, sub: "Pop captions, hook title, clean take." },
];
const BA = { from: 25.5, to: 28.5 };
const RING = 28.5, PUNCH = 31.5, END = 35;
/** Film time at which capture time `c` is shown, if any shot shows it. */
function filmAt(c: number): number | null {
  for (const s of shots) if (c >= s.c0 && c <= s.c1) return s.from + ((c - s.c0) / (s.c1 - s.c0)) * (s.to - s.from);
  return null;
}
const sayShot = shots.find((s) => s.from === 15.5 + P)!;
const VOICE_AT = sayShot.from + (ev["voice-down"] + 0.33 - sayShot.c0);

// ---------------------------------------------------------------- sound cues for music.mts
const sfx: { name: string; at: number; gain?: number; dur?: number }[] = [];
// the gag
sfx.push({ name: "click", at: 0.25, gain: 0.9 });
sfx.push({ name: "typing", at: HOOK.typeFrom, dur: HOOK.typeTo - HOOK.typeFrom, gain: 0.6 });
sfx.push({ name: "squeak", at: 1.55, dur: HOOK.pop - 1.55, gain: 0.7 });
sfx.push({ name: "pop", at: HOOK.pop, gain: 1.1 });
// the pin lands, bounces, hops onto the i, zooms
sfx.push({ name: "boing", at: HERO.from + HERO.land, gain: 1 });
sfx.push({ name: "plink", at: HERO.from + HERO.land + 0.27, gain: 0.5 });
for (let i = 0; i < 6; i++) sfx.push({ name: "tick", at: HERO.words + i * 0.07, gain: 0.35 });
sfx.push({ name: "boing", at: HERO.swap, gain: 0.6 });
sfx.push({ name: "plink", at: HERO.hopLand, gain: 0.9 });
sfx.push({ name: "riser", at: HERO.zoom - 0.5, gain: 0.7 });
sfx.push({ name: "impact", at: MONTAGE.from, gain: 1 });
for (let i = 1; i < 4; i++) sfx.push({ name: "slam", at: MONTAGE.from + i * MONTAGE.step, gain: 0.8 });
sfx.push({ name: "click", at: MONTAGE.from + 0.12, gain: 0.8 });
sfx.push({ name: "chime", at: MONTAGE.from + 0.55, gain: 0.6 });
// the product
for (const c of cards) sfx.push({ name: "slam", at: c.from });
for (const c of cards) sfx.push({ name: "plink", at: c.from + 0.2, gain: 0.5 });
for (const s of shots) if (!cards.some((c) => Math.abs(c.to - s.from) < 0.01)) sfx.push({ name: "whoosh", at: s.from, gain: 0.7 });
for (const s of shots.filter((s) => s.typing)) sfx.push({ name: "typing", at: s.from + 0.05, dur: s.to - s.from - 0.15, gain: 0.55 });
for (const [e, name] of [["box-down", "click"], ["select-down", "click"], ["note1-send", "send"], ["note2-send", "send"], ["voice-down", "mic"], ["agent-resolved-1", "chime"], ["agent-resolved-2", "chime"], ["agent-resolved-3", "chime"]] as const) {
  const at = ev[e] !== undefined ? filmAt(ev[e]) : null;
  if (at !== null) sfx.push({ name, at, gain: name === "click" ? 0.9 : 0.75 });
}
// the payoff
sfx.push({ name: "whoosh", at: BA.from, gain: 0.8 });
sfx.push({ name: "whoosh", at: RING, gain: 0.9 });
sfx.push({ name: "boing", at: PUNCH + 1.25, gain: 0.7 });
sfx.push({ name: "boing", at: END + 0.3, gain: 0.9 });
for (let i = 0; i < 7; i++) sfx.push({ name: "tick", at: END + 0.3 + i * 0.09, gain: 0.35 });
writeFileSync(
  join(OUT, "cues.json"),
  JSON.stringify({
    dialogue: [
      { file: join(OUT, "capture/voice.wav"), at: VOICE_AT, from: 0.3, dur: 1.9, gain: 1.15 },
      { file: join(OUT, "after.mp4"), at: BA.from, dur: BA.to - BA.from - 0.2, gain: 1.0 },
    ],
    sfx: sfx.sort((a, b) => a.at - b.at),
  }),
);
if (process.argv.includes("--cues")) process.exit(0);

// ---------------------------------------------------------------- assets
function frames(dir: string, src: string, vf: string, dur: number) {
  const d = join(OUT, dir);
  if (!existsSync(d) || readdirSync(d).length < 10) {
    mkdirSync(d, { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", src, "-t", String(dur), "-vf", `${vf},fps=${FPS}`, "-q:v", "3", join(d, "%04d.jpg")]);
  }
  return (t: number) => join(d, `${String(Math.min(Math.floor(t * FPS), readdirSync(d).length - 1) + 1).padStart(4, "0")}.jpg`);
}
const beforeAt = frames("before", join(OUT, "speaker.webm"), "crop=607:1080:656:0,scale=720:1280", 4);
const afterAt = frames("after", join(OUT, "after.mp4"), "scale=720:1280", 4);
const icon = await loadImage("assets/brand/icon-1024.png");
const imgCache = new Map<string, Image>();
async function img(path: string) {
  let i = imgCache.get(path);
  if (!i) {
    i = await loadImage(readFileSync(path));
    if (imgCache.size > 12) imgCache.delete(imgCache.keys().next().value!);
    imgCache.set(path, i);
  }
  return i;
}
// Film grain tile.
const grain = createCanvas(256, 256);
{
  const g = grain.getContext("2d");
  const d = g.createImageData(256, 256);
  for (let i = 0; i < d.data.length; i += 4) {
    const v = Math.random() * 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
}

// ---------------------------------------------------------------- helpers
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
const outCubic = (u: number) => 1 - Math.pow(1 - clamp(u), 3);
const outBack = (u: number) => {
  u = clamp(u);
  const c1 = 2.2, c3 = c1 + 1;
  return 1 + c3 * Math.pow(u - 1, 3) + c1 * Math.pow(u - 1, 2);
};
const prog = (t: number, a: number, d: number) => clamp((t - a) / d);

const canvas = createCanvas(W, H);
const x = canvas.getContext("2d") as SKRSContext2D;
bindMotion(x, { sans: FONT, mono: "SFMono" });

function font(size: number, weight = 800, family = FONT) {
  x.font = `${weight} ${size}px ${family}`;
}
function track(px: number) {
  (x as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}
function rrect(px: number, py: number, w: number, h: number, r: number) {
  x.beginPath();
  x.roundRect(px, py, w, h, r);
}
function backdrop(t: number, glow = 1) {
  x.fillStyle = PAL.cream;
  x.fillRect(0, 0, W, H);
  const a = x.createRadialGradient(W * 0.5, H * 0.45, 0, W * 0.5, H * 0.45, W * 0.7);
  a.addColorStop(0, `rgba(255,255,255,${0.5 * glow})`);
  a.addColorStop(1, "rgba(255,255,255,0)");
  x.fillStyle = a;
  x.fillRect(0, 0, W, H);
  void t;
}
function finish(t: number) {
  // vignette + grain
  const v = x.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.1);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.16)");
  x.fillStyle = v;
  x.fillRect(0, 0, W, H);
  x.save();
  x.globalAlpha = 0.035;
  x.globalCompositeOperation = "overlay";
  const ox = Math.floor(Math.random() * 256), oy = Math.floor(Math.random() * 256);
  for (let gx = -ox; gx < W; gx += 256) for (let gy = -oy; gy < H; gy += 256) x.drawImage(grain, gx, gy);
  x.restore();
  void t;
}
function centered(text: string, cx: number, cy: number) {
  const m = x.measureText(text);
  x.fillText(text, cx - m.width / 2, cy);
  return m.width;
}
function cursor(px: number, py: number, s = 1) {
  x.save();
  x.translate(px, py);
  x.scale(s, s);
  x.shadowColor = "rgba(0,0,0,0.5)";
  x.shadowBlur = 8;
  x.shadowOffsetY = 3;
  x.beginPath();
  x.moveTo(0, 0); x.lineTo(0, 19); x.lineTo(5, 14.5); x.lineTo(8.5, 22); x.lineTo(11.6, 20.6); x.lineTo(8.2, 13.3); x.lineTo(15, 13.3); x.closePath();
  x.fillStyle = "#111";
  x.fill();
  x.shadowColor = "transparent";
  x.lineWidth = 1.6;
  x.strokeStyle = "#fff";
  x.lineJoin = "round";
  x.stroke();
  x.restore();
}

// Captured editor in a window, with camera.
async function sceneCapture(t: number, s: Shot) {
  backdrop(t);
  const u = (t - s.from) / (s.to - s.from);
  const c = lerp(s.c0, s.c1, u);
  const e = inOut(u);
  let cam = { x: lerp(s.cam0.x, s.cam1.x, e), y: lerp(s.cam0.y, s.cam1.y, e), z: lerp(s.cam0.z, s.cam1.z, e) };
  // Punch-in on the cut.
  const punch = 1 + 0.05 * Math.pow(1 - prog(t, s.from, 0.3), 3);
  cam = { ...cam, z: cam.z * punch };
  const k = BASE * cam.z;
  // Keep the view inside the window.
  const halfW = W / 2 / k, halfH = H / 2 / k;
  // Keep the view on the window, letting a little of the desk show past its edges.
  const over = 70;
  cam.x = halfW * 2 < 1440 + over * 2 ? clamp(cam.x, halfW - over, 1440 + over - halfW) : 720;
  cam.y = halfH * 2 < 900 + over * 2 ? clamp(cam.y, halfH - over, 900 + over - halfH) : 450;
  const frame = await img(capFile(c));
  x.save();
  x.translate(W / 2, H / 2);
  x.scale(k, k);
  x.translate(-cam.x, -cam.y);
  x.shadowColor = "rgba(0,0,0,0.6)";
  x.shadowBlur = 60;
  x.shadowOffsetY = 20;
  rrect(0, 0, 1440, 900, 16);
  x.fillStyle = "#0e0d0c";
  x.fill();
  x.shadowColor = "transparent";
  x.save();
  rrect(0, 0, 1440, 900, 16);
  x.clip();
  x.imageSmoothingQuality = "high";
  x.drawImage(frame, 0, 0, 1440, 900);
  x.restore();
  x.strokeStyle = "rgba(255,255,255,0.10)";
  x.lineWidth = 1.5 / k;
  rrect(0, 0, 1440, 900, 16);
  x.stroke();
  x.restore();
  if (s.from === 15.5 + P || s.from === 16.1 + P) voiceCaption(t);
  label(t, s);
}
// The voice note, as it's spoken.
function voiceCaption(t: number) {
  const lt = t - (VOICE_AT - 0.25);
  if (lt < 0) return;
  const words = ["Make", "the", "captions", "pop."];
  const shown = words.filter((_, i) => lt > 0.25 + i * 0.3);
  const u = outBack(prog(lt, 0, 0.3));
  font(46, 700);
  const text = shown.length ? `“${shown.join(" ")}${shown.length === words.length ? "”" : ""}` : "";
  const tw = Math.max(x.measureText("“Make the captions pop.”").width, 0);
  const w = tw + 150, h = 96;
  x.save();
  x.translate(W / 2, 150);
  x.scale(u, u);
  x.shadowColor = "rgba(0,0,0,0.5)";
  x.shadowBlur = 40;
  rrect(-w / 2, -h / 2, w, h, h / 2);
  x.fillStyle = "rgba(20,18,16,0.94)";
  x.fill();
  x.shadowColor = "transparent";
  x.strokeStyle = "rgba(255,107,74,0.6)";
  x.lineWidth = 2;
  x.stroke();
  // mic pulse + bars
  const pulse = 0.5 + 0.5 * Math.sin(lt * 12);
  x.beginPath();
  x.arc(-w / 2 + 48, 0, 16 + pulse * 4, 0, Math.PI * 2);
  x.fillStyle = C.coral;
  x.fill();
  for (let b = 0; b < 4; b++) {
    const bh = 8 + Math.abs(Math.sin(lt * 9 + b * 1.7)) * (lt < 1.7 ? 26 : 4);
    rrect(-w / 2 + 78 + b * 9, -bh / 2, 5, bh, 2.5);
    x.fill();
  }
  x.fillStyle = C.text;
  x.fillText(text, -w / 2 + 128, 16);
  x.restore();
}
function label(t: number, s: Shot) {
  if (!s.sub) return;
  const lt = t - s.from;
  const g = x.createLinearGradient(0, H * 0.7, 0, H);
  g.addColorStop(0, "rgba(8,7,6,0)");
  g.addColorStop(1, "rgba(8,7,6,0.75)");
  x.fillStyle = g;
  x.fillRect(0, H * 0.7, W, H * 0.3);
  const u = outCubic(prog(lt, 0.04, 0.25));
  x.save();
  x.globalAlpha = u;
  x.translate(0, (1 - u) * 24);
  font(40, 600);
  const tw = x.measureText(s.sub).width;
  const chipW = s.agent ? 104 : 0;
  const w = tw + 64 + chipW, h = 76, px = 80, py = H - 80 - h;
  rrect(px, py, w, h, h / 2);
  x.fillStyle = "rgba(18,16,14,0.88)";
  x.fill();
  x.strokeStyle = "rgba(255,255,255,0.08)";
  x.lineWidth = 1.5;
  x.stroke();
  if (s.agent) {
    rrect(px + 14, py + 14, 92, 48, 24);
    x.fillStyle = C.agent;
    x.fill();
    font(26, 800, "SFMono");
    x.fillStyle = "#0b0a09";
    x.fillText("MCP", px + 34, py + 47);
  }
  font(40, 600);
  x.fillStyle = C.text;
  x.fillText(s.sub, px + 32 + chipW, py + 52);
  x.restore();
}

// Before / After of the real export.
async function sceneBA(t: number) {
  backdrop(t, 1.2);
  const lt = t - BA.from;
  const ph = 820, pw = Math.round((ph * 9) / 16);
  const gap = 140;
  const ys = (H - ph) / 2 + 40;
  for (const side of [0, 1]) {
    const u = outBack(prog(lt, side * 0.12, 0.45));
    const cx = W / 2 + (side ? 1 : -1) * (pw / 2 + gap / 2);
    const f = await img(side ? afterAt(lt) : beforeAt(lt));
    x.save();
    x.translate(cx, ys + ph / 2 + (1 - u) * 200);
    x.globalAlpha = clamp(u);
    const s = side ? 1 + 0.02 * Math.sin(lt * 2) : 0.94;
    x.scale(s, s);
    x.shadowColor = side ? "rgba(255,90,60,0.35)" : "rgba(20,18,16,0.25)";
    x.shadowBlur = side ? 90 : 40;
    rrect(-pw / 2, -ph / 2, pw, ph, 46);
    x.fillStyle = "#000";
    x.fill();
    x.shadowColor = "transparent";
    x.save();
    rrect(-pw / 2, -ph / 2, pw, ph, 46);
    x.clip();
    if (!side) x.filter = "saturate(0.55) brightness(0.8)";
    x.drawImage(f, -pw / 2, -ph / 2, pw, ph);
    x.filter = "none";
    x.restore();
    x.lineWidth = side ? 5 : 3;
    x.strokeStyle = side ? PAL.coral : "rgba(20,18,16,0.15)";
    rrect(-pw / 2, -ph / 2, pw, ph, 46);
    x.stroke();
    x.restore();
    // labels
    x.save();
    x.globalAlpha = clamp(u);
    font(40, 800, "SFMono");
    const lab = side ? "AFTER" : "BEFORE";
    const lw = x.measureText(lab).width + 44;
    rrect(cx - lw / 2, ys - 92, lw, 62, 31);
    x.fillStyle = side ? PAL.coral : "#dcd6cc";
    x.fill();
    x.fillStyle = side ? "#fff" : "#6b655d";
    x.fillText(lab, cx - lw / 2 + 22, ys - 46);
    x.restore();
  }
  // arrow between
  const au = outCubic(prog(lt, 0.4, 0.3));
  x.save();
  x.globalAlpha = au;
  x.strokeStyle = PAL.coral;
  x.lineWidth = 8;
  x.lineCap = "round";
  x.lineJoin = "round";
  const ay = ys + ph / 2;
  x.beginPath();
  x.moveTo(W / 2 - 36, ay);
  x.lineTo(W / 2 + 30, ay);
  x.moveTo(W / 2 + 6, ay - 26);
  x.lineTo(W / 2 + 32, ay);
  x.lineTo(W / 2 + 6, ay + 26);
  x.stroke();
  x.restore();
  // side notes
  const notes = [
    [0.7, "Speaker cut off", "Reframed", -1],
    [0.95, "“Umm… so the idea is…”", "Clean take", -1],
    [1.2, "No captions", "Pop captions + hook", -1],
  ] as const;
  notes.forEach(([at, b, a], i) => {
    const u = outCubic(prog(lt, at, 0.3));
    if (u <= 0) return;
    x.save();
    x.globalAlpha = u;
    const yy = ys + 200 + i * 150;
    font(34, 600);
    x.fillStyle = "#8d877f";
    const bw = x.measureText(b).width;
    const lx = W / 2 - pw - gap / 2 - 70;
    x.fillText(b, lx - bw + (1 - u) * -30, yy);
    x.fillStyle = PAL.ink;
    font(34, 700);
    x.fillText(a, W / 2 + pw + gap / 2 + 70 + (1 - u) * 30, yy);
    x.fillStyle = PAL.coral;
    x.beginPath();
    x.arc(W / 2 + pw + gap / 2 + 46, yy - 12, 8, 0, Math.PI * 2);
    x.fill();
    x.restore();
  });
}

async function render(t: number) {
  x.globalAlpha = 1;
  x.filter = "none";
  if (t < HERO.from) sceneHook(t);
  else if (t < MONTAGE.from) sceneHero(t);
  else if (t < 6 + P) sceneMontage(t);
  else if (t >= BA.from && t < BA.to) await sceneBA(t);
  else if (t >= END) motionEnd(t, END);
  else if (t >= PUNCH) scenePunch(t, PUNCH);
  else if (t >= RING) sceneRing(t, RING);
  else if (cards.some((c) => t >= c.from && t < c.to)) {
    const c = cards.find((c) => t >= c.from && t < c.to)!;
    motionCard(t, c.from, c.text, c.bg, c.fg, c.num);
  } else {
    const s = shots.find((s) => t >= s.from && t < s.to)!;
    await sceneCapture(t, s);
  }
  finish(t);
}

// ---------------------------------------------------------------- output
const only = process.argv.find((a) => a.startsWith("--only="));
if (only) {
  mkdirSync(join(OUT, "stills"), { recursive: true });
  for (const s of only.slice(7).split(",").map(Number)) {
    await render(s);
    writeFileSync(join(OUT, "stills", `t${s.toFixed(2)}.jpg`), canvas.toBuffer("image/jpeg", 90));
  }
  console.log("stills written");
  process.exit(0);
}
const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, "film-video.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
const total = DUR * FPS;
for (let f = 0; f < total; f++) {
  await render(f / FPS);
  const buf = Buffer.from(x.getImageData(0, 0, W, H).data.buffer);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % 150 === 0) console.log(`frame ${f}/${total}`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log("film-video.mp4 done");
