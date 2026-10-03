// The narrator for "Rough Cut": ElevenLabs text-to-speech, one file per line. Each request carries
// its neighbouring lines as context so the takes join up into one read. Takes are cached by content
// (voice, model, settings, text), so a re-run only pays for what changed.
// Key: ELEVENLABS_API_KEY in the environment, or in launch/.env.local (git-ignored).
// Usage: npx tsx launch/rough/vo.mts [--take=a|b|calm]  ->  launch/out/rough/vo/<take>/<line>.wav + vo-<take>.json
//        npx tsx launch/rough/vo.mts --audition          ->  launch/out/rough/vo/auditions.mp4
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts } from "@napi-rs/canvas";

const OUT = "launch/out/rough/vo";
const CACHE = join(OUT, "cache");
mkdirSync(CACHE, { recursive: true });
const arg = (k: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);

// What the narrator says, in film order. `say` is the spelling the voice reads, when it differs.
export const LINES: { id: string; text: string; say?: string }[] = [
  { id: "launch", text: "That's our launch film." },
  { id: "rough", text: "We know." },
  { id: "notes", text: "Nobody here wants to open a timeline. So we leave a note." },
  { id: "claude", text: "We didn't do that. Claude did." },
  { id: "what", text: "cutroom is a video editor Claude can drive. Over MCP, for the nerds.", say: "Cutroom is a video editor Claude can drive. Over MCP, for the nerds." },
  { id: "point", text: "Draw a box. Use your words." },
  { id: "ask", text: "Or just ask. Nicely." },
  { id: "three", text: "Three notes. No timelines were harmed." },
  { id: "review", text: "Review it like a pull request. For your face." },
  // the tour: the editor's other tools, one line per shot
  { id: "tPalette", text: "Oh, and it's a real editor." },
  { id: "tFillers", text: "All those ums? Gone." },
  { id: "tZoom", text: "Punch in. For drama." },
  { id: "tCaptions", text: "Captions, in eight flavors." },
  { id: "tLooks", text: "Make it moody." },
  { id: "tHook", text: "Add a hook, so nobody scrolls past." },
  { id: "tSound", text: "Studio sound. No studio." },
  { id: "tBroll", text: "B-roll. Or picture-in-picture." },
  { id: "tVoice", text: "Too lazy to type? Just say it." },
  { id: "tExport", text: "Export tall, square, or to Resolve, if you must." },
  { id: "name", text: "cutroom.", say: "Cutroom." },
  { id: "tagline", text: "Point at it. Claude fixes it." },
  { id: "turn", text: "Your turn. Go make something rough." },
];

// The reads: two lively, dry ones (the film's options) and the calm one it started with.
type Settings = Record<string, number | boolean>;
export const TAKES: Record<string, { name: string; voice: string; model: string; settings: Settings; tempo?: number }> = {
  // dry and conversational: low stability lets the read wander like a person's would
  // v4 ignores `speed`, so `tempo` tightens the read afterwards (a pitch-preserving stretch)
  a: { name: "Chris", voice: "iP95p4xoKVk53GoZ742B", model: "eleven_v4", settings: { stability: 0.3, similarity_boost: 0.85 }, tempo: 1.07 },
  b: { name: "Laura", voice: "FGY2WhTYpPnrIDTdsKH5", model: "eleven_v4", settings: { stability: 0.3, similarity_boost: 0.85 }, tempo: 1.07 },
  calm: { name: "Marcus K", voice: "3H55HGnNE1XjYxigHSAS", model: "eleven_multilingual_v2", settings: { stability: 0.5, similarity_boost: 0.8, style: 0.15, use_speaker_boost: true, speed: 0.95 } },
};
const TAKE = arg("take") ?? "a";

function apiKey(): string {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const f = "launch/.env.local";
  const m = existsSync(f) ? readFileSync(f, "utf8").match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/m) : null;
  if (m) return m[1];
  console.error("No ElevenLabs key. Put ELEVENLABS_API_KEY=... in launch/.env.local or the environment.");
  process.exit(2);
}
const KEY = apiKey();

