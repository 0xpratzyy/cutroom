// "Rough Cut": the launch film Claude edits while you watch. The cutroom mark is cut out of a note
// pin and the camera flies through it into the film's own rough cut, which stammers and pauses; a
// cursor points at what's wrong on the picture; Claude, connected over MCP, edits the film you're
// watching (cuts the false start, turns the box into a 9:16 Short, grades and captions it); then
// the camera pulls back into the real cutroom project, and the film ends inside a live
// wait_for_feedback call before the waiting dot is cut back into the mark.
//
// Every picture state is a genuine cutroom export of the captured session (states.mts); the
// MCP log lines are the real calls (mcp-log.jsonl), time-compressed only while the picture is
// paused; the transitions between states (rewind, fold, bloom, caption lift) are composited here.
// The narrator's lines (vo.mts) set the holds: each pause lasts as long as the longest read needs.
//
// Usage: npx tsx launch/rough/rough.mts [--cues] [--only=1.2,14] -> launch/out/rough/film-video.mp4
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts, loadImage, Path2D, type Image, type SKRSContext2D } from "@napi-rs/canvas";
import { computeCrop } from "../../src/core/shared/timeline.ts";
import { bindPremium, clamp, CORAL, expo, line, stage } from "../premium.mts";

const OUT = "launch/out/rough";
const W = 1920, H = 1080, FPS = 60, INNER_FPS = 24;
const LIME = "#e8f47c", BONE = "#f4f2ef", GREY = "#8d8983", SOFT = "#d4d0ca";
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNS.ttf", "SF");
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNSMono.ttf", "SFMono");
GlobalFonts.registerFromPath("node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2", "Inter");

// ---------------------------------------------------------------- data
type Box = { x: number; y: number; width: number; height: number };
type Word = { text: string; start: number; end: number; i: number };
const cap = JSON.parse(readFileSync(join(OUT, "capture/frames.json"), "utf8")) as { frames: { file: string; t: number }[]; events: { name: string; t: number }[]; rects: Record<string, Box> };
const t0 = cap.events.find((e) => e.name === "start")!.t;
const ev = Object.fromEntries(cap.events.map((e) => [e.name, e.t - t0])) as Record<string, number>;
const rects = cap.rects;
const capTimes = cap.frames.map((f) => f.t - t0);
function capIndex(c: number) {
  let lo = 0, hi = capTimes.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (capTimes[mid] <= c) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}
const capFile = (c: number) => join(OUT, "capture", cap.frames[capIndex(c)].file);
const statesWords = JSON.parse(readFileSync(join(OUT, "states/words.json"), "utf8")) as Record<string, Word[]> & { duration: Record<string, number> };
const snap = (v: string) => JSON.parse(readFileSync(join(OUT, `snapshots/${v}.json`), "utf8"));
const v3snap = snap("v3");
const feedback = (() => {
  const f = join(OUT, "project/.cutroom/feedback.json");
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")).items as { n: number; note: string; region?: { x: number; y: number; w: number; h: number } | null; replies?: { author: string; text: string }[] }[]) : [];
})();

// The MCP conversation: every tools/call with its result, in order.
type Call = { t: number; tRes: number; name: string; args: Record<string, unknown>; result: { content?: { type: string; text?: string; data?: string }[] } };
const calls: Call[] = (() => {
  const f = join(OUT, "mcp-log.jsonl");
  if (!existsSync(f)) return [];
  const reqs = new Map<unknown, { t: number; name: string; args: Record<string, unknown> }>();
  const out: Call[] = [];
  for (const l of readFileSync(f, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const o = JSON.parse(l) as { t: number; dir: string; msg: { id?: unknown; method?: string; params?: { name: string; arguments?: Record<string, unknown> }; result?: Call["result"] } };
    if (o.dir === "req" && o.msg.method === "tools/call") reqs.set(o.msg.id, { t: o.t - t0, name: o.msg.params!.name, args: o.msg.params!.arguments ?? {} });
    else if (o.dir === "res" && reqs.has(o.msg.id)) out.push({ ...reqs.get(o.msg.id)!, tRes: o.t - t0, result: o.msg.result ?? {} });
  }
  return out.sort((a, b) => a.t - b.t);
})();
const lit = (v: unknown): string => (typeof v === "number" ? String(Math.round(v * 1000) / 1000) : typeof v === "string" ? `"${v}"` : JSON.stringify(v));
/** An edit op exactly as Claude sent it, in a compact readable form. */
function opText(op: Record<string, unknown>) {
  const { op: name, ...rest } = op;
  const keys = Object.keys(rest).filter((k) => k !== "mediaId");
  return keys.length ? `${name} { ${keys.map((k) => `${k}: ${lit(rest[k])}`).join(", ")} }` : String(name);
}
/** What happened for note n: the wait that delivered it (with the frame Claude saw), the ops, the reply. */
function noteStory(n: number) {
  const note = feedback.find((f) => f.n === n);
  const wait = calls.find((c) => c.name === "wait_for_feedback" && (c.result.content ?? []).some((x) => x.text?.includes(`#${n}`)));
  let thumb: string | undefined;
  if (wait?.result.content) {
    const items = wait.result.content;
    const k = items.findIndex((x) => x.text?.startsWith(`Frame for #${n}`));
    if (k >= 0 && items[k + 1]?.data) thumb = items[k + 1].data;
  }
  const isN = (c: Call) => String(c.args.id) === String(n);
  const working = calls.find((c) => c.name === "update_feedback" && isN(c) && c.args.status === "working");
  const resolved = calls.find((c) => c.name === "update_feedback" && isN(c) && c.args.status === "resolved");
  const edits = calls.filter((c) => c.name === "edit" && (!working || c.t >= working.t - 0.01) && (!resolved || c.t <= resolved.t));
  const ops = edits.flatMap((c) => ((c.args.ops as Record<string, unknown>[]) ?? []).map(opText));
  const reply = (resolved?.args.reply as string) ?? note?.replies?.find((r) => r.author === "agent")?.text ?? "";
  return { n, note: note?.note ?? "", region: note?.region ?? null, thumb, ops: ops.length ? ops : ["edit"], reply };
}
const story = [1, 2, 3].map(noteStory);

// The narrator (vo.mts writes one vo-<take>.json per read). One picture serves every read, so each
// hold is sized for the slowest take of its line.
type VoLine = { end: number; words: { w: string; s: number; e: number }[] };
const voTakes = readdirSync(OUT).filter((f) => /^vo-\w+\.json$/.test(f)).map((f) => JSON.parse(readFileSync(join(OUT, f), "utf8")) as { take: string; lines: Record<string, VoLine> });
const VO_GUESS: Record<string, number> = { launch: 1.5, rough: 1.1, notes: 2.6, claude: 2.0, what: 4.4, point: 2.3, ask: 1.2, three: 2.7, review: 1.8, name: 0.7, tagline: 2.3, turn: 0.8 };
/** When the line's last word ends, in the slowest take. */
const voEnd = (id: string) => (voTakes.length ? Math.max(...voTakes.map((v) => v.lines[id]?.end ?? VO_GUESS[id])) : VO_GUESS[id]);
/** When word k of the line starts, in the slowest take. */
const voWord = (id: string, k: number) => (voTakes.length ? Math.max(...voTakes.map((v) => v.lines[id]?.words[k]?.s ?? 0)) : 0);

// ---------------------------------------------------------------- inner film (genuine exports)
function decode(state: string, size: string, fps = INNER_FPS, extra = "", key = state) {
  const d = join(OUT, "frames", key);
  if (!existsSync(d) || readdirSync(d).length < 5) {
    mkdirSync(d, { recursive: true });
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(OUT, "states", `${state}.mp4`), "-vf", `${extra}fps=${fps},scale=${size}:flags=lanczos`, "-q:v", "2", join(d, "%05d.jpg")]);
  }
  const n = readdirSync(d).length;
  return { n, at: (tl: number) => join(d, `${String(Math.min(n - 1, Math.max(0, Math.floor(tl * fps + 1e-6))) + 1).padStart(5, "0")}.jpg`), frame: (k: number) => join(d, `${String(Math.min(n - 1, Math.max(0, k)) + 1).padStart(5, "0")}.jpg`) };
}
const DEC = { v1: decode("v1", "1920:1080"), v2: decode("v2", "1920:1080"), v3: decode("v3", "1080:1920"), v4b: decode("v4b", "1080:1920"), v4: decode("v4", "1080:1920") };
type Dec = (typeof DEC)["v1"];
const inner = Object.fromEntries(Object.entries(DEC).map(([k, v]) => [k, v.at])) as Record<keyof typeof DEC, (tl: number) => string>;
const dur = statesWords.duration;
const norm = (s: string) => s.toLowerCase().replace(/[^a-z']/g, "");
const wordsOf = (v: string) => (statesWords[v] ?? []) as Word[];
const V1 = wordsOf("v1"), V2 = wordsOf("v2"), V3 = wordsOf("v3"), V4 = wordsOf("v4");
const keptIdx = new Set(V2.map((w) => w.i));
const cutIdx = new Set(V1.filter((w) => !keptIdx.has(w.i)).map((w) => w.i));
const firstKept = V1.findIndex((w) => keptIdx.has(w.i));
// Freeze points, always between words.
const TL1 = firstKept > 0 ? (V1[firstKept - 1].end + V1[firstKept].start) / 2 : 2.4;
const iCutroom = V2.findIndex((w) => /cutroom|room/.test(norm(w.text)));
const TL2 = iCutroom >= 0 ? V2[iCutroom].end + 0.08 : 2.2;
const iClaude = V3.findIndex((w) => norm(w.text) === "claude");
const TL3 = iClaude >= 0 ? V3[iClaude].end + 0.04 : TL2 + 2.1;
const iFixes = V4.findIndex((w) => norm(w.text) === "fixes");
// The final pass opens on the first captioned frame ("hey,"), not on the off-lens pre-roll, which
// would read as the false start surviving; and it ends on its last line, not on a silent smile.
const FINAL_IN = V4.length ? Math.ceil(V4[0].start * INNER_FPS - 1e-6) / INNER_FPS : 0;
const FINAL_LEN = (iFixes >= 0 ? Math.min(dur.v4 ?? 7, (V4[iFixes + 1] ?? V4[iFixes]).end + 0.7) : (dur.v4 ?? 6)) - FINAL_IN;
// The rewind gets motion-interpolated frames so a fast backwards scrub reads as motion, not as ghosts.
const RW_FPS = 120;
const v1Rewind = decode("v1", "1920:1080", RW_FPS, `trim=0:${(TL1 + 0.3).toFixed(2)},minterpolate=fps=${RW_FPS}:mi_mode=mci:mc_mode=aobmc:me_mode=bidir:vsbmc=1,`, `v1-rw-${TL1.toFixed(2)}`);

// ---------------------------------------------------------------- timeline (sequential, adapted to the take and the reads)
const ZOOM_LEN = 0.6; // the flight through the mark's counter into the take
const EXIT_LEN = 2.8; // the end card dissolves to its waiting dot, which is cut back into the mark
const T = (() => {
  const t: Record<string, number> = {};
  let at = 0;
  const mark = (k: string, d = 0) => ((t[k] = at), (at += d));
  // entry: a note pin lands on black, a lime cut makes it the cutroom mark, the camera flies through
  mark("entry");
  t.pinIn = 0.2; t.cutMark = 0.85; t.zoom = 1.55;
  at = t.zoom;
  // cold open: the rough cut plays from its first frame, sound and all, and pauses after the stammer
  mark("cold");
  at += TL1;
  mark("pause1");
  t.voLaunch = at + 0.3;
  t.voRough = t.voLaunch + voEnd("launch") + 0.25;
  at = t.voRough + 0.2;
  // note 1: the cursor comes in as the narrator calls it a rough cut, drags across the stammer, types the note
  mark("poster");
  t.dragStart = at + 0.5; t.dragEnd = t.dragStart + 0.55; t.noteOpen = t.dragEnd + 0.1;
  t.voNotes = Math.max(t.voRough + voEnd("rough") + 0.2, t.dragStart - 0.3);
  t.noteSend = Math.max(t.noteOpen + 0.85, t.voNotes + voEnd("notes") + 0.1);
  at = t.noteSend + 0.2;
  mark("turn1"); t.wait1 = at + 0.05; t.working1 = at + 0.6; t.edit1 = at + 1.4; t.strike1 = at + 1.75; t.fold1 = at + 1.95; t.resolved1 = at + 2.4;
  at += 3.3;
  mark("rewind", 1.0);
  mark("pass2"); t.badge = at + 0.1;
  at += Math.max(1.6, TL2);
  mark("freeze2");
  t.voClaude = at + 0.2;
  t.claude = t.voClaude + voWord("claude", 2) - 0.05;
  t.voWhat = t.voClaude + voEnd("claude") + 0.25;
  t.claude2 = t.voWhat - 0.05; t.claude3 = t.voWhat + voWord("what", 4) - 0.05;
  t.copyLeave = t.voWhat + voEnd("what") + 0.45;
  at = t.copyLeave + 0.25;
  mark("box"); t.boxDown = at + 0.55; t.boxUp = at + 1.3; t.note2Open = at + 1.45;
  t.voPoint = t.boxDown - 0.1;
  t.note2Send = Math.max(at + 2.4, t.voPoint + voEnd("point") + 0.1);
  at = t.note2Send + 0.1;
  mark("turn2"); t.wait2 = at + 0.05; t.working2 = at + 0.55; t.edit2 = at + 1.55;
  at += 2.0;
  mark("fold"); t.glide = at + 0.65; t.glideEnd = at + 2.15; t.resolved2 = at + 2.2;
  at += 2.3;
  mark("pass3");
  at += Math.max(1.4, TL3 - TL2);
  mark("freeze3"); t.cursorUp = at - 0.25; t.cmdK = at + 0.05; t.palette = at + 0.1; t.voAsk = at + 0.2; t.askSend = at + 1.95; t.cursorOut = at + 2.1;
  at += 2.1;
  mark("turn3"); t.wait3 = at + 0.1; t.working3 = at + 0.7; t.edit3a = at + 1.4; t.edit3b = at + 1.9;
  at += 2.4;
  mark("still", 0.5);
  mark("bloom"); t.liftFrom = at + 0.5; t.liftEnd = at + 1.75; t.resolved3 = at + 2.05;
  at += 2.7;
  mark("snap", 0.45);
  mark("final", FINAL_LEN);
  mark("finalEnd", 0.15);
  mark("reveal"); t.voThree = at + 1.5;
  at += Math.max(4.2, 1.5 + voEnd("three") + 0.6);
  // review: the push-in and its line, then Before (the stammer, heard again), then After
  mark("review"); t.voReview = at + 0.15;
  t.reviewPre = Math.max(0.4, 0.15 + voEnd("review") + 0.2);
  const bc = ev["before-click"] ?? 0, ac = ev["after-click"] ?? bc + 2;
  at += Math.max(4.2, t.reviewPre + (ac - bc) + 1.2);
  // the end card says its name and its line, then hands it to you
  mark("end"); t.voName = at + 0.7; t.tagIn = t.voName + voEnd("name") + 0.25; t.voTagline = t.tagIn;
  t.waitIn = t.tagIn + 1.0; t.pillIn = t.waitIn + 0.5; t.footIn = t.pillIn + 0.3;
  t.voTurn = Math.max(t.pillIn + 0.4, t.voTagline + voEnd("tagline") + 0.2);
  at = t.voTurn + voEnd("turn") + 0.6;
  mark("exit", EXIT_LEN);
  mark("filmEnd");
  return t;
})();
const DUR = T.filmEnd;
const REVIEW_C0 = (ev["before-click"] ?? 0) - T.reviewPre;

// ---------------------------------------------------------------- canvas + helpers
const canvas = createCanvas(W, H);
const x = canvas.getContext("2d") as SKRSContext2D;
const icon = await loadImage("assets/brand/icon-1024.png");
bindPremium(x, { sans: "SF", mono: "SFMono", icon });
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const inOut = (u: number) => (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * clamp(u) + 2, 3) / 2);
const prog = (t: number, a: number, d: number) => clamp((t - a) / d);
const spacing = (px: number) => ((x as unknown as { letterSpacing: string }).letterSpacing = `${px}px`);
const imgCache = new Map<string, Image>();
async function img(path: string) {
  let i = imgCache.get(path);
  if (!i) {
    i = await loadImage(readFileSync(path));
    if (imgCache.size > 32) imgCache.delete(imgCache.keys().next().value!);
    imgCache.set(path, i);
  }
  return i;
}
const thumbs = await Promise.all(story.map(async (s) => (s.thumb ? loadImage(Buffer.from(s.thumb, "base64")) : null)));
function rrect(px: number, py: number, w: number, h: number, r: number) {
  x.beginPath();
  x.roundRect(px, py, w, h, r);
}
function mono(size: number, weight = 500) {
  x.font = `${weight} ${size}px SFMono`;
}
function cursor(px: number, py: number, s = 1.5, alpha = 1) {
  if (alpha <= 0) return;
  x.save();
  x.globalAlpha = alpha;
  x.translate(px, py);
  x.scale(s, s);
  x.shadowColor = "rgba(0,0,0,0.45)";
  x.shadowBlur = 8;
  x.shadowOffsetY = 2;
  x.beginPath();
  x.moveTo(0, 0); x.lineTo(0, 19); x.lineTo(5, 14.5); x.lineTo(8.5, 22); x.lineTo(11.6, 20.6); x.lineTo(8.2, 13.3); x.lineTo(15, 13.3); x.closePath();
  x.fillStyle = "#fff";
  x.fill();
  x.shadowColor = "transparent";
  x.lineWidth = 1.2;
  x.strokeStyle = "#111";
  x.lineJoin = "round";
  x.stroke();
  x.restore();
}
/** A cutroom note pin: coral while open, a turning ring while Claude works, lime once resolved. */
function pin(px: number, py: number, n: number, t: number, o: { working?: [number, number]; resolvedAt?: number; alpha?: number; scale?: number; frozen?: [number, number] }) {
  const a = o.alpha ?? 1;
  if (a <= 0) return;
  const done = o.resolvedAt !== undefined && t >= o.resolvedAt;
  const s = o.scale ?? 1;
  x.save();
  x.globalAlpha = a;
  x.translate(px, py);
  x.scale(s, s);
  if (o.working && t >= o.working[0] && !done) {
    // the ring holds still through the film's moment of stillness
    let tt = t;
    if (o.frozen) tt = t < o.frozen[0] ? t : t < o.frozen[1] ? o.frozen[0] : t - (o.frozen[1] - o.frozen[0]);
    const ang = (tt - o.working[0]) * 0.6 * Math.PI * 2;
    x.strokeStyle = CORAL;
    x.lineWidth = 3;
    x.beginPath();
    x.arc(0, 0, 24, ang, ang + Math.PI * 1.3);
    x.stroke();
  }
  if (done) {
    const p = prog(t, o.resolvedAt!, 0.6);
    if (p < 1) {
      x.strokeStyle = `rgba(232,244,124,${0.9 * (1 - p)})`;
      x.lineWidth = 2;
      x.beginPath();
      x.arc(0, 0, 17 + p * 16, 0, Math.PI * 2);
      x.stroke();
    }
  }
  x.beginPath();
  x.arc(0, 0, 17, 0, Math.PI * 2);
  x.fillStyle = done ? LIME : CORAL;
  x.fill();
  x.fillStyle = done ? "#141210" : "#fff";
  x.font = "700 18px Inter";
  const label = String(n);
  x.fillText(label, -x.measureText(label).width / 2, 6.5);
  x.restore();
}
function wrapText(text: string, maxW: number) {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let cur = "";
    for (const w of para.split(" ")) {
      const nx = cur ? `${cur} ${w}` : w;
      if (cur && x.measureText(nx).width > maxW) {
        out.push(cur);
        cur = w;
      } else cur = nx;
    }
    if (cur) out.push(cur);
  }
  return out;
}
/**
 * The note as the person wrote it, at feed size, then Claude's reply in the same place: a coral
 * dot and "YOU" for the note, a lime dot (and "CLAUDE", once the film has named it) for the reply.
 * (ax, ay) is the card's anchor; `side` says which way it grows from there.
 */
