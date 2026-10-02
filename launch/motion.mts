// Kinetic scenes for the launch film: the prompt-box gag, the pin as the hero, the "point at
// anything" montage, the 3D type ring, the punchline and the end card. Everything is a pure
// function of time so any frame can be rendered on its own.
import { createCanvas, Path2D, type Canvas, type SKRSContext2D } from "@napi-rs/canvas";

export const PAL = { cream: "#efebe3", ink: "#141210", coral: "#ff5a3c", lime: "#d9ff4a", grey: "#8c867e", violet: "#a78bfa" };
const W = 1920, H = 1080;
let x: SKRSContext2D;
let FONT = "SF", MONO = "SFMono";
export function bindMotion(ctx: SKRSContext2D, fonts: { sans: string; mono: string }) {
  x = ctx;
  FONT = fonts.sans;
  MONO = fonts.mono;
}

// ---------------------------------------------------------------- helpers
export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const outCubic = (u: number) => 1 - Math.pow(1 - clamp(u), 3);
const inCubic = (u: number) => Math.pow(clamp(u), 3);
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
/** Damped spring from 0 to 1 (overshoots). */
export function spring(t: number, freq = 2.4, damp = 0.38) {
  if (t <= 0) return 0;
  const w = 2 * Math.PI * freq, wd = w * Math.sqrt(1 - damp * damp);
  return 1 - Math.exp(-damp * w * t) * (Math.cos(wd * t) + ((damp * w) / wd) * Math.sin(wd * t));
}
const hash = (i: number) => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};
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
function bg(color: string) {
  x.fillStyle = color;
  x.fillRect(0, 0, W, H);
}
function textW(s: string) {
  return x.measureText(s).width;
}

