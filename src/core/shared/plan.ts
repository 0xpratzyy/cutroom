// A render plan flattens the project into exactly what has to be drawn and when.
// The ffmpeg exporter and the browser preview both consume it.
import type { Focus, HookTitle, OverlayMode, Project, Transcript } from "./types.js";
import { EPS, placeClips, timelineDuration, timelineWords } from "./timeline.js";
import { paginateCaptions, type CaptionPage } from "./captions.js";

export interface PlanPiece {
  clipId: string;
  mediaId: string;
  srcIn: number;
  srcOut: number;
  start: number;
  end: number;
  /** Zoom at the start of the piece. */
  zoom: number;
  /** Zoom at the end of the piece (differs from `zoom` while easing in/out). */
  zoomTo: number;
  focus: Focus;
}

export interface PlanOverlay {
  id: string;
  mediaId: string;
  srcIn: number;
  start: number;
  end: number;
  mode: OverlayMode;
  pip?: { x: number; y: number; w: number };
  volume: number;
  focus: Focus;
}

export interface RenderPlan {
  duration: number;
  /** Timeline range this plan covers; plan times are relative to range.start. */
  range: { start: number; end: number };
  pieces: PlanPiece[];
  overlays: PlanOverlay[];
  captions: CaptionPage[];
  /** Hook title with times relative to the range, or null if not visible in it. */
  hook: HookTitle | null;
}

const CENTER: Focus = { x: 0.5, y: 0.5 };

export function buildPlan(project: Project, transcripts: Record<string, Transcript | undefined>, range?: { start: number; end: number }): RenderPlan {
  const total = timelineDuration(project);
  const r = range ? { start: Math.max(0, range.start), end: Math.min(total, range.end) } : { start: 0, end: total };

  // Split main clips at zoom boundaries (and the ends of their ease ramps), so each piece
  // has either a static zoom or a single smooth ramp.
  const ramps = project.zooms.map((z) => {
    const ease = Math.min(z.ease ?? 0, (z.end - z.start) / 2);
    return { z, ease };
  });
  const cuts = ramps.flatMap(({ z, ease }) => (ease > 0 ? [z.start, z.start + ease, z.end - ease, z.end] : [z.start, z.end]));
  const zoomAt = (t: number) => {
    for (const { z, ease } of ramps) {
      if (t < z.start - 1e-6 || t > z.end + 1e-6) continue;
      if (ease <= 0) return t < z.end ? { scale: z.scale, focus: z.focus } : null;
      const k = t < z.start + ease ? (t - z.start) / ease : t > z.end - ease ? (z.end - t) / ease : 1;
      return { scale: 1 + (z.scale - 1) * Math.max(0, Math.min(1, k)), focus: z.focus };
    }
    return null;
  };
  const pieces: PlanPiece[] = [];
  for (const pc of placeClips(project)) {
    const bounds = [pc.start, ...cuts.filter((t) => t > pc.start + EPS && t < pc.end - EPS).sort((a, b) => a - b), pc.end];
    for (let i = 0; i < bounds.length - 1; i++) {
      const start = bounds[i];
      const end = bounds[i + 1];
      const mid = (start + end) / 2;
      const active = project.zooms.find((z) => mid >= z.start && mid < z.end);
      const ramped = active && (active.ease ?? 0) > 0;
      const a = ramped ? zoomAt(start) : null;
      const b = ramped ? zoomAt(end) : null;
      const zoom = ramped ? (a?.scale ?? 1) : (active?.scale ?? 1);
      pieces.push({
        clipId: pc.clip.id,
        mediaId: pc.clip.mediaId,
        srcIn: pc.clip.in + (start - pc.start),
        srcOut: pc.clip.in + (end - pc.start),
        start,
        end,
        zoom,
        zoomTo: ramped ? (b?.scale ?? 1) : zoom,
        focus: active?.focus ?? pc.clip.focus ?? CENTER,
      });
    }
  }

  const clippedPieces = pieces
    .filter((p) => p.end > r.start + EPS && p.start < r.end - EPS)
    .map((p) => {
      const start = Math.max(p.start, r.start);
      const end = Math.min(p.end, r.end);
      const lerp = (t: number) => p.zoom + (p.zoomTo - p.zoom) * ((t - p.start) / Math.max(1e-6, p.end - p.start));
      return { ...p, srcIn: p.srcIn + (start - p.start), srcOut: p.srcOut - (p.end - end), start: start - r.start, end: end - r.start, zoom: lerp(start), zoomTo: lerp(end) };
    });

  const overlays: PlanOverlay[] = project.overlays
    .filter((o) => o.start + o.duration > r.start + EPS && o.start < r.end - EPS)
    .map((o) => {
      const start = Math.max(o.start, r.start);
      const end = Math.min(o.start + o.duration, r.end);
      return {
        id: o.id,
        mediaId: o.mediaId,
        srcIn: o.in + (start - o.start),
        start: start - r.start,
        end: end - r.start,
        mode: o.mode,
        pip: o.pip,
        volume: o.volume,
        focus: o.focus ?? CENTER,
      };
    });

  let captions: CaptionPage[] = [];
  if (project.captions.enabled) {
    captions = paginateCaptions(timelineWords(project, transcripts), project.captions)
      .filter((pg) => pg.end > r.start && pg.start < r.end)
      .map((pg) => ({
        start: Math.max(pg.start, r.start) - r.start,
        end: Math.min(pg.end, r.end) - r.start,
        words: pg.words.map((w) => ({ ...w, start: w.start - r.start, end: w.end - r.start })),
      }));
  }

  const h = project.hook;
  const hook = h.enabled && h.text.trim() && h.start + h.duration > r.start && h.start < r.end ? { ...h, start: h.start - r.start } : null;

  return { duration: r.end - r.start, range: r, pieces: clippedPieces, overlays, captions, hook };
}

/** Zoom of a piece at time t (same clock as the piece), eased with smoothstep across a ramp. */
export function pieceZoomAt(p: Pick<PlanPiece, "start" | "end" | "zoom" | "zoomTo">, t: number): number {
  if (p.zoom === p.zoomTo) return p.zoom;
  const u = Math.max(0, Math.min(1, (t - p.start) / Math.max(1e-6, p.end - p.start)));
  return p.zoom + (p.zoomTo - p.zoom) * (u * u * (3 - 2 * u));
}
