import { useEffect, useState } from "react";
import { api } from "./api";
import { Inspector } from "./components/Inspector";
import { MediaBin } from "./components/MediaBin";
import { Player } from "./components/Player";
import { Timeline } from "./components/Timeline";
import { TitleBar, ToolBar } from "./components/TopBar";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Feedback";
import { Takes } from "./components/Takes";
import { Palette } from "./components/Palette";
import { store, toast, useStore } from "./store";

export function App() {
  const ready = useStore((s) => !!s.project);
  const leftTab = useStore((s) => s.leftTab);
  const leftOpen = useStore((s) => s.leftOpen);
  const rightOpen = useStore((s) => s.rightOpen);
  const toasts = useStore((s) => s.toasts);
  const dropping = useFileDrop();

  const toastList = (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>
          {t.text}
        </div>
      ))}
    </div>
  );
  if (!ready)
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-3)" }}>
        Connecting to cutroom…
        {toastList}
      </div>
    );

  return (
    <div className="app">
      <TitleBar />
      <ToolBar />
      <div className={`main ${leftOpen ? "" : "no-left"} ${rightOpen ? "" : "no-right"}`}>
        {leftOpen && (
          <div className="panel left card">
            <div className="panel-head">
              <div className="seg">
                <button className={leftTab === "transcript" ? "on" : ""} onClick={() => store.set({ leftTab: "transcript" })}>
                  Transcript
                </button>
                <button className={leftTab === "takes" ? "on" : ""} onClick={() => store.set({ leftTab: "takes" })}>
                  Takes
                </button>
                <button className={leftTab === "media" ? "on" : ""} onClick={() => store.set({ leftTab: "media" })}>
                  Media
                </button>
              </div>
            </div>
            {leftTab === "transcript" ? <Transcript /> : leftTab === "takes" ? <Takes /> : <MediaBin />}
          </div>
        )}
        <Player />
        {rightOpen && <Inspector />}
      </div>
      <Timeline />
      {toastList}
      <Composer />
      <Palette />
      {dropping && <div className="drop-overlay">Drop to import</div>}
    </div>
  );
}

/** Drag files from the OS anywhere onto the window to upload + import them. */
function useFileDrop() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    let depth = 0;
    const isFiles = (e: DragEvent) => e.dataTransfer?.types.includes("Files");
    const enter = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth++;
      setOver(true);
    };
    const leave = (e: DragEvent) => {
      if (!isFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const overFn = (e: DragEvent) => isFiles(e) && e.preventDefault();
    const drop = async (e: DragEvent) => {
      if (!isFiles(e)) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const files = [...(e.dataTransfer?.files ?? [])];
      for (const f of files) {
        const empty = !store.get().project?.clips.length;
        toast(`Uploading ${f.name}…`);
        try {
          await api.upload(f, empty ? "main" : "library");
          toast(`Imported ${f.name}; analyzing in the background`);
          if (!empty) store.set({ leftTab: "media" });
        } catch (err) {
          toast(`${f.name}: ${(err as Error).message}`, "error");
        }
      }
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("dragover", overFn);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("dragover", overFn);
      window.removeEventListener("drop", drop);
    };
  }, []);
  return over;
}
