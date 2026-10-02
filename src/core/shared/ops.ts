// Edit operations. Every change to a project, whether from an agent over MCP or a
// click in the editor, goes through applyOps(). Pure and browser-safe.
import {
  ASPECTS,
  type CaptionStyle,
  type Clip,
  type Look,
  type HookTitle,
  type Watermark,
  type AudioEnhance,
  type MediaAsset,
  type OverlayMode,
  type Project,
  type Settings,
  type Silence,
  type Transcript,
  type Word,
} from "./types.js";
import { CAPTION_PRESETS } from "./captions.js";
import { LOOK_IDS } from "./looks.js";
import { EPS, clamp, isFiller, mapWords, mergeRanges, normalizeWord, placeClips, timelineDuration, timelineToSource, uid } from "./timeline.js";

type Range = { start: number; end: number };
type FocusInput = { x?: number; y?: number };

export type Op =
  | { op: "cut"; start: number; end: number }
  | { op: "cut_source"; mediaId: string; start: number; end: number }
  | { op: "remove_words"; mediaId: string; from: number; to: number }
  | { op: "restore_words"; mediaId: string; from: number; to: number }
  | { op: "restore_source"; mediaId: string; start: number; end: number }
  | { op: "remove_text"; text: string; mediaId?: string; occurrence?: number | "all" }
  | { op: "remove_silences"; mediaId?: string; minDuration?: number; keep?: number }
  | { op: "remove_fillers"; mediaId?: string; words?: string[] }
  | { op: "split"; at: number }
  | { op: "add_clip"; mediaId: string; in?: number; out?: number; index?: number }
  | { op: "remove_clip"; id: string }
  | { op: "trim_clip"; id: string; in?: number; out?: number }
  | { op: "move_clip"; id: string; index: number }
  | { op: "set_focus"; id?: string; x: number; y: number }
  | { op: "add_broll"; mediaId: string; start: number; duration?: number; in?: number; mode?: OverlayMode; volume?: number; pip?: { x: number; y: number; w: number } }
  | { op: "update_overlay"; id: string; start?: number; duration?: number; in?: number; mode?: OverlayMode; volume?: number; pip?: { x: number; y: number; w: number }; focus?: FocusInput }
  | { op: "remove_overlay"; id: string }
  | { op: "add_zoom"; start: number; end: number; scale?: number; x?: number; y?: number; ease?: number }
  | { op: "update_zoom"; id: string; start?: number; end?: number; scale?: number; x?: number; y?: number; ease?: number }
  | { op: "remove_zoom"; id: string }
  | { op: "jump_cut_zoom"; scale?: number; minGap?: number }
  | ({ op: "set_captions" } & Partial<CaptionStyle>)
  | ({ op: "set_look" } & Partial<Look>)
  | ({ op: "set_hook" } & Partial<HookTitle>)
  | ({ op: "set_watermark" } & Partial<Watermark>)
  | ({ op: "set_audio" } & Partial<AudioEnhance>)
  | ({ op: "set_settings"; aspect?: string } & Partial<Settings>);

export interface EditContext {
  transcripts: Record<string, Transcript | undefined>;
  silences: Record<string, Silence[] | undefined>;
}

export class EditError extends Error {}

export interface EditResult {
  project: Project;
  notes: string[];
}

const MIN_CLIP = 0.04;
const MIN_OVERLAY = 0.1;

export function applyOps(input: Project, ops: Op[], ctx: EditContext): EditResult {
  const p: Project = structuredClone(input);
  const notes: string[] = [];
  ops.forEach((op, n) => {
    try {
      const note = applyOp(p, op, ctx);
      if (note) notes.push(note);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new EditError(ops.length > 1 ? `op #${n} (${op.op}): ${msg}` : `${op.op}: ${msg}`);
    }
  });
  const total = timelineDuration(p);
  for (const o of p.overlays) if (o.start + o.duration > total) o.duration = total - o.start;
  p.overlays = p.overlays.filter((o) => o.duration >= MIN_OVERLAY);
  p.zooms = p.zooms.filter((z) => z.start < total - MIN_OVERLAY).map((z) => ({ ...z, end: Math.min(z.end, total) }));
  const errors = validateProject(p);
  if (errors.length) throw new EditError("edit produced an invalid project: " + errors.join("; "));
  return { project: p, notes };
}

