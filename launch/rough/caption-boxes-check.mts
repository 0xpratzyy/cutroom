// Checks caption-boxes.mts against a real cutroom export. Builds a scratch project from the
// stand-in footage (9:16, captions preset pop), exports a draft with and without captions, then
// for every frame finds each burned-in word's fill (pixels the captions changed that are bright)
// and compares it with the computed ink box. Also checks the caption clock against the PNG list
// render.ts wrote and the timestamps ffmpeg gave it, and that renderCaptionWord() draws exactly
// what drawCaptionFrame() does.
// Usage: npx tsx launch/rough/caption-boxes-check.mts [footage]   (PRESET=pop, ASPECT=9:16, CAPBOX_WORK=<dir>)
//   ->  launch/out/rough/caption-boxes-check.png + accuracy report on stdout
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createCanvas, ImageData, type SKRSContext2D } from "@napi-rs/canvas";
import { drawCaptionFrame, type Ctx2D } from "../../src/core/shared/captions.ts";
import { captionWordBoxes, exportCaptionEntries, loadCaptionProject, mapBox, renderCaptionWord, type CaptionWordBox } from "./caption-boxes.mts";

const ROOT = resolve(import.meta.dirname, "../..");
const OUT = join(ROOT, "launch/out/rough");
const CLI = join(ROOT, "dist/cli.js");
const FOOTAGE = resolve(process.argv[2] ?? join(ROOT, "launch/out/footage.webm"));
const PRESET = process.env.PRESET ?? "pop";
const ASPECT = process.env.ASPECT ?? "9:16";
const WORK = process.env.CAPBOX_WORK ?? mkdtempSync(join(tmpdir(), "capbox-"));
const DIR = join(WORK, "project");
// Never touch the user's ~/.cutroom.
const env = { ...process.env, CUTROOM_HOME: join(WORK, "home") } as Record<string, string>;
mkdirSync(env.CUTROOM_HOME, { recursive: true });
mkdirSync(OUT, { recursive: true });
const cli = (...args: string[]) => execFileSync("node", [CLI, ...args], { env, encoding: "utf8" }).trim();

// ---------------------------------------------------------------- project + exports
rmSync(DIR, { recursive: true, force: true });
cli("init", DIR, FOOTAGE, "--name", "capbox", "--model", "base.en");
cli("edit", "--project", DIR, JSON.stringify([{ op: "set_settings", aspect: ASPECT }, { op: "set_captions", preset: PRESET }]));
const withCaps = join(WORK, "with.mp4");
const without = join(WORK, "without.mp4");
cli("export", "--project", DIR, "--quality", "draft", "--out", withCaps);
const capDir = join(DIR, ".cutroom/render/captions");
const list = readdirSync(capDir).filter((f) => f.startsWith("list-")).sort((a, b) => statSync(join(capDir, b)).mtimeMs - statSync(join(capDir, a)).mtimeMs)[0];
cli("edit", "--project", DIR, JSON.stringify([{ op: "set_captions", enabled: false }]));
cli("export", "--project", DIR, "--quality", "draft", "--out", without);
cli("edit", "--project", DIR, JSON.stringify([{ op: "set_captions", enabled: true }]));

const { project, transcripts } = loadCaptionProject(DIR);
const { width: W, height: H, fps } = project.settings;
const style = project.captions;
const size = Math.round(style.fontSize * H);
const nFrames = Number(execFileSync("ffprobe", ["-v", "error", "-select_streams", "v", "-count_packets", "-show_entries", "stream=nb_read_packets", "-of", "csv=p=0", withCaps], { encoding: "utf8" }).trim());
console.log(`project ${DIR}\n${W}x${H} @ ${fps}, ${nFrames} frames, preset ${PRESET}, font ${size}px ${style.fontWeight} ${style.fontFamily}`);

