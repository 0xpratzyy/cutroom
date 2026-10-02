import { spawn } from "node:child_process";

export const FFMPEG = process.env.CUTROOM_FFMPEG ?? "ffmpeg";
export const FFPROBE = process.env.CUTROOM_FFPROBE ?? "ffprobe";

export interface RunOptions {
  /** Called with 0..1 when `duration` is known and ffmpeg reports progress. */
  onProgress?: (fraction: number) => void;
  duration?: number;
  signal?: AbortSignal;
  /** Collect stdout as a Buffer (for raw PCM etc). */
  binaryStdout?: boolean;
  /** Stream stdout chunks to this callback instead of buffering them (large PCM, long files). */
  onStdout?: (chunk: Buffer) => void;
  /** Called with each complete stderr line (e.g. silencedetect output), so nothing is lost to truncation. */
  onStderrLine?: (line: string) => void;
  cwd?: string;
}

export interface RunResult {
  stdout: Buffer;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd, signal: opts.signal });
    const out: Buffer[] = [];
    let err = "";
    let errLine = "";
    let progressBuf = "";
    child.stdout.on("data", (d: Buffer) => {
      if (opts.onStdout) opts.onStdout(d);
      else if (opts.binaryStdout) out.push(d);
      else {
        out.push(d);
        if (opts.onProgress && opts.duration) {
          progressBuf += d.toString();
          const lines = progressBuf.split("\n");
          progressBuf = lines.pop() ?? "";
          for (const line of lines) {
            const m = /^out_time_us=(\d+)/.exec(line);
            if (m) opts.onProgress(Math.max(0, Math.min(1, Number(m[1]) / 1e6 / opts.duration)));
          }
        }
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 200_000) err = err.slice(-100_000);
      if (opts.onStderrLine) {
        const lines = (errLine + s).split(/\r?\n|\r/);
        errLine = lines.pop() ?? "";
        for (const line of lines) opts.onStderrLine(line);
      }
    });
    child.on("error", (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") reject(new Error(`${cmd} not found. Install it (e.g. \`brew install ffmpeg\`) or set CUTROOM_FFMPEG.`));
      else reject(e);
    });
    child.on("close", (code) => {
      if (errLine && opts.onStderrLine) opts.onStderrLine(errLine);
      if (code === 0) resolve({ stdout: Buffer.concat(out), stderr: err });
      else reject(new Error(`${cmd} exited with ${code}:\n${err.split("\n").slice(-15).join("\n")}`));
    });
  });
}

export function ffmpeg(args: string[], opts: RunOptions = {}): Promise<RunResult> {
  // -progress uses stdout, so it can't be combined with streaming/binary stdout.
  const progress = opts.onProgress && !opts.onStdout && !opts.binaryStdout ? ["-progress", "pipe:1", "-nostats"] : [];
  return run(FFMPEG, ["-hide_banner", "-y", ...progress, ...args], opts);
}

export interface ProbeResult {
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  videoCodec?: string;
  audioCodec?: string;
  pixFmt?: string;
  /** Display rotation in degrees (phone footage); width/height above are already the displayed size. */
  rotation: number;
  /** Bits per sample of the video (10 for HDR/10-bit HEVC, ProRes …). */
  bitDepth?: number;
  /** Where the audio stream starts and ends on the file's clock (it can start late or end early). */
  audioStart?: number;
  audioEnd?: number;
  /** Video stream timing, for the same reason. */
  videoStart?: number;
  videoEnd?: number;
  isImage: boolean;
  /** The container/codec can be probed but ffmpeg has no decoder for the picture (e.g. SVG). */
  undecodable?: boolean;
}

const IMAGE_CODECS = new Set(["png", "mjpeg", "webp", "gif", "bmp", "tiff", "jpegls", "jpeg2000", "pam", "ppm", "pgm", "qoi"]);
/** Demuxers that only ever hold a still image (image2 = jpg/png/… by extension, *_pipe = sniffed images). */
const STILL_FORMAT = /(^|,)(image2|[a-z0-9]+_pipe)(,|$)/;

