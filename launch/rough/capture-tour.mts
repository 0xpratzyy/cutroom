// Records the real editor for Rough Cut's feature tour: on a fresh copy of the same take, a scripted
// user runs through the tools the three notes don't show: the ⌘K palette, Fillers, Pauses, a punch-in
// zoom, the caption templates, looks, a hook title, studio sound, b-roll (full frame, then picture in
// picture), a voice note and the export aspects. No agent: these are the user's own edits.
// Frames come from the CDP screencast at 2×; launch/out/rough/tour/frames.json marks each beat and
// where its UI sits, so the compositor can cut the tour as macro shots.
// Usage: npx tsx launch/rough/capture-tour.mts   (after capture-rough: it starts from snapshots/v1.json)
// Inputs: launch/out/rough/tour-assets/broll.png (an image for the b-roll lane) and voicenote.wav
// (what the "user" says into the mic).
import { execFileSync, spawn } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "launch/out/rough");
const TOUR = join(OUT, "tour");
const ASSETS = join(OUT, "tour-assets");
const CLI = join(ROOT, "dist/cli.js");
const PORT = 4410;
for (const f of ["broll.png", "voicenote.wav"]) if (!existsSync(join(ASSETS, f))) throw new Error(`missing ${join(ASSETS, f)}`);
rmSync(TOUR, { recursive: true, force: true });
mkdirSync(TOUR, { recursive: true });

// A scratch copy of the film's project, back at its first state (16:9, stammer and all), plus the b-roll.
const WORK = mkdtempSync(join(tmpdir(), "cutroom-tour-"));
const PROJECT = join(WORK, "project");
cpSync(join(OUT, "project"), PROJECT, { recursive: true });
copyFileSync(join(OUT, "snapshots/v1.json"), join(PROJECT, "cutroom.json"));
for (const f of ["feedback.json", "review.json", "selection.json", "agent.json", "history.json"]) rmSync(join(PROJECT, ".cutroom", f), { force: true });
const env = { ...process.env, CUTROOM_HOME: join(WORK, "home") } as Record<string, string>;
mkdirSync(env.CUTROOM_HOME, { recursive: true });
execFileSync(process.execPath, [CLI, "import", join(ASSETS, "broll.png"), "--role", "library", "--project", PROJECT], { env, stdio: "inherit" });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const events: { name: string; t: number }[] = [];
const mark = (name: string) => (events.push({ name, t: Date.now() / 1000 }), console.log("·", name));
type Box = { x: number; y: number; width: number; height: number };
const rects: Record<string, Box> = {};

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
process.on("exit", () => server.kill());
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

