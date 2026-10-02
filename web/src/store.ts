// Tiny external store + selector hook. Playback time updates ~30×/s, so components
// subscribe to exactly the slice they need.
import { useRef, useSyncExternalStore } from "react";
import type { Op } from "../../src/core/shared/ops";
import type { Change } from "../../src/core/shared/diff";
import type { AgentPresence, BrandKit, Feedback, HistoryEntry, Project, Silence, Transcript, Waveform } from "../../src/core/shared/types";

export interface Job {
  id: string;
  kind: "analyze" | "export" | "preview" | "voice";
  label: string;
  status: "running" | "done" | "error";
  progress: number;
  detail?: string;
  result?: { file?: string; path?: string } & Record<string, unknown>;
  error?: string;
}

export const STEP_LABELS: Record<string, string> = {
  voice: "Transcribing voice note",
  waveform: "Reading audio",
  silences: "Finding pauses",
  thumbs: "Making thumbnails",
  transcript: "Transcribing",
  proxy: "Optimizing for playback",
};

export interface Toast {
  id: number;
  text: string;
  kind: "agent" | "error" | "info";
}

export type Item = { type: "clip" | "overlay" | "zoom"; id: string };

export interface Filmstrip {
  count: number;
  step: number;
  height: number;
  width: number;
}

/** An unsaved note being written, anchored to what the user pointed at. */
export interface Composer {
  time: { start: number; end: number | null };
  region: Feedback["region"];
  words: Feedback["words"];
  target: Feedback["target"];
  /** Where to show the popover, in viewport pixels. */
  x: number;
  y: number;
}

export interface Review {
  since: string;
  baseline: Project;
  changes: Change[];
}

export interface Styles {
  fonts: { family: string; file: string }[];
  systemFonts: string[];
  looks: { id: string; name: string; description: string }[];
  luts: string[];
}

export interface State {
  connected: boolean;
  styles: Styles | null;
  brand: BrandKit | null;
  /** Hold-to-compare: hear the original audio while held. */
  soundBypass: boolean;
  voice: { recording: boolean; sending: boolean; level: number };
  /** Changes since the agent's first unreviewed edit. */
  review: Review | null;
  reviewView: "after" | "before";
  focusChange: string | null;
  feedback: Feedback[];
  agent: AgentPresence | null;
  annotating: boolean;
  composer: Composer | null;
  /** Note highlighted from a marker or the list. */
  focusFeedback: string | null;
  feedbackFilter: "open" | "resolved" | "all";
  dir: string;
  project: Project | null;
  transcripts: Record<string, Transcript>;
  silences: Record<string, Silence[]>;
  waveforms: Record<string, Waveform>;
  filmstrips: Record<string, Filmstrip>;
  history: { undo: HistoryEntry[]; redo: HistoryEntry[] };
  jobs: Record<string, Job>;
  toasts: Toast[];
  // Playback / selection
  time: number;
  playing: boolean;
  range: { start: number; end: number } | null;
  items: Item[];
  words: { mediaId: string; from: number; to: number } | null;
  // View
  pps: number;
  leftTab: "transcript" | "media" | "takes";
  rightTab: "feedback" | "edit" | "style" | "output";
  /** Narrow windows show the inspector as a slide-over. */
  inspectorOpen: boolean;
  leftOpen: boolean;
  rightOpen: boolean;
  /** Rule-of-thirds guides over the frame. */
  grid: boolean;
  paletteOpen: boolean;
  showCut: boolean;
  /** Timestamp of the last agent edit, for the live indicator. */
  agentActiveAt: number;
}

type Listener = () => void;

function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const next = typeof patch === "function" ? patch(state) : patch;
      state = { ...state, ...next };
      listeners.forEach((l) => l());
    },
    subscribe(l: Listener): () => void {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
  };
}

export const store = createStore<State>({
  connected: false,
  styles: null,
  brand: null,
  soundBypass: false,
  voice: { recording: false, sending: false, level: 0 },
  review: null,
  reviewView: "after",
  focusChange: null,
  feedback: [],
  agent: null,
  annotating: false,
  composer: null,
  focusFeedback: null,
  feedbackFilter: "open",
  dir: "",
  project: null,
  transcripts: {},
  silences: {},
  waveforms: {},
  filmstrips: {},
  history: { undo: [], redo: [] },
  jobs: {},
  toasts: [],
  time: 0,
  playing: false,
  range: null,
  items: [],
  words: null,
  pps: 40,
  leftTab: "transcript",
  rightTab: "feedback",
  inspectorOpen: false,
  leftOpen: true,
  rightOpen: true,
  grid: true,
  paletteOpen: false,
  showCut: true,
  agentActiveAt: 0,
});

/** Subscribe to a slice. Shallow-equal results keep their identity, so selectors may build arrays. */
export function useStore<T>(selector: (s: State) => T): T {
  const last = useRef<{ v: T } | null>(null);
  const get = () => {
    const v = selector(store.get());
    if (last.current && shallowEqual(last.current.v, v)) return last.current.v;
    last.current = { v };
    return v;
  };
  return useSyncExternalStore(store.subscribe, get);
}

function shallowEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== "object" || typeof b !== "object" || !a || !b) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.is((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

let toastId = 0;
export function toast(text: string, kind: Toast["kind"] = "info") {
  const t = { id: ++toastId, text, kind };
  store.set((s) => ({ toasts: [...s.toasts.slice(-3), t] }));
  setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((x) => x.id !== t.id) })), kind === "error" ? 6000 : 3500);
}

export type { Op };
