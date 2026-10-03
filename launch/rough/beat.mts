// The high-energy beds for "Rough Cut": ElevenLabs Music, composed to the film's own timeline
// (cues.json) in two halves that meet at the film's stillness. Half one runs from the entry's cut to the
// stillness (impact, a sparse bed under the cold open, the groove from "That was Claude", the build);
// half two starts on the drop, so the drop lands on the bloom's first frame whatever the model does
// inside a section. A key and a tempo are named in both halves so they belong together.
// Generations are cached by their composition plan, so a re-run only pays for what changed.
// Key: ELEVENLABS_API_KEY in the environment, or in launch/.env.local (git-ignored).
// Usage: npx tsx launch/rough/beat.mts [--style=a|b]  ->  launch/out/rough/beat-<style>-{1,2}.wav + beat-<style>.json
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "launch/out/rough";
const CACHE = join(OUT, "beat-cache");
mkdirSync(CACHE, { recursive: true });
const style = process.argv.find((a) => a.startsWith("--style="))?.slice(8) ?? "a";
const cues = JSON.parse(readFileSync(join(OUT, "cues.json"), "utf8")) as { duration: number; sections: Record<string, number> };
const S = cues.sections;

function apiKey(): string {
  if (process.env.ELEVENLABS_API_KEY) return process.env.ELEVENLABS_API_KEY.trim();
  const f = "launch/.env.local";
  const m = existsSync(f) ? readFileSync(f, "utf8").match(/^\s*ELEVENLABS_API_KEY\s*=\s*["']?([^"'\s]+)/m) : null;
  if (m) return m[1];
  console.error("No ElevenLabs key. Put ELEVENLABS_API_KEY=... in launch/.env.local or the environment.");
  process.exit(2);
}

// Two directions for the same picture: (a) hybrid trap, heavy and cinematic; (b) bright electro house.
type Style = { global: string[]; avoid: string[]; parts: Record<string, string[]> };
const STYLES: Record<string, Style> = {
  a: {
    global: ["hard-hitting hybrid trap", "cinematic trailer energy", "modern tech product launch", "punchy 808s", "crisp trap hi-hats", "140 BPM", "F minor", "dark and confident", "instrumental"],
    avoid: ["vocals", "singing", "choir", "vocal chops", "lo-fi", "acoustic guitar", "cheesy"],
    parts: {
      impact: ["one huge cinematic impact hit on the very first beat", "deep sub boom", "short dark tail"],
      sparse: ["sparse but continuous", "sustained dark ambient pad throughout", "soft ticking hi-hats", "no kick drum", "quiet background bed for a voiceover"],
      groove: ["the full trap beat drops in on the first beat", "punchy snare", "rolling hi-hats", "gliding 808 bass", "confident head-nod groove"],
      build: ["tension build that keeps rising to the very last second", "accelerating snare roll", "rising synth riser", "filter sweep up", "maximum tension"],
      drop: ["starts immediately with a massive drop on the very first beat", "huge distorted 808s", "aggressive synth stabs", "braam hits", "peak energy"],
      breakdown: ["breakdown", "drums drop out", "dark pad and sub only", "quiet"],
      outro: ["the beat comes back for one last phrase", "ends on one huge final impact hit", "long decaying sub tail"],
    },
  },
  b: {
    global: ["high-energy electro house", "future bass", "modern tech product launch", "bright and bouncy", "128 BPM", "A minor", "punchy four-on-the-floor kick", "supersaw synths", "instrumental"],
    avoid: ["vocals", "singing", "vocal chops", "lo-fi", "acoustic", "orchestral", "cheesy"],
    parts: {
      impact: ["one bright synth impact chord on the very first beat", "sidechained swell", "short tail"],
      sparse: ["sparse but continuous", "only a filtered pluck arpeggio and a soft pad", "no drums", "quiet background bed for a voiceover"],
      groove: ["the full house beat drops in on the first beat", "punchy kick and clap", "bouncy bassline", "bright plucks", "driving and fun"],
      build: ["build-up that keeps rising to the very last second", "accelerating snare roll", "white noise riser", "pitch rising", "maximum tension"],
      drop: ["starts immediately with a euphoric drop on the very first beat", "huge supersaw chords", "heavy sidechain pumping", "big kick", "peak energy"],
      breakdown: ["breakdown", "kick out", "airy chords and plucks", "quiet"],
      outro: ["the groove returns for one last phrase", "ends on one big final chord hit", "reverb tail"],
    },
  },
};
const st = STYLES[style];
if (!st) throw new Error(`unknown style ${style}`);

/** Composes (or fetches from the cache) one half: its sections run back to back from `from`. */
async function compose(half: number, from: number, bounds: [string, number][], until: number) {
  const sections = bounds.map(([name, at], i) => {
    const to = i + 1 < bounds.length ? bounds[i + 1][1] : until;
    return { section_name: name, positive_local_styles: st.parts[name], negative_local_styles: ["vocals"], duration_ms: Math.round((to - at) * 1000), lines: [] as string[] };
  });
  for (const s of sections) if (s.duration_ms < 3000) throw new Error(`section ${s.section_name} is ${s.duration_ms} ms; the API wants at least 3 s`);
  const plan = { positive_global_styles: st.global, negative_global_styles: st.avoid, sections };
  const hash = createHash("sha1").update(JSON.stringify(plan)).digest("hex").slice(0, 16);
  const mp3 = join(CACHE, `${style}${half}-${hash}.mp3`);
  if (!existsSync(mp3)) {
    console.log(`composing ${style}${half}: ${sections.map((s) => `${s.section_name} ${(s.duration_ms / 1000).toFixed(1)}s`).join(" · ")}`);
    const body: Record<string, unknown> = { composition_plan: plan, model_id: "music_v1", respect_sections_durations: true };
    const send = () => fetch("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128", { method: "POST", headers: { "xi-api-key": apiKey(), "content-type": "application/json" }, body: JSON.stringify(body) });
    let res = await send();
    for (let attempt = 1; attempt <= 8 && (res.status === 429 || res.status >= 500 || res.status === 422 || res.status === 400); attempt++) {
      const msg = await res.text();
      if (res.status === 422 || res.status === 400) {
        // older API versions don't know the strict-durations flag
        if (!("respect_sections_durations" in body)) throw new Error(`music: ${res.status} ${msg}`);
        console.warn(`  retrying without respect_sections_durations (${res.status}: ${msg.slice(0, 160)})`);
        delete body.respect_sections_durations;
      } else {
        console.warn(`  ${res.status}, retrying in ${10 * attempt} s`);
        await new Promise((r) => setTimeout(r, 10000 * attempt));
      }
      res = await send();
    }
    if (!res.ok) throw new Error(`music: ${res.status} ${await res.text()}`);
    writeFileSync(mp3, Buffer.from(await res.arrayBuffer()));
  }
  const wav = join(OUT, `beat-${style}-${half}.wav`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", mp3, "-ac", "2", "-ar", "48000", "-c:a", "pcm_f32le", wav]);
  // a 10 ms energy envelope, for finding where the music actually starts hitting
  const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", mp3, "-ac", "1", "-ar", "8000", "-f", "f32le", "-"], { maxBuffer: 1 << 28 });
  const s = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
  const rms: number[] = [];
  for (let k = 0; k + 80 <= s.length; k += 80) {
    let e = 0;
    for (let j = k; j < k + 80; j++) e += s[j] * s[j];
    rms.push(Math.sqrt(e / 80));
  }
  return { wav, plan, from, duration: s.length / 8000, rms };
}
const db = (v: number) => 20 * Math.log10(v + 1e-9);
/** The first moment the track gets within 6 dB of its loudest second: where it really starts hitting. */
function firstHit(rms: number[], within: number) {
  let peak = 0;
  for (let i = 0; i + 100 <= Math.min(rms.length, within * 100 + 300); i++) {
    let e = 0;
    for (let j = i; j < i + 100; j++) e += rms[j];
    peak = Math.max(peak, e / 100);
  }
  for (let i = 0; i < Math.min(rms.length, within * 100); i++) if (db(rms[i]) > db(peak) - 6) return i / 100;
  return 0;
}

// Half one: from the entry's cut to the bloom. It's composed a few seconds into a drop it never plays,
// so the build rises all the way to the cut instead of winding down like the end of a track; the mix
// cuts it at the stillness.
const one = await compose(1, S.cutMark, [["impact", S.cutMark], ["sparse", S.cutMark + 3], ["groove", S.pass2], ["build", S.pass3], ["drop", S.bloom]], S.bloom + 4);
// Half two: from the bloom to past the last frame.
const two = await compose(2, S.bloom, [["drop", S.bloom], ["breakdown", S.review], ["outro", S.end]], cues.duration + 1.5);
// Half two is trimmed so its first real hit is the bloom's first frame (models like a short lead-in).
const trim2 = Math.min(2.5, firstHit(two.rms, 4));
const trim1 = Math.min(0.5, firstHit(one.rms, 1.5));
const out = {
  style,
  halves: [
    { file: one.wav, at: S.cutMark, trim: trim1, until: S.still, duration: one.duration, plan: one.plan },
    { file: two.wav, at: S.bloom, trim: trim2, duration: two.duration, plan: two.plan },
  ],
};
writeFileSync(join(OUT, `beat-${style}.json`), JSON.stringify(out, null, 1));
const env = (h: typeof one, a: number, b: number) => db(Math.sqrt(h.rms.slice(Math.round(a * 100), Math.round(b * 100)).reduce((p, v) => p + v * v, 0) / Math.max(1, Math.round((b - a) * 100))));
console.log(`beat-${style}: half 1 ${one.duration.toFixed(1)} s (first hit ${trim1.toFixed(2)} s), half 2 ${two.duration.toFixed(1)} s (first hit ${trim2.toFixed(2)} s)`);
console.log(`  half 1 by section: impact ${env(one, 0, 3).toFixed(1)} dB · sparse ${env(one, 3, S.pass2 - S.cutMark).toFixed(1)} · groove ${env(one, S.pass2 - S.cutMark, S.pass3 - S.cutMark).toFixed(1)} · build ${env(one, S.pass3 - S.cutMark, S.still - S.cutMark).toFixed(1)} (last 2 s ${env(one, S.still - S.cutMark - 2, S.still - S.cutMark).toFixed(1)}) · unused drop ${env(one, S.bloom - S.cutMark, one.duration).toFixed(1)}`);
console.log(`  half 2 by section: drop ${env(two, trim2, trim2 + S.review - S.bloom).toFixed(1)} dB · breakdown ${env(two, trim2 + S.review - S.bloom, trim2 + S.end - S.bloom).toFixed(1)} · outro ${env(two, trim2 + S.end - S.bloom, two.duration).toFixed(1)}`);