type Timed = { w: string; s: number; e: number };
/** One take as 48 kHz mono float WAV plus its word timings, from the cache when it's there. */
async function take(voice: string, model: string, i: number, lines = LINES, settings: Settings = TAKES.calm.settings): Promise<{ wav: string; words: Timed[] }> {
  const line = lines[i];
  const text = line.say ?? line.text;
  const ctx = (k: number) => (lines[k] ? (lines[k].say ?? lines[k].text) : undefined);
  const body: Record<string, unknown> = { text, model_id: model, voice_settings: settings, seed: 7 };
  // Context stitching keeps the read continuous across separate requests (not every model takes it).
  if (model === "eleven_multilingual_v2") Object.assign(body, { previous_text: ctx(i - 1), next_text: ctx(i + 1) });
  const hash = createHash("sha1").update(JSON.stringify([voice, body, "ts"])).digest("hex").slice(0, 16);
  const wav = join(CACHE, `${hash}.wav`), align = join(CACHE, `${hash}.json`);
  if (!existsSync(wav) || !existsSync(align)) {
    // Lossless PCM where the plan allows it, else the best MP3 every plan gets; the timestamps
    // endpoint gives each character's time, so the film can put words on screen as they're said.
    let done = false;
    for (const format of formats.slice()) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice}/with-timestamps?output_format=${format}`, {
        method: "POST",
        headers: { "xi-api-key": KEY, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 403 && formats.length > 1) {
        formats.shift();
        continue;
      }
      if (!res.ok) throw new Error(`${line.id}: ${res.status} ${await res.text()}`);
      const j = (await res.json()) as { audio_base64: string; alignment: { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] } };
      const raw = join(CACHE, `${hash}.${format.startsWith("pcm") ? "pcm" : "mp3"}`);
      writeFileSync(raw, Buffer.from(j.audio_base64, "base64"));
      const input = format.startsWith("pcm") ? ["-f", "s16le", "-ar", format.split("_")[1], "-ac", "1", "-i", raw] : ["-i", raw];
      execFileSync("ffmpeg", ["-v", "error", "-y", ...input, "-ac", "1", "-ar", "48000", "-c:a", "pcm_f32le", wav]);
      writeFileSync(align, JSON.stringify(j.alignment));
      console.log(`  ${line.id} (${format}): "${text}"`);
      done = true;
      break;
    }
    if (!done) throw new Error("no output format available");
  }
  const a = JSON.parse(readFileSync(align, "utf8")) as { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
  const words: Timed[] = [];
  let cur: Timed | null = null;
  a.characters.forEach((ch, k) => {
    if (/\s/.test(ch)) return void (cur = null);
    if (!cur) words.push((cur = { w: "", s: a.character_start_times_seconds[k], e: a.character_end_times_seconds[k] }));
    cur.w += ch;
    // a word ends with its last letter: the aligner stretches trailing punctuation to the end of the file
    if (/[\p{L}\p{N}']/u.test(ch)) cur.e = a.character_end_times_seconds[k];
  });
  return { wav, words };
}
const formats = ["pcm_44100", "mp3_44100_128"];

/** Reads a mono float WAV (ffmpeg's layout: 44-byte header, or a longer one with a 'data' chunk). */
function readWav(file: string): Float32Array {
  const b = readFileSync(file);
  let off = 12;
  while (off < b.length - 8) {
    const id = b.toString("ascii", off, off + 4), size = b.readUInt32LE(off + 4);
    if (id === "data") return new Float32Array(b.buffer.slice(b.byteOffset + off + 8, b.byteOffset + off + 8 + size));
    off += 8 + size + (size & 1);
  }
  throw new Error(`no data chunk in ${file}`);
}
function writeWav(file: string, s: Float32Array) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + s.length * 4, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(3, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(48000, 24);
  h.writeUInt32LE(48000 * 4, 28); h.writeUInt16LE(4, 32); h.writeUInt16LE(32, 34); h.write("data", 36); h.writeUInt32LE(s.length * 4, 40);
  writeFileSync(file, Buffer.concat([h, Buffer.from(s.buffer, s.byteOffset, s.length * 4)]));
}
/** Trims the take to its speech: 60 ms before the first syllable, 160 ms after the last, with short
 *  fades. "Speech" is anything within 38 dB of the take's loudest 10 ms, so soft consonants survive. */
function trim(s: Float32Array) {
  const win = 480, hop = 240;
  const rms: number[] = [];
  for (let k = 0; k + win <= s.length; k += hop) {
    let e = 0;
    for (let j = k; j < k + win; j++) e += s[j] * s[j];
    rms.push(Math.sqrt(e / win));
  }
  const th = Math.max(Math.max(...rms) * 10 ** (-38 / 20), 10 ** (-62 / 20));
  const first = rms.findIndex((r) => r > th);
  let last = rms.length - 1;
  while (last > first && rms[last] <= th) last--;
  const a = Math.max(0, first * hop - 2880), b = Math.min(s.length, last * hop + win + 7680);
  const out = s.slice(a, b);
  const fi = 240, fo = 2880;
  for (let j = 0; j < fi && j < out.length; j++) out[j] *= j / fi;
  for (let j = 0; j < fo && j < out.length; j++) out[out.length - 1 - j] *= j / fo;
  return { out, from: a / 48000 };
}

if (process.argv.includes("--audition")) {
  // The same four lines in a few voices, as one labelled video to listen through.
  const cast: [string, string, string][] = [
    ["3H55HGnNE1XjYxigHSAS", "Marcus K", "calm documentary narrator"],
    ["CwhRBWXzGAHq8TQ4Fs17", "Roger", "laid-back, resonant"],
    ["pFZP5JQG7iQjIQuC4Bku", "Lily", "velvety, British"],
    ["hpp4J3VqNfWAUOO0d1Us", "Bella", "bright, warm, American"],
    ["1Mx54eW85zYpnx1WfIdU", "Mason", "warm documentary narrator"],
  ];
  const sample = [0, 1, 3, 10].map((k) => LINES[k]);
  const parts: string[] = [];
  for (const [k, [id, name, desc]] of cast.entries()) {
    console.log(`${k + 1}. ${name}`);
    const takes = [];
    for (let i = 0; i < sample.length; i++) takes.push(trim(readWav((await take(id, TAKES.calm.model, i, sample)).wav)).out);
    const gap = new Float32Array(48000 * 0.55);
    const all = takes.flatMap((t, i) => (i ? [gap, t] : [t]));
    const pad = new Float32Array(48000 * 0.6);
    const s = new Float32Array([...pad, ...all.flatMap((a) => [...a]), ...pad]);
    const wav = join(OUT, `audition-${k + 1}.wav`);
    writeWav(wav, s);
    const mp4 = join(OUT, `audition-${k + 1}.mp4`);
    // ffmpeg here has no drawtext, so the label is a canvas card
    GlobalFonts.registerFromPath("/System/Library/Fonts/SFNS.ttf", "SF");
    const card = createCanvas(1280, 720), c = card.getContext("2d");
    c.fillStyle = "#0d0d0f";
    c.fillRect(0, 0, 1280, 720);
    c.textAlign = "center";
    c.fillStyle = "#f4f2ef";
    c.font = "600 64px SF";
    c.fillText(`${k + 1}  ·  ${name}`, 640, 350);
    c.fillStyle = "#8d8983";
    c.font = "500 34px SF";
    c.fillText(desc, 640, 410);
    const png = join(OUT, `audition-${k + 1}.png`);
    writeFileSync(png, card.toBuffer("image/png"));
    execFileSync("ffmpeg", ["-v", "error", "-y", "-loop", "1", "-r", "30", "-i", png, "-i", wav, "-c:v", "libx264", "-tune", "stillimage", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-shortest", mp4]);
    parts.push(mp4);
  }
  const list = join(OUT, "auditions.txt");
  writeFileSync(list, parts.map((p) => `file '${p.split("/").pop()}'`).join("\n"));
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", join(OUT, "auditions.mp4")]);
  console.log(join(OUT, "auditions.mp4"));
  process.exit(0);
}

const cfg = TAKES[TAKE];
if (!cfg) throw new Error(`unknown take ${TAKE}: ${Object.keys(TAKES).join(", ")}`);
const dir = join(OUT, TAKE);
mkdirSync(dir, { recursive: true });
console.log(`take ${TAKE}: ${cfg.name} · ${cfg.model}`);
const manifest: { take: string; name: string; voice: string; model: string; lines: Record<string, { file: string; dur: number; lead: number; end: number; text: string; words: Timed[] }> } = { take: TAKE, name: cfg.name, voice: cfg.voice, model: cfg.model, lines: {} };
for (let i = 0; i < LINES.length; i++) {
  const t = await take(cfg.voice, cfg.model, i, LINES, cfg.settings);
  const tempo = cfg.tempo ?? 1;
  let wav = t.wav;
  if (tempo !== 1) {
    wav = t.wav.replace(/\.wav$/, `-x${tempo}.wav`);
    if (!existsSync(wav)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", t.wav, "-af", `atempo=${tempo}`, "-c:a", "pcm_f32le", wav]);
    t.words = t.words.map((w) => ({ ...w, s: w.s / tempo, e: w.e / tempo }));
  }
  const { out, from } = trim(readWav(wav));
  const file = join(dir, `${LINES[i].id}.wav`);
  writeWav(file, out);
  const r3 = (v: number) => Math.round(v * 1000) / 1000;
  const words = t.words.map((w) => ({ w: w.w, s: r3(w.s - from), e: r3(w.e - from) }));
  manifest.lines[LINES[i].id] = { file, dur: r3(out.length / 48000), lead: words[0]?.s ?? 0, end: words.at(-1)?.e ?? r3(out.length / 48000), text: LINES[i].text, words };
}
writeFileSync(join(OUT, `../vo-${TAKE}.json`), JSON.stringify(manifest, null, 1));
console.log(Object.entries(manifest.lines).map(([k, v]) => `${k} ${v.end.toFixed(2)}/${v.dur.toFixed(2)} s`).join(" · "));
