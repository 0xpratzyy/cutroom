// Title scenes for the launch film, in a restrained style: near-black, one accent colour,
// blur-in type with expo easing, no bounce. Every scene is a pure function of time.
import type { Image, SKRSContext2D } from "@napi-rs/canvas";

export const INK = "#060607";
export const CORAL = "#ff5f4f";
const W = 1920, H = 1080;
let x: SKRSContext2D;
let SANS = "SF", MONO = "SFMono";
let icon: Image;
export function bindPremium(ctx: SKRSContext2D, o: { sans: string; mono: string; icon: Image }) {
  x = ctx;
  SANS = o.sans;
  MONO = o.mono;
  icon = o.icon;
}

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
export const expo = (u: number) => (u >= 1 ? 1 : 1 - Math.pow(2, -10 * clamp(u)));
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * clamp(u) + 2, 3) / 2);
const prog = (t: number, a: number, d: number) => clamp((t - a) / d);

function font(size: number, weight = 600, family = SANS) {
  x.font = `${weight} ${size}px ${family}`;
}
function track(px: number) {
  (x as unknown as { letterSpacing: string }).letterSpacing = `${px}px`;
}
function rrect(px: number, py: number, w: number, h: number, r: number) {
  x.beginPath();
  x.roundRect(px, py, w, h, r);
}

