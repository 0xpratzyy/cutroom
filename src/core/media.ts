import { existsSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, relative, resolve } from "node:path";
import { loadImage, createCanvas } from "@napi-rs/canvas";
import { ffmpeg, probe, type ProbeResult } from "./ffmpeg.js";
import type { Origin, ProjectStore } from "./project.js";
import { transcribe } from "./transcribe.js";
import type { MediaAsset, Silence, Waveform } from "./shared/types.js";
import { uid } from "./shared/timeline.js";

export interface ImportOptions {
  /**
   * "main" appends to the main track, "library" only adds to the media bin.
   * Default: the first video goes on the main track if the timeline is empty.
   */
  role?: "main" | "library";
  origin?: Origin;
}

export async function importMedia(store: ProjectStore, paths: string[], opts: ImportOptions = {}): Promise<MediaAsset[]> {
  const assets: MediaAsset[] = [];
  for (const raw of paths) {
    const original = resolve(raw);
    if (!existsSync(original)) throw new Error(`File not found: ${original}`);
    let abs = original;
    let info: ProbeResult;
    try {
      info = await probe(abs);
    } catch (err) {
      if (!/\.svg$/i.test(abs)) throw new Error(`Can't read ${basename(abs)}: ${(err as Error).message.split("\n").filter(Boolean).pop() ?? "ffprobe failed"}`);
      info = { undecodable: true, videoCodec: "svg" } as ProbeResult;
    }
    // ffmpeg can't decode SVG: rasterize it once to a PNG in the project's media folder.
    if (info.videoCodec === "svg" || (/\.svg$/i.test(abs) && info.undecodable)) {
      abs = await rasterizeSvg(store, abs);
      info = await probe(abs);
    }
    if (!info.hasVideo && !info.hasAudio) throw new Error(`${basename(abs)} has no audio or video streams`);
    if (info.hasVideo && info.undecodable && !info.hasAudio) throw new Error(`${basename(abs)}: ffmpeg can't decode this picture format (${info.videoCodec ?? "unknown"}). Convert it to PNG, JPG or MP4 first.`);
    if (!info.isImage && info.duration <= 0) throw new Error(`${basename(abs)} has no duration; the file may be truncated or still being written`);
    const rel = relative(store.dir, abs);
    assets.push({
      id: "",
      name: basename(original),
      // Keep paths relative when the media lives inside the project, so projects are portable.
      path: rel.startsWith("..") ? abs : rel,
      kind: info.isImage ? "image" : info.hasVideo ? "video" : "audio",
      duration: info.duration,
      width: info.width,
      height: info.height,
      fps: info.fps,
      hasAudio: info.hasAudio,
      hasVideo: info.hasVideo,
      analysis: {},
    });
  }
  await store.update(
    (p) => {
      let n = p.media.reduce((max, m) => Math.max(max, Number(m.id.slice(1)) || 0), 0);
      let autoAdd = opts.role === undefined && p.clips.length === 0;
      for (const a of assets) {
        a.id = `m${++n}`;
        p.media.push(a);
        if (a.kind === "image") continue;
        if (opts.role === "main" || (autoAdd && a.hasAudio)) {
          p.clips.push({ id: uid("c"), mediaId: a.id, in: 0, out: a.duration });
          autoAdd = false;
        }
      }
      // Match output settings to the first video imported into an empty project.
      const first = assets.find((a) => a.kind === "video");
      if (first && p.media.length === assets.length) {
        p.settings.fps = projectFps(first.fps);
        if (first.height > first.width) Object.assign(p.settings, { width: 1080, height: 1920 });
      }
    },
    opts.origin ?? "editor",
    `import ${assets.map((a) => a.name).join(", ")}`,
  );
  return assets;
}

export type AnalysisStep = "waveform" | "silences" | "transcript" | "proxy" | "thumbs";
// Transcript early: it is what the user waits for. The proxy (a re-encode, only when needed) goes last.
export const ALL_STEPS: AnalysisStep[] = ["waveform", "silences", "thumbs", "transcript", "proxy"];

export interface AnalyzeOptions {
  steps?: AnalysisStep[];
  /** Overall progress across all steps, 0..1. */
  onOverall?: (fraction: number, step: AnalysisStep) => void;
  force?: boolean;
  model?: string;
  language?: string;
  silenceThresholdDb?: number;
  onProgress?: (step: AnalysisStep, fraction: number) => void;
}