function noteCard(ax: number, ay: number, n: number, t: number, o: { note: string; reply: string; openAt: number; replyAt: number; signed: boolean; working?: [number, number]; side: "left" | "right"; vAlign?: "bottom" | "middle"; maxW: number; noteMaxW?: number; alpha?: number; frozen?: [number, number] }) {
  const a = o.alpha ?? 1;
  const inU = expo(prog(t, o.openAt, 0.45));
  if (a <= 0 || inU <= 0) return null;
  const swap = inOut(prog(t, o.replyAt, 0.45));
  const draw = (text: string, reply: boolean, alpha: number, blur: number) => {
    if (alpha <= 0.002) return null;
    x.save();
    x.font = "600 46px SF";
    spacing(-0.6);
    const lines = wrapText(reply ? text : `“${text}”`, reply ? o.maxW : (o.noteMaxW ?? o.maxW));
    const tw = Math.max(...lines.map((l) => x.measureText(l).width));
    const label = reply ? (o.signed ? "Claude" : "") : "you";
    const top = label ? 40 : 0;
    const w = tw + 92, h = lines.length * 56 + 38 + top;
    const left = o.side === "left" ? ax - w : ax;
    const tp = o.vAlign === "middle" ? ay - h / 2 : ay - h;
    x.globalAlpha = a * alpha;
    if (blur > 0.3) x.filter = `blur(${blur.toFixed(1)}px)`;
    x.shadowColor = "rgba(0,0,0,0.45)";
    x.shadowBlur = 40;
    x.shadowOffsetY = 12;
    rrect(left, tp, w, h, 24);
    x.fillStyle = "rgba(14,13,12,0.86)";
    x.fill();
    x.shadowColor = "transparent";
    x.strokeStyle = reply ? "rgba(232,244,124,0.30)" : "rgba(255,95,79,0.45)";
    x.lineWidth = 1.5;
    x.stroke();
    if (label) {
      mono(22);
      spacing(1);
      x.fillStyle = reply ? LIME : "#c9a49d";
      x.fillText(label.toUpperCase(), left + 62, tp + 44);
      x.font = "600 46px SF";
      spacing(-0.6);
    }
    x.fillStyle = reply ? LIME : CORAL;
    x.beginPath();
    x.arc(left + 34, tp + top + 46, 8, 0, Math.PI * 2);
    x.fill();
    x.fillStyle = BONE;
    lines.forEach((l, k) => x.fillText(l, left + 62, tp + top + 62 + k * 56));
    spacing(0);
    x.restore();
    return { left, top: tp, w, h };
  };
  const g1 = draw(o.note, false, inU * (1 - swap), swap * 8);
  const g2 = swap > 0 ? draw(o.reply, true, swap, (1 - swap) * 8) : null;
  const g = g2 ?? g1;
  if (g) pin(o.side === "left" ? g.left + g.w : g.left, g.top, n, t, { working: o.working, resolvedAt: o.replyAt, alpha: a * inU, frozen: o.frozen });
  return g;
}
const fmtTC = (s: number) => `00:00:${String(Math.floor(Math.max(0, s))).padStart(2, "0")}:${String(Math.floor((Math.max(0, s) % 1) * 24)).padStart(2, "0")}`;
const fmtDur = (s: number) => `0:${(Math.round(s * 10) / 10).toFixed(1).padStart(4, "0")}`;

// Film grain over every frame: texture, and it dithers the gradients.
const grain = createCanvas(256, 256);
{
  const g = grain.getContext("2d");
  const d = g.createImageData(256, 256);
  let seed = 7;
  for (let i = 0; i < d.data.length; i += 4) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const v = 128 + (seed / 4294967296 - 0.5) * 90;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = v;
    d.data[i + 3] = 255;
  }
  g.putImageData(d, 0, 0);
}
function finish(t: number) {
  x.save();
  x.globalAlpha = 0.045;
  x.globalCompositeOperation = "overlay";
  const ox = Math.floor(((t * 977) % 1) * 256), oy = Math.floor(((t * 613) % 1) * 256);
  for (let gx = -ox; gx < W; gx += 256) for (let gy = -oy; gy < H; gy += 256) x.drawImage(grain, gx, gy);
  x.restore();
}

// ---------------------------------------------------------------- living stills
/** A paused frame that still breathes: it drifts slowly back over the last few frames before the
 *  pause and returns, blending neighbouring frames so the motion stays smooth. */
async function drawLiving(dec: Dec, tlF: number, since: number, dest: Box, amp = 0.2) {
  const tl = tlF - amp * (1 - Math.cos(Math.max(0, since) * 0.42)) * 0.5;
  const f = Math.max(0, tl * INNER_FPS);
  const k = Math.floor(f), frac = f - k;
  x.drawImage(await img(dec.frame(k)), dest.x, dest.y, dest.width, dest.height);
  if (frac > 0.02) {
    x.save();
    x.globalAlpha = frac;
    x.drawImage(await img(dec.frame(k + 1)), dest.x, dest.y, dest.width, dest.height);
    x.restore();
  }
}
const FULL: Box = { x: 0, y: 0, width: W, height: H };

// ---------------------------------------------------------------- transcript line
function layoutLine(words: Word[], size: number, cx: number, collapse?: { idx: Set<number>; u: number }) {
  mono(size);
  spacing(0);
  const space = x.measureText(" ").width;
  const items = words.map((w) => ({ w, width: x.measureText(w.text).width }));
  const shown = (it: (typeof items)[number]) => (collapse?.idx.has(it.w.i) ? it.width * (1 - collapse.u) : it.width);
  const gap = (it: (typeof items)[number]) => (collapse?.idx.has(it.w.i) ? space * (1 - collapse.u) : space);
  const total = items.reduce((a, it) => a + shown(it) + gap(it), 0) - space;
  let px = cx - total / 2;
  return items.map((it) => {
    const box = { w: it.w, x: px, width: it.width, shown: shown(it) };
    px += shown(it) + gap(it);
    return box;
  });
}
type LineBox = ReturnType<typeof layoutLine>[number];
const bandC = createCanvas(2400, 200), bandX = bandC.getContext("2d") as SKRSContext2D;
function drawLine(boxes: LineBox[], y: number, size: number, tl: number, o: { alpha?: number; strike?: { idx: Set<number>; u: number }; fade?: { idx: Set<number>; u: number }; select?: { idx: Set<number>; u: number; a?: number } } = {}) {
  const a = o.alpha ?? 1;
  if (a <= 0) return;
  mono(size);
  x.save();
  x.globalAlpha = a;
  // a soft band behind the line keeps it legible over any picture; it feathers out at both ends
  if (boxes.length) {
    const l0 = boxes[0].x, l1 = boxes[boxes.length - 1].x + boxes[boxes.length - 1].shown;
    const bw = Math.min(bandC.width, Math.ceil(l1 - l0 + 240)), bh = Math.ceil(size * 2.5);
    bandX.globalCompositeOperation = "source-over";
    bandX.clearRect(0, 0, bandC.width, bandC.height);
    const g = bandX.createLinearGradient(0, 0, 0, bh);
    g.addColorStop(0, "rgba(6,6,7,0)");
    g.addColorStop(0.5, "rgba(6,6,7,0.42)");
    g.addColorStop(1, "rgba(6,6,7,0)");
    bandX.fillStyle = g;
    bandX.fillRect(0, 0, bw, bh);
    bandX.globalCompositeOperation = "destination-in";
    const f = bandX.createLinearGradient(0, 0, bw, 0), e = Math.min(0.45, 120 / bw);
    f.addColorStop(0, "rgba(0,0,0,0)");
    f.addColorStop(e, "rgba(0,0,0,1)");
    f.addColorStop(1 - e, "rgba(0,0,0,1)");
    f.addColorStop(1, "rgba(0,0,0,0)");
    bandX.fillStyle = f;
    bandX.fillRect(0, 0, bw, bh);
    x.drawImage(bandC, 0, 0, bw, bh, l0 - 120, y - size * 1.6, bw, bh);
  }
  if (o.select && o.select.u > 0) {
    const sel = boxes.filter((b) => o.select!.idx.has(b.w.i));
    if (sel.length) {
      const x0 = sel[0].x - 8, x1 = sel[sel.length - 1].x + sel[sel.length - 1].width + 8;
      x.fillStyle = `rgba(255,95,79,${(0.42 * (o.select.a ?? 1)).toFixed(3)})`;
      rrect(x0, y - size * 0.95, (x1 - x0) * o.select.u, size * 1.3, 5);
      x.fill();
    }
  }
  for (const b of boxes) {
    const fading = o.fade?.idx.has(b.w.i) ? o.fade.u : 0;
    if (fading >= 1) continue;
    x.save();
    x.globalAlpha = a * (1 - fading);
    if (fading > 0.02) x.filter = `blur(${(fading * 6).toFixed(1)}px)`;
    x.fillStyle = b.w.start <= tl ? BONE : GREY;
    if (fading > 0 && b.shown < b.width) {
      x.beginPath();
      x.rect(b.x, y - size * 1.1, b.shown, size * 1.5);
      x.clip();
    }
    x.fillText(b.w.text, b.x, y);
    x.restore();
    if (o.strike?.idx.has(b.w.i) && o.strike.u > 0 && fading < 1) {
      x.fillStyle = CORAL;
      x.globalAlpha = a * (1 - fading);
      x.fillRect(b.x, y - size * 0.32, b.shown * clamp(o.strike.u * 1.05), 3);
      x.globalAlpha = a;
    }
  }
  x.restore();
}

