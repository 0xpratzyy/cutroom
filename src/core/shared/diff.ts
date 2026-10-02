// Diff two versions of a project into reviewable changes, each with the ops that revert it.
// Used to review an agent's edits like a pull request: see what it cut, added and restyled,
// then keep or revert each change.
import type { Op } from "./ops.js";
import { formatTime, mergeRanges, placeClips, sourceToTimeline, timelineToSource } from "./timeline.js";
import type { Project, Transcript } from "./types.js";
import { CAPTION_PRESETS } from "./captions.js";
import { BUILTIN_LOOKS } from "./looks.js";

type Range = { start: number; end: number };

export type ChangeKind = "cut" | "restore" | "zoom" | "overlay" | "style";

export interface Change {
  id: string;
  kind: ChangeKind;
  label: string;
  /** Timeline position in the new version where the change sits. */
  at: number;
  end?: number;
  /** For cuts/restores: the source range. */
  mediaId?: string;
  srcStart?: number;
  srcEnd?: number;
  /** Seconds added (+) or removed (−) from the timeline. */
  delta: number;
  revert: Op[];
}

const MIN = 0.03;

function subtract(a: Range[], b: Range[]): Range[] {
  const out: Range[] = [];
  for (const r of a) {
    let pieces = [{ ...r }];
    for (const c of b) {
      pieces = pieces.flatMap((p) => {
        if (c.end <= p.start || c.start >= p.end) return [p];
        const res: Range[] = [];
        if (c.start > p.start) res.push({ start: p.start, end: c.start });
        if (c.end < p.end) res.push({ start: c.end, end: p.end });
        return res;
      });
    }
    out.push(...pieces);
  }
  return out.filter((r) => r.end - r.start >= MIN);
}

function coverage(p: Project): Map<string, Range[]> {
  const m = new Map<string, Range[]>();
  for (const c of p.clips) m.set(c.mediaId, [...(m.get(c.mediaId) ?? []), { start: c.in, end: c.out }]);
  for (const [k, v] of m) m.set(k, mergeRanges(v, 0.005));
  return m;
}

function quote(t: Transcript | undefined, r: Range): string | null {
  if (!t) return null;
  const words = t.words.filter((w) => (w.start + w.end) / 2 >= r.start && (w.start + w.end) / 2 < r.end).map((w) => w.text);
  if (!words.length) return null;
  const text = words.join(" ");
  return text.length > 48 ? `${text.slice(0, 46)}…` : text;
}

/** Timeline position in `p` where a source range of `mediaId` would sit (just after the kept footage before it). */
function slot(p: Project, mediaId: string, r: Range): number {
  const placed = placeClips(p).filter((pc) => pc.clip.mediaId === mediaId);
  const prev = [...placed].reverse().find((pc) => pc.clip.out <= r.start + 0.01);
  if (prev) return prev.end;
  const next = placed.find((pc) => pc.clip.in >= r.end - 0.01);
  return next ? next.start : 0;
}

/** Where a timeline position in `before` ends up in `after`, following its footage through cuts. */
function follow(before: Project, after: Project, t: number): number | null {
  const hit = timelineToSource(before, t);
  return hit ? sourceToTimeline(after, hit.placed.clip.mediaId, hit.src) : null;
}

/** True when an item only slid along with the footage (ripple), not edited. */
function rippled(before: Project, after: Project, b: { start: number; end: number }, a: { start: number; end: number }): boolean {
  const s = follow(before, after, b.start + 0.001);
  return s !== null && Math.abs(s - a.start) < 0.06 && Math.abs(b.end - b.start - (a.end - a.start)) < 0.06;
}

const STYLE_FIELDS = ["captions", "look", "hook", "audio", "watermark", "settings"] as const;
const STYLE_NAMES: Record<(typeof STYLE_FIELDS)[number], string> = {
  captions: "Captions",
  look: "Color look",
  hook: "Hook title",
  audio: "Studio sound",
  watermark: "Logo",
  settings: "Output format",
};

