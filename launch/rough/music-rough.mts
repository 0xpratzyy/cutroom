// Synthesizes the score for "Rough Cut" (E major, 100 BPM). The score is held back until the edit
// lets it in: a phone-sketch piano (L0), a left hand and a room (L1), a pad (L2), half a second of
// digital silence, then the first full chord (the first time the mix is stereo) and the full theme
// resolving on the tonic. Driven by the compositor's cues (launch/out/rough/cues.json); without them,
// or with --defaults, it uses the beat sheet's own timings so it can be tested standalone. No voice.
// Usage: npx tsx launch/rough/music-rough.mts [--defaults | --cues <file>]  ->  launch/out/rough/soundtrack.wav
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "launch/out/rough";
const SR = 48000;
const BEAT = 0.6; // 100 BPM
const BAR = BEAT * 4;
const FRAME = 1 / 60; // the film's frame
mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- cues (contract 5)
type Layer = { at: number; name: string }; // 'L0' | 'L1' | 'L2' | 'full' | 'demo' | 'restore'
type Sfx = { name: string; at: number; gain?: number; dur?: number };
type Cues = {
  duration: number;
  sections: Record<string, number>;
  layers: Layer[];
  working: [number, number][];
  chimes: { at: number; midi: number }[];
  silence?: [number, number];
  arrival?: number;
  tonicAt?: number;
  endPulses: number[];
  rewind?: { from: number; to: number };
  sfx: Sfx[];
};
const keys = (from: number, to: number, n: number): Sfx[] =>
  Array.from({ length: n }, (_, k) => ({ name: "key", at: from + ((to - from) * k) / (n - 1) + [0, 0.014, -0.01][k % 3] }));
/** The beat sheet's own timings (spec scenes s01–s13), used until the compositor writes cues.json. */
const DEFAULT_CUES: Cues = {
  duration: 46.5,
  sections: { poster: 0, claude1: 1.4, rewind: 4.2, pass2: 4.9, note2: 8.4, claude2: 11, fold: 13.3, pass3: 16.4, claude3: 19.6, final: 24.6, reveal: 31, review: 36, end: 40 },
  layers: [
    { at: 0, name: "L0" },
    { at: 4.9, name: "L1" },
    { at: 11.1, name: "L2" },
    { at: 24.95, name: "full" },
    { at: 36.6, name: "demo" },
    { at: 37.8, name: "restore" },
  ],
  working: [[1.95, 3.8], [11.7, 13.3], [20.3, 22.0]],
  chimes: [
    { at: 3.8, midi: 76 },
    { at: 15.3, midi: 80 },
    { at: 24.0, midi: 83 },
    { at: 32.1, midi: 88 }, // pin dockings: E6 / G#6 / B6 ticks
    { at: 32.21, midi: 92 },
    { at: 32.32, midi: 95 },
  ],
  silence: [22.0, 22.5],
  arrival: 22.5,
  tonicAt: 29.9, // 'FIXES' in the v4 export's captions: an estimate until the export exists
  endPulses: [42.6, 43.8, 45.0],
  rewind: { from: 4.2, to: 4.9 },
  sfx: [
    { name: "click", at: 0 }, { name: "release", at: 0.5 }, ...keys(0.7, 1.2, 6), { name: "tock", at: 1.35 },
    { name: "fold", at: 3.35 },
    { name: "click", at: 9.05 }, { name: "release", at: 9.8 }, ...keys(10.0, 10.8, 10), { name: "tock", at: 11.0 },
    { name: "breath", at: 13.95, dur: 1.3 },
    { name: "key", at: 17.55, gain: 1.4 }, ...keys(17.8, 19.2, 14), { name: "tock", at: 19.4 },
    { name: "click", at: 36.6 }, { name: "release", at: 36.68 }, { name: "click", at: 37.8 }, { name: "release", at: 37.88 },
  ],
};
const arg = process.argv.indexOf("--cues");
const FILE = arg > 0 ? process.argv[arg + 1] : join(OUT, "cues.json");
if (arg > 0 && !(FILE && existsSync(FILE))) throw new Error(`--cues: no such file '${FILE ?? ""}'`);
const fromFile = existsSync(FILE) && !process.argv.includes("--defaults");
if (!fromFile && !process.argv.includes("--defaults")) console.warn(`cues: no ${FILE}, using the beat sheet's timings (run rough.mts --cues first, or they won't match the picture)`);
const C: Cues = fromFile ? JSON.parse(readFileSync(FILE, "utf8")) : DEFAULT_CUES;
for (const k of ["layers", "working", "chimes", "endPulses", "sfx"] as const) if (!Array.isArray(C[k])) (C as Record<string, unknown>)[k] = [];
C.sections ??= {};
if (fromFile) for (const k of ["duration", "silence", "arrival", "tonicAt", "rewind"] as const) if (C[k] == null) console.warn(`cues: no '${k}', deriving it`);

const DUR = C.duration ?? 46.5;
const N = Math.round(DUR * SR);
const S = (t: number) => Math.round(t * SR);
const layers = [...C.layers].sort((a, b) => a.at - b.at);
const cueAt = (name: string) => layers.find((l) => l.name === name)?.at;
/** A section's start by name: 'reveal' matches reveal or s11_reveal, 'end' matches end, endcard or s13_endcard.
 *  The value is a time, or a scene object with start/from/at. */
const section = (name: string) => {
  const v = Object.entries(C.sections as Record<string, unknown>).find(([k]) => new RegExp(`(^|_)${name}`).test(k))?.[1] as number | { start?: number; from?: number; at?: number } | undefined;
  const t = typeof v === "number" ? v : (v?.start ?? v?.from ?? v?.at);
  return typeof t === "number" && Number.isFinite(t) ? t : undefined;
};

