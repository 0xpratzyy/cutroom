// Agentation-style feedback for video: pin a spot or box on the frame, select words,
// a range or a clip, and leave a numbered note. Agents pick notes up over MCP
// (get_feedback / wait_for_feedback), work on them, reply and resolve.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { feedbackMarkdown, feedbackTime } from "../../../src/core/shared/feedback";
import { formatTime } from "../../../src/core/shared/timeline";
import type { Feedback } from "../../../src/core/shared/types";
import { openComposer, toggleAnnotate } from "../actions";
import { api } from "../api";
import { engine } from "../engine";
import { store, toast, useStore } from "../store";
import { Icon } from "./Icon";
import { ReviewPanel } from "./Review";

/** Notes whose moment is on screen at time t. */
function visibleAt(project: NonNullable<ReturnType<typeof store.get>["project"]>, items: Feedback[], t: number) {
  return items.filter((f) => {
    if (!f.region) return false;
    const ft = feedbackTime(project, f);
    if (ft.cut) return false;
    const end = ft.end ?? ft.start + 1.5;
    return t >= ft.start - 0.2 && t <= end;
  });
}

export function focusFeedback(f: Feedback) {
  const p = store.get().project;
  if (!p) return;
  const ft = feedbackTime(p, f);
  engine.pause();
  void engine.seek(ft.start + 0.001);
  store.set({ focusFeedback: f.id, rightTab: "feedback", inspectorOpen: true });
}

// ---------------------------------------------------------------- frame layer

/** Sits over the video frame: draws markers, and captures clicks/drags in annotate mode. */
export function AnnotationLayer() {
  const annotating = useStore((s) => s.annotating);
  const project = useStore((s) => s.project);
  const items = useStore((s) => s.feedback);
  const time = useStore((s) => Math.round(s.time * 10) / 10);
  const focus = useStore((s) => s.focusFeedback);
  const composer = useStore((s) => s.composer);
  const layer = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);

  const shown = useMemo(() => {
    if (!project) return [];
    const open = items.filter((f) => f.status !== "resolved" || f.id === focus);
    return visibleAt(project, open, time);
  }, [project, items, time, focus]);

  const norm = (e: React.PointerEvent) => {
    const r = layer.current!.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };

  return (
    <div
      ref={layer}
      className={`annot-layer ${annotating ? "on" : ""}`}
      onPointerDown={(e) => {
        if (!annotating) return;
        e.stopPropagation();
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = norm(e);
        setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        const p = norm(e);
        setDrag({ ...drag, x1: p.x, y1: p.y });
      }}
      onPointerUp={(e) => {
        if (!drag) return;
        const r = layer.current!.getBoundingClientRect();
        const w = Math.abs(drag.x1 - drag.x0);
        const h = Math.abs(drag.y1 - drag.y0);
        const isBox = w * r.width > 8 && h * r.height > 8;
        const region = isBox ? { x: Math.min(drag.x0, drag.x1), y: Math.min(drag.y0, drag.y1), w, h } : { x: drag.x0, y: drag.y0, w: 0, h: 0 };
        setDrag(null);
        openComposer({ region, x: e.clientX, y: e.clientY });
      }}
      onClick={(e) => annotating && e.stopPropagation()}
    >
      {shown.map((f) => (
        <Marker key={f.id} f={f} focused={f.id === focus} />
      ))}
      {drag && <div className="annot-draft" style={box(Math.min(drag.x0, drag.x1), Math.min(drag.y0, drag.y1), Math.abs(drag.x1 - drag.x0), Math.abs(drag.y1 - drag.y0))} />}
      {composer?.region && <DraftMarker region={composer.region} />}
    </div>
  );
}

function box(x: number, y: number, w: number, h: number): React.CSSProperties {
  return { left: `${x * 100}%`, top: `${y * 100}%`, width: `${w * 100}%`, height: `${h * 100}%` };
}

