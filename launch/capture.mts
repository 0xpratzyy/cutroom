// Records the real editor for the launch film: a scripted user annotates the frame, comments on
// transcript words and leaves a voice note, while a real MCP client (standing in for Claude)
// picks the notes up and fixes them. Frames come from the CDP screencast with wall-clock
// timestamps; launch/out/capture/frames.json marks each beat for the compositor.
// Usage: npx tsx launch/capture.mts <project-dir>   (run speaker.mts + init the project first)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = resolve(import.meta.dirname, "..");
const OUT = join(ROOT, "launch/out/capture");
const PROJECT = resolve(process.argv[2] ?? "");
const PORT = 4400;
const CLI = join(ROOT, "dist/cli.js");
const env = { ...process.env } as Record<string, string>;
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const events: { name: string; t: number }[] = [];
const mark = (name: string) => (events.push({ name, t: Date.now() / 1000 }), console.log("·", name));
// Where UI elements sit (CSS px in the 1440×900 window), so the film can frame macro shots.
type Box = { x: number; y: number; width: number; height: number };
const rects: Record<string, Box> = {};
let pageRef: import("@playwright/test").Page | null = null;
async function keep(name: string, sel: string | import("@playwright/test").Locator) {
  const loc = typeof sel === "string" ? pageRef!.locator(sel).first() : sel;
  const b = await loc.boundingBox({ timeout: 400 }).catch(() => null);
  if (b) rects[name] = b;
}

// The "user's" voice note, fed to Chromium as a fake microphone.
const voice = join(OUT, "voice.wav");
const elevenNote = join(ROOT, "launch/out/eleven/voicenote.mp3");
if (existsSync(elevenNote)) {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", elevenNote, "-af", "adelay=300:all=1,apad=pad_dur=5", "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", voice]);
} else {
  execFileSync("say", ["-v", "Samantha", "-r", "175", "-o", join(OUT, "voice.aiff"), "[[slnc 300]] Make the captions pop. [[slnc 5000]]"]);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(OUT, "voice.aiff"), "-ar", "48000", "-ac", "1", "-c:a", "pcm_s16le", voice]);
}

// ---------------------------------------------------------------- editor
const server = spawn(process.execPath, [CLI, "open", PROJECT, "--no-browser", "--port", String(PORT)], { env, stdio: ["ignore", "pipe", "pipe"] });
await new Promise<void>((ok, bad) => {
  let out = "";
  const on = (d: Buffer) => ((out += d), out.includes(String(PORT)) && ok());
  server.stdout!.on("data", on);
  server.stderr!.on("data", on);
  setTimeout(() => bad(new Error(out)), 20000);
});

// ---------------------------------------------------------------- "Claude"
const client = new Client({ name: "claude-demo", version: "0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, "mcp"], cwd: PROJECT, env }));
const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 })) as { content: { type: string; text?: string }[] };
  return r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