// ---------------------------------------------------------------- HUD (burn-in style)
type HudState = { version: string; aspect: string; durS: number; tl: number; paused: boolean; final?: boolean };
function burn(text: string, px: number, py: number, size: number, alpha: number, color = "#fff", align: "left" | "right" = "left") {
  mono(size);
  spacing(1.5);
  const w = x.measureText(text).width;
  const left = align === "right" ? px - w : px;
  x.save();
  x.globalAlpha = alpha * 0.55;
  x.fillStyle = "rgba(0,0,0,0.6)";
  rrect(left - 12, py - size - 4, w + 24, size + 16, 6);
  x.fill();
  x.globalAlpha = alpha;
  x.fillStyle = color;
  x.fillText(text, left, py);
  x.restore();
  spacing(0);
  return w;
}
/** A transport burn-in: a play triangle or two pause bars (no font has a pause glyph we can trust), then the text. */
function burnTransport(paused: boolean, text: string, right: number, py: number, size: number, alpha: number) {
  const iw = size * 0.62, gap = text ? size * 0.45 : 0;
  mono(size);
  spacing(1.5);
  const tw = text ? x.measureText(text).width : 0;
  const left = right - tw - gap - iw;
  x.save();
  x.globalAlpha = alpha * 0.55;
  x.fillStyle = "rgba(0,0,0,0.6)";
  rrect(left - 12, py - size - 4, iw + gap + tw + 24, size + 16, 6);
  x.fill();
  x.globalAlpha = alpha;
  x.fillStyle = "#fff";
  const top = py - size * 0.78, h = size * 0.78;
  if (paused) {
    x.fillRect(left, top, iw * 0.34, h);
    x.fillRect(left + iw * 0.66, top, iw * 0.34, h);
  } else {
    x.beginPath();
    x.moveTo(left, top);
    x.lineTo(left + iw, top + h / 2);
    x.lineTo(left, top + h);
    x.closePath();
    x.fill();
  }
  if (text) x.fillText(text, left + iw + gap, py);
  x.restore();
  spacing(0);
}
const mixHex = (a: string, b: string, u: number) => {
  const p = (h: string, k: number) => parseInt(h.slice(1 + 2 * k, 3 + 2 * k), 16);
  return `rgb(${[0, 1, 2].map((k) => Math.round(lerp(p(a, k), p(b, k), clamp(u)))).join(",")})`;
};
function hudFull(s: HudState, alpha = 1, hot = 0) {
  if (alpha <= 0) return;
  const slug = s.final ? "LAUNCH FILM · FINAL" : `ROUGH CUT ${s.version} · ${s.aspect} · ${fmtDur(s.durS)}`;
  burn(slug, 52, 70, 28, alpha * (0.9 + 0.1 * hot), hot > 0.01 ? mixHex("#ffffff", LIME, hot) : "#fff");
  if (!s.final) burnTransport(s.paused, fmtTC(s.tl), W - 52, 70, 28, alpha * 0.8);
}
function hudColumn(t: number, s: HudState, col: Box, alpha = 1, flashAspectAt?: number) {
  if (alpha <= 0) return;
  const flash = flashAspectAt !== undefined && t >= flashAspectAt && t < flashAspectAt + 0.5;
  const slug = s.final ? "LAUNCH FILM · FINAL" : `ROUGH CUT ${s.version} · ${s.aspect}`;
  burn(slug, col.x, col.y - 22, 22, alpha * 0.85, flash ? LIME : "#fff");
  if (!s.final) burnTransport(s.paused, "", col.x + col.width, col.y - 22, 22, alpha * 0.75);
}

// ---------------------------------------------------------------- Claude's log (a glass card, real calls)
const LOGCARD: Box = { x: 1290, y: 118, width: 590, height: 600 };
const glass = createCanvas(LOGCARD.width, LOGCARD.height), glassX = glass.getContext("2d") as SKRSContext2D;
type Entry = { at: number; head: string; body?: string[]; thumb?: Image | null; ok?: boolean };
function entries(beat: number): Entry[] {
  const s = story[beat], n = beat + 1;
  const at = [
    [T.wait1, T.working1, T.edit1, T.resolved1],
    [T.wait2, T.working2, T.edit2, T.resolved2],
    [T.wait3, T.working3, T.edit3a, T.resolved3],
  ][beat];
  return [
    { at: at[0], head: "wait_for_feedback", body: [`#${n} “${s.note}”`], thumb: thumbs[beat] },
    { at: at[1], head: "update_feedback", body: [`#${n} → working`] },
    { at: at[2], head: "edit", body: s.ops },
    { at: at[3], head: "update_feedback", body: [`#${n} → resolved`], ok: true },
  ];
}
const beatAt = (t: number) => (t >= T.wait3 - 0.01 ? 2 : t >= T.wait2 - 0.01 ? 1 : 0);
function drawLogCard(t: number, alpha: number, o: { dim?: number; rect?: Box } = {}) {
  if (alpha <= 0.002) return;
  const r = o.rect ?? LOGCARD;
  const k = r.width / LOGCARD.width;
  // frosted glass: the picture behind, blurred, under a dark tint
  glassX.clearRect(0, 0, glass.width, glass.height);
  glassX.filter = "blur(26px)";
  glassX.drawImage(canvas, r.x, r.y, r.width, r.height, -20, -20, glass.width + 40, glass.height + 40);
  glassX.filter = "none";
  x.save();
  x.globalAlpha = alpha;
  x.shadowColor = "rgba(0,0,0,0.5)";
  x.shadowBlur = 50;
  x.shadowOffsetY = 16;
  rrect(r.x, r.y, r.width, r.height, 22 * k);
  x.fillStyle = "rgba(10,10,11,0.5)";
  x.fill();
  x.shadowColor = "transparent";
  x.save();
  rrect(r.x, r.y, r.width, r.height, 22 * k);
  x.clip();
  x.drawImage(glass, r.x, r.y, r.width, r.height);
  x.fillStyle = "rgba(10,10,11,0.66)";
  x.fillRect(r.x, r.y, r.width, r.height);
  x.translate(r.x, r.y);
  x.scale(k, k);
  // header: "OVER MCP" from the start; "Claude" once the film names the agent
  const named = expo(prog(t, T.claude2, 0.8));
  mono(20);
  spacing(2);
  x.fillStyle = "rgba(255,255,255,0.45)";
  x.fillText("OVER MCP", 36, 48);
  spacing(0);
  x.fillStyle = `rgba(232,244,124,${0.6 + 0.4 * Math.sin(t * 3)})`;
  x.beginPath();
  x.arc(LOGCARD.width - 40, 42, 6, 0, Math.PI * 2);
  x.fill();
  if (named > 0) {
    x.save();
    x.globalAlpha = alpha * named;
    x.font = "600 32px SF";
    x.fillStyle = BONE;
    x.fillText("Claude", 36, 92);
    x.restore();
  }
  x.fillStyle = "rgba(255,255,255,0.08)";
  x.fillRect(36, 116, LOGCARD.width - 72, 1.5);
  // the current beat's calls; earlier beats collapse to one dim receipt each. The list scrolls so
  // the newest call's last line always clears the bottom edge; older lines fade under the divider.
  const beat = beatAt(t);
  const ents = entries(beat);
  const viewH = r.height / k;
  const TOP = 120, FADE = 32, PAD = 28;
  mono(22);
  const hOf = (e: Entry) => 34 + (e.body ?? []).reduce((sum, b) => sum + wrapText(b, LOGCARD.width - 110).length * 30, 0) + (e.thumb ? 90 : 0) + 14;
  let bottom = 162 + beat * 36 + (beat ? 10 : 0);
  for (const e of ents) bottom += hOf(e) * expo(prog(t, e.at, 0.5));
  const scroll = Math.max(0, bottom - 36 + PAD - viewH);
  const fadeAt = (inkTop: number) => clamp((inkTop - scroll - TOP) / FADE);
  x.save();
  x.beginPath();
  x.rect(0, TOP, LOGCARD.width, viewH - TOP);
  x.clip();
  x.translate(0, -scroll);
  let y = 162;
  for (let b = 0; b < beat; b++) {
    mono(21);
    x.globalAlpha = alpha * fadeAt(y - 16);
    x.fillStyle = "rgba(232,244,124,0.5)";
    x.fillText(`✓ #${b + 1}  ${story[b].reply}`.slice(0, 44), 36, y);
    y += 36;
  }
  if (beat) y += 10;
  for (const e of ents) {
    const u = expo(prog(t, e.at, 0.5));
    if (u <= 0) continue;
    x.save();
    const a0 = alpha * u * (o.dim ?? 1);
    if (u < 1) x.filter = `blur(${((1 - u) * 8).toFixed(1)}px)`;
    const dy = (1 - u) * 10;
    mono(24, 600);
    x.globalAlpha = a0 * fadeAt(y + dy - 18);
    x.fillStyle = e.ok ? LIME : CORAL;
    x.fillText(e.ok ? "✓" : "→", 36, y + dy);
    x.fillStyle = e.ok ? LIME : "#fff";
    x.fillText(e.head, 66, y + dy);
    y += 34;
    mono(22);
    x.fillStyle = e.ok ? "rgba(232,244,124,0.85)" : SOFT;
    for (const b of e.body ?? []) {
      for (const l of wrapText(b, LOGCARD.width - 110)) {
        x.globalAlpha = a0 * fadeAt(y + dy - 16);
        x.fillText(l, 66, y + dy);
        y += 30;
      }
    }
    if (e.thumb) {
      const tw = 150, th = 84;
      x.globalAlpha = a0 * fadeAt(y - 12 + dy + 30);
      x.save();
      rrect(66, y - 12 + dy, tw, th, 8);
      x.clip();
      x.drawImage(e.thumb, 66, y - 12 + dy, tw, th);
      x.restore();
      x.strokeStyle = "rgba(255,255,255,0.18)";
      x.lineWidth = 1;
      rrect(66, y - 12 + dy, tw, th, 8);
      x.stroke();
      y += th + 6;
    }
    y += 14;
    x.restore();
  }
  x.restore();
  x.restore();
  x.strokeStyle = "rgba(255,255,255,0.12)";
  x.lineWidth = 1.2;
  rrect(r.x, r.y, r.width, r.height, 22 * k);
  x.stroke();
  x.restore();
}

// ---------------------------------------------------------------- capture crops (the real composer and palette, 2× pixels)
async function capCrop(c: number, r: Box, dx: number, dy: number, scale: number, alpha = 1, unfold = 1) {
  if (alpha <= 0 || !r) return;
  const frame = await img(capFile(c));
  const k = frame.width / 1440;
  x.save();
  x.globalAlpha = alpha;
  const w = r.width * scale, h = r.height * scale;
  x.translate(dx, dy + h / 2);
  x.scale(1, unfold);
  x.translate(0, -h / 2);
  x.shadowColor = "rgba(0,0,0,0.55)";
  x.shadowBlur = 40;
  x.shadowOffsetY = 14;
  rrect(0, 0, w, h, 14 * scale);
  x.fillStyle = "#141210";
  x.fill();
  x.shadowColor = "transparent";
  rrect(0, 0, w, h, 14 * scale);
  x.clip();
  x.imageSmoothingQuality = "high";
  x.drawImage(frame, r.x * k, r.y * k, r.width * k, r.height * k, 0, 0, w, h);
  x.restore();
}