// ---------------------------------------------------------------- the pin (our logo mark)
const PIN_PATH = "M146.3 334.3A150 150 0 1 1 365.7 334.3L256 452Z";
const pins = new Map<string, Canvas>();
function pinCanvas(variant: "coral" | "white" | "ink"): Canvas {
  let c = pins.get(variant);
  if (c) return c;
  c = createCanvas(512, 512);
  const g = c.getContext("2d");
  if (variant === "coral") {
    const gr = g.createLinearGradient(0, 80, 0, 460);
    gr.addColorStop(0, "#ff7a6e");
    gr.addColorStop(1, "#ff4f4f");
    g.fillStyle = gr;
  } else g.fillStyle = variant === "white" ? "#ffffff" : PAL.ink;
  g.fill(new Path2D(PIN_PATH));
  g.globalCompositeOperation = "destination-out";
  g.beginPath();
  g.arc(256, 232, 66, 0, Math.PI * 2);
  g.fill();
  g.beginPath();
  g.moveTo(256, 232);
  g.lineTo(560, -72);
  g.lineTo(700, 232);
  g.closePath();
  g.fill();
  g.globalCompositeOperation = "source-over";
  if (variant === "coral") {
    g.strokeStyle = "#e8f47c";
    g.lineWidth = 7;
    g.lineCap = "round";
    g.beginPath();
    g.moveTo(304, 184);
    g.lineTo(362.6, 125.4);
    g.stroke();
  }
  pins.set(variant, c);
  return c;
}
/** Draw the pin with its tip at (px, py). size = height in px; sx/sy squash and stretch. */
export function pin(px: number, py: number, size: number, o: { sx?: number; sy?: number; rot?: number; variant?: "coral" | "white" | "ink"; alpha?: number; shadow?: boolean } = {}) {
  const k = size / 370;
  x.save();
  x.globalAlpha = o.alpha ?? 1;
  if (o.shadow !== false && py < H + 200) {
    // contact shadow
    x.fillStyle = "rgba(20,18,16,0.12)";
    x.beginPath();
    x.ellipse(px, py + 4, size * 0.28 * (o.sx ?? 1), size * 0.05, 0, 0, Math.PI * 2);
    x.fill();
  }
  x.translate(px, py);
  x.rotate(o.rot ?? 0);
  x.scale((o.sx ?? 1) * k, (o.sy ?? 1) * k);
  x.drawImage(pinCanvas(o.variant ?? "coral"), -256, -452);
  x.restore();
}
/** A bouncing drop: returns the pin's tip y and squash/stretch at time t after release. */
function drop(t: number, fromY: number, floorY: number, landAt: number, e = 0.42) {
  const d = floorY - fromY;
  const g = (2 * d) / (landAt * landAt);
  if (t < landAt) {
    const v = g * t;
    const sy = 1 + Math.min(0.45, v / 14000);
    return { y: fromY + 0.5 * g * t * t, sx: 1 / Math.sqrt(sy), sy, impact: -1 };
  }
  let tt = t - landAt, v = g * landAt * e, n = 0, last = landAt;
  while (v > 300) {
    const dur = (2 * v) / g;
    if (tt < dur) {
      const y = floorY - (v * tt - 0.5 * g * tt * tt);
      const sq = Math.exp(-tt * 40) * 0.32 * Math.pow(e, n);
      return { y, sx: 1 + sq, sy: 1 - sq, impact: last };
    }
    tt -= dur;
    last += dur;
    v *= e;
    n++;
  }
  const sq = Math.exp(-tt * 30) * 0.2 * Math.pow(e, n);
  return { y: floorY, sx: 1 + sq, sy: 1 - sq, impact: last };
}
export function cursorArrow(px: number, py: number, s = 1, color = "#111") {
  x.save();
  x.translate(px, py);
  x.scale(s, s);
  x.shadowColor = "rgba(0,0,0,0.25)";
  x.shadowBlur = 6;
  x.shadowOffsetY = 2;
  x.beginPath();
  x.moveTo(0, 0); x.lineTo(0, 19); x.lineTo(5, 14.5); x.lineTo(8.5, 22); x.lineTo(11.6, 20.6); x.lineTo(8.2, 13.3); x.lineTo(15, 13.3); x.closePath();
  x.fillStyle = color;
  x.fill();
  x.shadowColor = "transparent";
  x.lineWidth = 1.6;
  x.strokeStyle = "#fff";
  x.lineJoin = "round";
  x.stroke();
  x.restore();
}
/** Letters spring up into place one after another. Returns the text width. */
function springText(text: string, left: number, base: number, size: number, t: number, o: { weight?: number; color?: string; stagger?: number; trackPx?: number; family?: string; colors?: (string | undefined)[] } = {}) {
  font(size, o.weight ?? 800, o.family ?? FONT);
  track(o.trackPx ?? -size * 0.035);
  for (let i = 0; i < text.length; i++) {
    const u = spring(t - i * (o.stagger ?? 0.022), 2.6, 0.42);
    if (u <= 0.001) continue;
    const cx = left + textW(text.slice(0, i));
    x.save();
    x.globalAlpha = clamp(u * 2.5);
    x.translate(cx, base + (1 - u) * size * 0.8);
    x.rotate((1 - u) * 0.25);
    x.fillStyle = o.colors?.[i] ?? o.color ?? PAL.ink;
    x.fillText(text[i], 0, 0);
    x.restore();
  }
  const w = textW(text);
  track(0);
  return w;
}
function measure(text: string, size: number, weight = 800, trackPx?: number, family = FONT) {
  font(size, weight, family);
  track(trackPx ?? -size * 0.035);
  const w = textW(text);
  track(0);
  return w;
}

