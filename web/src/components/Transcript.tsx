// Text-based editing: select words and press Delete to cut them, select cut words to restore.
import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { isFiller, mapWords, normalizeWord, type TimelineWord } from "../../../src/core/shared/timeline";
import type { Project, Transcript as T } from "../../../src/core/shared/types";
import { addZoomHere, deleteSelection, openComposer } from "../actions";
import { api } from "../api";
import { engine } from "../engine";
import { STEP_LABELS, store, useStore } from "../store";
import { Icon } from "./Icon";

interface Para {
  key: string;
  mediaId: string;
  words: TimelineWord[];
}

function paragraphs(project: Project, transcripts: Record<string, T>): Para[] {
  const ids = [...new Set(project.clips.map((c) => c.mediaId))].filter((id) => transcripts[id]);
  const out: Para[] = [];
  for (const id of ids) {
    let cur: TimelineWord[] = [];
    const words = mapWords(project, transcripts[id]);
    words.forEach((w, n) => {
      cur.push(w);
      const next = words[n + 1];
      const sentenceEnd = /[.?!]$/.test(w.word.text);
      if (!next || (sentenceEnd && (next.word.start - w.word.end > 1.0 || cur.length > 45))) {
        out.push({ key: `${id}-${cur[0].word.i}`, mediaId: id, words: cur });
        cur = [];
      }
    });
  }
  return out;
}

