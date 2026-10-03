// The high-energy mix of "Rough Cut": one of the narrator's reads (vo.mts), Reed's own sound whenever
// the film inside the film plays, the UI foley (music-rough.mts --sfx-only), a few designed hits, and
// one of the beats (beat.mts), shaped to the picture: filtered under the cold open and swept open into
// the groove, a riser into the stillness, digital silence through it, the drop on the bloom, ducked
// under every spoken word. Mastered to -14 LUFS, true peak under -1.5 dBFS, then muxed onto the picture.
// Usage: npx tsx launch/rough/mix.mts --take=a|b [--beat=a|b]  ->  launch/out/rough/cutroom-roughcut-<take>.mp4
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "launch/out/rough";
const SR = 48000;
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
const take = arg("take") ?? "a";
const beatStyle = arg("beat") ?? take;
const cues = JSON.parse(readFileSync(join(OUT, "cues.json"), "utf8")) as {
  duration: number;
  sections: Record<string, number>;
  vo: { id: string; at: number }[];
  sync: { src: string; from: number; len: number; at: number }[];
  sfx: { name: string; at: number; dur?: number; gain?: number }[];
  chimes: { at: number; midi: number }[];
  rewind: { from: number; to: number };
};
const S = cues.sections;
const vo = JSON.parse(readFileSync(join(OUT, `vo-${take}.json`), "utf8")) as { name: string; lines: Record<string, { file: string; words: { s: number; e: number }[] }> };
// each half sits on the film's clock by a named section (see beat.mts), so it survives re-timing
const beat = JSON.parse(readFileSync(join(OUT, `beat-${beatStyle}.json`), "utf8")) as { halves: { file: string; anchor: string; anchorAt: number; from?: string; until?: string }[] };
const N = Math.ceil((cues.duration + 0.05) * SR);
const L = new Float32Array(N), R = new Float32Array(N); // the final mix, pre-master
const db = (v: number) => 10 ** (v / 20);
const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const at = (t: number) => Math.round(t * SR);

// ---------------------------------------------------------------- reading audio
function decode(file: string, ch: 1 | 2, from = 0, len?: number): Float32Array[] {
  // fixed decimals: a float like 1.8e-15 reads as an invalid time to ffmpeg
  const args = ["-v", "error", ...(from > 1e-4 ? ["-ss", from.toFixed(4)] : []), "-i", file, ...(len ? ["-t", len.toFixed(4)] : []), "-vn", "-ac", String(ch), "-ar", String(SR), "-f", "f32le", "-"];
  const b = execFileSync("ffmpeg", args, { maxBuffer: 1 << 30 });
  const all = new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
  if (ch === 1) return [all];
  const l = new Float32Array(all.length / 2), r = new Float32Array(all.length / 2);
  for (let i = 0; i < l.length; i++) (l[i] = all[2 * i]), (r[i] = all[2 * i + 1]);
  return [l, r];
}
/** RMS of the louder half of 20 ms windows: a speech level that ignores the pauses. */
function activeRms(s: Float32Array) {
  const w = 960, v: number[] = [];
  for (let k = 0; k + w <= s.length; k += w) {
    let e = 0;
    for (let j = k; j < k + w; j++) e += s[j] * s[j];
    v.push(e / w);
  }
  v.sort((a, b) => b - a);
  const top = v.slice(0, Math.max(1, Math.floor(v.length / 2)));
  return Math.sqrt(top.reduce((a, b) => a + b, 0) / top.length);
}
/** Adds a mono or stereo clip at film time t, with gain and short edge fades (ms). */
function place(ch: Float32Array[], t: number, gain: number, fadeIn = 3, fadeOut = 3, pan = 0) {
  const o = at(t), n = ch[0].length, fi = Math.max(1, (fadeIn * SR) / 1000), fo = Math.max(1, (fadeOut * SR) / 1000);
  const gl = gain * Math.min(1, 1 - pan), gr = gain * Math.min(1, 1 + pan);
  for (let i = 0; i < n; i++) {
    const k = o + i;
    if (k < 0 || k >= N) continue;
    const e = Math.min(1, i / fi, (n - 1 - i) / fo);
    L[k] += ch[0][i] * gl * e;
    R[k] += (ch[1] ?? ch[0])[i] * gr * e;
  }
}