export function diffProjects(before: Project, after: Project, transcripts: Record<string, Transcript | undefined>): Change[] {
  const changes: Change[] = [];

  // Footage: what source time was cut or brought back.
  const cb = coverage(before);
  const ca = coverage(after);
  for (const mediaId of new Set([...cb.keys(), ...ca.keys()])) {
    const b = cb.get(mediaId) ?? [];
    const a = ca.get(mediaId) ?? [];
    for (const r of subtract(b, a)) {
      const q = quote(transcripts[mediaId], r);
      changes.push({
        id: `cut:${mediaId}:${r.start.toFixed(3)}`,
        kind: "cut",
        label: q ? `Cut “${q}”` : `Cut ${(r.end - r.start).toFixed(1)}s`,
        at: slot(after, mediaId, r),
        mediaId,
        srcStart: r.start,
        srcEnd: r.end,
        delta: -(r.end - r.start),
        revert: [{ op: "restore_source", mediaId, start: r.start, end: r.end }],
      });
    }
    for (const r of subtract(a, b)) {
      const q = quote(transcripts[mediaId], r);
      const at = sourceToTimeline(after, mediaId, r.start) ?? 0;
      changes.push({
        id: `restore:${mediaId}:${r.start.toFixed(3)}`,
        kind: "restore",
        label: q ? `Added “${q}”` : `Added ${(r.end - r.start).toFixed(1)}s`,
        at,
        end: at + (r.end - r.start),
        mediaId,
        srcStart: r.start,
        srcEnd: r.end,
        delta: r.end - r.start,
        revert: [{ op: "cut_source", mediaId, start: r.start, end: r.end }],
      });
    }
  }

  // Zooms, matched by id.
  const zb = new Map(before.zooms.map((z) => [z.id, z]));
  const za = new Map(after.zooms.map((z) => [z.id, z]));
  for (const z of after.zooms) {
    const old = zb.get(z.id);
    if (!old) changes.push({ id: `zoom+:${z.id}`, kind: "zoom", label: `Zoom ×${z.scale.toFixed(2)}`, at: z.start, end: z.end, delta: 0, revert: [{ op: "remove_zoom", id: z.id }] });
    else if (JSON.stringify({ ...old, start: 0, end: old.end - old.start }) !== JSON.stringify({ ...z, start: 0, end: z.end - z.start }) || !rippled(before, after, old, z))
      changes.push({ id: `zoom~:${z.id}`, kind: "zoom", label: old.scale !== z.scale ? `Zoom ×${old.scale.toFixed(2)} → ×${z.scale.toFixed(2)}` : "Moved a zoom", at: z.start, end: z.end, delta: 0, revert: [{ op: "update_zoom", id: z.id, start: old.start, end: old.end, scale: old.scale, x: old.focus.x, y: old.focus.y }] });
  }
  for (const z of before.zooms) {
    if (!za.has(z.id)) changes.push({ id: `zoom-:${z.id}`, kind: "zoom", label: `Removed zoom ×${z.scale.toFixed(2)}`, at: z.start, end: z.end, delta: 0, revert: [{ op: "add_zoom", start: z.start, end: z.end, scale: z.scale, x: z.focus.x, y: z.focus.y }] });
  }

  // B-roll, matched by id.
  const ob = new Map(before.overlays.map((o) => [o.id, o]));
  const oa = new Map(after.overlays.map((o) => [o.id, o]));
  const mediaName = (id: string) => after.media.find((m) => m.id === id)?.name ?? before.media.find((m) => m.id === id)?.name ?? id;
  for (const o of after.overlays) {
    const old = ob.get(o.id);
    if (!old) changes.push({ id: `ov+:${o.id}`, kind: "overlay", label: `B-roll ${mediaName(o.mediaId)}`, at: o.start, end: o.start + o.duration, delta: 0, revert: [{ op: "remove_overlay", id: o.id }] });
    else if (
      JSON.stringify({ ...old, start: 0 }) !== JSON.stringify({ ...o, start: 0 }) ||
      !rippled(before, after, { start: old.start, end: old.start + old.duration }, { start: o.start, end: o.start + o.duration })
    )
      changes.push({
        id: `ov~:${o.id}`,
        kind: "overlay",
        label: `Changed b-roll ${mediaName(o.mediaId)}`,
        at: o.start,
        end: o.start + o.duration,
        delta: 0,
        revert: [{ op: "update_overlay", id: o.id, start: old.start, duration: old.duration, in: old.in, mode: old.mode, volume: old.volume, ...(old.pip ? { pip: old.pip } : {}) }],
      });
  }
  for (const o of before.overlays) {
    if (!oa.has(o.id))
      changes.push({ id: `ov-:${o.id}`, kind: "overlay", label: `Removed b-roll ${mediaName(o.mediaId)}`, at: o.start, end: o.start + o.duration, delta: 0, revert: [{ op: "add_broll", mediaId: o.mediaId, start: o.start, duration: o.duration, in: o.in, mode: o.mode, volume: o.volume, ...(o.pip ? { pip: o.pip } : {}) }] });
  }

  // Framing (focus) changes.
  const focusKey = (p: Project) => JSON.stringify([...new Set(p.clips.map((c) => JSON.stringify(c.focus ?? null)))].sort());
  if (focusKey(before) !== focusKey(after)) {
    const f = before.clips.find((c) => c.focus)?.focus ?? { x: 0.5, y: 0.5 };
    changes.push({ id: "framing", kind: "style", label: "Reframed the shot", at: 0, delta: 0, revert: [{ op: "set_focus", x: f.x, y: f.y }] });
  }

  // Whole-project styles.
  for (const field of STYLE_FIELDS) {
    const b = before[field] as unknown as Record<string, unknown>;
    const a = after[field] as unknown as Record<string, unknown>;
    if (JSON.stringify(b) === JSON.stringify(a)) continue;
    const keys = Object.keys(a).filter((k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]));
    let detail = keys.slice(0, 3).map((k) => (typeof a[k] === "string" || typeof a[k] === "boolean" || typeof a[k] === "number" ? `${k} ${String(a[k])}` : k));
    // Name the things people recognise instead of listing fields.
    if (field === "captions" && a.preset !== b.preset && a.preset) detail = [`${CAPTION_PRESETS.find((p) => p.id === a.preset)?.name ?? a.preset} template`];
    else if (field === "captions" && a.enabled !== b.enabled) detail = [a.enabled ? "on" : "off"];
    if (field === "look" && a.lut !== b.lut) detail = [a.lut ? (BUILTIN_LOOKS.find((l) => l.id === a.lut)?.name ?? String(a.lut)) : "none"];
    if (field === "hook" && a.text !== b.text && a.text) detail = [`“${a.text}”`];
    if (field === "audio" && a.preset !== b.preset) detail = [String(a.preset)];
    if (field === "settings" && (a.width !== b.width || a.height !== b.height)) detail = [`${a.width}×${a.height}`];
    const more = detail.length === 3 && keys.length > 3;
    const op = { captions: "set_captions", look: "set_look", hook: "set_hook", audio: "set_audio", watermark: "set_watermark", settings: "set_settings" }[field];
    changes.push({
      id: `style:${field}`,
      kind: "style",
      label: `${STYLE_NAMES[field]}: ${detail.join(", ")}${more ? "…" : ""}`,
      at: field === "hook" ? (after.hook.start ?? 0) : 0,
      delta: 0,
      revert: [{ op, ...b } as unknown as Op],
    });
  }

  return changes.sort((x, y) => x.at - y.at || x.kind.localeCompare(y.kind));
}

export function describeChange(c: Change): string {
  return `${c.label} at ${formatTime(c.at)}${c.delta ? ` (${c.delta > 0 ? "+" : ""}${c.delta.toFixed(1)}s)` : ""}`;
}
