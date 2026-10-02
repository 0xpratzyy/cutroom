// Turns project state into things an LLM can perceive: compact text and contact sheets.
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { ffmpeg } from "./ffmpeg.js";
import type { ProjectStore } from "./project.js";
import type { EditContext } from "./shared/ops.js";
import { formatTime, isFiller, mapWords, placeClips, timelineDuration, timelineToSource } from "./shared/timeline.js";
import type { Feedback, Project, Silence, Transcript } from "./shared/types.js";
import { feedbackTime } from "./shared/feedback.js";
import { render } from "./render.js";

export function summarizeProject(p: Project, ctx: EditContext): string {
  const out: string[] = [];
  const dur = timelineDuration(p);
  out.push(`Project "${p.name}": ${formatTime(dur)} (${dur.toFixed(2)}s), ${p.settings.width}x${p.settings.height} @ ${p.settings.fps}fps`);
  out.push("");
  out.push("MEDIA");
  if (!p.media.length) out.push("  (none; use import_media)");
  for (const m of p.media) {
    const t = ctx.transcripts[m.id];
    const flags = [
      t ? `transcript ${t.words.length} words` : m.hasAudio ? "no transcript" : null,
      ctx.silences[m.id] ? `${ctx.silences[m.id]!.length} silences` : null,
    ].filter(Boolean);
    const dims = m.hasVideo ? ` ${m.width}x${m.height}` : "";
    out.push(`  ${m.id}  ${m.kind}${dims} ${m.kind === "image" ? "" : formatTime(m.duration)}  "${m.name}"  [${flags.join(", ")}]`);
  }
  out.push("");
  out.push(`MAIN TRACK (${p.clips.length} clips; timeline → source)`);
  const placed = placeClips(p);
  const show = placed.length > 60 ? [...placed.slice(0, 30), null, ...placed.slice(-30)] : placed;
  for (const pc of show) {
    if (!pc) {
      out.push(`  … ${placed.length - 60} more clips …`);
      continue;
    }
    const focus = pc.clip.focus ? `  focus ${pc.clip.focus.x.toFixed(2)},${pc.clip.focus.y.toFixed(2)}` : "";
    out.push(`  ${pc.clip.id}  ${formatTime(pc.start)}–${formatTime(pc.end)}  ←  ${pc.clip.mediaId} ${pc.clip.in.toFixed(2)}–${pc.clip.out.toFixed(2)}${focus}`);
  }
  if (p.overlays.length) {
    out.push("", "B-ROLL");
    for (const o of p.overlays) out.push(`  ${o.id}  ${formatTime(o.start)}–${formatTime(o.start + o.duration)}  ${o.mediaId} from ${o.in.toFixed(2)}s  ${o.mode}${o.volume ? ` vol ${o.volume}` : " muted"}`);
  }
  if (p.zooms.length) {
    out.push("", "ZOOMS");
    for (const z of p.zooms) out.push(`  ${z.id}  ${formatTime(z.start)}–${formatTime(z.end)}  ×${z.scale}  focus ${z.focus.x.toFixed(2)},${z.focus.y.toFixed(2)}`);
  }
  const c = p.captions;
  out.push(
    "",
    `CAPTIONS ${c.enabled ? `on: ${c.preset ? `template ${c.preset}, ` : ""}${c.fontFamily.split(",")[0]} ${c.fontWeight}, ≤${c.maxWords} words, animation ${c.animation}, ${c.highlight ? `highlight ${c.highlightStyle}, ` : ""}${c.uppercase ? "uppercase, " : ""}pos ${c.position}${c.emphasisWords.length ? `, emphasis: ${c.emphasisWords.join(" ")}` : ""}` : "off"}`,
  );
  const l = p.look;
  const adj = (["exposure", "contrast", "saturation", "temperature"] as const).filter((k) => l[k]).map((k) => `${k} ${l[k] > 0 ? "+" : ""}${l[k].toFixed(2)}`);
  out.push(`LOOK ${l.lut ? `${l.lut} at ${Math.round(l.intensity * 100)}%` : "none"}${adj.length ? `, ${adj.join(", ")}` : ""}`);
  const h = p.hook;
  out.push(`HOOK ${h.enabled && h.text ? `"${h.text}" (${h.preset}) ${h.start.toFixed(1)}–${(h.start + h.duration).toFixed(1)}s` : "off"}`);
  out.push(`WATERMARK ${p.watermark.enabled && p.watermark.file ? `${p.watermark.file} ${p.watermark.corner}` : "off"}`);
  out.push(`STUDIO SOUND ${p.audio.preset}${p.audio.preset !== "off" ? ` at ${Math.round(p.audio.strength * 100)}%` : ""}`);
  return out.join("\n");
}

export interface TranscriptFormat {
  /** Timeline range to show. */
  range?: { start: number; end: number };
  /** Include words that have been cut. Default true. */
  showCut?: boolean;
}