const silenceCue = cueAt("silence");
const SIL: [number, number] | undefined = C.silence ?? (silenceCue !== undefined ? [silenceCue, C.arrival ?? silenceCue + 0.5] : undefined);
const ARRIVAL = C.arrival ?? SIL?.[1];
const L1 = cueAt("L1"), L2 = cueAt("L2");
const FULL = cueAt("full") ?? (ARRIVAL !== undefined ? ARRIVAL + 2.45 : undefined);
const TONIC = C.tonicAt ?? (FULL !== undefined ? FULL + 2 * BAR : undefined);
const STEREO = ARRIVAL ?? FULL ?? 0; // everything before this is mono
const RW = C.rewind ?? undefined;
const PULSES = [...C.endPulses].sort((a, b) => a - b);
const END_GATE = Math.min(DUR, PULSES.length ? PULSES[PULSES.length - 1] + 0.5 : DUR); // hard end: nothing after the last pulse
const resolves = C.chimes.filter((c) => c.midi < 88).sort((a, b) => a.at - b.at);
const docks = C.chimes.filter((c) => c.midi >= 88).map((c) => c.at).sort((a, b) => a - b);
const REVEAL = section("reveal") ?? (docks.length ? docks[0] - 1.1 : (TONIC ?? DUR) + 1.1);
const ENDCARD = section("end") ?? (PULSES.length ? PULSES[0] - 2.6 : DUR - 6.5);
const BED_END = SIL?.[0] ?? ARRIVAL ?? FULL ?? END_GATE;

// Before/After toggles: the score collapses to the demo piano between each 'demo' and the next 'restore'.
const DEMO: [number, number][] = [];
let open: number | undefined;
for (const l of layers) {
  if (l.name === "demo" && open === undefined) open = l.at;
  else if (l.name === "restore" && open !== undefined) DEMO.push([open, l.at]), (open = undefined);
}
if (open !== undefined) DEMO.push([open, END_GATE]);

// Hard stops: voices are cut at the next one (and reverbs emptied) so nothing rings across them.
const KILLS = [RW?.from, SIL?.[0], END_GATE].filter((k): k is number => k !== undefined && k < DUR).sort((a, b) => a - b);
const nextKill = (t: number) => KILLS.find((k) => k > t + 1e-6) ?? DUR;
// Digital zero in the final file: the silence, two frames on the rewind's cut, everything after the end.
const GATES = [SIL, RW && ([RW.to - 2 * FRAME, RW.to] as [number, number]), [END_GATE, DUR] as [number, number]].filter(
  (g): g is [number, number] => !!g && g[1] > g[0],
);
const gated = (t: number) => GATES.some(([a, b]) => t >= a - 1e-6 && t < b);
const muted = (t: number) => gated(t) || (!!RW && t >= RW.from - 1e-6 && t < RW.to);

// After note k's agent finishes, a transformation that takes a while (the fold) holds the score back
// until its resolve chime: near-silence, a low octave and a sub swell.
const DROPS: [number, number][] = [];
for (const [, b] of C.working) {
  const c = resolves.find((r) => r.at >= b - 0.05);
  if (c && c.at - b > 0.6 && !KILLS.some((k) => Math.abs(k - b) < 0.3)) DROPS.push([b, c.at]);
}
const inDrop = (t: number) => DROPS.some(([a, b]) => t >= a - 1e-6 && t < b + 0.1);
const dropEnv = (t: number) => {
  for (const [a, b] of DROPS) {
    if (t >= a && t < b + 0.1) return Math.max(0, 1 - (t - a) / 0.25);
    if (t >= b + 0.1 && t < b + 0.9) return (t - b - 0.1) / 0.8;
  }
  return 1;
};

// ---------------------------------------------------------------- buses
type Bus = { L: Float32Array; R: Float32Array; send: Float32Array };
const bus = (): Bus => ({ L: new Float32Array(N), R: new Float32Array(N), send: new Float32Array(N) });
const F = bus(); // the score: rewinds, collapses on Before, scaled to the loudness target
const A = bus(); // score elements specified in dBFS (heartbeat, pulse, rim, ticks, shimmer): collapse, never rescaled
const X = bus(); // sound effects, in dBFS: never collapse
const demoF = new Float32Array(N); // the phone-sketch piano where it is the score (the opening)
const demoC = new Float32Array(N); // the same voice shadowing the coda: heard only on Before
const room = new Float32Array(N);

let seed = 7350211;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const db = (d: number) => Math.pow(10, d / 20);
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const saw = (ph: number) => 2 * (ph - Math.floor(ph + 0.5));
const expoIn = (u: number) => (u <= 0 ? 0 : (Math.pow(2, 10 * u - 10) - 1 / 1024) / (1 - 1 / 1024));
const panOf = (midi: number) => clamp((midi - 62) / 50, -0.35, 0.35); // low notes left, high right (after the arrival)
const ramp = (t: number, t0: number, dur: number, a: number, b: number) => a + (b - a) * clamp((t - t0) / dur);
const peakOf = (v: Float32Array) => v.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
const atPeak = (v: Float32Array, dB: number) => {
  const g = db(dB) / (peakOf(v) || 1);
  return v.map((x) => x * g);
};

type Place = { gain?: number; pan?: number; send?: number; until?: number };
/** Writes a rendered voice at t; it is cut (3 ms) at the next hard stop, or at `until`. */
function place(dst: Bus | Float32Array, t: number, v: Float32Array, o: Place = {}) {
  const { gain = 1, pan = 0, send = 0 } = o;
  const i0 = S(t);
  const end = Math.min(v.length, S(Math.min(nextKill(t), o.until ?? DUR)) - i0);
  const fade = S(0.003);
  for (let n = 0; n < end; n++) {
    const i = i0 + n;
    if (i < 0 || i >= N) continue;
    const x = v[n] * gain * Math.min(1, (end - n) / fade);
    if (dst instanceof Float32Array) dst[i] += x;
    else {
      dst.L[i] += x * (1 - Math.max(0, pan));
      dst.R[i] += x * (1 + Math.min(0, pan));
      dst.send[i] += x * send;
    }
  }
}

// ---------------------------------------------------------------- voices
/** Soft felt piano (music.mts): a few decaying partials, a dull hammer and a gentle low-pass. */
function piano(midi: number, vel = 0.7, len = 3) {
  const v = new Float32Array(S(len));
  const f = hz(midi);
  const amps = [1, 0.42, 0.2, 0.09, 0.05];
  let lp = 0;
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    let s = 0;
    amps.forEach((a, k) => (s += Math.sin(2 * Math.PI * f * (k + 1) * (1 + 0.0004 * k) * x) * a * Math.exp(-x * (1.1 + (k + 1) * 0.9))));
    s *= Math.min(1, x / 0.004);
    s += rnd() * Math.exp(-x * 300) * 0.05;
    lp += (0.08 + 0.25 * vel) * (s - lp);
    v[n] = lp * 0.16 * vel * Math.min(1, (len - x) / 0.3);
  }
  return v;
}
/** The demo voice: the piano as a phone recorded it. Two one-pole high-passes at 300 Hz, then ±6 cents
 *  of wow at 0.7 Hz from a fractional read (a delay swinging by ±38 samples). Mono, dry. */
