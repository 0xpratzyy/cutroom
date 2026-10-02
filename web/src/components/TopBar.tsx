import { useEffect, useState } from "react";
import { timelineDuration } from "../../../src/core/shared/timeline";
import { ASPECTS } from "../../../src/core/shared/types";
import { addZoomHere, splitAtPlayhead, toggleAnnotate } from "../actions";
import { engine } from "../engine";
import { STEP_LABELS, store, useStore, type State } from "../store";
import { startVoice, stopVoice } from "../voice";
import { Icon } from "./Icon";

function formatDur(t: number) {
  const m = Math.floor(t / 60);
  const s = Math.round(t % 60);
  return m ? `${m}:${String(s).padStart(2, "0")}` : `${(Math.round(t * 10) / 10).toFixed(1)}s`;
}

const openPanel = (tab: State["rightTab"]) =>
  store.set((s) => ({ rightTab: tab, rightOpen: s.rightOpen && s.rightTab === tab ? false : true, inspectorOpen: true }));

/** Window title row: home, project tab, history / play / export. */
export function TitleBar() {
  const name = useStore((s) => s.project?.name ?? "");
  const duration = useStore((s) => (s.project ? timelineDuration(s.project) : 0));
  const aspect = useStore((s) => {
    const st = s.project?.settings;
    return st ? (Object.entries(ASPECTS).find(([, v]) => v.width === st.width && v.height === st.height)?.[0] ?? `${st.width}×${st.height}`) : "";
  });
  const playing = useStore((s) => s.playing);
  const running = useStore((s) => Object.values(s.jobs).filter((j) => j.status === "running"));
  const agent = useStore((s) => s.agent);
  const agentAt = useStore((s) => s.agentActiveAt);
  const connected = useStore((s) => s.connected);
  const [, tick] = useState(0);
  const live = Date.now() - agentAt < 8000;
  useEffect(() => {
    if (!live) return;
    const t = setTimeout(() => tick((n) => n + 1), 8000 - (Date.now() - agentAt) + 50);
    return () => clearTimeout(t);
  }, [agentAt, live]);

  return (
    <div className="titlebar">
      <button className="brand-btn" title="cutroom" onClick={() => openPanel("feedback")}>
        <img src="/icon-128.png" alt="cutroom" width="30" height="30" />
      </button>
      <div className="title-sep" />
      <div className="doc-tab">
        <span className="doc-chip">Project</span>
        <span className="doc-name">{name}</span>
        <span className="doc-meta">
          {formatDur(duration)} · {aspect}
        </span>
      </div>
      <div className="spacer" />
      <button className="palette-trigger" onClick={() => store.set({ paletteOpen: true })} title="Search actions or ask Claude (⌘K)">
        <Icon name="search" size={13} />
        <span>Search or ask Claude…</span>
        <kbd>⌘K</kbd>
      </button>
      <div className="spacer" />
      {running.slice(0, 1).map((j) => (
        <span key={j.id} className="job-chip" title={j.label}>
          <span className="job-label">{j.kind === "export" ? "Exporting" : (STEP_LABELS[j.detail ?? ""] ?? STEP_LABELS[j.kind] ?? "Working")}</span>
          <span className="progress">
            <div style={{ width: `${Math.round(j.progress * 100)}%` }} />
          </span>
        </span>
      ))}
      <span
        className={`agent-pill ${live ? "live" : agent?.watching ? "watching" : agent ? "connected" : ""}`}
        title={!connected ? "Disconnected from the cutroom server; retrying" : agent ? "An agent is connected over MCP" : "No agent connected"}
      >
        <span className="dot" />
        {!connected ? "Offline" : live ? "Claude editing" : agent?.watching ? "Claude watching" : agent ? "Claude connected" : "No agent"}
      </span>
      <div className="title-sep" />
      <button className="round" title="History" onClick={() => openPanel("edit")}>
        <Icon name="history" size={16} />
      </button>
      <button className="round" title={playing ? "Pause (Space)" : "Play (Space)"} onClick={() => engine.toggle()}>
        <Icon name={playing ? "pause" : "play"} size={14} />
      </button>
      <button className="round" title="Export" onClick={() => openPanel("output")}>
        <Icon name="share" size={16} />
      </button>
    </div>
  );
}

