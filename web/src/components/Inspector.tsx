import { useEffect, useState, type ReactNode } from "react";
import type { Op } from "../../../src/core/shared/ops";
import { formatTime, mapWords, timelineDuration } from "../../../src/core/shared/timeline";
import { ASPECTS, type Clip, type Focus, type MediaAsset, type Overlay, type Project, type Zoom } from "../../../src/core/shared/types";
import { deleteSelection } from "../actions";
import { api } from "../api";
import { store, useStore } from "../store";
import { FeedbackPanel } from "./Feedback";
import { StyleTab } from "./Style";
import { Icon } from "./Icon";

const edit = (op: Op, label?: string) => void api.edit([op], label);

const TABS = [
  ["feedback", "Feedback"],
  ["edit", "Edit"],
  ["style", "Style"],
  ["output", "Export"],
] as const;

export function Inspector() {
  const tab = useStore((s) => s.rightTab);
  const project = useStore((s) => s.project);
  const open = useStore((s) => s.inspectorOpen);
  const openNotes = useStore((s) => s.feedback.filter((f) => f.status !== "resolved").length + (s.review?.changes.length ?? 0));
  if (!project) return <div className="panel right" />;
  return (
    <div className={`panel right card ${open ? "open" : ""}`}>
      <div className="panel-head">
        <div className="seg full" style={{ flex: 1 }} role="tablist">
          {TABS.map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => store.set({ rightTab: t })}>
              {label}
              {t === "feedback" && openNotes > 0 && <span className="tab-count">{openNotes}</span>}
            </button>
          ))}
        </div>
        <button className="ghost sm icon inspector-close" title="Close" onClick={() => store.set({ inspectorOpen: false, rightOpen: false })}>
          <Icon name="close" size={14} />
        </button>
      </div>
      <div className="scroll">
        {tab === "feedback" && <FeedbackPanel />}
        {tab === "edit" && <EditTab project={project} />}
        {tab === "style" && <StyleTab project={project} />}
        {tab === "output" && <OutputTab project={project} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- edit tab

function EditTab({ project }: { project: Project }) {
  const items = useStore((s) => s.items);
  const words = useStore((s) => s.words);
  const transcripts = useStore((s) => s.transcripts);
  const range = useStore((s) => s.range);
  const item = items[0];
  const clip = item?.type === "clip" ? project.clips.find((c) => c.id === item.id) : undefined;
  const overlay = item?.type === "overlay" ? project.overlays.find((o) => o.id === item.id) : undefined;
  const zoom = item?.type === "zoom" ? project.zooms.find((z) => z.id === item.id) : undefined;
  const media = (id: string) => project.media.find((m) => m.id === id);

  return (
    <>
      {clip && <ClipPanel clip={clip} media={media(clip.mediaId)} project={project} />}
      {overlay && <OverlayPanel o={overlay} media={media(overlay.mediaId)} />}
      {zoom && <ZoomPanel z={zoom} project={project} />}
      {words && transcripts[words.mediaId] && (
        <div className="section">
          <div className="section-title">Selected words</div>
          <p style={{ margin: "0 0 10px" }}>
            “
            {mapWords(project, transcripts[words.mediaId])
              .slice(words.from, words.to + 1)
              .map((w) => w.word.text)
              .join(" ")}
            ”
          </p>
          <button onClick={deleteSelection}>
            <Icon name="scissors" /> Cut / restore <kbd>⌫</kbd>
          </button>
        </div>
      )}
      {range && !item && !words && (
        <div className="section">
          <div className="section-title">Range</div>
          <p className="muted">
            {formatTime(range.start)} – {formatTime(range.end)} ({(range.end - range.start).toFixed(2)}s)
          </p>
          <div className="row">
            <button onClick={deleteSelection}>
              <Icon name="scissors" /> Cut
            </button>
            <button onClick={() => edit({ op: "add_zoom", start: range.start, end: range.end })}>
              <Icon name="zoom" /> Zoom
            </button>
          </div>
        </div>
      )}
      {!item && !words && !range && !project.clips.length && (
        <div className="section">
          <div className="section-title">Getting started</div>
          <ol className="steps">
            <li>
              <span>
                <b>Add a recording.</b> Drop a video on the window. It's transcribed locally.
              </span>
            </li>
            <li>
              <span>
                <b>Edit by text.</b> Select words in the transcript and press ⌫. Remove fillers and pauses in one click.
              </span>
            </li>
            <li>
              <span>
                <b>Polish.</b> Reframe to 9:16, punch in with zooms, add b-roll and captions.
              </span>
            </li>
            <li>
              <span>
                <b>Export</b> an MP4, captions (.srt), or a timeline for Resolve or Premiere.
              </span>
            </li>
          </ol>
        </div>
      )}
      {!item && !words && !range && project.clips.length > 0 && (
        <div className="section">
          <Overview project={project} />
          <div className="section-title">Clean up</div>
          <QuickActions />
          <div className="section-title" style={{ marginTop: 24 }}>Shortcuts</div>
          <div className="shortcuts">
            <span>Play / pause</span> <kbd>Space</kbd>
            <span>Cut selected words / delete item</span> <kbd>⌫</kbd>
            <span>Split at playhead</span> <kbd>S</kbd>
            <span>Punch-in zoom</span> <kbd>Z</kbd>
            <span>Frame step (⇧ = 1s)</span> <kbd>← →</kbd>
            <span>Undo (⇧ to redo)</span> <kbd>⌘Z</kbd>
            <span>Timeline zoom</span> <kbd>+ −</kbd>
          </div>
          <p className="hint" style={{ marginTop: 16, marginBottom: 0 }}>Select words in the transcript or click something on the timeline to edit it. Connected agents see your selection too.</p>
        </div>
      )}
      <HistoryTab />
    </>
  );
}

function Overview({ project }: { project: Project }) {
  const transcripts = useStore((s) => s.transcripts);
  const total = timelineDuration(project);
  const sourceIds = [...new Set(project.clips.map((c) => c.mediaId))];
  const raw = sourceIds.reduce((n, id) => n + (project.media.find((m) => m.id === id)?.duration ?? 0), 0);
  const saved = Math.max(0, raw - total);
  const fillers = sourceIds.reduce((n, id) => (transcripts[id] ? n + mapWords(project, transcripts[id]).filter((w) => w.kept && w.word.filler).length : n), 0);
  return (
    <div className="stat">
      <div>
        <div className="label">Length</div>
        <div className="num">{formatTime(total).replace(/^00:/, "0:")}</div>
      </div>
      <div>
        <div className="label">Trimmed</div>
        <div className="num" style={{ color: saved > 0 ? "var(--ok)" : undefined }}>
          {saved > 0 ? `−${saved.toFixed(1)}s` : "0s"}
        </div>
      </div>
      <div>
        <div className="label">Clips</div>
        <div className="num">{project.clips.length}</div>
      </div>
      <div>
        <div className="label">Fillers left</div>
        <div className="num" style={{ color: fillers ? "var(--filler)" : undefined }}>{fillers}</div>
      </div>
    </div>
  );
}

function QuickActions() {
  const [minDur, setMinDur] = useState(0.6);
  const [keep, setKeep] = useState(0.2);
  return (
    <>
      <div className="row">
        <label>Min pause</label>
        <input className="grow" type="range" min={0.3} max={2} step={0.05} value={minDur} onChange={(e) => setMinDur(Number(e.target.value))} />
        <span className="val">{minDur.toFixed(2)}s</span>
      </div>
      <div className="row">
        <label>Keep</label>
        <input className="grow" type="range" min={0} max={0.5} step={0.01} value={keep} onChange={(e) => setKeep(Number(e.target.value))} />
        <span className="val">{keep.toFixed(2)}s</span>
      </div>
      <div className="row" style={{ marginTop: 12 }}>
        <button className="grow" onClick={() => edit({ op: "remove_silences", minDuration: minDur, keep }, "tighten pauses")}>
          <Icon name="compress" size={13} /> Tighten pauses
        </button>
        <button className="grow" onClick={() => edit({ op: "remove_fillers" })}>
          <Icon name="wand" size={13} /> Remove fillers
        </button>
      </div>
      <div className="row">
        <button className="grow" title="Alternate framing at each cut so jump cuts feel intentional" onClick={() => edit({ op: "jump_cut_zoom" }, "hide jump cuts")}>
          <Icon name="zoom" size={13} /> Hide jump cuts
        </button>
        <button className="grow" title="Lines you said more than once" onClick={() => store.set({ leftTab: "takes", leftOpen: true })}>
          <Icon name="refresh" size={13} /> Review retakes
        </button>
      </div>
    </>
  );
}

function ClipPanel({ clip, media, project }: { clip: Clip; media?: MediaAsset; project: Project }) {
  return (
    <div className="section">
      <div className="section-title">
        Clip {clip.id}
        <button className="ghost danger" onClick={deleteSelection} title="Delete clip">
          <Icon name="trash" />
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>
        {media?.name} · source {clip.in.toFixed(2)}–{clip.out.toFixed(2)}s ({(clip.out - clip.in).toFixed(2)}s)
      </p>
      <NumberRow label="In" value={clip.in} step={0.05} onCommit={(v) => edit({ op: "trim_clip", id: clip.id, in: v })} />
      <NumberRow label="Out" value={clip.out} step={0.05} onCommit={(v) => edit({ op: "trim_clip", id: clip.id, out: v })} />
      {media?.hasVideo && (
        <>
          <div className="section-title" style={{ marginTop: 14 }}>Framing</div>
          <FocusPicker media={media} focus={clip.focus ?? { x: 0.5, y: 0.5 }} project={project} t={(clip.in + clip.out) / 2} onCommit={(f) => edit({ op: "set_focus", id: clip.id, ...f })} />
          <button style={{ marginTop: 8 }} onClick={() => edit({ op: "set_focus", ...(clip.focus ?? { x: 0.5, y: 0.5 }) }, "apply framing to all clips")}>
            Apply to all clips
          </button>
        </>
      )}
    </div>
  );
}

function OverlayPanel({ o, media }: { o: Overlay; media?: MediaAsset }) {
  const pip = o.pip ?? { x: 0.68, y: 0.06, w: 0.28 };
  return (
    <div className="section">
      <div className="section-title">
        B-roll {o.id}
        <button className="ghost danger" onClick={deleteSelection} title="Remove">
          <Icon name="trash" />
        </button>
      </div>
      <p className="muted" style={{ marginTop: 0 }}>{media?.name}</p>
      <div className="row">
        <label>Mode</label>
        <div className="seg">
          {(["full", "pip"] as const).map((m) => (
            <button key={m} className={o.mode === m ? "on" : ""} onClick={() => edit({ op: "update_overlay", id: o.id, mode: m })}>
              {m === "full" ? "Full frame" : "Picture-in-picture"}
            </button>
          ))}
        </div>
      </div>
      <NumberRow label="Start" value={o.start} step={0.1} onCommit={(v) => edit({ op: "update_overlay", id: o.id, start: v })} />
      <NumberRow label="Duration" value={o.duration} step={0.1} onCommit={(v) => edit({ op: "update_overlay", id: o.id, duration: v })} />
      {media?.kind !== "image" && <NumberRow label="Source in" value={o.in} step={0.1} onCommit={(v) => edit({ op: "update_overlay", id: o.id, in: v })} />}
      {media?.hasAudio && <SliderRow label="Volume" min={0} max={1} step={0.05} value={o.volume} format={(v) => (v === 0 ? "muted" : `${Math.round(v * 100)}%`)} onCommit={(v) => edit({ op: "update_overlay", id: o.id, volume: v })} />}
      {o.mode === "pip" && (
        <>
          <SliderRow label="PiP size" min={0.1} max={0.8} step={0.01} value={pip.w} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => edit({ op: "update_overlay", id: o.id, pip: { ...pip, w: v } })} />
          <SliderRow label="PiP x" min={0} max={0.95} step={0.01} value={pip.x} format={(v) => v.toFixed(2)} onCommit={(v) => edit({ op: "update_overlay", id: o.id, pip: { ...pip, x: v } })} />
          <SliderRow label="PiP y" min={0} max={0.95} step={0.01} value={pip.y} format={(v) => v.toFixed(2)} onCommit={(v) => edit({ op: "update_overlay", id: o.id, pip: { ...pip, y: v } })} />
        </>
      )}
    </div>
  );
}