// ---------------------------------------------------------------- geometry
const focus = (v3snap.clips?.[0]?.focus ?? v3snap.focus ?? { x: 0.5, y: 0.5 }) as { x: number; y: number };
const crop = computeCrop(1920, 1080, 1080, 1920, 1, focus);
const CROP: Box = { x: (crop.x / crop.width) * W, y: 0, width: (1080 / crop.width) * W, height: H };
// While Claude works the Short sits left of its log; the final pass centres it, larger.
const COL: Box = { x: 560, y: 72, width: 472.5, height: 840 };
const COLF: Box = { x: (W - 540) / 2, y: 60, width: 540, height: 960 };
const COLCX = COL.x + COL.width / 2;
const PAL_SCALE = 2.3, PAL_Y = COL.y + 200; // the whole palette, its query row at ~35 px on canvas
const region2 = story[1].region ?? { x: CROP.x / W, y: 0, w: CROP.width / W, h: 1 };
// The note's region is the full-height crop; the gesture is drawn inset so its corners and the drag read
// (also on a phone); the fold then opens it out onto cutroom's real full-height crop.
const BOX_TOP = 120, BOX_BOT = 940;
const BOX: Box = { x: region2.x * W, y: Math.max(region2.y * H, BOX_TOP), width: region2.w * W, height: Math.min((region2.y + region2.h) * H, BOX_BOT) - Math.max(region2.y * H, BOX_TOP) };
const lerpBox = (a: Box, b: Box, u: number): Box => ({ x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), width: lerp(a.width, b.width, u), height: lerp(a.height, b.height, u) });

// Caption word boxes for the lift (where the burned-in words sit in the v4 export).
type CapWord = { text: string; displayText: string; x: number; y: number; w: number; h: number; fontSize: number; isActive: boolean };
let capWords: CapWord[] = [];
let renderCapWord: ((ctx: SKRSContext2D, w: CapWord, o?: Record<string, unknown>) => void) | null = null;
try {
  const mod = await import("./caption-boxes.mts");
  const v4 = snap("v4");
  const transcripts: Record<string, unknown> = {};
  for (const m of v4.media ?? []) {
    const f = join(OUT, "project/.cutroom/cache", m.id, "transcript.json");
    if (existsSync(f)) transcripts[m.id] = JSON.parse(readFileSync(f, "utf8"));
  }
  capWords = mod.captionWordBoxes(v4, transcripts as never, TL3, 1080, 1920).words as unknown as CapWord[];
  renderCapWord = mod.renderCaptionWord as never;
} catch (e) {
  console.warn("caption boxes unavailable:", (e as Error).message);
}

// ---------------------------------------------------------------- act 1: the poster, note 1, Claude's first turn, the rewind, pass 2
const SEL = new Set(cutIdx);
const lineV1 = V1.slice(0, iCutroom >= 0 ? firstKept + iCutroom + 1 : 10);
const lineV2 = V2.slice(0, iCutroom >= 0 ? iCutroom + 1 : 6);
function scrimRight(alpha: number) {
  if (alpha <= 0) return;
  const g = x.createLinearGradient(980, 0, W, 0);
  g.addColorStop(0, "rgba(6,6,7,0)");
  g.addColorStop(0.4, `rgba(6,6,7,${0.38 * alpha})`);
  g.addColorStop(1, `rgba(6,6,7,${0.55 * alpha})`);
  x.fillStyle = g;
  x.fillRect(980, 0, W - 980, H);
}
// the rewind leaves from the frame the living still is showing, so it never pops forward first
const RW_FROM = TL1 - 0.25 * (1 - Math.cos((T.rewind - T.pause1) * 0.42)) * 0.5;
const rewindTl = (t: number) => RW_FROM * (1 - inOut((t - T.rewind) / (T.pass2 - T.rewind)));
const TR1 = { y: 1000, size: 46 }; // the 16:9 transcript line
async function act1(t: number) {
  // picture: the cold open plays, the stammer's end holds, the rewind runs home, pass 2 plays and holds
  if (t < T.pause1) x.drawImage(await img(inner.v1(t - T.cold)), 0, 0, W, H);
  else if (t < T.rewind) await drawLiving(DEC.v1, TL1, t - T.pause1, FULL, 0.25);
  else if (t < T.pass2) x.drawImage(await img(v1Rewind.at(rewindTl(t))), 0, 0, W, H);
  else if (t < T.freeze2) x.drawImage(await img(inner.v2(t - T.pass2)), 0, 0, W, H);
  else await drawLiving(DEC.v2, TL2, t - T.freeze2, FULL, 0.2);
  // the rewind lands behind a short eased dip that hides the pose change between the two takes
  const dipA = 0.85 * Math.sin(Math.PI * prog(t, T.pass2 - 0.05, 0.1));
  if (dipA > 0.01) {
    x.fillStyle = `rgba(0,0,0,${dipA.toFixed(3)})`;
    x.fillRect(0, 0, W, H);
  }
  const tlNow = t < T.pause1 ? Math.max(0, t - T.cold) : t < T.rewind ? TL1 : t < T.pass2 ? rewindTl(t) : Math.min(TL2, t - T.pass2);
  scrimRight(expo(prog(t, T.turn1 - 0.2, 0.8)));
  const v = t < T.pass2 ? "v1" : "v2";
  const playing = t < T.pause1 || (t >= T.rewind && t < T.freeze2);
  // the burn-ins arrive once the camera is through the mark; the slug lights up as the narrator says "rough cut"
  const hudIn = expo(prog(t, T.cold + ZOOM_LEN - 0.1, 0.5));
  const hot = Math.sin(Math.PI * prog(t, T.voRough + voWord("rough", 2) - 0.05, 0.9));
  hudFull({ version: v, aspect: "16:9", durS: v === "v1" ? dur.v1 : dur.v2, tl: tlNow, paused: !playing }, hudIn, hot);
  // the shorter take, proven, on a burn-in plate clear of Reed
  if (t >= T.badge && t < T.copyLeave + 0.3) {
    const u = expo(prog(t, T.badge, 0.6)) * (1 - prog(t, T.copyLeave - 0.2, 0.4));
    if (u > 0) {
      x.save();
      x.globalAlpha = u;
      mono(44, 600);
      spacing(1);
      const hs = (v: number) => Math.round(v * 100);
      const f2 = (v: number) => `0:${(hs(v) / 100).toFixed(2).padStart(5, "0")}`;
      const a = `${f2(dur.v1)} → ${f2(dur.v2)}`, b = `  −${((hs(dur.v1) - hs(dur.v2)) / 100).toFixed(2)} s`;
      const wa = x.measureText(a).width, wb = x.measureText(b).width, by = 905;
      rrect(52 - 18, by - 44 - 12, wa + wb + 36, 44 + 30, 10);
      x.fillStyle = "rgba(8,8,9,0.62)";
      x.fill();
      x.fillStyle = "rgba(255,255,255,0.94)";
      x.fillText(a, 52, by);
      x.fillStyle = LIME;
      x.fillText(b, 52 + wa, by);
      spacing(0);
      x.restore();
    }
  }
  if (t >= T.rewind && t < T.pass2) {
    // the rewind: a lime playhead running home and a big timecode spinning back
    x.fillStyle = LIME;
    x.fillRect(0, H - 4, (tlNow / dur.v1) * W, 3);
    const u = Math.sin(Math.PI * clamp((t - T.rewind) / (T.pass2 - T.rewind)));
    x.save();
    x.globalAlpha = u * 0.92;
    mono(84, 600);
    spacing(2);
    const tc = `◀◀ ${fmtTC(tlNow)}`;
    x.fillStyle = "#fff";
    x.shadowColor = "rgba(0,0,0,0.6)";
    x.shadowBlur = 24;
    const tw = x.measureText(tc).width;
    x.fillText(tc, Math.min(LOGCARD.x / 2, LOGCARD.x - 40 - tw / 2) - tw / 2, H / 2 + 30);
    spacing(0);
    x.restore();
  }
  // transcript: it lights up word by word as the cold open plays
  const { y, size } = TR1;
  let anchorX = W / 2 - 300;
  if (t < T.pass2) {
    const lineIn = expo(prog(t, T.cold + ZOOM_LEN - 0.1, 0.5));
    const foldU = expo(prog(t, T.fold1, 0.4));
    const boxes = layoutLine(lineV1, size, W / 2, { idx: SEL, u: foldU });
    const cu = expo(prog(t, T.dragStart, T.dragEnd - T.dragStart));
    // the selection grows with the drag and fades while the strike draws
    const selA = 1 - prog(t, T.strike1 - 0.05, 0.18);
    drawLine(boxes, y, size, tlNow, { alpha: lineIn, select: t >= T.dragStart && selA > 0 ? { idx: SEL, u: cu, a: selA } : undefined, strike: { idx: SEL, u: prog(t, T.strike1, 0.2) }, fade: { idx: SEL, u: foldU } });
    // the cursor's path is fixed in screen space from the pre-fold layout, so it never rides the fold
    const pre = layoutLine(lineV1, size, W / 2).filter((b) => SEL.has(b.w.i));
    if (pre.length && t >= T.poster) {
      const sx0 = pre[0].x, sx1 = pre[pre.length - 1].x + pre[pre.length - 1].width;
      anchorX = Math.max(60, sx0 - 10);
      const drift = expo(prog(t, T.noteSend + 0.05, 0.4));
      let cx: number, cy: number;
      if (t < T.dragStart) {
        // in from the lower right onto the first word of the stammer
        const k = expo(prog(t, T.poster, T.dragStart - T.poster - 0.05));
        cx = lerp(W * 0.62, sx0, k);
        cy = lerp(H + 40, y - 12, k);
      } else if (t < T.noteSend) {
        cx = lerp(sx0, sx1, cu);
        cy = y - 12;
      } else {
        cx = lerp(sx1, sx1 + 30, drift);
        cy = lerp(y - 12, y + 18, drift);
      }
      cursor(cx, cy, 1.5, (t < T.rewind ? 1 : 1 - prog(t, T.rewind, 0.2)) * expo(prog(t, T.poster, 0.2)));
      // the real composer (2× pixels) while typing
      if (t >= T.noteOpen && t < T.noteSend + 0.25) {
        const c = lerp((ev["select-up"] ?? 0) + 0.8, (ev["note1-send"] ?? 0) - 0.02, prog(t, T.noteOpen + 0.15, T.noteSend - T.noteOpen - 0.15));
        const r = rects.composer1, scale = 1.6;
        const out = prog(t, T.noteSend, 0.25);
        await capCrop(c, r, clamp(sx0 - 20, 40, W - r.width * scale - 40), y - size - 48 - r.height * scale, scale, 1 - out, expo(prog(t, T.noteOpen, 0.25)));
      }
    }
  } else drawLine(layoutLine(lineV2, size, W / 2), y, size, Math.min(TL2, t - T.pass2));
  // note 1 at feed size, then Claude's reply in its place
  if (t < T.rewind + 0.3) noteCard(anchorX, 930, 1, t, { note: story[0].note, reply: story[0].reply, openAt: T.noteSend, replyAt: T.resolved1, signed: false, working: [T.working1, T.resolved1], side: "right", maxW: 720, alpha: 1 - prog(t, T.rewind, 0.3) });
  drawLogCard(t, expo(prog(t, T.wait1 - 0.1, 0.5)) * (1 - 0.45 * Math.sin(Math.PI * prog(t, T.rewind - 0.1, T.pass2 - T.rewind + 0.2))));
  // naming the agent: phone-legible, and clear of the right edge whatever the font measures
  if (t >= T.pass2) {
    const l2 = "cutroom: the video editor", l3 = "Claude drives over MCP.";
    x.font = "500 54px SF";
    const lx = Math.min(LOGCARD.x, W - 64 - Math.max(x.measureText(l2).width, x.measureText(l3).width));
    line("", lx, 798, 74, t, T.claude, { align: "left", leave: T.copyLeave, runs: [{ text: "That was Claude.", color: "gradient" }] });
    line("", lx, 862, 54, t, T.claude2, { align: "left", weight: 500, leave: T.copyLeave, runs: [{ text: l2, color: "#e6e2dc" }] });
    line("", lx, 922, 54, t, T.claude3, { align: "left", weight: 500, leave: T.copyLeave, runs: [{ text: l3, color: "#e6e2dc" }] });
  }
}