// ---------------------------------------------------------------- browser
// The headless screencast ignores the context's deviceScaleFactor; this flag gives true 2× frames. The
// Style tab's live look and caption thumbnails are WebGL canvases too: past Chromium's default 16
// contexts the preview's own context is the one that gets dropped (it paints white), so allow more.
const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--force-device-scale-factor=2", "--max-active-webgl-contexts=96"] });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await ctx.route("**/__voice.wav", (r) => r.fulfill({ path: join(ASSETS, "voicenote.wav"), contentType: "audio/wav" }));
// String scripts: tsx adds __name() helpers that do not exist in the page.
await ctx.addInitScript(`var __name = (f) => f; (${(() => {
  // Headless Chromium's fake microphone hangs, so the "mic" plays the voice note through Web Audio.
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
await page.goto(`${URL_}/`);
await page.waitForSelector("[data-i]", { timeout: 20000 });
await sleep(2500);
await page.locator('.transport button[title="Rule-of-thirds guides"].on').click({ timeout: 2000 }).catch(() => {});

async function keep(name: string, sel: string | import("@playwright/test").Locator) {
  const loc = typeof sel === "string" ? page.locator(sel).first() : sel;
  const b = await loc.boundingBox({ timeout: 600 }).catch(() => null);
  if (b) rects[name] = b;
  else console.warn(`  (no rect for ${name})`);
}
/** The bounding box of every element matching a selector (the transcript's words, say). */
async function keepAll(name: string, sel: string) {
  const b = (await page.evaluate(`(() => {
    const r = [...document.querySelectorAll(${JSON.stringify(sel)})].map((e) => e.getBoundingClientRect()).filter((r) => r.width && r.bottom > 0 && r.top < innerHeight);
    if (!r.length) return null;
    const x = Math.min(...r.map((q) => q.left)), y = Math.min(...r.map((q) => q.top));
    return { x, y, width: Math.max(...r.map((q) => q.right)) - x, height: Math.max(...r.map((q) => q.bottom)) - y };
  })()`)) as Box | null;
  if (b) rects[name] = b;
}

// Screencast
const cdp = await ctx.newCDPSession(page);
const frames: { file: string; t: number }[] = [];
cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { timestamp: number } }) => {
  const file = `f${String(frames.length).padStart(5, "0")}.jpg`;
  frames.push({ file, t: f.metadata.timestamp });
  writeFileSync(join(TOUR, file), Buffer.from(f.data, "base64"));
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
async function glide(x: number, y: number, ms = 450) {
  const from = { ...mouse };
  const n = Math.max(8, Math.round(ms / 16));
  for (let i = 1; i <= n; i++) {
    const u = ease(i / n);
    await page.mouse.move(from.x + (x - from.x) * u, from.y + (y - from.y) * u);
    await sleep(Math.max(1, ms / n - 4));
  }
  mouse = { x, y };
}
async function click() {
  await page.mouse.down();
  await sleep(60);
  await page.mouse.up();
}
const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });
/** Glides onto an element and clicks it (scrolling it into view first). */
async function press(loc: import("@playwright/test").Locator, name?: string, ms = 420) {
  await loc.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
  await sleep(120);
  const b = await loc.boundingBox();
  if (!b) throw new Error(`can't see ${name ?? loc}`);
  const c = centre(b);
  await glide(c.x, c.y, ms);
  if (name) rects[name] = b;
  await click();
}
const tab = (name: string) => page.getByRole("tab", { name, exact: true });
const words = () => page.evaluate(`[...document.querySelectorAll(".w[data-i]")].map((e) => ({ i: +e.dataset.i, text: e.textContent.trim() }))`) as Promise<{ i: number; text: string }[]>;
const word = async (i: number) => (await page.locator(`.w[data-i="${i}"]`).first().boundingBox())!;
const norm = (w: string) => w.toLowerCase().replace(/[^a-z']/g, "");

try {
  await page.mouse.move(mouse.x, mouse.y);
  await keep("frame", ".frame");
  await keep("left", ".panel.left");
  await keep("timeline", ".timeline");
  mark("start");
  await sleep(800);

  // ⌘K: every command by name
  mark("palette-in");
  await page.keyboard.press("Meta+k");
  await sleep(450);
  await keep("palette", ".palette");
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("ArrowDown");
    await sleep(130);
  }
  mark("palette-end");
  await sleep(350);
  await page.keyboard.press("Escape");
  await sleep(500);

  // Fillers, then pauses
  await keepAll("words", ".w[data-i]");
  const fillers = page.locator("button", { hasText: "Fillers" }).first();
  await keep("fillersBtn", fillers);
  mark("fillers-in");
  await press(fillers, "fillersBtn", 500);
  mark("fillers");
  await sleep(1100);
  await keepAll("words2", ".w[data-i]");
  const pauses = page.locator("button", { hasText: "Pauses" }).first();
  mark("pauses-in");
  await press(pauses, "pausesBtn", 380);
  mark("pauses");
  await sleep(1100);

  // A punch-in zoom on a phrase: drag across the words, press Z, play through it
  const ws = await words();
  const iYou = ws.findIndex((w) => norm(w.text) === "you");
  const iWrong = ws.findIndex((w) => norm(w.text) === "wrong");
  if (iYou < 0 || iWrong < 0) throw new Error("can't find the zoom phrase");
  const a = await word(ws[iYou].i), b = await word(ws[iWrong].i);
  mark("zoom-in");
  await glide(a.x + 2, a.y + a.height / 2, 450);
  await page.mouse.down();
  await glide(b.x + b.width - 2, b.y + b.height / 2, 420);
  await page.mouse.up();
  await sleep(350);
  mark("zoom-select");
  await page.keyboard.press("z");
  mark("zoom");
  await sleep(450);
  await keep("zoomBlock", ".timeline .zoom, .timeline [class*='zoom']");
  // back to the phrase's first word, then play through the punch-in
  await page.keyboard.press("Escape");
  await glide(a.x + a.width / 2, a.y + a.height / 2, 300);
  await click();
  await sleep(250);
  mark("zoom-play");
  await page.keyboard.press("Space");
  await sleep(1800);
  await page.keyboard.press("Space");
  mark("zoom-end");
  await sleep(300);

  // Captions: park the playhead on a spoken word, then run through the templates
  const iPoint = ws.findIndex((w) => norm(w.text) === "point");
  await page.keyboard.press("Escape");
  const pw = await word(ws[iPoint >= 0 ? iPoint : iYou].i);
  await glide(pw.x + pw.width / 2, pw.y + pw.height / 2, 380);
  await click();
  await sleep(250);
  await press(tab("Style"), "styleTab", 420);
  await sleep(400);
  const preset = (name: string) => page.locator(`.preset-card[title="${name}"]`).first();
  await preset("Karaoke").scrollIntoViewIfNeeded();
  await sleep(250);
  await keep("captionCards", page.locator(".preset-card[title='Karaoke']").first().locator("xpath=.."));
  mark("captions-in");
  for (const name of ["Karaoke", "Neon", "One word", "Pop"]) {
    await press(preset(name), undefined, 300);
    mark(`captions-${name.toLowerCase().replace(/\s/g, "-")}`);
    await sleep(650);
  }

  // Looks
  const look = (name: string) => page.locator(".look-card", { hasText: name }).first();
  await look("Teal").scrollIntoViewIfNeeded();
  await sleep(250);
  await keep("lookCards", page.locator(".look-card").first().locator("xpath=.."));
  mark("looks-in");
  for (const name of ["Teal & Orange", "Film", "Black & White", "Warm"]) {
    await press(look(name), undefined, 300);
    mark(`look-${name.toLowerCase().replace(/[^a-z]+/g, "-")}`);
    await sleep(650);
  }

  // A hook title over the opening seconds
  await page.keyboard.press("Home");
  const hookText = page.locator(".hook-text").first();
  await hookText.scrollIntoViewIfNeeded();
  await sleep(250);
  await keep("hookPanel", hookText.locator("xpath=../.."));
  mark("hook-in");
  await press(hookText, "hookText", 380);
  await page.keyboard.type("Stop editing by hand", { delay: 45 });
  mark("hook-typed");
  await press(page.locator(".preset-card", { hasText: "Highlight" }).first(), "hookCard", 350);
  mark("hook");
  await sleep(1100);

  // Studio sound
  const podcast = page.locator(".sound-card", { hasText: "Podcast" }).first();
  await podcast.scrollIntoViewIfNeeded();
  await sleep(200);
  await keep("soundCards", podcast.locator("xpath=.."));
  mark("sound-in");
  await press(podcast, "podcast", 350);
  mark("sound");
  await sleep(900);

  // B-roll: from the Media tab onto the timeline at the playhead, then picture in picture
  // the cutaway goes in on "This is cutroom", with room to play through it
  const iThis = ws.findIndex((w) => norm(w.text) === "this");
  const seekThis = async () => {
    const tw = await word(ws[iThis >= 0 ? iThis : iYou].i);
    await glide(tw.x + tw.width / 2, tw.y + tw.height / 2, 300);
    await click();
    await sleep(200);
  };
  await seekThis();
  await press(page.locator(".panel.left .seg button", { hasText: "Media" }).first(), "mediaTab", 380);
  await sleep(400);
  // the image is listed after the take; its own "+ B-roll" is the last one
  const addBroll = page.locator("button", { hasText: "+ B-roll" }).last();
  await keep("mediaItem", addBroll.locator("xpath=../.."));
  mark("broll-in");
  await press(addBroll, "addBroll", 380);
  mark("broll");
  // the paused preview only draws the cutaway once it plays through it
  await sleep(200);
  await page.keyboard.press("Space");
  await sleep(1300);
  await page.keyboard.press("Space");
  await sleep(300);
  await keep("brollBlock", ".timeline [class*='broll'], .timeline [class*='overlay']");
  // select the cutaway on the timeline: its inspector has the picture-in-picture switch
  if (rects.brollBlock) {
    await glide(rects.brollBlock.x + rects.brollBlock.width / 2, rects.brollBlock.y + rects.brollBlock.height / 2, 380);
    await click();
    await sleep(350);
    await press(tab("Edit"), "editTab", 380);
    await sleep(400);
  }
  const pip = page.locator("button", { hasText: "Picture-in-picture" }).first();
  if (await pip.count()) {
    await press(pip, "pipBtn", 380);
    await press(page.locator(".panel.left .seg button", { hasText: "Transcript" }).first(), undefined, 300);
    await seekThis();
    mark("pip");
    await page.keyboard.press("Space");
    await sleep(1300);
    await page.keyboard.press("Space");
    await sleep(300);
  } else console.warn("  (no Picture-in-picture control in view)");

  // A voice note: hold V and talk
  await press(page.locator(".panel.left .seg button", { hasText: "Transcript" }).first(), undefined, 300);
  await glide(rects.frame.x + rects.frame.width * 0.62, rects.frame.y + rects.frame.height * 0.35, 450);
  await sleep(200);
  mark("voice-in");
  await page.keyboard.down("v");
  await sleep(300);
  await keep("voiceOverlay", ".voice-overlay");
  await sleep(2100);
  await page.keyboard.up("v");
  mark("voice-up");
  await page.locator(".fb-card").first().waitFor({ timeout: 20000 }).catch(() => console.warn("  (no voice note card)"));
  mark("voice-note");
  await keep("voiceCard", ".fb-card");
  await sleep(900);

  // Export: every aspect, then the handoff formats
  await press(tab("Export"), "exportTab", 420);
  await sleep(450);
  await keep("exportPanel", page.locator("button", { hasText: "Export video" }).first().locator("xpath=.."));
  mark("export-in");
  for (const a of ["9:16", "1:1", "4:5", "16:9"]) {
    await press(page.locator(".seg button", { hasText: a }).first(), undefined, 300);
    mark(`aspect-${a.replace(":", "x")}`);
    await sleep(700);
  }
  const otio = page.locator("button", { hasText: "Timeline (.otio)" }).first();
  const ob = await otio.boundingBox();
  if (ob) {
    await glide(ob.x + ob.width / 2, ob.y + ob.height / 2, 420);
    rects.otio = ob;
  }
  mark("export-handoff");
  await sleep(900);
  mark("end");
} finally {
  await cdp.send("Page.stopScreencast").catch(() => {});
  writeFileSync(join(TOUR, "frames.json"), JSON.stringify({ frames, events, rects }, null, 1));
  console.log(`tour: ${frames.length} frames, ${events.length} marks → ${join(TOUR, "frames.json")}`);
  await browser.close();
  server.kill();
}