function ZoomPanel({ z, project }: { z: Zoom; project: Project }) {
  const total = timelineDuration(project);
  return (
    <div className="section">
      <div className="section-title">
        Zoom {z.id}
        <button className="ghost danger" onClick={deleteSelection} title="Remove">
          <Icon name="trash" />
        </button>
      </div>
      <div className="row">
        <label>Motion</label>
        <div className="seg grow" style={{ display: "flex" }}>
          <button className={!z.ease ? "on" : ""} style={{ flex: 1 }} onClick={() => edit({ op: "update_zoom", id: z.id, ease: 0 }, "punch-in zoom")}>
            Punch
          </button>
          <button className={z.ease ? "on" : ""} style={{ flex: 1 }} onClick={() => edit({ op: "update_zoom", id: z.id, ease: Math.min(0.6, (z.end - z.start) / 3) }, "smooth zoom")}>
            Smooth
          </button>
        </div>
      </div>
      {!!z.ease && <SliderRow label="Ease" min={0.1} max={Math.max(0.2, (z.end - z.start) / 2)} step={0.05} value={z.ease} format={(v) => `${v.toFixed(2)}s`} onCommit={(v) => edit({ op: "update_zoom", id: z.id, ease: v })} />}
      <SliderRow label="Scale" min={1.05} max={2.5} step={0.05} value={z.scale} format={(v) => `×${v.toFixed(2)}`} onCommit={(v) => edit({ op: "update_zoom", id: z.id, scale: v })} />
      <NumberRow label="Start" value={z.start} step={0.1} onCommit={(v) => edit({ op: "update_zoom", id: z.id, start: Math.max(0, v) })} />
      <NumberRow label="End" value={z.end} step={0.1} onCommit={(v) => edit({ op: "update_zoom", id: z.id, end: Math.min(total, v) })} />
      <SliderRow label="Focus x" min={0} max={1} step={0.01} value={z.focus.x} format={(v) => v.toFixed(2)} onCommit={(v) => edit({ op: "update_zoom", id: z.id, x: v })} />
      <SliderRow label="Focus y" min={0} max={1} step={0.01} value={z.focus.y} format={(v) => v.toFixed(2)} onCommit={(v) => edit({ op: "update_zoom", id: z.id, y: v })} />
    </div>
  );
}

