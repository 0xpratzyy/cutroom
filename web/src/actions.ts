// User actions shared by keyboard shortcuts, menus and panels.
import type { Op } from "../../src/core/shared/ops";
import { mapWords, placeClips, timelineDuration } from "../../src/core/shared/timeline";
import type { Feedback } from "../../src/core/shared/types";
import { api } from "./api";
import { engine } from "./engine";
import { store, toast, type Composer } from "./store";
import { startVoice, stopVoice } from "./voice";

export function deleteSelection() {
  const s = store.get();
  if (!s.project) return;
  if (s.words) {
    const t = s.transcripts[s.words.mediaId];
    const allCut = t && mapWords(s.project, t).slice(s.words.from, s.words.to + 1).every((w) => !w.kept);
    void api.edit([{ op: allCut ? "restore_words" : "remove_words", ...s.words }], allCut ? "restore words" : "cut words");
    store.set({ words: null });
    window.getSelection()?.removeAllRanges();
    return;
  }
  if (s.items.length) {
    const ops: Op[] = s.items.map((it) =>
      it.type === "clip" ? { op: "remove_clip", id: it.id } : it.type === "overlay" ? { op: "remove_overlay", id: it.id } : { op: "remove_zoom", id: it.id },
    );
    void api.edit(ops);
    store.set({ items: [] });
    return;
  }
  if (s.range) {
    void api.edit([{ op: "cut", start: s.range.start, end: s.range.end }], "cut range");
    store.set({ range: null });
    void engine.seek(s.range.start);
  }
}

export function splitAtPlayhead() {
  void api.edit([{ op: "split", at: store.get().time }]);
}

export function addZoomHere(scale = 1.3) {
  const s = store.get();
  if (!s.project) return;
  const total = timelineDuration(s.project);
  let start = s.range?.start ?? s.time;
  let end = s.range?.end ?? Math.min(total, s.time + 1.5);
  if (s.words) {
    const t = s.transcripts[s.words.mediaId];
    const ws = t ? mapWords(s.project, t).slice(s.words.from, s.words.to + 1).filter((w) => w.kept) : [];
    if (ws.length) {
      start = ws[0].start;
      end = ws[ws.length - 1].end;
    }
  }
  if (end - start < 0.2) return toast("Select a longer range to zoom", "error");
  void api.edit([{ op: "add_zoom", start, end, scale }]);
}

export function addBrollAt(mediaId: string, start?: number) {
  const s = store.get();
  void api.edit([{ op: "add_broll", mediaId, start: start ?? s.time }]);
}

export function step(seconds: number) {
  engine.pause();
  void engine.seek(store.get().time + seconds);
}

/** Open the note composer for whatever the user is pointing at (or a spot on the frame). */
export function openComposer(at?: { region?: Feedback["region"]; x: number; y: number }) {
  const s = store.get();
  if (!s.project?.clips.length) return toast("Add a recording first", "error");
  engine.pause();
  let time: Composer["time"] = { start: s.time, end: null };
  let words: Composer["words"] = null;
  let target: Composer["target"] = null;
  if (s.words && s.transcripts[s.words.mediaId]) {
    const ws = mapWords(s.project, s.transcripts[s.words.mediaId]).slice(s.words.from, s.words.to + 1);
    const kept = ws.filter((w) => w.kept);
    words = { ...s.words, text: ws.map((w) => w.word.text).join(" ") };
    if (kept.length) time = { start: kept[0].start, end: kept[kept.length - 1].end };
  } else if (s.range) {
    time = { start: s.range.start, end: s.range.end };
  } else if (s.items[0]) {
    const it = s.items[0];
    target = it;
    if (it.type === "clip") {
      const pc = placeClips(s.project).find((p) => p.clip.id === it.id);
      if (pc) time = { start: pc.start, end: pc.end };
    } else if (it.type === "overlay") {
      const o = s.project.overlays.find((x) => x.id === it.id);
      if (o) time = { start: o.start, end: o.start + o.duration };
    } else {
      const z = s.project.zooms.find((x) => x.id === it.id);
      if (z) time = { start: z.start, end: z.end };
    }
  }
  const frame = document.querySelector(".frame")?.getBoundingClientRect();
  const x = at?.x ?? (frame ? frame.left + frame.width / 2 : window.innerWidth / 2);
  const y = at?.y ?? (frame ? frame.top + frame.height * 0.35 : window.innerHeight / 3);
  store.set({ composer: { time, words, target, region: at?.region ?? null, x, y }, rightTab: "feedback" });
}