export async function analyzeMedia(store: ProjectStore, mediaId: string, opts: AnalyzeOptions = {}): Promise<Partial<Record<AnalysisStep, string>>> {
  const project = await store.load();
  const m = project.media.find((x) => x.id === mediaId);
  if (!m) throw new Error(`No media ${mediaId}`);
  const src = store.resolveMediaPath(m);
  const dir = store.cacheDir(m.id);
  await mkdir(dir, { recursive: true });
  const steps = (opts.steps ?? ALL_STEPS).filter((s) => {
    if (m.kind === "image") return false;
    if (!m.hasAudio && (s === "waveform" || s === "silences" || s === "transcript")) return false;
    if (!m.hasVideo && (s === "proxy" || s === "thumbs")) return false;
    return true;
  });
  const done: Partial<Record<AnalysisStep, string>> = {};
  const progress = (s: AnalysisStep) => (f: number) => {
    opts.onProgress?.(s, f);
    // Weight slow steps more so the overall bar moves evenly.
    const weight = (x: AnalysisStep) => (x === "transcript" ? 6 : x === "proxy" ? 3 : 1);
    const total = steps.reduce((n, x) => n + weight(x), 0);
    const before = steps.slice(0, steps.indexOf(s)).reduce((n, x) => n + weight(x), 0);
    opts.onOverall?.((before + f * weight(s)) / total, s);
  };

  for (const step of steps) {
    if (!opts.force && (await hasArtifact(store, m, step))) {
      done[step] = "cached";
      continue;
    }
    progress(step)(0);
    switch (step) {
      case "waveform":
        await store.writeArtifact(m.id, "waveform.json", await computeWaveform(src, m.duration, progress("waveform")));
        done.waveform = "ok";
        break;
      case "silences": {
        const silences = await detectSilences(src, m.duration, opts.silenceThresholdDb ?? -35, progress("silences"));
        await store.writeArtifact(m.id, "silences.json", silences);
        done.silences = `${silences.length} silences`;
        break;
      }
      case "transcript": {
        // A missing or broken transcription backend shouldn't stop the other steps (proxy etc).
        try {
          const t = await transcribe(m.id, src, dir, { model: opts.model, language: opts.language, onProgress: progress("transcript") });
          await store.writeArtifact(m.id, "transcript.json", t);
          done.transcript = `${t.words.length} words (${t.backend} ${t.model})`;
        } catch (err) {
          done.transcript = `failed: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`;
          console.error(`transcription failed for ${m.name}:`, err instanceof Error ? err.message : err);
        }
        break;
      }
      case "proxy":
        done.proxy = (await makeProxy(src, join(dir, "proxy.mp4"), m, progress("proxy"))) ? "ok" : "not needed";
        break;
      case "thumbs":
        await makeFilmstrip(src, join(dir, "filmstrip.jpg"), m, progress("thumbs"));
        done.thumbs = "ok";
        break;
    }
    progress(step)(1);
  }

  // Analysis flags aren't an edit, so they don't go on the undo stack.
  await store.update(
    (p) => {
      const target = p.media.find((x) => x.id === m.id);
      if (!target) return;
      for (const s of Object.keys(done) as AnalysisStep[]) if (!done[s]?.startsWith("failed")) target.analysis[s] = true;
      if (done.proxy) target.analysis.proxy = existsSync(join(dir, "proxy.mp4"));
    },
    "editor",
    `analyze ${m.name}`,
    { record: false },
  );
  return done;
}

async function hasArtifact(store: ProjectStore, m: MediaAsset, step: AnalysisStep): Promise<boolean> {
  const dir = store.cacheDir(m.id);
  const file = { waveform: "waveform.json", silences: "silences.json", transcript: "transcript.json", proxy: "proxy.mp4", thumbs: "filmstrip.jpg" }[step];
  if (step === "proxy" && m.analysis.proxy !== undefined) return true;
  return existsSync(join(dir, file));
}

export const WAVEFORM_RATE = 50;

/**
 * Audio filters every analysis pass starts with: pad the start with silence when the audio track
 * begins after the video (and fill gaps), so analysis times line up with the file's clock.
 */