// ---------------------------------------------------------------- act 2: the box, Claude's second turn, the fold into a vertical Short
// where the cursor rests while Claude works: clear of the transcript line
const CURSOR_PARK = { x: 1210, y: 880 };
async function act2(t: number) {
  const tl = TL2;
  const glideU = inOut(prog(t, T.glide, T.glideEnd - T.glide));
  const dark = inOut(prog(t, T.fold + 0.05, 0.6));
  const ease = inOut(prog(t, T.fold + 0.05, 0.45));
  const boxNow = t < T.fold ? BOX : lerpBox(BOX, CROP, ease);
  const since = t - T.freeze2;
  const du = expo(prog(t, T.boxDown + 0.05, T.boxUp - T.boxDown));
  const drawn = t < T.boxUp ? { x: BOX.x, y: BOX.y, width: BOX.width * du, height: BOX.height * du } : boxNow;
  const dim = t >= T.boxDown ? Math.max(dark, 0.45 * expo(prog(t, T.boxDown, 0.3))) : dark;
  if (t < T.glide) {
    await drawLiving(DEC.v2, TL2, since, FULL, 0.2);
    if (dim > 0) {
      x.fillStyle = `rgba(6,6,7,${dim})`;
      const b = t < T.fold ? drawn : boxNow;
      x.fillRect(0, 0, W, b.y);
      x.fillRect(0, b.y + b.height, W, H - b.y - b.height);
      x.fillRect(0, b.y, b.x, b.height);
      x.fillRect(b.x + b.width, b.y, W - b.x - b.width, b.height);
    }
  } else {
    stage(0);
    const dest = lerpBox(CROP, COL, glideU);
    x.save();
    rrect(dest.x, dest.y, dest.width, dest.height, 4);
    x.clip();
    if (t >= T.pass3) x.drawImage(await img(inner.v3(Math.min(TL3, tl + (t - T.pass3)))), dest.x, dest.y, dest.width, dest.height);
    else await drawLiving(DEC.v3, TL2, since, dest, 0.2 * (1 - prog(t, T.pass3 - 0.4, 0.4) ** 2));
    x.restore();
    x.strokeStyle = "rgba(255,240,230,0.16)";
    x.lineWidth = 1;
    x.strokeRect(dest.x + 0.5, dest.y + 0.5, dest.width - 1, dest.height - 1);
  }
  const colNow = t < T.glide ? boxNow : lerpBox(CROP, COL, glideU);
  if (t < T.glide) scrimRight(1 - dark);
  // the box: drawn, settling on release, breathing while Claude works, then easing onto cutroom's real crop window
  if (t >= T.boxDown && t < T.glide + 0.02) {
    const sc = 1 + 0.025 * Math.sin(Math.PI * prog(t, T.boxUp, 0.28));
    const b = { x: drawn.x + (drawn.width * (1 - sc)) / 2, y: drawn.y + (drawn.height * (1 - sc)) / 2, width: drawn.width * sc, height: drawn.height * sc };
    const breathe = t >= T.working2 && t < T.fold ? 0.7 + 0.3 * Math.abs(Math.sin((t - T.working2) * Math.PI * 1.667)) : 1;
    const bright = t >= T.fold && t < T.fold + 2 / FPS;
    x.save();
    x.globalAlpha = breathe;
    x.fillStyle = `rgba(255,95,79,${bright ? 0.1 : 0.06 * (1 - ease)})`;
    x.fillRect(b.x, b.y, b.width, b.height);
    x.strokeStyle = ease > 0 ? `rgba(255,${Math.round(lerp(95, 240, ease))},${Math.round(lerp(79, 230, ease))},${lerp(1, 0.16, ease)})` : CORAL;
    x.lineWidth = lerp(5, 1, ease);
    x.shadowColor = `rgba(0,0,0,${0.35 * (1 - ease)})`;
    x.shadowBlur = 10;
    rrect(b.x, b.y, b.width, b.height, 6 * (1 - ease));
    x.stroke();
    x.shadowColor = "transparent";
    const ha = prog(t, T.boxUp - 0.05, 0.15) * (1 - clamp(ease * 2));
    if (ha > 0) {
      const hs = 14;
      x.globalAlpha = breathe * ha;
      x.fillStyle = "#fff";
      x.strokeStyle = CORAL;
      x.lineWidth = 3;
      for (const [hx, hy] of [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]) {
        x.fillRect(hx - hs / 2, hy - hs / 2, hs, hs);
        x.strokeRect(hx - hs / 2, hy - hs / 2, hs, hs);
      }
    }
    x.restore();
  }
  // HUD: the 16:9 burn-ins fade as the picture leaves, the column's arrive with it
  hudFull({ version: "v2", aspect: "16:9", durS: dur.v2, tl, paused: true }, 1 - Math.max(dark, inOut(clamp(glideU * 2))));
  const colState: HudState = { version: t < T.resolved2 ? "v2" : "v3", aspect: t < T.resolved2 ? "16:9" : "9:16", durS: dur.v3, tl: t >= T.pass3 ? Math.min(TL3, tl + (t - T.pass3)) : tl, paused: t < T.pass3 };
  if (t >= T.glide) hudColumn(t, colState, colNow, inOut(clamp((glideU - 0.5) * 2)), T.resolved2);
  // transcript: the 16:9 line goes with the dark; the column's comes with the glide
  drawLine(layoutLine(lineV2, TR1.size, W / 2), TR1.y, TR1.size, tl, { alpha: 1 - dark });
  if (t >= T.glide) drawColumnTranscript(colState.tl, inOut(clamp((glideU - 0.4) / 0.6)), colNow.x + colNow.width / 2, colNow);
  // the real composer for note 2 while typing, then the note at feed size beside the box, then Claude's reply
  if (t >= T.note2Open && t < T.note2Send + 0.25) {
    const c = lerp((ev["box-up"] ?? 0) + 0.45, (ev["note2-send"] ?? 0) - 0.02, prog(t, T.note2Open + 0.15, T.note2Send - T.note2Open - 0.15));
    const r = rects.composer2, scale = 1.6;
    const out = prog(t, T.note2Send, 0.25);
    await capCrop(c, r, Math.max(40, BOX.x - r.width * scale - 30), BOX.y + 280, scale, 1 - out, expo(prog(t, T.note2Open, 0.25)));
  }
  noteCard(colNow.x - 32, colNow.y + colNow.height * 0.42, 2, t, { note: story[1].note, reply: story[1].reply, openAt: T.note2Send, replyAt: T.resolved2, signed: true, working: [T.working2, T.resolved2], side: "left", vAlign: "middle", maxW: Math.max(300, Math.min(460, COL.x - 140)), noteMaxW: Math.max(300, Math.min(460, BOX.x - 140)) });
  // cursor: enters, drags the box, lets go and rests at the right
  const curIn = expo(prog(t, T.box, 0.6));
  let cx = lerp(W + 40, BOX.x, curIn), cy = lerp(H * 0.7, BOX.y + 2, curIn);
  if (t >= T.boxDown) {
    const du = expo(prog(t, T.boxDown + 0.05, T.boxUp - T.boxDown));
    cx = BOX.x + BOX.width * du;
    cy = BOX.y + 2 + (BOX.height - 6) * du;
  }
  if (t >= T.note2Send) {
    const park = expo(prog(t, T.note2Send, 0.8));
    cx = lerp(BOX.x + BOX.width, CURSOR_PARK.x, park);
    cy = lerp(BOX.y + BOX.height - 4, CURSOR_PARK.y, park);
  }
  cursor(cx, cy, 1.5, curIn * (t >= T.glide ? 1 - prog(t, T.glide, 0.4) : 1));
  drawLogCard(t, 1);
}
/** The words around the playhead, in two lines under the 9:16 column. */
function columnLines() {
  const rest = V3.filter((w) => w.start >= TL2 - 0.05);
  const mid = Math.ceil(rest.length / 2);
  return [rest.slice(0, mid), rest.slice(mid)];
}
function drawColumnTranscript(tl: number, alpha: number, cx = COLCX, col: Box = COL, liftU = 0) {
  const [a, b] = columnLines();
  const size = 30, y0 = col.y + col.height + 44;
  drawLine(layoutLine(a, size, cx), y0, size, tl, { alpha: alpha * (1 - liftU) });
  drawLine(layoutLine(b, size, cx), y0 + 40, size, tl, { alpha: alpha * (1 - liftU) });
}

// ---------------------------------------------------------------- act 3: ⌘K, Claude's third turn, the stillness, the bloom and the caption lift
const faceInCol = { x: COL.x + ((focus.x * crop.width - crop.x) / 1080) * COL.width, y: COL.y + COL.height * 0.3 };
async function act3(t: number) {
  stage(0);
  const playEnd = T.freeze3;
  const tl = t < playEnd ? TL2 + (t - T.pass3) : TL3;
  const paletteOpen = t >= T.palette && t < T.askSend + 0.25;
  const still = t >= T.still && t < T.bloom;
  x.save();
  rrect(COL.x, COL.y, COL.width, COL.height, 4);
  x.clip();
  if (paletteOpen) x.filter = `blur(${(6 * expo(prog(t, T.palette, 0.3)) * (1 - prog(t, T.askSend, 0.25))).toFixed(1)}px)`;
  if (t < playEnd) x.drawImage(await img(inner.v3(tl)), COL.x, COL.y, COL.width, COL.height);
  else {
    // living still, except during the stillness, when not one pixel moves
    const since = t < T.still ? t - playEnd : t < T.bloom ? T.still - playEnd : t - playEnd - (T.bloom - T.still);
    await drawLiving(DEC.v3, TL3, since, COL, 0.1);
  }
  x.filter = "none";
  // the bloom: the real graded frame (v4b) grows out of Reed's face
  if (t >= T.bloom) {
    const u = inOut(prog(t, T.bloom, 1.4));
    const r = u * Math.hypot(COL.width, COL.height) * 1.05;
    const off = createCanvas(Math.ceil(COL.width), COL.height), o = off.getContext("2d") as SKRSContext2D;
    o.drawImage(await img(inner.v4b(TL3)), 0, 0, COL.width, COL.height);
    if (u < 1) {
      o.globalCompositeOperation = "destination-in";
      const g = o.createRadialGradient(faceInCol.x - COL.x, faceInCol.y - COL.y, Math.max(0, r - 180), faceInCol.x - COL.x, faceInCol.y - COL.y, Math.max(1, r));
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      o.fillStyle = g;
      o.fillRect(0, 0, COL.width, COL.height);
    }
    x.drawImage(off, COL.x, COL.y);
    const cross = prog(t, T.liftEnd - 0.15, 0.15);
    if (cross > 0) {
      x.globalAlpha = cross;
      x.drawImage(await img(inner.v4(TL3)), COL.x, COL.y, COL.width, COL.height);
      x.globalAlpha = 1;
    }
  }
  x.restore();
  x.strokeStyle = "rgba(255,240,230,0.16)";
  x.lineWidth = 1;
  x.strokeRect(COL.x + 0.5, COL.y + 0.5, COL.width - 1, COL.height - 1);
  // the hush: everything around the face eases down just before the stillness (so nothing moves inside it),
  // holds through the bloom and the lift, and comes back as Claude resolves the note
  const hush = inOut(prog(t, T.still - 0.12, 0.12)) * (1 - inOut(prog(t, T.liftEnd, T.resolved3 - T.liftEnd)));
  const hudA = 1 - 0.6 * hush;
  hudColumn(t, { version: t < T.resolved3 ? "v3" : "v4", aspect: "9:16", durS: dur.v3, tl, paused: t >= playEnd }, COL, hudA);
  const liftU = t >= T.liftFrom ? clamp((t - T.liftFrom) / 0.6) : 0;
  drawColumnTranscript(tl, hudA, COLCX, COL, capWords.length ? liftU : 0);
  if (capWords.length && t >= T.liftFrom && t < T.liftEnd) captionLift(t, tl);
  // the notes beside the Short: #2 answered, #3 asked, then answered
  noteCard(COL.x - 32, COL.y + COL.height * 0.42, 2, t, { note: story[1].note, reply: story[1].reply, openAt: -1, replyAt: -1, signed: true, side: "left", vAlign: "middle", maxW: Math.max(300, Math.min(460, COL.x - 140)), noteMaxW: Math.max(300, Math.min(460, BOX.x - 140)), alpha: 1 - expo(prog(t, T.palette - 0.1, 0.3)) });
  noteCard(COL.x - 32, COL.y + COL.height * 0.6, 3, t, { note: story[2].note, reply: story[2].reply, openAt: T.askSend, replyAt: T.resolved3, signed: true, working: [T.working3, T.resolved3], side: "left", vAlign: "middle", maxW: COL.x - 140, alpha: hudA, frozen: [T.still, T.bloom] });
  const palU = expo(prog(t, T.palette, 0.25)) * (1 - prog(t, T.askSend, 0.25));
  drawLogCard(t, 1 - 0.65 * palU, { dim: 1 - 0.5 * hush });
  if (paletteOpen && rects.palette) {
    const c = lerp((ev["palette"] ?? 0) + 0.45, (ev["ask-send"] ?? 0) - 0.02, prog(t, T.palette + 0.1, T.askSend - T.palette - 0.1));
    const r = rects.palette;
    const out = prog(t, T.askSend, 0.25);
    const sc = PAL_SCALE * (1 - out * 0.3);
    await capCrop(c, r, COLCX - (r.width * sc) / 2, PAL_Y, sc, (1 - out) * expo(prog(t, T.palette, 0.25)), 1);
  }
  if (t >= T.cmdK - 0.06 && t < T.cmdK + 0.5 && rects.palette) {
    const a = expo(prog(t, T.cmdK - 0.06, 0.08)) * (1 - prog(t, T.cmdK + 0.3, 0.2));
    const press = prog(t, T.cmdK, 0.04) * (1 - prog(t, T.cmdK + 0.12, 0.08));
    keycaps(["⌘", "K"], COLCX, PAL_Y + rects.palette.height * PAL_SCALE + 44, 120, a, press);
  }
  // the cursor comes up from below the bottom edge for ⌘K, then leaves the same way for good
  if (t < T.cursorOut + 0.6) {
    const up = expo(prog(t, T.cursorUp, 0.5));
    const outU = inOut(prog(t, T.cursorOut, 0.5));
    cursor(lerp(CURSOR_PARK.x, COLCX + 140, up), lerp(H + 120, COL.y + 150, up) + outU * 1000, 1.5, expo(prog(t, T.cursorUp, 0.12)));
  }
}
/** Two physical-looking keycaps, pressed once. */
function keycaps(keys: string[], cx: number, top: number, size: number, alpha: number, press: number) {
  if (alpha <= 0.002) return;
  const gap = size * 0.16, total = keys.length * size + (keys.length - 1) * gap, depth = size * 0.07, r = size * 0.2;
  x.save();
  x.globalAlpha = alpha;
  keys.forEach((k, i) => {
    const left = cx - total / 2 + i * (size + gap), dy = press * depth * 0.8;
    x.shadowColor = "rgba(0,0,0,0.55)";
    x.shadowBlur = 36;
    x.shadowOffsetY = 12;
    rrect(left, top + depth, size, size, r);
    x.fillStyle = "#0c0b0a";
    x.fill();
    x.shadowColor = "transparent";
    rrect(left, top + dy, size, size, r);
    x.fillStyle = press > 0.5 ? "#262320" : "#1d1b19";
    x.fill();
    x.strokeStyle = "rgba(255,240,230,0.20)";
    x.lineWidth = 1.5;
    x.stroke();
    mono(size * 0.46, 500);
    x.fillStyle = BONE;
    const w = x.measureText(k).width;
    x.fillText(k, left + (size - w) / 2, top + dy + size * 0.66);
  });
  x.restore();
}
/** Grey transcript words fly up into the exact boxes of their burned-in caption words. */
function captionLift(t: number, tl: number) {
  const [a, b] = columnLines();
  const size = 30, y0 = COL.y + COL.height + 44;
  const boxes = [...layoutLine(a, size, COLCX).map((bx) => ({ ...bx, y: y0 })), ...layoutLine(b, size, COLCX).map((bx) => ({ ...bx, y: y0 + 40 }))];
  const sx = COL.width / 1080;
  capWords.forEach((cw, k) => {
    const src = boxes.find((bx) => norm(bx.w.text) === norm(cw.text));
    if (!src) return;
    const u = inOut(prog(t, T.liftFrom + k * 0.06, 0.95));
    if (u <= 0) return;
    const tx = COL.x + cw.x * sx, ty = COL.y + (cw.y + cw.h) * sx;
    const p0 = { x: src.x, y: src.y }, p2 = { x: tx, y: ty }, p1 = { x: (p0.x + p2.x) / 2, y: Math.min(p0.y, p2.y) - 140 };
    const bx = (1 - u) * (1 - u) * p0.x + 2 * (1 - u) * u * p1.x + u * u * p2.x;
    const by = (1 - u) * (1 - u) * p0.y + 2 * (1 - u) * u * p1.y + u * u * p2.y;
    const fs = lerp(size, cw.fontSize * sx, u);
    // the transcript word becomes the caption word mid-flight: a short crossfade on one baseline
    const kx = renderCapWord ? inOut(clamp((u - 0.4) / 0.25)) : 0;
    if (kx < 1) {
      x.save();
      x.globalAlpha = 1 - kx;
      mono(fs);
      x.fillStyle = src.w.start <= tl ? BONE : GREY;
      x.fillText(src.w.text, bx, by);
      x.restore();
    }
    if (kx > 0 && renderCapWord) {
      x.save();
      x.globalAlpha = kx;
      const k2 = fs / (cw.fontSize * sx);
      x.translate(bx, by - cw.h * sx * k2);
      x.scale(sx * k2, sx * k2);
      renderCapWord(x, { ...cw, x: 0, y: 0 });
      x.restore();
    }
  });
}