function applyOp(p: Project, op: Op, ctx: EditContext): string | void {
  switch (op.op) {
    case "cut": {
      if (op.end <= op.start) throw new EditError("end must be after start");
      const removed = removeTimelineRanges(p, [{ start: op.start, end: op.end }]);
      return `cut ${removed.toFixed(2)}s`;
    }
    case "cut_source": {
      media(p, op.mediaId);
      const removed = removeSourceRanges(p, op.mediaId, [{ start: op.start, end: op.end }]);
      return `cut ${removed.toFixed(2)}s`;
    }
    case "remove_words": {
      const t = transcript(ctx, op.mediaId);
      const range = wordRange(t, op.from, op.to);
      const removed = removeSourceRanges(p, op.mediaId, [range]);
      return `removed words ${op.from}-${op.to} (${removed.toFixed(2)}s)`;
    }
    case "restore_words": {
      const t = transcript(ctx, op.mediaId);
      const range = wordRange(t, op.from, op.to);
      const added = restoreSourceRange(p, op.mediaId, range);
      return `restored words ${op.from}-${op.to} (+${added.toFixed(2)}s)`;
    }
    case "restore_source": {
      media(p, op.mediaId);
      if (op.end <= op.start) throw new EditError("end must be after start");
      const added = restoreSourceRange(p, op.mediaId, { start: op.start, end: op.end });
      return `restored ${op.mediaId} ${op.start.toFixed(2)}-${op.end.toFixed(2)} (+${added.toFixed(2)}s)`;
    }
    case "remove_text": {
      const matches = findText(p, ctx, op.text, op.mediaId);
      if (!matches.length) throw new EditError(`"${op.text}" not found in the kept transcript`);
      const occ = op.occurrence ?? 1;
      const chosen = occ === "all" ? matches : [matches[occ - 1]];
      if (!chosen[0]) throw new EditError(`only ${matches.length} occurrence(s) of "${op.text}"`);
      let removed = 0;
      for (const m of chosen.reverse()) removed += removeSourceRanges(p, m.mediaId, [wordRange(transcript(ctx, m.mediaId), m.from, m.to)]);
      return `removed ${chosen.length} occurrence(s) of "${op.text}" (${removed.toFixed(2)}s)`;
    }
    case "remove_silences": {
      const minDuration = op.minDuration ?? 0.6;
      const keep = op.keep ?? 0.2;
      if (minDuration < 0 || keep < 0) throw new EditError("minDuration and keep must be >= 0");
      let removed = 0;
      let count = 0;
      for (const mediaId of mainMediaIds(p, op.mediaId)) {
        const m = media(p, mediaId);
        const silences = ctx.silences[mediaId] ?? gapsFromTranscript(ctx.transcripts[mediaId], m.duration);
        if (!silences) continue;
        const ranges: Range[] = [];
        for (const s of silences) {
          if (s.end - s.start < minDuration) continue;
          const atStart = s.start <= EPS;
          const atEnd = s.end >= m.duration - 0.05;
          const start = atStart ? 0 : s.start + keep;
          const end = atEnd ? m.duration : s.end - keep;
          if (end - start > EPS) ranges.push({ start, end });
        }
        count += ranges.length;
        removed += removeSourceRanges(p, mediaId, ranges);
      }
      return `removed ${count} silence(s) (${removed.toFixed(2)}s)`;
    }
    case "remove_fillers": {
      const custom = op.words?.map(normalizeWord);
      let removed = 0;
      let count = 0;
      for (const mediaId of mainMediaIds(p, op.mediaId)) {
        const t = ctx.transcripts[mediaId];
        if (!t) continue;
        const kept = mapWords(p, t).filter((w) => w.kept);
        const hits = kept.filter((w) => (custom ? custom.includes(normalizeWord(w.word.text)) : isFiller(w.word.text)));
        count += hits.length;
        removed += removeSourceRanges(p, mediaId, hits.map((w) => wordRange(t, w.word.i, w.word.i)));
      }
      return `removed ${count} filler word(s) (${removed.toFixed(2)}s)`;
    }
    case "split": {
      const placed = placeClips(p).find((pc) => op.at > pc.start + MIN_CLIP && op.at < pc.end - MIN_CLIP);
      if (!placed) throw new EditError(`no clip to split at ${op.at}`);
      const { clip } = placed;
      const cutAt = clip.in + (op.at - placed.start);
      const second: Clip = { ...clip, id: uid("c"), in: cutAt };
      clip.out = cutAt;
      p.clips.splice(placed.index + 1, 0, second);
      return `split ${clip.id} at ${op.at.toFixed(2)}s, new clip ${second.id}`;
    }
    case "add_clip": {
      const m = media(p, op.mediaId);
      if (m.kind === "image") throw new EditError("images can only be used as b-roll");
      const clip: Clip = { id: uid("c"), mediaId: m.id, in: op.in ?? 0, out: op.out ?? m.duration };
      checkSourceRange(m, clip.in, clip.out);
      const index = op.index === undefined ? p.clips.length : clamp(Math.round(op.index), 0, p.clips.length);
      const at = placeClips(p)[index]?.start ?? timelineDuration(p);
      p.clips.splice(index, 0, clip);
      rippleShift(p, at, clip.out - clip.in);
      return `added clip ${clip.id}`;
    }
    case "remove_clip": {
      const placed = placeClips(p).find((pc) => pc.clip.id === op.id);
      if (!placed) throw new EditError(`no clip ${op.id}`);
      removeTimelineRanges(p, [{ start: placed.start, end: placed.end }]);
      return `removed clip ${op.id}`;
    }
    case "trim_clip": {
      const placed = placeClips(p).find((pc) => pc.clip.id === op.id);
      if (!placed) throw new EditError(`no clip ${op.id}`);
      const { clip } = placed;
      const m = media(p, clip.mediaId);
      const newIn = op.in ?? clip.in;
      const newOut = op.out ?? clip.out;
      checkSourceRange(m, newIn, newOut);
      const inDelta = clip.in - newIn;
      const outDelta = newOut - clip.out;
      clip.in = newIn;
      clip.out = newOut;
      // Shift later items by the change at the tail first, then at the head.
      if (outDelta) rippleShift(p, placed.end, outDelta);
      if (inDelta) rippleShift(p, placed.start + EPS, inDelta);
      return `trimmed ${clip.id} to ${newIn.toFixed(2)}-${newOut.toFixed(2)}`;
    }
    case "move_clip": {
      const i = p.clips.findIndex((c) => c.id === op.id);
      if (i < 0) throw new EditError(`no clip ${op.id}`);
      const before = placeClips(p);
      const [clip] = p.clips.splice(i, 1);
      p.clips.splice(clamp(Math.round(op.index), 0, p.clips.length), 0, clip);
      // Items that sit inside one clip travel with it; items spanning a boundary stay put.
      const after = new Map(placeClips(p).map((pc) => [pc.clip.id, pc.start]));
      const shift = (start: number, end: number) => {
        const pc = before.find((b) => start >= b.start - EPS && end <= b.end + EPS);
        return pc ? after.get(pc.clip.id)! - pc.start : 0;
      };
      for (const o of p.overlays) o.start += shift(o.start, o.start + o.duration);
      for (const z of p.zooms) {
        const d = shift(z.start, z.end);
        z.start += d;
        z.end += d;
      }
      p.overlays.sort((a, b) => a.start - b.start);
      p.zooms.sort((a, b) => a.start - b.start);
      for (const z of p.zooms) checkZoomOverlap(p, z);
      return `moved ${op.id} to index ${op.index}`;
    }
    case "set_focus": {
      const focus = { x: clamp(op.x, 0, 1), y: clamp(op.y, 0, 1) };
      const targets = op.id ? p.clips.filter((c) => c.id === op.id) : p.clips;
      if (op.id && !targets.length) throw new EditError(`no clip ${op.id}`);
      targets.forEach((c) => (c.focus = { ...focus }));
      return `set focus on ${op.id ?? "all clips"}`;
    }
    case "add_broll": {
      const m = media(p, op.mediaId);
      if (!m.hasVideo) throw new EditError(`${m.id} has no picture`);
      const inPoint = m.kind === "image" ? 0 : op.in ?? 0;
      const maxDur = m.kind === "image" ? Infinity : m.duration - inPoint;
      const duration = Math.min(op.duration ?? (m.kind === "image" ? 3 : Math.min(4, maxDur)), maxDur);
      if (duration < MIN_OVERLAY) throw new EditError("b-roll duration too short (check `in`)");
      const total = timelineDuration(p);
      if (op.start < 0 || op.start >= total) throw new EditError(`start must be within the timeline (0-${total.toFixed(2)})`);
      const id = uid("o");
      p.overlays.push({
        id,
        mediaId: m.id,
        start: op.start,
        duration: Math.min(duration, total - op.start),
        in: inPoint,
        mode: op.mode ?? "full",
        volume: op.volume ?? 0,
        ...(op.pip ? { pip: op.pip } : {}),
      });
      p.overlays.sort((a, b) => a.start - b.start);
      return `added b-roll ${id}`;
    }
    case "update_overlay": {
      const o = p.overlays.find((x) => x.id === op.id);
      if (!o) throw new EditError(`no overlay ${op.id}`);
      const { op: _op, id: _id, focus, ...rest } = op;
      Object.assign(o, rest);
      const m = media(p, o.mediaId);
      const total = timelineDuration(p);
      if (o.start < 0 || o.start >= total) throw new EditError(`start must be within the timeline (0-${total.toFixed(2)})`);
      if (m.kind === "image") o.in = 0;
      else {
        if (o.in < 0 || o.in > m.duration - MIN_OVERLAY) throw new EditError(`in must be within ${m.id} (0-${(m.duration - MIN_OVERLAY).toFixed(2)})`);
        o.duration = Math.min(o.duration, m.duration - o.in);
      }
      if (focus) o.focus = { x: clamp(focus.x ?? o.focus?.x ?? 0.5, 0, 1), y: clamp(focus.y ?? o.focus?.y ?? 0.5, 0, 1) };
      p.overlays.sort((a, b) => a.start - b.start);
      return `updated ${o.id}`;
    }
    case "remove_overlay": {
      const n = p.overlays.length;
      p.overlays = p.overlays.filter((o) => o.id !== op.id);
      if (p.overlays.length === n) throw new EditError(`no overlay ${op.id}`);
      return `removed ${op.id}`;
    }
    case "add_zoom": {
      if (op.end <= op.start) throw new EditError("end must be after start");
      const clash = p.zooms.find((z) => op.start < z.end - EPS && op.end > z.start + EPS);
      if (clash) throw new EditError(`overlaps zoom ${clash.id} (${clash.start.toFixed(2)}-${clash.end.toFixed(2)}); update or remove it first`);
      const id = uid("z");
      const f = timelineToSource(p, op.start)?.placed.clip.focus ?? { x: 0.5, y: 0.4 };
      p.zooms.push({ id, start: op.start, end: op.end, scale: op.scale ?? 1.3, focus: { x: clamp(op.x ?? f.x, 0, 1), y: clamp(op.y ?? f.y, 0, 1) }, ...(op.ease ? { ease: Math.max(0, op.ease) } : {}) });
      p.zooms.sort((a, b) => a.start - b.start);
      return `added zoom ${id}`;
    }
    case "update_zoom": {
      const z = p.zooms.find((x) => x.id === op.id);
      if (!z) throw new EditError(`no zoom ${op.id}`);
      if (op.start !== undefined) z.start = op.start;
      if (op.end !== undefined) z.end = op.end;
      if (op.scale !== undefined) z.scale = op.scale;
      if (op.x !== undefined) z.focus.x = clamp(op.x, 0, 1);
      if (op.y !== undefined) z.focus.y = clamp(op.y, 0, 1);
      if (op.ease !== undefined) z.ease = Math.max(0, op.ease);
      if (z.end <= z.start) throw new EditError("end must be after start");
      checkZoomOverlap(p, z);
      p.zooms.sort((a, b) => a.start - b.start);
      return `updated ${z.id}`;
    }
    case "jump_cut_zoom": {
      // Hide jump cuts by alternating framing at each cut: every other clip is punched in.
      // Existing zooms are kept; clips that already overlap a zoom are skipped.
      const scale = op.scale ?? 1.15;
      const placed = placeClips(p);
      let added = 0;
      let alt = false;
      for (let i = 0; i < placed.length; i++) {
        const pc = placed[i];
        const prev = placed[i - 1];
        // A "cut" is a jump in source time (or a different recording) between neighbours.
        const isCut = !!prev && (prev.clip.mediaId !== pc.clip.mediaId || Math.abs(prev.clip.out - pc.clip.in) > (op.minGap ?? 0.05));
        if (isCut) alt = !alt;
        if (!alt || pc.end - pc.start < 0.4) continue;
        if (p.zooms.some((z) => z.start < pc.end - EPS && z.end > pc.start + EPS)) continue;
        const f = pc.clip.focus ?? { x: 0.5, y: 0.4 };
        p.zooms.push({ id: uid("z"), start: pc.start, end: pc.end, scale, focus: { ...f } });
        added++;
      }
      p.zooms.sort((a, b) => a.start - b.start);
      return `added ${added} jump-cut zoom(s) at ×${scale}`;
    }
    case "remove_zoom": {
      const n = p.zooms.length;
      p.zooms = p.zooms.filter((z) => z.id !== op.id);
      if (p.zooms.length === n) throw new EditError(`no zoom ${op.id}`);
      return `removed ${op.id}`;
    }
    case "set_captions": {
      const { op: _op, preset, ...style } = op;
      if (preset) {
        const tpl = CAPTION_PRESETS.find((x) => x.id === preset);
        if (!tpl) throw new EditError(`unknown caption preset ${preset}; use one of ${CAPTION_PRESETS.map((x) => x.id).join(", ")}`);
        Object.assign(p.captions, tpl.style, { preset, enabled: true });
      }
      Object.assign(p.captions, style);
      if (preset === null) p.captions.preset = null;
      return `captions ${p.captions.enabled ? "on" : "off"}${p.captions.preset ? ` (${p.captions.preset})` : ""}`;
    }
    case "set_hook": {
      const { op: _op, ...hook } = op;
      Object.assign(p.hook, hook);
      if (hook.text !== undefined && hook.enabled === undefined && hook.text.trim()) p.hook.enabled = true;
      if (p.hook.duration < 0.5 || p.hook.duration > 15) throw new EditError("hook duration must be 0.5-15s");
      return p.hook.enabled ? `hook "${p.hook.text}" ${p.hook.start.toFixed(1)}-${(p.hook.start + p.hook.duration).toFixed(1)}s` : "hook off";
    }
    case "set_watermark": {
      const { op: _op, ...wm } = op;
      if (wm.file && (wm.file.startsWith("/") || wm.file.split(/[\\/]/).includes(".."))) throw new EditError("watermark file must be inside the project folder");
      Object.assign(p.watermark, wm);
      return `watermark ${p.watermark.enabled ? `on (${p.watermark.corner})` : "off"}`;
    }
    case "set_audio": {
      const { op: _op, ...audio } = op;
      Object.assign(p.audio, audio);
      return `studio sound ${p.audio.preset}${p.audio.preset !== "off" ? ` at ${Math.round(p.audio.strength * 100)}%` : ""}`;
    }
    case "set_look": {
      const { op: _op, ...look } = op;
      if (look.lut && !look.lut.startsWith("custom:") && !LOOK_IDS.includes(look.lut)) {
        throw new EditError(`unknown look ${look.lut}; use one of ${LOOK_IDS.join(", ")} or "custom:<file.cube>"`);
      }
      Object.assign(p.look, look);
      return `look ${p.look.lut ?? "none"}${p.look.lut ? ` at ${Math.round(p.look.intensity * 100)}%` : ""}`;
    }
    case "set_settings": {
      const { op: _op, aspect, ...rest } = op;
      if (aspect) {
        const preset = ASPECTS[aspect];
        if (!preset) throw new EditError(`unknown aspect ${aspect}; use one of ${Object.keys(ASPECTS).join(", ")}`);
        Object.assign(p.settings, preset);
      }
      Object.assign(p.settings, rest);
      return `settings ${p.settings.width}x${p.settings.height}@${p.settings.fps}`;
    }
    default: {
      const never: never = op;
      throw new EditError(`unknown op ${(never as { op: string }).op}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Core range operations

/** Remove timeline ranges from the main track, rippling overlays and zooms. Returns seconds removed. */
export function removeTimelineRanges(p: Project, ranges: Range[]): number {
  const merged = mergeRanges(ranges.map((r) => ({ start: Math.max(0, r.start), end: Math.min(r.end, timelineDuration(p)) })));
  let removed = 0;
  // Work back to front so earlier positions stay valid.
  for (const r of merged.reverse()) {
    const next: Clip[] = [];
    for (const pc of placeClips(p)) {
      const { clip } = pc;
      if (pc.end <= r.start + EPS || pc.start >= r.end - EPS) {
        next.push(clip);
        continue;
      }
      if (pc.start < r.start) next.push({ ...clip, out: clip.in + (r.start - pc.start) });
      if (pc.end > r.end) {
        const keepsId = pc.start >= r.start;
        next.push({ ...clip, id: keepsId ? clip.id : uid("c"), in: clip.in + (r.end - pc.start) });
      }
    }
    p.clips = next.filter((c) => c.out - c.in >= MIN_CLIP);
    removed += r.end - r.start;
    rippleRemove(p, r);
  }
  return removed;
}

/** Remove source ranges of one media wherever they appear on the main track. */
export function removeSourceRanges(p: Project, mediaId: string, ranges: Range[]): number {
  const timeline: Range[] = [];
  for (const pc of placeClips(p)) {
    if (pc.clip.mediaId !== mediaId) continue;
    for (const r of ranges) {
      const s = Math.max(r.start, pc.clip.in);
      const e = Math.min(r.end, pc.clip.out);
      if (e - s > EPS) timeline.push({ start: pc.start + s - pc.clip.in, end: pc.start + e - pc.clip.in });
    }
  }
  return removeTimelineRanges(p, timeline);
}

/** Bring back a source range that was cut. Returns seconds added to the timeline. */
export function restoreSourceRange(p: Project, mediaId: string, range: Range): number {
  const dur = p.media.find((m) => m.id === mediaId)?.duration ?? Infinity;
  const r = { start: Math.max(0, range.start), end: Math.min(dur, range.end) };
  if (r.end - r.start <= EPS) return 0;
  const all = placeClips(p);
  const placed = all.filter((pc) => pc.clip.mediaId === mediaId);
  // Gaps to fill, located on the timeline before anything moves.
  const fills: { at: number; len: number }[] = [];

  let head = placed.find((pc) => pc.clip.in <= r.start + EPS && pc.clip.out >= r.start - EPS);
  if (!head) {
    const first = placed.filter((pc) => pc.clip.in > r.start && pc.clip.in <= r.end + EPS).sort((a, b) => a.clip.in - b.clip.in)[0];
    if (!first) {
      const prev = [...placed].reverse().find((pc) => pc.clip.out <= r.start + EPS);
      const next = placed.find((pc) => pc.clip.in >= r.end - EPS);
      const index = prev ? prev.index + 1 : next ? next.index : p.clips.length;
      const at = prev ? prev.end : next ? next.start : timelineDuration(p);
      p.clips.splice(index, 0, { id: uid("c"), mediaId, in: r.start, out: r.end });
      rippleShift(p, at, r.end - r.start);
      return r.end - r.start;
    }
    fills.push({ at: first.start, len: first.clip.in - r.start });
    first.clip.in = r.start;
    head = first;
  }

  // Walk forward through the run of clips this range spans, filling the cut gaps between them.
  // Only clips that move forward in source time continue the run, so deliberate repeats survive.
  const merges: number[] = [];
  let a = head;
  for (;;) {
    const b = all[a.index + 1];
    if (!b || b.clip.mediaId !== mediaId || b.clip.in < a.clip.out - EPS || b.clip.in > r.end + EPS) break;
    if (b.clip.in - a.clip.out > EPS) {
      fills.push({ at: a.end, len: b.clip.in - a.clip.out });
      merges.push(a.index);
    }
    a = b;
  }
  if (r.end - a.clip.out > EPS) {
    fills.push({ at: a.end, len: r.end - a.clip.out });
    a.clip.out = r.end;
  }
  for (const i of merges.reverse()) {
    p.clips[i].out = p.clips[i + 1].out;
    p.clips.splice(i + 1, 1);
  }
  let added = 0;
  for (const f of fills.sort((x, y) => y.at - x.at)) {
    rippleShift(p, f.at, f.len);
    added += f.len;
  }
  return added;
}

/** Throws if zoom `z` overlaps another zoom. */
function checkZoomOverlap(p: Project, z: { id: string; start: number; end: number }): void {
  const clash = p.zooms.find((o) => o.id !== z.id && z.start < o.end - EPS && z.end > o.start + EPS);
  if (clash) throw new EditError(`overlaps zoom ${clash.id} (${clash.start.toFixed(2)}-${clash.end.toFixed(2)}); update or remove it first`);
}

function rippleRemove(p: Project, r: Range): void {
  const len = r.end - r.start;
  const map = (t: number) => (t <= r.start ? t : t < r.end ? r.start : t - len);
  p.overlays = p.overlays
    .map((o) => {
      const start = map(o.start);
      return { ...o, start, duration: map(o.start + o.duration) - start };
    })
    .filter((o) => o.duration >= MIN_OVERLAY);
  p.zooms = p.zooms
    .map((z) => ({ ...z, start: map(z.start), end: map(z.end) }))
    .filter((z) => z.end - z.start >= MIN_OVERLAY);
}

function rippleShift(p: Project, at: number, delta: number): void {
  for (const o of p.overlays) if (o.start >= at - EPS) o.start = Math.max(0, o.start + delta);
  for (const z of p.zooms) {
    if (z.start >= at - EPS) {
      z.start = Math.max(0, z.start + delta);
      z.end = Math.max(z.start + MIN_OVERLAY, z.end + delta);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers

/**
 * Source range for words [from..to]. Takes the word plus the gap after it (up to a cap),
 * so removing a word doesn't leave a double pause.
 */
export function wordRange(t: Transcript, from: number, to: number): Range {
  if (from > to) [from, to] = [to, from];
  const first = t.words[from];
  const last = t.words[to];
  if (!first || !last) throw new EditError(`word index out of range (transcript has ${t.words.length} words, 0-${t.words.length - 1})`);
  const prev: Word | undefined = t.words[from - 1];
  const next: Word | undefined = t.words[to + 1];
  const start = Math.max(prev ? prev.end : 0, first.start - 0.02);
  const end = next ? Math.min(next.start, last.end + 0.3) : last.end + 0.1;
  return { start, end: Math.max(end, last.end) };
}

function findText(p: Project, ctx: EditContext, text: string, onlyMedia?: string) {
  const needle = text.split(/\s+/).map(normalizeWord).filter(Boolean);
  if (!needle.length) throw new EditError("empty text");
  const out: { mediaId: string; from: number; to: number }[] = [];
  for (const mediaId of mainMediaIds(p, onlyMedia)) {
    const t = ctx.transcripts[mediaId];
    if (!t) continue;
    const kept = mapWords(p, t).filter((w) => w.kept);
    const norm = kept.map((w) => normalizeWord(w.word.text));
    for (let i = 0; i + needle.length <= kept.length; i++) {
      if (needle.every((n, k) => norm[i + k] === n)) {
        out.push({ mediaId, from: kept[i].word.i, to: kept[i + needle.length - 1].word.i });
        i += needle.length - 1;
      }
    }
  }
  return out;
}

function gapsFromTranscript(t: Transcript | undefined, duration: number): Silence[] | undefined {
  if (!t || !t.words.length) return undefined;
  const gaps: Silence[] = [];
  let prev = 0;
  for (const w of t.words) {
    if (w.start > prev) gaps.push({ start: prev, end: w.start });
    prev = Math.max(prev, w.end);
  }
  if (duration > prev) gaps.push({ start: prev, end: duration });
  return gaps;
}

function mainMediaIds(p: Project, only?: string): string[] {
  if (only) return [media(p, only).id];
  return [...new Set(p.clips.map((c) => c.mediaId))];
}

function media(p: Project, id: string): MediaAsset {
  const m = p.media.find((x) => x.id === id);
  if (!m) throw new EditError(`no media ${id}; available: ${p.media.map((x) => x.id).join(", ") || "none"}`);
  return m;
}

function transcript(ctx: EditContext, mediaId: string): Transcript {
  const t = ctx.transcripts[mediaId];
  if (!t) throw new EditError(`${mediaId} has no transcript yet; run analyze first`);
  return t;
}

function checkSourceRange(m: MediaAsset, start: number, end: number): void {
  if (start < -EPS || end > m.duration + 0.05 || end - start < MIN_CLIP) {
    throw new EditError(`invalid range ${start.toFixed(2)}-${end.toFixed(2)} for ${m.id} (duration ${m.duration.toFixed(2)})`);
  }
}

export function validateProject(p: Project): string[] {
  const errors: string[] = [];
  const byId = new Map(p.media.map((m) => [m.id, m]));
  for (const c of p.clips) {
    const m = byId.get(c.mediaId);
    if (!m) errors.push(`clip ${c.id} references missing media ${c.mediaId}`);
    else if (c.in < -EPS || c.out > m.duration + 0.05 || c.out - c.in < MIN_CLIP / 2) errors.push(`clip ${c.id} has invalid range ${c.in}-${c.out}`);
  }
  const total = timelineDuration(p);
  for (const o of p.overlays) {
    const m = byId.get(o.mediaId);
    if (!m) errors.push(`overlay ${o.id} references missing media ${o.mediaId}`);
    if (o.start < -EPS || o.duration < MIN_OVERLAY / 2) errors.push(`overlay ${o.id} has invalid timing`);
    else if (o.start + o.duration > total + 0.05) errors.push(`overlay ${o.id} runs past the end of the timeline`);
    if (o.volume < 0 || o.volume > 2) errors.push(`overlay ${o.id} volume must be 0-2`);
  }
  for (const z of p.zooms) {
    if (z.scale < 1 || z.scale > 4) errors.push(`zoom ${z.id} scale must be 1-4`);
    if (z.end <= z.start) errors.push(`zoom ${z.id} has invalid range`);
  }
  const s = p.settings;
  if (!/^#[0-9a-fA-F]{6}$/.test(s.background)) errors.push("settings.background must be a #rrggbb color");
  if (s.width < 16 || s.height < 16 || s.width % 2 || s.height % 2) errors.push("output width/height must be even and >= 16");
  if (s.fps < 1 || s.fps > 120) errors.push("fps must be 1-120");
  if (p.captions.maxWords < 1) errors.push("captions.maxWords must be >= 1");
  return errors;
}