export const ALIGN_AUDIO = "aresample=async=1:first_pts=0";

/** Peak per 1/WAVEFORM_RATE s, computed incrementally from streamed PCM (constant memory). */
export class PeakAccumulator {
  readonly peaks: number[] = [];
  private max = 0;
  private n = 0;
  private carry: Buffer | null = null;
  constructor(private readonly win: number) {}
  /** Feed raw s16le bytes (chunks may split samples). Returns the number of samples consumed so far. */
  push(chunk: Buffer): void {
    let buf = chunk;
    if (this.carry) {
      buf = Buffer.concat([this.carry, chunk]);
      this.carry = null;
    }
    const usable = buf.length - (buf.length % 2);
    if (usable < buf.length) this.carry = Buffer.from(buf.subarray(usable));
    for (let o = 0; o < usable; o += 2) {
      const v = Math.abs(buf.readInt16LE(o));
      if (v > this.max) this.max = v;
      if (++this.n === this.win) this.flush();
    }
  }
  get samples(): number {
    return this.peaks.length * this.win + this.n;
  }
  private flush() {
    this.peaks.push(Math.round((this.max / 32768) * 1000) / 1000);
    this.max = 0;
    this.n = 0;
  }
  finish(): number[] {
    if (this.n > 0) this.flush();
    return this.peaks;
  }
}

async function computeWaveform(src: string, duration: number, onProgress?: (f: number) => void): Promise<Waveform> {
  const sampleRate = 8000;
  const acc = new PeakAccumulator(sampleRate / WAVEFORM_RATE);
  const total = Math.max(1, duration * sampleRate);
  let lastReport = 0;
  await ffmpeg(["-i", src, "-vn", "-af", ALIGN_AUDIO, "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"], {
    onStdout: (chunk) => {
      acc.push(chunk);
      const f = Math.min(1, acc.samples / total);
      if (onProgress && f - lastReport >= 0.01) {
        lastReport = f;
        onProgress(f);
      }
    },
  });
  return { rate: WAVEFORM_RATE, peaks: acc.finish() };
}

/** Parses silencedetect output line by line (long recordings produce more output than we keep in memory). */
export class SilenceParser {
  readonly silences: Silence[] = [];
  private start: number | null = null;
  line(line: string): void {
    const s = /silence_start: (-?[\d.]+)/.exec(line);
    const e = /silence_end: (-?[\d.]+)/.exec(line);
    if (s) this.start = Math.max(0, Number(s[1]));
    if (e && this.start !== null) {
      const end = Number(e[1]);
      if (end > this.start) this.silences.push({ start: round(this.start), end: round(end) });
      this.start = null;
    }
  }
  finish(duration: number): Silence[] {
    if (this.start !== null && duration > this.start) this.silences.push({ start: round(this.start), end: round(duration) });
    this.start = null;
    return this.silences;
  }
}

async function detectSilences(src: string, duration: number, thresholdDb: number, onProgress?: (f: number) => void): Promise<Silence[]> {
  const parser = new SilenceParser();
  await ffmpeg(["-i", src, "-vn", "-af", `${ALIGN_AUDIO},silencedetect=noise=${thresholdDb}dB:d=0.25`, "-f", "null", "-"], {
    onStderrLine: (l) => parser.line(l),
    onProgress,
    duration,
  });
  return parser.finish(duration);
}

/** Browser-friendly, fast-seeking 720p proxy, only when the source needs one. */
async function makeProxy(src: string, out: string, m: MediaAsset, onProgress: (f: number) => void): Promise<boolean> {
  const info = await probe(src);
  const big = (await stat(src)).size / Math.max(m.duration, 1) > 2_500_000; // > ~20 Mbit/s scrubs badly
  if (!needsProxy(info, src) && !big) return false;
  // Shorter side to 720 (portrait phone footage stays portrait: ffmpeg applies the rotation).
  const scale = "scale='if(gte(iw,ih),-2,min(720,iw))':'if(gte(iw,ih),min(720,ih),-2)'";
  await ffmpeg(
    ["-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn", "-vf", `${scale},format=yuv420p`, "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-g", "15", "-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart", `${out}.tmp.mp4`],
    { onProgress, duration: m.duration },
  );
  // Only a finished proxy may be picked up by the editor.
  const { rename } = await import("node:fs/promises");
  await rename(`${out}.tmp.mp4`, out);
  return true;
}

