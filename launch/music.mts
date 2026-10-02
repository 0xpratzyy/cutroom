// Synthesizes the launch film's soundtrack (120 BPM, A minor) and mixes in the dialogue cues
// the compositor wrote (launch/out/cues.json), ducking the music under them.
// Usage: npx tsx launch/music.mts  ->  launch/out/soundtrack.wav
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SR = 48000;
const DUR = 35.5;
const N = Math.ceil(DUR * SR);
const L = new Float32Array(N), R = new Float32Array(N);
const verbIn = new Float32Array(N); // mono reverb send
const BEAT = 0.5;

let seed = 1234567;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const hz = (midi: number) => 440 * Math.pow(2, (midi - 69) / 12);
const add = (i: number, v: number, pan = 0, send = 0) => {
  if (i < 0 || i >= N) return;
  L[i] += v * (1 - Math.max(0, pan));
  R[i] += v * (1 + Math.min(0, pan));
  verbIn[i] += v * send;
};
const S = (t: number) => Math.round(t * SR);

// Sidechain: every kick ducks the tonal parts.
const kicks: number[] = [];
const duckAt = (t: number) => {
  let g = 1;
  for (let k = kicks.length - 1; k >= 0; k--) {
    const d = t - kicks[k];
    if (d < 0) continue;
    if (d > 0.5) break;
    g = Math.min(g, 1 - 0.65 * Math.exp(-d * 9));
  }
  return g;
};

// ---------------------------------------------------------------- drums
function kick(t: number, gain = 1, long = false) {
  kicks.push(t);
  kicks.sort((a, b) => a - b);
  const len = long ? 1.8 : 0.45;
  let ph = 0;
  for (let n = 0; n < S(len); n++) {
    const x = n / SR;
    const f = 42 + 120 * Math.exp(-x * 32);
    ph += (2 * Math.PI * f) / SR;
    const env = Math.exp(-x * (long ? 2.2 : 7));
    const click = Math.exp(-x * 500) * rnd() * 0.35;
    add(S(t) + n, Math.tanh((Math.sin(ph) * env * 1.6 + click) * 1.4) * 0.8 * gain);
  }
}
function clap(t: number, gain = 1, send = 0.35) {
  let lp = 0, lp2 = 0;
  for (let n = 0; n < S(0.35); n++) {
    const x = n / SR;
    const bursts = [0, 0.011, 0.022].reduce((a, o) => a + (x >= o ? Math.exp(-(x - o) * 140) : 0), 0);
    const env = bursts * 0.6 + Math.exp(-x * 16) * 0.5;
    const w = rnd();
    lp += 0.25 * (w - lp);
    lp2 += 0.03 * (lp - lp2);
    add(S(t) + n, (lp - lp2) * env * 1.3 * gain, 0, send);
  }
}
function hat(t: number, gain = 1, open = false, pan = 0.2) {
  let lp = 0;
  const len = open ? 0.25 : 0.05;
  for (let n = 0; n < S(len); n++) {
    const x = n / SR;
    const w = rnd();
    lp += 0.5 * (w - lp);
    add(S(t) + n, (w - lp) * Math.exp(-x * (open ? 14 : 70)) * 0.22 * gain, pan, 0.05);
  }
}
function impact(t: number, gain = 1) {
  kick(t, 1.1 * gain, true);
  let lp = 0;
  for (let n = 0; n < S(2.5); n++) {
    const x = n / SR;
    const w = rnd();
    lp += (0.02 + 0.5 * Math.exp(-x * 2)) * (w - lp);
    add(S(t) + n, lp * Math.exp(-x * 2.4) * 0.5 * gain, rnd() * 0.3, 0.6);
  }
}
function riser(t0: number, t1: number, gain = 1) {
  let lp = 0, ph = 0;
  for (let n = 0; n < S(t1 - t0); n++) {
    const u = n / S(t1 - t0);
    const w = rnd();
    lp += (0.01 + 0.6 * u * u) * (w - lp);
    ph += (2 * Math.PI * (220 + 1400 * u * u)) / SR;
    add(S(t0) + n, (lp * 0.7 + Math.sin(ph) * 0.08) * Math.pow(u, 2.2) * 0.55 * gain, Math.sin(u * 20) * 0.3, 0.3);
  }
}
function whoosh(t: number, gain = 1) {
  let lp = 0;
  const len = 0.35;
  for (let n = 0; n < S(len); n++) {
    const u = n / S(len);
    const w = rnd();
    lp += (0.03 + 0.25 * Math.sin(Math.PI * u)) * (w - lp);
    add(S(t - len * 0.6) + n, lp * Math.sin(Math.PI * u) ** 2 * 0.5 * gain, (u - 0.5) * 1.2, 0.2);
  }
}
function blip(t: number, midi: number, gain = 1) {
  let ph = 0;
  for (let n = 0; n < S(0.12); n++) {
    const x = n / SR;
    ph += (2 * Math.PI * hz(midi) * (1 + 0.5 * Math.exp(-x * 80))) / SR;
    add(S(t) + n, Math.sin(ph) * Math.exp(-x * 35) * 0.22 * gain, 0.3, 0.25);
  }
}

