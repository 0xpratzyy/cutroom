// Local speech-to-text with word timestamps. Pluggable backends, auto-detected:
//
//   whisper.cpp     `whisper-cli` on PATH + a ggml model (CUTROOM_WHISPER_CPP_MODEL)
//   faster-whisper  via `uv` (installs on first run) or a python3 that has it
//
// Force one with CUTROOM_TRANSCRIBER=whisper-cpp|faster-whisper.
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { ffmpeg, probe, run } from "./ffmpeg.js";
import { isFiller } from "./shared/timeline.js";
import type { Transcript, Word } from "./shared/types.js";

export interface TranscribeOptions {
  model?: string;
  language?: string;
  onProgress?: (fraction: number) => void;
}

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "transcribe_faster_whisper.py");

/** PATH lookup that works on macOS, Linux and Windows (PATHEXT). */
async function which(cmd: string): Promise<boolean> {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) if (existsSync(join(dir, cmd + ext))) return true;
  }
  return false;
}

/** First python that has faster-whisper installed. */
async function pythonWithFasterWhisper(): Promise<string | null> {
  for (const py of ["python3", "python"]) {
    if (!(await which(py))) continue;
    try {
      await run(py, ["-c", "import faster_whisper"]);
      return py;
    } catch {
      /* try the next one */
    }
  }
  return null;
}

type Backend = "whisper-cpp" | "faster-whisper-uv" | "faster-whisper-python";

async function detectBackend(): Promise<Backend> {
  const forced = process.env.CUTROOM_TRANSCRIBER;
  if (forced === "whisper-cpp") return "whisper-cpp";
  if (forced === "faster-whisper") return (await which("uv")) ? "faster-whisper-uv" : "faster-whisper-python";
  if ((await which("whisper-cli")) && whisperCppModel()) return "whisper-cpp";
  if (await which("uv")) return "faster-whisper-uv";
  if (await pythonWithFasterWhisper()) return "faster-whisper-python";
  throw new Error(
    "No transcription backend found. Install one of:\n" +
      "  • uv (recommended, auto-installs faster-whisper): curl -LsSf https://astral.sh/uv/install.sh | sh\n" +
      "  • faster-whisper: pip install faster-whisper\n" +
      "  • whisper.cpp: brew install whisper-cpp, then set CUTROOM_WHISPER_CPP_MODEL=/path/to/ggml-base.en.bin",
  );
}

function whisperCppModel(): string | undefined {
  const env = process.env.CUTROOM_WHISPER_CPP_MODEL;
  if (env && existsSync(env)) return env;
  const fallback = join(homedir(), ".cache", "cutroom", "models", "ggml-base.en.bin");
  return existsSync(fallback) ? fallback : undefined;
}