/** Click on a frame of the source to set the crop focus; shows the output crop window. */
function FocusPicker({ media, focus, project, onCommit }: { media: MediaAsset; focus: Focus; project: Project; t: number; onCommit: (f: Focus) => void }) {
  const hasStrip = useStore((s) => !!s.filmstrips[media.id]);
  const srcAspect = media.width / media.height;
  const outAspect = project.settings.width / project.settings.height;
  // Crop window size as a fraction of the source frame (cover fit).
  const bw = outAspect < srcAspect ? outAspect / srcAspect : 1;
  const bh = outAspect < srcAspect ? 1 : srcAspect / outAspect;
  const bx = Math.min(Math.max(focus.x - bw / 2, 0), 1 - bw);
  const by = Math.min(Math.max(focus.y - bh / 2, 0), 1 - bh);
  return (
    <div
      className="focus-picker"
      style={{ aspectRatio: `${media.width} / ${media.height}`, backgroundImage: hasStrip ? `url(/media/${media.id}/filmstrip.jpg)` : undefined, backgroundSize: "auto 100%" }}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onCommit({ x: Math.round(((e.clientX - r.left) / r.width) * 100) / 100, y: Math.round(((e.clientY - r.top) / r.height) * 100) / 100 });
      }}
      title="Click to set the focal point"
    >
      <div className="focus-box" style={{ left: `${bx * 100}%`, top: `${by * 100}%`, width: `${bw * 100}%`, height: `${bh * 100}%` }} />
      <div className="focus-dot" style={{ left: `${focus.x * 100}%`, top: `${focus.y * 100}%` }} />
    </div>
  );
}