// ---------------------------------------------------------------- tonal
const CHORDS = [
  [57, 60, 64], // Am
  [53, 57, 60], // F
  [48, 52, 55], // C
  [55, 59, 62], // G
];
const chordAt = (t: number) => CHORDS[Math.floor(t / 2) % 4];

function saw(ph: number) {
  return 2 * (ph - Math.floor(ph + 0.5));
}
function pad(t0: number, t1: number, gain = 1, cutoff = 1400) {
  const lp = [0, 0], lp2 = [0, 0];
  const phs = new Array(18).fill(0).map(() => Math.random());
  for (let n = 0; n < S(t1 - t0); n++) {
    const t = t0 + n / SR;
    const chord = chordAt(t);
    const env = Math.min(1, (t - t0) / 0.4, (t1 - t) / 0.5);
    let l = 0, r = 0;
    chord.forEach((m, k) => {
      for (let d = 0; d < 3; d++) {
        const idx = k * 3 + d;
        phs[idx] += (hz(m) * Math.pow(2, ((d - 1) * 9) / 1200)) / SR;
        const v = saw(phs[idx] % 1);
        if (d === 0) l += v;
        else if (d === 2) r += v;
        else (l += v * 0.6), (r += v * 0.6);
      }
    });
    const a = 1 - Math.exp((-2 * Math.PI * cutoff) / SR);
    lp[0] += a * (l - lp[0]); lp2[0] += a * (lp[0] - lp2[0]);
    lp[1] += a * (r - lp[1]); lp2[1] += a * (lp[1] - lp2[1]);
    const g = env * 0.05 * gain * duckAt(t);
    const i = S(t);
    L[i] += lp2[0] * g; R[i] += lp2[1] * g; verbIn[i] += (lp2[0] + lp2[1]) * g * 0.3;
  }
}
function pluck(t: number, midi: number, gain = 1, bright = 1, pan = 0) {
  let ph = Math.random(), ph2 = Math.random(), a = 0, b = 0;
  for (let n = 0; n < S(0.4); n++) {
    const x = n / SR;
    ph += hz(midi) / SR;
    ph2 += (hz(midi) * 1.004) / SR;
    const v = saw(ph % 1) + saw(ph2 % 1) * 0.7;
    const fc = 300 + 5200 * bright * Math.exp(-x * 14);
    const k = 1 - Math.exp((-2 * Math.PI * fc) / SR);
    a += k * (v - a); b += k * (a - b);
    add(S(t) + n, b * Math.exp(-x * 7) * 0.09 * gain * duckAt(t + x), pan, 0.35);
  }
}
function bass(t: number, midi: number, len: number, gain = 1) {
  let ph = 0, a = 0;
  for (let n = 0; n < S(len); n++) {
    const x = n / SR;
    ph += hz(midi) / SR;
    const v = Math.sin(2 * Math.PI * ph) + 0.35 * saw(ph % 1);
    a += 0.08 * (v - a);
    const env = Math.min(1, x / 0.005) * Math.min(1, (len - x) / 0.02);
    add(S(t) + n, Math.tanh(a * 1.8) * env * 0.32 * gain * duckAt(t + x));
  }
}