export async function transcribe(mediaId: string, mediaPath: string, workDir: string, opts: TranscribeOptions = {}): Promise<Transcript> {
  const backend = await detectBackend();
  const model = opts.model ?? process.env.CUTROOM_WHISPER_MODEL ?? "base.en";
  const language = opts.language ?? (model.endsWith(".en") ? "en" : "auto");
  let raw: { language: string; words: { text: string; start: number; end: number; conf?: number }[] };

  // Progress: extracting audio is the first few percent, the speech model the rest.
  const duration = await probe(mediaPath).then((i) => i.duration).catch(() => 0);
  const EXTRACT = 0.04;
  const extractProgress = (f: number) => opts.onProgress?.(f * EXTRACT);
  const modelProgress = (f: number) => opts.onProgress?.(EXTRACT + f * (1 - EXTRACT));
  if (backend === "whisper-cpp") {
    raw = await runWhisperCpp(mediaPath, workDir, language, duration, extractProgress);
  } else {
    const pcm = join(workDir, `audio16k-${process.pid}-${Date.now()}.f32`);
    await ffmpeg(["-i", mediaPath, "-vn", "-af", ALIGN_AUDIO, "-ac", "1", "-ar", "16000", "-f", "f32le", pcm], { onProgress: extractProgress, duration });
    try {
      const [cmd, args] =
        backend === "faster-whisper-uv"
          ? ["uv", ["run", "--quiet", "--python", "3.12", "--with", "faster-whisper", "python", SCRIPT, pcm, model, language]]
          : [(await pythonWithFasterWhisper()) ?? "python3", [SCRIPT, pcm, model, language]];
      raw = JSON.parse(await runWithProgress(cmd, args as string[], modelProgress));
    } finally {
      await rm(pcm, { force: true });
    }
  }

  // Whisper hallucinates low-confidence words at the end of audio (and occasionally
  // elsewhere). Drop near-zero-confidence words, and any weak tail.
  let ws = raw.words.filter((w) => w.conf === undefined || w.conf >= 0.05);
  while (ws.length && (ws[ws.length - 1].conf ?? 1) < 0.25) ws = ws.slice(0, -1);

  const words: Word[] = [];
  for (const w of ws) {
    const text = w.text.trim();
    if (!text || w.end <= w.start) continue;
    words.push({ i: words.length, text, start: w.start, end: w.end, ...(w.conf !== undefined ? { conf: w.conf } : {}), ...(isFiller(text) ? { filler: true } : {}) });
  }
  return { mediaId, backend: backend.replace(/-(uv|python)$/, ""), model: backend === "whisper-cpp" ? "whisper.cpp" : model, language: raw.language, words };
}

/**
 * Pad the start with silence when the audio track starts after the video (and fill gaps), so word
 * timestamps are on the file's clock rather than the audio track's.
 */
const ALIGN_AUDIO = "aresample=async=1:first_pts=0";

/** Splits a byte stream into lines, carrying partial lines across chunks. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let rest = "";
  return (chunk) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    for (const l of lines) onLine(l);
  };
}

function runWithProgress(cmd: string, args: string[], onProgress?: (f: number) => void): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    let err = "";
    // Words for an hour of speech are a few MB of JSON: collect Buffers rather than growing a string.
    child.stdout.on("data", (d: Buffer) => out.push(d));
    const feed = lineSplitter((line) => {
      const m = /^\{"progress": ([\d.]+)\}/.exec(line.trim());
      if (m) onProgress?.(Math.min(1, Number(m[1])));
    });
    child.stderr.on("data", (d: Buffer) => {
      const s = d.toString();
      err += s;
      if (err.length > 200_000) err = err.slice(-100_000);
      feed(s);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out).toString("utf8")) : reject(new Error(`${cmd} failed (${code}):\n${err.split("\n").slice(-12).join("\n")}`))));
  });
}

async function runWhisperCpp(mediaPath: string, workDir: string, language: string, duration: number, onExtract?: (f: number) => void) {
  const model = whisperCppModel();
  if (!model) throw new Error("Set CUTROOM_WHISPER_CPP_MODEL to a ggml model file");
  const tag = `${process.pid}-${Date.now()}`;
  const wav = join(workDir, `audio16k-${tag}.wav`);
  const outBase = join(workDir, `whispercpp-${tag}`);
  await ffmpeg(["-i", mediaPath, "-vn", "-af", ALIGN_AUDIO, "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wav], { onProgress: onExtract, duration });
  try {
    // -ml 1 + -sow makes each output segment (roughly) one word.
    await run("whisper-cli", ["-m", model, "-f", wav, "-l", language, "-ml", "1", "-sow", "-oj", "-of", outBase, "-np"]);
    const json = JSON.parse(await readFile(outBase + ".json", "utf8"));
    const words = (json.transcription ?? []).map((s: any) => ({ text: String(s.text), start: s.offsets.from / 1000, end: s.offsets.to / 1000 }));
    return { language: json.result?.language ?? language, words };
  } finally {
    await rm(wav, { force: true });
    await rm(outBase + ".json", { force: true });
  }
}
