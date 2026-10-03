// Records the real editor for Rough Cut while real Claude Code (headless, over MCP) edits the film:
// a scripted user cuts the false start from the transcript, boxes the 9:16 Short on the frame and
// asks for a grade and captions with ⌘K. Frames come from the CDP screencast with wall-clock
// timestamps; launch/out/rough/capture/frames.json marks each beat for the compositor. Every MCP
// message goes through tap.mjs into launch/out/rough/mcp-log.jsonl, and the agent-* marks come from
// that log. snapshots/v1..v4.json hold the project before the first note and after each one.
// Usage: npx tsx launch/rough/capture-rough.mts <project-dir>   (run prep-footage.sh first)
// Env: ROUGH_MODEL (claude --model), ROUGH_FACE_X (speaker's face, 0..1 of the frame, default 0.40,
//      measured on launch/out/rough/reed-take.mp4; check it again for another roll),
//      ROUGH_CUT="from-to" (word indices of the false start, if the detection picks wrong),
//      ROUGH_END_WAITING=0 (Claude stops after note 3; by default it ends in a live wait_for_feedback,
//      so the editor still shows it watching in the reveal and the end card's wait is a real logged
//      call; Claude is then killed at the end of the take, so claude.jsonl has no result line),
//      ROUGH_AGENT=stand-in (rig test only: stand-in-agent.mjs plays Claude; never for the film).
import { spawn } from "node:child_process";
import { closeSync, copyFileSync, cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { toolCalls, turns, type LogEntry, type Turn } from "./mcplog.mts";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "launch/out/rough");
const CAP = join(OUT, "capture");
const SNAP = join(OUT, "snapshots");
const LOG = join(OUT, "mcp-log.jsonl");
const PROJECT = resolve(process.argv[2] ?? "");
const CLI = join(ROOT, "dist/cli.js");
const PORT = 4400;
const FACE_X = Number(process.env.ROUGH_FACE_X ?? 0.4);
const END_WAITING = process.env.ROUGH_END_WAITING !== "0";
if (!existsSync(join(PROJECT, "cutroom.json"))) {
  console.error("usage: npx tsx launch/rough/capture-rough.mts <project-dir>");
  process.exit(1);
}
// Never the user's ~/.cutroom: the editor, the MCP server and Claude's tap all share a scratch home.
const HOME = process.env.ROUGH_HOME ?? mkdtempSync(join(tmpdir(), "cutroom-rough-"));
const env = { ...process.env, CUTROOM_HOME: HOME } as Record<string, string>;
for (const d of [CAP, SNAP]) rmSync(d, { recursive: true, force: true });
for (const d of [CAP, SNAP]) mkdirSync(d, { recursive: true });
for (const f of [LOG, join(OUT, "claude.jsonl")]) rmSync(f, { force: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const events: { name: string; t: number }[] = [];
const markAt = (name: string, t: number) => (events.push({ name, t }), console.log("·", name));
const mark = (name: string) => markAt(name, Date.now() / 1000);
// Where UI elements sit (CSS px in the 1440×900 window), so the film can frame macro shots.
type Box = { x: number; y: number; width: number; height: number };
const rects: Record<string, Box> = {};
let pageRef: import("@playwright/test").Page | null = null;
async function keep(name: string, sel: string | import("@playwright/test").Locator) {
  const loc = typeof sel === "string" ? pageRef!.locator(sel).first() : sel;
  const b = await loc.boundingBox({ timeout: 400 }).catch(() => null);
  if (b) rects[name] = b;
}
const union = (bs: Box[]): Box => {
  const x = Math.min(...bs.map((b) => b.x)), y = Math.min(...bs.map((b) => b.y));
  return { x, y, width: Math.max(...bs.map((b) => b.x + b.width)) - x, height: Math.max(...bs.map((b) => b.y + b.height)) - y };
};

// Every run starts from the untouched project, so takes can be repeated: the first run keeps
// cutroom.json (and its undo history) aside; later runs restore them and clear notes and review state.
const data = join(PROJECT, ".cutroom");
const pristine = [["cutroom.json", join(data, "rough-pristine.json")], [".cutroom/history.json", join(data, "rough-pristine-history.json")]];
for (const [file, saved] of pristine) {
  if (!existsSync(join(PROJECT, file))) continue;
  if (existsSync(saved)) copyFileSync(saved, join(PROJECT, file));
  else copyFileSync(join(PROJECT, file), saved);
}
for (const f of ["feedback.json", "review.json", "selection.json", "agent.json"]) rmSync(join(data, f), { force: true });
const snapshot = (v: string) => (copyFileSync(join(PROJECT, "cutroom.json"), join(SNAP, `${v}.json`)), console.log("· snapshot", v));
snapshot("v1");

// What the user points at, from the transcript's word timings.
const project = JSON.parse(readFileSync(join(PROJECT, "cutroom.json"), "utf8"));
type Word = { i: number; text: string; start: number; end: number };
const words: Word[] = JSON.parse(readFileSync(join(data, "cache", project.clips[0].mediaId, "transcript.json"), "utf8")).words;
const norm = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "");
const FILLER = /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+)$/;
/** The false start: "is it— is it rolling? okay. umm." from the first word through the filler (or "okay").
 * A take without the stammer (the v4 stand-in) cuts just its first filler. */
