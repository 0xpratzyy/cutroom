// Review the agent's edits like a pull request: what changed, before/after, keep or revert.
import type { Change } from "../../../src/core/shared/diff";
import { formatTime } from "../../../src/core/shared/timeline";
import { api } from "../api";
import { engine } from "../engine";
import { store, useStore } from "../store";
import { Icon } from "./Icon";

const KIND_ICON: Record<Change["kind"], string> = { cut: "scissors", restore: "plus", zoom: "zoom", overlay: "film", style: "sparkle" };

export function seekToChange(c: Change) {
  engine.pause();
  store.set({ focusChange: c.id, reviewView: "after" });
  void engine.seek(Math.max(0, c.at - (c.kind === "cut" ? 1.5 : 0.3)));
}

function netDelta(changes: Change[]) {
  const d = changes.reduce((n, c) => n + c.delta, 0);
  return Math.abs(d) < 0.05 ? null : `${d > 0 ? "+" : "−"}${Math.abs(d).toFixed(1)}s`;
}

/** Compact bar over the video while there are changes to review. */
export function ReviewBar() {
  const review = useStore((s) => s.review);
  const view = useStore((s) => s.reviewView);
  if (!review) return null;
  const net = netDelta(review.changes);
  return (
    <div className={`review-bar ${view}`}>
      <Icon name="sparkle" size={12} />
      <span>
        Claude made <b>{review.changes.length}</b> change{review.changes.length === 1 ? "" : "s"}
        {net ? ` · ${net}` : ""}
      </span>
      <div className="seg small">
        <button className={view === "before" ? "on" : ""} onClick={() => store.set({ reviewView: "before" })} title="Preview the edit as it was before Claude's changes">
          Before
        </button>
        <button className={view === "after" ? "on" : ""} onClick={() => store.set({ reviewView: "after" })}>
          After
        </button>
      </div>
      <button className="ghost sm" onClick={() => store.set({ rightTab: "feedback", inspectorOpen: true })}>
        Review
      </button>
    </div>
  );
}

/** Change list (top of the Feedback tab). */
export function ReviewPanel() {
  const review = useStore((s) => s.review);
  const focus = useStore((s) => s.focusChange);
  if (!review) return null;
  const net = netDelta(review.changes);
  return (
    <div className="section review-panel">
      <div className="section-title">
        <span>
          Claude's changes <span className="tab-count agent">{review.changes.length}</span>
        </span>
        {net && <span className="mono muted" style={{ fontSize: 11 }}>{net}</span>}
      </div>
      <div className="change-list">
        {review.changes.map((c) => (
          <div key={c.id} className={`change ${c.kind} ${focus === c.id ? "focus" : ""}`} onClick={() => seekToChange(c)}>
            <span className="change-icon">
              <Icon name={KIND_ICON[c.kind]} size={11} />
            </span>
            <span className="change-label">{c.label}</span>
            <span className="change-time">{c.kind === "style" && !c.at ? "" : formatTime(c.at).replace(/^00:/, "")}</span>
            <button
              className="ghost sm icon"
              title="Revert this change"
              onClick={(e) => {
                e.stopPropagation();
                void api.reviewRevert(c.id);
              }}
            >
              <Icon name="undo" size={12} />
            </button>
          </div>
        ))}
      </div>
      <div className="row" style={{ marginTop: 10 }}>
        <button className="primary grow" onClick={() => void api.reviewAccept()}>
          <Icon name="check" size={13} /> Keep all
        </button>
        <button className="grow danger" onClick={() => void api.reviewReject()}>
          Reject all
        </button>
      </div>
      <p className="hint" style={{ margin: "8px 0 0" }}>Red is footage Claude cut, green is footage it brought back. Use Before/After over the video to compare.</p>
    </div>
  );
}