function phoneSketch(x: Float32Array) {
  const a = Math.exp((-2 * Math.PI * 300) / SR);
  const hp = new Float32Array(N);
  let x1 = 0, y1 = 0, y2 = 0, z1 = 0;
  for (let n = 0; n < N; n++) {
    y1 = a * (y1 + x[n] - x1);
    x1 = x[n];
    y2 = a * (y2 + y1 - z1);
    z1 = y1;
    hp[n] = y2;
  }
  const w = 2 * Math.PI * 0.7;
  const depth = ((Math.pow(2, 6 / 1200) - 1) / w) * SR; // pitch ratio 1 ± depth·w/SR = ±6 cents
  const out = new Float32Array(N);
  for (let n = 0; n < N; n++) {
    const r = n - depth * Math.sin((w * n) / SR);
    const j = Math.floor(r), fr = r - j;
    if (j >= 0 && j + 1 < N) out[n] = hp[j] * (1 - fr) + hp[j + 1] * fr;
  }
  return out;
}
/** Warm detuned-saw pad (music.mts) with a moving chord, cutoff and level. */
function pad(b: Bus, t0: number, t1: number, chord: (t: number) => number[], cutoff: (t: number) => number, env: (t: number) => number, gain = 1) {
  t1 = Math.min(t1, nextKill(t0), DUR);
  const lp = [0, 0], lp2 = [0, 0];
  const phs = Array.from({ length: 15 }, () => Math.abs(rnd()));
  for (let i = S(t0); i < S(t1); i++) {
    const t = i / SR;
    let l = 0, r = 0;
    chord(t).forEach((m, k) => {
      for (let d = 0; d < 3; d++) {
        const idx = k * 3 + d;
        phs[idx] += (hz(m) * Math.pow(2, ((d - 1) * 9) / 1200)) / SR;
        const v = saw(phs[idx] % 1);
        if (d === 0) l += v;
        else if (d === 2) r += v;
        else (l += v * 0.6), (r += v * 0.6);
      }
    });
    const a = 1 - Math.exp((-2 * Math.PI * cutoff(t)) / SR);
    lp[0] += a * (l - lp[0]); lp2[0] += a * (lp[0] - lp2[0]);
    lp[1] += a * (r - lp[1]); lp2[1] += a * (lp[1] - lp2[1]);
    const g = env(t) * 0.05 * gain * Math.min(1, (t1 - t) / 0.003);
    b.L[i] += lp2[0] * g; b.R[i] += lp2[1] * g; b.send[i] += (lp2[0] + lp2[1]) * g * 0.3;
  }
}
/** Round sine/saw bass (music.mts). */
function bass(midi: number, len: number) {
  const v = new Float32Array(S(len));
  let ph = 0, a = 0;
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    ph += hz(midi) / SR;
    a += 0.08 * (Math.sin(2 * Math.PI * ph) + 0.35 * saw(ph % 1) - a);
    v[n] = Math.tanh(a * 1.8) * Math.min(1, x / 0.005, (len - x) / 0.02) * 0.32;
  }
  return v;
}
/** A short sine pulse at f: the agent's heartbeat (52 Hz, 120 ms) and the end card's pulses. A faint
 *  2nd harmonic lets it read on small speakers. */
function sub(f = 52, len = 0.12, attack = 0.006) {
  const v = new Float32Array(S(len));
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    v[n] = (Math.sin(2 * Math.PI * f * x) + 0.12 * Math.sin(4 * Math.PI * f * x)) * Math.min(1, x / attack) * (1 - x / len) ** 2;
  }
  return v;
}
/** The final pass's soft pulse: a round sine kick with no click (not the long impact kick). */
function softKick() {
  const v = new Float32Array(S(0.32));
  let ph = 0;
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    ph += (2 * Math.PI * (50 + 24 * Math.exp(-x * 30))) / SR;
    v[n] = Math.sin(ph) * Math.min(1, x / 0.003) * Math.exp(-x * 9) * (1 - x / 0.32);
  }
  return v;
}
/** A slow sub swell under a big chord. */
function swell(f: number, len: number, rise = 0.35) {
  const v = new Float32Array(S(len));
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    const env = x < rise ? Math.sin((Math.PI / 2) * (x / rise)) ** 2 : Math.exp(-(x - rise) * 2.2) * (1 - (x - rise) / (len - rise));
    v[n] = Math.sin(2 * Math.PI * f * x) * env;
  }
  return v;
}
/** A dry rim/snap (music.mts). */
function rim() {
  const v = new Float32Array(S(0.08));
  let lp = 0, ph = 0;
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    const w = rnd();
    lp += 0.4 * (w - lp);
    ph += (2 * Math.PI * 1750) / SR;
    v[n] = ((w - lp) * 0.5 + Math.sin(ph) * 0.3) * Math.exp(-x * 70);
  }
  return v;
}
/** Pink-ish noise (Paul Kellet's economy filter). */
function pink(len: number) {
  const v = new Float32Array(len);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let n = 0; n < len; n++) {
    const w = rnd();
    b0 = 0.99765 * b0 + w * 0.099046;
    b1 = 0.963 * b1 + w * 0.2965164;
    b2 = 0.57 * b2 + w * 1.0526913;
    v[n] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
  }
  return v;
}
function lowpass(v: Float32Array, fc: number) {
  const a = 1 - Math.exp((-2 * Math.PI * fc) / SR);
  let l1 = 0, l2 = 0;
  for (let n = 0; n < v.length; n++) (l1 += a * (v[n] - l1)), (l2 += a * (l1 - l2)), (v[n] = l2);
  return v;
}
const rms = (v: Float32Array, a = 0, b = v.length) => Math.sqrt(v.subarray(a, b).reduce((s, x) => s + x * x, 0) / Math.max(1, b - a));