function falseStart() {
  if (process.env.ROUGH_CUT) {
    const [from, to] = process.env.ROUGH_CUT.split("-").map(Number);
    return { from, to: to ?? from };
  }
  const head = words.slice(0, 14).map((w) => norm(w.text));
  const rolling = head.indexOf("rolling");
  if (rolling >= 0) {
    const filler = head.findIndex((w, i) => i > rolling && FILLER.test(w));
    const okay = head.findIndex((w, i) => i > rolling && /^(okay|ok)$/.test(w));
    return { from: 0, to: filler >= 0 ? filler : okay >= 0 ? okay : rolling };
  }
  const f = words.findIndex((w) => FILLER.test(norm(w.text)));
  if (f >= 0) return { from: f, to: f };
  throw new Error("nothing to cut in the transcript");
}
/** The word after "cutroom." (Whisper may split it as "cut room."), where play2 stops; null if the take never says it. */
function afterBrand(): number | null {
  for (let i = 0; i + 1 < words.length; i++) {
    const a = norm(words[i].text);
    const j = a === "cutroom" ? i + 1 : a === "cut" && norm(words[i + 1].text) === "room" ? i + 2 : -1;
    if (j > 0) return words[j]?.i ?? null;
  }
  return null;
}
const cut = falseStart();
console.log(`· false start: words ${cut.from}–${cut.to} "${words.slice(cut.from, cut.to + 1).map((w) => w.text).join(" ")}", then "${words[cut.to + 1]?.text}" at ${words[cut.to + 1]?.start}s`);

