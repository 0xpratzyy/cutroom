#!/usr/bin/env node
// Release check: pack the npm tarball, install it into a fresh temp project, and make
// sure the installed package works: `cutroom --help`, `cutroom doctor`, and the MCP
// server (via scripts/mcp-smoke.mjs).
//
//   npm run test:pack                    # builds via `prepack`, then checks
//   npm run test:pack -- --no-build      # reuse the current dist/
//   npm run test:pack -- --allow-doctor-fail   # don't fail when this machine lacks ffmpeg etc.
//   npm run test:pack -- --keep          # keep the temp folder for inspection
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const flags = new Set(process.argv.slice(2));
const isWin = process.platform === "win32";
const work = mkdtempSync(join(tmpdir(), "cutroom-pack-"));
let failures = 0;

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", shell: isWin, maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw r.error;
  return r;
}
function check(ok, label, detail = "") {
  console.log(`${ok ? "  ok  " : "  FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
  if (!ok) failures++;
}
function step(title) {
  console.log(`\n== ${title}`);
}

try {
  step("npm pack");
  const pack = run("npm", ["pack", "--json", "--pack-destination", work, ...(flags.has("--no-build") ? ["--ignore-scripts"] : [])], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (pack.status !== 0) throw new Error("npm pack failed");
  const [info] = JSON.parse(pack.stdout.slice(pack.stdout.indexOf("[")));
  const tarball = join(work, info.filename);
  const files = info.files.map((f) => f.path);
  console.log(`  ${info.filename}: ${files.length} files, ${(info.size / 1e6).toFixed(2)} MB packed, ${(info.unpackedSize / 1e6).toFixed(2)} MB unpacked`);

  for (const f of ["package.json", "README.md", "LICENSE", "dist/cli.js", "dist/core/index.js", "dist/server/server.js", "dist/mcp/server.js", "dist/web/index.html", "scripts/transcribe_faster_whisper.py"]) {
    check(files.includes(f), `includes ${f}`);
  }
  check(files.some((f) => f.startsWith("dist/web/assets/") && f.endsWith(".js")), "includes the built editor bundle (dist/web/assets/*.js)");
  const unwanted = files.filter((f) => /^(src|web|test|\.github|node_modules)\//.test(f) || f.endsWith(".map") || /make-fixtures|smoke|playwright|tsconfig/.test(f));
  check(unwanted.length === 0, "excludes sources, tests, source maps and dev scripts", unwanted.slice(0, 5).join(", "));

  step("npm install <tarball> into a fresh project");
  const app = join(work, "app");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "package.json"), JSON.stringify({ name: "cutroom-smoke", private: true, type: "module" }, null, 2));
  const install = run("npm", ["install", tarball, "--no-audit", "--no-fund", "--loglevel=error"], { cwd: app, stdio: "inherit" });
  check(install.status === 0, "npm install");
  if (install.status !== 0) throw new Error("install failed");

  const pkgDir = join(app, "node_modules", "cutroom");
  const cli = readFileSync(join(pkgDir, "dist", "cli.js"), "utf8");
  check(cli.startsWith("#!/usr/bin/env node"), "bin has a node shebang");
  for (const dev of ["react", "react-dom", "vite", "typescript", "@playwright/test", "tsx"]) {
    check(!existsSync(join(app, "node_modules", dev)), `devDependency ${dev} not installed`);
  }

  step("npx cutroom --help");
  const help = run("npx", ["--no-install", "cutroom", "--help"], { cwd: app });
  check(help.status === 0 && help.stdout.includes("cutroom doctor") && help.stdout.includes("cutroom mcp"), "prints usage", help.status !== 0 ? help.stderr : "");

  const version = run("npx", ["--no-install", "cutroom", "--version"], { cwd: app });
  check(version.stdout.trim() === info.version, "--version matches package.json", version.stdout.trim());

  step("npx cutroom doctor");
  const doctor = run("npx", ["--no-install", "cutroom", "doctor"], { cwd: app, env: { ...process.env, NO_COLOR: "1" } });
  process.stdout.write(doctor.stdout.replace(/^/gm, "    "));
  if (doctor.stderr.trim()) process.stdout.write(doctor.stderr.replace(/^/gm, "    "));
  check(doctor.stdout.includes("Editor UI") && /✓ Editor UI/.test(doctor.stdout), "installed package finds its prebuilt editor");
  check(/✓ Caption renderer/.test(doctor.stdout), "native @napi-rs/canvas loads");
  if (flags.has("--allow-doctor-fail")) console.log(`  (doctor exited ${doctor.status}; not required)`);
  else check(doctor.status === 0, "doctor passes on this machine", doctor.status === 0 ? "" : `exit ${doctor.status}; use --allow-doctor-fail to skip`);

  const fixture = join(ROOT, "test", "fixtures", "talking.mp4");
  if (doctor.status === 0 && existsSync(fixture)) {
    step("npx cutroom init <dir> talking.mp4 (import + transcribe from the installed package)");
    const init = run("npx", ["--no-install", "cutroom", "init", "proj", fixture], { cwd: app, env: { ...process.env, CUTROOM_HOME: join(work, "home") } });
    const transcript = join(app, "proj", ".cutroom", "cache", "m1", "transcript.json");
    const words = existsSync(transcript) ? JSON.parse(readFileSync(transcript, "utf8")).words.length : 0;
    check(init.status === 0 && words > 0, "project created and transcribed", init.status === 0 ? `${words} words` : init.stderr.slice(-600));
  } else console.log("\n(skipping the transcription check: doctor failed or test/fixtures/talking.mp4 is missing; run npm run fixtures)");

  step("MCP server: list tools + create_project");
  copyFileSync(join(ROOT, "scripts", "mcp-smoke.mjs"), join(app, "mcp-smoke.mjs"));
  const bin = isWin ? [process.execPath, join(pkgDir, "dist", "cli.js")] : [join(app, "node_modules", ".bin", "cutroom")];
  const mcp = run(process.execPath, ["mcp-smoke.mjs", ...bin, "mcp"], { cwd: app, stdio: "inherit", shell: false });
  check(mcp.status === 0, "MCP smoke test");
} catch (err) {
  failures++;
  console.error(`\npack-smoke: ${err instanceof Error ? err.message : err}`);
} finally {
  if (flags.has("--keep")) console.log(`\nKept ${work}`);
  else rmSync(work, { recursive: true, force: true });
}

console.log(failures ? `\npack-smoke: ${failures} check(s) failed` : "\npack-smoke: all checks passed");
process.exit(failures ? 1 : 0);