// ---------------------------------------------------------------- act 4: the final pass, untouched
const PUSH4 = 0.02;
// the column slug bows out over the last hold of the final pass and the first beat of the pull-back
const slugA = (t: number) => 1 - inOut(prog(t, T.reveal - 0.12, 0.36));
function finalDest(t: number): Box {
  const slide = inOut(prog(t, T.snap, T.final - T.snap + 0.25));
  const base = lerpBox(COL, COLF, slide);
  const push = 1 + PUSH4 * prog(t, T.final, FINAL_LEN);
  return { x: base.x + base.width / 2 - (base.width * push) / 2, y: base.y + base.height / 2 - (base.height * push) / 2, width: base.width * push, height: base.height * push };
}
async function act4(t: number) {
  stage(1.2 * inOut(prog(t, T.snap, 0.4)));
  const dest = finalDest(t);
  // the playhead goes home behind a short dip (not a second rewind), then the finished Short plays
  const dip = t < T.final ? Math.sin(Math.PI * prog(t, T.snap + 0.05, T.final - T.snap - 0.05)) : 0;
  const tl = t < T.final ? (t < (T.snap + T.final) / 2 ? TL3 : FINAL_IN) : FINAL_IN + Math.min(FINAL_LEN, t - T.final);
  x.save();
  rrect(dest.x, dest.y, dest.width, dest.height, 4);
  x.clip();
  x.drawImage(await img(inner.v4(tl)), dest.x, dest.y, dest.width, dest.height);
  if (dip > 0) {
    x.fillStyle = `rgba(6,6,7,${0.92 * dip})`;
    x.fillRect(dest.x, dest.y, dest.width, dest.height);
  }
  x.restore();
  x.strokeStyle = "rgba(255,240,230,0.12)";
  x.lineWidth = 1;
  x.strokeRect(dest.x + 0.5, dest.y + 0.5, dest.width - 1, dest.height - 1);
  const fade = 1 - inOut(prog(t, T.snap, 0.45));
  hudColumn(t, { version: "v4", aspect: "9:16", durS: dur.v4, tl: 0, paused: false, final: true }, dest, slugA(t));
  if (fade > 0) {
    drawLogCard(t, fade);
    noteCard(COL.x - 32, COL.y + COL.height * 0.6, 3, t, { note: story[2].note, reply: story[2].reply, openAt: -1, replyAt: -1, signed: true, side: "left", vAlign: "middle", maxW: COL.x - 140, alpha: fade });
  }
}

// ---------------------------------------------------------------- act 5: the pull-back into the real editor, then the review
const BASE = 1.2;
type Cam = { x: number; y: number; z: number };
const fitCam = (r: Box, fill: number): Cam => ({ x: r.x + r.width / 2, y: r.y + r.height / 2, z: Math.min((W * fill) / r.width, (H * fill) / r.height) / BASE });
function camRect(cam: Cam, r: Box): Box {
  const k = BASE * cam.z;
  return { x: W / 2 + (r.x - cam.x) * k, y: H / 2 + (r.y - cam.y) * k, width: r.width * k, height: r.height * k };
}
async function drawEditor(c: number, cam: Cam, alpha = 1) {
  if (alpha <= 0) return;
  const k = BASE * cam.z;
  const frame = await img(capFile(c));
  x.save();
  x.globalAlpha = alpha;
  x.translate(W / 2, H / 2);
  x.scale(k, k);
  x.translate(-cam.x, -cam.y);
  x.shadowColor = "rgba(0,0,0,0.75)";
  x.shadowBlur = 90;
  x.shadowOffsetY = 30;
  rrect(0, 0, 1440, 900, 14);
  x.fillStyle = "#0e0d0c";
  x.fill();
  x.shadowColor = "transparent";
  x.save();
  rrect(0, 0, 1440, 900, 14);
  x.clip();
  x.imageSmoothingQuality = "high";
  x.drawImage(frame, 0, 0, 1440, 900);
  x.restore();
  x.strokeStyle = "rgba(255,255,255,0.12)";
  x.lineWidth = 1.2 / k;
  rrect(0, 0, 1440, 900, 14);
  x.stroke();
  x.restore();
}
const F916 = rects.frame916 ?? rects.frame;
// The pull-back starts exactly where the final pass ends: the preview fills the same rect.
const endDest = finalDest(T.reveal);
const zStart = endDest.height / (F916.height * BASE);
const camStart: Cam = { x: F916.x + F916.width / 2 - (endDest.x + endDest.width / 2 - W / 2) / (BASE * zStart), y: F916.y + F916.height / 2 - (endDest.y + endDest.height / 2 - H / 2) / (BASE * zStart), z: zStart };
const camWide: Cam = { ...fitCam({ x: 0, y: 0, width: 1440, height: 900 }, 0.72), y: 450 + 52 };
// Review: push in on what changed: the struck words, the preview and Claude's review pill (2× capture stays sharp).
const RB = rects.review ?? F916, RX0 = (rects.words?.x ?? 69) - 24, RX1 = RB.x + RB.width + 24;
const kReview = Math.min((W * 0.96) / (RX1 - RX0), 2.1);
const camReview: Cam = { x: (RX0 + RX1) / 2, y: 335, z: kReview / BASE };
// Reveal choreography (seconds after T.reveal): the pins leave once the real notes panel is in frame.
const PIN_GO = 1.3, PIN_FLY = 0.8, PIN_STAG = 0.12;
// the ⌘K search field in the editor's top bar (capture coordinates), where note 3 was asked
const SEARCH_K: Box = { x: 860, y: 12, width: 40, height: 20 };
// The capture's After lands a few frames after the click; until then the preview shows its raw state.
const afterShown = await (async () => {
  const ac = ev["after-click"], r = F916;
  if (ac === undefined || !r) return ac;
  const pc = createCanvas(16, 8), p = pc.getContext("2d");
  for (let i = 0; i < cap.frames.length; i++) {
    if (capTimes[i] < ac) continue;
    if (capTimes[i] > ac + 1.5) break;
    const f = await loadImage(join(OUT, "capture", cap.frames[i].file));
    const k = f.width / 1440;
    p.drawImage(f, r.x * k, (r.y + r.height * 0.55) * k, r.width * k, r.height * 0.25 * k, 0, 0, 16, 8);
    const d = p.getImageData(0, 0, 16, 8).data;
    let s = 0;
    for (let j = 0; j < d.length; j += 4) s += d[j] + d[j + 1] + d[j + 2];
    if (s / (128 * 3) > 12) return capTimes[i];
  }
  return ac + 0.2;
})();
async function act5(t: number) {
  stage(1.2);
  if (t < T.review) {
    const u = inOut(prog(t, T.reveal, 2.0));
    const cam: Cam = { x: lerp(camStart.x, camWide.x, u), y: lerp(camStart.y, camWide.y, u), z: Math.exp(lerp(Math.log(camStart.z), Math.log(camWide.z), u)) };
    const c = (ev["reveal"] ?? 0) + (t - T.reveal);
    await drawEditor(c, cam, inOut(prog(t, T.reveal, 0.6)));
    // the finished Short stays sharp in the preview until the editor is the picture
    const pr = camRect(cam, F916);
    const sharp = 1 - clamp((1.7 - cam.z) / 0.35);
    if (sharp > 0) {
      x.save();
      x.globalAlpha = sharp;
      rrect(pr.x, pr.y, pr.width, pr.height, 4);
      x.clip();
      x.drawImage(await img(inner.v4(FINAL_IN + FINAL_LEN - 0.02)), pr.x, pr.y, pr.width, pr.height);
      x.restore();
      if (rects.review) {
        const f = await img(capFile(c));
        const k = f.width / 1440, rr = camRect(cam, rects.review);
        x.save();
        x.globalAlpha = sharp * inOut(prog(t, T.reveal, 0.6));
        x.drawImage(f, rects.review.x * k, rects.review.y * k, rects.review.width * k, rects.review.height * k, rr.x, rr.y, rr.width, rr.height);
        x.restore();
      }
    }
    // the final pass's slug rides the preview out with the zoom instead of cutting
    if (t < T.reveal + 0.3) hudColumn(t, { version: "v4", aspect: "9:16", durS: dur.v4, tl: 0, paused: false, final: true }, pr, slugA(t));
    // each note's pin rises from where it was made in the real editor and lands on its resolved tick:
    // #1 the struck words in the transcript, #2 the picture (beside the face), #3 the ⌘K field
    const origins: Box[] = [rects.words ?? { x: 120, y: 360, width: 0, height: 0 }, { x: F916.x + F916.width * 0.82, y: F916.y + F916.height * 0.3, width: 0, height: 0 }, SEARCH_K];
    for (let n = 1; n <= 3; n++) {
      const card = rects[`card${n}`];
      if (!card) continue;
      const tick = rects[`tick${n}`];
      const at = T.reveal + PIN_GO + (n - 1) * PIN_STAG;
      const land = at + PIN_FLY;
      if (t < at - 0.15 || t >= land + 0.6) continue;
      const tg = camRect(cam, tick ? { x: tick.x + tick.width / 2, y: tick.y + tick.height / 2, width: 0, height: 0 } : { x: card.x + 27, y: card.y + 21, width: 0, height: 0 });
      const o = origins[n - 1];
      const st = camRect(cam, { x: o.x + o.width / 2, y: o.y + o.height / 2, width: 0, height: 0 });
      const tickR = 10 * BASE * cam.z;
      const p1 = { x: st.x, y: st.y - 140 }, p2 = { x: tg.x - 120, y: tg.y - 90 };
      const at3 = (uu: number) => {
        const bz = (a: number, b: number, c2: number, d: number) => (1 - uu) ** 3 * a + 3 * (1 - uu) ** 2 * uu * b + 3 * (1 - uu) * uu * uu * c2 + uu ** 3 * d;
        return { x: bz(st.x, p1.x, p2.x, tg.x), y: bz(st.y, p1.y, p2.y, tg.y) };
      };
      const pu = inOut(prog(t, at, PIN_FLY));
      if (t < land) {
        const a = expo(prog(t, at - 0.15, 0.2));
        // a short tapered lime streak so the flight reads as motion, not as a stray dot
        const u0 = inOut(prog(t - 0.14, at, PIN_FLY));
        x.save();
        x.lineCap = "round";
        for (let k = 0; k < 8; k++) {
          const qa = at3(lerp(u0, pu, k / 8)), qb = at3(lerp(u0, pu, (k + 1) / 8));
          x.strokeStyle = `rgba(232,244,124,${(0.5 * a * ((k + 1) / 8)).toFixed(3)})`;
          x.lineWidth = 6 + 18 * ((k + 1) / 8);
          x.beginPath();
          x.moveTo(qa.x, qa.y);
          x.lineTo(qb.x, qb.y);
          x.stroke();
        }
        x.restore();
        const q = at3(pu);
        pin(q.x, q.y, n, t, { resolvedAt: 0, alpha: a, scale: lerp(0.6, 2, expo(prog(t, at - 0.15, 0.3))) });
      } else {
        const q = expo(prog(t, land, 0.25));
        if (q < 1) pin(tg.x, tg.y, n, t, { resolvedAt: 0, alpha: 1 - q, scale: lerp(2, tickR / 17, q) });
        const p = prog(t, land, 0.6);
        x.strokeStyle = `rgba(232,244,124,${0.9 * (1 - p)})`;
        x.lineWidth = 2;
        x.beginPath();
        x.arc(tg.x, tg.y, tickR + 2 + p * 14, 0, Math.PI * 2);
        x.stroke();
      }
    }
    line("", W / 2, 984, 52, t, T.voThree - 0.05, { leave: T.review - 0.35, runs: [{ text: "Three notes. Claude made every change.", color: "gradient" }] });
    line("", W / 2, 1044, 40, t, T.voThree + 0.6, { weight: 500, leave: T.review - 0.35, runs: [{ text: "Over MCP, while you watched.", color: SOFT }] });
  } else if (t < T.end) {
    // review it like a pull request: the real Before/After, pushed in on what changed
    const u = inOut(prog(t, T.review, 0.8));
    const cam: Cam = { x: lerp(camWide.x, camReview.x, u), y: lerp(camWide.y, camReview.y, u), z: Math.exp(lerp(Math.log(camWide.z), Math.log(camReview.z), u)) };
    const c = REVIEW_C0 + (t - T.review);
    const fadeOut = 1 - inOut(prog(t, T.end - 0.6, 0.6));
    await drawEditor(c, cam, fadeOut);
    const bc = ev["before-click"] ?? 0;
    const aT = afterShown ?? bc + 2;
    const bIn = inOut(prog(c, bc + 0.05, 0.35)), bOut = inOut(prog(c, aT, 0.35));
    const pr = camRect(cam, F916);
    if (bIn > 0 && bOut < 1) {
      x.save();
      x.globalAlpha = fadeOut;
      rrect(pr.x, pr.y, pr.width, pr.height, 4);
      x.clip();
      x.drawImage(await img(inner.v4(FINAL_IN + FINAL_LEN - 0.02)), pr.x, pr.y, pr.width, pr.height);
      const x0 = pr.x + pr.width * bOut, x1 = pr.x + pr.width * bIn;
      x.beginPath();
      x.rect(x0, pr.y, x1 - x0, pr.height);
      x.clip();
      x.fillStyle = "#000";
      x.fillRect(pr.x, pr.y, pr.width, pr.height);
      const h = (pr.width * 9) / 16;
      x.drawImage(await img(inner.v1(Math.min(dur.v1 - 0.05, c - bc))), pr.x, pr.y + (pr.height - h) / 2, pr.width, h);
      x.restore();
      const edge = bIn < 1 ? x1 : bOut > 0 ? x0 : -1;
      if (edge > 0) {
        x.fillStyle = LIME;
        x.fillRect(edge - 1.5, pr.y, 3, pr.height);
      }
    }
    if (rects.review) {
      // the real review pill stays on top
      const f = await img(capFile(c));
      const k = f.width / 1440, rr = camRect(cam, rects.review);
      x.save();
      x.globalAlpha = fadeOut * u;
      x.drawImage(f, rects.review.x * k, rects.review.y * k, rects.review.width * k, rects.review.height * k, rr.x, rr.y, rr.width, rr.height);
      x.restore();
    }
    // labels a phone can read: nothing until Before is clicked, then BEFORE, then AFTER once After is back.
    // One plate (sized for the wider label) on one side (picked from the settled camera), so the titles
    // swap in place: the old one is out before the new one comes in.
    const plateA = bIn * fadeOut;
    if (plateA > 0.01) {
      const chips = [
        { title: "BEFORE", sub: `${fmtDur(dur.v1)} · 16:9`, color: CORAL, a: clamp(1 - 2 * bOut) },
        { title: "AFTER", sub: `${fmtDur(dur.v4)} · 9:16 · captions`, color: LIME, a: clamp(2 * bOut - 1) },
      ];
      let w = 0;
      for (const c2 of chips) {
        x.font = "700 56px SF";
        spacing(6);
        w = Math.max(w, x.measureText(c2.title).width);
        mono(28);
        spacing(0);
        w = Math.max(w, x.measureText(c2.sub).width);
      }
      w += 56;
      const h = 150, prF = camRect(camReview, F916);
      const onRight = prF.x + prF.width + 48 + w <= W - 40;
      const lx = onRight ? pr.x + pr.width + 48 : pr.x - 48 - w, ly = pr.y + pr.height / 2;
      x.save();
      x.globalAlpha = plateA;
      rrect(lx, ly - h / 2, w, h, 14);
      x.fillStyle = "rgba(10,10,11,0.78)";
      x.fill();
      for (const c2 of chips) {
        if (c2.a <= 0.01) continue;
        x.globalAlpha = plateA * c2.a;
        x.font = "700 56px SF";
        spacing(6);
        x.fillStyle = c2.color;
        x.fillText(c2.title, lx + 28, ly + 2);
        spacing(0);
        mono(28);
        x.fillStyle = GREY;
        x.fillText(c2.sub, lx + 28, ly + 50);
      }
      x.restore();
    }
    const g = x.createLinearGradient(0, H - 250, 0, H);
    g.addColorStop(0, "rgba(6,6,7,0)");
    g.addColorStop(1, `rgba(6,6,7,${(0.95 * fadeOut).toFixed(3)})`);
    x.fillStyle = g;
    x.fillRect(0, H - 250, W, 250);
    line("", W / 2, 1046, 46, t, T.voReview - 0.05, { leave: T.end - 0.5, runs: [{ text: "Review it like a pull request.", color: "gradient" }] });
  }
}