// ---------------------------------------------------------------- sound effects (quiet, physical)
/** Trackpad press/release: a 3 ms filtered click plus a tiny body thump. */
function trackpad(press: boolean) {
  const v = new Float32Array(S(0.06));
  let a = 0, b = 0, ph = 0;
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    const w = rnd();
    a += 0.55 * (w - a);
    b += 0.12 * (a - b);
    const click = (a - b) * (x < 0.003 ? 1 : Math.exp(-(x - 0.003) * 900));
    ph += (2 * Math.PI * (press ? 115 : 150)) / SR;
    v[n] = click + Math.sin(ph) * Math.min(1, x / 0.002) * Math.exp(-x * (press ? 70 : 110)) * (press ? 0.5 : 0.3);
  }
  return v;
}
/** Soft key tick (music.mts hat). */
function keyTick() {
  const v = new Float32Array(S(0.05));
  let lp = 0;
  for (let n = 0; n < v.length; n++) {
    const w = rnd();
    lp += 0.5 * (w - lp);
    v[n] = (w - lp) * Math.exp((-n / SR) * 70);
  }
  return v;
}
/** The send 'tock': a short, muted wooden sine and noise at about 180 Hz. */
function tock() {
  const v = new Float32Array(S(0.12));
  let p1 = 0, p2 = 0, lp = 0;
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    const f = 172 + 14 * Math.exp(-x * 60);
    p1 += (2 * Math.PI * f) / SR;
    p2 += (2 * Math.PI * f * 2.76) / SR;
    lp += 0.15 * (rnd() - lp);
    v[n] = (Math.sin(p1) + 0.25 * Math.sin(p2) * Math.exp(-x * 60) + lp * 2.2 * Math.exp(-x * 400)) * Math.min(1, x / 0.0015) * Math.exp(-x * 38);
  }
  return v;
}
/** A paper-soft noise burst (the words folding out). */
function fold() {
  const v = new Float32Array(S(0.15));
  let a = 0, b = 0;
  for (let n = 0; n < v.length; n++) {
    const x = n / SR;
    const w = rnd() + (Math.abs(rnd()) > 0.985 ? rnd() * 3 : 0);
    a += 0.6 * (w - a);
    b += 0.18 * (a - b);
    v[n] = (a - b) * (1 - Math.exp(-x / 0.008)) * Math.exp(-x * 30);
  }
  return v;
}
/** Filtered air under the glide: pink noise, low-passed at 400 Hz, -40 dBFS RMS. */
function breath(dur: number) {
  const v = lowpass(pink(S(dur)), 400);
  v.forEach((x, n) => (v[n] = x * Math.pow(Math.sin((Math.PI * n) / v.length), 1.5)));
  const g = db(-40) / (rms(v, v.length >> 2, (v.length * 3) >> 2) || 1);
  return v.map((x) => x * g);
}
function decode(file: string) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength));
}

// ---------------------------------------------------------------- the score
// Chords as two-beat slots, counted back from the tonic: ... E | A | E | B/D# | C#m7 A | Bsus4 B | E.
const CH: Record<string, { bass: number; pad: number[]; ost: number[] }> = {
  E: { bass: 40, pad: [52, 59, 66, 68], ost: [52, 59, 64, 68] }, // E add9
  BD: { bass: 39, pad: [51, 59, 63, 66], ost: [51, 59, 63, 66] }, // B/D#
  Csm: { bass: 37, pad: [49, 56, 59, 64], ost: [49, 56, 59, 64] }, // C#m7
  A: { bass: 33, pad: [45, 52, 59, 61], ost: [45, 52, 59, 61] }, // A add9
  Bsus: { bass: 35, pad: [47, 54, 59, 64], ost: [47, 54, 59, 64] },
  B: { bass: 35, pad: [47, 54, 59, 63], ost: [47, 54, 59, 63] },
};
const TONIC_PAD = [52, 56, 59, 64]; // plain E major
const SLOTS = ["B", "Bsus", "A", "Csm", "BD", "E", "A", "E"];
const slotAt = (k: number) => {
  const j = Math.floor((-k - 1) / 2);
  return CH[SLOTS[j < 8 ? j : 4 + ((j - 4) % 4)]];
};
// The theme, [beat from the tonic, midi, beats held]: the motif B4–E5–G#5, a scale down from B5 and
// the motif again, landing its E5 on the tonic. Earlier statements repeat the -16..-9 phrase.
const THEME: [number, number, number][] = [
  [-16.5, 71, 0.5], [-16, 76, 1], [-15, 80, 1], [-14, 81, 1], [-13, 80, 1], [-12, 76, 2], [-10, 78, 1], [-9, 75, 0.5],
  [-8.5, 71, 0.5], [-8, 76, 1], [-7, 80, 1], [-6, 83, 1], [-5, 81, 0.5], [-4.5, 80, 0.5], [-4, 78, 1], [-3, 76, 1], [-2, 75, 1], [-1, 71, 1],
];
const motifAt = (t: number) => (resolves.filter((c) => c.at <= t + 0.01).length >= 2 ? [71, 76, 80] : [71, 76]);
const FIGURE = { E: [71, 76, 80, 78], A: [71, 76, 81, 80] }; // the coda's one-bar figure

// Resolve chimes complete a rising arpeggio (E5, G#5, B5); the pin dockings are E6/G#6/B6 ticks.
for (const c of C.chimes) {
  if (muted(c.at)) continue;
  if (c.midi >= 88) place(A, c.at, atPeak(piano(c.midi, 0.5, 1.4), -26), { pan: clamp((c.midi - 92) / 20, -0.3, 0.3), send: 0.25 });
  else if ((L1 === undefined || c.at < L1) && c.at < STEREO) place(demoF, c.at, piano(c.midi, 0.5, 3.2));
  else place(F, c.at, piano(c.midi, 0.5, 3.2), { gain: 0.9, pan: c.at >= STEREO ? 0.12 : 0, send: 0.35 });
}

// The agent's heartbeat, only while a note is in working state. With a bar grid running it falls
// in with the grid after its first beat.
for (const [a, b] of C.working) {
  const grid = L1 !== undefined && a >= L1 && a < BED_END ? L1 : undefined;
  const beats = [a];
  for (let t = grid === undefined ? a + BEAT : grid + Math.ceil((a + 0.55 * BEAT - grid) / BEAT) * BEAT; t < b - 0.02; t += BEAT) beats.push(t);
  for (const t of beats) if (!muted(t)) place(A, t, atPeak(sub(52, 0.12), -24), { until: b });
}

