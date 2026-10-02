// Regression tests for real-world media handling: probing odd files, analysis parsers,
// render segment timing, chunked rendering and the undo history store.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { interpretProbe } from "../src/core/ffmpeg.ts";
import { needsProxy, PeakAccumulator, projectFps, SilenceParser } from "../src/core/media.ts";
import { audioSegment, chunkRanges, snapToFrame, standardRate, videoSegment } from "../src/core/render.ts";
import { lineSplitter } from "../src/core/transcribe.ts";
import { ProjectStore } from "../src/core/project.ts";
import type { PlanPiece } from "../src/core/shared/plan.ts";

const video = (extra: Record<string, unknown> = {}) => ({ codec_type: "video", codec_name: "h264", width: 1920, height: 1080, pix_fmt: "yuv420p", avg_frame_rate: "30/1", r_frame_rate: "30/1", start_time: "0", duration: "10", ...extra });
const audio = (extra: Record<string, unknown> = {}) => ({ codec_type: "audio", codec_name: "aac", start_time: "0", duration: "10", ...extra });

test("probe: phone rotation swaps the displayed size", () => {
  for (const rotation of [90, -90, 270]) {
    const p = interpretProbe({ format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10" }, streams: [video({ side_data_list: [{ rotation }] }), audio()] });
    assert.equal(p.width, 1080);
    assert.equal(p.height, 1920);
    assert.equal(p.rotation, rotation);
  }
  const upside = interpretProbe({ format: { format_name: "mov", duration: "10" }, streams: [video({ side_data_list: [{ rotation: 180 }] })] });
  assert.equal(upside.width, 1920);
});

test("probe: images vs. animations vs. silent MJPEG video", () => {
  const png = interpretProbe({ format: { format_name: "png_pipe" }, streams: [video({ codec_name: "png", duration: undefined, avg_frame_rate: "25/1" })] });
  assert.equal(png.isImage, true);
  assert.equal(png.duration, 0);
  const jpg = interpretProbe({ format: { format_name: "image2", duration: "0.04" }, streams: [video({ codec_name: "mjpeg", duration: "0.04" })] });
  assert.equal(jpg.isImage, true);
  const gif = interpretProbe({ format: { format_name: "gif", duration: "3" }, streams: [video({ codec_name: "gif", nb_frames: "30", duration: "3" })] });
  assert.equal(gif.isImage, false, "an animated GIF is a clip");
  assert.equal(gif.duration, 3);
  const webcam = interpretProbe({ format: { format_name: "avi", duration: "60" }, streams: [video({ codec_name: "mjpeg", duration: "60" })] });
  assert.equal(webcam.isImage, false, "MJPEG video without audio is still video");
  const svg = interpretProbe({ format: { format_name: "svg_pipe" }, streams: [video({ codec_name: "svg", width: 0, height: 0 })] });
  assert.equal(svg.undecodable, true);
});

test("probe: late audio, 10-bit, VFR averages", () => {
  const p = interpretProbe({ format: { format_name: "mov", duration: "25.6", start_time: "0" }, streams: [video({ duration: "23.6", pix_fmt: "yuv420p10le", codec_name: "hevc", avg_frame_rate: "17880/473" }), audio({ start_time: "1.978", duration: "23.655" })] });
  assert.equal(p.audioStart, 1.978);
  assert.ok(Math.abs(p.audioEnd! - 25.633) < 1e-6);
  assert.ok(Math.abs(p.videoEnd! - 23.6) < 1e-6);
  assert.equal(p.bitDepth, 10);
  assert.equal(p.fps, 37.801);
});

test("projectFps snaps odd averages to a common output rate", () => {
  assert.equal(projectFps(37.895), 30);
  assert.equal(projectFps(23.976), 24);
  assert.equal(projectFps(29.97), 30);
  assert.equal(projectFps(59.94), 60);
  assert.equal(projectFps(50), 50);
  assert.equal(projectFps(119.88), 60);
  assert.equal(projectFps(NaN), 30);
});

test("needsProxy: HEVC, 10-bit, PCM audio, 4K and odd containers get a proxy", () => {
  const base = { videoCodec: "h264", pixFmt: "yuv420p", audioCodec: "aac", width: 1920, height: 1080 };
  assert.equal(needsProxy(base, "a.mp4"), false);
  assert.equal(needsProxy({ ...base, width: 1080, height: 1920 }, "phone.mov"), false, "portrait 1080p plays fine");
  assert.equal(needsProxy({ ...base, videoCodec: "hevc" }, "a.mov"), true);
  assert.equal(needsProxy({ ...base, pixFmt: "yuv420p10le" }, "a.mp4"), true);
  assert.equal(needsProxy({ ...base, videoCodec: "prores", pixFmt: "yuv422p10le" }, "a.mov"), true);
  assert.equal(needsProxy({ ...base, audioCodec: "pcm_s16le" }, "a.mov"), true);
  assert.equal(needsProxy({ ...base, width: 3840, height: 2160 }, "a.mp4"), true);
  assert.equal(needsProxy(base, "a.mkv"), true);
});

test("PeakAccumulator: streamed chunks (even split mid-sample) match one buffer", () => {
  const n = 1000;
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(Math.sin(i / 7) * 30000 * ((i % 160) / 160)), i * 2);
  const whole = new PeakAccumulator(160);
  whole.push(buf);
  const parts = new PeakAccumulator(160);
  for (let o = 0; o < buf.length; o += 37) parts.push(buf.subarray(o, Math.min(buf.length, o + 37)));
  assert.deepEqual(parts.finish(), whole.finish());
  assert.equal(whole.peaks.length, Math.ceil(n / 160));
});

test("SilenceParser handles negative starts and an open silence at the end", () => {
  const p = new SilenceParser();
  for (const l of ["[silencedetect @ 0x1] silence_start: -0.0213", "[silencedetect @ 0x1] silence_end: 1.5 | silence_duration: 1.52", "size=N/A time=00:00:02", "[silencedetect @ 0x1] silence_start: 8.25"]) p.line(l);
  assert.deepEqual(p.finish(10), [
    { start: 0, end: 1.5 },
    { start: 8.25, end: 10 },
  ]);
});

test("lineSplitter carries partial lines across chunks", () => {
  const lines: string[] = [];
  const feed = lineSplitter((l) => lines.push(l));
  feed('{"progress": 0.1}\n{"prog');
  feed('ress": 0.2}\n');
  assert.deepEqual(lines, ['{"progress": 0.1}', '{"progress": 0.2}']);
});

test("segment timing: VFR sources are not snapped to a fake frame grid", () => {
  assert.equal(standardRate(37.895), null);
  assert.ok(Math.abs(standardRate(29.97)! - 30000 / 1001) < 1e-9);
  assert.equal(snapToFrame(1.234567, 37.895), 1.234567);
  assert.equal(standardRate(30), 30);
  assert.equal(standardRate(23.976), 24000 / 1001);
  assert.ok(Math.abs(snapToFrame(1.01, 30) - 1.0) < 1e-9);
  // Anchored to the source clock, not to whichever frame comes first after the trim.
  const v = videoSegment(12.5, 2, 24, 30);
  assert.match(v, /setpts=PTS-12\.500000\/TB/);
  assert.match(v, /fps=fps=30:start_time=0/);
  assert.doesNotMatch(v, /STARTPTS/);
  const a = audioSegment(12.5, 2, 48000);
  assert.match(a, /asetpts=PTS-12\.500000\/TB/);
  assert.match(a, /first_pts=0/);
});

function pieces(n: number, len: number, opts: { zoomSplitEvery?: number } = {}): PlanPiece[] {
  const out: PlanPiece[] = [];
  let t = 0;
  let src = 0;
  for (let i = 0; i < n; i++) {
    const continues = opts.zoomSplitEvery && i % opts.zoomSplitEvery !== 0;
    if (!continues) src += 0.5; // a cut: skip some source
    out.push({ clipId: `c${i}`, mediaId: "m1", srcIn: src, srcOut: src + len, start: t, end: t + len, zoom: 1, zoomTo: 1, focus: { x: 0.5, y: 0.5 } });
    t += len;
    src += len;
  }
  return out;
}

test("chunkRanges: frame-exact, contiguous, only at real cuts", () => {
  const fps = 30;
  assert.deepEqual(chunkRanges({ pieces: pieces(20, 1.37), duration: 20 * 1.37 }, fps), []);
  const ps = pieces(500, 1.37, { zoomSplitEvery: 3 });
  const duration = ps[ps.length - 1].end;
  const r = chunkRanges({ pieces: ps, duration }, fps);
  assert.ok(r.length > 10);
  assert.equal(r[0].start, 0);
  assert.ok(Math.abs(r[r.length - 1].end - Math.round(duration * fps) / fps) < 1e-9);
  for (let i = 0; i < r.length; i++) {
    assert.ok(Number.isInteger(Math.round(r[i].start * fps * 1e6) / 1e6), "starts on a frame");
    if (i) assert.equal(r[i].start, r[i - 1].end);
    if (i) {
      // The boundary is the start of a piece that follows a cut (piece index multiple of 3).
      const k = ps.findIndex((p) => Math.round(p.start * fps) === Math.round(r[i].start * fps));
      assert.equal(k % 3, 0, "never inside a zoom split");
    }
  }
});

test("history: snapshots live in files, survive reopen, legacy inline history migrates", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cutroom-hist-"));
  try {
    const store = await ProjectStore.create(dir);
    await store.update(
      (p) => {
        p.media.push({ id: "m1", name: "a.mp4", path: "/a.mp4", kind: "video", duration: 60, width: 1920, height: 1080, fps: 30, hasAudio: true, hasVideo: true, analysis: {} });
        p.clips.push({ id: "c1", mediaId: "m1", in: 0, out: 60 });
      },
      "cli",
      "setup",
    );
    for (let i = 0; i < 5; i++) await store.edit([{ op: "cut", start: 10 + i, end: 10.5 + i }], "cli");
    const raw = JSON.parse((await import("node:fs")).readFileSync(join(dir, ".cutroom", "history.json"), "utf8"));
    assert.equal(raw.undo.length, 6);
    assert.ok(raw.undo.every((e: any) => e.snap && !e.project), "index holds no inline projects");
    assert.equal(readdirSync(join(dir, ".cutroom", "history")).length, 6);

    // Another process (fresh store) undoes and redoes.
    const other = await ProjectStore.open(dir);
    const before = (await other.load()).clips.length;
    await other.undo();
    assert.equal((await store.load()).clips.length, before - 1);
    await store.redo();
    assert.equal((await other.load()).clips.length, before);
    // A new edit drops the redo stack and its snapshot file.
    await store.undo();
    await store.edit([{ op: "cut", start: 40, end: 41 }], "cli");
    const h = await store.history();
    assert.equal(h.redo.length, 0);
    assert.equal(readdirSync(join(dir, ".cutroom", "history")).length, h.undo.length);

    // Legacy format: inline project snapshots are still undoable and get moved out on the next write.
    const legacyProject = await store.load();
    writeFileSync(join(dir, ".cutroom", "history.json"), JSON.stringify({ nextId: 50, undo: [{ id: 49, label: "old", origin: "cli", at: new Date().toISOString(), project: { ...legacyProject, clips: [] } }], redo: [] }));
    const legacy = await ProjectStore.open(dir);
    await legacy.edit([{ op: "cut", start: 1, end: 2 }], "cli");
    const migrated = JSON.parse((await import("node:fs")).readFileSync(join(dir, ".cutroom", "history.json"), "utf8"));
    assert.ok(migrated.undo.every((e: any) => e.snap && !e.project));
    await legacy.undo();
    await legacy.undo();
    assert.equal((await legacy.load()).clips.length, 0, "restored the legacy snapshot");
    assert.ok(existsSync(join(dir, ".cutroom", "history")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
