import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { paginateCaptions } from "../../../src/core/shared/captions";
import { formatTime, placeClips, timelineDuration, timelineWords, type PlacedClip } from "../../../src/core/shared/timeline";
import type { Op } from "../../../src/core/shared/ops";
import type { Project } from "../../../src/core/shared/types";
import { deleteSelection } from "../actions";
import { api } from "../api";
import { engine } from "../engine";
import { store, useStore, type Item } from "../store";
import { feedbackTime } from "../../../src/core/shared/feedback";
import { focusFeedback } from "./Feedback";
import { seekToChange } from "./Review";
import { Icon } from "./Icon";

const RULER = 28;
const H = { captions: 26, broll: 34, zoom: 28, labels: 36, main: 78, audio: 46 };
export const MEDIA_MIME = "application/x-cutroom-media";

type Drag =
  | { kind: "block"; mode: "move" | "l" | "r"; type: Item["type"]; id: string; x0: number; moved: boolean; additive: boolean }
  | { kind: "range"; x0: number; t0: number; moved: boolean }
  | { kind: "scrub" };

export function Timeline() {
  const project = useStore((s) => s.project);
  const transcripts = useStore((s) => s.transcripts);
  const pps = useStore((s) => s.pps);
  const items = useStore((s) => s.items);
  const range = useStore((s) => s.range);
  const reviewing = useStore((s) => !!s.review);
  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState({ left: 0, width: 800 });
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dx, setDx] = useState(0);
  const [dropOn, setDropOn] = useState<"main" | "broll" | null>(null);
  const fitted = useRef(false);

  const duration = project ? timelineDuration(project) : 0;
  const placed = useMemo(() => (project ? placeClips(project) : []), [project]);
  const runList = useMemo(() => runs(placed), [placed]);
  const captionPages = useMemo(
    () => (project?.captions.enabled ? paginateCaptions(timelineWords(project, transcripts), project.captions) : []),
    [project, transcripts],
  );

  useLayoutEffect(() => {
    const el = scroller.current!;
    const update = () => setScroll({ left: el.scrollLeft, width: el.clientWidth });
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Keep the whole edit in view until the user zooms the timeline themselves.
  useEffect(() => {
    if (!fitted.current && duration > 0 && scroll.width > 100) {
      store.set({ pps: Math.max(2, Math.min(200, (scroll.width - 60) / duration)) });
    }
  }, [duration, scroll.width]);
  useEffect(() => {
    const onKeyZoom = () => (fitted.current = true);
    window.addEventListener("cutroom:user-zoom", onKeyZoom);
    return () => window.removeEventListener("cutroom:user-zoom", onKeyZoom);
  }, []);
  const userZoom = (pps: number) => {
    fitted.current = true;
    store.set({ pps });
  };

  // Keep the playhead in view while playing.
  useEffect(
    () =>
      store.subscribe(() => {
        const { playing, time, pps } = store.get();
        const el = scroller.current;
        if (!playing || !el) return;
        const x = time * pps;
        if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = x - 60;
      }),
    [],
  );

  if (!project) return <div className="timeline" />;

  const timeAt = (clientX: number) => {
    const r = scroller.current!.getBoundingClientRect();
    return Math.max(0, Math.min(duration, (clientX - r.left + scroller.current!.scrollLeft) / pps));
  };
  const width = Math.max(scroll.width, duration * pps + 240);
  const showCaptions = project.captions.enabled;
  const isSel = (type: Item["type"], id: string) => items.some((i) => i.type === type && i.id === id);
  const d = drag?.kind === "block" && drag.moved ? dx / pps : 0;
  // Only blocks near the visible window are rendered (long edits have ~1000 clips); the one being
  // dragged always is. One viewport of margin each side keeps scrolling seamless.
  const winStart = (scroll.left - scroll.width) / pps;
  const winEnd = (scroll.left + 2 * scroll.width) / pps;
  const dragId = drag?.kind === "block" ? drag.id : null;
  const near = (start: number, end: number, id: string) => (end >= winStart && start <= winEnd) || id === dragId;

  // ---- pointer handling -------------------------------------------------
  const onBlockDown = (e: React.PointerEvent, type: Item["type"], id: string, mode: "move" | "l" | "r") => {
    e.stopPropagation();
    capture(e);
    setDrag({ kind: "block", mode, type, id, x0: e.clientX, moved: false, additive: e.shiftKey });
    setDx(0);
  };
  const onEmptyDown = (e: React.PointerEvent) => {
    capture(e);
    setDrag({ kind: "range", x0: e.clientX, t0: timeAt(e.clientX), moved: false });
  };
  const onRulerDown = (e: React.PointerEvent) => {
    capture(e);
    if (e.shiftKey) return onEmptyDown(e);
    engine.pause();
    void engine.seek(timeAt(e.clientX));
    setDrag({ kind: "scrub" });
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    if (drag.kind === "scrub") return void engine.seek(timeAt(e.clientX));
    const delta = e.clientX - drag.x0;
    if (!drag.moved && Math.abs(delta) < 3) return;
    if (!drag.moved) setDrag({ ...drag, moved: true });
    if (drag.kind === "range") {
      const t = timeAt(e.clientX);
      store.set({ range: { start: Math.min(drag.t0, t), end: Math.max(drag.t0, t) }, items: [], words: null });
    } else setDx(delta);
  };
  const onUp = (e: React.PointerEvent) => {
    const dr = drag;
    setDrag(null);
    setDx(0);
    if (!dr || dr.kind === "scrub") return;
    if (dr.kind === "range") {
      if (!dr.moved) {
        store.set({ range: null, items: [], words: null });
        engine.pause();
        void engine.seek(timeAt(e.clientX));
      }
      return;
    }
    if (!dr.moved) {
      const it = { type: dr.type, id: dr.id };
      store.set((s) => ({ items: dr.additive ? (isSel(dr.type, dr.id) ? s.items.filter((i) => i.id !== dr.id) : [...s.items, it]) : [it], words: null, range: null }));
      return;
    }
    const op = dragOp(project, placed, dr, (e.clientX - dr.x0) / pps, timeAt(e.clientX));
    if (op) void api.edit([op]);
  };

  const onWheel = (e: React.WheelEvent) => {
    const el = scroller.current!;
    if (e.ctrlKey || e.metaKey) {
      const t = timeAt(e.clientX);
      const next = Math.max(2, Math.min(400, pps * Math.exp(-e.deltaY * 0.01)));
      userZoom(next);
      requestAnimationFrame(() => (el.scrollLeft = t * next - (e.clientX - el.getBoundingClientRect().left)));
    } else if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      el.scrollLeft += e.deltaY;
    }
  };

  const drop = (track: "main" | "broll") => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(MEDIA_MIME)) return;
      e.preventDefault();
      setDropOn(track);
    },
    onDragLeave: () => setDropOn(null),
    onDrop: (e: React.DragEvent) => {
      setDropOn(null);
      const mediaId = e.dataTransfer.getData(MEDIA_MIME);
      if (!mediaId) return;
      e.preventDefault();
      const t = timeAt(e.clientX);
      if (track === "broll") void api.edit([{ op: "add_broll", mediaId, start: Math.min(t, Math.max(0, duration - 0.2)) }]);
      else void api.edit([{ op: "add_clip", mediaId, index: placed.filter((p) => (p.start + p.end) / 2 < t).length }]);
    },
  });

  // ---- rendering --------------------------------------------------------
  const ticks = rulerTicks(pps, scroll.left, scroll.width);
  const mainTop = (showCaptions ? H.captions : 0) + H.broll + H.zoom + H.labels + (reviewing ? DIFF_H : 0);
  const gridPx = Math.max(8, (ticks.find((t) => t.major && t.t > 0)?.t ?? 1) * pps);

  return (
    <div className="timeline">
      <ResizeHandle />
      <div className="timeline-bar">
        {range && (
          <>
            <span className="chip">
              {formatTime(range.start)} → {formatTime(range.end)}
            </span>
            <button className="sm" onClick={deleteSelection}>
              <Icon name="scissors" size={13} /> Cut range
            </button>
            <button className="sm ghost" onClick={() => store.set({ range: null })}>
              Clear
            </button>
          </>
        )}
        <div className="spacer" />
        <div className="zoom-ctl" title="Timeline zoom (⌘/Ctrl + scroll, or + / −)">
          <Icon name="search" size={13} />
          <input type="range" min={0} max={1} step={0.001} value={Math.log(pps / 2) / Math.log(200)} onChange={(e) => userZoom(2 * Math.pow(200, Number(e.target.value)))} />
          <button
            className="ghost sm"
            onClick={() => {
              fitted.current = false;
              if (duration) store.set({ pps: Math.max(2, (scroll.width - 60) / duration) });
            }}
          >
            Fit
          </button>
        </div>
      </div>
      <div className="timeline-body">
        <div className="track-heads">
          <DiffHead />
          {showCaptions && (
            <div className="track-head" style={{ height: H.captions }} title="Captions">
              <Icon name="captions" size={14} />
            </div>
          )}
          <div className="track-head" style={{ height: H.broll }} title="B-roll">
            <Icon name="image" size={14} />
          </div>
          <div className="track-head" style={{ height: H.zoom }} title="Zooms">
            <Icon name="zoom" size={14} />
          </div>
          <div className="track-head" style={{ height: H.labels + H.main }} title="Main track">
            <Icon name="film" size={14} />
          </div>
          <div className="track-head" style={{ height: H.audio }} title="Audio">
            <Icon name="audio" size={14} />
          </div>
        </div>
        <div className="tracks" ref={scroller} onScroll={(e) => setScroll({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })} onWheel={onWheel}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={() => {
            setDrag(null);
            setDx(0);
          }}
        >
          <div className="tracks-inner" style={{ width }}>
            <div className="ruler" onPointerDown={onRulerDown}>
              {ticks.map((t) => (
                <div key={t.t} className={`tick ${t.major ? "major" : ""}`} style={{ left: t.t * pps }}>
                  {t.major && <span>{rulerLabel(t.t)}</span>}
                </div>
              ))}
              <RulerNotes pps={pps} />
            </div>
            <DiffLane pps={pps} />

            {showCaptions && (
              <div className="track" style={{ height: H.captions }} onPointerDown={onEmptyDown}>
                {captionPages
                  .filter((p) => p.end * pps > scroll.left - 50 && p.start * pps < scroll.left + scroll.width + 50)
                  .map((p, i) => (
                    <div key={i} className="block caption" style={{ left: p.start * pps + 1, width: Math.max(2, (p.end - p.start) * pps - 2) }} onPointerDown={(e) => { e.stopPropagation(); engine.pause(); void engine.seek(p.start); }}>
                      <span className="tx">{p.words.map((w) => w.text).join(" ")}</span>
                    </div>
                  ))}
              </div>
            )}

            <div className={`track lane ${dropOn === "broll" ? "drop-target" : ""}`} style={{ height: H.broll, ["--grid" as string]: `${gridPx}px` }} onPointerDown={onEmptyDown} {...drop("broll")}>
              {project.overlays.filter((o) => near(o.start, o.start + o.duration, o.id)).map((o) => {
                const active = drag?.kind === "block" && drag.id === o.id ? drag.mode : null;
                const left = (o.start + (active === "move" || active === "l" ? d : 0)) * pps;
                const w = (o.duration + (active === "r" ? d : active === "l" ? -d : 0)) * pps;
                const m = project.media.find((x) => x.id === o.mediaId);
                return (
                  <div key={o.id} className={`block overlay ${isSel("overlay", o.id) ? "sel" : ""}`} style={{ left, width: Math.max(4, w) }} onPointerDown={(e) => onBlockDown(e, "overlay", o.id, "move")} title={`${m?.name ?? o.mediaId} · ${o.mode}`}>
                    <div className="handle l" onPointerDown={(e) => onBlockDown(e, "overlay", o.id, "l")} />
                    <Icon name={m?.kind === "image" ? "image" : "film"} size={12} />
                    <span className="tx">
                      {m?.name ?? o.mediaId}
                      {o.mode === "pip" ? " · PiP" : ""}
                    </span>
                    <div className="handle r" onPointerDown={(e) => onBlockDown(e, "overlay", o.id, "r")} />
                  </div>
                );
              })}
            </div>

            <div className="track lane" style={{ height: H.zoom, ["--grid" as string]: `${gridPx}px` }} onPointerDown={onEmptyDown}>
              {project.zooms.filter((z) => near(z.start, z.end, z.id)).map((z) => {
                const active = drag?.kind === "block" && drag.id === z.id ? drag.mode : null;
                const left = (z.start + (active === "move" || active === "l" ? d : 0)) * pps;
                const w = (z.end - z.start + (active === "r" ? d : active === "l" ? -d : 0)) * pps;
                return (
                  <div key={z.id} className={`block zoom ${isSel("zoom", z.id) ? "sel" : ""}`} style={{ left, width: Math.max(4, w) }} onPointerDown={(e) => onBlockDown(e, "zoom", z.id, "move")}>
                    <div className="handle l" onPointerDown={(e) => onBlockDown(e, "zoom", z.id, "l")} />
                    <Icon name="zoom" size={12} />
                    <span className="tx">{z.scale.toFixed(2)}×</span>
                    <div className="handle r" onPointerDown={(e) => onBlockDown(e, "zoom", z.id, "r")} />
                  </div>
                );
              })}
            </div>

            <div className="track labels" style={{ height: H.labels }} onPointerDown={onEmptyDown}>
              {runList.map((r) => (
                <div key={r.start} className="run-pill" style={{ left: r.start * pps + 4, maxWidth: Math.max(0, (r.end - r.start) * pps - 8) }}>
                  <span className="run-ico">
                    <Icon name="film" size={11} />
                  </span>
                  <span className="tx">{project.media.find((m) => m.id === r.mediaId)?.name.replace(/\.[^.]+$/, "") ?? r.mediaId}</span>
                  <span className="run-meta">{r.count > 1 ? `${r.count} clips` : `${(r.end - r.start).toFixed(1)}s`}</span>
                </div>
              ))}
            </div>
            <div className={`track main-track ${dropOn === "main" ? "drop-target" : ""}`} style={{ height: H.main }} onPointerDown={onEmptyDown} {...drop("main")}>
              <MainCanvas project={project} placed={placed} pps={pps} left={scroll.left} width={scroll.width} height={H.main} />
              {!placed.length && (
                <div className="track-empty" style={{ left: scroll.left + 8, width: Math.max(0, scroll.width - 16), right: "auto" }}>
                  <Icon name="film" size={14} /> Drop a recording here, or drag one from the Media tab
                </div>
              )}
              {visibleClips(placed, winStart, winEnd, dragId).map((p) => {
                const active = drag?.kind === "block" && drag.id === p.clip.id ? drag.mode : null;
                const w = (p.end - p.start + (active === "r" ? d : active === "l" ? -d : 0)) * pps;
                const shift = active === "move" ? dx : 0;
                return (
                  <div
                    key={p.clip.id}
                    className={`block clip ${isSel("clip", p.clip.id) ? "sel" : ""}`}
                    style={{ left: p.start * pps + shift + 1, width: Math.max(3, w - 2), opacity: active === "move" ? 0.7 : 1 }}
                    onPointerDown={(e) => onBlockDown(e, "clip", p.clip.id, "move")}
                    title={`${p.clip.id}: ${p.clip.mediaId} ${p.clip.in.toFixed(2)}–${p.clip.out.toFixed(2)}s`}
                  >
                    <div className="handle l" onPointerDown={(e) => onBlockDown(e, "clip", p.clip.id, "l")} />
                    <div className="handle r" onPointerDown={(e) => onBlockDown(e, "clip", p.clip.id, "r")} />
                  </div>
                );
              })}
            </div>

            <div className="track audio-track" style={{ height: H.audio }} onPointerDown={onEmptyDown}>
              {runList.map((r) => (
                <AudioRun key={r.start} run={r} placed={placed} pps={pps} />
              ))}
            </div>

            {range && <div className="range" style={{ left: range.start * pps, width: (range.end - range.start) * pps, top: RULER }} />}
            <Playhead pps={pps} />
            <div className="end-marker" style={{ left: duration * pps, top: RULER, height: mainTop + H.main + H.audio }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function capture(e: React.PointerEvent) {
  try {
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  } catch {
    /* pointer already released */
  }
}

function DiffHead() {
  const review = useStore((s) => !!s.review);
  if (!review) return null;
  return (
    <div className="track-head" style={{ height: DIFF_H, color: "var(--agent)" }}>
      <i style={{ background: "var(--agent)" }} /> Changes
    </div>
  );
}

const DIFF_H = 22;

/** Where Claude's changes sit: red ticks for cuts, green bands for added footage, violet for the rest. */
function DiffLane({ pps }: { pps: number }) {
  const review = useStore((s) => s.review);
  const focus = useStore((s) => s.focusChange);
  if (!review) return null;
  return (
    <div className="track diff-lane" style={{ height: DIFF_H }}>
      {review.changes
        .filter((c) => !(c.kind === "style" && !c.end))
        .map((c) => {
          const w = c.end !== undefined ? Math.max(4, (c.end - c.at) * pps) : 0;
          return (
            <button
              key={c.id}
              className={`diff-mark ${c.kind} ${focus === c.id ? "focus" : ""}`}
              style={{ left: c.at * pps - (w ? 0 : 5), width: w || 10 }}
              title={c.label}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => seekToChange(c)}
            >
              {c.kind === "cut" && w === 0 && <span className="diff-cut-label">{c.delta.toFixed(1)}s</span>}
            </button>
          );
        })}
    </div>
  );
}

function RulerNotes({ pps }: { pps: number }) {
  const project = useStore((s) => s.project);
  const feedback = useStore((s) => s.feedback);
  const focus = useStore((s) => s.focusFeedback);
  if (!project) return null;
  return (
    <>
      {feedback
        .filter((f) => f.status !== "resolved" || f.id === focus)
        .map((f) => {
          const t = feedbackTime(project, f);
          if (t.cut) return null;
          return (
            <div key={f.id}>
              {t.end !== null && <div className={`ruler-band ${f.status}`} style={{ left: t.start * pps, width: Math.max(2, (t.end - t.start) * pps) }} />}
              <button
                className={`ruler-note ${f.status} ${f.id === focus ? "focus" : ""}`}
                style={{ left: t.start * pps }}
                title={`#${f.n} ${f.note}`}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => focusFeedback(f)}
              >
                {f.n}
              </button>
            </div>
          );
        })}
    </>
  );
}