/** Tool row: assets/transcript on the left, tools in the middle, panels on the right. */
export function ToolBar() {
  const annotating = useStore((s) => s.annotating);
  const leftOpen = useStore((s) => s.leftOpen);
  const leftTab = useStore((s) => s.leftTab);
  const rightOpen = useStore((s) => s.rightOpen);
  const rightTab = useStore((s) => s.rightTab);
  const recording = useStore((s) => s.voice.recording);
  const notes = useStore((s) => s.feedback.filter((f) => f.status !== "resolved").length + (s.review?.changes.length ?? 0));
  const left = (tab: State["leftTab"]) => store.set((s) => ({ leftTab: tab, leftOpen: s.leftOpen && s.leftTab === tab ? false : true }));

  return (
    <div className="toolbar-row">
      <div className="tool-side">
        <button className={`soft ${leftOpen && leftTab === "media" ? "on" : ""}`} onClick={() => left("media")}>
          <span className="round-ico">
            <Icon name="plus" size={14} />
          </span>
          Add Assets
        </button>
        <button className={`soft ${leftOpen && leftTab === "transcript" ? "on" : ""}`} onClick={() => left("transcript")}>
          <span className="round-ico">
            <Icon name="layers" size={15} />
          </span>
          Transcript
        </button>
      </div>

      <div className="tools">
        <button className={`tool ${!annotating ? "active" : ""}`} title="Select (Esc)" onClick={() => toggleAnnotate(false)}>
          <Icon name="cursor" size={17} />
        </button>
        <button className={`tool ${annotating ? "active" : ""}`} title="Annotate: pin notes on the frame (A)" onClick={() => toggleAnnotate()}>
          <Icon name="pin" size={17} />
        </button>
        <button className="tool" title="Split at playhead (S)" onClick={splitAtPlayhead}>
          <Icon name="scissors" size={17} />
        </button>
        <button className="tool" title="Punch-in zoom (Z)" onClick={() => addZoomHere()}>
          <Icon name="zoom" size={17} />
        </button>
        <button
          className="tool"
          title="Hook title & captions"
          onClick={() => {
            store.set({ rightTab: "style", rightOpen: true, inspectorOpen: true });
            setTimeout(() => document.querySelector(".hook-text")?.scrollIntoView({ block: "center", behavior: "smooth" }), 80);
          }}
        >
          <Icon name="type" size={17} />
        </button>
        <button
          className={`tool ${recording ? "rec" : ""}`}
          title="Hold to talk: voice note (V)"
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            void startVoice();
          }}
          onPointerUp={() => void stopVoice()}
          onPointerCancel={() => void stopVoice()}
        >
          <Icon name="mic" size={17} />
        </button>
      </div>

      <div className="tool-side right">
        <button className={`round ${rightOpen && rightTab === "style" ? "on" : ""}`} title="Style: looks, captions, hook, sound, brand" onClick={() => openPanel("style")}>
          <Icon name="cube" size={16} />
        </button>
        <button className={`round ${rightOpen && rightTab === "feedback" ? "on" : ""}`} title="Notes and Claude's changes" onClick={() => openPanel("feedback")}>
          <Icon name="message" size={15} />
          {notes > 0 && <span className="round-badge">{notes}</span>}
        </button>
        <button className={`round ${rightOpen && rightTab === "edit" ? "on" : ""}`} title="Edit details" onClick={() => openPanel("edit")}>
          <Icon name="sliders" size={15} />
        </button>
        <div className="title-sep" />
        <button className="round" title={rightOpen ? "Hide panel" : "Show panel"} onClick={() => store.set((s) => ({ rightOpen: !s.rightOpen, inspectorOpen: !s.rightOpen }))}>
          <Icon name={rightOpen ? "panelHide" : "panel"} size={15} />
        </button>
      </div>
    </div>
  );
}