const BROWSER_VIDEO = ["h264", "vp8", "vp9", "av1"];
const BROWSER_AUDIO = ["aac", "mp3", "opus", "vorbis", "flac"];

/**
 * Whether a source needs a browser-friendly proxy: HEVC (not decodable in Chrome everywhere), 10-bit,
 * ProRes/DNxHD, 4:2:2/4:4:4, audio codecs browsers can't play (PCM in .mov, AC-3), or > 1080p.
 */
export function needsProxy(info: Pick<ProbeResult, "videoCodec" | "pixFmt" | "audioCodec" | "width" | "height">, path: string): boolean {
  const okVideo = BROWSER_VIDEO.includes(info.videoCodec ?? "") && (info.pixFmt === "yuv420p" || info.pixFmt === "yuvj420p");
  const okAudio = !info.audioCodec || BROWSER_AUDIO.includes(info.audioCodec);
  const okSize = Math.min(info.width, info.height) <= 1080;
  return !(okVideo && okAudio && okSize && /\.(mp4|m4v|webm|mov)$/i.test(path));
}

export const FILMSTRIP_HEIGHT = 72;

/** One horizontal sprite of evenly spaced frames, used for timeline thumbnails. */
async function makeFilmstrip(src: string, out: string, m: MediaAsset, onProgress?: (f: number) => void): Promise<void> {
  const count = Math.max(1, Math.min(120, Math.ceil(m.duration / 2)));
  const step = Math.max(0.04, m.duration / count);
  // With tiles minutes apart, decoding every frame of a long (or 4K HEVC) recording is wasted work:
  // keyframes alone are plenty for thumbnails.
  const keyOnly = step >= 5 ? ["-skip_frame", "nokey"] : [];
  // Width follows the displayed aspect (rotation applied), and stays even for the JPEG encoder.
  await ffmpeg([...keyOnly, "-i", src, "-an", "-vf", `fps=1/${step.toFixed(4)},scale=-2:${FILMSTRIP_HEIGHT},tile=${count}x1`, "-frames:v", "1", "-q:v", "5", out]);
  onProgress?.(1);
}

export async function filmstripInfo(m: MediaAsset) {
  const count = Math.max(1, Math.min(120, Math.ceil(m.duration / 2)));
  return { count, step: m.duration / count, height: FILMSTRIP_HEIGHT, width: Math.round((m.width / Math.max(m.height, 1)) * FILMSTRIP_HEIGHT / 2) * 2 };
}

/** Output frame rate for a new project: the nearest common rate (VFR phone footage averages odd values). */
export function projectFps(fps: number): number {
  const rates = [15, 24, 25, 30, 48, 50, 60];
  if (!Number.isFinite(fps) || fps <= 0) return 30;
  return rates.reduce((best, r) => (Math.abs(r - fps) < Math.abs(best - fps) ? r : best), 30);
}

/** Rasterize an SVG (which ffmpeg can't decode) to a PNG next to the project's media. */
async function rasterizeSvg(store: ProjectStore, svgPath: string): Promise<string> {
  let img;
  try {
    img = await loadImage(await readFile(svgPath));
  } catch (err) {
    throw new Error(`Can't read SVG ${basename(svgPath)}: ${(err as Error).message}`);
  }
  const w0 = img.width || 1024;
  const h0 = img.height || 1024;
  // Vector art: render big enough to stay sharp full-frame at 1080p/4K.
  const k = Math.max(1, 2160 / Math.max(w0, h0));
  const w = Math.round(w0 * k);
  const h = Math.round(h0 * k);
  const canvas = createCanvas(w, h);
  canvas.getContext("2d").drawImage(img, 0, 0, w, h);
  const dir = join(store.dir, "media");
  await mkdir(dir, { recursive: true });
  const base = basename(svgPath, extname(svgPath));
  let out = join(dir, `${base}.png`);
  for (let i = 1; existsSync(out); i++) out = join(dir, `${base}-${i}.png`);
  await writeFile(out, await canvas.encode("png"));
  return out;
}

function round(n: number) {
  return Math.round(n * 1000) / 1000;
}