// ---------------------------------------------------------------- 1. the prompt-box gag (0 – 3.5)
const PLEAS = "move me a bit to the left.. no, MY left.. cut at 0:05.. no, the OTHER 0:05.. and make the captions pop?? pls";
export const HOOK = { typeFrom: 0.42, typeTo: 2.15, pop: 2.5 };
function wrap(text: string, maxW: number): string[] {
  const words = text.split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (textW(next) > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}
export function sceneHook(t: number) {
  bg(PAL.cream);
  const cy = H / 2 + 10;
  const size = 54, lineH = 74;
  font(size, 600);
  const n = Math.floor(clamp((t - HOOK.typeFrom) / (HOOK.typeTo - HOOK.typeFrom)) * PLEAS.length);
  const typed = PLEAS.slice(0, n);
  const maxText = 1320;
  const lines = typed ? wrap(typed, maxText) : [];
  const widest = Math.max(0, ...lines.map((l) => textW(l)));
  const fieldW = Math.max(880, Math.min(maxText, widest) + 230);
  const fieldH = Math.max(128, lines.length * lineH + 54);
  // caption
  font(40, 500, MONO);
  x.fillStyle = "#6b655d";
  const cap = "you, editing a video with a chatbot:";
  x.globalAlpha = clamp(t / 0.2) * (t < HOOK.pop ? 1 : clamp(1 - (t - HOOK.pop) / 0.3));
  x.fillText(cap, W / 2 - textW(cap) / 2, cy - fieldH / 2 - 60);
  x.globalAlpha = 1;
  // tension: wobble grows as it fills up, then it inflates and bursts
  const strain = clamp((t - 1.2) / 1.0);
  const inflate = inCubic(clamp((t - 2.18) / (HOOK.pop - 2.18)));
  const textLeft = -fieldW / 2 + 70;
  const textTop = -fieldH / 2 + 27 + lineH * 0.72;
  if (t < HOOK.pop) {
    x.save();
    x.translate(W / 2 + Math.sin(t * 61) * strain * 6 + Math.sin(t * 93) * inflate * 10, cy);
    x.rotate(Math.sin(t * 23) * strain * 0.014);
    x.scale(1 + inflate * 0.08, 1 + inflate * 0.3);
    x.shadowColor = "rgba(20,18,16,0.12)";
    x.shadowBlur = 40;
    x.shadowOffsetY = 14;
    rrect(-fieldW / 2, -fieldH / 2, fieldW, fieldH, Math.min(64, fieldH / 2));
    const red = clamp(strain * 0.6 + inflate);
    x.fillStyle = `rgb(255,${Math.round(255 - red * 40)},${Math.round(255 - red * 52)})`;
    x.fill();
    x.shadowColor = "transparent";
    x.lineWidth = 2;
    x.strokeStyle = `rgba(255,90,60,${0.15 + red * 0.6})`;
    x.stroke();
    font(size, 600);
    if (!typed) {
      x.fillStyle = "#b5afa6";
      x.fillText("Describe your edit…", textLeft, size * 0.35);
    } else {
      x.fillStyle = PAL.ink;
      lines.forEach((l, k) => x.fillText(l, textLeft, textTop + k * lineH));
      const last = lines[lines.length - 1];
      if (Math.floor(t * 4) % 2 === 0) x.fillRect(textLeft + textW(last) + 4, textTop + (lines.length - 1) * lineH - size * 0.8, 3, size * 0.95);
    }
    // send button
    const by = fieldH / 2 - 64;
    x.beginPath();
    x.arc(fieldW / 2 - 64, by, 40, 0, Math.PI * 2);
    x.fillStyle = PAL.ink;
    x.fill();
    x.strokeStyle = "#fff";
    x.lineWidth = 6;
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(fieldW / 2 - 64, by + 16); x.lineTo(fieldW / 2 - 64, by - 16);
    x.moveTo(fieldW / 2 - 78, by - 2); x.lineTo(fieldW / 2 - 64, by - 16); x.lineTo(fieldW / 2 - 50, by - 2);
    x.stroke();
    x.restore();
    // cursor clicks into the field
    const cu = outCubic(t / 0.3);
    const clickX = W / 2 - 300, clickY = cy + 20;
    if (t > 0.22 && t < 0.5) {
      const r = outCubic((t - 0.22) / 0.28);
      x.strokeStyle = `rgba(255,90,60,${1 - r})`;
      x.lineWidth = 3;
      x.beginPath();
      x.arc(clickX, clickY, 10 + r * 30, 0, Math.PI * 2);
      x.stroke();
    }
    cursorArrow(lerp(W * 0.8, clickX, cu), lerp(H * 0.95, clickY + fieldH / 2 + 10, cu), 2.2);
  } else {
    const u = (t - HOOK.pop) / 0.35;
    if (u < 1) {
      x.strokeStyle = `rgba(255,90,60,${1 - u})`;
      x.lineWidth = 18 * (1 - u) + 1;
      x.beginPath();
      x.ellipse(W / 2, cy, 300 + u * 900, 120 + u * 420, 0, 0, Math.PI * 2);
      x.stroke();
    }
    const tt = t - HOOK.pop;
    for (let i = 0; i < 26; i++) {
      const a = hash(i) * Math.PI * 2, sp = 500 + hash(i + 50) * 1100;
      const px = W / 2 + Math.cos(a) * sp * tt, py = cy + Math.sin(a) * sp * tt * 0.6 + 1600 * tt * tt;
      x.fillStyle = i % 3 === 0 ? PAL.coral : i % 3 === 1 ? PAL.ink : PAL.lime;
      x.beginPath();
      x.arc(px, py, 7 + hash(i + 9) * 8, 0, Math.PI * 2);
      x.fill();
    }
    // the letters fall out of the frame
    font(size, 600);
    const all = wrap(PLEAS, maxText);
    let idx = 0;
    all.forEach((line, k) => {
      for (let c = 0; c < line.length; c++, idx++) {
        const ch = line[c];
        if (ch === " ") continue;
        const lx = W / 2 + textLeft + textW(line.slice(0, c));
        const ly = cy + textTop + k * lineH;
        const vx = (lx - W / 2) * 0.9 + (hash(idx) - 0.5) * 500;
        const vy = -(250 + hash(idx + 100) * 850);
        const px = lx + vx * tt, py = ly + vy * tt + 0.5 * 3600 * tt * tt;
        if (py > H + 100) continue;
        x.save();
        x.translate(px, py);
        x.rotate((hash(idx + 200) - 0.5) * 14 * tt);
        x.fillStyle = PAL.ink;
        x.fillText(ch, 0, 0);
        x.restore();
      }
      idx++;
    });
  }
}

// ---------------------------------------------------------------- 2. the hero (3.5 – 6)
export const HERO = { from: 3.5, land: 0.25, words: 4.0, swap: 5.0, hopLand: 5.32, zoom: 5.55, to: 6.0 };
export function sceneHero(t: number) {
  bg(PAL.cream);
  const lt = t - HERO.from;
  const size = 170;
  const base = H / 2 + 70;
  // Layout: "Stop describing" + pin as the full stop.
  const w1 = measure("Stop describing", size);
  const pinSize = 150;
  const total1 = w1 + 30 + pinSize * 0.6;
  const left1 = W / 2 - total1 / 2;
  const stopX = left1 + w1 + 30 + pinSize * 0.3;
  // Layout: "Just point." with the pin as the dot of the i.
  const w2 = measure("Just point.", size);
  const left2 = W / 2 - w2 / 2;
  const iX = left2 + measure("Just po", size) + measure("ı", size) / 2;
  const dotSize = 92;
  const dotY = base - size * 0.74;

  let px = stopX, py = base, ps = pinSize, sx = 1, sy = 1, rot = 0;
  if (lt < HERO.swap - HERO.from) {
    const d = drop(lt, -260, base, HERO.land);
    py = d.y; sx = d.sx; sy = d.sy;
  } else {
    // hop from the full stop onto the i
    const u = clamp((t - HERO.swap) / (HERO.hopLand - HERO.swap));
    px = lerp(stopX, iX, inOut(u));
    py = lerp(base, dotY, u) - Math.sin(Math.PI * u) * 260;
    ps = lerp(pinSize, dotSize, outCubic(u));
    rot = Math.sin(Math.PI * u) * -0.5;
    if (u >= 1) {
      const sq = Math.exp(-(t - HERO.hopLand) * 26) * 0.35;
      sx = 1 + sq; sy = 1 - sq;
    } else {
      sy = 1 + Math.sin(Math.PI * u) * 0.15;
      sx = 1 / sy;
    }
  }
  // words
  if (t < HERO.swap + 0.16) {
    const out = clamp((t - HERO.swap) / 0.16);
    x.save();
    x.globalAlpha = 1 - out;
    x.translate(0, inCubic(out) * 300);
    springText("Stop describing", left1, base, size, t - HERO.words, { stagger: 0.03 });
    x.restore();
  }
  if (t >= HERO.swap) {
    // "Just po" + dotless i (ı) + "nt."
    const s = "Just poınt.";
    springText(s, left2, base, size, t - HERO.swap - 0.12, { stagger: 0.022 });
  }
  // zoom into the pin → coral fills the frame
  const z = inCubic(clamp((t - HERO.zoom) / (HERO.to - HERO.zoom)));
  if (z > 0) {
    x.save();
    const k = 1 + z * 40;
    x.translate(px, py - ps * 0.55);
    x.scale(k, k);
    x.translate(-px, -(py - ps * 0.55));
    pin(px, py, ps, { sx, sy, rot, shadow: false });
    x.restore();
    if (z > 0.85) {
      x.fillStyle = `rgba(255,90,60,${(z - 0.85) / 0.15})`;
      x.fillRect(0, 0, W, H);
    }
  } else pin(px, py, ps, { sx, sy, rot });
}

// ---------------------------------------------------------------- 3. point at anything (6 – 9)
export const MONTAGE = { from: 6, step: 0.75 };
export function sceneMontage(t: number) {
  const lt = t - MONTAGE.from;
  const i = Math.floor(lt / MONTAGE.step);
  const u = (lt - i * MONTAGE.step) / MONTAGE.step;
  const st = lt - i * MONTAGE.step;
  if (i === 0) montageFrame(st, u);
  else if (i === 1) montageWords(st, u);
  else if (i === 2) montageVoice(st, u);
  else montageClaude(st, u);
}
function label(text: string, color: string, st: number, rightAlign = false) {
  const size = 120;
  const w = measure(text, size);
  const left = rightAlign ? W - 140 - w : 140;
  springText(text, left, H - 150, size, st, { color, stagger: 0.015 });
}
function montageFrame(st: number, u: number) {
  bg(PAL.coral);
  const fh = 640, fw = fh * 9 / 16, fx = 360, fy = (H - fh) / 2 - 60;
  // the speaker, cut off at the left edge — then centered once boxed
  const fix = outCubic(clamp((st - 0.5) / 0.2));
  x.save();
  rrect(fx, fy, fw, fh, 28);
  x.clip();
  x.fillStyle = "rgba(255,255,255,0.12)";
  x.fillRect(fx, fy, fw, fh);
  const hx = lerp(fx + 20, fx + fw / 2, fix);
  x.fillStyle = PAL.ink;
  x.beginPath();
  x.arc(hx, fy + 260, 86, 0, Math.PI * 2);
  x.fill();
  x.beginPath();
  x.ellipse(hx, fy + fh + 40, 200, 230, 0, Math.PI, 0);
  x.fill();
  x.restore();
  x.strokeStyle = "#fff";
  x.lineWidth = 6;
  rrect(fx, fy, fw, fh, 28);
  x.stroke();
  // the white pin drags a box around the head
  const bx0 = fx - 10, by0 = fy + 150, bx1 = fx + 140, by1 = fy + 380;
  const du = inOut(clamp((st - 0.12) / 0.3));
  if (st < 0.55) {
    if (du > 0) {
      x.save();
      x.setLineDash([16, 10]);
      x.strokeStyle = "#fff";
      x.lineWidth = 5;
      rrect(bx0, by0, (bx1 - bx0) * du, (by1 - by0) * du, 12);
      x.stroke();
      x.restore();
    }
    const pxp = lerp(bx0, bx1, du), pyp = lerp(by0, by1, du);
    pin(pxp + 26, pyp + 10, 90, { variant: "white", shadow: false, rot: -0.3 });
  } else {
    // check mark pops
    const cu = spring(st - 0.55, 3, 0.4);
    x.save();
    x.translate(fx + fw - 50, fy + 50);
    x.scale(cu, cu);
    x.beginPath();
    x.arc(0, 0, 34, 0, Math.PI * 2);
    x.fillStyle = PAL.lime;
    x.fill();
    x.strokeStyle = PAL.ink;
    x.lineWidth = 7;
    x.lineCap = "round";
    x.beginPath();
    x.moveTo(-14, 0); x.lineTo(-4, 11); x.lineTo(15, -12);
    x.stroke();
    x.restore();
  }
  label("Point at the frame.", PAL.ink, st, true);
  void u;
}
function montageWords(st: number, u: number) {
  bg(PAL.ink);
  const size = 92;
  const a = "so the idea is…", b = " so the idea is really simple.";
  font(size, 700);
  track(-2);
  const wa = textW(a);
  const total = textW(a + b);
  const collapse = outCubic(clamp((st - 0.48) / 0.2));
  const left = W / 2 - lerp(total, total - wa, collapse) / 2;
  const y = H / 2 - 40;
  // marker swipe over the false start
  const sw = outCubic(clamp((st - 0.08) / 0.22));
  x.fillStyle = PAL.coral;
  x.globalAlpha = 1 - collapse;
  x.fillRect(left - 10, y - size * 0.78, (wa + 20) * sw, size * 1.02);
  x.globalAlpha = (1 - collapse) * 1;
  x.fillStyle = "#fff";
  x.fillText(a, left, y);
  if (st > 0.32) {
    x.fillRect(left, y - size * 0.3, wa * clamp((st - 0.32) / 0.12), 6);
  }
  x.globalAlpha = 1;
  x.fillStyle = "#fff";
  x.fillText(b.trimStart(), left + lerp(textW(a + " "), 0, collapse), y);
  track(0);
  pin(left + wa * sw + 30, y - size * 0.1, 84, { variant: "white", shadow: false, rot: -0.25, alpha: 1 - collapse });
  label("Or the words.", "#fff", st);
  void u;
}
function montageVoice(st: number, u: number) {
  bg(PAL.cream);
  const cx = W / 2, cy = H / 2 - 60;
  // sound rings
  for (let k = 0; k < 3; k++) {
    const r = ((st * 1.6 + k / 3) % 1);
    x.strokeStyle = `rgba(255,90,60,${(1 - r) * 0.6})`;
    x.lineWidth = 6;
    x.beginPath();
    x.arc(cx, cy - 60, 90 + r * 260, 0, Math.PI * 2);
    x.stroke();
  }
  // waveform
  const bars = 44;
  for (let b = 0; b < bars; b++) {
    const bxp = cx - 620 + b * 29;
    if (Math.abs(bxp - cx) < 120) continue;
    const h = 18 + Math.abs(Math.sin(st * 14 + b * 0.7) * Math.sin(b * 0.33 + st * 5)) * 150 * (1 - Math.abs(b - bars / 2) / bars);
    x.fillStyle = PAL.ink;
    rrect(bxp, cy - 60 - h / 2, 14, h, 7);
    x.fill();
  }
  const s = 1 + Math.sin(st * 30) * 0.04;
  pin(cx, cy + 40, 200, { sx: s, sy: 2 - s, shadow: false });
  label("Or just say it.", PAL.ink, st);
  void u;
}
function montageClaude(st: number, u: number) {
  bg(PAL.violet);
  const size = 190;
  const text = "Claude fixes it.";
  const w = measure(text, size);
  springText(text, W / 2 - w / 2, H / 2 + 60, size, st, { stagger: 0.02 });
  font(40, 600, MONO);
  x.fillStyle = "rgba(20,18,16,0.6)";
  const sub = "live, while you watch";
  x.globalAlpha = clamp((st - 0.2) / 0.15);
  x.fillText(sub, W / 2 - textW(sub) / 2, H / 2 + 170);
  x.globalAlpha = 1;
  void u;
}

// ---------------------------------------------------------------- beat cards (in the product section)
export function sceneCard(t: number, from: number, text: string, bgc: string, fg: string, num?: string) {
  bg(bgc);
  const lt = t - from;
  const size = text.length > 12 ? 200 : 260;
  const w = measure(text, size);
  const left = W / 2 - w / 2 - 50;
  const base = H / 2 + size * 0.34;
  springText(text, left, base, size, lt, { color: fg, stagger: 0.018 });
  // the pin is the full stop
  const d = drop(lt - 0.05, -200, base, 0.16);
  pin(left + w + 60, d.y, size * 0.55, { sx: d.sx, sy: d.sy, variant: bgc === PAL.coral ? "white" : "coral", shadow: false });
  if (num) {
    font(44, 700, MONO);
    x.fillStyle = fg;
    x.globalAlpha = 0.55 * clamp(lt / 0.1);
    x.fillText(num, left, base - size * 0.95);
    x.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------- 4. the 3D type ring
export function sceneRing(t: number, from: number) {
  const lt = t - from;
  bg(PAL.ink);
  const text = "BOX IT · SELECT IT · SAY IT · CLAUDE FIXES IT · ";
  const n = text.length;
  const R = 780, tilt = 0.3 + Math.sin(lt * 0.9) * 0.06;
  const spin = -lt * 0.9 - 0.6;
  const cx = W / 2, cy = H / 2;
  const enter = spring(lt, 1.6, 0.5);
  font(124, 900);
  const glyphs = [...text].map((ch, i) => {
    const a = spin + (i / n) * Math.PI * 2;
    return { ch, a, z: Math.cos(a) };
  });
  const drawGlyph = (g: { ch: string; a: number; z: number }) => {
    const px = cx + Math.sin(g.a) * R * enter;
    const py = cy + g.z * R * tilt * enter - 20;
    const depth = (g.z + 1) / 2; // 0 back … 1 front
    x.save();
    x.translate(px, py);
    const s = 0.5 + depth * 0.55;
    // back half reads mirrored, like type wrapped around a cylinder
    x.scale(s * Math.cos(g.a) * 1.0, s);
    x.globalAlpha = 0.25 + depth * 0.75;
    x.fillStyle = g.ch === "·" ? PAL.coral : "#f5f2ee";
    const w = textW(g.ch);
    x.fillText(g.ch, -w / 2, 38);
    x.restore();
  };
  for (const g of glyphs.filter((g) => g.z < 0)) drawGlyph(g);
  const bob = Math.sin(lt * 4) * 14;
  pin(cx, cy + 110 + bob, 230 * enter, { shadow: false, rot: Math.sin(lt * 2) * 0.08 });
  for (const g of glyphs.filter((g) => g.z >= 0)) drawGlyph(g);
}

// ---------------------------------------------------------------- 5. the punchline
export function scenePunch(t: number, from: number) {
  const lt = t - from;
  bg(PAL.ink);
  const left = 220;
  font(46, 600);
  x.fillStyle = PAL.grey;
  x.globalAlpha = clamp(lt / 0.25);
  x.fillText("cutroom", left + 64, 380);
  x.globalAlpha = 1;
  pin(left + 22, 392, 52, { shadow: false, alpha: clamp(lt / 0.25) });
  springText("Video editor.", left, 560, 170, lt - 0.25, { color: "#f5f2ee", stagger: 0.025 });
  const colors = [PAL.coral];
  springText("0 timelines.", left, 760, 170, lt - 1.25, { color: "#f5f2ee", stagger: 0.03, colors });
}

// ---------------------------------------------------------------- 6. the end card
export function sceneEnd(t: number, from: number) {
  const lt = t - from;
  bg(PAL.cream);
  const size = 190;
  const w = measure("cutroom", size, 800);
  const pinS = 210;
  const total = pinS * 0.8 + 40 + w;
  const left = W / 2 - total / 2;
  const base = H / 2 + 20;
  const d = drop(lt, -300, base + 10, 0.3);
  pin(left + pinS * 0.4, d.y, pinS, { sx: d.sx, sy: d.sy });
  springText("cutroom", left + pinS * 0.8 + 40, base, size, lt - 0.3, { stagger: 0.03 });
  const tu = outCubic(clamp((lt - 0.8) / 0.35));
  x.globalAlpha = tu;
  font(52, 600);
  x.fillStyle = "#5d5852";
  const tag = "Point at it. Claude fixes it.";
  x.fillText(tag, W / 2 - textW(tag) / 2, base + 120 + (1 - tu) * 20);
  const pu = spring(lt - 1.2, 2.2, 0.45);
  if (pu > 0) {
    x.save();
    x.translate(W / 2, base + 250);
    x.scale(pu, pu);
    font(46, 600, MONO);
    const cmd = "$ npx cutroom";
    const cw = textW(cmd) + 80;
    rrect(-cw / 2, -48, cw, 96, 48);
    x.fillStyle = PAL.ink;
    x.fill();
    x.fillStyle = PAL.lime;
    x.fillText(cmd, -cw / 2 + 40, 16);
    x.restore();
  }
  x.globalAlpha = clamp((lt - 1.6) / 0.3);
  font(32, 500);
  x.fillStyle = PAL.grey;
  const url = "github.com/0xpratzyy/cutroom  ·  open source  ·  runs on your machine";
  x.fillText(url, W / 2 - textW(url) / 2, H - 90);
  x.globalAlpha = 1;
}