export function Transcript() {
  const project = useStore((s) => s.project);
  const transcripts = useStore((s) => s.transcripts);
  const showCut = useStore((s) => s.showCut);
  const jobs = useStore((s) => s.jobs);
  const feedback = useStore((s) => s.feedback);
  const [query, setQuery] = useState("");
  const container = useRef<HTMLDivElement>(null);
  const [bar, setBar] = useState<{ x: number; y: number; restore: boolean } | null>(null);
  const selectedWords = useStore((s) => s.words);
  const composing = useStore((s) => !!s.composer);
  useEffect(() => {
    if (!selectedWords || composing) setBar(null);
  }, [selectedWords, composing]);

  const paras = useMemo(() => (project ? paragraphs(project, transcripts) : []), [project, transcripts]);
  const fillerCount = useMemo(() => paras.reduce((n, p) => n + p.words.filter((w) => w.kept && isFiller(w.word.text)).length, 0), [paras]);
  const needle = useMemo(() => query.split(/\s+/).map(normalizeWord).filter(Boolean), [query]);

  // Kept words in timeline order, for a binary search on every playhead tick.
  const kept = useMemo(() => paras.flatMap((p) => p.words.filter((w) => w.kept)).sort((a, b) => a.start - b.start), [paras]);

  // Words Claude cut (red) or brought back (green), from the review diff.
  const review = useStore((s) => s.review);
  const diffMarks = useMemo(() => {
    const m = new Map<string, "diff-cut" | "diff-add">();
    if (!review) return m;
    for (const c of review.changes) {
      if ((c.kind !== "cut" && c.kind !== "restore") || !c.mediaId) continue;
      const t = transcripts[c.mediaId];
      if (!t) continue;
      for (const w of t.words) {
        const mid = (w.start + w.end) / 2;
        if (mid >= c.srcStart! && mid < c.srcEnd!) m.set(`${c.mediaId}:${w.i}`, c.kind === "cut" ? "diff-cut" : "diff-add");
      }
    }
    return m;
  }, [review, transcripts]);

  // Notes attached to words: first word shows the note number.
  const fbMarks = useMemo(() => {
    const m = new Map<string, number>();
    for (const f of feedback) {
      if (!f.words || f.status === "resolved") continue;
      for (let i = f.words.from; i <= f.words.to; i++) m.set(`${f.words.mediaId}:${i}`, i === f.words.from ? f.n : 0);
    }
    return m;
  }, [feedback]);

  // Highlight the word under the playhead without re-rendering the transcript.
  useEffect(() => {
    let lastWord: TimelineWord | null = null;
    let lastEl: Element | null = null;
    const unsub = store.subscribe(() => {
      const { time, playing } = store.get();
      const root = container.current;
      if (!root) return;
      const w = findWordAt(kept, time);
      if (w === lastWord) return;
      lastWord = w;
      const el = w ? root.querySelector(`[data-k="${w.mediaId}:${w.word.i}"]`) : null;
      lastEl?.classList.remove("now");
      el?.classList.add("now");
      lastEl = el;
      if (el && playing) {
        const r = el.getBoundingClientRect();
        const box = root.parentElement!.getBoundingClientRect();
        if (r.top < box.top + 40 || r.bottom > box.bottom - 40) el.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
    return () => {
      unsub();
      lastEl?.classList.remove("now");
    };
  }, [kept]);

  if (!project) return null;
  const mainIds = [...new Set(project.clips.map((c) => c.mediaId))];
  const missing = mainIds.filter((id) => !transcripts[id] && project.media.find((m) => m.id === id)?.hasAudio);
  const running = Object.values(jobs).filter((j) => j.kind === "analyze" && j.status === "running");

  const onSelectEnd = () => {
    const sel = window.getSelection();
    const root = container.current;
    if (!sel || !root || !sel.rangeCount) return;
    if (sel.isCollapsed) {
      setBar(null);
      store.set({ words: null });
      return;
    }
    const range = sel.getRangeAt(0);
    // intersectsNode() is true when the selection merely touches a word's edge; require real overlap.
    const overlaps = (s: HTMLElement) => {
      if (!range.intersectsNode(s)) return false;
      const text = s.firstChild;
      if (range.endContainer === text && range.endOffset === 0) return false;
      if (range.startContainer === text && range.startOffset === (text?.textContent?.length ?? 0)) return false;
      return true;
    };
    const spans = [...root.querySelectorAll<HTMLElement>(".w")].filter(overlaps);
    if (!spans.length) return;
    const mediaId = spans[0].dataset.m!;
    const idx = spans.filter((s) => s.dataset.m === mediaId).map((s) => Number(s.dataset.i));
    const from = Math.min(...idx);
    const to = Math.max(...idx);
    store.set({ words: { mediaId, from, to }, items: [], range: null });
    const rect = range.getBoundingClientRect();
    const restore = spans.every((s) => s.classList.contains("cut"));
    setBar({ x: rect.left + rect.width / 2, y: rect.top - 44, restore });
  };

  const onClick = (e: React.MouseEvent) => {
    if (!window.getSelection()?.isCollapsed) return;
    const t = (e.target as HTMLElement).closest<HTMLElement>(".w");
    if (t && t.dataset.t) {
      engine.pause();
      void engine.seek(Number(t.dataset.t) + 0.001);
    }
  };

  return (
    <>
      <div className="toolbar">
        <div className="search">
          <Icon name="search" size={14} />
          <input type="search" placeholder="Search transcript" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className="sm" title="Cut every um, uh, erm…" disabled={!fillerCount} onClick={() => void api.edit([{ op: "remove_fillers" }])}>
          <Icon name="wand" size={13} /> Fillers {fillerCount ? <span className="count">{fillerCount}</span> : null}
        </button>
        <button className="sm" title="Tighten pauses longer than 0.6s" disabled={!mainIds.length} onClick={() => void api.edit([{ op: "remove_silences" }])}>
          <Icon name="compress" size={13} /> Pauses
        </button>
        <button className={`sm icon ghost ${showCut ? "" : "on"}`} title={showCut ? "Hide cut words" : "Show cut words"} onClick={() => store.set({ showCut: !showCut })}>
          <Icon name={showCut ? "eye" : "eyeOff"} size={14} />
        </button>
      </div>
      <div className="scroll" onScroll={() => bar && setBar(null)}>
        {missing.length > 0 && (
          <div className="notice">
            {running.length ? (
              <>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                  <Icon name="mic" size={14} /> <b style={{ fontWeight: 600 }}>{STEP_LABELS[running[0].detail ?? ""] ?? "Preparing"}…</b>
                  <span className="spacer" />
                  <span className="mono muted" style={{ fontSize: 11 }}>{Math.round(running[0].progress * 100)}%</span>
                </div>
                <div className="progress" style={{ width: "100%" }}>
                  <div style={{ width: `${Math.max(2, Math.round(running[0].progress * 100))}%` }} />
                </div>
                <p className="hint" style={{ margin: "10px 0 0" }}>Everything runs on this computer. The first transcription also downloads the speech model, so it takes longer.</p>
              </>
            ) : (
              <>
                <p style={{ margin: "0 0 10px" }}>No transcript yet. Transcribe to edit by text, cut fillers and add captions.</p>
                {missing.map((id) => (
                  <button key={id} className="primary sm" onClick={() => void api.analyze(id)}>
                    <Icon name="sparkle" size={13} /> Transcribe {project.media.find((m) => m.id === id)?.name ?? id}
                  </button>
                ))}
              </>
            )}
          </div>
        )}
        {!mainIds.length && (
          <div style={{ padding: "48px 28px", textAlign: "center" }}>
            <div className="empty-icon" style={{ width: 40, height: 40, borderRadius: 11 }}>
              <Icon name="mic" size={17} />
            </div>
            <p className="hint" style={{ marginTop: 12 }}>The transcript of your recording appears here. Edit the video by editing the text.</p>
          </div>
        )}
        <div className="doc" ref={container} onMouseUp={onSelectEnd} onKeyUp={(e) => e.shiftKey && onSelectEnd()} onClick={onClick}>
          <Paragraphs paras={paras} showCut={showCut} needle={needle} media={project.media} fbMarks={fbMarks} diffMarks={diffMarks} />
        </div>
      </div>
      {bar && (
        <div className="word-actions" style={{ left: Math.max(8, bar.x - 120), top: Math.max(56, bar.y) }} onMouseDown={(e) => e.preventDefault()}>
          <button
            onClick={() => {
              deleteSelection();
              setBar(null);
            }}
          >
            <Icon name={bar.restore ? "undo" : "scissors"} size={13} /> {bar.restore ? "Restore" : "Cut"} <kbd>⌫</kbd>
          </button>
          <button
            onClick={() => {
              const r = window.getSelection()?.getRangeAt(0).getBoundingClientRect();
              openComposer(r ? { x: r.left, y: r.bottom } : undefined);
              setBar(null);
            }}
          >
            <Icon name="message" size={13} /> Note <kbd>C</kbd>
          </button>
          {!bar.restore && (
            <button
              onClick={() => {
                addZoomHere();
                setBar(null);
              }}
            >
              <Icon name="zoom" size={13} /> Zoom <kbd>Z</kbd>
            </button>
          )}
          {!bar.restore && (
            <button
              onClick={() => {
                const s = store.get();
                const w = s.words && paras.flatMap((p) => p.words).find((x) => x.mediaId === s.words!.mediaId && x.word.i >= s.words!.from && x.kept);
                if (w) void engine.seek(w.start).then(() => engine.play());
                setBar(null);
              }}
            >
              <Icon name="play" size={12} /> Play
            </button>
          )}
        </div>
      )}
    </>
  );
}

const Paragraphs = memo(function Paragraphs({ paras, showCut, needle, media, fbMarks, diffMarks }: { paras: Para[]; showCut: boolean; needle: string[]; media: Project["media"]; fbMarks: Map<string, number>; diffMarks: Map<string, string> }) {
  const matches = useMemo(() => {
    const set = new Set<string>();
    if (!needle.length) return set;
    const flat = paras.flatMap((p) => p.words);
    const norm = flat.map((w) => normalizeWord(w.word.text));
    for (let i = 0; i + needle.length <= flat.length; i++) {
      if (needle.every((n, k) => norm[i + k].startsWith(n) && (k === needle.length - 1 || norm[i + k] === n))) {
        for (let k = 0; k < needle.length; k++) set.add(`${flat[i + k].mediaId}:${flat[i + k].word.i}`);
      }
    }
    return set;
  }, [paras, needle]);

  const multi = new Set(paras.map((p) => p.mediaId)).size > 1;
  return (
    <>
      {paras.map((p, n) => {
        const header = multi && (n === 0 || paras[n - 1].mediaId !== p.mediaId) ? (media.find((m) => m.id === p.mediaId)?.name ?? p.mediaId) : null;
        // Everything a paragraph's markup depends on, so an edit elsewhere (or a playhead/selection
        // change) doesn't re-render all ~10k words of a long transcript, only the paragraphs it touched.
        let sig = `${header ?? ""}|${showCut ? 1 : 0}`;
        for (const w of p.words) {
          const k = `${w.mediaId}:${w.word.i}`;
          sig += `|${w.word.i}:${w.word.text}:${w.word.conf ?? ""}${w.kept ? `k${w.start}-${w.end}` : "c"}${matches.has(k) ? "m" : ""}${fbMarks.get(k) ?? ""}${diffMarks.get(k) ?? ""}`;
        }
        return <Paragraph key={p.key} sig={sig} p={p} header={header} showCut={showCut} matches={matches} fbMarks={fbMarks} diffMarks={diffMarks} />;
      })}
    </>
  );
});

interface ParagraphProps {
  sig: string;
  p: Para;
  header: string | null;
  showCut: boolean;
  matches: Set<string>;
  fbMarks: Map<string, number>;
  diffMarks: Map<string, string>;
}

const Paragraph = memo(
  function Paragraph({ p, header, showCut, matches, fbMarks, diffMarks }: ParagraphProps) {
    let prevKept: TimelineWord | null = null;
    const firstKept = p.words.find((w) => w.kept);
    if (!firstKept && !showCut) return null;
    return (
      <>
        {header !== null && (
          <div className="doc-media">
            <span className="label">{header}</span>
          </div>
        )}
        {/* content-visibility lets the browser skip layout/paint of off-screen paragraphs (no visual change). */}
        <div className="para" style={PARA_STYLE}>
          <div
            className="para-time"
            title="Jump here"
            onClick={() => {
              if (!firstKept) return;
              engine.pause();
              void engine.seek(firstKept.start + 0.001);
            }}
          >
            {firstKept ? formatClock(firstKept.start) : "cut"}
          </div>
          <div className="para-text">
            {p.words.map((w) => {
              if (!w.kept && !showCut && !diffMarks.has(`${w.mediaId}:${w.word.i}`)) return null;
              const gap = w.kept && prevKept ? w.start - prevKept.end : 0;
              const before = prevKept;
              if (w.kept) prevKept = w;
              const k = `${w.mediaId}:${w.word.i}`;
              const fbn = fbMarks.get(k);
              const cls = ["w", w.kept ? "" : "cut", isFiller(w.word.text) ? "filler" : "", matches.has(k) ? "match" : "", (w.word.conf ?? 1) < 0.5 ? "low" : "", fbn !== undefined ? "fb" : "", fbn ? "fb-start" : "", diffMarks.get(k) ?? ""].filter(Boolean).join(" ");
              return (
                <Fragment key={k}>
                  {gap >= 0.6 && before && (
                    <span
                      className="pause"
                      title="Click to tighten this pause"
                      onClick={(e) => {
                        e.stopPropagation();
                        void api.edit([{ op: "cut", start: before.end + 0.15, end: w.start - 0.15 }], "tighten pause");
                      }}
                    >
                      {gap.toFixed(1)}s
                    </span>
                  )}
                  <span className={cls} data-k={k} data-m={w.mediaId} data-i={w.word.i} data-t={w.kept ? w.start : undefined} data-fbn={fbn || undefined} title={(w.word.conf ?? 1) < 0.5 ? `Low confidence (${Math.round((w.word.conf ?? 0) * 100)}%)` : undefined}>
                    {w.word.text}
                  </span>{" "}
                </Fragment>
              );
            })}
          </div>
        </div>
      </>
    );
  },
  (a, b) => a.sig === b.sig,
);

const PARA_STYLE: React.CSSProperties = { contentVisibility: "auto", containIntrinsicSize: "auto 96px" };

function formatClock(t: number) {
  const m = Math.floor(t / 60);
  return `${m}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
}

function findWordAt(kept: TimelineWord[], t: number): TimelineWord | null {
  let lo = 0;
  let hi = kept.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const w = kept[mid];
    if (t < w.start - 0.01) hi = mid - 1;
    else if (t >= w.end + 0.05) lo = mid + 1;
    else return w;
  }
  return null;
}