// ---------------------------------------------------------------- arrangement
// Intro: three word hits.
pad(0, 2.0, 0.7, 700);
for (const t of [0.5, 1.0, 1.5]) {
  kick(t, 0.9);
  clap(t, 0.8, 0.5);
}
// 2–4: the "describing edits" chat pile-up.
for (let k = 0; k < 8; k++) {
  const t = 2 + k * 0.25;
  blip(t, 76 + k * 2, 0.9);
  hat(t + 0.125, 0.6);
  if (k % 2 === 0) kick(t, 0.6);
}
riser(2.0, 3.75, 1.0);
// 4: "Just point."
impact(4.0, 1);
clap(4.0, 1, 0.9);
pad(4.0, 6.0, 0.8, 900);
for (let i = 0; i < 16; i++) {
  const t = 4 + i * 0.125;
  const ch = chordAt(t);
  pluck(t, ch[i % 3] + 12, 0.7, 0.2 + (i / 16) * 0.8, i % 2 ? 0.3 : -0.3);
}
riser(5.0, 6.0, 0.9);
for (const t of [5.0, 5.5, 5.75, 5.875]) kick(t, 0.7);

// 6–28: the groove.
function groove(t0: number, t1: number, opts: { arp?: boolean; light?: boolean } = {}) {
  for (let t = t0; t < t1 - 1e-6; t += BEAT) {
    const inBar = ((t % 2) + 2) % 2;
    kick(t, opts.light ? 0.75 : 1);
    if (Math.abs(inBar - 0.5) < 1e-6 || Math.abs(inBar - 1.5) < 1e-6) clap(t, 0.85);
    hat(t + 0.25, 0.9, true, -0.15);
    for (let s = 0; s < 4; s++) hat(t + s * 0.125, s % 2 ? 0.55 : 0.8, false, 0.25);
    const ch = chordAt(t);
    bass(t + 0.25, ch[0] - 24, 0.22, 1);
    bass(t, ch[0] - 24, 0.2, 0.8);
    if (opts.arp !== false)
      for (let s = 0; s < 4; s++) {
        const step = Math.round((t - t0) / 0.125) + s;
        const pattern = [0, 1, 2, 1, 2, 0, 1, 2];
        const note = ch[pattern[step % 8]] + 12 + (step % 16 >= 12 ? 12 : 0);
        pluck(t + s * 0.125, note, opts.light ? 0.6 : 0.85, 0.75, s % 2 ? 0.35 : -0.35);
      }
  }
}
impact(6.0, 0.8);
groove(6.0, 28.0);
pad(6.0, 29.75, 1);
for (const t of [10, 12, 15, 19, 22.5, 26]) whoosh(t, 0.9);
// 28–30: feature words, a clap on every word, then a stop.
for (let t = 28; t < 29.75; t += 0.25) {
  kick(t, t % 0.5 === 0 ? 0.9 : 0.5);
  clap(t, 0.6 + (t - 28) * 0.2, 0.4);
  bass(t, chordAt(t)[0] - 24, 0.2, 0.9);
}
riser(28.0, 29.75, 1.1);
// 30: end card.
impact(30.0, 1.1);
pad(30.0, 35.5, 1.1, 1000);
for (let i = 0; i < 20; i++) {
  const t = 30 + i * 0.25;
  const ch = chordAt(t);
  pluck(t, ch[[0, 2, 1, 2][i % 4]] + 12, 0.55 * Math.max(0, 1 - i / 22), 0.5, i % 2 ? 0.4 : -0.4);
}

