// Studio sound presets as data, so the exporter (ffmpeg) and the preview (Web Audio)
// build their chains from the same numbers. Noise reduction only exists in the export.
import type { AudioEnhance } from "./types.js";

export interface AudioParams {
  highpass: number;
  /** afftdn noise reduction in dB (export only). */
  denoise: number;
  lowShelf: { f: number; g: number };
  presence: { f: number; g: number; q: number };
  highShelf: { f: number; g: number };
  deess: boolean;
  comp: { threshold: number; ratio: number; attack: number; release: number; makeup: number };
  limit: boolean;
}

export const AUDIO_PRESETS: { id: AudioEnhance["preset"]; name: string; description: string }[] = [
  { id: "off", name: "Off", description: "Original audio" },
  { id: "clean", name: "Clean", description: "Remove hum and hiss, even out levels" },
  { id: "podcast", name: "Podcast", description: "Warm, close, radio-style voice" },
  { id: "crisp", name: "Crisp", description: "Bright and clear for shorts on phones" },
  { id: "broadcast", name: "Broadcast", description: "Dense, loud, compressed" },
];

export function audioParams(a: AudioEnhance): AudioParams | null {
  if (a.preset === "off") return null;
  const k = Math.min(1, Math.max(0, a.strength));
  const base: AudioParams = {
    highpass: 80,
    denoise: 12 * k,
    lowShelf: { f: 150, g: 0 },
    presence: { f: 3200, g: 0, q: 0.9 },
    highShelf: { f: 9000, g: 0 },
    deess: false,
    comp: { threshold: -20, ratio: 1 + 2 * k, attack: 8, release: 120, makeup: 2 * k },
    limit: false,
  };
  switch (a.preset) {
    case "podcast":
      return { ...base, highpass: 70, lowShelf: { f: 140, g: 3 * k }, presence: { f: 3000, g: 2.5 * k, q: 0.9 }, deess: true, comp: { ...base.comp, ratio: 1 + 2.5 * k, makeup: 3 * k } };
    case "crisp":
      return { ...base, highpass: 110, denoise: 14 * k, lowShelf: { f: 180, g: -1.5 * k }, presence: { f: 4200, g: 4 * k, q: 1 }, highShelf: { f: 10000, g: 3 * k }, deess: true };
    case "broadcast":
      return { ...base, presence: { f: 3500, g: 2.5 * k, q: 0.9 }, lowShelf: { f: 120, g: 1.5 * k }, deess: true, comp: { threshold: -24, ratio: 1 + 4 * k, attack: 5, release: 80, makeup: 5 * k }, limit: true };
    default:
      return base;
  }
}

/** ffmpeg audio filter chain (comma-separated), or null when off. */
export function audioFilterChain(a: AudioEnhance): string | null {
  const p = audioParams(a);
  if (!p) return null;
  const f = [`highpass=f=${p.highpass}`];
  if (p.denoise > 0.5) f.push(`afftdn=nr=${p.denoise.toFixed(1)}:nf=-35:tn=1`);
  if (Math.abs(p.lowShelf.g) > 0.05) f.push(`lowshelf=f=${p.lowShelf.f}:g=${p.lowShelf.g.toFixed(2)}`);
  if (Math.abs(p.presence.g) > 0.05) f.push(`equalizer=f=${p.presence.f}:t=q:w=${p.presence.q}:g=${p.presence.g.toFixed(2)}`);
  if (Math.abs(p.highShelf.g) > 0.05) f.push(`highshelf=f=${p.highShelf.f}:g=${p.highShelf.g.toFixed(2)}`);
  if (p.deess) f.push("deesser=i=0.4");
  const c = p.comp;
  if (c.ratio > 1.05) f.push(`acompressor=threshold=${c.threshold}dB:ratio=${c.ratio.toFixed(2)}:attack=${c.attack}:release=${c.release}:makeup=${Math.max(1, Math.pow(10, c.makeup / 20)).toFixed(3)}`);
  if (p.limit) f.push("alimiter=limit=0.95:level=disabled");
  return f.join(",");
}
