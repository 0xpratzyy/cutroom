import assert from "node:assert/strict";
import { test } from "node:test";
import { applyOps, EditError, restoreSourceRange, type EditContext } from "../src/core/shared/ops.ts";
import { parseOps } from "../src/core/opSchema.ts";
import { buildPlan } from "../src/core/shared/plan.ts";
import { paginateCaptions } from "../src/core/shared/captions.ts";
import { computeCrop, mapWords, placeClips, timelineDuration, timelineWords } from "../src/core/shared/timeline.ts";
import { DEFAULT_AUDIO, DEFAULT_CAPTIONS, DEFAULT_HOOK, DEFAULT_LOOK, DEFAULT_SETTINGS, DEFAULT_WATERMARK, type Project, type Transcript } from "../src/core/shared/types.ts";

// "hello um world . this is great" with a 2s pause after "world."
const transcript: Transcript = {
  mediaId: "m1",
  backend: "test",
  model: "test",
  language: "en",
  words: [
    { i: 0, text: "Hello", start: 0.0, end: 0.5 },
    { i: 1, text: "um,", start: 0.6, end: 0.9, filler: true },
    { i: 2, text: "world.", start: 1.0, end: 1.5 },
    { i: 3, text: "This", start: 3.5, end: 3.8 },
    { i: 4, text: "is", start: 3.9, end: 4.1 },
    { i: 5, text: "great.", start: 4.2, end: 4.8 },
  ],
};

const ctx: EditContext = { transcripts: { m1: transcript }, silences: { m1: [{ start: 1.5, end: 3.5 }] } };

function project(): Project {
  return {
    version: 1,
    name: "t",
    createdAt: "",
    updatedAt: "",
    settings: { ...DEFAULT_SETTINGS },
    media: [
      { id: "m1", name: "a.mp4", path: "/a.mp4", kind: "video", duration: 6, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true, analysis: {} },
      { id: "m2", name: "b.mp4", path: "/b.mp4", kind: "video", duration: 10, width: 1280, height: 720, fps: 30, hasAudio: false, hasVideo: true, analysis: {} },
    ],
    clips: [{ id: "c1", mediaId: "m1", in: 0, out: 6 }],
    overlays: [],
    zooms: [],
    captions: { ...DEFAULT_CAPTIONS },
    look: { ...DEFAULT_LOOK },
    hook: { ...DEFAULT_HOOK },
    watermark: { ...DEFAULT_WATERMARK },
    audio: { ...DEFAULT_AUDIO },
  };
}

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);

test("cut splits a clip and ripples overlays/zooms after it", () => {
  let p = project();
  p = applyOps(p, [{ op: "add_broll", mediaId: "m2", start: 4, duration: 1 }, { op: "add_zoom", start: 5, end: 5.5 }], ctx).project;
  const { project: q } = applyOps(p, [{ op: "cut", start: 1, end: 2 }], ctx);
  assert.equal(q.clips.length, 2);
  assert.deepEqual(q.clips.map((c) => [c.in, c.out]), [[0, 1], [2, 6]]);
  close(timelineDuration(q), 5);
  close(q.overlays[0].start, 3);
  close(q.zooms[0].start, 4);
});

test("cut shortens overlays that span the removed range", () => {
  let p = applyOps(project(), [{ op: "add_broll", mediaId: "m2", start: 1, duration: 3 }], ctx).project;
  p = applyOps(p, [{ op: "cut", start: 2, end: 3 }], ctx).project;
  close(p.overlays[0].start, 1);
  close(p.overlays[0].duration, 2);
});

test("remove_words cuts the word plus the gap after it, and restore_words brings it back", () => {
  const removed = applyOps(project(), [{ op: "remove_words", mediaId: "m1", from: 1, to: 1 }], ctx).project;
  const kept = mapWords(removed, transcript).filter((w) => w.kept).map((w) => w.word.text);
  assert.deepEqual(kept, ["Hello", "world.", "This", "is", "great."]);
  // [0.58, 1.0] removed: from just after "Hello" to the start of "world."
  close(timelineDuration(removed), 6 - (1.0 - 0.58));

  const restored = applyOps(removed, [{ op: "restore_words", mediaId: "m1", from: 1, to: 1 }], ctx).project;
  assert.equal(restored.clips.length, 1, "neighbouring clips merge back together");
  close(timelineDuration(restored), 6);
});