// L1: the left hand (E2/B2 fifths) in a room, and the motif every other bar. L2: the pad, opening up.
if (L1 !== undefined) {
  let since = 2;
  for (let j = 0, t = L1; t < BED_END; j++, t = L1 + j * BAR) {
    if (muted(t) || inDrop(t) || nextKill(t) - t < 0.5) continue;
    place(F, t, piano(40, 0.42, 3.4), { gain: 0.8, pan: -0.15, send: 0.35 });
    place(F, t + 0.012, piano(47, 0.38, 3.4), { gain: 0.8, pan: -0.1, send: 0.35 });
    const afterDrop = DROPS.some(([, d]) => t > d && t - d < BAR + 0.15);
    if (since >= 2 || afterDrop) {
      motifAt(t).forEach((m, k) => {
        const tt = t + k * BEAT;
        if (!inDrop(tt) && nextKill(tt) - tt > 0.3) place(F, tt, piano(m, 0.46, 3), { gain: 0.8, pan: 0.1, send: 0.35 });
      });
      since = 0;
    }
    since++;
  }
}
if (L2 !== undefined && L2 < BED_END) {
  const span = BED_END - L2;
  pad(F, L2, BED_END, () => CH.E.pad, (t) => 700 + 400 * clamp((t - L2) / span), (t) => Math.min(1, (t - L2) / 1.5) * dropEnv(t), 0.45);
}
// The fold: the pulse stops dead; one low felt octave (E1+E2) over a slow 40 Hz swell, then near-silence.
for (const [a] of DROPS) {
  place(F, a, piano(28, 0.6, 3.5), { pan: -0.2, send: 0.3 });
  place(F, a + 0.01, piano(40, 0.5, 3.5), { pan: -0.15, send: 0.3 });
  place(F, a, swell(40, 1.2), { gain: 0.09 });
}

// The arrival: the first full chord, spread across the piano (and the stereo field), pad and sub,
// with a faint E7/B7 (2.6/3.9 kHz) shimmer for the caption lift.
if (ARRIVAL !== undefined && !muted(ARRIVAL)) {
  [40, 47, 52, 56, 59, 66].forEach((m, k) => place(F, ARRIVAL + k * 0.024, piano(m, 0.62, 5), { gain: 0.95, pan: panOf(m), send: 0.4 }));
  place(F, ARRIVAL, swell(hz(28), 2.6), { gain: 0.05 });
  const until = (FULL ?? ARRIVAL + 3) + 0.12;
  pad(F, ARRIVAL, until, () => CH.E.pad, () => 1100, (t) => Math.min(1, (t - ARRIVAL) / 0.06, (until - t) / 0.12), 2.0);
  for (let n = 0; n < S(1.4); n++) {
    const x = n / SR, i = S(ARRIVAL) + n;
    if (i >= N) break;
    const env = Math.sin((Math.PI / 2) * Math.min(1, x / 0.45)) * clamp(1 - (x - 1.1) / 0.3) * (1 + 0.25 * Math.sin(2 * Math.PI * 5.5 * x)) / 1.25;
    const lo = Math.sin(2 * Math.PI * hz(100) * x) * env * db(-38), hi = Math.sin(2 * Math.PI * hz(107) * x) * env * db(-38);
    A.L[i] += lo + hi * 0.6; A.R[i] += hi + lo * 0.6; A.send[i] += (lo + hi) * 0.2;
  }
}

// The final pass: the full theme over bass, pad, ostinato and a soft pulse, resolving on the tonic;
// then the tonic rings into the reveal's pad, and a one-bar figure carries the coda on the same grid.
if (FULL !== undefined && TONIC !== undefined) {
  const k0 = Math.ceil((FULL - TONIC) / BEAT - 1e-6);
  const beat = (k: number) => TONIC + k * BEAT;
  for (const [k, m, held] of THEME) {
    for (let kk = k; beat(kk) >= FULL - 0.3; kk -= 8) {
      // A pickup that falls just before the cue moves onto it, so the final pass still opens on B4–E5.
      if (beat(kk) >= FULL - 1e-6 || kk % 1) place(F, Math.max(FULL, beat(kk)), piano(m, 0.6, held * BEAT + 1.6), { gain: 1.1, pan: 0.1, send: 0.3 });
      if (k >= -8.5) break; // the last phrase plays once; the one before it repeats back to the cue
    }
  }
  for (let h = Math.ceil((FULL - TONIC) / (BEAT / 2) - 1e-6); h < 0; h++) {
    const m = slotAt(Math.floor(h / 2)).ost[[0, 2, 1, 3][((h % 4) + 4) % 4]];
    place(F, TONIC + (h * BEAT) / 2, piano(m, 0.28, 1.4), { pan: panOf(m), send: 0.3 });
  }
  for (let k = k0; k < 0; k++) if (k % 2 === 0 || k === k0) place(F, beat(k), bass(slotAt(k).bass, (k % 2 === 0 ? 2 : 1) * BEAT * 0.98), { gain: 0.45 });
  for (let k = k0; beat(k) < REVEAL - 0.05; k++) {
    if (muted(beat(k))) continue;
    place(A, beat(k), atPeak(softKick(), -22));
    if ([1, 3].includes(((k % 4) + 4) % 4)) place(A, beat(k), atPeak(rim(), -30), { pan: -0.1 });
  }
  // The tonic: E major, with the motif's E5 on top.
  [40, 47, 52, 56, 59, 64, 68, 76].forEach((m, k) => place(F, TONIC + (k && m !== 76 ? k * 0.014 : 0), piano(m, m === 76 ? 0.62 : 0.56, 6.5), { gain: 0.9, pan: panOf(m), send: 0.4 }));
  place(F, TONIC, bass(40, 3.2), { gain: 0.45 });
  place(F, TONIC, swell(hz(28), 2.2, 0.12), { gain: 0.03 });
  // The coda: after the pins dock, the figure (and its demo-voice shadow) on the tonic's bar grid.
  const kCoda = 4 * Math.ceil((Math.max(REVEAL + 1.5, (docks[docks.length - 1] ?? 0) + 1) - TONIC) / BAR - 1e-6);
  // Two bars of E add9, then two of A add9, never starting a bar that the end card would cut.
  const harmony = (k: number) => (k < kCoda || Math.floor((k - kCoda) / 8) % 2 === 0 || beat(k - (k % 4)) + BAR > ENDCARD + 0.05 ? "E" : "A");
  for (let k = 1; beat(k) < ENDCARD - 0.05; k++) {
    const m = FIGURE[harmony(k)][k % 4];
    place(demoC, beat(k), piano(m, 0.5, 2.6));
    if (k < kCoda || muted(beat(k))) continue;
    place(F, beat(k), piano(m, 0.5, 2.6), { gain: 1.3, pan: 0.12, send: 0.4 });
    if (k % 4 === 0) (harmony(k) === "E" ? [40, 47] : [33, 40]).forEach((l, n) => place(F, beat(k) + n * 0.012, piano(l, 0.45, 3), { gain: 1.2, pan: -0.15, send: 0.35 }));
  }
  const CODA = beat(kCoda);
  // The pad: the progression, the tonic, then a sustained E add9 that swells a little under the coda and
  // dies away under the end card so the three pulses are heard on their own.
  const tail = Math.max(ENDCARD + 0.5, END_GATE - 0.2);
  pad(
    F, FULL, END_GATE,
    (t) => (t < TONIC ? slotAt(Math.floor((t - TONIC) / BEAT)).pad : t < REVEAL ? TONIC_PAD : t >= CODA && t < ENDCARD && harmony(Math.floor((t - TONIC) / BEAT)) === "A" ? CH.A.pad : CH.E.pad),
    (t) => (t < TONIC ? 1250 : t < REVEAL ? 1400 : t < ENDCARD ? 1000 : ramp(t, ENDCARD, tail - ENDCARD, 1000, 500)),
    (t) => Math.min(1, (t - FULL) / 0.1) * (t < REVEAL ? 1 : t < ENDCARD ? ramp(t, REVEAL, 1.5, 1, 1.4) : 1.4 * Math.pow(1 - clamp((t - ENDCARD) / (tail - ENDCARD)), 2.5)),
    0.9,
  );
}