/**
 * One line per phrase:  [timeline] index:word index:word …
 * Cut words appear as ~index:word~ so the agent can restore them.
 */
export function formatTranscript(p: Project, t: Transcript, opts: TranscriptFormat = {}): string {
  const mapped = mapWords(p, t);
  const showCut = opts.showCut ?? true;
  const lines: string[] = [];
  let line: string[] = [];
  let lineStart: number | null = null;
  let prevEnd: number | null = null;

  const flush = () => {
    if (line.length) lines.push(`${lineStart === null ? "[cut]          " : `[${formatTime(lineStart)}]`} ${line.join(" ")}`);
    line = [];
    lineStart = null;
  };

  for (const w of mapped) {
    if (opts.range && w.kept && (w.end < opts.range.start || w.start > opts.range.end)) continue;
    if (opts.range && !w.kept && !line.length) continue;
    const label = `${w.word.i}:${w.word.text}${isFiller(w.word.text) ? "⟨filler⟩" : ""}`;
    if (!w.kept) {
      if (showCut) line.push(`~${label}~`);
      continue;
    }
    const gap = prevEnd === null ? 0 : w.start - prevEnd;
    if (gap >= 0.5 && line.length) {
      flush();
      lines.push(`               ⏸ ${gap.toFixed(1)}s`);
    }
    if (lineStart === null) lineStart = w.start;
    line.push(label);
    prevEnd = w.end;
    if (/[.?!]$/.test(w.word.text) || line.length >= 18) flush();
  }
  flush();
  const header = `${t.mediaId} transcript (${t.backend} ${t.model}, ${t.words.length} words). Format: [timeline time] index:word … ; ~index:word~ = already cut; ⏸ = pause on the timeline.`;
  return [header, ...lines].join("\n");
}

export function formatSilences(p: Project, mediaId: string, silences: Silence[], minDuration = 0.4): string {
  const rows = silences
    .filter((s) => s.end - s.start >= minDuration)
    .map((s) => {
      const tl = placeClips(p).find((pc) => pc.clip.mediaId === mediaId && s.start < pc.clip.out && s.end > pc.clip.in);
      return `  ${s.start.toFixed(2)}–${s.end.toFixed(2)}s (${(s.end - s.start).toFixed(2)}s)${tl ? "" : "  [already cut]"}`;
    });
  return `${mediaId} silences ≥ ${minDuration}s (source time):\n${rows.join("\n") || "  none"}`;
}

/**
 * Grab frames at timeline times and lay them out in a labeled grid (JPEG).
 * Uses source frames (fast): shows b-roll where it's active, but not crops/zooms/captions;
 * use render-based previews to check the final look.
 */
export async function contactSheet(store: ProjectStore, times: number[], opts: { cols?: number; tileWidth?: number } = {}): Promise<Buffer> {
  const p = await store.load();
  const cols = opts.cols ?? gridCols(times.length, p.settings.height > p.settings.width);
  const tileW = opts.tileWidth ?? 320;
  const dir = join(store.dataDir, "sheets", String(Date.now()));
  await mkdir(dir, { recursive: true });
  try {
    const frames: { t: number; file: string | null; label: string }[] = [];
    for (const [i, t] of times.entries()) {
      const overlay = p.overlays.find((o) => t >= o.start && t < o.start + o.duration);
      let mediaId: string | undefined;
      let src = 0;
      let label = formatTime(t);
      if (overlay) {
        mediaId = overlay.mediaId;
        src = overlay.in + (t - overlay.start);
        label += ` · b-roll ${overlay.id}`;
      } else {
        const hit = timelineToSource(p, t);
        if (hit) {
          mediaId = hit.placed.clip.mediaId;
          src = hit.src;
          label += ` · ${hit.placed.clip.id}`;
        }
      }
      const m = p.media.find((x) => x.id === mediaId);
      if (!m || !m.hasVideo) {
        frames.push({ t, file: null, label });
        continue;
      }
      const file = join(dir, `${i}.jpg`);
      const seek = m.kind === "image" ? [] : ["-ss", Math.max(0, Math.min(src, m.duration - 0.05)).toFixed(3)];
      // One unreadable frame (past the end of a video track that stops early, a damaged GOP)
      // shouldn't fail the whole sheet: show an empty tile instead.
      const ok = await ffmpeg([...seek, "-i", store.resolveMediaPath(m), "-frames:v", "1", "-vf", `scale=${tileW}:-2`, "-q:v", "4", file]).then(
        () => existsSync(file),
        () => false,
      );
      frames.push({ t, file: ok ? file : null, label: ok ? label : `${label} · no frame` });
    }

    return await composeSheet(frames, p.settings.height / p.settings.width, cols, tileW);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Lay out frames in a labeled grid, cover-fitting each into the output aspect. */
export async function composeSheet(frames: { file: string | null; label: string }[], aspect: number, cols: number, tileW = 320): Promise<Buffer> {
  const tileH = Math.round(tileW * aspect);
  const labelH = 22;
  const rows = Math.ceil(frames.length / cols);
  const canvas = createCanvas(cols * tileW, rows * (tileH + labelH));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const [i, f] of frames.entries()) {
    const x = (i % cols) * tileW;
    const y = Math.floor(i / cols) * (tileH + labelH);
    if (f.file) {
      const img = await loadImage(f.file);
      const s = Math.max(tileW / img.width, tileH / img.height);
      const w = img.width * s;
      const h = img.height * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, tileW, tileH);
      ctx.clip();
      ctx.drawImage(img, x + (tileW - w) / 2, y + (tileH - h) / 2, w, h);
      ctx.restore();
    }
    ctx.fillStyle = "#000";
    ctx.fillRect(x, y + tileH, tileW, labelH);
    ctx.fillStyle = "#fff";
    ctx.font = "13px Menlo, monospace";
    ctx.fillText(f.label, x + 6, y + tileH + 15);
  }
  return await canvas.encode("jpeg", 82);
}

