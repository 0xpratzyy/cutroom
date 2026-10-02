import assert from "node:assert/strict";
import { test } from "node:test";
import { findRetakes, useTakeOps } from "../src/core/shared/retakes.ts";
import { applyOps } from "../src/core/shared/ops.ts";
import { mapWords } from "../src/core/shared/timeline.ts";
import type { Transcript } from "../src/core/shared/types.ts";

// Build a transcript from "word@start" tokens, each word 0.25s long.
function tr(spec: string): Transcript {
  const words = spec.split(/\s+/).map((tok, i) => {
    const [text, at] = tok.split("@");
    const start = Number(at);
    return { i, text, start, end: start + 0.25 };
  });
  return { mediaId: "m1", backend: "t", model: "t", language: "en", words };
}

const clips = (out: number) => ({ clips: [{ id: "c1", mediaId: "m1", in: 0, out }] });

test("finds a false start and suggests the finished take", () => {
  const t = tr("So@0 today@0.3 I@0.6 want@0.9 to...@1.2 so@2.5 today@2.8 I@3.1 want@3.4 to@3.7 show@4 you@4.3 editing.@4.6 Next@6 topic.@6.3");
  const groups = findRetakes(clips(8), { m1: t });
  assert.equal(groups.length, 1);
  assert.equal(groups[0].takes.length, 2);
  assert.equal(groups[0].best, 1);
  assert.match(groups[0].takes[1].text, /show you editing/);
});

test("finds a full redo and prefers the fluent take", () => {
  const t = tr("This@0 is@0.3 um,@0.6 the@0.9 best@1.2 part@1.5 of@1.8 it.@2.1 This@3.5 is@3.8 the@4.1 best@4.4 part@4.7 of@5 it.@5.3");
  const g = findRetakes(clips(7), { m1: t });
  assert.equal(g.length, 1);
  assert.equal(g[0].best, 1, "no filler in the second take");
});

test("doesn't flag unrelated sentences", () => {
  const t = tr("Welcome@0 back@0.3 to@0.6 the@0.9 channel.@1.2 Today@2.5 we@2.8 talk@3.1 about@3.4 cameras.@3.7");
  assert.equal(findRetakes(clips(5), { m1: t }).length, 0);
});

test("using a take cuts the others", () => {
  const t = tr("So@0 today@0.3 I@0.6 want@0.9 to...@1.2 so@2.5 today@2.8 I@3.1 want@3.4 to@3.7 show@4 you@4.3 editing.@4.6");
  const p = { version: 1, name: "t", createdAt: "", updatedAt: "", settings: {} as never, media: [{ id: "m1", name: "a", path: "/a", kind: "video" as const, duration: 6, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true, analysis: {} }], clips: clips(6).clips, overlays: [], zooms: [], captions: {} as never, look: {} as never, hook: {} as never, watermark: {} as never, audio: {} as never };
  const g = findRetakes(p, { m1: t })[0];
  const after = applyOps({ ...p, settings: { width: 1920, height: 1080, fps: 30, background: "#000000", normalizeAudio: true, cutFadeMs: 12 }, captions: { maxWords: 4 } as never }, useTakeOps(g, g.best), { transcripts: { m1: t }, silences: {} }).project;
  const kept = mapWords(after, t).filter((w) => w.kept).map((w) => w.word.text).join(" ");
  assert.equal(kept, "so today I want to show you editing.");
});