// The end card: three soft 52 Hz pulses with the waiting dot, then silence.
for (const p of PULSES) if (!muted(p)) place(A, p, atPeak(sub(52, 0.42, 0.015), -27));

// Room tone under the opening, until the silence: pink noise, low-passed at 6 kHz, -50 dBFS.
{
  const end = S(SIL?.[0] ?? STEREO);
  const v = lowpass(pink(end), 6000);
  const g = db(-50) / (rms(v) || 1);
  for (let n = 0; n < end; n++) room[n] = v[n] * g * (1 + 0.1 * Math.sin((2 * Math.PI * 0.11 * n) / SR)) * Math.min(1, n / S(0.02), (end - n) / S(0.003));
}

// Sound effects. Recorded ElevenLabs click/key replace the synthesized ones when present.
const BANNED = new Set(["boing", "squeak", "pop", "riser", "whoosh", "clap", "impact", "slam", "squeal", "tape"]);
const SFX_PEAK: Record<string, number> = { click: -33, release: -37, key: -38, tock: -25, fold: -36 };
const ELEVEN = "launch/out/eleven/sfx";
const recorded = new Map<string, Float32Array>();
const usedEleven = new Set<string>();
for (const e of C.sfx) {
  if (BANNED.has(e.name)) console.warn(`sfx '${e.name}' at ${e.at} is banned in this film: skipped`);
  else if (gated(e.at)) continue;
  else if (e.name === "breath") place(X, e.at, breath(e.dur ?? 1.3), { gain: e.gain ?? 1 });
  else if (e.name in SFX_PEAK) {
    const file = join(ELEVEN, `${e.name}.mp3`);
    let v: Float32Array;
    if ((e.name === "click" || e.name === "key") && existsSync(file)) {
      if (!recorded.has(e.name)) recorded.set(e.name, decode(file));
      v = recorded.get(e.name)!;
      usedEleven.add(e.name);
    } else v = e.name === "click" ? trackpad(true) : e.name === "release" ? trackpad(false) : e.name === "key" ? keyTick() : e.name === "tock" ? tock() : fold();
    place(X, e.at, atPeak(v, SFX_PEAK[e.name]), { gain: e.gain ?? 1, pan: e.name === "key" ? rnd() * 0.2 : 0 });
  } else console.warn(`unknown sfx '${e.name}' at ${e.at}: skipped`);
}

// ---------------------------------------------------------------- reverb (music.mts), emptied at each hard stop
function reverb(b: Bus) {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ d: Math.round((d * SR) / 44100), buf: new Float32Array(Math.round((d * SR) / 44100) + 23), i: 0, lp: 0 }));
  const aps = [556, 441, 341].map((d) => ({ buf: new Float32Array(Math.round((d * SR) / 44100)), i: 0 }));
  const resets = new Set(KILLS.map(S));
  for (let n = 0; n < N; n++) {
    if (resets.has(n)) {
      for (const c of combs) c.buf.fill(0), (c.lp = 0);
      for (const a of aps) a.buf.fill(0);
    }
    let outL = 0, outR = 0;
    combs.forEach((c, k) => {
      const len = c.d + (k % 2 ? 23 : 0);
      const y = c.buf[c.i % len];
      c.lp = y * 0.7 + c.lp * 0.3;
      c.buf[c.i % len] = b.send[n] * 0.5 + c.lp * 0.84;
      c.i++;
      if (k % 2) outR += y;
      else outL += y;
    });
    let mono = (outL + outR) * 0.5;
    for (const a of aps) {
      const y = a.buf[a.i];
      a.buf[a.i] = mono + y * 0.5;
      mono = y - mono * 0.5;
      a.i = (a.i + 1) % a.buf.length;
    }
    b.L[n] += (outL * 0.7 + mono * 0.3) * 0.12;
    b.R[n] += (outR * 0.7 + mono * 0.3) * 0.12;
  }
}
const sketchF = phoneSketch(demoF), sketchC = phoneSketch(demoC);
for (let n = 0; n < N; n++) (F.L[n] += sketchF[n]), (F.R[n] += sketchF[n]);
reverb(F);
reverb(A);