// ---------------------------------------------------------------- 1. clock: same PNGs, same timestamps
{
  // Every PNG render.ts listed, named by its own cache key (render.ts png()), and the timestamp
  // ffmpeg's concat demuxer gave it, against caption-boxes' model of the same list.
  const files = readFileSync(join(capDir, list), "utf8").split("\n").filter((l) => l.startsWith("file ")).slice(0, -1).map((l) => l.slice(6, -1).split("/").pop()!.replace(".png", ""));
  const pts = execFileSync("ffprobe", ["-v", "error", "-f", "concat", "-safe", "0", "-i", join(capDir, list), "-select_streams", "v", "-show_entries", "packet=pts_time", "-of", "csv=p=0"], { encoding: "utf8" }).trim().split("\n").map(Number);
  const streams = exportCaptionEntries(project, transcripts);
  const entries = streams.length === 1 ? streams[0].entries : [];
  let names = 0, stamps = 0;
  entries.forEach((e, k) => {
    const cap = e.page ? { words: e.page.words.map((w) => [w.text, +(w.start - e.page!.start).toFixed(4)]), t: +(e.t - e.page.start).toFixed(4), style } : null;
    if (createHash("sha1").update(JSON.stringify([W, H, cap, null])).digest("hex").slice(0, 16) === files[k]) names++;
    if (Math.abs(pts[k] - e.pts) < 1e-6) stamps++;
  });
  console.log(`clock: ${entries.length} modelled caption PNGs vs ${files.length} in render.ts's list: ${names} same image, ${stamps} same ffmpeg timestamp`);
}

// ---------------------------------------------------------------- 2. renderCaptionWord == drawCaptionFrame
{
  let same = 0, n = 0;
  for (let f = 0; f < nFrames; f += 7) {
    const b = captionWordBoxes(project, transcripts, f / fps, W, H);
    if (!b.page) continue;
    const a = createCanvas(W, H), c = createCanvas(W, H);
    // (renderCaptionWord draws words only: compare without a page background.)
    drawCaptionFrame(a.getContext("2d") as unknown as Ctx2D, W, H, b.page, { ...style, background: null }, b.sampleTime!);
    // Drawn from JSON copies, as a compositor reading captions.json would.
    const cc = c.getContext("2d");
    for (const w of JSON.parse(JSON.stringify(b.words)) as CaptionWordBox[]) renderCaptionWord(cc, w);
    n++;
    if (a.data().equals(c.data())) same++;
  }
  console.log(`draw: renderCaptionWord (from JSON copies) is byte-identical to drawCaptionFrame in ${same}/${n} sampled frames`);
}

// ---------------------------------------------------------------- 3. boxes vs burned-in pixels, every frame
// The caption band, decoded as RGBA (even bounds, converted before cropping so no chroma rounding).
const band = { y: Math.max(0, 2 * Math.round((style.position * H - 2.2 * size) / 2)), h: 0 };
band.h = Math.min(H, 2 * Math.round((style.position * H + 2.2 * size) / 2)) - band.y;
const bandArgs = (file: string, only?: number) => ["-v", "error", "-i", file, "-vf", `${only === undefined ? "" : `select=eq(n\\,${only}),`}format=rgba,crop=${W}:${band.h}:0:${band.y}`, ...(only === undefined ? [] : ["-frames:v", "1"]), "-f", "rawvideo", "-pix_fmt", "rgba", "-"];
async function* frames(file: string) {
  const p = spawn("ffmpeg", bandArgs(file));
  const bytes = W * band.h * 4;
  let buf = Buffer.alloc(0);
  for await (const chunk of p.stdout) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= bytes) {
      yield buf.subarray(0, bytes);
      buf = buf.subarray(bytes);
    }
  }
}
const grab = (file: string, f: number) => execFileSync("ffmpeg", bandArgs(file, f), { maxBuffer: 1 << 26 });

const luma = (r: number, g: number, b: number) => 0.299 * r + 0.587 * g + 0.114 * b;
const hexLuma = (hex: string) => luma(parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16));
type Got = { x0: number; y0: number; x1: number; y1: number; yellow: boolean };
type Hit = { f: number; word: CaptionWordBox; got: Got | null; crowded: boolean; err: number[] };
/**
 * The burned-in fill of one word, near its computed box: pixels the captions changed that are past
 * half the fill colour's brightness (the glyph outline, anti-aliased over the black stroke), kept
 * only in blobs ringed by darker pixels, so encoder noise and the moving picture don't count.
 */