// ---------------------------------------------------------------- the mark: a note pin with a cut taken out of it
// Geometry from assets/brand/mark.svg (a 512 box): the pin's head is a circle at (256, 232), r 150,
// with its point at (256, 452); the counter is r 66; the cut is the wedge between -45° and 0°;
// the lime edge runs along the -45° side from r 68 to r 151.
const MARK = { cx: 256, cy: 232, r: 150, tipY: 452, counter: 66, limeIn: 68, limeOut: 151 };
function pinPath(p: Path2D | SKRSContext2D) {
  const a0 = Math.asin((334.3 - MARK.cy) / MARK.r); // where the point's sides leave the circle
  p.moveTo(MARK.cx + MARK.r * Math.cos(Math.PI - a0), MARK.cy + MARK.r * Math.sin(Math.PI - a0));
  p.arc(MARK.cx, MARK.cy, MARK.r, Math.PI - a0, a0, false);
  p.lineTo(MARK.cx, MARK.tipY);
  p.closePath();
}
/**
 * The cutroom mark at (px, py) (the counter's centre), `k` screen px per mark unit. `cut` opens the
 * counter and throws the wedge out (0 = a whole pin, 1 = the mark); `blade` draws the lime cut in
 * from outside (0 to 1); `portal` fills the counter with whatever `fill` draws (the take, on the entry).
 */
function drawMark(px: number, py: number, k: number, o: { cut: number; blade: number; alpha?: number; blur?: number; glow?: number; portal?: () => void }) {
  const a = o.alpha ?? 1;
  if (a <= 0.002) return;
  const toMark = () => {
    x.translate(px, py);
    x.scale(k, k);
    x.translate(-MARK.cx, -MARK.cy);
  };
  x.save();
  x.globalAlpha = a;
  if ((o.blur ?? 0) > 0.3) x.filter = `blur(${o.blur!.toFixed(1)}px)`;
  // a soft coral bloom behind it
  if ((o.glow ?? 0) > 0) {
    const g = x.createRadialGradient(px, py + 30 * k, 0, px, py + 30 * k, 420 * k);
    g.addColorStop(0, `rgba(255,95,79,${(0.22 * o.glow!).toFixed(3)})`);
    g.addColorStop(1, "rgba(255,95,79,0)");
    x.fillStyle = g;
    x.fillRect(px - 460 * k, py - 430 * k, 920 * k, 920 * k);
  }
  const rc = MARK.counter * expo(clamp(o.cut / 0.6));
  const far = MARK.r * 3;
  const dir = (deg: number, r: number) => ({ x: MARK.cx + r * Math.cos((deg * Math.PI) / 180), y: MARK.cy + r * Math.sin((deg * Math.PI) / 180) });
  const grad = () => {
    const g = x.createLinearGradient(0, MARK.cy - MARK.r, 0, MARK.tipY);
    g.addColorStop(0, "#ff7a6e");
    g.addColorStop(1, "#ff4f4f");
    return g;
  };
  // the counter, open onto whatever is behind it
  if (o.portal && rc > 0.5) {
    x.save();
    toMark();
    x.beginPath();
    x.arc(MARK.cx, MARK.cy, rc, 0, Math.PI * 2);
    x.restore();
    x.save();
    x.clip();
    o.portal();
    x.restore();
  }
  // the body: the pin minus the counter and the wedge (one path: everything but the counter-plus-wedge)
  x.save();
  toMark();
  const hole = new Path2D();
  hole.rect(MARK.cx - 2000, MARK.cy - 2000, 4000, 4000);
  if (rc > 0.5) {
    const c0 = dir(0, rc), w1 = dir(-45, far), w0 = dir(0, far);
    hole.moveTo(c0.x, c0.y);
    hole.arc(MARK.cx, MARK.cy, rc, 0, Math.PI * 1.75, false);
    hole.lineTo(w1.x, w1.y);
    hole.lineTo(w0.x, w0.y);
    hole.closePath();
  }
  x.clip(hole, "evenodd");
  const body = new Path2D();
  pinPath(body);
  x.shadowColor = "rgba(0,0,0,0.45)";
  x.shadowBlur = 30 * k;
  x.shadowOffsetY = 10 * k;
  x.fillStyle = grad();
  x.fill(body);
  x.restore();
  // the wedge: cut loose, it slides out along its bisector and goes
  const wu = clamp(o.cut);
  if (wu > 0 && wu < 1) {
    x.save();
    toMark();
    // it flies off bright and only fades over the second half, so it never reads as a dark shard
    const off = 130 * expo(wu);
    x.translate(off * Math.cos((-22.5 * Math.PI) / 180), off * Math.sin((-22.5 * Math.PI) / 180));
    x.globalAlpha = a * (1 - clamp((wu - 0.45) / 0.55));
    const w1 = dir(-45, far), w0 = dir(0, far);
    x.beginPath();
    x.moveTo(MARK.cx, MARK.cy);
    x.lineTo(w1.x, w1.y);
    x.lineTo(w0.x, w0.y);
    x.closePath();
    x.clip();
    const notCounter = new Path2D();
    notCounter.rect(MARK.cx - 2000, MARK.cy - 2000, 4000, 4000);
    notCounter.arc(MARK.cx, MARK.cy, Math.max(rc, 0.1), 0, Math.PI * 2);
    x.clip(notCounter, "evenodd");
    const body = new Path2D();
    pinPath(body);
    x.fillStyle = grad();
    x.fill(body);
    x.restore();
  }
  // the blade: a lime line streaks in from outside and stays as the cut's edge
  if (o.blade > 0) {
    const head = lerp(430, MARK.limeIn, expo(clamp(o.blade / 0.55)));
    const tail = lerp(430, MARK.limeOut, expo(clamp(o.blade)));
    const flash = 1 - clamp((o.blade - 0.4) / 0.6);
    x.save();
    toMark();
    const h = dir(-45, head), tl = dir(-45, Math.max(tail, head));
    x.lineCap = "round";
    x.strokeStyle = LIME;
    x.lineWidth = 7 + 6 * flash;
    x.shadowColor = `rgba(232,244,124,${(0.9 * flash).toFixed(3)})`;
    x.shadowBlur = 28 * flash * k + 1;
    x.beginPath();
    x.moveTo(tl.x, tl.y);
    x.lineTo(h.x, h.y);
    x.stroke();
    x.restore();
  }
  x.restore();
}

// ---------------------------------------------------------------- act 0: the entry
const MARK_K = 360 / 512; // the mark at 360 px across its box
const MARK_AT = { x: W / 2, y: H / 2 - 35 * MARK_K }; // the counter, so the whole pin sits centred
async function act0(t: number) {
  stage(0);
  const inU = expo(prog(t, T.pinIn, 0.55));
  const cut = prog(t, T.cutMark, 0.42);
  const blade = prog(t, T.cutMark - 0.04, 0.32);
  // the flight: the counter grows from the middle of the frame until the take fills it
  const zu = prog(t, T.zoom, ZOOM_LEN);
  const z = Math.exp(Math.log(34) * zu ** 2.6);
  const py = lerp(MARK_AT.y, H / 2, inOut(zu));
  const breathe = 1 + 0.03 * prog(t, T.cutMark, T.zoom - T.cutMark);
  const tl = Math.max(0, t - T.cold);
  const frame = t >= T.zoom ? await img(inner.v1(tl)) : null;
  drawMark(MARK_AT.x, py, MARK_K * breathe * z * lerp(0.9, 1, inU), {
    cut,
    blade,
    alpha: inU,
    blur: (1 - inU) * 12,
    glow: inU * (1 - zu),
    portal: frame ? () => x.drawImage(frame, 0, 0, W, H) : undefined,
  });
}