// ---------------------------------------------------------------- the rewind
// The last ~0.7 s of the score before `from`, reversed and sped up 1→2.2× along an expo-in curve (it
// stays near 1× so the window is the brief's ~0.7 s; the picture's own tl ∝ u^2.2 would read back ~1 s),
// low-passed (3 → 1.2 kHz as it speeds up); then two frames of silence on the cut.
let rewindSpan = 0;
if (RW) {
  const i0 = S(RW.from), i1 = S(RW.to - 2 * FRAME), len = i1 - i0;
  const src = [F.L.slice(0, i0), F.R.slice(0, i0)];
  const lp = [0, 0, 0, 0];
  let pos = i0 - 1;
  for (let n = 0; n < len; n++) {
    const u = n / len;
    const j = Math.floor(pos), fr = pos - j;
    const a = 1 - Math.exp((-2 * Math.PI * (3000 - 1800 * u)) / SR);
    const env = Math.min(1, n / S(0.004), (len - n) / S(0.006));
    src.forEach((s, c) => {
      const v = j >= 0 ? s[j] * (1 - fr) + (j + 1 < i0 ? s[j + 1] : 0) * fr : 0;
      lp[c * 2] += a * (v - lp[c * 2]);
      lp[c * 2 + 1] += a * (lp[c * 2] - lp[c * 2 + 1]);
      (c ? F.R : F.L)[i0 + n] = lp[c * 2 + 1] * env;
    });
    pos -= 1 + 1.2 * expoIn(u);
  }
  F.L.fill(0, i1, S(RW.to));
  F.R.fill(0, i1, S(RW.to));
  rewindSpan = (i0 - 1 - pos) / SR;
}

// ---------------------------------------------------------------- mix + master
// Before/After: a hard switch (4 ms) between the full score and the demo piano, on the same grid.
const full = new Float32Array(N).fill(1);
const edge = S(0.004);
for (const [a, b] of DEMO)
  for (let i = Math.max(0, S(a) - edge); i < Math.min(N, S(b) + edge); i++) full[i] = Math.min(full[i], 1 - clamp(Math.min(i - S(a) + edge, S(b) + edge - i) / edge));