// ---------------------------------------------------------------- speech: the narrator and Reed
const speech = new Float32Array(N); // 1 while anyone speaks: drives the ducking
const mark = (t0: number, t1: number, v: number) => {
  for (let k = Math.max(0, at(t0)); k < Math.min(N, at(t1)); k++) speech[k] = Math.max(speech[k], v);
};
const stems = process.argv.includes("--stems");
const VO_RMS = db(-15);
for (const c of cues.vo) {
  const line = vo.lines[c.id];
  if (!line || c.at === undefined) continue;
  const [s] = decode(line.file, 1);
  // a high-pass at 90 Hz and a little presence keep a voice clear over 808s on a phone
  hp(s, 90);
  place([s], c.at, VO_RMS / activeRms(s), 2, 40);
  for (const w of line.words) mark(c.at + w.s - 0.06, c.at + w.e + 0.12, 1);
}
const SYNC_RMS = db(-14.5);
for (const c of cues.sync) {
  const [s] = decode(join(OUT, "states", `${c.src}.mp4`), 1, c.from, c.len);
  hp(s, 80);
  place([s], c.at, SYNC_RMS / activeRms(s), 6, 30);
  mark(c.at, c.at + c.len, 1);
}

// ---------------------------------------------------------------- filters
/** In-place one-pole-pair high-pass (12 dB/oct). */
function hp(s: Float32Array, f: number) {
  const a = Math.exp((-2 * Math.PI * f) / SR);
  for (let pass = 0; pass < 2; pass++) {
    let x1 = 0, y1 = 0;
    for (let i = 0; i < s.length; i++) {
      const y = a * (y1 + s[i] - x1);
      x1 = s[i];
      s[i] = y1 = y;
    }
  }
}
/** RBJ biquad low-pass with a cutoff that moves (cutoff(t) in Hz), stereo, in place. */
function sweepLowpass(ch: Float32Array[], t0: number, cutoff: (t: number) => number, q = 0.75) {
  for (const s of ch) {
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0;
    for (let i = 0; i < s.length; i++) {
      if (i % 32 === 0) {
        const f = Math.min(20000, Math.max(40, cutoff(t0 + i / SR)));
        const w = (2 * Math.PI * f) / SR, al = Math.sin(w) / (2 * q), cw = Math.cos(w), a0 = 1 + al;
        b0 = (1 - cw) / 2 / a0; b1 = (1 - cw) / a0; b2 = (1 - cw) / 2 / a0; a1 = (-2 * cw) / a0; a2 = (1 - al) / a0;
      }
      const x0 = s[i], y = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = x0; y2 = y1; y1 = y;
      s[i] = y;
    }
  }
}
/** Band-pass biquad whose centre moves, for risers and whooshes (mono, returns a new buffer). */
function sweepBandpass(s: Float32Array, centre: (u: number) => number, q: number) {
  const out = new Float32Array(s.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, b0 = 0, b2 = 0, a1 = 0, a2 = 0;
  for (let i = 0; i < s.length; i++) {
    if (i % 32 === 0) {
      const f = Math.min(18000, Math.max(60, centre(i / s.length)));
      const w = (2 * Math.PI * f) / SR, al = Math.sin(w) / (2 * q), a0 = 1 + al;
      b0 = al / a0; b2 = -al / a0; a1 = (-2 * Math.cos(w)) / a0; a2 = (1 - al) / a0;
    }
    const y = b0 * s[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = s[i]; y2 = y1; y1 = y;
    out[i] = y;
  }
  return out;
}
let seed = 11;
const noise = (n: number) => {
  const s = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    s[i] = seed / 2147483648 - 1;
  }
  return s;
};
const peakTo = (s: Float32Array, dbfs: number) => {
  let p = 0;
  for (const v of s) p = Math.max(p, Math.abs(v));
  const g = db(dbfs) / (p || 1);
  for (let i = 0; i < s.length; i++) s[i] *= g;
  return s;
};

// ---------------------------------------------------------------- the beat
// (with --stems, the speech placed so far is written out on its own for measuring)
if (stems) writeStem("speech", L, R);
const music = [new Float32Array(N), new Float32Array(N)];
for (const [i, h] of beat.halves.entries()) {
  const at0 = S[h.anchor] - h.anchorAt; // the film time of the track's first sample
  const start = Math.max(0, at0, h.from ? S[h.from] : at0);
  let until = Math.min(h.until ? S[h.until] : cues.duration + 1, cues.duration + 0.05);
  let [l, r] = decode(h.file, 2, start - at0, until - start);
  if (i === 0) {
    // if the model starts its drop before the stillness, cut half one just before that first hit
    const e = (a: number, b: number) => {
      let v = 0;
      for (let k = Math.max(0, a); k < Math.min(l.length, b); k++) v += l[k] * l[k] + r[k] * r[k];
      return v / Math.max(1, b - a);
    };
    for (let k = l.length - at(1.5); k < l.length - at(0.05); k += at(0.01)) {
      if (k < at(0.5)) continue;
      if (10 * Math.log10((e(k, k + at(0.05)) + 1e-12) / (e(k - at(0.4), k) + 1e-12)) > 6) {
        console.log(`  half one's drop starts early at ${(start + k / SR).toFixed(2)} s: cut there`);
        (l = l.slice(0, k - at(0.02))), (r = r.slice(0, k - at(0.02)));
        until = start + l.length / SR;
        break;
      }
    }
  }
  const o = at(start), fi = h.from ? at(0.02) : 96, fo = i === 0 ? 0.035 * SR : 0.6 * SR;
  for (let k = 0; k < l.length; k++) {
    if (o + k >= N) break;
    const e = Math.min(1, k / fi, (l.length - 1 - k) / fo);
    music[0][o + k] += l[k] * e;
    music[1][o + k] += r[k] * e;
  }
}
// Level: the loudest stretch of the beat sits at -11 dBFS RMS before the duck.
{
  let best = 0;
  for (let k = 0; k + SR <= N; k += SR / 4) {
    let e = 0;
    for (let j = k; j < k + SR; j++) e += music[0][j] * music[0][j] + music[1][j] * music[1][j];
    best = Math.max(best, Math.sqrt(e / (2 * SR)));
  }
  const g = db(-11) / (best || 1);
  for (const s of music) for (let k = 0; k < N; k++) s[k] *= g;
}
// Shape: muffled under the cold open and the first note, swept open over Claude's first turn and the
// rewind, so the groove arrives with "Hey, I'm Reed".
const ln = Math.log;
const cutoff = (t: number) => {
  const open = 20000, shut = 650;
  if (t < S.turn1) return shut;
  if (t < S.pass2) return Math.exp(ln(shut) + (ln(open) - ln(shut)) * clamp((t - S.turn1) / (S.pass2 - S.turn1)) ** 2);
  return open;
};
sweepLowpass(music, 0, cutoff);
// Ducking: a smoothed gain from the speech track, with a little look-ahead; speech-free parts of the
// muffled opening also sit lower, so the hits read as hits.
{
  const look = at(0.08), attack = Math.exp(-1 / (0.03 * SR)), release = Math.exp(-1 / (0.28 * SR));
  let g = 0;
  for (let k = 0; k < N; k++) {
    const target = speech[Math.min(N - 1, k + look)];
    g = target > g ? target + (g - target) * attack : target + (g - target) * release;
    const t = k / SR;
    let gain = db(-10.5 * g);
    if (t >= S.still - 0.02 && t < S.bloom) gain *= clamp((S.still - t) / 0.02) + clamp((t - (S.bloom - 0.005)) / 0.005); // digital silence
    music[0][k] *= gain;
    music[1][k] *= gain;
  }
}
for (let k = 0; k < N; k++) (L[k] += music[0][k]), (R[k] += music[1][k]);
if (stems) writeStem("music", music[0], music[1]);

// ---------------------------------------------------------------- designed sounds
const SFX: Record<string, (dur?: number) => Float32Array[]> = {
  // the pin landing: a soft round pop
  pin: () => {
    const n = at(0.35), s = new Float32Array(n);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const t = i / SR, f = 90 + 110 * Math.exp(-t / 0.03);
      ph += (2 * Math.PI * f) / SR;
      s[i] = Math.sin(ph) * Math.exp(-t / 0.09) + (i < 240 ? (noise(1)[0] * (1 - i / 240)) * 0.3 : 0);
    }
    return [peakTo(s, -9)];
  },
  // the cut: a bright metallic shing on a crisp transient
  slice: () => {
    const n = at(0.6), s = new Float32Array(n), nz = noise(n);
    hp(nz, 3000);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      const ring = [3150, 4730, 6310, 8420].reduce((a, f, j) => a + Math.sin(2 * Math.PI * f * t + j) * Math.exp(-t / (0.16 - j * 0.025)), 0) / 4;
      s[i] = nz[i] * Math.exp(-t / 0.018) * 0.9 + ring * 0.7 + Math.sin(2 * Math.PI * (2600 + 5000 * Math.exp(-t / 0.03)) * t) * Math.exp(-t / 0.05) * 0.4;
    }
    return [peakTo(s, -8)];
  },
  // the flight through the mark: air that rises and is cut off as the take fills the frame
  whoosh: (dur = 0.6) => {
    const n = at(dur + 0.08), chs: Float32Array[] = [];
    for (let c = 0; c < 2; c++) {
      const b = sweepBandpass(noise(n), (u) => 250 * 18 ** Math.min(1, u * 1.1), 1.6);
      for (let i = 0; i < n; i++) {
        const u = i / at(dur);
        b[i] *= (u < 1 ? u ** 2.2 : Math.exp(-(i - at(dur)) / (0.012 * SR)));
      }
      chs.push(b);
    }
    const p = Math.max(...chs.map((c) => c.reduce((a, v) => Math.max(a, Math.abs(v)), 0)));
    for (const c of chs) for (let i = 0; i < c.length; i++) c[i] *= db(-10) / p;
    return chs;
  },
  // the take pausing: a dry muted knock
  pause: () => {
    const n = at(0.12), s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      s[i] = Math.sin(2 * Math.PI * (210 + 140 * Math.exp(-t / 0.01)) * t) * Math.exp(-t / 0.025);
    }
    return [peakTo(s, -14)];
  },
};
const impact = (len: number, peak: number) => {
  // a sub boom with a short noisy front: the drop's downbeat and the last frame's full stop
  const n = at(len), l = new Float32Array(n), r = new Float32Array(n), nl = noise(n), nr = noise(n);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, f = 42 + 58 * Math.exp(-t / 0.06);
    ph += (2 * Math.PI * f) / SR;
    const sub = Math.sin(ph) * Math.exp(-t / (len * 0.35));
    l[i] = sub + nl[i] * 0.35 * Math.exp(-t / 0.04);
    r[i] = sub + nr[i] * 0.35 * Math.exp(-t / 0.04);
  }
  let p = 0;
  for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(l[i]), Math.abs(r[i]));
  for (let i = 0; i < n; i++) (l[i] *= db(peak) / p), (r[i] *= db(peak) / p);
  return [l, r];
};
for (const e of cues.sfx) {
  const make = SFX[e.name];
  if (!make) continue;
  place(make(e.dur), e.at, e.gain ?? 1, 1, 10);
}
// Claude at work on note 1: a ticking clock on the beat's tempo, so the first turn isn't a hole; it
// gives way to the groove at the rewind
{
  const bpm = beatStyle === "a" ? 140 : 128, step = 60 / bpm / 4;
  const t0 = S.working1, t1 = cues.rewind.from + 0.3;
  for (let t = t0, k = 0; t < t1; t += step, k++) {
    const n = at(0.05), s = noise(n);
    hp(s, 6000);
    const accent = k % 4 === 0 ? 1 : 0.45, fade = Math.min(1, (t - t0) / 0.6, (t1 - t) / 0.5);
    for (let i = 0; i < n; i++) s[i] *= Math.exp(-i / (0.008 * SR)) * accent;
    place([peakTo(s, -21)], t, Math.max(0, fade), 1, 5, k % 2 ? 0.25 : -0.25);
    if (k % 4 === 0) {
      const m = at(0.25), b = new Float32Array(m);
      for (let i = 0; i < m; i++) b[i] = Math.sin(2 * Math.PI * (55 + 40 * Math.exp(-i / (0.02 * SR))) * (i / SR)) * Math.exp(-i / (0.07 * SR));
      place([peakTo(b, -17)], t, Math.max(0, fade), 1, 20);
    }
  }
}
// the riser: from the end of the third note into the stillness, then nothing
{
  const t0 = S.turn3 + 0.3, t1 = S.still, n = at(t1 - t0);
  for (let c = 0; c < 2; c++) {
    const b = sweepBandpass(noise(n), (u) => 300 * 30 ** (u ** 1.5), 2.2);
    let ph = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n;
      ph += (2 * Math.PI * (180 * 4 ** (u ** 1.3))) / SR;
      b[i] = (b[i] * 1.0 + Math.sin(ph + c) * 0.18) * u ** 2.4;
    }
    peakTo(b, -11);
    place(c === 0 ? [b, new Float32Array(n)] : [new Float32Array(n), b], t0, 1, 50, 4);
  }
}
place(impact(1.6, -4), S.bloom, 1, 1, 200); // the drop
place(impact(1.3, -7), S.pause1, 1, 1, 200); // the take freezes and the film begins
place(impact(2.4, -5), S.exit + 1.2, 1, 1, 400); // the last cut
// the rewind: a tape chattering backwards, under the picture's own rewind
{
  const t0 = cues.rewind.from, n = at(cues.rewind.to - cues.rewind.from);
  const b = sweepBandpass(noise(n), (u) => 1800 * 3 ** Math.sin(Math.PI * u), 3);
  for (let i = 0; i < n; i++) {
    const u = i / n;
    b[i] *= Math.sin(Math.PI * u) * (0.6 + 0.4 * Math.sin(2 * Math.PI * (28 + 40 * u) * (i / SR)));
  }
  place([peakTo(b, -18)], t0, 1, 20, 20);
}
// Claude's chimes: two short high notes, an interval that sits on any key's tonic and fifth
{
  const base = beatStyle === "a" ? 1396.9 : 1760;
  for (const c of cues.chimes) {
    const n = at(0.5), s = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const t = i / SR;
      s[i] = (Math.sin(2 * Math.PI * base * t) + 0.6 * Math.sin(2 * Math.PI * base * 1.5 * t) * (t > 0.06 ? 1 : 0)) * Math.exp(-t / 0.12);
    }
    place([peakTo(s, -20)], c.at, 1, 1, 30);
  }
}
// the UI foley (clicks, keys, tocks, fold, breath), pulled down a touch on the breath
if (existsSync(join(OUT, "foley.wav"))) {
  const [l, r] = decode(join(OUT, "foley.wav"), 2);
  const breath = cues.sfx.find((e) => e.name === "breath");
  for (let k = 0; k < Math.min(N, l.length); k++) {
    const t = k / SR, g = breath && t >= breath.at && t < breath.at + (breath.dur ?? 1.5) + 0.2 ? db(-9) : db(1);
    L[k] += l[k] * g;
    R[k] += r[k] * g;
  }
}

