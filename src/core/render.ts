// Renders a RenderPlan with a single ffmpeg filter graph. Long, heavily cut timelines (hundreds of
// pieces) are rendered in frame-exact slices at cut boundaries, a few in parallel; the slices are
// joined without re-encoding and the audio is mastered once over the whole timeline.
//
// Graph shape:
//   main pieces:  [in]trim → scale/crop (cover + zoom) ─┐
//                 [in]atrim → fades ────────────────────┴→ concat → base
//   b-roll:       base → overlay(enable=between(t,…)) → …
//   captions:     PNG pages via the concat demuxer → overlay
//   audio:        concat (+ b-roll audio) → loudnorm
//
// Captions are drawn with @napi-rs/canvas using the same drawCaptionFrame() as the
// editor preview, so we don't depend on ffmpeg being built with libass/freetype.
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { ffmpeg, filterScriptArg, probe } from "./ffmpeg.js";
import type { ProjectStore } from "./project.js";
import { captionSampleTimes, drawCaptionFrame, type CaptionPage, type Ctx2D } from "./shared/captions.js";
import { drawHook, hookActive, hookSampleTimes, hookSteady } from "./shared/hook.js";
import { audioFilterChain } from "./shared/audio.js";
import { bakeLook, cubeText, isNeutral, parseCube } from "./shared/looks.js";
import { registerProjectFonts } from "./fonts.js";
import { buildPlan, type PlanOverlay, type PlanPiece, type RenderPlan } from "./shared/plan.js";
import { computeCrop, even } from "./shared/timeline.js";
import type { CaptionStyle, HookTitle, Look, MediaAsset, Project, Transcript } from "./shared/types.js";

export interface RenderOptions {
  out: string;
  range?: { start: number; end: number };
  /** Scale output resolution (e.g. 0.33 for previews). */
  scale?: number;
  quality?: "draft" | "standard" | "high";
  /** Render a single still frame (PNG) at range.start instead of a video. */
  still?: boolean;
  /** Render audio only (AAC in .m4a), e.g. to audition studio sound. */
  audioOnly?: boolean;
  onProgress?: (fraction: number) => void;
  signal?: AbortSignal;
}

const QUALITY = {
  draft: { preset: "ultrafast", crf: "30", audio: "96k" },
  standard: { preset: "medium", crf: "20", audio: "192k" },
  high: { preset: "slow", crf: "16", audio: "256k" },
};

export async function render(store: ProjectStore, opts: RenderOptions): Promise<{ out: string; duration: number; plan: RenderPlan }> {
  const project = await store.load();
  const { transcripts } = await store.context();
  const range = opts.still && opts.range ? { start: opts.range.start, end: opts.range.start + 1 / project.settings.fps } : opts.range;
  const plan = buildPlan(project, transcripts, range);
  if (!plan.pieces.length) throw new Error(project.clips.length ? "Nothing to render in that range" : "The timeline is empty");
  const workDir = join(store.dataDir, "render");
  await mkdir(workDir, { recursive: true });

  const chunks = opts.still ? [] : chunkRanges(plan, project.settings.fps);
  if (chunks.length > 1) await renderChunked(store, project, transcripts, plan, chunks, opts, workDir);
  else await renderGraph(store, project, plan, opts, { kind: "full", out: opts.out }, workDir, opts.onProgress);
  return { out: opts.out, duration: plan.duration, plan };
}

type GraphMode =
  /** Everything in one pass: video + mastered audio (or a still / audio only). */
  | { kind: "full"; out: string }
  /** One slice of a long render: finished video (no audio) + the raw main-track audio, mastered later. */
  | { kind: "chunk"; videoOut: string | null; audioOut: string };