/** Linked look-ahead peak limiter (1.5 ms look-ahead, 80 ms release), so loudnorm can stay linear. */
function limit(L: Float32Array, R: Float32Array, ceilingDb: number) {
  const c = db(ceilingDb), W = S(0.0015), rel = 1 - Math.exp(-1 / (0.08 * SR));
  const g = new Float32Array(N).fill(1);
  for (let n = 0; n < N; n++) {
    const p = Math.max(Math.abs(L[n]), Math.abs(R[n]));
    if (p > c) for (let k = Math.max(0, n - W); k <= n; k++) g[k] = Math.min(g[k], c / p);
  }
  let b = 1, sum = W, min = 1;
  const hist = new Float32Array(W).fill(1);
  for (let n = 0; n < N; n++) {
    b = Math.min(g[n], b + (1 - b) * rel);
    sum += b - hist[n % W];
    hist[n % W] = b;
    const gain = sum / W;
    L[n] *= gain;
    R[n] *= gain;
    min = Math.min(min, gain);
  }
  return -20 * Math.log10(min);
}
function mix(music: number, ceilingDb: number) {
  const L = new Float32Array(N), R = new Float32Array(N);
  const stereo = S(STEREO);
  for (let n = 0; n < N; n++) {
    const f = full[n];
    let l = music * (F.L[n] * f + sketchC[n] * (1 - f)) + A.L[n] * f + X.L[n] + room[n];
    let r = music * (F.R[n] * f + sketchC[n] * (1 - f)) + A.R[n] * f + X.R[n] + room[n];
    if (n < stereo) l = r = (l + r) / 2; // the arrival is the first time the mix is stereo
    L[n] = l;
    R[n] = r;
  }
  for (const [a, b] of GATES) L.fill(0, S(a), S(b)), R.fill(0, S(a), S(b));
  return { L, R, gr: limit(L, R, ceilingDb) };
}
function wav(frames: number, bits: 16 | 32) {
  const bytes = frames * 2 * (bits / 8), h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + bytes, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(bits === 32 ? 3 : 1, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 2 * (bits / 8), 28); h.writeUInt16LE(2 * (bits / 8), 32); h.writeUInt16LE(bits, 34); h.write("data", 36); h.writeUInt32LE(bytes, 40);
  return h;
}
const RAW = join(OUT, "soundtrack-raw.wav"), WAV = join(OUT, "soundtrack.wav");
const TARGET = { I: -14, TP: -2 };
const measure = () => {
  const err = spawnSync("ffmpeg", ["-hide_banner", "-i", RAW, "-af", `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const m = JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/.exec(err)![0]);
  return { ...m, I: +m.input_i, TP: +m.input_tp, LRA: +m.input_lra };
};

// Two-pass loudnorm (music.mts) needs linear mode, or it would compress the dramaturgy: the score is
// scaled until it measures -14 LUFS (so the dBFS-specified elements land where specified) and limited
// until the gain leaves true peak under -2 dBFS. The LRA target is raised to the score's own range.
let gainDb = 0, ceiling = TARGET.TP - 0.35, gr = 0, prev: [number, number] | undefined;
let m = { I: 0, TP: 0, LRA: 0 } as ReturnType<typeof measure>;
let mixedDb = 0, converged = false;
for (let it = 0; it < 12; it++) {
  const r = mix(db(gainDb), ceiling);
  gr = r.gr;
  mixedDb = gainDb;
  const inter = new Float32Array(N * 2);
  for (let n = 0; n < N; n++) (inter[2 * n] = r.L[n]), (inter[2 * n + 1] = r.R[n]);
  writeFileSync(RAW, Buffer.concat([wav(N, 32), Buffer.from(inter.buffer)]));
  m = measure();
  const off = TARGET.I - m.I, over = m.TP + off - (TARGET.TP - 0.15); // over > 0: loudnorm would leave linear mode
  if (Math.abs(off) < 0.15 && over <= 0) {
    converged = true;
    break;
  }
  // Secant step on (gain, loudness): the limiter eats part of every dB once it is working.
  const slope = prev && Math.abs(gainDb - prev[0]) > 0.01 ? clamp((m.I - prev[1]) / (gainDb - prev[0]), 0.3, 1) : 1;
  prev = [gainDb, m.I];
  gainDb += off / slope;
  if (over > 0 && Math.abs(off) < 1) ceiling -= over + 0.1;
}
// Not converged: loudnorm's own linear gain makes up the rest, so the dBFS-specified elements drift by it.
if (!converged) console.warn(`master: gain search did not converge (${m.I} LUFS / ${m.TP} dBTP before loudnorm)`);
const music = db(mixedDb); // the gain actually in soundtrack-raw.wav
const lra = Math.min(50, Math.max(11, Math.ceil(m.LRA + 1)));
const pass2 = spawnSync(
  "ffmpeg",
  [
    "-hide_banner", "-i", RAW, "-af",
    `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${lra}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true:print_format=json,aresample=192000,alimiter=limit=0.72:level=false:attack=1:release=60:latency=1,aresample=48000:osf=s16:dither_method=none`,
    "-f", "s16le", "-ac", "2", "-ar", String(SR), "-",
  ],
  { maxBuffer: 1 << 30 },
);
if (pass2.status !== 0) throw new Error(`loudnorm pass 2 failed: ${pass2.stderr.toString().slice(-2000)}`);
const norm = JSON.parse(/\{[^{}]*"normalization_type"[^{}]*\}/.exec(pass2.stderr.toString())![0]);
if (norm.normalization_type !== "linear") throw new Error(`loudnorm fell back to ${norm.normalization_type} mode`);
const pcm = new Int16Array(N * 2);
pcm.set(new Int16Array(pass2.stdout.buffer.slice(pass2.stdout.byteOffset, pass2.stdout.byteOffset + Math.min(pass2.stdout.byteLength, N * 4))));
// The resamplers ring a little into the gates: put them back at digital zero after mastering.
for (const [a, b] of GATES) pcm.fill(0, S(a) * 2, S(b) * 2);
writeFileSync(WAV, Buffer.concat([wav(N, 16), Buffer.from(pcm.buffer)]));

// ---------------------------------------------------------------- checks
const file = readFileSync(WAV);
const back = new Int16Array(file.buffer.slice(file.byteOffset + 44, file.byteOffset + file.byteLength));
const nonzero = (a: number, b: number) => back.subarray(S(a) * 2, S(b) * 2).reduce((c, x) => c + (x !== 0 ? 1 : 0), 0);
let side = 0;
for (let n = 0; n < S(STEREO); n++) side = Math.max(side, Math.abs(back[2 * n] - back[2 * n + 1]));
const ebu = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", WAV, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const summary = ebu.slice(ebu.lastIndexOf("Summary:"));
const I = /I:\s+(-?[\d.]+) LUFS/.exec(summary)?.[1], LRA = /LRA:\s+(-?[\d.]+) LU/.exec(summary)?.[1], TPK = /Peak:\s+(-?[\d.inf]+) dBFS/.exec(summary)?.[1];
const M = [...ebu.matchAll(/t:\s*([\d.]+)\s+TARGET:\S+ LUFS\s+M:\s*(-?[\d.]+)/g)].map((x) => [+x[1], +x[2]]);
const loudest = (a: number, b: number) => Math.max(...M.filter(([t]) => t >= a + 0.4 && t <= b + 1e-6).map(([, v]) => v), -120.7);
const show = (name: string, a?: number, b?: number) => (a !== undefined && b !== undefined && b > a + 0.4 ? `${name} ${loudest(a, b).toFixed(1)}` : "");

console.log(`cues: ${fromFile ? FILE : "built-in defaults (beat sheet)"} · ${DUR}s · layers ${layers.map((l) => `${l.name}@${l.at}`).join(" ")}`);
console.log(`master: music gain ${(20 * Math.log10(music)).toFixed(2)} dB · pre-limit ceiling ${ceiling.toFixed(2)} dBFS (max GR ${gr.toFixed(2)} dB) · pass 1 ${m.I} LUFS / ${m.TP} dBTP / LRA ${m.LRA} · loudnorm ${norm.normalization_type}, LRA target ${lra}`);
console.log(`soundtrack.wav: integrated ${I} LUFS · true peak ${TPK} dBFS · LRA ${LRA} LU`);
console.log(`digital zero: ${GATES.map(([a, b]) => `[${a.toFixed(3)}, ${b.toFixed(3)}) ${nonzero(a, b)} non-zero samples`).join(" · ")} · mono before ${STEREO}s (max |L-R| ${side})`);
console.log(
  "loudest momentary (LUFS):",
  [
    show("opening", 0, C.working[0]?.[0]), show("L1", L1, L2), show("L2", L2, BED_END), show("arrival", ARRIVAL, FULL), show("full", FULL, TONIC),
    show("tonic", TONIC, REVEAL), show("reveal", REVEAL, DEMO[0]?.[0]), show("before", DEMO[0]?.[0], DEMO[0]?.[1]), show("after", DEMO[0]?.[1], ENDCARD), show("end", ENDCARD, END_GATE),
  ].filter(Boolean).join(" · "),
);
console.log(`rewind: ${RW ? `${rewindSpan.toFixed(3)}s of score reversed into [${RW.from}, ${RW.to}]` : "none"} · drops ${DROPS.map(([a, b]) => `[${a}, ${b}]`).join(" ") || "none"} · sfx ${C.sfx.length} (${usedEleven.size ? `ElevenLabs: ${[...usedEleven].join(", ")}` : "synthesized"})`);

// A waveform with the cues drawn on it (coral: working and digital zero, grey: layers, lime: chimes,
// arrival and tonic), to check the structure at a glance.
const PW = 2400, px = (t: number) => Math.round((t / DUR) * PW);
const box = (t0: number, t1: number, y: string, h: string, color: string) => `drawbox=x=${px(t0)}:y=${y}:w=${Math.max(2, px(t1) - px(t0))}:h=${h}:color=${color}:t=fill`;
const marks = [
  ...GATES.map(([a, b]) => box(a, b, "0", "ih", "0xff5f4f@0.35")),
  ...C.working.map(([a, b]) => box(a, b, "0", "16", "0xff5f4f@0.85")),
  ...layers.map((l) => box(l.at, l.at, "0", "ih", "0x8d8983@0.9")),
  ...C.chimes.map((c) => box(c.at, c.at, "ih-16", "16", "0xe8f47c@0.95")),
  ...[ARRIVAL, TONIC].filter((t): t is number => t !== undefined).map((t) => box(t, t, "0", "ih", "0xe8f47c@0.8")),
];
execFileSync("ffmpeg", [
  "-v", "error", "-y", "-i", WAV, "-f", "lavfi", "-i", `color=c=0x0d0d0f:s=${PW}x600:d=1`, "-filter_complex",
  `[0:a]showwavespic=s=${PW}x600:split_channels=1:scale=sqrt:filter=peak:colors=0xd8d2c8|0xd8d2c8[w];[1:v][w]overlay=format=auto,${marks.join(",")}`,
  "-frames:v", "1", join(OUT, "score-wave.png"),
]);
console.log(`${WAV} · ${join(OUT, "score-wave.png")}`);