await call("open_project", { path: PROJECT });
// The first "So the idea is..." in the transcript: the false start the user selects.
function falseStart() {
  const words: { text: string }[] = JSON.parse(readFileSync(join(PROJECT, ".cutroom/cache/m1/transcript.json"), "utf8")).words;
  const norm = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "");
  for (let i = 0; i + 3 < words.length; i++) {
    if (["so", "the", "idea", "is"].every((w, k) => norm(words[i + k].text) === w)) return { from: i, to: i + 3 };
  }
  throw new Error("false start not found in transcript");
}
const handled = new Set<number>();
let agentDone = false;
const agent = (async () => {
  while (handled.size < 3) {
    await call("wait_for_feedback", { timeoutSec: 600 });
    const feedback = (await (await fetch(`http://localhost:${PORT}/api/feedback`)).json()) as { n: number; note: string; status: string }[];
    for (const f of feedback.filter((f) => f.status === "open" && !handled.has(f.n))) {
      handled.add(f.n);
      await sleep(600);
      await call("update_feedback", { id: String(f.n), status: "working" });
      mark(`agent-working-${f.n}`);
      await sleep(1200);
      const note = f.note.toLowerCase();
      let reply = "Done.";
      if (/center|cut off|frame/.test(note)) {
        await call("edit", { ops: [{ op: "set_focus", x: 0.3125, y: 0.5 }], label: "center the speaker" });
        reply = "Reframed the shot so you're centered.";
      } else if (/false start|cut/.test(note)) {
        const fs = falseStart();
await call("edit", { ops: [{ op: "remove_words", mediaId: "m1", from: fs.from, to: fs.to }, { op: "remove_fillers" }], label: "cut the false start" });
        reply = "Cut the false start and the “umm”.";
      } else {
        await call("edit", { ops: [{ op: "set_captions", preset: "pop", emphasisWords: ["point", "wrong", "fixes", "simple", "cool"] }, { op: "set_hook", text: "AI just fixes it", start: 0, duration: 2.5 }], label: "pop captions" });
        reply = "Pop captions on, key words highlighted. Added a hook too.";
      }
      mark(`agent-edit-${f.n}`);
      await sleep(400);
      await call("update_feedback", { id: String(f.n), status: "resolved", reply });
      mark(`agent-resolved-${f.n}`);
      await sleep(250);
      if (pageRef) await keep(`card${f.n}`, pageRef.locator(".fb-card", { hasText: f.note.slice(0, 20) }).first());
    }
  }
  agentDone = true;
})().catch((e) => console.error("agent:", e));

// ---------------------------------------------------------------- browser
const browser = await chromium.launch({
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.route("**/__voice.wav", (r) => r.fulfill({ path: voice, contentType: "audio/wav" }));
// String scripts: tsx adds __name() helpers that do not exist in the page.
await ctx.addInitScript(`var __name = (f) => f; (${(() => {
  // Headless Chromium's fake microphone hangs, so the "mic" plays the voice clip through Web Audio.
  navigator.mediaDevices.getUserMedia = async () => {
    const ac = new AudioContext();
    await ac.resume();
    const buf = await ac.decodeAudioData(await (await fetch("/__voice.wav")).arrayBuffer());
    const src = ac.createBufferSource();
    src.buffer = buf;
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    src.start();
    return dest.stream;
  };
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
await page.goto(`http://localhost:${PORT}/`);
await page.waitForSelector("[data-i]", { timeout: 20000 });
await sleep(2500);

// Screencast
const cdp = await ctx.newCDPSession(page);
const frames: { file: string; t: number }[] = [];
cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
  const file = `f${String(frames.length).padStart(5, "0")}.jpg`;
  frames.push({ file, t: f.metadata.timestamp });
  writeFileSync(join(OUT, file), Buffer.from(f.data, "base64"));
  cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, maxWidth: 2880, maxHeight: 1800, everyNthFrame: 1 });

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
    await page.mouse.move(from.x + (x - from.x) * u, from.y + (y - from.y) * u);
    await sleep(Math.max(1, ms / n - 4));
  }
  mouse = { x, y };
}
const rect = async (sel: string) => (await page.locator(sel).first().boundingBox())!;

// Keep resolved notes (with Claude's replies) in view.
await page.getByRole("button", { name: "All", exact: true }).click().catch(() => {});
await page.mouse.move(mouse.x, mouse.y);
mark("start");
await sleep(1200);

