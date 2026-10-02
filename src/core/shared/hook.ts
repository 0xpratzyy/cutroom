// Hook title: big text over the opening seconds. Drawn with any Canvas 2D context, so the
// preview and the exporter render it identically.
import type { Ctx2D } from "./captions.js";
import type { HookTitle } from "./types.js";

const IN = 0.28;
const OUT = 0.25;
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOutBack = (t: number) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

export const HOOK_PRESETS: { id: HookTitle["preset"]; name: string }[] = [
  { id: "highlight", name: "Highlight" },
  { id: "headline", name: "Headline" },
  { id: "outline", name: "Outline" },
  { id: "minimal", name: "Minimal" },
];

export function hookActive(hook: HookTitle, t: number): boolean {
  return hook.enabled && !!hook.text.trim() && t >= hook.start && t < hook.start + hook.duration;
}

/** Times an exported hook must be redrawn: its entrance and exit frames. */
export function hookSampleTimes(hook: HookTitle, fps: number): number[] {
  if (!hook.enabled || !hook.text.trim()) return [];
  const out: number[] = [];
  const end = hook.start + hook.duration;
  for (let k = 0; k <= Math.ceil(IN * fps); k++) out.push(hook.start + k / fps);
  for (let k = Math.ceil(OUT * fps); k >= 0; k--) out.push(end - k / fps);
  out.push(end);
  return out.filter((x) => x >= hook.start && x <= end);
}

/** Whether the hook looks the same at every time in [a, b) (between animations). */
export function hookSteady(hook: HookTitle, t: number): boolean {
  return t >= hook.start + IN && t < hook.start + hook.duration - OUT;
}

export function drawHook(ctx: Ctx2D, width: number, height: number, hook: HookTitle, t: number): void {
  if (!hookActive(hook, t)) return;
  const age = clamp01((t - hook.start) / IN);
  const left = clamp01((hook.start + hook.duration - t) / OUT);
  const scale = 0.82 + 0.18 * easeOutBack(age);
  const alpha = (0.35 + 0.65 * easeOutCubic(Math.min(age * 1.6, 1))) * easeOutCubic(left);
  const size = Math.round(hook.fontSize * height);
  const text = hook.uppercase ? hook.text.toUpperCase() : hook.text;
  ctx.font = `${hook.fontWeight} ${size}px ${hook.fontFamily}`;
  ctx.textBaseline = "middle";
  ctx.textAlign = "left";

  // Wrap into lines at 84% width (explicit newlines respected).
  const max = width * 0.84;
  const lines: string[] = [];
  for (const para of text.split(/\n/)) {
    let line = "";
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (line && ctx.measureText(next).width > max) {
        lines.push(line);
        line = word;
      } else line = next;
    }
    if (line) lines.push(line);
  }
  const lineH = size * (hook.preset === "highlight" ? 1.32 : 1.18);
  const cx = width / 2;
  const cy = hook.position * height;
  const top = cy - (lineH * lines.length) / 2 + lineH / 2;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.translate(cx, cy);
  ctx.scale(scale, scale);
  ctx.translate(-cx, -cy);
  ctx.lineJoin = "round";
  lines.forEach((l, i) => {
    const w = ctx.measureText(l).width;
    const x = cx - w / 2;
    const y = top + i * lineH;
    if (hook.preset === "highlight") {
      const padX = size * 0.32;
      const padY = size * 0.14;
      ctx.fillStyle = hook.accent;
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(x - padX, y - size / 2 - padY, w + padX * 2, size + padY * 2, size * 0.18);
      else ctx.rect(x - padX, y - size / 2 - padY, w + padX * 2, size + padY * 2);
      ctx.fill();
      ctx.fillStyle = hook.color;
      ctx.fillText(l, x, y + size * 0.04);
    } else if (hook.preset === "headline") {
      ctx.lineWidth = size * 0.2;
      ctx.strokeStyle = "#000000";
      ctx.strokeText(l, x, y);
      ctx.fillStyle = i === 0 ? hook.accent : hook.color;
      ctx.fillText(l, x, y);
    } else if (hook.preset === "outline") {
      ctx.shadowColor = "rgba(0,0,0,0.6)";
      ctx.shadowBlur = size * 0.3;
      ctx.lineWidth = size * 0.07;
      ctx.strokeStyle = hook.color;
      ctx.strokeText(l, x, y);
      ctx.shadowBlur = 0;
      ctx.lineWidth = size * 0.035;
      ctx.strokeStyle = hook.accent;
      ctx.strokeText(l, x, y);
    } else {
      ctx.shadowColor = "rgba(0,0,0,0.75)";
      ctx.shadowBlur = size * 0.4;
      ctx.fillStyle = hook.color;
      ctx.fillText(l, x, y);
      ctx.shadowBlur = 0;
    }
  });
  ctx.restore();
}
