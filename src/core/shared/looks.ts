// Color looks. Every grade (built-in or .cube, plus intensity and adjustments) is baked
// into a single 3D LUT. The browser preview samples it in a shader; the exporter hands
// the same table to ffmpeg's lut3d, so what you see is what you export.
import type { Look } from "./types.js";

type RGB = [number, number, number];
type ColorFn = (r: number, g: number, b: number) => RGB;

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (x: number) => x * x * (3 - 2 * x);
/** Gentle S-curve; amount 0..1. */
const scurve = (x: number, amount: number) => mix(x, smooth(clamp01(x)), amount);
const saturate = (c: RGB, s: number): RGB => {
  const l = luma(...c);
  return [l + (c[0] - l) * s, l + (c[1] - l) * s, l + (c[2] - l) * s];
};

export interface BuiltinLook {
  id: string;
  name: string;
  description: string;
  fn: ColorFn;
}

/** Tuned for talking heads: skin tones stay natural, shadows and highlights carry the mood. */
export const BUILTIN_LOOKS: BuiltinLook[] = [
  {
    id: "clean",
    name: "Clean",
    description: "Bright, crisp, true-to-life",
    fn: (r, g, b) => {
      const c = saturate([r, g, b], 1.08);
      return c.map((x) => scurve(x * 1.03 + 0.01, 0.25)) as RGB;
    },
  },
  {
    id: "warm",
    name: "Warm",
    description: "Golden, friendly skin tones",
    fn: (r, g, b) => {
      const c: RGB = [r * 1.05 + 0.02, g * 1.01 + 0.005, b * 0.9];
      return saturate(c, 1.06).map((x) => scurve(x, 0.15)) as RGB;
    },
  },
  {
    id: "teal-orange",
    name: "Teal & Orange",
    description: "Cinematic, warm skin against cool shadows",
    fn: (r, g, b) => {
      const l = luma(r, g, b);
      const sh = (1 - l) * (1 - l);
      const hi = l * l;
      const c: RGB = [r - 0.05 * sh + 0.06 * hi, g + 0.01 * sh + 0.015 * hi, b + 0.06 * sh - 0.07 * hi];
      return saturate(c, 1.1).map((x) => scurve(x, 0.35)) as RGB;
    },
  },
  {
    id: "moody",
    name: "Moody",
    description: "Muted, deep shadows, cool cast",
    fn: (r, g, b) => {
      let c = saturate([r, g, b], 0.72);
      c = c.map((x) => scurve(x * 0.95, 0.45)) as RGB;
      const sh = 1 - luma(...c);
      return [c[0] - 0.02 * sh, c[1] + 0.005 * sh, c[2] + 0.035 * sh];
    },
  },
  {
    id: "film",
    name: "Film",
    description: "Lifted blacks, soft highlights, warm mids",
    fn: (r, g, b) => {
      const c = saturate([r, g, b], 0.88).map((x) => 0.06 + x * 0.88) as RGB;
      const l = luma(...c);
      const mid = 1 - Math.abs(l - 0.5) * 2;
      return [c[0] + 0.03 * mid, c[1] + 0.012 * mid + 0.01 * (1 - l), c[2] - 0.02 * mid];
    },
  },
  {
    id: "vivid",
    name: "Vivid",
    description: "Punchy color for shorts",
    fn: (r, g, b) => saturate([r, g, b], 1.28).map((x) => scurve(x, 0.3)) as RGB,
  },
  {
    id: "bleach",
    name: "Bleach",
    description: "Desaturated, high-contrast editorial",
    fn: (r, g, b) => saturate([r, g, b], 0.55).map((x) => scurve(x, 0.6)) as RGB,
  },
  {
    id: "bw",
    name: "Black & White",
    description: "Contrasty monochrome",
    fn: (r, g, b) => {
      const l = scurve(luma(r, g, b) * 1.04, 0.45);
      return [l, l, l];
    },
  },
];

export const LOOK_IDS = BUILTIN_LOOKS.map((l) => l.id);

// ---------------------------------------------------------------- .cube files

export interface Cube {
  size: number;
  /** RGB triples, red fastest (standard .cube order), values 0..1. */
  data: Float32Array;
  domainMin: RGB;
  domainMax: RGB;
}