// ---------------------------------------------------------------- master and mux
function writeStem(name: string, l: Float32Array, r: Float32Array) {
  const h = Buffer.alloc(44), n = l.length;
  h.write("RIFF", 0); h.writeUInt32LE(36 + n * 8, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34); h.write("data", 36); h.writeUInt32LE(n * 8, 40);
  const d = new Float32Array(n * 2);
  for (let k = 0; k < n; k++) (d[2 * k] = l[k]), (d[2 * k + 1] = r[k]);
  writeFileSync(join(OUT, `stem-${take}-${name}.wav`), Buffer.concat([h, Buffer.from(d.buffer)]));
}
function writeWav(file: string) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + N * 8, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(2, 22); h.writeUInt32LE(SR, 24);
  h.writeUInt32LE(SR * 8, 28); h.writeUInt16LE(8, 32); h.writeUInt16LE(32, 34); h.write("data", 36); h.writeUInt32LE(N * 8, 40);
  const d = new Float32Array(N * 2);
  for (let k = 0; k < N; k++) (d[2 * k] = L[k]), (d[2 * k + 1] = R[k]);
  writeFileSync(file, Buffer.concat([h, Buffer.from(d.buffer)]));
}
const raw = join(OUT, `mix-${take}-raw.wav`), wav = join(OUT, `soundtrack-${take}.wav`);
writeWav(raw);
// a transparent limiter catches the hits, then loudnorm (two passes, linear) sets -14 LUFS
const pre = "alimiter=limit=0.5:level=disabled:attack=3:release=60:asc=1";
const m = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", raw, "-af", `${pre},loudnorm=I=-14:TP=-1.5:LRA=18:print_format=json`, "-f", "null", "-"], { encoding: "utf8" }).stderr;
const j = JSON.parse(m.slice(m.lastIndexOf("{"), m.lastIndexOf("}") + 1));
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-af", `${pre},loudnorm=I=-14:TP=-1.5:LRA=18:linear=true:measured_I=${j.input_i}:measured_TP=${j.input_tp}:measured_LRA=${j.input_lra}:measured_thresh=${j.input_thresh}:offset=${j.target_offset},aresample=${SR}`, "-c:a", "pcm_s24le", wav]);
const ebu = spawnSync("ffmpeg", ["-hide_banner", "-nostats", "-i", wav, "-af", "ebur128=peak=true", "-f", "null", "-"], { encoding: "utf8" }).stderr;
const I = ebu.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop(), TP = ebu.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.pop(), LRA = ebu.match(/LRA:\s+(-?[\d.]+) LU/g)?.pop();
console.log(`soundtrack-${take}.wav (${vo.name} + beat ${beatStyle}): ${I} · true ${TP} · ${LRA}`);
if (process.argv.includes("--no-mux")) process.exit(0);
const mp4 = join(OUT, `cutroom-roughcut-${take}.mp4`);
execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(OUT, "film-video.mp4"), "-i", wav, "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-b:a", "256k", "-shortest", "-movflags", "+faststart", mp4]);
console.log(mp4);
