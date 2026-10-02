// Project schema. This file is shared by the engine (Node) and the web editor,
// so it must stay free of Node imports.
//
// Time units: seconds (float). "Source time" is a position inside a media file;
// "timeline time" is a position in the edited output.

export const PROJECT_VERSION = 1;
export const PROJECT_FILE = "cutroom.json";

export type MediaKind = "video" | "audio" | "image";

export interface MediaAnalysis {
  transcript?: boolean;
  silences?: boolean;
  waveform?: boolean;
  /** true = a proxy exists, false = the source plays fine in browsers, undefined = not checked yet. */
  proxy?: boolean;
  thumbs?: boolean;
}

export interface MediaAsset {
  id: string;
  name: string;
  /** Absolute path, or relative to the project directory. */
  path: string;
  kind: MediaKind;
  duration: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  hasVideo: boolean;
  analysis: MediaAnalysis;
}

/** Normalized focal point inside the source frame (0..1). Used when cropping to a different aspect. */
export interface Focus {
  x: number;
  y: number;
}

/** A segment of the main (A-roll) track. Main clips play back-to-back with no gaps. */
export interface Clip {
  id: string;
  mediaId: string;
  in: number;
  out: number;
  focus?: Focus;
}

export type OverlayMode = "full" | "pip";

/** B-roll placed on top of the main track at a timeline position. */
export interface Overlay {
  id: string;
  mediaId: string;
  start: number;
  duration: number;
  /** Source in-point. Ignored for images. */
  in: number;
  mode: OverlayMode;
  /** Picture-in-picture box, normalized to the output frame. */
  pip?: { x: number; y: number; w: number };
  /** 0 = muted (default), 1 = full volume. */
  volume: number;
  focus?: Focus;
}

/** Punch-in zoom on the main track over a timeline range. */
export interface Zoom {
  id: string;
  start: number;
  end: number;
  scale: number;
  focus: Focus;
  /** Seconds to ease in and out. 0 = instant punch-in. */
  ease?: number;
}

export interface CaptionStyle {
  enabled: boolean;
  maxWords: number;
  maxChars: number;
  /** Vertical center of the caption block, 0 = top, 1 = bottom. */
  position: number;
  /** Font size as a fraction of output height. */
  fontSize: number;
  fontFamily: string;
  fontWeight: number;
  color: string;
  highlightColor: string;
  strokeColor: string;
  /** Stroke width as a fraction of font size. */
  strokeWidth: number;
  uppercase: boolean;
  /** Highlight the word being spoken. */
  highlight: boolean;
  /** Optional box behind the text, e.g. "rgba(0,0,0,0.6)". */
  background: string | null;
  /** Template this style started from (see CAPTION_PRESETS). */
  preset: string | null;
  /** How words enter. "reveal" shows words only once spoken. */
  animation: CaptionAnimation;
  /** How the spoken word is highlighted when `highlight` is on. */
  highlightStyle: "color" | "box" | "scale" | "underline";
  /** Fill of the box behind the active word (highlightStyle "box"). */
  boxColor: string;
  /** Soft glow/shadow color behind text, or null. */
  glow: string | null;
  /** Words (case/punctuation-insensitive) drawn in emphasisColor. */
  emphasisWords: string[];
  emphasisColor: string;
}

export type CaptionAnimation = "none" | "pop" | "bounce" | "fade" | "rise" | "reveal";

/** Big title over the opening seconds: the hook every short starts with. */
export interface HookTitle {
  enabled: boolean;
  text: string;
  /** Timeline seconds. */
  start: number;
  duration: number;
  /** Vertical center, 0 top – 1 bottom. */
  position: number;
  preset: "headline" | "highlight" | "outline" | "minimal";
  fontFamily: string;
  fontWeight: number;
  /** Fraction of output height. */
  fontSize: number;
  color: string;
  /** Box / outline / accent color. */
  accent: string;
  uppercase: boolean;
}

/** Logo burned into a corner. `file` is relative to the project folder. */
export interface Watermark {
  enabled: boolean;
  file: string | null;
  corner: "tl" | "tr" | "bl" | "br";
  /** Width as a fraction of output width. */
  size: number;
  opacity: number;
  /** Inset from the edges, fraction of output width. */
  margin: number;
}

/** Voice cleanup applied to the main track's audio. */
export interface AudioEnhance {
  preset: "off" | "clean" | "podcast" | "crisp" | "broadcast";
  /** 0..1, scales noise reduction and EQ. */
  strength: number;
}

/** Saved once per machine (~/.cutroom/brand) and applied to any project. */
export interface BrandKit {
  name: string;
  primary: string;
  secondary: string;
  text: string;
  fontFamily: string | null;
  /** Font file inside the brand folder. */
  fontFile: string | null;
  /** Logo file inside the brand folder. */
  logo: string | null;
  watermark: Pick<Watermark, "corner" | "size" | "opacity" | "margin">;
  captionPreset: string | null;
  look: string | null;
}

/** Color grade. Everything is baked into one 3D LUT so preview and export match exactly. */
export interface Look {
  /** Built-in look id, or "custom:<file>" for a .cube in the project's luts/ folder. */
  lut: string | null;
  /** How much of the LUT to apply, 0..1. */
  intensity: number;
  /** -1..1 */
  exposure: number;
  contrast: number;
  saturation: number;
  /** -1 (cool) .. 1 (warm) */
  temperature: number;
}