// Search margin around a computed box: big enough for a few px of error, smaller than a word gap.
const G = Math.round(Math.min(16, 0.14 * size));
function measure(a: Buffer, b: Buffer, w: CaptionWordBox): Got | null {
  const fl = hexLuma(w.color);
  const wx0 = Math.max(0, Math.floor(w.x - G)), wx1 = Math.min(W, Math.ceil(w.x + w.w + G));
  const wy0 = Math.max(0, Math.floor(w.y - G - band.y)), wy1 = Math.min(band.h, Math.ceil(w.y + w.h + G - band.y));
  const ww = wx1 - wx0, wh = wy1 - wy0;
  const cov = new Float32Array(ww * wh);
  const on = new Uint8Array(ww * wh);
  for (let y = 0; y < wh; y++)
    for (let x = 0; x < ww; x++) {
      const i = ((y + wy0) * W + x + wx0) * 4;
      const d = Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      cov[y * ww + x] = luma(a[i], a[i + 1], a[i + 2]) / fl;
      on[y * ww + x] = d >= 60 && cov[y * ww + x] >= 0.5 ? 1 : 0;
    }
  const label = new Int32Array(ww * wh).fill(-1);
  let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1, yel = 0, cnt = 0;
  for (let s = 0; s < on.length; s++) {
    if (!on[s] || label[s] >= 0) continue;
    const comp: number[] = [s];
    label[s] = s;
    for (let k = 0; k < comp.length; k++) {
      const p = comp[k], px = p % ww, py = (p / ww) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
        const q = ny * ww + nx;
        if (on[q] && label[q] < 0) (label[q] = s), comp.push(q);
      }
    }
    // Ring 2–3 px outside the blob: the stroke, so dark. Blobs touching the window edge are not glyphs.
    let ring = 0, rn = 0, edge = false;
    for (const p of comp) {
      const px = p % ww, py = (p / ww) | 0;
      if (px === 0 || py === 0 || px === ww - 1 || py === wh - 1) edge = true;
      for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3]]) {
        const nx = px + dx, ny = py + dy;
        if (nx < 0 || ny < 0 || nx >= ww || ny >= wh || label[ny * ww + nx] === s) continue;
        ring += cov[ny * ww + nx];
        rn++;
      }
    }
    if (comp.length < 30 || edge || ring / Math.max(1, rn) > 0.3) continue;
    for (const p of comp) {
      const px = (p % ww) + wx0, py = ((p / ww) | 0) + wy0 + band.y;
      x0 = Math.min(x0, px), x1 = Math.max(x1, px + 1), y0 = Math.min(y0, py), y1 = Math.max(y1, py + 1);
      const i = ((py - band.y) * W + px) * 4;
      cnt++;
      if (a[i] > 150 && a[i + 2] < 110) yel++;
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1, yellow: yel > cnt * 0.5 };
}

