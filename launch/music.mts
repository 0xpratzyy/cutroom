// Synthesizes the launch film's soundtrack (120 BPM, A minor) and mixes in the dialogue cues
// the compositor wrote (launch/out/cues.json), ducking the music under them.
// Usage: npx tsx launch/music.mts  ->  launch/out/soundtrack.wav
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SR = 48000;
const DUR = 38.5;
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

/** Cartoon spring: a sine that sags in pitch while it wobbles. */
function boing(t: number, gain = 1) {
  let ph = 0;
  for (let n = 0; n < S(0.45); n++) {
    const x = n / SR;
    const f = 140 + 260 * Math.exp(-x * 6) + Math.sin(x * 2 * Math.PI * 16) * 60 * Math.exp(-x * 5);
    ph += (2 * Math.PI * f) / SR;
    add(S(t) + n, Math.sin(ph) * Math.exp(-x * 7) * 0.38 * gain, 0, 0.1);
  }
}
/** Rubbery stretch: a rising, wobbling tone. */
function squeak(t: number, dur: number, gain = 1) {
  let ph = 0;
  for (let n = 0; n < S(dur); n++) {
    const u = n / S(dur), x = n / SR;
    const f = 260 + 700 * u * u + Math.sin(x * 2 * Math.PI * 9) * 30;
    ph += (2 * Math.PI * f) / SR;
    add(S(t) + n, (Math.sin(ph) * 0.6 + saw((ph / (2 * Math.PI)) % 1) * 0.15) * Math.min(1, u * 6) * 0.13 * gain, 0.1, 0.1);
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

// ---------------------------------------------------------------- arrangement (follows the story)
// 0–2.5 the prompt box fills up: a staccato bass line climbs a semitone every beat.
for (let b = 0; b < 5; b++) {
  const t = b * 0.5;
  for (const o of [0, 0.25]) bass(t + o, 45 + b, 0.12, 0.9);
  if (b >= 2) kick(t, 0.55);
  for (let s16 = 0; s16 < 4; s16++) hat(t + s16 * 0.125, b >= 3 ? 0.7 : 0.4, false, 0.2);
  pluck(t + 0.25, 69 + b, 0.45, 0.4, 0.3);
}
// 2.5–3.5 it bursts: silence (the pop and the falling letters are effects).
// 3.5–6 the pin arrives: a light bouncy groove, opening up into the drop.
pad(3.5, 6.0, 0.7, 900);
for (let t = 4.0; t < 6.0 - 1e-6; t += BEAT) {
  kick(t, 0.75);
  if (Math.abs(((t % 1) + 1) % 1 - 0.5) < 1e-6) clap(t, 0.7);
  hat(t + 0.25, 0.6, true, -0.15);
}
for (let i = 0; i < 16; i++) {
  const t = 4 + i * 0.125;
  pluck(t, chordAt(t)[i % 3] + 12, 0.6, 0.15 + (i / 16) * 0.85, i % 2 ? 0.3 : -0.3);
}
for (const t of [5.75, 5.875]) kick(t, 0.7);
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
// 6–31.25 the montage, the product, the before/after and the type ring.
groove(6.0, 31.0);
pad(6.0, 31.25, 1);
for (const t of [31.0, 31.125]) kick(t, 0.8);
// 31.5–35 the punchline lands in near silence: one sub hit on "0 timelines".
pad(31.5, 35.0, 0.45, 600);
kick(32.75, 1.1, true);
// 35–38.5 the end card.
impact(35.0, 0.8);
pad(35.0, 38.5, 1.1, 1000);
for (let i = 0; i < 12; i++) {
  const t = 35.25 + i * 0.25;
  pluck(t, chordAt(t)[[0, 2, 1, 2][i % 4]] + 12, 0.55 * Math.max(0, 1 - i / 14), 0.5, i % 2 ? 0.4 : -0.4);
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
// ---------------------------------------------------------------- cues: dialogue + sound effects
type Cue = { file: string; at: number; from?: number; dur?: number; gain?: number };
type Sfx = { name: string; at: number; gain?: number; dur?: number };
const cueFile = existsSync("launch/out/cues.json") ? JSON.parse(readFileSync("launch/out/cues.json", "utf8")) : {};
const dialogue: Cue[] = Array.isArray(cueFile) ? cueFile : (cueFile.dialogue ?? []);
const effects: Sfx[] = cueFile.sfx ?? [];
function decode(file: string, from?: number, dur?: number) {
  const raw = execFileSync("ffmpeg", ["-v", "error", ...(from ? ["-ss", String(from)] : []), ...(dur ? ["-t", String(dur)] : []), "-i", file, "-ac", "1", "-ar", String(SR), "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}
const dlg = new Float32Array(N);
for (const c of dialogue) {
  const pcm = decode(c.file, c.from, c.dur);
  const fade = S(0.05);
  for (let i = 0; i < pcm.length; i++) {
    const j = S(c.at) + i;
    if (j < N) dlg[j] += pcm[i] * Math.min(1, i / fade, (pcm.length - i) / fade) * (c.gain ?? 1);
  }
}
// Sound effects: ElevenLabs renders from launch/eleven.mts when present, synthesized otherwise.
const ELEVEN = "launch/out/eleven/sfx";
const sfxCache = new Map<string, Float32Array | null>();
const usedEleven = new Set<string>();
for (const e of effects) {
  const file = join(ELEVEN, `${e.name}.mp3`);
  if (!sfxCache.has(e.name)) sfxCache.set(e.name, existsSync(file) ? decode(file) : null);
  const pcm = sfxCache.get(e.name);
  const g = e.gain ?? 1;
  if (pcm) {
    usedEleven.add(e.name);
    const len = e.dur ? Math.min(pcm.length, S(e.dur)) : pcm.length;
    const fade = S(0.04);
    // Whooshes peak at their middle: lead in so the peak lands on the cut.
    const lead = e.name === "whoosh" ? Math.floor(len * 0.45) : 0;
    for (let i = 0; i < len; i++) {
      const v = pcm[i] * g * 0.8 * (e.dur ? Math.min(1, (len - i) / fade) : 1);
      add(S(e.at) - lead + i, v, 0, e.name === "chime" || e.name === "send" ? 0.25 : 0.1);
    }
  } else if (e.name === "whoosh") whoosh(e.at, g);
  else if (e.name === "impact") impact(e.at, g * 0.8);
  else if (e.name === "slam") (kick(e.at, 0.7 * g), clap(e.at, 0.8 * g, 0.4));
  else if (e.name === "riser") riser(e.at, e.at + 1.75, g);
  else if (e.name === "click") hat(e.at, 2.2 * g, false, 0);
  else if (e.name === "send") blip(e.at, 84, g);
  else if (e.name === "chime") (blip(e.at, 88, g), blip(e.at + 0.09, 95, g));
  else if (e.name === "mic") blip(e.at, 79, 0.6 * g);
  else if (e.name === "pop") (impact(e.at, 0.35 * g), blip(e.at, 72, 1.6 * g), clap(e.at, 1.2 * g, 0.3));
  else if (e.name === "boing") boing(e.at, g);
  else if (e.name === "plink") blip(e.at, 96, 1.1 * g);
  else if (e.name === "tick") blip(e.at, 100 + Math.round(Math.abs(rnd()) * 7), 0.5 * g);
  else if (e.name === "squeak") squeak(e.at, e.dur ?? 0.8, g);
  else if (e.name === "typing") for (let t = e.at; t < e.at + (e.dur ?? 1); t += 0.06 + Math.abs(rnd()) * 0.05) hat(t, 0.9 * g, false, rnd() * 0.3);
}
reverb();

// Dialogue ducks the music ~14 dB, with 30 ms of look-ahead.
let env = 0;
const look = S(0.03);
for (let n = 0; n < N; n++) {
  const a = Math.abs(dlg[Math.min(N - 1, n + look)]);
  env = a > env ? env + (a - env) * 0.02 : env * 0.99994;
  const duck = 1 - 0.8 * Math.min(1, env * 14);
  L[n] = L[n] * duck + dlg[n] * 1.1;
  R[n] = R[n] * duck + dlg[n] * 1.1;
}

// ---------------------------------------------------------------- master
const fadeOut = (t: number) => (t < 37.3 ? 1 : Math.max(0, 1 - (t - 37.3) / 1.2));
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
writeFileSync("launch/out/soundtrack-raw.wav", out);
// Master: two-pass loudness normalisation to -12 LUFS, true peak <= -2 dBFS (AAC adds ~1 dB).
const target = "I=-12:TP=-2:LRA=9";
const pass1 = spawnSync("ffmpeg", ["-hide_banner", "-i", "launch/out/soundtrack-raw.wav", "-af", `loudnorm=${target}:print_format=json`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
const m = JSON.parse(/\{[^{}]*"input_i"[^{}]*\}/.exec(pass1)![0]);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", "launch/out/soundtrack-raw.wav", "-af", `loudnorm=${target}:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}:linear=true,aresample=192000,alimiter=limit=0.72:level=false:attack=1:release=60,aresample=48000`, "-c:a", "pcm_s16le", "launch/out/soundtrack.wav"]);
console.log(`soundtrack.wav ${DUR}s · ${dialogue.length} dialogue cues · ${effects.length} effects (${usedEleven.size ? `ElevenLabs: ${[...usedEleven].join(", ")}` : "synthesized"}) · input ${m.input_i} LUFS`);