// -------------------------------------------------------------- output tab

function OutputTab({ project }: { project: Project }) {
  const s = project.settings;
  const jobs = useStore((st) => st.jobs);
  const [quality, setQuality] = useState<"draft" | "standard" | "high">("standard");
  const aspect = Object.entries(ASPECTS).find(([, v]) => v.width === s.width && v.height === s.height)?.[0];
  const exports = Object.values(jobs).filter((j) => j.kind === "export").reverse();
  return (
    <>
      <div className="section">
        <div className="section-title">Format</div>
        <div className="row">
          <label>Aspect</label>
          <div className="seg grow" style={{ display: "flex" }}>
            {Object.keys(ASPECTS).map((a) => (
              <button key={a} className={aspect === a ? "on" : ""} style={{ flex: 1 }} onClick={() => edit({ op: "set_settings", aspect: a }, `aspect ${a}`)}>
                {a}
              </button>
            ))}
          </div>
        </div>
        <p className="hint" style={{ marginTop: 0 }}>
          {s.width}×{s.height} · {s.fps} fps. Reframing uses each clip's focal point (Edit tab).
        </p>
        <div className="row">
          <label>Frame rate</label>
          <select value={s.fps} onChange={(e) => edit({ op: "set_settings", fps: Number(e.target.value) })}>
            {[24, 25, 30, 50, 60].map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </div>
        <Toggle label="Normalize loudness (−16 LUFS)" checked={s.normalizeAudio} onChange={(v) => edit({ op: "set_settings", normalizeAudio: v })} />
      </div>
      <div className="section">
        <div className="section-title">Export</div>
        <div className="row">
          <label>Quality</label>
          <div className="seg grow" style={{ display: "flex" }}>
            {(["draft", "standard", "high"] as const).map((q) => (
              <button key={q} className={quality === q ? "on" : ""} style={{ flex: 1 }} onClick={() => setQuality(q)}>
                {q[0].toUpperCase() + q.slice(1)}
              </button>
            ))}
          </div>
        </div>
        <button className="primary" style={{ width: "100%", height: 36, marginTop: 4 }} onClick={() => void api.exportVideo(quality)} disabled={!project.clips.length}>
          <Icon name="download" size={14} /> Export video
        </button>
        <div className="row" style={{ marginTop: 8 }}>
          <a href="/api/srt" download className="grow">
            <button className="ghost sm" style={{ width: "100%" }}>Captions (.srt)</button>
          </a>
          <a href="/api/otio" download="timeline.otio" className="grow">
            <button className="ghost sm" style={{ width: "100%" }}>Timeline (.otio)</button>
          </a>
        </div>
        {exports.map((j) => (
          <div key={j.id} className="export-item">
            <Icon name="film" size={14} />
            <div className="name">
              {j.label.replace(/^Export /, "")}
              {j.status === "running" && (
                <div className="progress" style={{ width: "100%", marginTop: 6 }}>
                  <div style={{ width: `${j.progress * 100}%` }} />
                </div>
              )}
            </div>
            {j.status === "done" && j.result?.file && (
              <a href={`/exports/${encodeURIComponent(j.result.file)}?download`}>
                <button className="sm">
                  <Icon name="download" size={12} /> Save
                </button>
              </a>
            )}
            {j.status === "running" && <span className="mono muted">{Math.round(j.progress * 100)}%</span>}
            {j.status === "error" && <span style={{ color: "var(--danger)", fontSize: 12 }}>Failed</span>}
          </div>
        ))}
      </div>
    </>
  );
}

// ------------------------------------------------------------- history tab

function HistoryTab() {
  const history = useStore((s) => s.history);
  return (
    <>
      <div className="section" style={{ display: "flex", gap: 6, alignItems: "center", borderBottom: 0, paddingBottom: 8 }}>
        <span className="section-title grow" style={{ margin: 0 }}>
          History
        </span>
        <button className="ghost sm icon" title="Undo" onClick={() => void api.undo()} disabled={!history.undo.length}>
          <Icon name="undo" size={14} />
        </button>
        <button className="ghost sm icon" title="Redo" onClick={() => void api.redo()} disabled={!history.redo.length}>
          <Icon name="redo" size={14} />
        </button>
      </div>
      {[...history.redo].map((h) => (
        <HistRow key={`r${h.id}`} h={h} redo />
      ))}
      {[...history.undo].reverse().slice(0, 40).map((h) => (
        <HistRow key={h.id} h={h} />
      ))}
      {!history.undo.length && !history.redo.length && <p className="hint" style={{ padding: "0 16px 16px" }}>No edits yet.</p>}
    </>
  );
}

function HistRow({ h, redo }: { h: { id: number; label: string; origin: string; at: string }; redo?: boolean }) {
  return (
    <div className={`hist ${redo ? "redo" : ""}`} title={`by ${h.origin}`}>
      <span className={`who ${h.origin}`} />
      <span>
        {h.label} <span className="by">· {h.origin === "agent" ? "Agent" : h.origin === "editor" ? "You" : "CLI"}</span>
      </span>
      <span className="when">{new Date(h.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
    </div>
  );
}

// ------------------------------------------------------------ form helpers

/** A slider that previews locally and commits one edit on release. */
function SliderRow({ label, min, max, step, value, format, onCommit }: { label: string; min: number; max: number; step: number; value: number; format: (v: number) => string; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => local !== value && onCommit(local);
  return (
    <div className="row">
      <label>{label}</label>
      <input className="grow" type="range" min={min} max={max} step={step} value={local} onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
      <span className="val">{format(local)}</span>
    </div>
  );
}

function NumberRow({ label, value, step, onCommit }: { label: string; value: number; step: number; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(value.toFixed(2));
  useEffect(() => setLocal(value.toFixed(2)), [value]);
  const commit = () => {
    const v = Number(local);
    if (Number.isFinite(v) && Math.abs(v - value) > 1e-4) onCommit(v);
    else setLocal(value.toFixed(2));
  };
  return (
    <div className="row">
      <label>{label}</label>
      <input className="grow" type="number" step={step} value={local} onChange={(e) => setLocal(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      <span className="val">s</span>
    </div>
  );
}

function Toggle({ label, checked, onChange }: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