export interface Settings {
  width: number;
  height: number;
  fps: number;
  background: string;
  normalizeAudio: boolean;
  /** Tiny audio fade at every cut to avoid clicks. */
  cutFadeMs: number;
}

export interface Project {
  version: number;
  name: string;
  createdAt: string;
  updatedAt: string;
  settings: Settings;
  media: MediaAsset[];
  clips: Clip[];
  overlays: Overlay[];
  zooms: Zoom[];
  captions: CaptionStyle;
  look: Look;
  hook: HookTitle;
  watermark: Watermark;
  audio: AudioEnhance;
}

export interface Word {
  /** Index within the media's transcript. Stable for the life of the transcript. */
  i: number;
  text: string;
  start: number;
  end: number;
  conf?: number;
  filler?: boolean;
}

export interface Transcript {
  mediaId: string;
  backend: string;
  model: string;
  language: string;
  words: Word[];
}

export interface Silence {
  start: number;
  end: number;
}

export interface Waveform {
  /** Peaks per second of source audio. */
  rate: number;
  peaks: number[];
}

/** What the user is pointing at in the editor; agents read this via get_selection. */
export interface Selection {
  playhead: number;
  range: { start: number; end: number } | null;
  items: { type: "clip" | "overlay" | "zoom"; id: string }[];
  words: { mediaId: string; from: number; to: number } | null;
  updatedAt: string;
}

export interface HistoryEntry {
  id: number;
  label: string;
  origin: "agent" | "editor" | "cli";
  at: string;
}

export const ASPECTS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
  "1:1": { width: 1080, height: 1080 },
  "4:5": { width: 1080, height: 1350 },
};

export const DEFAULT_CAPTIONS: CaptionStyle = {
  enabled: false,
  maxWords: 4,
  maxChars: 24,
  position: 0.78,
  fontSize: 0.055,
  fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
  fontWeight: 800,
  color: "#ffffff",
  highlightColor: "#ffd60a",
  strokeColor: "#000000",
  strokeWidth: 0.16,
  uppercase: false,
  highlight: true,
  background: null,
  preset: null,
  animation: "pop",
  highlightStyle: "color",
  boxColor: "#7c3aed",
  glow: null,
  emphasisWords: [],
  emphasisColor: "#4ade80",
};

export const DEFAULT_LOOK: Look = { lut: null, intensity: 1, exposure: 0, contrast: 0, saturation: 0, temperature: 0 };

export const DEFAULT_HOOK: HookTitle = {
  enabled: false,
  text: "",
  start: 0,
  duration: 3,
  position: 0.22,
  preset: "highlight",
  fontFamily: "Helvetica Neue, Arial, sans-serif",
  fontWeight: 900,
  fontSize: 0.06,
  color: "#ffffff",
  accent: "#ff3b30",
  uppercase: true,
};

export const DEFAULT_WATERMARK: Watermark = { enabled: false, file: null, corner: "tr", size: 0.14, opacity: 0.85, margin: 0.04 };

export const DEFAULT_AUDIO: AudioEnhance = { preset: "off", strength: 0.6 };

export const DEFAULT_BRAND: BrandKit = {
  name: "My brand",
  primary: "#ff3b30",
  secondary: "#ffd60a",
  text: "#ffffff",
  fontFamily: null,
  fontFile: null,
  logo: null,
  watermark: { corner: "tr", size: 0.14, opacity: 0.85, margin: 0.04 },
  captionPreset: null,
  look: null,
};

export const DEFAULT_SETTINGS: Settings = {
  width: 1920,
  height: 1080,
  fps: 30,
  background: "#000000",
  normalizeAudio: true,
  cutFadeMs: 12,
};

export const FILLER_WORDS = ["um", "uh", "erm", "er", "ah", "hmm", "mhm"];
/** Catches stretched spellings Whisper produces: "ummm", "uhhh", "ahh", "hmmm". */
export const FILLER_PATTERN = /^(u+m+|u+h+m*|e+r+m*|a+h+|h+m+|m+h*m+)$/;

// ---------------------------------------------------------------------------
// Feedback: notes the user pins to the video for an agent to act on.

export type FeedbackStatus = "open" | "working" | "resolved";

export interface FeedbackReply {
  author: "user" | "agent";
  text: string;
  at: string;
}

export interface Feedback {
  id: string;
  /** Display number, stable for the life of the note. */
  n: number;
  createdAt: string;
  updatedAt: string;
  note: string;
  status: FeedbackStatus;
  /** Timeline time when the note was made (fallback if the anchored footage is cut). */
  time: { start: number; end: number | null };
  /** Source anchor, so the note follows the footage through edits. */
  anchor: { mediaId: string; start: number; end: number } | null;
  /** Spot on the frame, normalized to the output frame. w = h = 0 for a pin. */
  region: { x: number; y: number; w: number; h: number } | null;
  /** Transcript words the note is about. */
  words: { mediaId: string; from: number; to: number; text: string } | null;
  /** Timeline item the note is about. */
  target: { type: "clip" | "overlay" | "zoom"; id: string } | null;
  replies: FeedbackReply[];
  /** Voice note recording, relative to .cutroom/voice/. */
  voice?: string;
}

export interface FeedbackDraft {
  note: string;
  time: { start: number; end: number | null };
  region?: Feedback["region"];
  words?: Feedback["words"];
  target?: Feedback["target"];
  voice?: string;
}

/** Written by the MCP server so the editor can show whether an agent is connected. */
export interface AgentPresence {
  pid: number;
  lastSeen: string;
  /** True while the agent is blocked in wait_for_feedback. */
  watching: boolean;
}
