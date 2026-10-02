import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { timelineDuration } from "../../../src/core/shared/timeline";
import { deleteSelection, openComposer, step } from "../actions";
import { api } from "../api";
import { engine } from "../engine";
import { store, useStore } from "../store";
import { EmptyState } from "./EmptyState";
import { AnnotationLayer } from "./Feedback";
import { Icon } from "./Icon";
import { ReviewBar } from "./Review";

export function Player() {
  const view = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const a = useRef<HTMLVideoElement>(null);
  const b = useRef<HTMLVideoElement>(null);
  const overlay = useRef<HTMLVideoElement>(null);
  const overlayImg = useRef<HTMLImageElement>(null);
  const captions = useRef<HTMLCanvasElement>(null);
  const grade = useRef<HTMLCanvasElement>(null);
  const logo = useRef<HTMLImageElement>(null);
  const width = useStore((s) => s.project?.settings.width ?? 1920);
  const height = useStore((s) => s.project?.settings.height ?? 1080);
  const empty = useStore((s) => !s.project?.clips.length);
  const annotating = useStore((s) => s.annotating);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useEffect(
    () => engine.attach({ frame: frame.current!, a: a.current!, b: b.current!, overlay: overlay.current!, overlayImg: overlayImg.current!, captions: captions.current!, grade: grade.current!, logo: logo.current! }),
    [],
  );

  // Fit the output aspect into the available space.
  useLayoutEffect(() => {
    const el = view.current!;
    const fit = () => {
      const pad = 40;
      const k = Math.min((el.clientWidth - pad) / width, (el.clientHeight - pad) / height);
      const w = Math.max(10, Math.floor(width * k));
      const h = Math.max(10, Math.floor(height * k));
      setSize({ w, h });
      engine.resize(w, h);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, height]);

  return (
    <div className="stage">
      {annotating && (
        <div className="annot-banner">
          <Icon name="pin" size={13} /> Click to pin a note, drag to mark an area <kbd>Esc</kbd>
        </div>
      )}
      <VoiceOverlay />
      {!annotating && <ReviewBar />}
      <div className="stage-view" ref={view}>
        <div
          className={`frame ${annotating ? "annotating" : ""}`}
          ref={frame}
          style={{ width: size.w, height: size.h, display: empty ? "none" : undefined }}
          onClick={() => !annotating && engine.toggle()}
        >
          <video ref={a} className="main-v" />
          <video ref={b} className="main-v" />
          <canvas ref={grade} className="grade" />
          <video ref={overlay} />
          <img ref={overlayImg} alt="" />
          <img ref={logo} className="logo" alt="" />
          <canvas ref={captions} />
          <Guides />
          <AnnotationLayer />
          {!empty && <FrameProgress />}
        </div>
        {empty && <EmptyState />}
        {!empty && <LevelMeter />}
      </div>
      {!empty && <Transport />}
    </div>
  );
}

/** Rule-of-thirds guides; hidden while playing. */
function Guides() {
  const on = useStore((s) => s.grid && !s.playing);
  if (!on) return null;
  return (
    <div className="guides" aria-hidden>
      <i style={{ left: "33.333%" }} className="v" />
      <i style={{ left: "66.666%" }} className="v" />
      <i style={{ top: "33.333%" }} className="h" />
      <i style={{ top: "66.666%" }} className="h" />
    </div>
  );
}

/** Progress along the frame's bottom edge with a time bubble; drag to scrub. */
function FrameProgress() {
  const time = useStore((s) => s.time);
  const duration = useStore((s) => (s.project ? timelineDuration(s.project) : 0));
  const f = duration ? Math.min(1, time / duration) : 0;
  const seekAt = (el: HTMLElement, x: number) => {
    const r = el.getBoundingClientRect();
    void engine.seek(Math.max(0, Math.min(1, (x - r.left) / r.width)) * duration);
  };
  return (
    <div
      className="frame-progress"
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => {
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        engine.pause();
        seekAt(e.currentTarget, e.clientX);
      }}
      onPointerMove={(e) => e.buttons === 1 && seekAt(e.currentTarget, e.clientX)}
    >
      <div className="fp-fill" style={{ width: `${f * 100}%` }} />
      <div className="fp-bubble" style={{ left: `clamp(30px, ${f * 100}%, calc(100% - 30px))` }}>
        {formatClock(time)}
      </div>
    </div>
  );
}