/** Builds and runs one ffmpeg filter graph for `plan`. */
async function renderGraph(store: ProjectStore, project: Project, plan: RenderPlan, opts: RenderOptions, mode: GraphMode, workDir: string, onProgress?: (f: number) => void): Promise<void> {
  const scale = opts.scale ?? 1;
  const W = even(project.settings.width * scale);
  const H = even(project.settings.height * scale);
  const fps = project.settings.fps;
  const q = QUALITY[opts.quality ?? "standard"];
  const media = new Map(project.media.map((m) => [m.id, m]));
  const withVideo = mode.kind === "full" ? !opts.audioOnly : mode.videoOut !== null;
  const master = mode.kind === "full";

  const args: string[] = [];
  const graph: string[] = [];
  let inputCount = 0;
  const addInput = (inputArgs: string[]) => {
    args.push(...inputArgs);
    return inputCount++;
  };
  // --- Main track ---------------------------------------------------------
  // One input per media file, seeked near the first piece we need, reused by every trim.
  const mainInputs = new Map<string, { index: number; offset: number; audio: Span | null; video: Span | null }>();
  for (const id of new Set(plan.pieces.map((p) => p.mediaId))) {
    const m = media.get(id)!;
    const ps = plan.pieces.filter((p) => p.mediaId === id);
    let srcIn = Infinity;
    let srcOut = 0;
    for (const p of ps) {
      srcIn = Math.min(srcIn, p.srcIn);
      srcOut = Math.max(srcOut, p.srcOut);
    }
    const offset = Math.max(0, srcIn - 1);
    const end = srcOut + 0.5;
    const path = store.resolveMediaPath(m);
    const index = addInput(["-ss", offset.toFixed(3), "-t", (end - offset).toFixed(3), "-i", path]);
    // Where the audio track actually is: it can start late or stop early, and a segment with no
    // audio at all must be generated as silence (an empty atrim branch fails the whole graph).
    const spans = m.hasAudio || m.hasVideo ? await streamSpans(path) : null;
    mainInputs.set(id, { index, offset, audio: m.hasAudio ? spans!.audio : null, video: m.hasVideo ? spans!.video : null });
  }

  // Snap piece boundaries to the frame grid and make every segment exactly N frames of video and
  // the matching number of audio samples, so A/V stays in sync across many cuts.
  const RATE = 48000;
  const frame = (t: number) => Math.round(t * fps);
  const sample = (f: number) => Math.round((f * RATE) / fps);
  const fade = project.settings.cutFadeMs / 1000;
  const bg = /^#[0-9a-fA-F]{6}$/.test(project.settings.background) ? project.settings.background.replace("#", "0x") : "0x000000";
  // Same media and contiguous in source time: a zoom split, not a cut, so no fade.
  const continues = (a: PlanPiece | undefined, b: PlanPiece | undefined) => !!a && !!b && a.mediaId === b.mediaId && Math.abs(a.srcOut - b.srcIn) < 1e-3;
  const segs: string[] = [];
  let next = 0;
  plan.pieces.forEach((p, k) => {
    const f0 = frame(p.start);
    const n = frame(p.end) - f0;
    if (n <= 0) return;
    const dur = n / fps;
    const samples = sample(f0 + n) - sample(f0);
    const m = media.get(p.mediaId)!;
    const { index, offset, audio, video: vspan } = mainInputs.get(p.mediaId)!;
    const covers = (span: Span | null) => !!span && span.start < offset + s + dur - 0.005 && span.end > offset + s + 0.005;
    // After a cut, start on a source frame so audio begins exactly where the first video frame does;
    // across a zoom split, carry on from where the previous segment ended.
    const src = p.srcIn + (f0 / fps - p.start);
    const s = continues(plan.pieces[k - 1], p) ? next : snapToFrame(src, m.fps) - offset;
    next = s + dur;
    // Pad with the last frame then cut, so rounding in the source (or a video track that ends before
    // the audio) can't add or drop a frame: concat needs every segment's video and audio equally long.
    const exact = `tpad=stop_mode=clone:stop=-1,trim=end_frame=${n},setpts=PTS-STARTPTS`;
    if (m.hasVideo && covers(vspan)) {
      // Timestamps stay anchored to the source clock (PTS - s) rather than to whichever frame happens
      // to come first, and fps (start_time=0) picks the frame on screen at each output tick. With
      // variable frame rate sources the first frame after a cut can be far from s, and resetting to
      // STARTPTS would shift the whole segment against its audio.
      const framing = p.zoom === p.zoomTo ? staticFraming(m, W, H, p) : rampFraming(m, W, H, p, n, fps);
      graph.push(`[${index}:v]${videoSegment(s, dur, m.fps, fps)},${exact},${framing},setsar=1,format=yuv420p[v${k}]`);
    } else {
      graph.push(`color=c=${bg}:s=${W}x${H}:r=${fps}:d=${dur.toFixed(6)},${exact},format=yuv420p[v${k}]`);
    }
    const f = Math.min(fade, dur / 4);
    const fades = [
      f > 0 && !continues(plan.pieces[k - 1], p) ? `afade=t=in:d=${f.toFixed(4)}` : "",
      f > 0 && !continues(p, plan.pieces[k + 1]) ? `afade=t=out:st=${(dur - f).toFixed(4)}:d=${f.toFixed(4)}` : "",
    ].filter(Boolean).map((x) => "," + x).join("");
    const fit = `apad=whole_len=${samples},atrim=end_sample=${samples}${fades}`;
    if (covers(audio)) {
      graph.push(`[${index}:a]${audioSegment(s, dur, RATE)},aformat=sample_fmts=fltp:channel_layouts=stereo,${fit}[a${k}]`);
    } else {
      graph.push(`anullsrc=r=${RATE}:cl=stereo,${fit}[a${k}]`);
    }
    segs.push(`[v${k}][a${k}]`);
  });
  if (!segs.length) throw new Error("Range is shorter than one frame");
  graph.push(`${segs.join("")}concat=n=${segs.length}:v=1:a=1[vbase][abase]`);
  let video = "vbase";
  const audioMix = ["[abase]"];
  if (master) {
    const enhance = enhanceChain(project, RATE);
    if (enhance) {
      graph.push(`[abase]${enhance}[aenh]`);
      audioMix[0] = "[aenh]";
    }
    addBrollAudio(store, plan, media, addInput, graph, audioMix);
  }

  if (withVideo) {
    // --- Color grade (main track only; b-roll keeps its own look) -------------------
    if (!isNeutral(project.look)) {
      const cube = await lookCubeFile(store, project.look);
      graph.push(`[vbase]lut3d=file='${cube}':interp=tetrahedral[vgrade]`);
      video = "vgrade";
    }

    // --- B-roll ---------------------------------------------------------------
    plan.overlays.forEach((o, k) => {
      const m = media.get(o.mediaId);
      if (!m || !m.hasVideo) return;
      const index = brollInput(store, o, m, fps, addInput);
      let fit: string;
      let x = 0;
      let y = 0;
      if (o.mode === "pip") {
        const pip = o.pip ?? { x: 0.68, y: 0.06, w: 0.28 };
        const pw = even(W * pip.w);
        const ph = even((pw * m.height) / Math.max(m.width, 1));
        fit = `scale=${pw}:${ph}`;
        x = Math.round(pip.x * W);
        y = Math.round(pip.y * H);
      } else {
        const c = computeCrop(m.width, m.height, W, H, 1, o.focus);
        fit = `scale=${c.width}:${c.height}:flags=bicubic,crop=${W}:${H}:${c.x}:${c.y}`;
      }
      graph.push(`[${index}:v]setpts=PTS-STARTPTS+${o.start.toFixed(4)}/TB,fps=${fps},${fit},setsar=1,format=yuva420p[ov${k}]`);
      graph.push(`[${video}][ov${k}]overlay=${x}:${y}:eof_action=pass:enable='between(t,${o.start.toFixed(4)},${o.end.toFixed(4)})'[vo${k}]`);
      video = `vo${k}`;
    });

    // --- Watermark ----------------------------------------------------------------
    const wm = project.watermark;
    if (wm.enabled && wm.file) {
      const logo = join(store.dir, wm.file);
      if (existsSync(logo)) {
        const index = addInput(["-loop", "1", "-framerate", String(fps), "-t", plan.duration.toFixed(3), "-i", logo]);
        const lw = even(W * wm.size);
        const m = Math.round(W * wm.margin);
        const x = wm.corner.endsWith("l") ? `${m}` : `W-w-${m}`;
        const y = wm.corner.startsWith("t") ? `${m}` : `H-h-${m}`;
        graph.push(`[${index}:v]scale=${lw}:-2,format=rgba,colorchannelmixer=aa=${wm.opacity.toFixed(3)}[wm]`);
        graph.push(`[${video}][wm]overlay=${x}:${y}:eof_action=pass:format=auto[vwm]`);
        video = "vwm";
      }
    }

    // --- Captions and hook title ----------------------------------------------------
    if (plan.captions.length || plan.hook) {
      await registerProjectFonts(store);
      const list = await renderTextStream(plan.captions, project.captions, plan.hook, W, H, plan.duration, fps, workDir);
      const index = addInput(["-f", "concat", "-safe", "0", "-i", list]);
      graph.push(`[${index}:v]format=rgba[caps]`);
      graph.push(`[${video}][caps]overlay=0:0:eof_action=pass:format=auto[vcap]`);
      video = "vcap";
    }
    graph.push(`[${video}]format=yuv420p[vout]`);
  } else {
    graph.push(`[${video}]nullsink`);
  }

  // --- Audio master -------------------------------------------------------------
  if (opts.still) {
    graph.push(`${audioMix.join("")}amix=inputs=${audioMix.length},anullsink`);
  } else if (master) {
    graph.push(`${masterAudio(project, audioMix)}[aout]`);
  } else {
    graph.push(`[abase]anull[aout]`);
  }

  const scriptPath = join(workDir, `graph-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.txt`);
  await writeFile(scriptPath, graph.join(";\n"));
  const flag = await filterScriptArg();
  const t = ["-t", plan.duration.toFixed(4)];
  const x264 = ["-c:v", "libx264", "-preset", q.preset, "-crf", q.crf, "-pix_fmt", "yuv420p", "-r", String(fps)];
  let output: string[];
  if (mode.kind === "chunk") {
    output = [
      ...(mode.videoOut ? ["-map", "[vout]", ...x264, ...t, "-an", mode.videoOut] : []),
      // Raw main-track audio, lossless (24-bit FLAC): it is mastered across the whole timeline later.
      "-map", "[aout]", "-c:a", "flac", "-sample_fmt", "s32", ...t, "-vn", mode.audioOut,
    ];
  } else if (opts.still) {
    output = ["-map", "[vout]", "-frames:v", "1", mode.out];
  } else if (opts.audioOnly) {
    output = ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k", ...t, mode.out];
  } else {
    output = ["-map", "[vout]", "-map", "[aout]", ...x264, "-c:a", "aac", "-b:a", q.audio, ...t, "-movflags", "+faststart", mode.out];
  }
  try {
    await ffmpeg([...args, flag, scriptPath, ...output], { onProgress, duration: plan.duration, signal: opts.signal });
  } finally {
    await rm(scriptPath, { force: true });
  }
}

