// Generates the launch film's voices and sound effects with ElevenLabs.
// Key: ELEVENLABS_API_KEY in the environment, or in launch/.env.local (git-ignored).
// Usage: npx tsx launch/eleven.mts [--force]  ->  launch/out/eleven/{speaker,voicenote}.mp3, sfx/*.mp3
// Without a key the other scripts fall back to macOS `say` and synthesized effects.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "launch/out/eleven";
mkdirSync(join(OUT, "sfx"), { recursive: true });
const force = process.argv.includes("--force");

function apiKey(): string {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const f = "launch/.env.local";
  if (existsSync(f)) {
    const m = readFileSync(f, "utf8").match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/m);
    if (m) return m[1];
  }
  console.error("No ElevenLabs key. Put ELEVENLABS_API_KEY=... in launch/.env.local or the environment.");
  process.exit(2);
}
const KEY = apiKey();

async function post(path: string, body: unknown, file: string) {
  if (existsSync(file) && !force) return console.log("have", file);
  const res = await fetch(`https://api.elevenlabs.io${path}`, {
    method: "POST",
    headers: { "xi-api-key": KEY, "content-type": "application/json", accept: "audio/mpeg" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  console.log("wrote", file);
}

// Premade voices available on every account.
const VOICES = { presenter: "TX3LPaxmHKxFdv7VOQHJ" /* Liam: young, articulate */, note: "EXAVITQu4vr4xnJBP1Gg" /* Sarah: warm, clear */ };
const tts = (voice: string, text: string, file: string, settings: Record<string, number | boolean>) =>
  post(`/v1/text-to-speech/${voice}?output_format=mp3_44100_128`, { text, model_id: "eleven_multilingual_v2", voice_settings: settings }, file);

// The presenter's take keeps a filler and a false start: that's what Claude cuts in the film.
await tts(
  VOICES.presenter,
  `Hey, I'm Reed. <break time="0.4s" /> Umm, today I wanna show you something cool. <break time="0.7s" /> So the idea is... <break time="0.6s" /> so the idea is really simple. <break time="0.3s" /> You point at what's wrong, and the AI just fixes it. <break time="0.5s" /> Let's go.`,
  join(OUT, "speaker.mp3"),
  { stability: 0.4, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true },
);
await tts(VOICES.note, "Make the captions pop.", join(OUT, "voicenote.mp3"), { stability: 0.5, similarity_boost: 0.8, style: 0.2, use_speaker_boost: true });

const SFX: Record<string, [string, number]> = {
  whoosh: ["fast clean cinematic whoosh transition, airy swish, no reverb tail", 0.7],
  impact: ["deep cinematic impact hit with sub bass boom, trailer style, short", 2.0],
  slam: ["punchy tight percussive slam hit for a title card, modern, dry", 0.6],
  click: ["single crisp mouse click, modern trackpad click, close mic, dry", 0.3],
  typing: ["fast soft typing on a modern laptop keyboard, close mic, dry, continuous", 2.5],
  send: ["short soft UI pop for a message sent, bubbly, pleasant", 0.5],
  chime: ["short bright success chime, modern app notification, two notes rising", 1.0],
  riser: ["tension riser building up, white noise sweep and rising synth, ends abruptly", 2.0],
  mic: ["soft UI tick for a microphone starting to record, subtle", 0.4],
  pop: ["balloon pop, crisp and loud, cartoon, dry", 0.6],
  boing: ["cartoon spring boing, bouncy, playful, short", 0.7],
  plink: ["single bright plink, glockenspiel note, short, dry", 0.4],
  tick: ["tiny soft tick, letter landing, very short, dry", 0.2],
  squeak: ["rubber stretching squeak rising in pitch, cartoon tension", 1.2],
};
for (const [name, [text, dur]] of Object.entries(SFX)) {
  await post("/v1/sound-generation", { text, duration_seconds: dur, prompt_influence: 0.6 }, join(OUT, "sfx", `${name}.mp3`));
}
console.log("ElevenLabs assets ready in", OUT);