function Marker({ f, focused }: { f: Feedback; focused: boolean }) {
  const r = f.region!;
  const pin = r.w < 0.01 && r.h < 0.01;
  const cls = `marker ${f.status} ${focused ? "focus" : ""}`;
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    focusFeedback(f);
  };
  if (pin)
    return (
      <button className={`${cls} pin`} style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }} onClick={onClick} title={f.note} aria-label={`Note ${f.n}: ${f.note}`}>
        {f.status === "resolved" ? <Icon name="check" size={11} /> : f.n}
      </button>
    );
  return (
    <div className={`${cls} boxed`} style={box(r.x, r.y, r.w, r.h)}>
      <button className="marker-tag" onClick={onClick} title={f.note} aria-label={`Note ${f.n}: ${f.note}`}>
        {f.status === "resolved" ? <Icon name="check" size={11} /> : f.n}
      </button>
    </div>
  );
}

function DraftMarker({ region: r }: { region: NonNullable<Feedback["region"]> }) {
  if (r.w < 0.01 && r.h < 0.01) return <div className="marker pin draft" style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%` }} />;
  return <div className="marker boxed draft" style={box(r.x, r.y, r.w, r.h)} />;
}

// ------------------------------------------------------------------- composer

export function Composer() {
  const c = useStore((s) => s.composer);
  const nextN = useStore((s) => s.feedback.reduce((m, f) => Math.max(m, f.n), 0) + 1);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: 0, top: 0 });

  useEffect(() => setNote(""), [c]);
  useLayoutEffect(() => {
    if (!c || !ref.current) return;
    const w = ref.current.offsetWidth;
    const h = ref.current.offsetHeight;
    // Prefer just below-right of the point; keep on screen.
    let left = c.x + 14;
    let top = c.y + 14;
    if (left + w > window.innerWidth - 12) left = c.x - w - 14;
    if (top + h > window.innerHeight - 12) top = c.y - h - 14;
    setPos({ left: Math.max(12, left), top: Math.max(56, top) });
  }, [c]);

  if (!c) return null;
  const submit = async () => {
    if (!note.trim() || busy) return;
    setBusy(true);
    const fb = await api.addFeedback({ note, time: c.time, region: c.region, words: c.words, target: c.target });
    setBusy(false);
    if (fb) {
      store.set({ composer: null, words: null, focusFeedback: fb.id });
      window.getSelection()?.removeAllRanges();
    }
  };
  const when = c.time.end !== null ? `${formatTime(c.time.start)} – ${formatTime(c.time.end)}` : formatTime(c.time.start);
  return (
    <div className="composer" ref={ref} style={pos} role="dialog" aria-label="New note">
      <div className="composer-head">
        <span className="fb-num">{nextN}</span>
        <span className="chip">{when}</span>
        {c.region && <span className="chip">{c.region.w < 0.01 ? "Point" : "Area"}</span>}
        {c.target && <span className="chip">{c.target.type}</span>}
      </div>
      {c.words && <div className="fb-quote">“{c.words.text}”</div>}
      <textarea
        autoFocus
        rows={3}
        placeholder={c.region ? "What should change here?" : c.words ? "What should change about these words?" : "What should change at this moment?"}
        value={note}
        onChange={(e) => setNote(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit();
          if (e.key === "Escape") store.set({ composer: null });
          e.stopPropagation();
        }}
      />
      <div className="composer-foot">
        <span className="hint">
          <kbd>⌘</kbd>
          <kbd>↵</kbd> to add
        </span>
        <span className="spacer" />
        <button className="ghost sm" onClick={() => store.set({ composer: null })}>
          Cancel
        </button>
        <button className="coral sm" disabled={!note.trim() || busy} onClick={() => void submit()}>
          Add note
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------- panel

export function FeedbackPanel() {
  const project = useStore((s) => s.project);
  const items = useStore((s) => s.feedback);
  const filter = useStore((s) => s.feedbackFilter);
  const focus = useStore((s) => s.focusFeedback);
  const open = items.filter((f) => f.status !== "resolved");
  const resolved = items.filter((f) => f.status === "resolved");
  const shown = (filter === "open" ? open : filter === "resolved" ? resolved : items).slice().sort((a, b) => b.n - a.n);

  useEffect(() => {
    if (!focus) return;
    // Scroll only the panel's own list; scrollIntoView would also scroll clipped ancestors.
    const card = document.querySelector<HTMLElement>(`[data-fb="${focus}"]`);
    const list = card?.closest<HTMLElement>(".scroll");
    if (card && list) {
      const top = card.offsetTop - list.offsetTop;
      if (top < list.scrollTop || top + card.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTo({ top: top - 60, behavior: "smooth" });
    }
  }, [focus]);

  if (!project) return null;
  return (
    <>
      <ReviewPanel />
      <div className="section fb-header">
        <AgentStatus />
        <div className="row" style={{ marginTop: 12 }}>
          <div className="seg grow" style={{ display: "flex" }}>
            <button className={filter === "open" ? "on" : ""} style={{ flex: 1 }} onClick={() => store.set({ feedbackFilter: "open" })}>
              Open {open.length ? <span className="tab-count">{open.length}</span> : null}
            </button>
            <button className={filter === "resolved" ? "on" : ""} style={{ flex: 1 }} onClick={() => store.set({ feedbackFilter: "resolved" })}>
              Resolved
            </button>
            <button className={filter === "all" ? "on" : ""} style={{ flex: 1 }} onClick={() => store.set({ feedbackFilter: "all" })}>
              All
            </button>
          </div>
          <button
            className="sm"
            title="Copy notes as markdown, to paste into any agent"
            disabled={!open.length}
            onClick={() => {
              void navigator.clipboard?.writeText(feedbackMarkdown(project, open.slice().sort((a, b) => a.n - b.n)));
              toast(`Copied ${open.length} note${open.length === 1 ? "" : "s"} as markdown`);
            }}
          >
            <Icon name="copy" size={13} /> Copy
          </button>
        </div>
      </div>
      {shown.map((f) => (
        <FeedbackCard key={f.id} f={f} focused={f.id === focus} />
      ))}
      {!shown.length && <EmptyFeedback filter={filter} />}
    </>
  );
}

function EmptyFeedback({ filter }: { filter: string }) {
  if (filter !== "open") return <p className="hint" style={{ padding: "8px 16px" }}>Nothing here yet.</p>;
  return (
    <div className="fb-empty">
      <div className="fb-empty-art">
        <span className="marker pin static">1</span>
      </div>
      <h3>Point at what to fix</h3>
      <p>
        Press <kbd>A</kbd> and click the video to pin a note, or drag to mark an area. Select transcript words or a timeline range and press <kbd>C</kbd>.
      </p>
      <p>Claude picks notes up over MCP, fixes them, and replies here.</p>
      <button className="coral" onClick={() => toggleAnnotate(true)}>
        <Icon name="pin" size={13} /> Start annotating
      </button>
    </div>
  );
}

function AgentStatus() {
  const agent = useStore((s) => s.agent);
  const [help, setHelp] = useState(false);
  const cmd = "claude mcp add cutroom -- npx -y cutroom mcp";
  const ask = "Work through my cutroom feedback, then keep watching for more.";
  const label = !agent ? "No agent connected" : agent.watching ? "Claude is watching for notes" : "Claude connected";
  return (
    <div className={`agent-status ${!agent ? "off" : agent.watching ? "watching" : "on"}`}>
      <div className="agent-status-row">
        <span className="dot" />
        <span className="grow">{label}</span>
        <button className="ghost sm" onClick={() => setHelp(!help)}>
          {help ? "Hide" : "How"}
        </button>
      </div>
      {help && (
        <div className="agent-help">
          <p>1. Connect cutroom to Claude Code:</p>
          <CopyLine text={cmd} />
          <p>2. Ask Claude:</p>
          <CopyLine text={ask} />
          <p className="hint">Claude marks notes as working, edits, previews, and resolves them with a reply. Edits show up live.</p>
        </div>
      )}
    </div>
  );
}

function CopyLine({ text }: { text: string }) {
  const [done, setDone] = useState(false);
  return (
    <div className="cmd">
      <code>{text}</code>
      <button
        className="ghost sm"
        onClick={() => {
          void navigator.clipboard?.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }}
      >
        {done ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

function VoicePlay({ file }: { file: string }) {
  const [playing, setPlaying] = useState(false);
  const el = useRef<HTMLAudioElement | null>(null);
  return (
    <button
      className="voice-play"
      title="Play the voice note"
      onClick={(e) => {
        e.stopPropagation();
        const a = (el.current ??= new Audio(`/voice/${encodeURIComponent(file)}`));
        if (playing) {
          a.pause();
          a.currentTime = 0;
          return setPlaying(false);
        }
        a.onended = () => setPlaying(false);
        void a.play().then(() => setPlaying(true));
      }}
    >
      <Icon name={playing ? "pause" : "mic"} size={11} />
    </button>
  );
}

const STATUS_LABEL: Record<Feedback["status"], string> = { open: "Open", working: "Claude working", resolved: "Resolved" };

function FeedbackCard({ f, focused }: { f: Feedback; focused: boolean }) {
  const project = useStore((s) => s.project)!;
  const [reply, setReply] = useState("");
  const [replying, setReplying] = useState(false);
  const ft = feedbackTime(project, f);
  const when = ft.end !== null ? `${formatTime(ft.start)} – ${formatTime(ft.end)}` : formatTime(ft.start);
  return (
    <div className={`fb-card ${f.status} ${focused ? "focus" : ""}`} data-fb={f.id} onClick={() => focusFeedback(f)}>
      <div className="fb-top">
        <span className={`fb-num ${f.status}`}>{f.status === "resolved" ? <Icon name="check" size={11} /> : f.n}</span>
        <span className="fb-when">{ft.cut ? "cut from edit" : when}</span>
        {f.region && <span className="fb-kind">{f.region.w < 0.01 ? "point" : "area"}</span>}
        {f.target && <span className="fb-kind">{f.target.type}</span>}
        {f.voice && <span className="fb-kind">voice</span>}
        <span className="spacer" />
        <span className={`status ${f.status}`}>
          {f.status === "working" && <span className="spinner" />}
          {STATUS_LABEL[f.status]}
        </span>
      </div>
      {f.words && <div className="fb-quote">“{f.words.text}”</div>}
      <div className="fb-note">
        {f.voice && <VoicePlay file={f.voice} />}
        {f.note}
      </div>
      {f.replies.map((r, i) => (
        <div key={i} className={`fb-reply ${r.author}`}>
          <span className="who">{r.author === "agent" ? <Icon name="sparkle" size={11} /> : "You"}</span>
          <span>{r.text}</span>
        </div>
      ))}
      <div className="fb-actions" onClick={(e) => e.stopPropagation()}>
        {f.status !== "resolved" ? (
          <button className="ghost sm" onClick={() => void api.updateFeedback(f.id, { status: "resolved" })}>
            <Icon name="check" size={13} /> Resolve
          </button>
        ) : (
          <button className="ghost sm" onClick={() => void api.updateFeedback(f.id, { status: "open" })}>
            <Icon name="refresh" size={13} /> Reopen
          </button>
        )}
        <button className="ghost sm" onClick={() => setReplying(!replying)}>
          Reply
        </button>
        <span className="spacer" />
        <button className="ghost sm icon danger" title="Delete note" onClick={() => void api.deleteFeedback(f.id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      {replying && (
        <form
          className="fb-reply-form"
          onClick={(e) => e.stopPropagation()}
          onSubmit={(e) => {
            e.preventDefault();
            if (!reply.trim()) return;
            void api.updateFeedback(f.id, { reply, status: f.status === "resolved" ? "open" : undefined });
            setReply("");
            setReplying(false);
          }}
        >
          <input autoFocus placeholder="Add a follow-up" value={reply} onChange={(e) => setReply(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
          <button type="submit" className="sm" disabled={!reply.trim()}>
            Send
          </button>
        </form>
      )}
    </div>
  );
}
