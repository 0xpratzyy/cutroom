// Composites the launch film: kinetic type, the captured editor in a window with camera moves,
// a before/after of the real export, a feature run and the end card.
// Usage: npx tsx launch/film.mts [--cues] [--only=12.5,16]  ->  launch/out/film.mp4 (+ cues.json)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts, loadImage, type Image, type SKRSContext2D } from "@napi-rs/canvas";

const OUT = "launch/out";
const W = 1920, H = 1080, FPS = 30, DUR = 35;
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
interface Shot {
  kind: "cap";
  from: number;
  to: number;
  c0: number;
  c1: number;
  cam0: Cam;
  cam1: Cam;
  num?: string;
  title: string;
  sub?: string;
  agent?: boolean;
}
const shots: Shot[] = [
  { kind: "cap", from: 6, to: 10, c0: ev["annotate-key"] - 0.35, c1: ev["note1-send"] + 0.3, cam0: { x: 790, y: 330, z: 1.8 }, cam1: { x: 810, y: 335, z: 2.1 }, num: "01", title: "Box it.", sub: "Drag over anything in the frame." },
  { kind: "cap", from: 10, to: 12, c0: ev["note1-send"] + 0.3, c1: ev["agent-resolved-1"] + 1.1, cam0: { x: 985, y: 330, z: 1.3 }, cam1: { x: 1000, y: 330, z: 1.42 }, title: "Claude fixes it.", sub: "Your agent picks up the note over MCP.", agent: true },
  { kind: "cap", from: 12, to: 15, c0: ev["select-down"] - 0.9, c1: ev["note2-send"] + 0.3, cam0: { x: 520, y: 360, z: 1.3 }, cam1: { x: 545, y: 365, z: 1.4 }, num: "02", title: "Select it.", sub: "Highlight words in the transcript." },
  { kind: "cap", from: 15, to: 19, c0: ev["voice-down"] - 0.9, c1: ev["voice-down"] + 3.1, cam0: { x: 760, y: 330, z: 1.85 }, cam1: { x: 750, y: 335, z: 2.15 }, num: "03", title: "Say it.", sub: "Hold V and talk over the video." },
  { kind: "cap", from: 19, to: 22.5, c0: ev["voice-up"] + 0.2, c1: ev["agent-resolved-3"] + 1.0, cam0: { x: 960, y: 360, z: 1.18 }, cam1: { x: 905, y: 340, z: 1.5 }, title: "Claude fixes it.", sub: "Reframed. False start cut. Captions popped.", agent: true },
  { kind: "cap", from: 26, to: 28, c0: ev["palette"] - 0.1, c1: ev["end"], cam0: { x: 715, y: 230, z: 1.55 }, cam1: { x: 715, y: 230, z: 1.75 }, title: "Or just ask.", sub: "⌘K: any action, or a note for Claude." },
];
const BA = { from: 22.5, to: 26 };
const VOICE_AT = 15 + (ev["voice-down"] + 0.33 - (ev["voice-down"] - 0.9));