test("remove_text matches case- and punctuation-insensitively", () => {
  const { project: p, notes } = applyOps(project(), [{ op: "remove_text", text: "this IS" }], ctx);
  assert.match(notes[0], /removed 1 occurrence/);
  const kept = mapWords(p, transcript).filter((w) => w.kept).map((w) => w.word.text);
  assert.deepEqual(kept, ["Hello", "um,", "world.", "great."]);
  assert.throws(() => applyOps(p, [{ op: "remove_text", text: "this is" }], ctx), EditError);
});

test("remove_fillers and remove_silences", () => {
  const { project: p } = applyOps(project(), [{ op: "remove_fillers" }, { op: "remove_silences", minDuration: 0.6, keep: 0.2 }], ctx);
  const kept = mapWords(p, transcript).filter((w) => w.kept).map((w) => w.word.text);
  assert.deepEqual(kept, ["Hello", "world.", "This", "is", "great."]);
  // filler cut 0.42s, silence 2s - 0.4s kept = 1.6s
  close(timelineDuration(p), 6 - 0.42 - 1.6, 1e-3);
});

test("edits are atomic: one bad op rejects the whole batch", () => {
  const p = project();
  assert.throws(() => applyOps(p, [{ op: "cut", start: 0, end: 1 }, { op: "remove_clip", id: "nope" }], ctx), /op #1/);
  assert.equal(p.clips.length, 1, "input project is never mutated");
});

test("zooms can't overlap", () => {
  const p = applyOps(project(), [{ op: "add_zoom", start: 1, end: 2 }], ctx).project;
  assert.throws(() => applyOps(p, [{ op: "add_zoom", start: 1.5, end: 3 }], ctx), /overlaps/);
});

test("split and trim keep the timeline contiguous", () => {
  let p = applyOps(project(), [{ op: "split", at: 2 }], ctx).project;
  assert.equal(p.clips.length, 2);
  p = applyOps(p, [{ op: "trim_clip", id: p.clips[0].id, out: 1.5 }], ctx).project;
  const placed = placeClips(p);
  close(placed[1].start, 1.5);
  close(timelineDuration(p), 5.5);
});

test("set_settings aspect presets", () => {
  const p = applyOps(project(), [{ op: "set_settings", aspect: "9:16" }], ctx).project;
  assert.equal(p.settings.width, 1080);
  assert.equal(p.settings.height, 1920);
  assert.throws(() => applyOps(project(), [{ op: "set_settings", aspect: "7:3" }], ctx), /unknown aspect/);
});

test("plan splits pieces at zoom boundaries", () => {
  const p = applyOps(project(), [{ op: "add_zoom", start: 2, end: 3, scale: 1.5 }], ctx).project;
  const plan = buildPlan(p, ctx.transcripts);
  assert.deepEqual(plan.pieces.map((x) => [x.start, x.end, x.zoom]), [[0, 2, 1], [2, 3, 1.5], [3, 6, 1]]);
  const ranged = buildPlan(p, ctx.transcripts, { start: 2.5, end: 4 });
  assert.deepEqual(ranged.pieces.map((x) => [x.start, x.end, x.srcIn]), [[0, 0.5, 2.5], [0.5, 1.5, 3]]);
});

test("captions page by word count and sentence ends", () => {
  const pages = paginateCaptions(timelineWords(project(), ctx.transcripts), { ...DEFAULT_CAPTIONS, maxWords: 2 });
  assert.deepEqual(pages.map((pg) => pg.words.map((w) => w.text).join(" ")), ["Hello um,", "world.", "This is", "great."]);
});

test("computeCrop covers the frame and clamps focus to the edges", () => {
  const c = computeCrop(1920, 1080, 1080, 1920, 1, { x: 0.5, y: 0.5 });
  assert.equal(c.height, 1920);
  assert.ok(c.width >= 1080);
  close(c.x, Math.round((c.width - 1080) / 2), 1);
  const left = computeCrop(1920, 1080, 1080, 1920, 1, { x: 0, y: 0.5 });
  assert.equal(left.x, 0);
});

test("restore across several cuts ripples each gap at its own position", () => {
  let p = applyOps(project(), [{ op: "cut_source", mediaId: "m1", start: 1, end: 2 }, { op: "cut_source", mediaId: "m1", start: 3, end: 4 }], ctx).project;
  // clips [0,1] [2,3] [4,6]; b-roll over source 2.5 (timeline 1.5), zoom over source 4.5-5 (timeline 2.5-3)
  p = applyOps(p, [{ op: "add_broll", mediaId: "m2", start: 1.5, duration: 0.2 }, { op: "add_zoom", start: 2.5, end: 3 }], ctx).project;
  const added = restoreSourceRange(p, "m1", { start: 0.5, end: 4.5 });
  close(added, 2);
  assert.deepEqual(p.clips.map((c) => [c.in, c.out]), [[0, 6]]);
  close(p.overlays[0].start, 2.5);
  close(p.zooms[0].start, 4.5);
  close(p.zooms[0].end, 5);
});

test("restoring the last word near the end of the media clamps to its duration", () => {
  const t: Transcript = { ...transcript, words: [...transcript.words, { i: 6, text: "Bye.", start: 5.5, end: 5.99 }] };
  const c: EditContext = { transcripts: { m1: t }, silences: {} };
  const removed = applyOps(project(), [{ op: "remove_words", mediaId: "m1", from: 6, to: 6 }], c).project;
  const restored = applyOps(removed, [{ op: "restore_words", mediaId: "m1", from: 6, to: 6 }], c).project;
  assert.deepEqual(restored.clips.map((x) => [x.in, x.out]), [[0, 6]]);
});

test("timelineWords captions every appearance of a reused source range", () => {
  const p = { ...project(), clips: [{ id: "hook", mediaId: "m1", in: 3.5, out: 4.8 }, { id: "c1", mediaId: "m1", in: 0, out: 6 }] };
  const words = timelineWords(p, ctx.transcripts);
  assert.deepEqual(words.map((w) => w.word.text), ["This", "is", "great.", "Hello", "um,", "world.", "This", "is", "great."]);
  close(words[6].start, 1.3 + 3.5);
  assert.equal(mapWords(p, transcript).length, 6, "mapWords still has one entry per word");
});

test("restore doesn't merge a deliberate repeat into its source", () => {
  let p = { ...project(), clips: [{ id: "c1", mediaId: "m1", in: 0, out: 6 }, { id: "rep", mediaId: "m1", in: 3.5, out: 4.8 }] };
  p = applyOps(p, [{ op: "remove_words", mediaId: "m1", from: 1, to: 1 }], ctx).project;
  p = applyOps(p, [{ op: "restore_words", mediaId: "m1", from: 1, to: 1 }], ctx).project;
  assert.deepEqual(p.clips.map((c) => [c.in, c.out]), [[0, 6], [3.5, 4.8]]);
});

test("add_zoom defaults its focus to the clip's framing", () => {
  let p = applyOps(project(), [{ op: "add_zoom", start: 0, end: 1 }], ctx).project;
  assert.deepEqual(p.zooms[0].focus, { x: 0.5, y: 0.4 });
  p = applyOps(project(), [{ op: "set_focus", x: 0.2, y: 0.7 }, { op: "add_zoom", start: 1, end: 2 }, { op: "add_zoom", start: 3, end: 4, x: 0.9 }], ctx).project;
  assert.deepEqual(p.zooms.map((z) => z.focus), [{ x: 0.2, y: 0.7 }, { x: 0.9, y: 0.7 }]);
});

test("update_zoom can't create an overlap", () => {
  const p = applyOps(project(), [{ op: "add_zoom", start: 1, end: 2 }, { op: "add_zoom", start: 3, end: 4 }], ctx).project;
  assert.throws(() => applyOps(p, [{ op: "update_zoom", id: p.zooms[1].id, start: 1.5 }], ctx), /overlaps/);
  applyOps(p, [{ op: "update_zoom", id: p.zooms[1].id, start: 2 }], ctx);
});

test("update_overlay keeps the source in-point within the media", () => {
  const p = applyOps(project(), [{ op: "add_broll", mediaId: "m2", start: 0, duration: 4 }], ctx).project;
  const id = p.overlays[0].id;
  assert.throws(() => applyOps(p, [{ op: "update_overlay", id, in: 12 }], ctx), /in must be within/);
  const q = applyOps(p, [{ op: "update_overlay", id, in: 8 }], ctx).project;
  close(q.overlays[0].duration, 2);
});

test("move_clip carries the overlays and zooms inside the clip", () => {
  let p = applyOps(project(), [{ op: "split", at: 2 }], ctx).project;
  const [c1] = p.clips;
  p = applyOps(p, [{ op: "add_broll", mediaId: "m2", start: 0.5, duration: 1 }, { op: "add_zoom", start: 3, end: 4 }], ctx).project;
  p = applyOps(p, [{ op: "move_clip", id: c1.id, index: 1 }], ctx).project;
  assert.equal(p.clips[1].id, c1.id);
  close(p.overlays[0].start, 4.5);
  close(p.zooms[0].start, 1);
  close(p.zooms[0].end, 2);
});

test("op validation: silences thresholds and background color", () => {
  assert.throws(() => applyOps(project(), [{ op: "remove_silences", keep: -1 }], ctx), />= 0/);
  assert.throws(() => applyOps(project(), [{ op: "set_settings", background: "red:drawbox" }], ctx), /background/);
  assert.throws(() => parseOps([{ op: "set_settings", background: "#fff" }]), /background/);
  assert.throws(() => parseOps([{ op: "remove_silences", minDuration: -0.1 }]), /minDuration/);
  assert.throws(() => parseOps([]), EditError);
  assert.deepEqual(parseOps([{ op: "cut", start: 1, end: 2, junk: true }]), [{ op: "cut", start: 1, end: 2 }]);
});

test("eased zooms ramp in and out", async () => {
  const { pieceZoomAt } = await import("../src/core/shared/plan.ts");
  const p = applyOps(project(), [{ op: "add_zoom", start: 2, end: 4, scale: 1.5, ease: 0.5 }], ctx).project;
  const plan = buildPlan(p, ctx.transcripts);
  const spans = plan.pieces.map((x) => [x.start, x.end, +x.zoom.toFixed(3), +x.zoomTo.toFixed(3)]);
  assert.deepEqual(spans, [[0, 2, 1, 1], [2, 2.5, 1, 1.5], [2.5, 3.5, 1.5, 1.5], [3.5, 4, 1.5, 1], [4, 6, 1, 1]]);
  const ramp = plan.pieces[1];
  assert.ok(pieceZoomAt(ramp, 2.25) > 1 && pieceZoomAt(ramp, 2.25) < 1.5);
  assert.equal(pieceZoomAt(ramp, 2.5), 1.5);
});

test("jump_cut_zoom punches in on every other clip after a cut", () => {
  const cut = applyOps(project(), [{ op: "cut", start: 1, end: 1.5 }, { op: "cut", start: 2.5, end: 3 }], ctx).project;
  assert.equal(cut.clips.length, 3);
  const p = applyOps(cut, [{ op: "jump_cut_zoom" }], ctx).project;
  const placed = placeClips(p);
  assert.equal(p.zooms.length, 1);
  close(p.zooms[0].start, placed[1].start);
  close(p.zooms[0].end, placed[1].end);
});

test("word mapping handles out-of-order transcripts and stays fast at 1-hour scale", () => {
  const unsorted: Transcript = { ...transcript, words: [transcript.words[1], transcript.words[0], ...transcript.words.slice(2)].map((w, i) => ({ ...w, i })) };
  const kept = mapWords(project(), unsorted).filter((w) => w.kept).length;
  assert.equal(kept, unsorted.words.length);

  // ~11k words, ~800 clips
  const words = Array.from({ length: 11000 }, (_, i) => ({ i, text: "w", start: i * 0.33, end: i * 0.33 + 0.25 }));
  const big: Transcript = { ...transcript, words };
  const clips = Array.from({ length: 800 }, (_, k) => ({ id: `c${k}`, mediaId: "m1", in: k * 4.5, out: k * 4.5 + 4 }));
  const t0 = performance.now();
  const n = mapWords({ clips }, big).filter((w) => w.kept).length;
  const tw = timelineWords({ clips }, { m1: big }).length;
  const ms = performance.now() - t0;
  assert.ok(n > 9000 && tw === n, `${n} / ${tw}`);
  assert.ok(ms < 60, `took ${ms.toFixed(1)}ms`);
});
