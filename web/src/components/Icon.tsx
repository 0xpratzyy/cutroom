const PATHS: Record<string, string> = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M6 4h4v16H6zM14 4h4v16h-4z",
  back: "M11 6v12l-8.5-6zM21 6v12l-8.5-6z",
  fwd: "M13 6v12l8.5-6zM3 6v12l8.5-6z",
  frameBack: "M6 6h2v12H6zM9.5 12l8.5 6V6z",
  frameFwd: "M16 6h2v12h-2zM6 6v12l8.5-6z",
  undo: "M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 010 11H11",
  redo: "M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 000 11H13",
  scissors: "M6 9a3 3 0 100-6 3 3 0 000 6zM6 21a3 3 0 100-6 3 3 0 000 6zM20 4L8.12 15.88M14.47 14.48L20 20M8.12 8.12L12 12",
  split: "M12 3v18M8 7l-4 5 4 5M16 7l4 5-4 5",
  zoom: "M11 19a8 8 0 100-16 8 8 0 000 16zM21 21l-4.35-4.35M11 8v6M8 11h6",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6",
  upload: "M12 16V4M7 9l5-5 5 5M4 20h16",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 9h4M4 15h4M16 9h4M16 15h4",
  image: "M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15.5 9.5a1 1 0 100-.01",
  audio: "M9 18V6l10-2v12M9 18a3 3 0 11-3-3 3 3 0 013 3zM19 16a3 3 0 11-3-3 3 3 0 013 3z",
  download: "M12 4v12M7 11l5 5 5-5M4 20h16",
  sparkle: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z",
  captions: "M3 5h18v14H3zM7 10h4M7 14h10M13 10h4",
  plus: "M12 5v14M5 12h14",
  refresh: "M20 11a8 8 0 10-2.3 5.7M20 4v7h-7",
  rewind: "M11 6v12L3 12zM21 6v12l-8-6z",
  ffwd: "M13 6v12l8-6zM3 6v12l8-6z",
  prevTri: "M16 5v14L6 12z",
  nextTri: "M8 5v14l10-7z",
  history: "M3 12a9 9 0 109-9 9 9 0 00-6.4 2.6L3 8M3 3v5h5M12 7v5l3 2",
  share: "M12 15V3M7 8l5-5 5 5M5 13v6a2 2 0 002 2h10a2 2 0 002-2v-6",
  layers: "M12 3l9 5-9 5-9-5zM3 13l9 5 9-5M3 17l9 5 9-5",
  cursor: "M5 3l14 7-6 2-2 6z",
  type: "M5 5h14M12 5v14M9 19h6",
  cube: "M12 2l9 5v10l-9 5-9-5V7zM3 7l9 5 9-5M12 12v10",
  panel: "M3 4h18v16H3zM15 4v16",
  panelHide: "M3 4h18v16H3zM15 4v16M18 10l-2 2 2 2",
  grid: "M3 3h18v18H3zM9 3v18M15 3v18M3 9h18M3 15h18",
  fullscreen: "M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5",
  info: "M12 22a10 10 0 100-20 10 10 0 000 20zM12 16v-5M12 8h.01",
  bars: "M6 20V14M12 20V8M18 20V4",
  check: "M5 12.5l4.5 4.5L19 7.5",
  copy: "M9 9h11v11H9zM5 15V4h11",
  pin: "M12 21s-6-5.6-6-11a6 6 0 1112 0c0 5.4-6 11-6 11zM12 12.5a2.5 2.5 0 100-5 2.5 2.5 0 000 5z",
  message: "M4 5h16v11H8l-4 4z",
  sliders: "M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M16 4v4M10 10v4M18 16v4",
  close: "M6 6l12 12M18 6L6 18",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 100-6 3 3 0 000 6z",
  eyeOff: "M3 3l18 18M10.6 5.1A10 10 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.2M6.6 6.6A17 17 0 002 12s3.5 7 10 7a10 10 0 005.4-1.6M9.9 9.9a3 3 0 004.2 4.2",
  wand: "M15 4V2M15 10V8M11 6h2M17 6h2M4 20L14 10M16.5 3.5l1 1",
  compress: "M4 12h6M14 12h6M7 9l3 3-3 3M17 9l-3 3 3 3",
  skipBack: "M19 20L9 12l10-8zM5 19V5",
  skipFwd: "M5 4l10 8-10 8zM19 5v14",
  mic: "M12 15a3 3 0 003-3V6a3 3 0 00-6 0v6a3 3 0 003 3zM19 11a7 7 0 01-14 0M12 18v3",
};

const FILLED = new Set(["play", "pause", "back", "fwd", "frameBack", "frameFwd", "sparkle", "skipBack", "skipFwd"]);
const OUTLINE_TRI = new Set(["rewind", "ffwd", "prevTri", "nextTri"]);

export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  const filled = FILLED.has(name);
  if (OUTLINE_TRI.has(name)) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" aria-hidden>
        <path d={PATHS[name] ?? ""} />
      </svg>
    );
  }
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke={filled ? "none" : "currentColor"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={PATHS[name] ?? ""} />
    </svg>
  );
}