export function interpretProbe(info: any): ProbeResult {
  const streams: any[] = info.streams ?? [];
  const v = streams.find((s) => s.codec_type === "video" && !s.disposition?.attached_pic);
  const a = streams.find((s) => s.codec_type === "audio");
  const num = (x: unknown) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : undefined;
  };
  const duration = num(info.format?.duration) ?? num(v?.duration) ?? num(a?.duration) ?? 0;
  const frames = num(v?.nb_frames);
  const animated = (frames ?? 0) > 1 || (v?.codec_name === "gif" && duration > 0.15);
  const fmt = String(info.format?.format_name ?? "");
  const isImage = !!v && !a && !animated && (STILL_FORMAT.test(fmt) || (IMAGE_CODECS.has(v.codec_name) && duration < 0.1));
  const rate = (r: unknown) => {
    const [n, d] = String(r ?? "").split("/").map(Number);
    const f = d ? n / d : n;
    return Number.isFinite(f) && f > 0 && f < 240 ? f : undefined;
  };
  const fps = rate(v?.avg_frame_rate) ?? rate(v?.r_frame_rate) ?? 30;
  // Phone footage stores portrait as landscape + a display matrix; ffmpeg autorotates on decode.
  const rotation = Number(v?.side_data_list?.find((d: any) => d.rotation !== undefined)?.rotation ?? v?.tags?.rotate ?? 0) || 0;
  const sideways = Math.abs(Math.round(rotation / 90)) % 2 === 1;
  const w = Number(v?.width ?? 0);
  const h = Number(v?.height ?? 0);
  const pixBits = /p(9|1[0-6])(le|be)$/.exec(String(v?.pix_fmt ?? ""))?.[1];
  const bits = num(v?.bits_per_raw_sample) ?? (pixBits ? Number(pixBits) : v ? 8 : undefined);
  const fileStart = num(info.format?.start_time) ?? 0;
  const aStart = a ? (num(a.start_time) ?? fileStart) - fileStart : undefined;
  const aDur = a ? (num(a.duration) ?? duration) : undefined;
  return {
    duration: isImage ? 0 : duration,
    width: sideways ? h : w,
    height: sideways ? w : h,
    fps: Math.round(fps * 1000) / 1000,
    hasAudio: !!a,
    hasVideo: !!v,
    videoCodec: v?.codec_name,
    audioCodec: a?.codec_name,
    pixFmt: v?.pix_fmt,
    rotation,
    bitDepth: bits,
    audioStart: aStart !== undefined ? Math.max(0, aStart) : undefined,
    audioEnd: aStart !== undefined && aDur !== undefined ? Math.max(0, aStart) + aDur : undefined,
    videoStart: v ? Math.max(0, (num(v.start_time) ?? fileStart) - fileStart) : undefined,
    videoEnd: v && !isImage ? Math.max(0, (num(v.start_time) ?? fileStart) - fileStart) + (num(v.duration) ?? duration) : undefined,
    isImage,
    undecodable: !!v && (!w || !h || v.codec_name === "svg"),
  };
}

export async function probe(path: string): Promise<ProbeResult> {
  const { stdout } = await run(FFPROBE, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", path]);
  return interpretProbe(JSON.parse(stdout.toString()));
}

let filterScriptFlag: string | undefined;
/** ffmpeg >= 7 reads a filtergraph from a file with `-/filter_complex`; older builds use -filter_complex_script. */
export async function filterScriptArg(): Promise<string> {
  if (!filterScriptFlag) {
    const { stdout } = await run(FFMPEG, ["-hide_banner", "-version"]);
    const version = stdout.toString();
    const major = Number(/version n?(\d+)\./.exec(version)?.[1] ?? 0);
    // Git builds report "version N-12345-g…" and are always recent.
    filterScriptFlag = major >= 7 || /version N-/.test(version) ? "-/filter_complex" : "-filter_complex_script";
  }
  return filterScriptFlag;
}