function formatClock(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Output level meter (dBFS) at the stage's right edge. */
function LevelMeter() {
  const playing = useStore((s) => s.playing);
  const fill = useRef<HTMLDivElement>(null);
  const peak = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let hold = -60;
    let holdAt = 0;
    const loop = () => {
      const db = playing ? engine.level() : -Infinity;
      const v = Math.max(-60, Math.min(0, db));
      const k = (v + 60) / 60;
      if (v > hold || performance.now() - holdAt > 900) {
        hold = v;
        holdAt = performance.now();
      }
      if (fill.current) fill.current.style.height = `${k * 100}%`;
      if (peak.current) peak.current.style.bottom = `${((hold + 60) / 60) * 100}%`;
      raf = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(raf);
  }, [playing]);
  return (
    <div className="meter" title="Output level (dBFS)">
      <div className="meter-scale">
        {[0, -6, -12, -24, -36, -48].map((d) => (
          <span key={d} style={{ bottom: `${((d + 60) / 60) * 100}%` }}>
            {d}
          </span>
        ))}
      </div>
      <div className="meter-bar">
        <div className="meter-fill" ref={fill} />
        <div className="meter-peak" ref={peak} />
      </div>
    </div>
  );
}

function Transport() {
  const project = useStore((s) => s.project);
  const playing = useStore((s) => s.playing);
  const grid = useStore((s) => s.grid);
  const canUndo = useStore((s) => s.history.undo.length > 0);
  const canRedo = useStore((s) => s.history.redo.length > 0);
  const canDelete = useStore((s) => s.items.length > 0 || !!s.range || !!s.words);
  const duration = project ? timelineDuration(project) : 0;
  const fps = project?.settings.fps ?? 30;
  return (
    <div className="transport">
      <div className="t-group">
        <button className="round" title="Undo (⌘Z)" disabled={!canUndo} onClick={() => void api.undo()}>
          <Icon name="undo" size={15} />
        </button>
        <button className="round" title="Redo (⇧⌘Z)" disabled={!canRedo} onClick={() => void api.redo()}>
          <Icon name="redo" size={15} />
        </button>
        <button className="round" title="Delete selection (⌫)" disabled={!canDelete} onClick={deleteSelection}>
          <Icon name="trash" size={15} />
        </button>
      </div>
      <div className="t-group center">
        <button className="round" title="Go to start (Home)" onClick={() => void engine.seek(0)}>
          <Icon name="rewind" size={15} />
        </button>
        <button className="round" title="Previous frame (←)" onClick={() => step(-1 / fps)}>
          <Icon name="prevTri" size={13} />
        </button>
        <button className="round big" title="Play / pause (Space)" aria-label={playing ? "Pause" : "Play"} onClick={() => engine.toggle()}>
          <Icon name={playing ? "pause" : "play"} size={16} />
        </button>
        <button className="round" title="Next frame (→)" onClick={() => step(1 / fps)}>
          <Icon name="nextTri" size={13} />
        </button>
        <button className="round" title="Go to end (End)" onClick={() => void engine.seek(duration)}>
          <Icon name="ffwd" size={15} />
        </button>
      </div>
      <div className="t-group right">
        <button className="round" title="Leave a note for Claude (C)" onClick={() => openComposer()}>
          <Icon name="message" size={15} />
        </button>
        <button className={`round ${grid ? "on" : ""}`} title="Rule-of-thirds guides" onClick={() => store.set({ grid: !grid })}>
          <Icon name="grid" size={15} />
        </button>
        <button
          className="round"
          title="Full screen preview"
          onClick={() => {
            const el = document.querySelector(".stage") as HTMLElement | null;
            if (document.fullscreenElement) void document.exitFullscreen();
            else void el?.requestFullscreen?.();
          }}
        >
          <Icon name="fullscreen" size={15} />
        </button>
        <button className="round" title="Shortcuts and details" onClick={() => store.set({ rightTab: "edit", rightOpen: true, inspectorOpen: true, items: [], range: null, words: null })}>
          <Icon name="info" size={15} />
        </button>
      </div>
    </div>
  );
}

function VoiceOverlay() {
  const v = useStore((s) => s.voice);
  if (!v.recording && !v.sending) return null;
  return (
    <div className={`voice-overlay ${v.sending ? "sending" : ""}`}>
      {v.sending ? (
        <>
          <span className="spinner" /> Transcribing your note…
        </>
      ) : (
        <>
          <span className="rec-dot" />
          <span className="voice-bars">
            {[0.5, 0.8, 1, 0.8, 0.5].map((k, i) => (
              <i key={i} style={{ height: `${4 + v.level * 18 * k}px` }} />
            ))}
          </span>
          Listening. Release to send
        </>
      )}
    </div>
  );
}