// ---------------------------------------------------------------- dialogue cues for music.mts
writeFileSync(
  join(OUT, "cues.json"),
  JSON.stringify([
    { file: join(OUT, "capture/voice.wav"), at: VOICE_AT, from: 0.3, dur: 1.6, gain: 1.15 },
    { file: join(OUT, "after.mp4"), at: BA.from, dur: BA.to - BA.from - 0.25, gain: 1.0 },
  ]),
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
  x.fillStyle = C.bg;
  x.fillRect(0, 0, W, H);
  const a = x.createRadialGradient(W * 0.18, H * 0.1, 0, W * 0.18, H * 0.1, W * 0.7);
  a.addColorStop(0, `rgba(255,107,74,${0.16 * glow})`);
  a.addColorStop(1, "rgba(255,107,74,0)");
  x.fillStyle = a;
  x.fillRect(0, 0, W, H);
  const b = x.createRadialGradient(W * 0.88, H * 0.95, 0, W * 0.88, H * 0.95, W * 0.6);
  b.addColorStop(0, `rgba(217,255,74,${0.09 * glow})`);
  b.addColorStop(1, "rgba(217,255,74,0)");
  x.fillStyle = b;
  x.fillRect(0, 0, W, H);
  void t;
}
function finish(t: number) {
  // vignette + grain
  const v = x.createRadialGradient(W / 2, H / 2, H * 0.45, W / 2, H / 2, H * 1.1);
  v.addColorStop(0, "rgba(0,0,0,0)");
  v.addColorStop(1, "rgba(0,0,0,0.45)");
  x.fillStyle = v;
  x.fillRect(0, 0, W, H);
  x.save();
  x.globalAlpha = 0.045;
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

// ---------------------------------------------------------------- scenes
// 0–2: "Stop describing edits."
function sceneStop(t: number) {
  x.fillStyle = "#050505";
  x.fillRect(0, 0, W, H);
  font(150, 800);
  track(-3);
  const words = ["Stop", "describing", "edits."];
  const widths = words.map((w) => x.measureText(w).width);
  const gap = 42;
  const total = widths.reduce((a, b) => a + b, 0) + gap * 2;
  let px = W / 2 - total / 2;
  const zoom = 1 + t * 0.03;
  x.save();
  x.translate(W / 2, H / 2);
  x.scale(zoom, zoom);
  x.translate(-W / 2, -H / 2);
  words.forEach((w, i) => {
    const at = 0.5 + i * 0.5;
    const u = prog(t, at, 0.22);
    if (u > 0) {
      const s = lerp(1.35, 1, outBack(u));
      x.save();
      x.globalAlpha = clamp(u * 2);
      x.translate(px + widths[i] / 2, H / 2 + 50);
      x.scale(s, s);
      x.fillStyle = i === 2 ? C.coral : C.text;
      x.fillText(w, -widths[i] / 2, 0);
      x.restore();
    }
    px += widths[i] + gap;
  });
  x.restore();
  track(0);
}
// 2–4: the describe-it-in-chat pile-up.
const PLEAS = [
  "move the speaker a bit to the left",
  "no, the other left",
  "cut where I say “so the idea is”",
  "the first one, not the second",
  "it's like 0:05 in?",
  "make the captions… pop?",
  "not like that",
  "ugh",
];
function sceneChat(t: number) {
  const lt = t - 2;
  backdrop(t, 0.5);
  const shake = lt > 1.2 ? Math.sin(lt * 90) * (lt - 1.2) * 6 : 0;
  x.save();
  x.translate(shake, 0);
  font(44, 500);
  const shown = Math.min(PLEAS.length, Math.floor(lt / 0.25) + 1);
  const lineH = 104;
  let y = H / 2 + 230;
  for (let i = shown - 1; i >= 0; i--) {
    const u = outBack(prog(lt, i * 0.25, 0.18));
    const text = PLEAS[i];
    const w = x.measureText(text).width + 64;
    const bx = W / 2 + 330 - w;
    x.save();
    x.globalAlpha = clamp(1 - (shown - 1 - i) * 0.13);
    x.translate(bx + w, y);
    x.scale(u, u);
    rrect(-w, -58, w, 84, 34);
    x.fillStyle = i === shown - 1 ? "#2b6cf6" : "#26231f";
    x.fill();
    x.fillStyle = "#fff";
    x.fillText(text, -w + 32, 0);
    x.restore();
    y -= lineH;
  }
  // header
  font(30, 600);
  x.fillStyle = C.dim;
  x.globalAlpha = 1;
  centered("You, describing edits to an AI:", W / 2 - 330 + 170, 140);
  x.restore();
  if (lt > 1.75) {
    x.fillStyle = "#050505";
    x.fillRect(0, 0, W, H);
  }
}
// 4–6: "Just point."
function scenePoint(t: number) {
  const lt = t - 4;
  x.fillStyle = "#050505";
  x.fillRect(0, 0, W, H);
  backdrop(t, clamp(lt * 1.5));
  const zoom = 1 + lt * 0.025;
  x.save();
  x.translate(W / 2, H / 2);
  x.scale(zoom, zoom);
  x.translate(-W / 2, -H / 2);
  font(190, 800);
  track(-4);
  const text = "Just point.";
  const tw = x.measureText(text).width;
  const iconS = 210;
  const gap = 56;
  const total = iconS + gap + tw;
  const ix = W / 2 - total / 2;
  const u = outBack(prog(lt, 0, 0.35));
  x.save();
  x.translate(ix + iconS / 2, H / 2);
  x.scale(u, u);
  x.rotate((1 - u) * -0.4);
  x.shadowColor = "rgba(217,255,74,0.35)";
  x.shadowBlur = 60;
  x.drawImage(icon, -iconS / 2, -iconS / 2, iconS, iconS);
  x.restore();
  const tu = outCubic(prog(lt, 0.25, 0.35));
  x.globalAlpha = tu;
  x.fillStyle = C.text;
  const tx = ix + iconS + gap + (1 - tu) * 40;
  x.fillText(text, tx, H / 2 + 68);
  x.globalAlpha = 1;
  track(0);
  // An annotation box drags around "point." from 0.9s.
  const pw = (() => {
    font(190, 800);
    track(-4);
    const a = x.measureText("Just ").width;
    const b = x.measureText("Just point").width;
    track(0);
    return { a, b };
  })();
  const bx0 = tx + pw.a - 26, by0 = H / 2 - 92, bx1 = tx + pw.b + 34, by1 = H / 2 + 112;
  const du = inOut(prog(lt, 0.9, 0.55));
  if (lt > 0.75) {
    const cx = lerp(bx0, bx1, du), cy = lerp(by0, by1, du);
    if (du > 0) {
      x.save();
      x.fillStyle = "rgba(217,255,74,0.10)";
      x.strokeStyle = C.lime;
      x.lineWidth = 5;
      x.setLineDash([18, 12]);
      x.lineDashOffset = -lt * 60;
      rrect(bx0, by0, cx - bx0, cy - by0, 14);
      x.fill();
      x.stroke();
      x.restore();
    }
    const appear = outCubic(prog(lt, 0.7, 0.2));
    cursor(lerp(bx0 - 160, bx0, appear) + (cx - bx0) * (du > 0 ? 1 : 0), lerp(by0 - 80, by0, appear) + (cy - by0) * (du > 0 ? 1 : 0), 3.2);
    // Note tag
    const nu = outBack(prog(lt, 1.5, 0.25));
    if (nu > 0) {
      x.save();
      x.translate(bx1 - 8, by0 - 8);
      x.scale(nu, nu);
      x.beginPath();
      x.arc(0, 0, 30, 0, Math.PI * 2);
      x.fillStyle = C.coral;
      x.fill();
      font(34, 800);
      x.fillStyle = "#fff";
      centered("1", 0, 12);
      x.restore();
    }
  }
  x.restore();
}

// Captured editor in a window, with camera.
const BASE = 1.2; // film px per window px at zoom 1
async function sceneCapture(t: number, s: Shot) {
  backdrop(t);
  const u = (t - s.from) / (s.to - s.from);
  const c = lerp(s.c0, s.c1, u);
  const e = inOut(u);
  let cam = { x: lerp(s.cam0.x, s.cam1.x, e), y: lerp(s.cam0.y, s.cam1.y, e), z: lerp(s.cam0.z, s.cam1.z, e) };
  // Punch-in on the cut.
  const punch = 1 + 0.07 * Math.pow(1 - prog(t, s.from, 0.35), 3);
  cam = { ...cam, z: cam.z * punch };
  const k = BASE * cam.z;
  // Keep the view inside the window.
  const halfW = W / 2 / k, halfH = H / 2 / k;
  cam.x = halfW * 2 < 1440 ? clamp(cam.x, halfW, 1440 - halfW) : 720;
  cam.y = halfH * 2 < 900 ? clamp(cam.y, halfH, 900 - halfH) : 450;
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
  if (s.num === "03") voiceCaption(t);
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
  const lt = t - s.from;
  const g = x.createLinearGradient(0, H * 0.55, 0, H);
  g.addColorStop(0, "rgba(8,7,6,0)");
  g.addColorStop(1, "rgba(8,7,6,0.92)");
  x.fillStyle = g;
  x.fillRect(0, H * 0.55, W, H * 0.45);
  const u = outCubic(prog(lt, 0.05, 0.35));
  const out = s.to - t < 0.12 ? (s.to - t) / 0.12 : 1;
  x.save();
  x.globalAlpha = u * out;
  x.translate(0, (1 - u) * 40);
  let px = 96;
  const base = H - 128;
  if (s.num || s.agent) {
    font(34, 800, "SFMono");
    const chip = s.agent ? "MCP" : s.num!;
    const cw = x.measureText(chip).width + 40;
    rrect(px, base - 72, cw, 58, 29);
    x.fillStyle = s.agent ? C.agent : C.lime;
    x.fill();
    x.fillStyle = "#0b0a09";
    x.fillText(chip, px + 20, base - 31);
    px += cw + 26;
  }
  font(104, 800);
  track(-1.5);
  x.fillStyle = C.text;
  x.fillText(s.title, px, base);
  track(0);
  if (s.sub) {
    font(38, 500);
    x.fillStyle = "#cfc9c1";
    x.fillText(s.sub, 100, base + 66);
  }
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
    x.shadowColor = side ? "rgba(217,255,74,0.28)" : "rgba(0,0,0,0.6)";
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
    x.strokeStyle = side ? C.lime : "rgba(255,255,255,0.18)";
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
    x.fillStyle = side ? C.lime : "#2a2723";
    x.fill();
    x.fillStyle = side ? "#0b0a09" : "#cfc9c1";
    x.fillText(lab, cx - lw / 2 + 22, ys - 46);
    x.restore();
  }
  // arrow between
  const au = outCubic(prog(lt, 0.4, 0.3));
  x.save();
  x.globalAlpha = au;
  x.strokeStyle = C.lime;
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
    x.fillStyle = C.text;
    font(34, 700);
    x.fillText(a, W / 2 + pw + gap / 2 + 70 + (1 - u) * 30, yy);
    x.fillStyle = C.lime;
    x.beginPath();
    x.arc(W / 2 + pw + gap / 2 + 46, yy - 12, 8, 0, Math.PI * 2);
    x.fill();
    x.restore();
  });
}

