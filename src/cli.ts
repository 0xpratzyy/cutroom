#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ALL_STEPS,
  PROJECT_FILE,
  ProjectStore,
  analyzeMedia,
  defaultExportName,
  formatTranscript,
  importMedia,
  jobs,
  parseOps,
  render,
  summarizeProject,
  type AnalysisStep,
} from "./core/index.js";

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_PROJECT = "cutroom-project";

const HELP = `cutroom: a local, agent-native video editor

Quick start:
  cutroom                              Open the editor. Uses ./cutroom.json if there is one; otherwise
                                       creates (or reopens) a project in ./${DEFAULT_PROJECT}
  cutroom <video>                      Create a project next to the video (a folder named after it),
                                       import and transcribe it, and open the editor
  cutroom doctor                       Check ffmpeg, transcription and permissions, with fix commands

Commands:
  cutroom init <dir> [media...]        Create a project and import (and analyze) media
  cutroom open [dir]                   Open the web editor
  cutroom mcp [dir]                    Run the MCP server over stdio
  cutroom import <files...>            Add media            [--role main|library] [--no-analyze]
  cutroom analyze [mediaId]            Transcribe, detect silences, etc.  [--model base.en] [--force]
  cutroom timeline                     Print the timeline summary
  cutroom transcript [mediaId]         Print the transcript
  cutroom edit '<ops json>'            Apply edit ops, e.g. '[{"op":"remove_fillers"}]'
  cutroom undo | redo
  cutroom export                       Render to exports/   [--quality draft|standard|high] [--out file.mp4]

Editor options (cutroom, cutroom <video>, cutroom open):
  --port <n>          Port for the editor (default 4321; the next free port is used if taken)
  --no-browser        Don't open a browser window
  --no-analyze        Import without transcribing (cutroom <video>, init, import)
  --model <name>      Whisper model, e.g. base.en (default), small.en, small

Commands run against the project in the current directory, or --project <dir> / CUTROOM_PROJECT.
  cutroom --version | --help`;

const COMMANDS = new Set(["init", "open", "mcp", "import", "analyze", "timeline", "transcript", "edit", "undo", "redo", "export", "doctor", "help"]);

const MEDIA_EXT = new Set(
  "mp4 mov m4v mkv webm avi mts m2ts mxf flv wmv 3gp mpg mpeg ts mp3 wav m4a aac flac ogg opus aif aiff".split(" ").map((e) => "." + e),
);

type Flags = Record<string, string | boolean>;

function parse(argv: string[]) {
  const pos: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h") flags.help = true;
    else if (a === "-v") flags.version = true;
    else if (a.startsWith("--no-")) flags[a.slice(5)] = false;
    else if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--") && !["help", "version", "dev", "force", "json"].includes(key)) {
        flags[key] = next;
        i++;
      } else flags[key] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

