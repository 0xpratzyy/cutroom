// The genuine picture states of Rough Cut, rendered offline after capture-rough.mts (so export CPU
// never hitches the screencast): each project snapshot is exported by the real cutroom CLI.
//   v1 before any note, v2 after "cut this", v3 after the Short, v4 after the grade + captions, and
//   v4b = v3 plus ONLY the set_look op(s) Claude made for note 3 (the honest middle of the bloom).
// Also writes states/words.json: the timeline words (kept words, timeline seconds) of each state.
// Usage: npx tsx launch/rough/states.mts   ->  launch/out/rough/states/{v1,v2,v3,v4b,v4}.mp4 + words.json
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { timelineDuration, timelineWords } from "../../src/core/shared/timeline.ts";
import type { Project, Transcript } from "../../src/core/shared/types.ts";
import { readLog, turns } from "./mcplog.mts";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "launch/out/rough");
const STATES = join(OUT, "states");
const PROJECT = join(OUT, "project");
const CLI = join(ROOT, "dist/cli.js");
const SCRATCH = mkdtempSync(join(tmpdir(), "rough-states-"));
const env = { ...process.env, CUTROOM_HOME: join(SCRATCH, "home") };
mkdirSync(STATES, { recursive: true });

const snap = (v: string) => JSON.parse(readFileSync(join(OUT, "snapshots", `${v}.json`), "utf8")) as Project;
const cli = (args: string[], cwd = ROOT) => execFileSync(process.execPath, [CLI, ...args], { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
/** A throwaway copy of the final project (media paths are absolute, the transcript cache comes along) holding `p`. */
function scratch(name: string, p: Project) {
  const dir = join(SCRATCH, name);
  mkdirSync(join(dir, ".cutroom"), { recursive: true });
  cpSync(join(PROJECT, ".cutroom/cache"), join(dir, ".cutroom/cache"), { recursive: true });
  writeFileSync(join(dir, "cutroom.json"), JSON.stringify(p, null, 2));
  return dir;
}

// v4b: the set_look op(s) from Claude's edit(s) for note 3, exactly as logged.
const note3 = turns(readLog(join(OUT, "mcp-log.jsonl"))).find((t) => t.n === 3);
const looks = (note3?.edits ?? []).filter((e) => !e.error).flatMap((e) => e.ops.filter((o) => o.op === "set_look"));
if (!looks.length) console.warn("! Claude made no set_look for note 3; v4b is the same picture as v3");

const states: [string, string][] = [["v1", "v1"], ["v2", "v2"], ["v3", "v3"], ["v4b", "v3"], ["v4", "v4"]];
for (const [name, from] of states) {
  const dir = scratch(name, snap(from));
  if (name === "v4b" && looks.length) console.log(`v4b: ${cli(["edit", "--project", dir, JSON.stringify(looks)])}`);
  const out = join(STATES, `${name}.mp4`);
  const t = Date.now();
  cli(["export", "--project", dir, "--quality", "high", "--out", out]);
  console.log(`${name}: ${out} (${((Date.now() - t) / 1000).toFixed(1)}s)`);
}

// Timeline words per state, the same mapping the editor and the renderer use.
const transcripts: Record<string, Transcript> = {};
for (const id of readdirSync(join(PROJECT, ".cutroom/cache"))) {
  const f = join(PROJECT, ".cutroom/cache", id, "transcript.json");
  if (existsSync(f)) transcripts[id] = JSON.parse(readFileSync(f, "utf8"));
}
const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
const words: Record<string, unknown> = {};
const duration: Record<string, number> = {};
for (const v of ["v1", "v2", "v3", "v4"]) {
  const p = snap(v);
  words[v] = timelineWords(p, transcripts).map((w) => ({ text: w.word.text, start: r4(w.start), end: r4(w.end), i: w.word.i }));
  duration[v] = r4(timelineDuration(p));
}
writeFileSync(join(STATES, "words.json"), JSON.stringify({ ...words, duration }, null, 1));
console.log(`words.json: ${Object.entries(duration).map(([v, d]) => `${v} ${d}s/${(words[v] as unknown[]).length} words`).join(", ")}`);
rmSync(SCRATCH, { recursive: true, force: true });