// ---------------------------------------------------------------- reverb
function reverb() {
  const combs = [1557, 1617, 1491, 1422, 1277, 1356].map((d) => ({ d: Math.round((d * SR) / 44100), buf: new Float32Array(Math.round((d * SR) / 44100) + 23), i: 0, lp: 0 }));
  const aps = [556, 441, 341].map((d) => ({ buf: new Float32Array(Math.round((d * SR) / 44100)), i: 0 }));
  for (let n = 0; n < N; n++) {
    let outL = 0, outR = 0;
    combs.forEach((c, k) => {
      const len = c.d + (k % 2 ? 23 : 0);
      const y = c.buf[c.i % len];
      c.lp = y * 0.7 + c.lp * 0.3;
      c.buf[c.i % len] = verbIn[n] * 0.5 + c.lp * 0.84;
      c.i++;
      if (k % 2) outR += y;
      else outL += y;
    });
    let mono = (outL + outR) * 0.5;
    for (const a of aps) {
      const b = a.buf[a.i];
      a.buf[a.i] = mono + b * 0.5;
      mono = b - mono * 0.5;
      a.i = (a.i + 1) % a.buf.length;
    }
    L[n] += (outL * 0.7 + mono * 0.3) * 0.12;
    R[n] += (outR * 0.7 + mono * 0.3) * 0.12;
  }
}
reverb();

// ---------------------------------------------------------------- dialogue cues + ducking
type Cue = { file: string; at: number; from?: number; dur?: number; gain?: number };
const cues: Cue[] = existsSync("launch/out/cues.json") ? JSON.parse(readFileSync("launch/out/cues.json", "utf8")) : [];
const dlg = new Float32Array(N);
for (const c of cues) {
  const raw = execFileSync("ffmpeg", ["-v", "error", ...(c.from ? ["-ss", String(c.from)] : []), ...(c.dur ? ["-t", String(c.dur)] : []), "-i", c.file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const pcm = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
  const fade = S(0.05);
  for (let i = 0; i < pcm.length; i++) {
    const g = Math.min(1, i / fade, (pcm.length - i) / fade) * (c.gain ?? 1);
    const j = S(c.at) + i;
    if (j < N) dlg[j] += pcm[i] * g;
  }
}
// Envelope follower on the dialogue drives the duck.
let env = 0;
for (let n = 0; n < N; n++) {
  const a = Math.abs(dlg[n]);
  env = a > env ? env + (a - env) * 0.01 : env * 0.99993;
  const duck = 1 - Math.min(0.72, env * 6);
  L[n] = L[n] * duck + dlg[n] * 0.95;
  R[n] = R[n] * duck + dlg[n] * 0.95;
}

// ---------------------------------------------------------------- master
const fadeOut = (t: number) => (t < 33.5 ? 1 : Math.max(0, 1 - (t - 33.5) / 2));
let peak = 0;
for (let n = 0; n < N; n++) {
  const f = fadeOut(n / SR);
  L[n] = Math.tanh(L[n] * 1.25) * f;
  R[n] = Math.tanh(R[n] * 1.25) * f;
  peak = Math.max(peak, Math.abs(L[n]), Math.abs(R[n]));
}
const norm = 0.89 / peak;
const out = Buffer.alloc(44 + N * 4);
out.write("RIFF", 0); out.writeUInt32LE(36 + N * 4, 4); out.write("WAVE", 8); out.write("fmt ", 12);
out.writeUInt32LE(16, 16); out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(SR, 24);
out.writeUInt32LE(SR * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34); out.write("data", 36); out.writeUInt32LE(N * 4, 40);
for (let n = 0; n < N; n++) {
  out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, L[n] * norm)) * 32767), 44 + n * 4);
  out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, R[n] * norm)) * 32767), 46 + n * 4);
}
writeFileSync("launch/out/soundtrack.wav", out);
console.log(`soundtrack.wav ${DUR}s, ${cues.length} dialogue cues`);