function version(): string {
  try {
    return JSON.parse(readFileSync(join(PKG_ROOT, "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const [cmd, ...args] = pos;
  const projectDir = () => resolve(String(flags.project ?? process.env.CUTROOM_PROJECT ?? "."));
  const open = () => ProjectStore.open(projectDir());

  if (flags.version) return console.log(version());
  if (flags.help || cmd === "help") return console.log(HELP);

  if (cmd === undefined) return startDefault(flags);
  if (!COMMANDS.has(cmd)) {
    const target = resolve(cmd);
    if (existsSync(target) && statSync(target).isDirectory() && existsSync(join(target, PROJECT_FILE))) return openEditor(await ProjectStore.open(target), flags);
    if (existsSync(target) && statSync(target).isFile()) {
      if (!MEDIA_EXT.has(extname(target).toLowerCase())) fail(`${cmd} doesn't look like a video or audio file.\n\n${HELP}`);
      return startFromVideo(target, flags);
    }
    fail(`Unknown command or file: ${cmd}\n\n${HELP}`);
  }

  switch (cmd) {
    case "doctor": {
      const ok = await doctor(flags);
      process.exitCode = ok ? 0 : 1;
      break;
    }
    case "init": {
      const dir = resolve(args[0] ?? ".");
      const media = args.slice(1);
      const analyze = media.length > 0 && flags.analyze !== false;
      if (media.length) preflight({ transcribe: analyze });
      const store = await ProjectStore.create(dir, typeof flags.name === "string" ? flags.name : undefined);
      console.log(`Project: ${store.file}`);
      if (media.length) {
        const assets = await importMedia(store, media, { origin: "cli" });
        if (analyze) for (const a of assets) await analyzeVerbose(store, a.id, flags);
      }
      console.log("\n" + summarizeProject(await store.load(), await store.context()));
      console.log(`\nNext: cutroom open ${args[0] ?? "."}`);
      break;
    }
    case "open": {
      const dir = resolve(args[0] ?? String(flags.project ?? process.env.CUTROOM_PROJECT ?? "."));
      const store = existsSync(join(dir, PROJECT_FILE)) ? await ProjectStore.open(dir) : await ProjectStore.create(dir);
      await openEditor(store, flags);
      break;
    }
    case "mcp": {
      const { startMcp } = await import("./mcp/server.js");
      const dir = args[0] ?? process.env.CUTROOM_PROJECT;
      await startMcp(dir && existsSync(join(resolve(dir), PROJECT_FILE)) ? dir : undefined);
      break;
    }
    case "import": {
      const store = await open();
      const role = flags.role === "main" || flags.role === "library" ? flags.role : undefined;
      preflight({ transcribe: flags.analyze !== false });
      const assets = await importMedia(store, args, { role, origin: "cli" });
      for (const a of assets) {
        console.log(`${a.id}  ${a.kind}  ${a.name}`);
        if (flags.analyze !== false && a.kind !== "image") await analyzeVerbose(store, a.id, flags);
      }
      break;
    }
    case "analyze": {
      const store = await open();
      preflight({ transcribe: true });
      const ids = args.length ? args : (await store.load()).media.map((m) => m.id);
      for (const id of ids) await analyzeVerbose(store, id, flags);
      break;
    }
    case "timeline": {
      const store = await open();
      console.log(summarizeProject(await store.load(), await store.context()));
      break;
    }
    case "transcript": {
      const store = await open();
      const p = await store.load();
      const ctx = await store.context();
      for (const id of args.length ? args : [...new Set(p.clips.map((c) => c.mediaId))]) {
        const t = ctx.transcripts[id];
        console.log(t ? formatTranscript(p, t) : `${id}: no transcript`);
      }
      break;
    }
    case "edit": {
      const store = await open();
      const parsed = JSON.parse(args.join(" "));
      const r = await store.edit(parseOps(Array.isArray(parsed) ? parsed : [parsed]), "cli");
      console.log(r.notes.join("\n"));
      break;
    }
    case "undo":
    case "redo": {
      const store = await open();
      const e = cmd === "undo" ? await store.undo() : await store.redo();
      console.log(e ? `${cmd}: ${e.label}` : `nothing to ${cmd}`);
      break;
    }
    case "export": {
      const store = await open();
      const p = await store.load();
      await mkdir(store.exportDir, { recursive: true });
      const out = resolve(typeof flags.out === "string" ? flags.out : join(store.exportDir, defaultExportName(p, store.exportDir)));
      const quality = (["draft", "standard", "high"] as const).find((q) => q === flags.quality) ?? "standard";
      let last = -1;
      await render(store, {
        out,
        quality,
        onProgress: (f) => {
          const pct = Math.floor(f * 100);
          if (pct !== last && process.stderr.isTTY) process.stderr.write(`\rRendering ${pct}%`);
          last = pct;
        },
      });
      if (process.stderr.isTTY) process.stderr.write("\n");
      console.log(out);
      break;
    }
  }
}

// --------------------------------------------------------------- editor entry points

/** `cutroom` with no arguments. */
async function startDefault(flags: Flags) {
  const cwd = process.cwd();
  if (existsSync(join(cwd, PROJECT_FILE))) return openEditor(await ProjectStore.open(cwd), flags);
  const dir = join(cwd, DEFAULT_PROJECT);
  const existed = existsSync(join(dir, PROJECT_FILE));
  const store = existed ? await ProjectStore.open(dir) : await ProjectStore.create(dir);
  const hasMedia = (await store.load()).media.length > 0;
  console.log(
    [
      "",
      "  Welcome to cutroom.",
      "",
      existed ? `  Reopening your project in ./${DEFAULT_PROJECT}.` : `  No ${PROJECT_FILE} here, so a new project was created in ./${DEFAULT_PROJECT}.`,
      "",
      "  Next steps:",
      ...(hasMedia ? [] : ["    - Drop a video onto the editor window to import and transcribe it"]),
      "    - Or start from a recording:  cutroom path/to/video.mp4",
      "    - Let Claude edit for you:    claude mcp add cutroom -- npx -y cutroom mcp",
      "    - Check your setup:           cutroom doctor",
      "",
    ].join("\n"),
  );
  preflight({ transcribe: true, warnOnly: true });
  await openEditor(store, flags);
}

/** `cutroom <video>`: a project folder next to the video, named after it. */
async function startFromVideo(video: string, flags: Flags) {
  preflight({ transcribe: flags.analyze !== false });
  const dir = typeof flags.project === "string" ? resolve(flags.project) : projectDirFor(video);
  const store = await ProjectStore.create(dir);
  const project = await store.load();
  let asset = project.media.find((m) => resolve(store.dir, m.path) === video);
  if (asset) console.log(`Reopening ${display(store.dir)} (${basename(video)} is already imported)`);
  else {
    [asset] = await importMedia(store, [video], { origin: "cli" });
    console.log(`Created project ${display(store.dir)} with ${basename(video)}`);
  }
  await openEditor(store, flags);
  if (flags.analyze === false || asset.kind === "image") return;
  // Analyze in the background as an editor job, so the editor shows progress while it runs.
  const steps = analysisSteps();
  const id = asset.id;
  let lastStep = "";
  await jobs
    .run("analyze", `Analyze ${asset.name}`, (update) =>
      analyzeMedia(store, id, {
        steps,
        model: typeof flags.model === "string" ? flags.model : undefined,
        language: typeof flags.language === "string" ? flags.language : undefined,
        onOverall: (f, step) => {
          update(f, step);
          if (step !== lastStep) {
            lastStep = step;
            process.stderr.write(`${id}: ${step}…\n`);
          }
        },
      }),
    )
    .then((r) => {
      const done = Object.entries(r);
      if (done.some(([, v]) => v !== "cached")) console.log(`${id}: ${done.map(([k, v]) => `${k} ${v}`).join(", ")}`);
    })
    .catch((err: Error) => {
      console.error(`Analysis failed: ${err.message}`);
      console.error("Run `cutroom doctor` to check your setup.");
    });
}

/** A path relative to the cwd when it's inside it, absolute otherwise. */
function display(path: string): string {
  const rel = relative(process.cwd(), path);
  return !rel ? "." : rel.startsWith("..") || isAbsolute(rel) ? path : `./${rel}`;
}

function projectDirFor(video: string): string {
  const parent = dirname(video);
  const stem = basename(video, extname(video));
  const candidates = [stem !== basename(video) ? stem : `${stem}-cutroom`, `${stem}-cutroom`];
  for (let n = 2; n < 100; n++) candidates.push(`${stem}-cutroom-${n}`);
  for (const name of candidates) {
    const dir = join(parent, name);
    if (!existsSync(dir)) return dir;
    if (statSync(dir).isDirectory() && (existsSync(join(dir, PROJECT_FILE)) || readdirSync(dir).length === 0)) return dir;
  }
  fail(`Couldn't find a free folder name next to ${video}. Use --project <dir>.`);
}

async function openEditor(store: ProjectStore, flags: Flags) {
  if (flags.dev) process.env.CUTROOM_DEV = "1";
  const { startServer } = await import("./server/server.js");
  const srv = await startServer(store, { port: flags.port ? Number(flags.port) : undefined });
  const url = flags.dev ? "http://localhost:5173" : srv.url;
  console.log(`cutroom editor: ${url}  (project ${store.dir})`);
  if (flags.browser !== false && !flags.dev) (await import("./mcp/server.js")).openBrowser(url);
  return srv;
}

async function analyzeVerbose(store: ProjectStore, id: string, flags: Flags) {
  let lastStep = "";
  const r = await analyzeMedia(store, id, {
    steps: analysisSteps(),
    force: flags.force === true,
    model: typeof flags.model === "string" ? flags.model : undefined,
    language: typeof flags.language === "string" ? flags.language : undefined,
    onProgress: (step, f) => {
      if (step !== lastStep) {
        lastStep = step;
        process.stderr.write(`${id}: ${step}…\n`);
      }
      void f;
    },
  });
  console.log(`${id}: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

/** All analysis steps, minus transcription when no backend is installed (so import still works). */
function analysisSteps(): AnalysisStep[] {
  return transcriptionBackend() ? ALL_STEPS : ALL_STEPS.filter((s) => s !== "transcript");
}

// ------------------------------------------------------------------ preflight

const FFMPEG = process.env.CUTROOM_FFMPEG ?? "ffmpeg";
const FFPROBE = process.env.CUTROOM_FFPROBE ?? "ffprobe";

/** Quick checks before work that needs ffmpeg / a transcriber, with a pointer to `cutroom doctor`. */
function preflight(opts: { transcribe: boolean; warnOnly?: boolean }) {
  const missing = [FFMPEG, FFPROBE].filter((b) => !findExecutable(b));
  if (missing.length) {
    const msg = `${missing.map((m) => basename(m)).join(" and ")} not found. Run \`cutroom doctor\` for install instructions.`;
    if (opts.warnOnly) console.error(`! ${msg}`);
    else fail(msg);
  }
  if (opts.transcribe && !transcriptionBackend()) {
    console.error(
      opts.warnOnly
        ? "! No transcription backend found, so recordings won't be transcribed. Run `cutroom doctor` to fix."
        : "! No transcription backend found; importing without a transcript. Run `cutroom doctor` to fix, then `cutroom analyze`.",
    );
  }
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Resolve a command on PATH (or an explicit path) without spawning a shell. Works on Windows too. */
function findExecutable(cmd: string): string | null {
  const isWin = process.platform === "win32";
  const exts = isWin ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").map((e) => e.toLowerCase())] : [""];
  const usable = (p: string) => {
    try {
      if (!statSync(p).isFile()) return false;
      if (!isWin) accessSync(p, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };
  if (isAbsolute(cmd) || cmd.includes("/") || (isWin && cmd.includes("\\"))) {
    for (const e of exts) if (usable(cmd + e)) return cmd + e;
    return null;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const e of exts) {
      const p = join(dir, cmd + e);
      if (usable(p)) return p;
    }
  }
  return null;
}

function whisperCppModel(): string | undefined {
  const env = process.env.CUTROOM_WHISPER_CPP_MODEL;
  if (env && existsSync(env)) return env;
  const fallback = join(homedir(), ".cache", "cutroom", "models", "ggml-base.en.bin");
  return existsSync(fallback) ? fallback : undefined;
}

let pythonHasFasterWhisper: boolean | undefined;
function pythonFasterWhisper(): boolean {
  if (pythonHasFasterWhisper === undefined) {
    const py = findExecutable("python3") ?? (process.platform === "win32" ? findExecutable("python") : null);
    pythonHasFasterWhisper = !!py && tryRun(py, ["-c", "import faster_whisper"], 20_000) !== null;
  }
  return pythonHasFasterWhisper;
}

/** Mirrors the auto-detection in src/core/transcribe.ts. */
function transcriptionBackend(): "whisper-cpp" | "faster-whisper (uv)" | "faster-whisper (python)" | null {
  const forced = process.env.CUTROOM_TRANSCRIBER;
  if (forced === "whisper-cpp") return findExecutable("whisper-cli") && whisperCppModel() ? "whisper-cpp" : null;
  if (findExecutable("whisper-cli") && whisperCppModel() && forced !== "faster-whisper") return "whisper-cpp";
  if (findExecutable("uv")) return "faster-whisper (uv)";
  if (pythonFasterWhisper()) return "faster-whisper (python)";
  return null;
}

function tryRun(cmd: string, args: string[], timeout = 15_000): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------- doctor

type Status = "pass" | "warn" | "fail";
interface Check {
  name: string;
  status: Status;
  detail: string;
  fix?: string[];
}

type OS = "mac" | "debian" | "fedora" | "arch" | "linux" | "windows";

function detectOS(): OS {
  if (process.platform === "darwin") return "mac";
  if (process.platform === "win32") return "windows";
  try {
    const rel = readFileSync("/etc/os-release", "utf8");
    const ids = `${/^ID=(.*)$/m.exec(rel)?.[1] ?? ""} ${/^ID_LIKE=(.*)$/m.exec(rel)?.[1] ?? ""}`.replace(/"/g, "");
    if (/debian|ubuntu/.test(ids)) return "debian";
    if (/fedora|rhel|centos/.test(ids)) return "fedora";
    if (/arch/.test(ids)) return "arch";
  } catch {
    /* not linux, or no os-release */
  }
  return "linux";
}

const FIX: Record<"node" | "ffmpeg" | "ffmpegFull" | "uv" | "home", Record<OS, string[]>> = {
  node: {
    mac: ["brew install node@22", "or use a version manager: https://github.com/nvm-sh/nvm"],
    debian: ["curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -", "sudo apt-get install -y nodejs"],
    fedora: ["sudo dnf install -y nodejs"],
    arch: ["sudo pacman -S nodejs npm"],
    linux: ["install Node 20+ from https://nodejs.org or with nvm: https://github.com/nvm-sh/nvm"],
    windows: ["winget install OpenJS.NodeJS.LTS", "or: choco install nodejs-lts"],
  },
  ffmpeg: {
    mac: ["brew install ffmpeg"],
    debian: ["sudo apt-get update && sudo apt-get install -y ffmpeg"],
    fedora: ["sudo dnf install -y ffmpeg   (enable RPM Fusion first: https://rpmfusion.org/Configuration)"],
    arch: ["sudo pacman -S ffmpeg"],
    linux: ["install ffmpeg 5+ from your package manager or https://ffmpeg.org/download.html"],
    windows: ["winget install Gyan.FFmpeg", "or: choco install ffmpeg-full"],
  },
  ffmpegFull: {
    mac: ["brew reinstall ffmpeg   (Homebrew's ffmpeg includes every filter cutroom uses)"],
    debian: ["sudo apt-get install -y ffmpeg   (the distro build is complete; avoid minimal/static builds)"],
    fedora: ["sudo dnf swap ffmpeg-free ffmpeg --allowerasing   (RPM Fusion's full build)"],
    arch: ["sudo pacman -S ffmpeg"],
    linux: ["install a full ffmpeg build (5+), or point CUTROOM_FFMPEG / CUTROOM_FFPROBE at one"],
    windows: ["winget install Gyan.FFmpeg   (the full build)", "or: choco install ffmpeg-full"],
  },
  uv: {
    mac: ["brew install uv", "or: curl -LsSf https://astral.sh/uv/install.sh | sh"],
    debian: ["curl -LsSf https://astral.sh/uv/install.sh | sh"],
    fedora: ["curl -LsSf https://astral.sh/uv/install.sh | sh"],
    arch: ["sudo pacman -S uv", "or: curl -LsSf https://astral.sh/uv/install.sh | sh"],
    linux: ["curl -LsSf https://astral.sh/uv/install.sh | sh"],
    windows: ["winget install astral-sh.uv", 'or: powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'],
  },
  home: {
    mac: ["mkdir -p ~/.cutroom && chmod u+rwx ~/.cutroom", "or set CUTROOM_HOME to a writable folder"],
    debian: ["mkdir -p ~/.cutroom && chmod u+rwx ~/.cutroom", "or set CUTROOM_HOME to a writable folder"],
    fedora: ["mkdir -p ~/.cutroom && chmod u+rwx ~/.cutroom", "or set CUTROOM_HOME to a writable folder"],
    arch: ["mkdir -p ~/.cutroom && chmod u+rwx ~/.cutroom", "or set CUTROOM_HOME to a writable folder"],
    linux: ["mkdir -p ~/.cutroom && chmod u+rwx ~/.cutroom", "or set CUTROOM_HOME to a writable folder"],
    windows: ['mkdir "%USERPROFILE%\\.cutroom"', "or set CUTROOM_HOME to a writable folder"],
  },
};

/** Filters cutroom's renderer and analysis depend on. */
const REQUIRED_FILTERS = ["lut3d", "afftdn", "deesser", "acompressor", "silencedetect", "loudnorm", "alimiter", "highpass", "equalizer", "overlay", "concat"];
const REQUIRED_ENCODERS = ["libx264", "aac"];

function hfCacheDir(): string {
  if (process.env.HF_HUB_CACHE) return process.env.HF_HUB_CACHE;
  if (process.env.HF_HOME) return join(process.env.HF_HOME, "hub");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "huggingface", "hub");
}

async function doctor(flags: Flags): Promise<boolean> {
  const os = detectOS();
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);

  // Node
  const [major, minor] = process.versions.node.split(".").map(Number);
  add({
    name: "Node.js",
    status: major >= 20 ? "pass" : "fail",
    detail: `v${process.versions.node}${major >= 20 ? "" : " (cutroom needs Node 20 or newer)"}`,
    fix: FIX.node[os],
  });
  void minor;

  // ffmpeg / ffprobe
  const ffmpegPath = findExecutable(FFMPEG);
  const ffmpegVersion = ffmpegPath ? tryRun(ffmpegPath, ["-hide_banner", "-version"]) : null;
  if (!ffmpegPath || !ffmpegVersion) {
    add({ name: "ffmpeg", status: "fail", detail: ffmpegPath ? `${ffmpegPath} doesn't run` : `${FFMPEG} not found on PATH`, fix: FIX.ffmpeg[os] });
  } else {
    const v = /version\s+(\S+)/.exec(ffmpegVersion)?.[1] ?? "unknown";
    const vMajor = Number(/^n?(\d+)\./.exec(v)?.[1] ?? NaN);
    const old = Number.isFinite(vMajor) && vMajor < 5;
    add({ name: "ffmpeg", status: old ? "warn" : "pass", detail: `${v} (${ffmpegPath})${old ? "; version 5 or newer is recommended" : ""}`, fix: FIX.ffmpeg[os] });

    const filters = tryRun(ffmpegPath, ["-hide_banner", "-filters"]) ?? "";
    const have = new Set(filters.split("\n").map((l) => /^\s*[A-Z.|]{2,4}\s+(\w+)\s/.exec(l)?.[1]).filter(Boolean));
    const missingFilters = REQUIRED_FILTERS.filter((f) => !have.has(f));
    add({
      name: "ffmpeg filters",
      status: missingFilters.length ? "fail" : "pass",
      detail: missingFilters.length ? `missing: ${missingFilters.join(", ")}` : REQUIRED_FILTERS.slice(0, 5).join(", ") + ` + ${REQUIRED_FILTERS.length - 5} more`,
      fix: FIX.ffmpegFull[os],
    });

    const encoders = tryRun(ffmpegPath, ["-hide_banner", "-encoders"]) ?? "";
    const haveEnc = new Set(encoders.split("\n").map((l) => /^\s*[VAS][A-Z.]{5}\s+(\S+)\s/.exec(l)?.[1]).filter(Boolean));
    const missingEnc = REQUIRED_ENCODERS.filter((e) => !haveEnc.has(e));
    add({
      name: "ffmpeg encoders",
      status: missingEnc.length ? "fail" : "pass",
      detail: missingEnc.length ? `missing: ${missingEnc.join(", ")}` : REQUIRED_ENCODERS.join(", "),
      fix: FIX.ffmpegFull[os],
    });
  }
  const ffprobePath = findExecutable(FFPROBE);
  const ffprobeVersion = ffprobePath ? tryRun(ffprobePath, ["-hide_banner", "-version"]) : null;
  add(
    ffprobePath && ffprobeVersion
      ? { name: "ffprobe", status: "pass", detail: `${/version\s+(\S+)/.exec(ffprobeVersion)?.[1] ?? "unknown"} (${ffprobePath})` }
      : { name: "ffprobe", status: "fail", detail: ffprobePath ? `${ffprobePath} doesn't run` : `${FFPROBE} not found on PATH (it ships with ffmpeg)`, fix: FIX.ffmpeg[os] },
  );

  // Transcription
  const model = typeof flags.model === "string" ? flags.model : (process.env.CUTROOM_WHISPER_MODEL ?? "base.en");
  const backend = transcriptionBackend();
  const uvPath = findExecutable("uv");
  const uvVersion = uvPath ? tryRun(uvPath, ["--version"])?.trim() : null;
  const whisperCli = findExecutable("whisper-cli");
  const found: string[] = [];
  if (whisperCli) found.push(whisperCppModel() ? "whisper-cli + model" : "whisper-cli (no model: set CUTROOM_WHISPER_CPP_MODEL)");
  if (uvPath) found.push(uvVersion ?? "uv");
  if (pythonFasterWhisper()) found.push("python3 faster_whisper");
  if (backend && uvPath && !uvVersion && backend === "faster-whisper (uv)") {
    add({ name: "Transcription", status: "fail", detail: `${uvPath} doesn't run`, fix: FIX.uv[os] });
  } else if (backend) {
    const via = backend === "faster-whisper (uv)" && uvVersion ? `faster-whisper via ${uvVersion.split(" ").slice(0, 2).join(" ")}` : backend;
    add({ name: "Transcription", status: "pass", detail: `${via}${found.length > 1 ? `  (also found: ${found.join(", ")})` : ""}` });
  } else {
    add({
      name: "Transcription",
      status: "fail",
      detail: found.length ? `no usable backend (found ${found.join(", ")})` : "no backend found (uv, python3 + faster_whisper, or whisper-cli + model)",
      fix: [...FIX.uv[os].map((f) => f), "then cutroom installs faster-whisper automatically on first use", "alternatives: pip install faster-whisper, or whisper.cpp + CUTROOM_WHISPER_CPP_MODEL"],
    });
  }
  if (backend?.startsWith("faster-whisper")) {
    const script = join(PKG_ROOT, "scripts", "transcribe_faster_whisper.py");
    if (!existsSync(script)) add({ name: "Transcriber script", status: "fail", detail: `missing ${script}; reinstall cutroom`, fix: ["npm install -g cutroom   (or run with npx cutroom)"] });
    const hub = hfCacheDir();
    const cached = existsSync(hub) && readdirSync(hub).some((d) => d.endsWith(`faster-whisper-${model}`));
    add({
      name: "Whisper model",
      status: cached ? "pass" : "warn",
      detail: cached ? `${model} is downloaded` : `${model} isn't downloaded yet; it downloads on first transcription (base.en is ~150 MB)`,
    });
  }

  // ~/.cutroom
  const home = process.env.CUTROOM_HOME ?? join(homedir(), ".cutroom");
  try {
    await mkdir(home, { recursive: true });
    const probe = join(home, `.doctor-${process.pid}`);
    await writeFile(probe, "ok");
    await rm(probe, { force: true });
    add({ name: "Settings folder", status: "pass", detail: `${home} is writable` });
  } catch (err) {
    add({ name: "Settings folder", status: "fail", detail: `can't write to ${home}: ${(err as Error).message}`, fix: FIX.home[os] });
  }

  // Package integrity: native canvas binding (captions) and the prebuilt editor.
  try {
    await import("@napi-rs/canvas");
    add({ name: "Caption renderer", status: "pass", detail: "@napi-rs/canvas loaded" });
  } catch (err) {
    add({
      name: "Caption renderer",
      status: "fail",
      detail: `@napi-rs/canvas failed to load: ${(err as Error).message.split("\n")[0]}`,
      fix: ["reinstall cutroom so npm fetches the native binary for this platform (npm install cutroom@latest)"],
    });
  }
  const webIndex = join(PKG_ROOT, "dist", "web", "index.html");
  add(
    existsSync(webIndex)
      ? { name: "Editor UI", status: "pass", detail: "prebuilt web editor found" }
      : { name: "Editor UI", status: "fail", detail: `missing ${webIndex}`, fix: ["from a git checkout: npm run build", "from npm: reinstall cutroom"] },
  );

  // Report
  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const icon: Record<Status, string> = { pass: paint(32, "✓"), warn: paint(33, "!"), fail: paint(31, "✗") };
  const width = Math.max(...checks.map((c) => c.name.length));
  console.log(`cutroom doctor  (cutroom ${version()}, ${process.platform} ${process.arch})\n`);
  for (const c of checks) {
    console.log(`  ${icon[c.status]} ${c.name.padEnd(width)}  ${c.status === "pass" ? c.detail : paint(c.status === "fail" ? 31 : 33, c.detail)}`);
    if (c.status !== "pass" && c.fix?.length) for (const f of c.fix) console.log(`  ${" ".repeat(width + 4)}${paint(2, "→")} ${f}`);
  }
  const failed = checks.filter((c) => c.status === "fail").length;
  const warned = checks.filter((c) => c.status === "warn").length;
  console.log(
    "\n" +
      (failed
        ? paint(31, `${failed} problem${failed === 1 ? "" : "s"} found.`) + " Fix the items marked ✗ and run `cutroom doctor` again."
        : paint(32, "All set.") + (warned ? ` ${warned} warning${warned === 1 ? "" : "s"}, nothing blocking.` : " cutroom is ready to edit.")),
  );
  return failed === 0;
}

main().catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  if (/ffmpeg|ffprobe|transcri|whisper|\buv\b|python/i.test(msg)) console.error("\nRun `cutroom doctor` to check your setup.");
  process.exit(1);
});