// 28–30: feature run.
const FEATURES = [
  ["Pop captions.", C.lime],
  ["Retake finder.", C.text],
  ["Looks & LUTs.", C.coral],
  ["Studio sound.", C.text],
  ["Brand kit.", C.lime],
  ["Voice notes.", C.text],
  ["Runs local.", C.agent],
] as const;
function sceneFeatures(t: number) {
  const lt = t - 28;
  x.fillStyle = "#050505";
  x.fillRect(0, 0, W, H);
  backdrop(t, 0.6);
  const i = Math.min(FEATURES.length - 1, Math.floor(lt / 0.25));
  const u = outBack(prog(lt, i * 0.25, 0.14));
  const [word, color] = FEATURES[i];
  x.save();
  x.translate(W / 2, H / 2);
  const s = lerp(1.5, 1, u) * (1 + (lt - i * 0.25) * 0.15);
  x.scale(s, s);
  font(190, 800);
  track(-4);
  x.fillStyle = color;
  centered(word, 0, 66);
  track(0);
  x.restore();
  if (lt > 1.75) {
    x.fillStyle = "#050505";
    x.fillRect(0, 0, W, H);
  }
}

// 30–35: end card.
function sceneEnd(t: number) {
  const lt = t - 30;
  x.fillStyle = "#050505";
  x.fillRect(0, 0, W, H);
  backdrop(t, 1.3);
  const zoom = 1 + lt * 0.012;
  x.save();
  x.translate(W / 2, H / 2);
  x.scale(zoom, zoom);
  x.translate(-W / 2, -H / 2);
  const iu = outBack(prog(lt, 0, 0.45));
  const iy = 300 - (1 - iu) * 120;
  x.save();
  x.translate(W / 2, iy);
  x.scale(iu, iu);
  x.shadowColor = "rgba(255,107,74,0.45)";
  x.shadowBlur = 90;
  x.drawImage(icon, -130, -130, 260, 260);
  x.restore();
  const wu = outCubic(prog(lt, 0.35, 0.4));
  x.globalAlpha = wu;
  font(150, 800);
  track(-3);
  x.fillStyle = C.text;
  centered("cutroom", W / 2, 580 + (1 - wu) * 30);
  track(0);
  const tu = outCubic(prog(lt, 0.7, 0.4));
  x.globalAlpha = tu;
  font(52, 700);
  x.fillStyle = C.lime;
  centered("Point at it. Claude fixes it.", W / 2, 668 + (1 - tu) * 20);
  const pu = outBack(prog(lt, 1.1, 0.35));
  x.globalAlpha = clamp(pu);
  font(40, 600, "SFMono");
  const cmd = "$ npx cutroom";
  const cw = x.measureText(cmd).width + 64;
  x.save();
  x.translate(W / 2, 790);
  x.scale(pu, pu);
  rrect(-cw / 2, -42, cw, 84, 42);
  x.fillStyle = "#1a1816";
  x.fill();
  x.strokeStyle = "rgba(217,255,74,0.35)";
  x.lineWidth = 2;
  x.stroke();
  x.fillStyle = C.text;
  x.fillText(cmd, -cw / 2 + 32, 14);
  x.restore();
  const gu = outCubic(prog(lt, 1.5, 0.4));
  x.globalAlpha = gu;
  font(32, 500);
  x.fillStyle = C.dim;
  centered("github.com/0xpratzyy/cutroom   ·   open source   ·   runs on your machine", W / 2, 900);
  x.restore();
  x.globalAlpha = 1;
  if (t > 34.4) {
    x.fillStyle = `rgba(0,0,0,${clamp((t - 34.4) / 0.6)})`;
    x.fillRect(0, 0, W, H);
  }
}

async function render(t: number) {
  x.globalAlpha = 1;
  x.filter = "none";
  if (t < 2) sceneStop(t);
  else if (t < 4) sceneChat(t);
  else if (t < 6) scenePoint(t);
  else if (t >= BA.from && t < BA.to) await sceneBA(t);
  else if (t >= 28 && t < 30) sceneFeatures(t);
  else if (t >= 30) sceneEnd(t);
  else {
    const s = shots.find((s) => t >= s.from && t < s.to)!;
    await sceneCapture(t, s);
  }
  // Flash on the drop and the end card.
  for (const at of [4, 6, 30]) {
    const f = 1 - prog(t, at, 0.18);
    if (t >= at && f > 0) {
      x.fillStyle = `rgba(255,255,255,${f * 0.55})`;
      x.fillRect(0, 0, W, H);
    }
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