export function toggleAnnotate(on?: boolean) {
  const next = on ?? !store.get().annotating;
  if (next) engine.pause();
  store.set({ annotating: next, composer: next ? store.get().composer : null });
}

/** Text-entry fields keep their keys; sliders, toggles and buttons don't swallow shortcuts. */
function isTyping(el: HTMLElement) {
  if (el.closest("textarea, select, [contenteditable=true]")) return true;
  return el instanceof HTMLInputElement && !["range", "checkbox", "color", "button", "submit", "radio"].includes(el.type);
}

export function installShortcuts() {
  // Hold V to record a voice note while the video keeps playing.
  window.addEventListener("keyup", (e) => {
    if (e.key === "v" || e.key === "V") void stopVoice();
  });
  window.addEventListener("blur", () => void stopVoice());
  window.addEventListener("keydown", (e) => {
    const el = e.target as HTMLElement;
    if (e.key === "Escape") {
      const s = store.get();
      if (s.composer) return store.set({ composer: null });
      if (s.annotating) return store.set({ annotating: false });
      store.set({ items: [], range: null, words: null, focusFeedback: null });
      window.getSelection()?.removeAllRanges();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      store.set((s) => ({ paletteOpen: !s.paletteOpen }));
      return;
    }
    if (isTyping(el)) return;
    const mod = e.metaKey || e.ctrlKey;
    const fps = store.get().project?.settings.fps ?? 30;
    const editKey = ["Backspace", "Delete", "s", "z", "c", "a", "v"].includes(e.key);
    if (editKey && e.repeat) return;
    if (mod && e.key.toLowerCase() === "z") {
      e.preventDefault();
      void (e.shiftKey ? api.redo() : api.undo());
    } else if (mod && e.key.toLowerCase() === "y") {
      e.preventDefault();
      void api.redo();
    } else if (mod) {
      return;
    } else if (e.key === " " || e.key === "k") {
      e.preventDefault();
      engine.toggle();
    } else if (e.key === "Backspace" || e.key === "Delete") {
      e.preventDefault();
      deleteSelection();
    } else if (e.key === "s") {
      splitAtPlayhead();
    } else if (e.key === "z") {
      addZoomHere();
    } else if (e.key === "c") {
      e.preventDefault();
      openComposer();
    } else if (e.key === "a") {
      e.preventDefault();
      toggleAnnotate();
    } else if (e.key === "v" || e.key === "V") {
      e.preventDefault();
      if (!e.repeat) void startVoice();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      step(e.shiftKey ? -1 : -1 / fps);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      step(e.shiftKey ? 1 : 1 / fps);
    } else if (e.key === "Home") {
      void engine.seek(0);
    } else if (e.key === "End") {
      void engine.seek(engine.duration);
    } else if (e.key === "=" || e.key === "+" || e.key === "-") {
      window.dispatchEvent(new CustomEvent("cutroom:user-zoom"));
      store.set((s) => ({ pps: e.key === "-" ? Math.max(2, s.pps / 1.25) : Math.min(400, s.pps * 1.25) }));
    }
  });
}

/** Mirror the selection to the server so agents can ask "what is the user pointing at?". */
export function syncSelection() {
  let timer: number | undefined;
  let last = "";
  store.subscribe(() => {
    const s = store.get();
    const payload = { playhead: s.playing ? null : Math.round(s.time * 100) / 100, range: s.range, items: s.items, words: s.words };
    const key = JSON.stringify(payload);
    if (key === last || s.playing) return;
    last = key;
    clearTimeout(timer);
    timer = window.setTimeout(() => api.selection({ ...payload, playhead: payload.playhead ?? 0 }), 200);
  });
}