// ---------------------------------------------------------------- act 6: the end, waiting for your note
const PULSE0 = T.waitIn - T.end + 0.6; // first peak of the waiting dot, seconds into the end card
const WAIT_Y = H / 2 + 160;
/** Where the waiting dot sits on the card (it carries into the exit). */
function waitLayout() {
  const a = "→ wait_for_feedback  ", b = "  waiting for your note";
  const dotW = 30;
  mono(44, 500);
  const wa = x.measureText(a).width, wb = x.measureText(b).width;
  mono(34, 500);
  const wc = x.measureText("  0:00").width;
  const left = W / 2 - (wa + dotW + wb + wc) / 2;
  return { a, b, wa, wb, dotW, left, dotX: left + wa + dotW / 2, dotY: WAIT_Y - 14 };
}
const pulseAt = (lt: number) => 0.5 + 0.5 * Math.sin(((lt - PULSE0) / 1.2) * Math.PI * 2 + Math.PI / 2);
function act6(t: number, leave = 0) {
  // the review's last frame is stage(1.2); the card eases up to its own level
  const lt = t - T.end;
  stage(lerp(1.2, 1.6, inOut(prog(lt, 0, 1.0))));
  const keep = 1 - leave;
  const stagger = (k: number) => 1 - inOut(clamp(leave * 1.6 - k * 0.12));
  const iu = expo(prog(lt, 0.25, 1.1));
  const size = 180;
  x.save();
  x.globalAlpha = iu * stagger(4);
  const g = x.createRadialGradient(W / 2, H / 2 - 230, 0, W / 2, H / 2 - 230, 420);
  g.addColorStop(0, `rgba(255,95,79,${0.2 * iu})`);
  g.addColorStop(1, "rgba(255,95,79,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  x.translate(W / 2, H / 2 - 230);
  x.scale(lerp(0.9, 1, iu), lerp(0.9, 1, iu));
  const blurOut = (1 - stagger(4)) * 14;
  if (1 - iu > 0.02 || blurOut > 0.3) x.filter = `blur(${((1 - iu) * 14 + blurOut).toFixed(1)}px)`;
  x.drawImage(icon, -size / 2, -size / 2, size, size);
  x.restore();
  const fade = (k: number) => ({ alpha: stagger(k) });
  line("", W / 2, H / 2 - 30, 104, lt, 0.7, { weight: 700, runs: [{ text: "cutroom", color: "gradient" }], ...fade(3) });
  line("", W / 2, H / 2 + 46, 56, lt, T.tagIn - T.end, { weight: 500, runs: [{ text: "Point at it. Claude fixes it.", color: SOFT }], ...fade(2) });
  // the film ends inside a live MCP call, waiting for your note
  const L = waitLayout();
  const wu = expo(prog(lt, T.waitIn - T.end, 0.7));
  if (wu > 0) {
    x.save();
    const textA = wu * stagger(1);
    const secs = Math.max(0, Math.floor(lt - (T.waitIn - T.end)));
    const c = `  0:${String(secs).padStart(2, "0")}`;
    let px = L.left;
    x.globalAlpha = textA;
    mono(44, 500);
    x.fillStyle = BONE;
    x.fillText(L.a, px, WAIT_Y);
    px += L.wa + L.dotW;
    x.fillStyle = SOFT;
    x.fillText(L.b, px, WAIT_Y);
    px += L.wb;
    mono(34, 500);
    x.fillStyle = "#77736d";
    x.fillText(c, px, WAIT_Y);
    // the dot stays for the exit, which takes it from here
    if (leave <= 0) {
      const pulse = pulseAt(lt);
      x.fillStyle = CORAL;
      x.globalAlpha = wu * (0.45 + 0.55 * pulse);
      x.beginPath();
      x.arc(L.dotX, L.dotY, 10 * (1 + 0.35 * pulse), 0, Math.PI * 2);
      x.fill();
    }
    x.restore();
  }
  const pu = expo(prog(lt, T.pillIn - T.end, 0.8));
  if (pu > 0) {
    x.save();
    x.globalAlpha = pu * stagger(0.5);
    mono(38);
    const cmd = "claude mcp add cutroom -- npx -y cutroom mcp";
    const cw = x.measureText(cmd).width + 76;
    const py = H / 2 + 230 + (1 - pu) * 12;
    rrect(W / 2 - cw / 2, py, cw, 78, 39);
    x.fillStyle = "rgba(255,255,255,0.06)";
    x.fill();
    x.strokeStyle = "rgba(255,255,255,0.14)";
    x.lineWidth = 1.5;
    x.stroke();
    x.fillStyle = "#e9e6e1";
    x.fillText(cmd, W / 2 - cw / 2 + 38, py + 52);
    x.restore();
  }
  line("", W / 2, H - 70, 36, lt, T.footIn - T.end, { weight: 500, runs: [{ text: "Open-source video editor for Claude Code  ·  MIT  ·  runs locally  ·  ", color: "#a8a49e" }, { text: "github.com/0xpratzyy/cutroom", color: BONE }], ...fade(0) });
  return keep;
}

// ---------------------------------------------------------------- act 7: the exit
// The card dissolves around its waiting dot; the dot comes to the middle, swells into a pin and is cut
// back into the mark (the entry, answered); the repo sits under it on the last frame.
async function act7(t: number) {
  const et = t - T.exit;
  const leave = prog(et, 0, 0.9);
  act6(t, leave);
  const L = waitLayout();
  const lt = t - T.end;
  const go = inOut(prog(et, 0.15, 0.75));
  const grow = inOut(prog(et, 0.75, 0.45));
  const cut = prog(et, 1.2, 0.42);
  const blade = prog(et, 1.16, 0.32);
  const px = lerp(L.dotX, MARK_AT.x, go), py = lerp(L.dotY, MARK_AT.y, go);
  const k = MARK_K * 0.78;
  if (grow < 1) {
    // the dot, still pulsing, on its way to the middle
    const pulse = pulseAt(lt) * (1 - go);
    x.save();
    x.globalAlpha = (0.45 + 0.55 * Math.max(pulse, go)) * (1 - grow);
    x.fillStyle = CORAL;
    x.beginPath();
    x.arc(px, py, lerp(10 * (1 + 0.35 * pulse), MARK.r * k, grow), 0, Math.PI * 2);
    x.fill();
    x.restore();
  }
  if (grow > 0) drawMark(px, py, k * lerp(0.35, 1, grow), { cut, blade, alpha: grow, glow: grow });
  line("", W / 2, MARK_AT.y + (MARK.tipY - MARK.cy) * k + 120, 44, et, 1.55, { weight: 500, runs: [{ text: "github.com/0xpratzyy/cutroom", color: BONE }] });
}

async function render(t: number) {
  x.globalAlpha = 1;
  x.filter = "none";
  if (t < T.cold + ZOOM_LEN) await act0(t);
  else if (t < T.box) await act1(t);
  else if (t < T.cursorUp) await act2(t);
  else if (t < T.snap) await act3(t);
  else if (t < T.reveal) await act4(t);
  else if (t < T.end) await act5(t);
  else if (t < T.exit) act6(t);
  else await act7(t);
  finish(t);
}

// ---------------------------------------------------------------- cues for the score (music-rough.mts), the beat (beat.mts) and the mix (mix.mts)
const filmOfCap = (c: number | undefined, fallback: number) => (c === undefined ? fallback : T.review + (c - REVIEW_C0));
/** Keystrokes in a text field, on the capture clock: the frames where its text gains ink (a caret
 *  blinking back on never beats the most ink seen so far, so it doesn't count). */
async function keystrokes(r: Box | undefined, c0: number, c1: number) {
  if (!r) return [] as number[];
  const pw = 160, ph = 24, pc = createCanvas(pw, ph), p = pc.getContext("2d");
  const out: number[] = [];
  let most = -1;
  for (let i = 0; i < cap.frames.length; i++) {
    const c = capTimes[i];
    if (c < c0 - 0.3) continue;
    if (c > c1 + 0.05) break;
    const f = await loadImage(join(OUT, "capture", cap.frames[i].file));
    const k = f.width / 1440;
    p.drawImage(f, r.x * k, r.y * k, r.width * k, r.height * k, 0, 0, pw, ph);
    const d = p.getImageData(0, 0, pw, ph).data;
    let ink = 0;
    for (let j = 0; j < d.length; j += 4) if (d[j] + d[j + 1] + d[j + 2] > 3 * 150) ink++;
    if (most >= 0 && ink > most + 6 && c >= c0) out.push(c);
    most = Math.max(most, ink);
  }
  return out.filter((c, i) => i === 0 || c - out[i - 1] > 0.035);
}
/** Capture keystrokes mapped onto the film the way the composer crop maps the capture. */
const keysOnFilm = (keys: number[], c0: number, c1: number, f0: number, f1: number, fallback: number[]) =>
  keys.length ? keys.map((c) => f0 + (clamp((c - c0) / (c1 - c0)) * (f1 - f0))) : fallback;
const k1c = [(ev["select-up"] ?? 0) + 0.8, (ev["note1-send"] ?? 0) - 0.02];
const k2c = [(ev["box-up"] ?? 0) + 0.45, (ev["note2-send"] ?? 0) - 0.02];
const k3c = [(ev["palette"] ?? 0) + 0.45, (ev["ask-send"] ?? 0) - 0.02];
const keys1 = keysOnFilm(await keystrokes(rects.composer1, k1c[0], k1c[1]), k1c[0], k1c[1], T.noteOpen + 0.15, T.noteSend, Array.from({ length: 6 }, (_, i) => T.noteOpen + 0.3 + i * 0.08));
const keys2 = keysOnFilm(await keystrokes(rects.composer2, k2c[0], k2c[1]), k2c[0], k2c[1], T.note2Open + 0.15, T.note2Send, Array.from({ length: 8 }, (_, i) => T.note2Open + 0.15 + i * 0.09));
const palRow = rects.palette ? { ...rects.palette, height: Math.min(56, rects.palette.height) } : undefined;
const keys3 = keysOnFilm(await keystrokes(palRow, k3c[0], k3c[1]), k3c[0], k3c[1], T.palette + 0.1, T.askSend, Array.from({ length: 12 }, (_, i) => T.palette + 0.2 + i * 0.12));
const bcFilm = filmOfCap(ev["before-click"], T.review + T.reviewPre), aShownFilm = filmOfCap(afterShown, bcFilm + 2.4);
const cues = {
  duration: DUR,
  sections: { ...T },
  layers: [
    { at: 0, name: "L0" },
    { at: T.pass2, name: "L1" },
    { at: T.wait2, name: "L2" },
    { at: T.final, name: "full" },
    { at: bcFilm + 0.08, name: "demo" },
    { at: aShownFilm, name: "restore" },
  ],
  working: [[T.working1, T.resolved1], [T.working2, T.fold], [T.working3, T.still]],
  chimes: [{ at: T.resolved1, midi: 76 }, { at: T.resolved2, midi: 80 }, { at: T.resolved3, midi: 83 }, ...[0, 1, 2].map((k) => ({ at: T.reveal + PIN_GO + PIN_FLY + k * PIN_STAG, midi: [88, 92, 95][k] }))],
  silence: [T.still, T.bloom],
  arrival: T.bloom,
  tonicAt: iFixes >= 0 ? T.final + V4[iFixes].start - FINAL_IN : T.final + FINAL_LEN - 1,
  endPulses: [0, 1, 2].map((k) => T.end + PULSE0 + k * 1.2).filter((p) => p < T.exit + 0.8),
  rewind: { from: T.rewind, to: T.pass2 },
  // the narrator's lines, by id (vo-<take>.json has the files)
  vo: ["launch", "rough", "notes", "claude", "what", "point", "ask", "three", "review", "name", "tagline", "turn"].map((id) => ({ id, at: T[`vo${id[0].toUpperCase()}${id.slice(1)}`] })),
  // Reed's own sound, whenever the film inside the film plays at speed
  sync: [
    { src: "v1", from: 0, len: TL1, at: T.cold },
    { src: "v2", from: 0, len: TL2, at: T.pass2 },
    { src: "v3", from: TL2, len: TL3 - TL2, at: T.pass3 },
    { src: "v4", from: FINAL_IN, len: FINAL_LEN, at: T.final },
    { src: "v1", from: 0, len: Math.max(0.5, aShownFilm - bcFilm), at: bcFilm },
  ],
  sfx: [
    { name: "pin", at: T.pinIn },
    { name: "slice", at: T.cutMark },
    { name: "whoosh", at: T.zoom, dur: ZOOM_LEN },
    { name: "pause", at: T.pause1 },
    { name: "click", at: T.dragStart },
    { name: "release", at: T.dragEnd },
    ...keys1.map((at) => ({ name: "key", at })),
    { name: "tock", at: T.noteSend },
    { name: "fold", at: T.fold1 },
    { name: "click", at: T.boxDown },
    { name: "release", at: T.boxUp },
    ...keys2.map((at) => ({ name: "key", at })),
    { name: "tock", at: T.note2Send },
    { name: "breath", at: T.glide, dur: T.glideEnd - T.glide },
    { name: "key", at: T.cmdK, gain: 1.2 },
    ...keys3.map((at) => ({ name: "key", at })),
    { name: "tock", at: T.askSend },
    { name: "click", at: bcFilm + 0.06 },
    { name: "click", at: filmOfCap(ev["after-click"], bcFilm + 2.4) + 0.06 },
    { name: "pin", at: T.exit + 0.75 },
    { name: "slice", at: T.exit + 1.2 },
  ],
};
writeFileSync(join(OUT, "cues.json"), JSON.stringify(cues, null, 1));
console.log(`timeline ${DUR.toFixed(1)} s · TL1 ${TL1.toFixed(2)} TL2 ${TL2.toFixed(2)} TL3 ${TL3.toFixed(2)} · final ${FINAL_LEN.toFixed(2)} s · capture ${cap.frames.length} frames at ${(await img(capFile(1))).width}px`);
if (process.argv.includes("--cues")) process.exit(0);

// ---------------------------------------------------------------- output
const only = process.argv.find((a) => a.startsWith("--only="));
if (only) {
  mkdirSync(join(OUT, "stills"), { recursive: true });
  for (const s of only.slice(7).split(",").map(Number)) {
    await render(s);
    writeFileSync(join(OUT, "stills", `t${s.toFixed(2).padStart(5, "0")}.jpg`), canvas.toBuffer("image/jpeg", 92));
  }
  console.log("stills written");
  process.exit(0);
}
const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-c:v", "libx264", "-preset", "slow", "-tune", "film", "-crf", "12", "-x264-params", "aq-mode=3:aq-strength=0.9", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(OUT, "film-video.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
const total = Math.round(DUR * FPS);
for (let f = 0; f < total; f++) {
  await render(f / FPS);
  const buf = Buffer.from(x.getImageData(0, 0, W, H).data.buffer);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
  if (f % 300 === 0) console.log(`frame ${f}/${total}`);
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log(`film-video.mp4 done (${DUR.toFixed(1)} s)`);