/** Studio-sound chain, with afftdn's latency removed so the voice stays in sync with the picture. */
function enhanceChain(project: Project, rate: number): string | null {
  const enhance = audioFilterChain(project.audio);
  if (!enhance) return null;
  if (!/afftdn/.test(enhance)) return enhance;
  const lag = Math.round(AFFTDN_LATENCY * rate);
  return `apad=pad_len=${lag},${enhance},atrim=start_sample=${lag},asetpts=PTS-STARTPTS`;
}

/** afftdn delays its output by half its 50 ms analysis window (measured: 25.0 ms at 44.1/48 kHz). */
export const AFFTDN_LATENCY = 0.025;

function masterAudio(project: Project, audioMix: string[]): string {
  let audio = audioMix.length > 1 ? `${audioMix.join("")}amix=inputs=${audioMix.length}:normalize=0:duration=first` : `${audioMix[0]}anull`;
  if (project.settings.normalizeAudio) audio += ",loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000";
  return audio;
}

function brollInput(store: ProjectStore, o: PlanOverlay, m: MediaAsset, fps: number, addInput: (a: string[]) => number): number {
  const dur = o.end - o.start;
  const path = store.resolveMediaPath(m);
  return m.kind === "image"
    ? addInput(["-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(3), "-i", path])
    : addInput(["-ss", o.srcIn.toFixed(3), "-t", dur.toFixed(3), "-i", path]);
}

/** Audible b-roll, delayed to its timeline position and mixed with the main track. */
function addBrollAudio(store: ProjectStore, plan: RenderPlan, media: Map<string, MediaAsset>, addInput: (a: string[]) => number, graph: string[], audioMix: string[]) {
  plan.overlays.forEach((o, k) => {
    const m = media.get(o.mediaId);
    if (!m || !(o.volume > 0) || !m.hasAudio || m.kind === "image") return;
    const dur = o.end - o.start;
    const index = addInput(["-ss", o.srcIn.toFixed(3), "-t", dur.toFixed(3), "-i", store.resolveMediaPath(m)]);
    const delay = Math.round(o.start * 48000);
    graph.push(`[${index}:a]atrim=0:${dur.toFixed(4)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume=${o.volume},adelay=${delay}S:all=1[oa${k}]`);
    audioMix.push(`[oa${k}]`);
  });
}

// --- Long timelines: render in slices, then master the audio once ----------------------

/** Above this many pieces a single filter graph gets slow: every decoded frame visits every trim. */
const CHUNK_MAX_PIECES = 24;
const CHUNK_MAX_SECONDS = 240;

function staticFraming(m: { width: number; height: number }, W: number, H: number, p: PlanPiece): string {
  const c = computeCrop(m.width, m.height, W, H, p.zoom, p.focus);
  return `scale=${c.width}:${c.height}:flags=bicubic,crop=${W}:${H}:${c.x}:${c.y}`;
}

/**
 * A smooth zoom ramp, frame by frame, matching the preview (pieceZoomAt + computeCrop): crop to the
 * zoom-1 framing at 2x resolution (so slow zooms don't jitter on integer pixel steps), then zoompan
 * with the same smoothstep curve and the same focus clamping as computeCrop.
 */
function rampFraming(m: { width: number; height: number }, W: number, H: number, p: PlanPiece, n: number, fps: number): string {
  const c = computeCrop(m.width, m.height, W, H, 1, p.focus);
  const S = 2;
  const u = `(on/${n})`;
  const z = `${p.zoom.toFixed(5)}+(${(p.zoomTo - p.zoom).toFixed(5)})*${u}*${u}*(3-2*${u})`;
  // Window position in the zoom-1 frame: computeCrop's clamped offset at this zoom, mapped back.
  const x = `${S}*(clip(${p.focus.x.toFixed(5)}*${c.width}*zoom-${W / 2},0,${c.width}*zoom-${W})/zoom-${c.x})`;
  const y = `${S}*(clip(${p.focus.y.toFixed(5)}*${c.height}*zoom-${H / 2},0,${c.height}*zoom-${H})/zoom-${c.y})`;
  return `scale=${c.width * S}:${c.height * S}:flags=bicubic,crop=${W * S}:${H * S}:${c.x * S}:${c.y * S},zoompan=z='${z}':x='${x}':y='${y}':d=1:s=${W}x${H}:fps=${fps}`;
}

/**
 * Split a plan into frame-exact timeline ranges at cut boundaries (never inside a zoom split, so no
 * fade is added there). Returns [] when one graph is fine.
 */
export function chunkRanges(plan: Pick<RenderPlan, "pieces" | "duration">, fps: number, maxPieces = CHUNK_MAX_PIECES, maxSeconds = CHUNK_MAX_SECONDS): { start: number; end: number }[] {
  const ps = plan.pieces;
  if (ps.length <= maxPieces * 1.5) return [];
  const frames = Math.round(plan.duration * fps);
  const cuts: number[] = [0];
  let count = 0;
  let startFrame = 0;
  for (let k = 1; k < ps.length; k++) {
    count++;
    const a = ps[k - 1];
    const b = ps[k];
    const seam = !(a.mediaId === b.mediaId && Math.abs(a.srcOut - b.srcIn) < 1e-3);
    const f = Math.round(b.start * fps);
    if (seam && f > startFrame && (count >= maxPieces || (f - startFrame) / fps >= maxSeconds)) {
      cuts.push(f);
      startFrame = f;
      count = 0;
    }
  }
  // Fold a tiny tail into the previous chunk.
  if (cuts.length > 1 && frames - cuts[cuts.length - 1] < fps) cuts.pop();
  if (cuts.length < 2) return [];
  return cuts.map((f, i) => ({ start: f / fps, end: (i + 1 < cuts.length ? cuts[i + 1] : frames) / fps }));
}

async function renderChunked(store: ProjectStore, project: Project, transcripts: Record<string, Transcript | undefined>, plan: RenderPlan, ranges: { start: number; end: number }[], opts: RenderOptions, workDir: string): Promise<void> {
  const dir = join(workDir, `chunks-${process.pid}-${Date.now()}`);
  await mkdir(dir, { recursive: true });
  const base = plan.range.start;
  const total = plan.duration;
  const done = new Array(ranges.length).fill(0);
  const report = () => opts.onProgress?.(Math.min(0.92, (0.92 * done.reduce((a, b) => a + b, 0)) / total));
  const parts = ranges.map((r, i) => ({ r, video: opts.audioOnly ? null : join(dir, `v${i}.mp4`), audio: join(dir, `a${i}.flac`) }));
  try {
    const parallel = Math.max(1, Math.min(4, Math.round(cpus().length / 4)));
    let nextJob = 0;
    const worker = async () => {
      for (let i = nextJob++; i < parts.length; i = nextJob++) {
        opts.signal?.throwIfAborted();
        const { r, video, audio } = parts[i];
        const sub = buildPlan(project, transcripts, { start: base + r.start, end: base + r.end });
        // Captions keep their real page times (not clipped to the slice), so an entrance animation
        // isn't replayed where two slices meet.
        sub.captions = plan.captions
          .filter((pg) => pg.end > r.start && pg.start < r.end)
          .map((pg) => ({ start: pg.start - r.start, end: pg.end - r.start, words: pg.words.map((w) => ({ ...w, start: w.start - r.start, end: w.end - r.start })) }));
        sub.duration = r.end - r.start;
        await renderGraph(store, project, sub, opts, { kind: "chunk", videoOut: video, audioOut: audio }, workDir, (f) => {
          done[i] = f * (r.end - r.start);
          report();
        });
        done[i] = r.end - r.start;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(parallel, parts.length) }, worker));

    // Master: join the slices (video stream-copied), then studio sound, b-roll audio and loudness
    // over the whole timeline in one pass.
    const list = async (name: string, files: string[]) => {
      const path = join(dir, name);
      await writeFile(path, ["ffconcat version 1.0", ...files.map((f) => `file ${q(f)}`)].join("\n"));
      return path;
    };
    const args: string[] = [];
    let inputs = 0;
    const addInput = (a: string[]) => {
      args.push(...a);
      return inputs++;
    };
    const vIndex = opts.audioOnly ? -1 : addInput(["-f", "concat", "-safe", "0", "-i", await list("video.txt", parts.map((p) => p.video!))]);
    const aIndex = addInput(["-f", "concat", "-safe", "0", "-i", await list("audio.txt", parts.map((p) => p.audio))]);
    const graph: string[] = [];
    const audioMix = [`[${aIndex}:a]`];
    const enhance = enhanceChain(project, 48000);
    if (enhance) {
      graph.push(`[${aIndex}:a]${enhance}[aenh]`);
      audioMix[0] = "[aenh]";
    }
    addBrollAudio(store, plan, new Map(project.media.map((m) => [m.id, m])), addInput, graph, audioMix);
    graph.push(`${masterAudio(project, audioMix)}[aout]`);
    const scriptPath = join(dir, "master.txt");
    await writeFile(scriptPath, graph.join(";\n"));
    const qa = QUALITY[opts.quality ?? "standard"];
    const t = ["-t", total.toFixed(4)];
    const output = opts.audioOnly
      ? ["-map", "[aout]", "-c:a", "aac", "-b:a", "192k", ...t, opts.out]
      : ["-map", `${vIndex}:v`, "-c:v", "copy", "-map", "[aout]", "-c:a", "aac", "-b:a", qa.audio, ...t, "-movflags", "+faststart", opts.out];
    await ffmpeg([...args, await filterScriptArg(), scriptPath, ...output], {
      onProgress: (f) => opts.onProgress?.(0.92 + 0.08 * f),
      duration: total,
      signal: opts.signal,
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Bake the project's look into a .cube for ffmpeg's lut3d. Written to the OS temp dir so the
 * path has no characters that need filtergraph escaping.
 */
async function lookCubeFile(store: ProjectStore, look: Look): Promise<string> {
  let custom = null;
  let customKey = "";
  if (look.lut?.startsWith("custom:")) {
    const file = join(store.dir, "luts", look.lut.slice(7));
    const text = await readFile(file, "utf8").catch(() => {
      throw new Error(`LUT file not found: luts/${look.lut!.slice(7)}`);
    });
    custom = parseCube(text);
    customKey = createHash("sha1").update(text).digest("hex");
  }
  const key = createHash("sha1").update(JSON.stringify([look, customKey])).digest("hex").slice(0, 16);
  const dir = join(tmpdir(), "cutroom-luts");
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${key}.cube`);
  if (!existsSync(path)) await writeFile(path, cubeText(bakeLook(look, custom)));
  return path;
}

/**
 * Draws captions and the hook title at every time their look changes (word changes and
 * animation frames) and writes an ffconcat list that holds each image until the next.
 */
async function renderTextStream(pages: CaptionPage[], style: CaptionStyle, hook: HookTitle | null, W: number, H: number, duration: number, fps: number, workDir: string): Promise<string> {
  const dir = join(workDir, "captions");
  await mkdir(dir, { recursive: true });
  const times = new Set<number>([0]);
  for (const page of pages) {
    for (const x of captionSampleTimes(page, style, fps)) times.add(x);
    times.add(page.end);
  }
  if (hook) for (const x of hookSampleTimes(hook, fps)) times.add(x);
  const sorted = [...times].filter((x) => x >= 0 && x < duration).sort((a, b) => a - b);

  const lines = ["ffconcat version 1.0"];
  let pi = 0;
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    const next = i + 1 < sorted.length ? sorted[i + 1] : duration + 1;
    if (next - t < 0.0005) continue;
    while (pi < pages.length && pages[pi].end <= t) pi++;
    const page = pages[pi] && t >= pages[pi].start && t < pages[pi].end ? pages[pi] : null;
    const showHook = !!hook && hookActive(hook, t);
    lines.push(`file ${q(await png(dir, W, H, { page, style, hook: showHook ? hook : null, t }))}`, `duration ${(next - t).toFixed(4)}`);
  }
  // The concat demuxer ignores the duration of the last entry; repeat it.
  lines.push(lines[lines.length - 2]);
  const list = join(dir, `list-${Date.now()}.txt`);
  await writeFile(list, lines.join("\n"));
  return list;
}

/** Quote a path for an ffconcat file. */
function q(path: string): string {
  return `'${path.replace(/'/g, "'\\''")}'`;
}

async function png(dir: string, W: number, H: number, d: { page: CaptionPage | null; style: CaptionStyle; hook: HookTitle | null; t: number }): Promise<string> {
  // Key on page-relative times so identical states at different timeline positions share images.
  const cap = d.page ? { words: d.page.words.map((w) => [w.text, +(w.start - d.page!.start).toFixed(4)]), t: +(d.t - d.page.start).toFixed(4), style: d.style } : null;
  const hk = d.hook ? { ...d.hook, start: 0, t: hookSteady(d.hook, d.t) ? "steady" : +(d.t - d.hook.start).toFixed(4) } : null;
  const key = createHash("sha1").update(JSON.stringify([W, H, cap, hk])).digest("hex").slice(0, 16);
  const file = join(dir, `${key}.png`);
  if (existsSync(file)) return file;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext("2d") as unknown as Ctx2D;
  if (d.page) drawCaptionFrame(ctx, W, H, d.page, d.style, d.t);
  if (d.hook) drawHook(ctx, W, H, d.hook, hookSteady(d.hook, d.t) ? d.hook.start + d.hook.duration / 2 : d.t);
  await writeFile(file, await canvas.encode("png"));
  return file;
}

// --- Segment timing helpers (exported for tests) -----------------------------------

type Span = { start: number; end: number };
const spanCache = new Map<string, Promise<{ audio: Span; video: Span }>>();
/** Where the audio and video tracks start and end on the file clock (cached per file and size). */
async function streamSpans(path: string): Promise<{ audio: Span; video: Span }> {
  const key = `${path}:${await stat(path).then((s) => `${s.size}:${s.mtimeMs}`).catch(() => "")}`;
  let hit = spanCache.get(key);
  if (!hit) {
    const all = { start: 0, end: 1e9 };
    hit = probe(path)
      .then((i) => ({
        audio: i.audioStart !== undefined ? { start: i.audioStart, end: i.audioEnd ?? 1e9 } : all,
        video: i.videoStart !== undefined ? { start: i.videoStart, end: i.videoEnd ?? 1e9 } : all,
      }))
      .catch(() => ({ audio: all, video: all }));
    spanCache.set(key, hit);
  }
  return hit;
}

const NTSC: Record<number, number> = { 23.976: 24000 / 1001, 29.97: 30000 / 1001, 47.952: 48000 / 1001, 59.94: 60000 / 1001, 119.88: 120000 / 1001 };
const STANDARD_RATES = [15, 23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60, 90, 100, 119.88, 120];

/** The exact frame rate if `fps` is a common constant rate, else null (variable frame rate, odd average). */
export function standardRate(fps: number): number | null {
  // Nearest rate, tight tolerance: 30 and 29.97 are only 0.1% apart.
  const hit = STANDARD_RATES.reduce((best, r) => (Math.abs(fps - r) < Math.abs(fps - best) ? r : best));
  return Math.abs(fps - hit) / hit < 0.0003 ? (NTSC[hit] ?? hit) : null;
}

/**
 * Snap a source time onto the source's frame grid so audio starts exactly where a frame does.
 * Variable-frame-rate sources have no grid (their average rate is meaningless here), so they're left alone.
 */
export function snapToFrame(t: number, fps: number): number {
  const r = fps > 0 ? standardRate(fps) : null;
  return r ? Math.round(t * r) / r : t;
}

/**
 * Video for one segment: source frames around [s, s+dur) re-timed against the source clock and
 * resampled to the output rate, starting at output frame 0. Followed by tpad/trim to make it exact.
 */
export function videoSegment(s: number, dur: number, srcFps: number, fps: number): string {
  // Take a little before s so the frame on screen at s is included (VFR gaps can be long).
  const lead = Math.max(0.1, 2 / (srcFps > 0 ? srcFps : fps));
  return `trim=start=${Math.max(0, s - lead).toFixed(6)}:end=${(s + dur + lead).toFixed(6)},setpts=PTS-${s.toFixed(6)}/TB,fps=fps=${fps}:start_time=0`;
}

/**
 * Audio for one segment, anchored to the source clock like the video. aresample with first_pts=0
 * pads the start with silence when the audio stream begins after s (late audio track, gaps), instead
 * of pulling later audio forward and drifting out of sync.
 */
export function audioSegment(s: number, dur: number, rate: number): string {
  return `atrim=start=${Math.max(0, s).toFixed(6)}:end=${(s + dur).toFixed(6)},asetpts=PTS-${s.toFixed(6)}/TB,aresample=${rate}:async=1:first_pts=0`;
}

/**
 * Timestamped export filename. With `dir`, a short random suffix is added only if the name is
 * taken; without it the suffix is always added, since two exports can start in the same second.
 */
export function defaultExportName(project: Project, dir?: string): string {
  const slug = project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "export";
  const aspect = project.settings.width >= project.settings.height ? "landscape" : "vertical";
  const base = `${slug}-${aspect}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "")}`;
  if (dir && !existsSync(join(dir, `${base}.mp4`))) return `${base}.mp4`;
  return `${base}-${Math.random().toString(36).slice(2, 6)}.mp4`;
}