function Playhead({ pps }: { pps: number }) {
  const time = useStore((s) => s.time);
  const m = Math.floor(time / 60);
  const sec = Math.floor(time % 60);
  return (
    <div className="playhead" style={{ left: time * pps }}>
      <span className="ph-pill">
        {String(m).padStart(2, "0")}:{String(sec).padStart(2, "0")}
      </span>
      <span className="ph-dot" />
    </div>
  );
}

interface Run {
  mediaId: string;
  start: number;
  end: number;
  count: number;
  first: number;
}

/** Consecutive clips from the same recording, shown as one labelled group. */
function runs(placed: PlacedClip[]): Run[] {
  const out: Run[] = [];
  placed.forEach((p, i) => {
    const last = out[out.length - 1];
    if (last && last.mediaId === p.clip.mediaId && Math.abs(last.end - p.start) < 1e-3) {
      last.end = p.end;
      last.count++;
    } else out.push({ mediaId: p.clip.mediaId, start: p.start, end: p.end, count: 1, first: i });
  });
  return out;
}

/** Waveform for a run of clips; the part before the playhead is lime. */
function AudioRun({ run, placed, pps }: { run: Run; placed: PlacedClip[]; pps: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const lime = useRef<HTMLCanvasElement>(null);
  const wf = useStore((s) => s.waveforms[run.mediaId]);
  const width = Math.max(8, (run.end - run.start) * pps - 8);
  const left = run.start * pps + 4;
  useEffect(() => {
    for (const [c, color] of [
      [ref.current, "rgba(255,240,235,0.32)"],
      [lime.current, "#e8f47c"],
    ] as const) {
      if (!c) continue;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.min(width - 40, 16000);
      const h = 26;
      c.width = Math.max(1, w * dpr);
      c.height = h * dpr;
      c.style.width = `${Math.max(1, w)}px`;
      const ctx = c.getContext("2d")!;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = color;
      ctx.fillRect(0, h / 2 - 0.5, w, 1);
      if (!wf) continue;
      const clips = placed.slice(run.first, run.first + run.count);
      // x (and so t) only increases: walk the clips instead of searching them for every column.
      let ci = 0;
      for (let x = 0; x < w; x += 3) {
        const t = run.start + ((x + 32) / pps);
        while (ci < clips.length && t >= clips[ci].end) ci++;
        const pc = ci < clips.length && t >= clips[ci].start ? clips[ci] : undefined;
        if (!pc) continue;
        const src = pc.clip.in + (t - pc.start);
        let peak = 0;
        const a = Math.floor(src * wf.rate);
        for (let i = a; i < a + Math.max(1, Math.round(wf.rate * (3 / pps))); i++) peak = Math.max(peak, wf.peaks[i] ?? 0);
        const bh = Math.max(1, Math.sqrt(peak) * h * 0.9);
        ctx.fillRect(x, (h - bh) / 2, 1.6, bh);
      }
    }
  }, [wf, width, pps, placed, run]);
  return (
    <div className="audio-run" style={{ left, width }}>
      <span className="run-ico">
        <Icon name="audio" size={12} />
      </span>
      <div className="audio-wave">
        <canvas ref={ref} />
        <AudioPlayed run={run} pps={pps}>
          <canvas ref={lime} />
        </AudioPlayed>
      </div>
    </div>
  );
}

function AudioPlayed({ run, pps, children }: { run: Run; pps: number; children: React.ReactNode }) {
  const time = useStore((s) => s.time);
  const px = Math.max(0, (time - run.start) * pps - 32);
  return <div className="audio-played" style={{ width: px }}>{children}</div>;
}

function ResizeHandle() {
  return (
    <div
      className="timeline-resize"
      onPointerDown={(e) => {
        const app = document.querySelector<HTMLElement>(".app")!;
        const startY = e.clientY;
        const startH = parseFloat(getComputedStyle(app).getPropertyValue("--timeline-h")) || 260;
        const move = (ev: PointerEvent) => app.style.setProperty("--timeline-h", `${Math.max(170, Math.min(window.innerHeight - 260, startH - (ev.clientY - startY)))}px`);
        const up = () => {
          window.removeEventListener("pointermove", move);
          window.removeEventListener("pointerup", up);
        };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
      }}
    />
  );
}

/** Turn a finished drag into an edit op. */
function dragOp(p: Project, placed: PlacedClip[], dr: Extract<Drag, { kind: "block" }>, d: number, tDrop: number): Op | null {
  if (dr.type === "overlay") {
    const o = p.overlays.find((x) => x.id === dr.id);
    if (!o) return null;
    if (dr.mode === "move") return { op: "update_overlay", id: o.id, start: Math.min(Math.max(0, o.start + d), Math.max(0, timelineDuration(p) - o.duration)) };
    const m = p.media.find((x) => x.id === o.mediaId);
    const isImage = m?.kind === "image";
    const total = timelineDuration(p);
    if (dr.mode === "r") {
      const maxDur = Math.min(total - o.start, isImage ? Infinity : (m?.duration ?? Infinity) - o.in);
      return { op: "update_overlay", id: o.id, duration: Math.max(0.2, Math.min(maxDur, o.duration + d)) };
    }
    // Left edge: start and in-point move together; the end stays put.
    const dd = Math.min(Math.max(d, -o.start, isImage ? -Infinity : -o.in), o.duration - 0.2);
    return { op: "update_overlay", id: o.id, start: o.start + dd, duration: o.duration - dd, ...(isImage ? {} : { in: o.in + dd }) };
  }
  if (dr.type === "zoom") {
    const z = p.zooms.find((x) => x.id === dr.id);
    if (!z) return null;
    if (dr.mode === "move") {
      const s = Math.max(0, z.start + d);
      return { op: "update_zoom", id: z.id, start: s, end: s + (z.end - z.start) };
    }
    if (dr.mode === "r") return { op: "update_zoom", id: z.id, end: Math.max(z.start + 0.2, z.end + d) };
    return { op: "update_zoom", id: z.id, start: Math.min(z.end - 0.2, Math.max(0, z.start + d)) };
  }
  const pc = placed.find((x) => x.clip.id === dr.id);
  if (!pc) return null;
  const m = p.media.find((x) => x.id === pc.clip.mediaId);
  if (dr.mode === "r") return { op: "trim_clip", id: pc.clip.id, out: Math.max(pc.clip.in + 0.1, Math.min(m?.duration ?? Infinity, pc.clip.out + d)) };
  if (dr.mode === "l") return { op: "trim_clip", id: pc.clip.id, in: Math.min(pc.clip.out - 0.1, Math.max(0, pc.clip.in + d)) };
  const index = placed.filter((x) => x.clip.id !== pc.clip.id && (x.start + x.end) / 2 < tDrop).length;
  return index === pc.index ? null : { op: "move_clip", id: pc.clip.id, index };
}

function rulerLabel(t: number) {
  const m = Math.floor(t / 60);
  const sec = t - m * 60;
  const ss = Number.isInteger(sec) ? String(sec).padStart(2, "0") : sec.toFixed(1).padStart(4, "0");
  return `${String(m).padStart(2, "0")}:${ss}`;
}

function rulerTicks(pps: number, left: number, width: number) {
  const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
  const major = steps.find((s) => s * pps >= 80) ?? 600;
  const minor = steps.slice().reverse().find((s) => s < major && s * pps >= 10) ?? major;
  const out: { t: number; major: boolean }[] = [];
  const t0 = Math.floor(left / pps / minor) * minor;
  const t1 = (left + width) / pps;
  for (let t = t0; t <= t1; t += minor) {
    const r = Math.round(t * 1000) / 1000;
    out.push({ t: r, major: Math.abs(r / major - Math.round(r / major)) < 1e-6 });
  }
  return out;
}

/** Index of the first clip that ends at or after t (clips are placed back to back, sorted by start). */
function firstEndingAfter(placed: PlacedClip[], t: number): number {
  let lo = 0;
  let hi = placed.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (placed[mid].end < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Clips overlapping [t0, t1], plus the one being dragged wherever it is. */
function visibleClips(placed: PlacedClip[], t0: number, t1: number, keep: string | null): PlacedClip[] {
  const out: PlacedClip[] = [];
  for (let i = firstEndingAfter(placed, t0); i < placed.length && placed[i].start <= t1; i++) out.push(placed[i]);
  if (keep && !out.some((p) => p.clip.id === keep)) {
    const p = placed.find((x) => x.clip.id === keep);
    if (p) out.push(p);
  }
  return out;
}

const sprites = new Map<string, HTMLImageElement>();

/** Filmstrip thumbnails + waveform for the visible part of the main track. */
function MainCanvas({ project, placed, pps, left, width, height }: { project: Project; placed: PlacedClip[]; pps: number; left: number; width: number; height: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const waveforms = useStore((s) => s.waveforms);
  const filmstrips = useStore((s) => s.filmstrips);
  const [loadedTick, setLoadedTick] = useState(0);

  useEffect(() => {
    for (const id of Object.keys(filmstrips)) {
      if (sprites.has(id)) continue;
      const img = new Image();
      img.onload = () => setLoadedTick((n) => n + 1);
      img.src = `/media/${id}/filmstrip.jpg`;
      sprites.set(id, img);
    }
  }, [filmstrips]);

  useEffect(() => {
    const c = ref.current!;
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(width * dpr);
    c.height = Math.round(height * dpr);
    const ctx = c.getContext("2d")!;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, width, height);
    const t0 = left / pps;
    const t1 = (left + width) / pps;
    const top = 6;
    const h = height - 12;
    for (let i = firstEndingAfter(placed, t0); i < placed.length; i++) {
      const p = placed[i];
      if (p.start > t1) break;
      if (p.end < t0) continue;
      const x0 = p.start * pps - left + 2;
      const w = Math.max(1, (p.end - p.start) * pps - 4);
      // Card
      ctx.save();
      ctx.beginPath();
      ctx.roundRect(x0, top, w, h, 10);
      ctx.fillStyle = "#1a1818";
      ctx.fill();
      ctx.clip();
      // Thumbnails inset in the card
      const inset = 5;
      const fs = filmstrips[p.clip.mediaId];
      const img = sprites.get(p.clip.mediaId);
      ctx.beginPath();
      ctx.roundRect(x0 + inset, top + inset, Math.max(1, w - inset * 2), h - inset * 2, 7);
      ctx.clip();
      ctx.fillStyle = "#0a0909";
      ctx.fillRect(x0, top, w, h);
      if (fs && img?.complete && img.naturalWidth) {
        const tileW = img.naturalWidth / fs.count;
        const th = h - inset * 2;
        const dw = (tileW * th) / img.naturalHeight;
        for (let x = x0 + inset + Math.max(0, Math.floor((-x0 - dw) / dw)) * dw; x < Math.min(x0 + w, width); x += dw) {
          const src = p.clip.in + (x + dw / 2 - x0) / pps;
          const idx = Math.max(0, Math.min(fs.count - 1, Math.floor(src / fs.step)));
          ctx.drawImage(img, idx * tileW, 0, tileW, img.naturalHeight, x, top + inset, dw, th);
        }
      }
      if (w > 46) {
        const dur = `${(p.end - p.start).toFixed(1)}s`;
        ctx.font = "600 10px 'JetBrains Mono Variable', monospace";
        const tw = ctx.measureText(dur).width;
        ctx.fillStyle = "rgba(12,10,10,0.78)";
        ctx.beginPath();
        ctx.roundRect(x0 + w - inset - tw - 12, top + inset + 4, tw + 8, 16, 5);
        ctx.fill();
        ctx.fillStyle = "#f3eeec";
        ctx.fillText(dur, x0 + w - inset - tw - 8, top + inset + 15.5);
      }
      ctx.restore();
    }
  }, [project, placed, pps, left, width, height, waveforms, filmstrips, loadedTick]);

  return <canvas ref={ref} className="main-canvas" style={{ left, width, height }} />;
}