/** Frames from an already-rendered video at the given times (relative to the video). */
export async function sheetFromVideo(file: string, times: number[], labels: string[], aspect: number, workDir: string): Promise<Buffer> {
  const dir = join(workDir, `sheet-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  try {
    const frames: { file: string | null; label: string }[] = [];
    for (const [i, t] of times.entries()) {
      const out = join(dir, `${i}.jpg`);
      await ffmpeg(["-ss", t.toFixed(3), "-i", file, "-frames:v", "1", "-q:v", "4", out]).catch(() => {});
      frames.push({ file: existsSync(out) ? out : null, label: labels[i] });
    }
    return await composeSheet(frames, aspect, gridCols(times.length, aspect > 1), aspect > 1 ? 200 : 320);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Balanced grid: as few rows as possible, then evenly filled. */
function gridCols(count: number, vertical: boolean): number {
  const rows = Math.ceil(count / (vertical ? 6 : 4));
  return Math.max(1, Math.ceil(count / rows));
}

/** Evenly spaced sample times across a range (centered in each slot). */
export function sampleTimes(start: number, end: number, count: number): number[] {
  const step = (end - start) / count;
  return Array.from({ length: count }, (_, i) => start + step * (i + 0.5));
}

/**
 * The rendered frame a feedback note points at, with its pin/box drawn on top,
 * so an agent sees exactly what the user saw.
 */
export async function annotatedFrame(store: ProjectStore, fb: Feedback): Promise<Buffer | null> {
  const p = await store.load();
  if (!p.clips.length) return null;
  const t = feedbackTime(p, fb);
  const dir = join(store.dataDir, "sheets");
  await mkdir(dir, { recursive: true });
  const file = join(dir, `fb-${fb.id}-${Date.now()}.png`);
  try {
    if (t.cut && fb.anchor) {
      const m = p.media.find((x) => x.id === fb.anchor!.mediaId);
      if (!m?.hasVideo) return null;
      await ffmpeg(["-ss", fb.anchor.start.toFixed(3), "-i", store.resolveMediaPath(m), "-frames:v", "1", "-vf", "scale=640:-2", file]);
    } else {
      const total = timelineDuration(p);
      const at = Math.min(Math.max(0, t.start + (t.end !== null ? Math.min(0.3, (t.end - t.start) / 2) : 0)), Math.max(0, total - 0.05));
      await render(store, { out: file, range: { start: at, end: at }, still: true, scale: Math.min(1, 720 / Math.max(p.settings.width, p.settings.height)) });
    }
    const img = await loadImage(file);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const r = fb.region;
    const accent = "#ff6b3d";
    let lx = 12;
    let ly = 12;
    if (r && !t.cut) {
      const x = r.x * img.width;
      const y = r.y * img.height;
      if (r.w > 0.01 || r.h > 0.01) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = accent;
        ctx.strokeRect(x, y, r.w * img.width, r.h * img.height);
        lx = x;
        ly = Math.max(0, y - 26);
      } else {
        ctx.beginPath();
        ctx.arc(x, y, 9, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.lineWidth = 3;
        ctx.strokeStyle = "#fff";
        ctx.stroke();
        lx = x + 12;
        ly = y - 30;
      }
    }
    ctx.font = "bold 15px Helvetica, Arial, sans-serif";
    const label = `#${fb.n} ${formatTime(t.start)}`;
    const w = ctx.measureText(label).width + 14;
    lx = Math.min(Math.max(0, lx), img.width - w);
    ly = Math.min(Math.max(0, ly), img.height - 24);
    ctx.fillStyle = accent;
    ctx.fillRect(lx, ly, w, 24);
    ctx.fillStyle = "#fff";
    ctx.fillText(label, lx + 7, ly + 17);
    return await canvas.encode("jpeg", 85);
  } catch {
    return null;
  } finally {
    await rm(file, { force: true });
  }
}