const hits: Hit[] = [];
// Which PNG is really burned into each frame: composite every nearby list entry over the
// caption-free frame and keep the closest; the clock is right if that draws what it predicts.
const entries = exportCaptionEntries(project, transcripts)[0].entries;
const pngs = new Map<number, Uint8ClampedArray>();
function entryBand(k: number) {
  let d = pngs.get(k);
  if (!d) {
    const c = createCanvas(W, H);
    const e = entries[k];
    if (e.page) drawCaptionFrame(c.getContext("2d") as unknown as Ctx2D, W, H, e.page, style, e.t);
    pngs.set(k, (d = c.getContext("2d").getImageData(0, band.y, W, band.h).data));
  }
  return d;
}
function composite(a: Buffer, b: Buffer, p: Uint8ClampedArray) {
  let err = 0;
  for (let i = 0; i < p.length; i += 12) {
    const al = p[i + 3] / 255;
    for (let ch = 0; ch < 3; ch++) err += Math.abs(a[i + ch] - (p[i + ch] * al + b[i + ch] * (1 - al)));
  }
  return err;
}
let clockOk = 0, clockN = 0;
{
  const A = frames(withCaps), B = frames(without);
  for (let f = 0; f < nFrames; f++) {
    const a = (await A.next()).value as Buffer, b = (await B.next()).value as Buffer;
    if (!a || !b) break;
    const boxes = captionWordBoxes(project, transcripts, f / fps, W, H);
    for (const w of boxes.words) {
      const got = measure(a, b, w);
      // Pop can scale a word into its neighbour's search margin; then the two can't be told apart.
      const crowded = boxes.words.some((o) => o !== w && o.x < w.x + w.w + G && o.x + o.w > w.x - G && o.y < w.y + w.h + G && o.y + o.h > w.y - G);
      hits.push({ f, word: w, got, crowded, err: got ? [got.x0 - w.x, got.y0 - w.y, got.x1 - (w.x + w.w), got.y1 - (w.y + w.h)] : [] });
    }
    const ft = f / fps;
    const near = entries.map((_, k) => k).filter((k) => Math.abs(entries[k].pts - ft) < 0.13);
    const before = entries.findLastIndex((e) => e.pts <= ft - 0.13);
    if (before >= 0) near.unshift(before);
    const errs = near.map((k) => composite(a, b, entryBand(k)));
    const best = Math.min(...errs);
    // The predicted state, drawn the same way; it must be (one of) the closest candidates.
    const c = createCanvas(W, H);
    if (boxes.page) drawCaptionFrame(c.getContext("2d") as unknown as Ctx2D, W, H, boxes.page, style, boxes.sampleTime!);
    clockN++;
    if (composite(a, b, c.getContext("2d").getImageData(0, band.y, W, band.h).data) <= best * 1.01) clockOk++;
  }
}
console.log(`clock: the predicted caption state is the closest match to the burned-in pixels in ${clockOk}/${clockN} frames`);
const found = hits.filter((h) => h.got);
const clear = found.filter((h) => !h.crowded);
const edges = ["left", "top", "right", "bottom"];
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))];
const worstErr = (h: Hit) => Math.max(...h.err.map(Math.abs));
const stateOk = found.filter((h) => h.got!.yellow === (h.word.isActive && h.word.color.toLowerCase() === style.highlightColor.toLowerCase())).length;
console.log(`boxes: ${found.length}/${hits.length} word boxes found in ${new Set(hits.map((h) => h.f)).size} captioned frames; highlight state matches in ${stateOk}/${found.length}`);
console.log(`  ${clear.length} words stand clear of their neighbours (${found.length - clear.length} have one within the ${G} px search margin):`);
for (let e = 0; e < 4; e++) {
  const xs = clear.map((h) => h.err[e]);
  console.log(`  ${edges[e].padEnd(6)} error px: mean ${mean(xs).toFixed(2)}  mean|.| ${mean(xs.map(Math.abs)).toFixed(2)}  p95|.| ${pct(xs.map(Math.abs), 0.95).toFixed(2)}  max|.| ${Math.max(...xs.map(Math.abs)).toFixed(2)}`);
}
for (const [name, set] of [["clear", clear], ["all", found]] as const) {
  const abs = set.flatMap((h) => h.err.map(Math.abs));
  console.log(`  ${name.padEnd(5)} words, all edges: mean|.| ${mean(abs).toFixed(2)} px, p95 ${pct(abs, 0.95).toFixed(2)} px, max ${Math.max(...abs).toFixed(2)} px; every edge within 3 px: ${set.filter((h) => worstErr(h) <= 3).length}/${set.length}`);
}
const worst = [...found].sort((a, b) => worstErr(b) - worstErr(a));
for (const h of worst.slice(0, 4)) console.log(`  worst: frame ${h.f} "${h.word.displayText}" scale ${h.word.scale.toFixed(3)}${h.crowded ? " (neighbour within margin)" : ""} err [${h.err.map((e) => e.toFixed(1)).join(", ")}]`);
const worstClear = [...clear].sort((a, b) => worstErr(b) - worstErr(a));

