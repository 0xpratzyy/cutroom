// Retakes: repeated attempts at the same line, with the suggested best take.
import { useEffect, useState } from "react";
import type { TakeGroup } from "../../../src/core/shared/retakes";
import { formatTime, sourceToTimeline } from "../../../src/core/shared/timeline";
import { api } from "../api";
import { engine } from "../engine";
import { store, toast, useStore } from "../store";
import { Icon } from "./Icon";

export function useRetakes(): TakeGroup[] | null {
  const project = useStore((s) => s.project);
  const transcripts = useStore((s) => s.transcripts);
  const [groups, setGroups] = useState<TakeGroup[] | null>(null);
  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const r = await fetch("/api/retakes").then((x) => (x.ok ? x.json() : null)).catch(() => null);
      if (live && r) setGroups(r);
    }, 300);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [project, transcripts]);
  return groups;
}

async function useTake(id: string, take: number) {
  const res = await fetch("/api/retakes/use", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, take }) });
  if (!res.ok) toast((await res.json().catch(() => ({}))).error ?? "Couldn't switch takes", "error");
}

export function Takes() {
  const groups = useRetakes();
  const project = useStore((s) => s.project);
  if (!project) return null;
  if (!groups) return <p className="hint" style={{ padding: 20 }}>Looking for retakes…</p>;
  const pending = groups.filter((g) => !g.takes[g.best].kept || g.takes.some((t, k) => k !== g.best && t.kept));

  return (
    <div className="scroll">
      <div className="toolbar">
        <span className="hint" style={{ flex: 1 }}>
          {groups.length ? `${groups.length} line${groups.length === 1 ? "" : "s"} said more than once` : "No retakes found"}
        </span>
        {pending.length > 0 && (
          <button
            className="sm primary"
            onClick={async () => {
              for (const g of pending) await useTake(g.id, g.best);
              toast(`Kept the best take in ${pending.length} place${pending.length === 1 ? "" : "s"}`);
            }}
          >
            <Icon name="check" size={12} /> Keep all suggested
          </button>
        )}
      </div>
      {!groups.length && (
        <div className="fb-empty">
          <div className="empty-icon" style={{ width: 40, height: 40, borderRadius: 11 }}>
            <Icon name="refresh" size={17} />
          </div>
          <h3>Retakes show up here</h3>
          <p>When you restart a line ("so today I want to… so today I want to show you"), cutroom groups the attempts and suggests the best one.</p>
        </div>
      )}
      {groups.map((g) => (
        <div key={g.id} className="take-group">
          <div className="take-head">
            <span className="mono muted">{formatTime(g.takes[0].start).replace(/^00:/, "")}</span>
            <span>{g.takes.length} takes</span>
          </div>
          {g.takes.map((t, k) => {
            const at = t.kept ? sourceToTimeline(project, t.mediaId, t.start) : null;
            return (
              <div key={k} className={`take ${t.kept ? "kept" : "cut"} ${k === g.best ? "best" : ""}`}>
                <button
                  className="ghost sm icon"
                  disabled={at === null}
                  title={at === null ? "This take is cut. Use it to hear it." : "Play this take"}
                  onClick={() => {
                    if (at === null) return;
                    void engine.seek(at).then(() => engine.play());
                  }}
                >
                  <Icon name="play" size={11} />
                </button>
                <div className="take-body">
                  <div className="take-text">{t.text}</div>
                  <div className="take-meta">
                    {k === g.best && <span className="badge ok">Suggested</span>}
                    {!t.complete && <span className="badge">Unfinished</span>}
                    {t.fillers > 0 && <span className="badge">{t.fillers} filler{t.fillers > 1 ? "s" : ""}</span>}
                    <span className="muted">{(t.end - t.start).toFixed(1)}s</span>
                  </div>
                </div>
                {t.kept && g.takes.filter((x) => x.kept).length === 1 ? (
                  <span className="take-in">In edit</span>
                ) : (
                  <button className="sm" onClick={() => void useTake(g.id, k)}>
                    Use
                  </button>
                )}
              </div>
            );
          })}
        </div>
      ))}
      {groups.length > 0 && (
        <div style={{ padding: 16 }}>
          <button
            className="sm agent-btn"
            onClick={async () => {
              const fb = await api.addFeedback({ note: "Review the retakes (find_retakes) and keep the strongest take of each line; explain your picks.", time: { start: 0, end: null } });
              if (fb) {
                toast(`Asked Claude (note #${fb.n})`, "agent");
                store.set({ rightTab: "feedback", rightOpen: true });
              }
            }}
          >
            <Icon name="sparkle" size={12} /> Ask Claude to pick
          </button>
        </div>
      )}
    </div>
  );
}