// 1 — Box it
const frame = await rect(".frame");
await glide(frame.x + frame.width * 0.5, frame.y + frame.height * 0.45, 700);
await sleep(250);
mark("annotate-key");
await page.keyboard.press("a");
await sleep(500);
// The speaker is cut off at the left edge of the 9:16 crop: box their face.
const x0 = frame.x + frame.width * 0.03, y0 = frame.y + frame.height * 0.24;
const x1 = frame.x + frame.width * 0.4, y1 = frame.y + frame.height * 0.56;
await glide(x0, y0, 600);
mark("box-down");
await page.mouse.down();
await glide(x1, y1, 750);
await page.mouse.up();
mark("box-up");
await sleep(350);
await keep("frame", ".frame");
await keep("box", ".annot-layer .marker.draft");
await page.keyboard.type("speaker's cut off, center them", { delay: 42 });
await keep("composer1", ".composer");
await sleep(300);
mark("note1-send");
await page.keyboard.press("Meta+Enter");
await sleep(500);
await page.keyboard.press("Escape");
await sleep(400);

// 2 — Select it (drag across the false start in the transcript)
const fsw = falseStart();
const w11 = (await page.locator(`[data-i="${fsw.from}"]`).first().boundingBox())!;
const w14 = (await page.locator(`[data-i="${fsw.to}"]`).first().boundingBox())!;
await glide(w11.x + 1, w11.y + w11.height / 2, 800);
mark("select-down");
await page.mouse.down();
await glide(w14.x + w14.width - 1, w14.y + w14.height / 2, 650);
await page.mouse.up();
mark("select-up");
await sleep(500);
await page.keyboard.press("c");
await sleep(350);
rects.words = { x: w11.x, y: Math.min(w11.y, w14.y), width: w14.x + w14.width - w11.x, height: Math.max(w11.y + w11.height, w14.y + w14.height) - Math.min(w11.y, w14.y) };
await page.keyboard.type("cut the false start", { delay: 45 });
await keep("composer2", ".composer");
await sleep(250);
mark("note2-send");
await page.keyboard.press("Meta+Enter");
await sleep(1200);

// 3 — Say it (hold V over the captions area while it plays)
const f2 = await rect(".frame");
await glide(f2.x + f2.width * 0.5, f2.y + f2.height * 0.78, 700);
await page.keyboard.press("Space");
await sleep(400);
await keep("mic", '.tool[title^="Hold to talk"]');
mark("voice-down");
await page.keyboard.down("v");
await sleep(2900);
await page.keyboard.up("v");
mark("voice-up");
await page.keyboard.press("Space");

// Wait for Claude to finish all three.
const t0 = Date.now();
while (!agentDone && Date.now() - t0 < 120000) await sleep(200);
mark("agent-done");
await sleep(1500);

// 4 — Review: Before / After
const before = page.locator(".review-bar button", { hasText: /before/i }).first();
const after = page.locator(".review-bar button", { hasText: /after/i }).first();
await keep("review", ".review-bar");
if (await before.count()) {
  const b = (await before.boundingBox())!;
  await glide(b.x + b.width / 2, b.y + b.height / 2, 700);
  await sleep(200);
  mark("before");
  await page.mouse.down();
  await page.mouse.up();
  await sleep(1700);
  const a = (await after.boundingBox())!;
  await glide(a.x + a.width / 2, a.y + a.height / 2, 400);
  mark("after");
  await page.mouse.down();
  await page.mouse.up();
  await sleep(900);
}
// Play the result from the top.
await glide(f2.x + f2.width * 0.85, f2.y + f2.height * 0.62, 500);
await page.keyboard.press("Home");
await sleep(200);
mark("play");
await page.keyboard.press("Space");
await sleep(7000);
await page.keyboard.press("Space");
mark("palette");
await page.keyboard.press("Meta+k");
await sleep(500);
await page.keyboard.type("make the intro punchier", { delay: 50 });
await keep("palette", ".palette");
await sleep(1600);
mark("end");

await cdp.send("Page.stopScreencast");
writeFileSync(join(OUT, "frames.json"), JSON.stringify({ frames, events, rects }, null, 1));
console.log(`${frames.length} frames over ${(frames.at(-1)!.t - frames[0].t).toFixed(1)}s`);
await browser.close();
await client.close();
server.kill();
void agent;
process.exit(0);