// ---------------------------------------------------------------- editor
const server = spawn(process.execPath, [CLI, "open", PROJECT, "--no-browser", "--port", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
const URL_ = await new Promise<string>((ok, bad) => {
  let out = "";
  const on = (d: Buffer) => {
    out += d;
    const m = out.match(/editor: (http:\/\/\S+)/);
    if (m) ok(m[1].replace(/\/$/, ""));
  };
  server.stdout!.on("data", on);
  server.stderr!.on("data", on);
  setTimeout(() => bad(new Error(out)), 20000);
});

// ---------------------------------------------------------------- Claude
// Real Claude Code, headless, with cutroom as its only MCP server (through the tap). It is started
// before the first note, so it is already waiting in wait_for_feedback when the user starts.
const PROMPT =
  `You are editing the cutroom video project at ${PROJECT}. Call open_project with that path, then call wait_for_feedback. ` +
  "For each note: call update_feedback with status working, make exactly the edit the note asks for with one edit call (nothing extra), " +
  "then update_feedback with status resolved and a reply of at most five words. Then call wait_for_feedback again. " +
  (END_WAITING ? "After the third note is resolved, call wait_for_feedback one last time." : "Stop after the third note is resolved.");
const tapConfig = join(mkdtempSync(join(tmpdir(), "rough-tap-")), "tap.json");
writeFileSync(tapConfig, JSON.stringify({ mcpServers: { cutroom: { command: process.execPath, args: [join(ROOT, "launch/rough/tap.mjs")], env: { ROUGH_PROJECT: PROJECT, ROUGH_MCP_LOG: LOG, CUTROOM_HOME: HOME } } } }));
// A nested session must not inherit a parent Claude Code's session plumbing (when this runs inside one).
const NESTED = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_EFFORT|AI_AGENT|CLAUDE_AGENT_SDK_VERSION|CLAUDE_CODE_(ENTRYPOINT|SESSION_ID|CHILD_SESSION|SESSION_ATTENDED|HOST_SESSION_ID|MESSAGING_\w+|EXECPATH|TERMINAL_MCP_TOOLS|SDK_HAS_HOST_AUTH_REFRESH|ENABLE_SDK_FILE_CHECKPOINTING|EMIT_TOOL_USE_SUMMARIES|REPORT_FINDINGS|ENABLE_ASK_USER_QUESTION_TOOL|EAGER_FLUSH))$/;
const claudeEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !NESTED.test(k)));
const claudeArgs = ["-p", PROMPT, "--mcp-config", tapConfig, "--strict-mcp-config", "--allowedTools", "mcp__cutroom__*", "--output-format", "stream-json", "--verbose"];
if (process.env.ROUGH_MODEL) claudeArgs.push("--model", process.env.ROUGH_MODEL);
const STAND_IN = process.env.ROUGH_AGENT === "stand-in";
if (STAND_IN) console.warn("! ROUGH_AGENT=stand-in: a scripted client plays Claude. Rig test only, not for the film.");
const claude = STAND_IN
  ? spawn(process.execPath, [join(ROOT, "launch/rough/stand-in-agent.mjs"), tapConfig, PROJECT], { cwd: PROJECT, env, stdio: ["ignore", "pipe", "pipe"], detached: true })
  : spawn("claude", claudeArgs, { cwd: PROJECT, env: claudeEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
const claudeOut = STAND_IN ? null : createWriteStream(join(OUT, "claude.jsonl"));
let claudeExit: number | null = null;
let claudeResult: any = null;
let claudeRest = "";
claude.stdout!.on("data", (d: Buffer) => {
  claudeOut?.write(d);
  claudeRest += d;
  for (let nl; (nl = claudeRest.indexOf("\n")) >= 0; claudeRest = claudeRest.slice(nl + 1)) {
    try {
      const m = JSON.parse(claudeRest.slice(0, nl));
      if (m.type === "result") claudeResult = m;
    } catch {}
  }
});
claude.stderr!.on("data", (d: Buffer) => process.stderr.write(`claude: ${d}`));
claude.on("error", (e) => console.error(`! could not start ${STAND_IN ? "the stand-in" : "claude"}: ${e.message}`));
claude.on("close", (code) => ((claudeExit = code ?? 1), console.log(`· claude exited (${claudeExit})`)));
const killAll = () => {
  try {
    if (claudeExit === null) process.kill(-claude.pid!, "SIGTERM");
  } catch {}
  server.kill();
};
process.on("exit", killAll);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

// Tail the tap's log: the agent-* marks carry the log's own timestamps.
const log: LogEntry[] = [];
let logAt = 0;
let logRest = Buffer.alloc(0);
const chunk = Buffer.alloc(1 << 20);
function readLog() {
  if (!existsSync(LOG)) return false;
  const fd = openSync(LOG, "r");
  for (let n; (n = readSync(fd, chunk, 0, chunk.length, logAt)) > 0; logAt += n) logRest = Buffer.concat([logRest, chunk.subarray(0, n)]);
  closeSync(fd);
  let grew = false;
  for (let nl; (nl = logRest.indexOf(10)) >= 0; logRest = logRest.subarray(nl + 1)) {
    const e = JSON.parse(logRest.subarray(0, nl).toString("utf8"));
    // Only the text matters here; the frames Claude was sent stay in the file.
    if (Array.isArray(e.msg?.result?.content)) e.msg.result.content = e.msg.result.content.filter((c: { type: string }) => c.type !== "image");
    log.push(e);
    grew = true;
  }
  return grew;
}
let agentWaiting = false;
let agent: Turn[] = [];
const fired = new Set<string>();
const resolvedAck: Record<number, number> = {};
function refresh() {
  if (!readLog()) return;
  agentWaiting ||= toolCalls(log).some((c) => c.name === "wait_for_feedback");
  agent = turns(log);
  const at = (name: string, t?: number) => t !== undefined && !fired.has(name) && (fired.add(name), markAt(name, t));
  for (const tr of agent) {
    at(`agent-saw-${tr.n}`, tr.seen);
    at(`agent-working-${tr.n}`, tr.working);
    at(`agent-edit-${tr.n}`, tr.edits.find((e) => !e.error && e.at !== undefined)?.at);
    at(`agent-resolved-${tr.n}`, tr.resolved);
    if (tr.resolvedAck !== undefined) resolvedAck[tr.n] = tr.resolvedAck;
  }
}
const tail = setInterval(refresh, 50);
/** The user waits for Claude to finish a note before the next one, so each turn reads on its own. */
async function afterResolved(n: number, settle = 1300) {
  const t = Date.now();
  while (resolvedAck[n] === undefined) {
    // The agent can exit right after its last response, before the tail has read it.
    if (claudeExit !== null && (refresh(), resolvedAck[n] === undefined)) throw new Error(`Claude exited before resolving note ${n}`);
    if (Date.now() - t > 300_000) throw new Error(`note ${n} not resolved after 5 minutes`);
    await sleep(100);
  }
  await sleep(settle);
}

// ---------------------------------------------------------------- browser
// The headless screencast ignores the context's deviceScaleFactor; this flag gives true 2× frames.
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--force-device-scale-factor=2"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
// String scripts: tsx adds __name() helpers that do not exist in the page.
await ctx.addInitScript(`var __name = (f) => f; (${(() => {
  const css = `#fc{position:fixed;left:0;top:0;width:26px;height:26px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px)}
  #fc svg{filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))} #fr{position:fixed;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:2px solid #d9ff4a;pointer-events:none;z-index:2147483646;opacity:0}
  #fr.go{animation:fr .45s ease-out} @keyframes fr{0%{opacity:.9;transform:scale(.3)}100%{opacity:0;transform:scale(1.4)}}`;
  addEventListener("DOMContentLoaded", () => {
    const s = document.createElement("style");
    s.textContent = css;
    document.head.append(s);
    const c = document.createElement("div");
    c.id = "fc";
    c.innerHTML = `<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L14.6 22.6 L11.2 15.3 L18 15.3 Z" fill="#111" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
    const r = document.createElement("div");
    r.id = "fr";
    document.body.append(c, r);
    addEventListener("pointermove", (e) => (c.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`), true);
    addEventListener(
      "pointerdown",
      (e) => {
        r.style.left = `${e.clientX}px`;
        r.style.top = `${e.clientY}px`;
        r.classList.remove("go");
        void r.offsetWidth;
        r.classList.add("go");
      },
      true,
    );
  });
}).toString()})()`);
const page = await ctx.newPage();
pageRef = page;
await page.goto(`${URL_}/`);
await page.waitForSelector("[data-i]", { timeout: 20000 });
await sleep(2500);
// Keep resolved notes (with Claude's replies) in view, and hide the rule-of-thirds guides so the paused
// preview matches the exported frames the film cuts to.
await page.getByRole("button", { name: "All", exact: true }).click().catch(() => {});
await page.locator('.transport button[title="Rule-of-thirds guides"].on').click({ timeout: 2000 }).catch(() => {});

// Claude boots (and connects to cutroom) before the take starts.
{
  const t = Date.now();
  while (!agentWaiting) {
    if (claudeExit !== null) throw new Error(`Claude exited before it started waiting for feedback${claudeResult?.result ? `: ${claudeResult.result}` : ""}`);
    if (Date.now() - t > 180_000) throw new Error("Claude never called wait_for_feedback");
    await sleep(100);
  }
  console.log(`· Claude waiting for notes after ${((Date.now() - t) / 1000).toFixed(1)}s`);
  await sleep(1500);
}

// Screencast
const cdp = await ctx.newCDPSession(page);
const frames: { file: string; t: number }[] = [];
cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
  const file = `f${String(frames.length).padStart(5, "0")}.jpg`;
  frames.push({ file, t: f.metadata.timestamp });
  writeFileSync(join(CAP, file), Buffer.from(f.data, "base64"));
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 95, maxWidth: 2880, maxHeight: 1800, everyNthFrame: 1 });

// Keep frames flowing while idle (the screencast only emits on paint).
await page.evaluate(`(() => {
  const d = document.createElement("div");
  d.style.cssText = "position:fixed;right:0;bottom:0;width:2px;height:2px;pointer-events:none;z-index:2147483647";
  document.body.append(d);
  let i = 0;
  const tick = () => ((d.style.background = i++ % 2 ? "#0b0a09" : "#0c0b0a"), requestAnimationFrame(tick));
  tick();
})()`);

let mouse = { x: 1100, y: 640 };
const ease = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2);
async function glide(x: number, y: number, ms = 600) {
  const from = { ...mouse };
  const n = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const u = ease(i / n);
    const px = from.x + (x - from.x) * u, py = from.y + (y - from.y) * u;
    // Outside the window the page gets no pointer events, so the drawn cursor is moved directly.
    if (px >= 0 && py >= 0 && px < 1440 && py < 900) await page.mouse.move(px, py);
    else await page.evaluate(`document.getElementById("fc").style.transform = "translate(${px - 3}px,${py - 2}px)"`);
    await sleep(Math.max(1, ms / n - 4));
  }
  mouse = { x, y };
}
async function click() {
  await page.mouse.down();
  await sleep(70);
  await page.mouse.up();
}
const rect = async (sel: string) => (await page.locator(sel).first().boundingBox())!;
const word = (i: number) => rect(`.w[data-i="${i}"]`);
const playing = () => page.evaluate(`!!document.querySelector('.transport button[aria-label="Pause"]')`) as Promise<boolean>;
/** Play, then pause once the transcript's highlighted word is `i` (or after `ms` if there is no word to stop on). */
async function playUntil(i: number | null, ms: number) {
  await page.keyboard.press("Space");
  if (i !== null) await page.waitForFunction(`document.querySelector(".w.now")?.dataset.i === "${i}"`, null, { timeout: ms + 4000, polling: "raf" }).catch(() => console.warn(`  (never reached word ${i})`));
  else await sleep(ms);
  if (await playing()) await page.keyboard.press("Space");
}
const card = (note: string) => page.locator(".fb-card").filter({ has: page.locator(".fb-note", { hasText: new RegExp(`^\\s*${note.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`) }) }).first();
const NOTES = ["cut this", "make this the Short", "warmer, more contrast. captions that pop."];

try {
  await page.mouse.move(mouse.x, mouse.y);
  await keep("frame", ".frame");
  mark("start");
  await sleep(1200);

  // The preview rests on the first word after the stammer (clicking a word seeks there, paused).
  const rest = await word(cut.to + 1);
  await glide(rest.x + rest.width / 2, rest.y + rest.height / 2, 800);
  await click();
  mark("pause1");
  await sleep(1500);

  // NOTE 1: drag across the false start in the transcript, press C, "cut this"
  const w0 = await word(cut.from);
  const w1 = await word(cut.to);
  await glide(w0.x + 1, w0.y + w0.height / 2, 800);
  mark("select-down");
  await page.mouse.down();
  await glide(w1.x + w1.width - 1, w1.y + w1.height / 2, 650);
  await page.mouse.up();
  mark("select-up");
  const spans: Box[] = [];
  for (let i = cut.from; i <= cut.to; i++) spans.push(await word(i));
  rects.words = union(spans);
  await sleep(500);
  await page.keyboard.press("c");
  await sleep(350);
  await page.keyboard.type(NOTES[0], { delay: 55 });
  await keep("composer1", ".composer");
  await sleep(300);
  mark("note1-send");
  await page.keyboard.press("Meta+Enter");
  await afterResolved(1);
  snapshot("v2");
  // Drop the focus on the resolved note (a resolved box would otherwise stay drawn on the frame).
  await page.keyboard.press("Escape");

  // Play from the top, stop on the word after "cutroom."
  await page.keyboard.press("Home");
  await sleep(400);
  mark("play2");
  await playUntil(afterBrand(), 2400);
  mark("pause2");
  await sleep(700);

  // NOTE 2: box exactly where cutroom's 9:16 crop sits when centred on the face, top edge to bottom edge
  const frame = await rect(".frame");
  await glide(frame.x + frame.width * 0.5, frame.y + frame.height * 0.45, 700);
  await sleep(250);
  await page.keyboard.press("a");
  await sleep(500);
  const cropW = Math.min(frame.width, (frame.height * 9) / 16);
  const cropX = frame.x + Math.min(Math.max(FACE_X * frame.width - cropW / 2, 0), frame.width - cropW);
  await glide(Math.max(cropX, frame.x + 0.5), frame.y + 0.5, 600);
  mark("box-down");
  await page.mouse.down();
  // Past the bottom edge: the layer keeps the pointer and clamps the box to the frame.
  await glide(cropX + cropW, frame.y + frame.height + 2, 750);
  await page.mouse.up();
  mark("box-up");
  await sleep(350);
  await keep("box", ".annot-layer .marker.draft");
  await page.keyboard.type(NOTES[1], { delay: 55 });
  await keep("composer2", ".composer");
  await sleep(300);
  mark("note2-send");
  await page.keyboard.press("Meta+Enter");
  await sleep(500);
  await page.keyboard.press("Escape");
  // The editor's paused preview keeps its old framing after an aspect change until the next seek,
  // so step a frame forward and back once Claude's edit has landed.
  for (const t = Date.now(); !fired.has("agent-edit-2") && resolvedAck[2] === undefined && Date.now() - t < 300_000; ) await sleep(100);
  await sleep(700);
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowLeft");
  await afterResolved(2);
  snapshot("v3");
  await page.keyboard.press("Escape");
  await keep("frame916", ".frame");

  // Play on for a moment in 9:16
  await sleep(500);
  mark("play3");
  await playUntil(null, 2200);
  mark("pause3");
  await sleep(700);

  // NOTE 3: ⌘K, free text goes to Claude
  const f0 = await rect(".frame");
  await glide(f0.x + f0.width / 2, 40, 700);
  await sleep(200);
  mark("palette");
  await page.keyboard.press("Meta+k");
  await sleep(450);
  await page.keyboard.type(NOTES[2], { delay: 48 });
  await keep("palette", ".palette");
  await sleep(500);
  mark("ask-send");
  await page.keyboard.press("Enter");
  await sleep(400);
  // Out of the way while Claude works: off the bottom of the window.
  await glide(f0.x + f0.width / 2, 900 + 40, 700);
  await afterResolved(3);
  snapshot("v4");
  await page.keyboard.press("Escape");
  // Claude's change list sits above the notes, so scroll the panel until all three cards are in view
  // (the film's pins fly to their ticks).
  await page.evaluate(`(() => {
    const top = document.querySelector(".fb-card");
    const list = top && top.closest(".scroll");
    if (list) list.scrollTo({ top: top.offsetTop - list.offsetTop - 12, behavior: "smooth" });
  })()`);
  await sleep(700);
  for (const [i, note] of NOTES.entries()) await keep(`card${i + 1}`, card(note));
  // Optional anchors for the pull-back: each card's number badge, its last reply, the project title.
  for (const [i, note] of NOTES.entries()) {
    await keep(`tick${i + 1}`, card(note).locator(".fb-num"));
    await keep(`reply${i + 1}`, card(note).locator(".fb-reply").last());
  }
  await keep("title", ".doc-tab");
  await keep("review", ".review-bar");
  await keep("before", page.locator(".review-bar button", { hasText: /^Before$/ }));
  await keep("after", page.locator(".review-bar button", { hasText: /^After$/ }));

  // REVEAL: back to the first frame and play the finished cut once ('reveal-play'). It stops on its
  // last frame, and that still is the pull-back source ('reveal'): the film lays the v4 export's last
  // frame over the preview while zoomed in, then crossfades to these pixels, so they must match. The
  // hold covers the whole pull-back (5 s in rough.mts) before the cursor comes back for the review.
  const first = await page.evaluate(`[...document.querySelectorAll(".w[data-t]")].sort((a, b) => a.dataset.t - b.dataset.t)[0]?.dataset.i`);
  const fw = await word(Number(first));
  await glide(fw.x + fw.width / 2, fw.y + fw.height / 2, 800);
  await click();
  // Out of the window again, so the reveal has no cursor in it.
  await glide(fw.x + 300, 900 + 40, 700);
  await sleep(300);
  mark("reveal-play");
  await page.keyboard.press("Space");
  await page.waitForFunction(`!!document.querySelector('.transport button[aria-label="Pause"]')`, null, { timeout: 3000 }).catch(() => {});
  await page.waitForFunction(`!!document.querySelector('.transport button[aria-label="Play"]')`, null, { timeout: 60000, polling: 100 }).catch(() => console.warn("  (playback never ended)"));
  await sleep(300);
  mark("reveal");
  await sleep(6500);

  // REVIEW: Before, then After
  const before = await rect(".review-bar button:text-is('Before')");
  await glide(before.x + before.width / 2, before.y + before.height / 2, 700);
  mark("before-click");
  await click();
  await sleep(1500);
  const shown = await rect(".frame");
  // The editor sizes the preview from the current project, so Before can stay 9:16; the film then uses the v1 plate.
  if (shown.width < shown.height) mark("before-not-unfolded");
  const after = await rect(".review-bar button:text-is('After')");
  await glide(after.x + after.width / 2, after.y + after.height / 2, 600);
  mark("after-click");
  await click();
  await sleep(1500);
  mark("end");
} finally {
  clearInterval(tail);
  await cdp.send("Page.stopScreencast").catch(() => {});
  refresh();
  events.sort((a, b) => a.t - b.t);
  writeFileSync(join(CAP, "frames.json"), JSON.stringify({ frames, events, rects }, null, 1));
  if (frames.length) console.log(`${frames.length} frames over ${(frames.at(-1)!.t - frames[0].t).toFixed(1)}s`);

  // The final project, for offline use (states.mts exports every snapshot from this copy).
  const copy = join(OUT, "project");
  rmSync(copy, { recursive: true, force: true });
  mkdirSync(join(copy, ".cutroom"), { recursive: true });
  copyFileSync(join(PROJECT, "cutroom.json"), join(copy, "cutroom.json"));
  cpSync(join(data, "cache"), join(copy, ".cutroom/cache"), { recursive: true });
  for (const f of ["feedback.json", "review.json"]) if (existsSync(join(data, f))) copyFileSync(join(data, f), join(copy, ".cutroom", f));

  // What Claude did, per note, timed from the moment the note was sent.
  const sent = ["note1-send", "note2-send", "ask-send"].map((n) => events.find((e) => e.name === n)?.t);
  const s = (t: number | undefined, from: number | undefined) => (t !== undefined && from !== undefined ? `${(t - from).toFixed(1)}s` : "–");
  for (const tr of turns(log)) {
    const t0 = sent[tr.n - 1];
    console.log(`note ${tr.n} "${tr.note ?? NOTES[tr.n - 1]}": seen ${s(tr.seen, t0)}, working ${s(tr.working, t0)}, edit ${s(tr.edits[0]?.at, t0)}, resolved ${s(tr.resolved, t0)}  reply "${tr.reply ?? ""}"`);
    for (const e of tr.edits) console.log(`  edit${e.error ? " (error)" : ""} ${JSON.stringify(e.ops)}${e.label ? ` "${e.label}"` : ""}`);
  }
  const used = toolCalls(log).map((c) => c.name);
  console.log(`tools: ${used.join(", ")}`);
  if (claudeResult) console.log(`claude: ${claudeResult.subtype}, ${claudeResult.num_turns} turns, ${(claudeResult.duration_ms / 1000).toFixed(1)}s, $${claudeResult.total_cost_usd?.toFixed(3)}${claudeResult.permission_denials?.length ? `, denied: ${JSON.stringify(claudeResult.permission_denials)}` : ""}`);
  const need = "start pause1 select-down select-up note1-send agent-working-1 agent-edit-1 agent-resolved-1 play2 pause2 box-down box-up note2-send agent-working-2 agent-edit-2 agent-resolved-2 play3 pause3 palette ask-send agent-working-3 agent-edit-3 agent-resolved-3 reveal before-click after-click end".split(" ");
  const missing = need.filter((n) => !events.some((e) => e.name === n));
  const missingRects = "frame words composer1 box composer2 frame916 palette card1 card2 card3 review before after".split(" ").filter((n) => !rects[n]);
  if (missing.length || missingRects.length) console.warn(`missing events: ${missing.join(" ") || "none"}; missing rects: ${missingRects.join(" ") || "none"}`);
  await browser.close();
  killAll();
}
process.exit(0);
