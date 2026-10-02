import { useState } from "react";
import { formatTime } from "../../../src/core/shared/timeline";
import type { MediaAsset } from "../../../src/core/shared/types";
import { addBrollAt } from "../actions";
import { api } from "../api";
import { STEP_LABELS, useStore, toast } from "../store";
import { Icon } from "./Icon";
import { MEDIA_MIME } from "./Timeline";

export function MediaBin() {
  const media = useStore((s) => s.project?.media ?? []);
  const clips = useStore((s) => s.project?.clips ?? []);
  const filmstrips = useStore((s) => s.filmstrips);
  const jobs = useStore((s) => s.jobs);
  const [path, setPath] = useState("");

  return (
    <div className="scroll">
      <div className="toolbar">
        <form
          style={{ display: "flex", gap: 6, flex: 1 }}
          onSubmit={(e) => {
            e.preventDefault();
            const p = path.trim().replace(/^['"]|['"]$/g, "");
            if (!p) return;
            void api.importPaths([p], "library");
            setPath("");
          }}
        >
          <input style={{ flex: 1 }} placeholder="Paste a file path to import…" value={path} onChange={(e) => setPath(e.target.value)} />
          <button type="submit" className="sm icon" title="Import" style={{ height: 30, width: 30 }}>
            <Icon name="plus" size={14} />
          </button>
        </form>
      </div>
      <p className="hint" style={{ padding: "12px 16px 0", margin: 0 }}>
        Drop files onto the window. Drag items onto the <b style={{ color: "var(--text-2)" }}>Main</b> or <b style={{ color: "var(--text-2)" }}>B-roll</b> track.
      </p>
      <div className="media-list">
      {media.map((m) => {
        const job = Object.values(jobs).find((j) => j.kind === "analyze" && j.status === "running" && j.label.endsWith(m.name));
        const onMain = clips.some((c) => c.mediaId === m.id);
        return (
          <div
            key={m.id}
            className="media-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(MEDIA_MIME, m.id);
              e.dataTransfer.effectAllowed = "copy";
            }}
          >
            <Thumb m={m} hasStrip={!!filmstrips[m.id]} />
            <div style={{ minWidth: 0 }}>
              <div className="media-name" title={m.path}>
                {m.name}
              </div>
              <div className="media-meta">
                {m.kind === "image" ? `${m.width}×${m.height}` : `${formatTime(m.duration)}${m.hasVideo ? ` · ${m.width}×${m.height}` : ""}`}
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center", flexWrap: "wrap" }}>
                {onMain && <span className="badge ok">Main</span>}
                {m.analysis.transcript && <span className="badge">Transcript</span>}
                {job && (
                  <span className="badge agent">
                    {STEP_LABELS[job.detail ?? ""] ?? "Analyzing"} {Math.round(job.progress * 100)}%
                  </span>
                )}
                <span className="spacer" />
                {m.hasVideo && (
                  <button className="ghost sm" title="Add as b-roll at the playhead" onClick={() => addBrollAt(m.id)}>
                    + B-roll
                  </button>
                )}
                {m.kind !== "image" && (
                  <button className="ghost sm" title="Append to the main track" onClick={() => void api.edit([{ op: "add_clip", mediaId: m.id }])}>
                    + Main
                  </button>
                )}
                {m.hasAudio && !job && (
                  <button
                    className="ghost"
                    style={{ padding: "2px 6px", fontSize: 12 }}
                    title="Re-run transcription and silence detection"
                    onClick={() => {
                      void api.analyze(m.id, ["transcript", "silences"], true);
                      toast(`Re-analyzing ${m.name}`);
                    }}
                  >
                    <Icon name="refresh" size={12} />
                  </button>
                )}
              </div>
            </div>
          </div>
        );
      })}
      </div>
      {!media.length && <p className="hint" style={{ padding: "0 16px" }}>No media yet.</p>}
    </div>
  );
}

function Thumb({ m, hasStrip }: { m: MediaAsset; hasStrip: boolean }) {
  if (m.kind === "image") return <div className="thumb" style={{ backgroundImage: `url(/media/${m.id}/file)`, backgroundSize: "cover" }} />;
  if (!m.hasVideo) return <div className="thumb"><Icon name="audio" /></div>;
  if (!hasStrip) return <div className="thumb"><Icon name="film" /></div>;
  // First tile of the filmstrip sprite.
  return <div className="thumb" style={{ backgroundImage: `url(/media/${m.id}/filmstrip.jpg)` }} />;
}
