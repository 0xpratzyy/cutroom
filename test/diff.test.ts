import assert from "node:assert/strict";
import { test } from "node:test";
import { diffProjects } from "../src/core/shared/diff.ts";
import { applyOps, type EditContext } from "../src/core/shared/ops.ts";
import { timelineDuration } from "../src/core/shared/timeline.ts";
import { DEFAULT_AUDIO, DEFAULT_CAPTIONS, DEFAULT_HOOK, DEFAULT_LOOK, DEFAULT_SETTINGS, DEFAULT_WATERMARK, type Project, type Transcript } from "../src/core/shared/types.ts";

const transcript: Transcript = {
  mediaId: "m1",
  backend: "test",
  model: "test",
  language: "en",
  words: [
    { i: 0, text: "Hello", start: 0.0, end: 0.5 },
    { i: 1, text: "um,", start: 0.6, end: 0.9 },
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

test("diff lists cuts with the words removed, plus zooms and style changes", () => {
  const before = project();
  const after = applyOps(before, [{ op: "remove_fillers" }, { op: "add_zoom", start: 3, end: 4 }, { op: "set_captions", preset: "karaoke" }, { op: "set_look", lut: "warm" }], ctx).project;
  const changes = diffProjects(before, after, ctx.transcripts);
  const kinds = changes.map((c) => c.kind).sort();
  assert.deepEqual(kinds, ["cut", "style", "style", "zoom"]);
  const cut = changes.find((c) => c.kind === "cut")!;
  assert.match(cut.label, /um/);
  assert.ok(cut.delta < 0);
});

test("reverting every change restores the original edit", () => {
  const before = project();
  const after = applyOps(before, [{ op: "remove_fillers" }, { op: "remove_silences" }, { op: "add_zoom", start: 1, end: 2 }, { op: "add_broll", mediaId: "m2", start: 0.5, duration: 1 }, { op: "set_captions", preset: "pop" }], ctx).project;
  let p = after;
  for (const c of diffProjects(before, after, ctx.transcripts)) p = applyOps(p, c.revert, ctx).project;
  const left = diffProjects(before, p, ctx.transcripts);
  assert.equal(left.length, 0, "nothing left to review: " + JSON.stringify(left.map((c) => [c.id, c.label])) + JSON.stringify(p.zooms) + JSON.stringify(p.overlays));
  assert.ok(Math.abs(timelineDuration(p) - timelineDuration(before)) < 1e-6);
});

test("restores show up as additions and revert to cuts", () => {
  const cut = applyOps(project(), [{ op: "remove_words", mediaId: "m1", from: 3, to: 4 }], ctx).project;
  const restored = applyOps(cut, [{ op: "restore_words", mediaId: "m1", from: 3, to: 4 }], ctx).project;
  const changes = diffProjects(cut, restored, ctx.transcripts);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].kind, "restore");
  const back = applyOps(restored, changes[0].revert, ctx).project;
  assert.equal(diffProjects(cut, back, ctx.transcripts).length, 0);
});

test("items that only slide along with a cut are not reported as changes", () => {
  const before = applyOps(project(), [{ op: "add_zoom", start: 4, end: 4.5 }, { op: "add_broll", mediaId: "m2", start: 4.2, duration: 0.5 }], ctx).project;
  const after = applyOps(before, [{ op: "remove_words", mediaId: "m1", from: 1, to: 1 }], ctx).project;
  const kinds = diffProjects(before, after, ctx.transcripts).map((c) => c.kind);
  assert.deepEqual(kinds, ["cut"]);
});