/** Near-black stage with a faint warm light from above. */
export function stage(glow = 1) {
  x.fillStyle = INK;
  x.fillRect(0, 0, W, H);
  if (glow <= 0) return;
  const g = x.createRadialGradient(W / 2, -H * 0.25, 0, W / 2, -H * 0.25, H * 1.25);
  g.addColorStop(0, `rgba(255,236,220,${0.075 * glow})`);
  g.addColorStop(1, "rgba(255,236,220,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
}

/**
 * A line of type that resolves out of a blur. `at` is when it starts; it can also leave
 * (blur out, drift up) from `leave`. Returns the line width.
 */
export function line(text: string, cx: number, base: number, size: number, t: number, at: number, o: { weight?: number; color?: string; leave?: number; align?: "center" | "left"; dim?: boolean; runs?: { text: string; color: string }[] } = {}) {
  const u = expo(prog(t, at, 0.9));
  const out = o.leave !== undefined ? inOut(prog(t, o.leave, 0.45)) : 0;
  if (u <= 0 || out >= 1) return 0;
  font(size, o.weight ?? 600);
  track(-size * 0.025);
  const runs = o.runs ?? [{ text, color: o.color ?? "#f4f2ef" }];
  const full = runs.map((r) => r.text).join("");
  const w = x.measureText(full).width;
  const left = o.align === "left" ? cx : cx - w / 2;
  x.save();
  x.globalAlpha = u * (1 - out);
  const blur = (1 - u) * 18 + out * 14;
  if (blur > 0.3) x.filter = `blur(${blur.toFixed(1)}px)`;
  const dy = (1 - u) * 26 - out * 20;
  let px = left;
  for (const r of runs) {
    if (r.color === "gradient") {
      const g = x.createLinearGradient(0, base - size, 0, base + size * 0.2);
      g.addColorStop(0, "#ffffff");
      g.addColorStop(1, "#b9b5b0");
      x.fillStyle = g;
    } else x.fillStyle = r.color;
    x.fillText(r.text, px, base + dy);
    px += x.measureText(r.text).width;
  }
  x.restore();
  track(0);
  return w;
}

function cursor(px: number, py: number, s = 1) {
  x.save();
  x.translate(px, py);
  x.scale(s, s);
  x.shadowColor = "rgba(0,0,0,0.45)";
  x.shadowBlur = 10;
  x.shadowOffsetY = 3;
  x.beginPath();
  x.moveTo(0, 0); x.lineTo(0, 19); x.lineTo(5, 14.5); x.lineTo(8.5, 22); x.lineTo(11.6, 20.6); x.lineTo(8.2, 13.3); x.lineTo(15, 13.3); x.closePath();
  x.fillStyle = "#fff";
  x.fill();
  x.shadowColor = "transparent";
  x.lineWidth = 1.3;
  x.strokeStyle = "#111";
  x.lineJoin = "round";
  x.stroke();
  x.restore();
}

// ---------------------------------------------------------------- 1. the problem
export const OPEN = { from: 0, to: 2.8 };
export function sceneOpen(t: number) {
  stage();
  line("Editing video with AI", W / 2, H / 2 - 30, 92, t, 0.15, { leave: 2.25, runs: [{ text: "Editing video with AI", color: "gradient" }] });
  line("means describing every edit.", W / 2, H / 2 + 80, 92, t, 0.75, { leave: 2.3, runs: [{ text: "means describing every edit.", color: "#7d7973" }] });
}

// ---------------------------------------------------------------- 2. describing it
export const PROMPT = { from: 2.8, to: 5.6, typeFrom: 3.15, typeTo: 4.55, selectAt: 4.8, deleteAt: 5.1 };
const ASK = "move the speaker a bit to the left… no, the other left…";
export function scenePrompt(t: number) {
  stage();
  const lt = t - PROMPT.from;
  const appear = expo(prog(lt, 0, 0.7));
  const leave = inOut(prog(t, PROMPT.to - 0.35, 0.35));
  const fw = 1240, fh = 112, fx = (W - fw) / 2, fy = H / 2 - fh / 2;
  x.save();
  x.globalAlpha = appear * (1 - leave);
  x.translate(0, (1 - appear) * 30);
  // glass field
  x.shadowColor = "rgba(0,0,0,0.6)";
  x.shadowBlur = 60;
  x.shadowOffsetY = 20;
  rrect(fx, fy, fw, fh, fh / 2);
  const g = x.createLinearGradient(0, fy, 0, fy + fh);
  g.addColorStop(0, "rgba(255,255,255,0.075)");
  g.addColorStop(1, "rgba(255,255,255,0.035)");
  x.fillStyle = g;
  x.fill();
  x.shadowColor = "transparent";
  x.lineWidth = 1.5;
  x.strokeStyle = "rgba(255,255,255,0.13)";
  x.stroke();
  // send button
  x.beginPath();
  x.arc(fx + fw - 56, fy + fh / 2, 30, 0, Math.PI * 2);
  x.fillStyle = "rgba(255,255,255,0.9)";
  x.fill();
  x.strokeStyle = INK;
  x.lineWidth = 4;
  x.lineCap = "round";
  x.beginPath();
  x.moveTo(fx + fw - 56, fy + fh / 2 + 11); x.lineTo(fx + fw - 56, fy + fh / 2 - 11);
  x.moveTo(fx + fw - 66, fy + fh / 2 - 1); x.lineTo(fx + fw - 56, fy + fh / 2 - 11); x.lineTo(fx + fw - 46, fy + fh / 2 - 1);
  x.stroke();
  // text
  font(40, 500);
  track(-0.5);
  const n = Math.floor(clamp((t - PROMPT.typeFrom) / (PROMPT.typeTo - PROMPT.typeFrom)) * ASK.length);
  const deleted = t >= PROMPT.deleteAt;
  const typed = deleted ? "" : ASK.slice(0, n);
  const tx = fx + 52, ty = fy + fh / 2 + 14;
  if (!typed) {
    x.fillStyle = "rgba(255,255,255,0.32)";
    x.fillText("Ask AI to edit your video…", tx, ty);
  } else {
    const w = x.measureText(typed).width;
    if (t >= PROMPT.selectAt) {
      x.fillStyle = "rgba(90,140,255,0.45)";
      x.fillRect(tx - 4, ty - 36, w + 8, 50);
    }
    x.fillStyle = "#f4f2ef";
    x.fillText(typed, tx, ty);
  }
  const caretX = tx + (typed ? x.measureText(typed).width + 3 : 0);
  if (Math.floor(t * 2.2) % 2 === 0 || (t > PROMPT.typeFrom && t < PROMPT.typeTo)) {
    x.fillStyle = "rgba(255,255,255,0.85)";
    x.fillRect(caretX, ty - 34, 2.5, 44);
  }
  track(0);
  x.restore();
}

// ---------------------------------------------------------------- 3. the turn
export const REVEAL = { from: 5.6, to: 8.4 };
export function sceneReveal(t: number) {
  stage(1.4);
  const lt = t - REVEAL.from;
  const leave = REVEAL.to - 0.45 - REVEAL.from;
  const size = 104;
  const base = H / 2 + 10;
  // measure "point" inside the sentence
  font(size, 600);
  track(-size * 0.025);
  const pre = "What if you could just ", word = "point", post = "?";
  const wPre = x.measureText(pre).width, wWord = x.measureText(word).width, wAll = x.measureText(pre + word + post).width;
  track(0);
  const left = W / 2 - wAll / 2;
  const hot = expo(prog(lt, 1.55, 0.5));
  const wordColor = hot > 0 ? `rgb(${Math.round(lerp(244, 255, hot))},${Math.round(lerp(242, 95, hot))},${Math.round(lerp(239, 79, hot))})` : "#f4f2ef";
  line("", W / 2, base, size, lt, 0.1, { leave, runs: [{ text: pre, color: "gradient" }, { text: word, color: wordColor }, { text: post, color: "gradient" }] });
  // the cursor drags a box around "point"
  const bx0 = left + wPre - 18, by0 = base - size * 0.86, bx1 = left + wPre + wWord + 18, by1 = base + size * 0.3;
  const fade = 1 - inOut(prog(lt, leave, 0.45));
  const come = expo(prog(lt, 0.75, 0.6));
  const drag = inOut(prog(lt, 1.1, 0.5));
  if (come > 0) {
    const cx = drag > 0 ? lerp(bx0, bx1, drag) : lerp(bx0 + 340, bx0, come);
    const cy = drag > 0 ? lerp(by0, by1, drag) : lerp(by0 + 260, by0, come);
    x.save();
    x.globalAlpha = fade;
    if (drag > 0) {
      x.fillStyle = `rgba(255,95,79,${0.1 * drag})`;
      x.strokeStyle = "rgba(255,255,255,0.85)";
      x.lineWidth = 2;
      rrect(bx0, by0, cx - bx0, cy - by0, 10);
      x.fill();
      x.stroke();
      if (drag >= 1) {
        x.fillStyle = CORAL;
        for (const [hx, hy] of [[bx0, by0], [bx1, by0], [bx0, by1], [bx1, by1]]) {
          x.beginPath();
          x.arc(hx, hy, 6, 0, Math.PI * 2);
          x.fill();
        }
      }
    }
    cursor(cx, cy, 2.4);
    x.restore();
  }
  // the name, quietly
  const nu = expo(prog(lt, 1.9, 0.8));
  if (nu > 0) {
    x.save();
    x.globalAlpha = nu * fade;
    const iy = base + 120 + (1 - nu) * 16;
    font(38, 600);
    track(-0.8);
    const nw = x.measureText("cutroom").width;
    const total = 48 + 14 + nw;
    const ix = W / 2 - total / 2;
    x.drawImage(icon, ix, iy, 48, 48);
    x.fillStyle = "#d9d5cf";
    x.fillText("cutroom", ix + 62, iy + 36);
    track(0);
    x.restore();
  }
}

// ---------------------------------------------------------------- 4. what it is
export function sceneWhat(t: number, from: number, to: number) {
  stage(1.2);
  const lt = t - from;
  const leave = to - from - 0.45;
  line("", W / 2, H / 2 - 120, 84, lt, 0.1, { leave, runs: [{ text: "cutroom is a video editor ", color: "gradient" }, { text: "built for Claude.", color: "#f4f2ef" }] });
  line("", W / 2, H / 2 - 30, 40, lt, 0.6, { weight: 500, leave, runs: [{ text: "You point at what's wrong. Claude makes the edit, over MCP.", color: "#8d8983" }] });
  // cutroom ⟷ MCP ⟷ Claude
  const u = expo(prog(lt, 1.0, 0.9));
  const out = inOut(prog(lt, leave, 0.45));
  if (u <= 0 || out >= 1) return;
  x.save();
  x.globalAlpha = u * (1 - out);
  const cy = H / 2 + 130;
  const lx = W / 2 - 330, rx = W / 2 + 330;
  // left node: the app
  x.drawImage(icon, lx - 44, cy - 44, 88, 88);
  font(30, 600);
  track(-0.5);
  x.fillStyle = "#d9d5cf";
  let w = x.measureText("cutroom").width;
  x.fillText("cutroom", lx - w / 2, cy + 86);
  // right node: Claude
  rrect(rx - 44, cy - 44, 88, 88, 24);
  x.fillStyle = "rgba(255,255,255,0.06)";
  x.fill();
  x.strokeStyle = "rgba(255,255,255,0.16)";
  x.lineWidth = 1.5;
  x.stroke();
  font(40, 600);
  x.fillStyle = "#f4f2ef";
  w = x.measureText("C").width;
  x.fillText("C", rx - w / 2, cy + 14);
  font(30, 600);
  x.fillStyle = "#d9d5cf";
  w = x.measureText("Claude").width;
  x.fillText("Claude", rx - w / 2, cy + 86);
  track(0);
  // the link, drawn left to right, with notes travelling one way and edits the other
  const a = lx + 70, b = rx - 70;
  const draw = expo(prog(lt, 1.2, 0.8));
  x.strokeStyle = "rgba(255,255,255,0.22)";
  x.lineWidth = 2;
  x.setLineDash([6, 8]);
  x.beginPath();
  x.moveTo(a, cy);
  x.lineTo(lerp(a, b, draw), cy);
  x.stroke();
  x.setLineDash([]);
  if (draw >= 1) {
    for (const k of [0, 1]) {
      const p = ((lt * 0.7 + k * 0.5) % 1);
      const px = k ? lerp(b, a, p) : lerp(a, b, p);
      x.fillStyle = k ? "#f4f2ef" : CORAL;
      x.globalAlpha = u * (1 - out) * Math.sin(Math.PI * p);
      x.beginPath();
      x.arc(px, cy, 6, 0, Math.PI * 2);
      x.fill();
    }
    x.globalAlpha = u * (1 - out);
  }
  font(24, 500, MONO);
  track(3);
  x.fillStyle = "#6f6b65";
  w = x.measureText("MCP").width;
  x.fillText("MCP", W / 2 - w / 2, cy - 22);
  font(22, 500, MONO);
  track(0.5);
  x.fillStyle = "#57534e";
  const notes = "notes →", edits = "← edits";
  x.fillText(notes, W / 2 - x.measureText(notes).width / 2, cy + 40);
  x.fillText(edits, W / 2 - x.measureText(edits).width / 2, cy + 70);
  track(0);
  x.restore();
}

// ---------------------------------------------------------------- punchline + end
export function scenePunch(t: number, from: number, to: number) {
  stage();
  const lt = t - from;
  const leave = to - from - 0.4;
  line("", W / 2, H / 2 - 20, 120, lt, 0.1, { leave, runs: [{ text: "Video editor.", color: "gradient" }] });
  line("", W / 2, H / 2 + 120, 120, lt, 0.9, { leave, runs: [{ text: "0", color: CORAL }, { text: " timelines.", color: "#7d7973" }] });
}
export function sceneEnd(t: number, from: number) {
  stage(1.6);
  const lt = t - from;
  const iu = expo(prog(lt, 0.05, 1.1));
  const size = 220;
  x.save();
  x.globalAlpha = iu;
  const g = x.createRadialGradient(W / 2, H / 2 - 150, 0, W / 2, H / 2 - 150, 420);
  g.addColorStop(0, `rgba(255,95,79,${0.22 * iu})`);
  g.addColorStop(1, "rgba(255,95,79,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  const s = lerp(0.9, 1, iu);
  x.translate(W / 2, H / 2 - 150);
  x.scale(s, s);
  if (1 - iu > 0.02) x.filter = `blur(${((1 - iu) * 14).toFixed(1)}px)`;
  x.drawImage(icon, -size / 2, -size / 2, size, size);
  x.restore();
  line("", W / 2, H / 2 + 70, 120, lt, 0.45, { weight: 700, runs: [{ text: "cutroom", color: "gradient" }] });
  line("", W / 2, H / 2 + 150, 44, lt, 0.85, { weight: 500, runs: [{ text: "Point at it. Claude fixes it.", color: "#8d8983" }] });
  const pu = expo(prog(lt, 1.3, 0.8));
  if (pu > 0) {
    x.save();
    x.globalAlpha = pu;
    font(30, 500, MONO);
    const cmd = "claude mcp add cutroom -- npx -y cutroom mcp";
    const cw = x.measureText(cmd).width + 64;
    const py = H / 2 + 230 + (1 - pu) * 14;
    rrect(W / 2 - cw / 2, py, cw, 68, 34);
    void 0;
    x.fillStyle = "rgba(255,255,255,0.06)";
    x.fill();
    x.strokeStyle = "rgba(255,255,255,0.14)";
    x.lineWidth = 1.5;
    x.stroke();
    x.fillStyle = "#e9e6e1";
    x.fillText(cmd, W / 2 - cw / 2 + 32, py + 44);
    x.restore();
  }
  line("", W / 2, H - 80, 28, lt, 1.6, { weight: 500, runs: [{ text: "Open source  ·  Runs on your machine  ·  github.com/0xpratzyy/cutroom", color: "#5f5b56" }] });
}