export function parseCube(text: string): Cube {
  let size = 0;
  let domainMin: RGB = [0, 0, 0];
  let domainMax: RGB = [1, 1, 1];
  const values: number[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === "LUT_3D_SIZE") size = Number(parts[1]);
    else if (key === "DOMAIN_MIN") domainMin = parts.slice(1, 4).map(Number) as RGB;
    else if (key === "DOMAIN_MAX") domainMax = parts.slice(1, 4).map(Number) as RGB;
    else if (key === "TITLE" || key === "LUT_1D_SIZE" || /^[A-Z_]+$/.test(key)) {
      if (key === "LUT_1D_SIZE") throw new Error("1D LUTs aren't supported; use a 3D .cube");
    } else if (parts.length >= 3) values.push(Number(parts[0]), Number(parts[1]), Number(parts[2]));
  }
  if (!size || values.length !== size * size * size * 3) throw new Error(`Invalid .cube file (size ${size}, ${values.length / 3} entries)`);
  return { size, data: Float32Array.from(values), domainMin, domainMax };
}

/** Trilinear sample of a cube at rgb (0..1). */
export function sampleCube(cube: Cube, r: number, g: number, b: number): RGB {
  const n = cube.size - 1;
  const norm = (x: number, i: number) => clamp01((x - cube.domainMin[i]) / (cube.domainMax[i] - cube.domainMin[i] || 1)) * n;
  const fr = norm(r, 0);
  const fg = norm(g, 1);
  const fb = norm(b, 2);
  const r0 = Math.floor(fr);
  const g0 = Math.floor(fg);
  const b0 = Math.floor(fb);
  const r1 = Math.min(r0 + 1, n);
  const g1 = Math.min(g0 + 1, n);
  const b1 = Math.min(b0 + 1, n);
  const tr = fr - r0;
  const tg = fg - g0;
  const tb = fb - b0;
  const s = cube.size;
  const at = (ri: number, gi: number, bi: number, c: number) => cube.data[(ri + gi * s + bi * s * s) * 3 + c];
  const out: RGB = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const c00 = mix(at(r0, g0, b0, c), at(r1, g0, b0, c), tr);
    const c10 = mix(at(r0, g1, b0, c), at(r1, g1, b0, c), tr);
    const c01 = mix(at(r0, g0, b1, c), at(r1, g0, b1, c), tr);
    const c11 = mix(at(r0, g1, b1, c), at(r1, g1, b1, c), tr);
    out[c] = mix(mix(c00, c10, tg), mix(c01, c11, tg), tb);
  }
  return out;
}

// ---------------------------------------------------------------- baking

export function isNeutral(look: Look): boolean {
  return (!look.lut || look.intensity <= 0) && !look.exposure && !look.contrast && !look.saturation && !look.temperature;
}

/**
 * Bake a look into a size³ LUT (red fastest). `custom` supplies the parsed .cube when
 * look.lut is "custom:…".
 */
export function bakeLook(look: Look, custom?: Cube | null, size = 33): Float32Array {
  const builtin = look.lut && !look.lut.startsWith("custom:") ? BUILTIN_LOOKS.find((l) => l.id === look.lut) : undefined;
  const base: ColorFn | null = builtin ? builtin.fn : custom ? (r, g, b) => sampleCube(custom, r, g, b) : null;
  const k = clamp01(look.intensity);
  const exposure = Math.pow(2, look.exposure * 0.8);
  const out = new Float32Array(size * size * size * 3);
  let o = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const r = ri / (size - 1);
        const g = gi / (size - 1);
        const b = bi / (size - 1);
        let c: RGB = [r, g, b];
        if (base && k > 0) {
          const t = base(r, g, b);
          c = [mix(r, t[0], k), mix(g, t[1], k), mix(b, t[2], k)];
        }
        if (look.exposure) c = c.map((x) => x * exposure) as RGB;
        if (look.temperature) c = [c[0] + look.temperature * 0.07, c[1] + look.temperature * 0.01, c[2] - look.temperature * 0.08];
        if (look.contrast) c = c.map((x) => (look.contrast > 0 ? scurve(x, look.contrast) : mix(x, 0.5, -look.contrast * 0.5))) as RGB;
        if (look.saturation) c = saturate(c, 1 + look.saturation);
        out[o++] = clamp01(c[0]);
        out[o++] = clamp01(c[1]);
        out[o++] = clamp01(c[2]);
      }
    }
  }
  return out;
}

export function cubeText(data: Float32Array, size = 33, title = "cutroom look"): string {
  const lines = [`TITLE "${title}"`, `LUT_3D_SIZE ${size}`];
  for (let i = 0; i < data.length; i += 3) lines.push(`${data[i].toFixed(6)} ${data[i + 1].toFixed(6)} ${data[i + 2].toFixed(6)}`);
  return lines.join("\n") + "\n";
}