// ---------------------------------------------------------------- picture
{
  // Rows: the caption band of a few frames (a pop entrance, a held word, later pages) with the
  // computed boxes; then 2× insets of a popping word and of the worst-measured word.
  const pick: number[] = [];
  for (let f = 0; f < nFrames && pick.length < 4; f++) {
    const act = captionWordBoxes(project, transcripts, f / fps, W, H).words.find((w) => w.isActive);
    if (act && Math.round((f / fps - act.start) * fps) === (pick.length % 2 ? 6 : 2) && !pick.some((p) => Math.abs(p - f) < fps * 1.5)) pick.push(f);
  }
  // Styles without a highlighted word: frames spread over the captioned ones.
  const captioned = [...new Set(found.map((h) => h.f))];
  for (let k = 0; pick.length < 4 && k < 4; k++) pick.push(captioned[Math.floor(((k + 0.5) * captioned.length) / 4)]);
  const popping = found.find((h) => h.f === pick[0] && h.word.isActive) ?? found[0];
  const insets = [popping, worstClear[0]];
  const zoom = 2, zh = Math.round(size * 1.7) * zoom;
  const canvas = createCanvas(W, pick.length * band.h + insets.length * zh);
  const ctx = canvas.getContext("2d") as SKRSContext2D;
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const toCanvas = (img: Buffer) => {
    const c = createCanvas(W, band.h);
    c.getContext("2d").putImageData(new ImageData(new Uint8ClampedArray(img.buffer, img.byteOffset, img.length), W, band.h), 0, 0);
    return c;
  };
  const outline = (b: { x: number; y: number; width: number; height: number }, color: string, dash: number[] = []) => {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.strokeRect(b.x + 0.5, b.y + 0.5, b.width - 1, b.height - 1);
    ctx.restore();
  };
  const label = (text: string, y: number) => {
    ctx.font = "600 24px Menlo, monospace";
    ctx.lineWidth = 5;
    ctx.strokeStyle = "#000";
    ctx.strokeText(text, 16, y);
    ctx.fillStyle = "#00e5ff";
    ctx.fillText(text, 16, y);
  };
  pick.forEach((f, r) => {
    const top = r * band.h;
    ctx.drawImage(toCanvas(grab(withCaps, f)), 0, top);
    const boxes = captionWordBoxes(project, transcripts, f / fps, W, H);
    for (const w of boxes.words) {
      outline(mapBox(w, W, H, { x: 0, y: top - band.y, width: W, height: H }), "#00e5ff");
      outline({ x: w.outer.x, y: w.outer.y + top - band.y, width: w.outer.width, height: w.outer.height }, "#ff3df2", [4, 4]);
    }
    const errs = hits.filter((h) => h.f === f && h.got).map(worstErr);
    label(`frame ${f} · t ${(f / fps).toFixed(3)}s · caption sample ${boxes.sampleTime?.toFixed(3)}s · worst edge ${Math.max(...errs).toFixed(1)}px`, top + 30);
  });
  insets.forEach((h, k) => {
    const top = pick.length * band.h + k * zh;
    const src = toCanvas(grab(withCaps, h.f));
    const w = h.word;
    const sx = w.cx - W / zoom / 2, sy = w.cy - band.y - zh / zoom / 2;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, top, W, zh);
    ctx.clip();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, sx, sy, W / zoom, zh / zoom, 0, top, W, zh);
    const z = (x: number, y: number, bw: number, bh: number) => ({ x: (x - sx) * zoom, y: top + (y - band.y - sy) * zoom, width: bw * zoom, height: bh * zoom });
    for (const o of hits.filter((x) => x.f === h.f)) {
      outline(z(o.word.x, o.word.y, o.word.w, o.word.h), "#00e5ff");
      if (o.got) outline(z(o.got.x0, o.got.y0, o.got.x1 - o.got.x0, o.got.y1 - o.got.y0), "#7cff4f", [3, 3]);
    }
    ctx.restore();
    label(`${zoom}× frame ${h.f} "${w.displayText}" ${k ? "worst clear word" : "popping"} ×${w.scale.toFixed(3)}: error L/T/R/B ${h.err.map((e) => e.toFixed(1)).join(" ")} px`, top + 30);
    label(`cyan: computed ink box · green: measured fill · magenta (rows): ink + stroke`, top + 60);
  });
  const png = join(OUT, PRESET === "pop" && ASPECT === "9:16" ? "caption-boxes-check.png" : `caption-boxes-check-${PRESET}-${ASPECT.replace(":", "x")}.png`);
  writeFileSync(png, canvas.toBuffer("image/png"));
  console.log(png);
}
// The scratch project and exports go unless CAPBOX_WORK asked to keep them.
if (!process.env.CAPBOX_WORK) rmSync(WORK, { recursive: true, force: true });
