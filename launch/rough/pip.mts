// Reed's picture-in-picture lines: after "...and Claude fixes it" he stays on in a bubble and walks
// through the rest of cutroom himself. The clips are Grok takes of him saying the lines (pip-1..4.mp4,
// from launch/out/rough/pip/brief.txt); this transcribes them with word timings and finds where each
// line starts and ends, so the film can cut his bubble line by line.
// Usage: npx tsx launch/rough/pip.mts  ->  launch/out/rough/pip.json
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = "launch/out/rough";
const DIR = join(OUT, "pip");
// What Reed says, clip by clip, in film order. Ids: r + the beat the line plays over.
export const PIP_SCRIPT: { clip: string; lines: [string, string][] }[] = [
  { clip: "pip-1.mp4", lines: [["rThree", "Yeah, that was three notes. I never opened a timeline."], ["rReview", "And it's literally a pull request for my face."], ["rPalette", "Oh, and it's a real editor."]] },
  { clip: "pip-2.mp4", lines: [["rFillers", "It kills the ums. Ask me how I know."], ["rZoom", "Punch-ins, for drama."], ["rCaptions", "Captions, in eight flavors."]] },
  { clip: "pip-3.mp4", lines: [["rLooks", "Make it moody."], ["rHook", "A hook, so you don't scroll past me."], ["rSound", "Studio sound. This is my bedroom."]] },
  { clip: "pip-4.mp4", lines: [["rBroll", "B-roll. Or picture-in-picture, like me, right now."], ["rVoice", "Too lazy to type? Just say it."], ["rExport", "Then export it anywhere. Even Resolve."]] },
];

type Word = { text: string; start: number; end: number };
const norm = (w: string) => w.toLowerCase().replace(/[^a-z0-9']/g, "");
/** Word-level transcript with the repo's own faster-whisper script (no filler prompt needed here). */
function transcribe(file: string): Word[] {
  const f32 = file.replace(/\.mp4$/, ".f32");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-f", "f32le", f32]);
  const out = execFileSync("uv", ["run", "--python", "3.12", "--with", "faster-whisper", "python", "scripts/transcribe_faster_whisper.py", f32, "small.en", "en"], { encoding: "utf8", maxBuffer: 1 << 26, stdio: ["ignore", "pipe", "ignore"] });
  const words = (JSON.parse(out.trim().split("\n").pop()!) as { words: Word[] }).words;
  // Whisper splits hyphenated words ("Punch" "-ins", "B" "-roll"): join them back up
  const joined: Word[] = [];
  for (const w of words) {
    const prev = joined.at(-1);
    if (prev && w.text.startsWith("-")) Object.assign(prev, { text: prev.text + w.text, end: w.end });
    else joined.push({ ...w });
  }
  return joined;
}
/** Aligns the expected words to the heard ones (edit distance on words) and returns each heard
 *  word's line, so every line gets the span of the words heard for it. */
function align(expected: { w: string; line: string }[], heard: Word[]) {
  const n = expected.length, m = heard.length;
  const D = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = 0; i <= n; i++) D[i][0] = i;
  for (let j = 0; j <= m; j++) D[0][j] = j;
  const cost = (i: number, j: number) => (norm(expected[i].w) === norm(heard[j].text) ? 0 : 1);
  for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) D[i][j] = Math.min(D[i - 1][j] + 1, D[i][j - 1] + 1, D[i - 1][j - 1] + cost(i - 1, j - 1));
  const lineOf: (string | null)[] = new Array(m).fill(null);
  let i = n, j = m;
  while (i > 0 && j > 0) {
    if (D[i][j] === D[i - 1][j - 1] + cost(i - 1, j - 1)) (lineOf[j - 1] = expected[i - 1].line), i--, j--;
    else if (D[i][j] === D[i][j - 1] + 1) (lineOf[j - 1] = expected[Math.max(0, i - 1)].line), j--;
    else i--;
  }
  return { lineOf, distance: D[n][m] };
}

// Pauses inside a line are cut down to a beat, the way a creator edits a talking head (jump cuts in the
// bubble): a long gap becomes MAX_GAP, the rest of the line follows on.
const MAX_GAP = 0.4;
type Seg = { from: number; to: number };
const result: { lines: Record<string, { clip: string; from: number; to: number; segs: Seg[]; text: string; heard: string; words: Word[] }>; fps: Record<string, number> } = { lines: {}, fps: {} };
for (const { clip, lines } of PIP_SCRIPT) {
  const file = join(DIR, clip);
  if (!existsSync(file)) throw new Error(`missing ${file}`);
  const heard = transcribe(file);
  const expected = lines.flatMap(([id, text]) => text.split(/\s+/).map((w) => ({ w, line: id })));
  const { lineOf, distance } = align(expected, heard);
  console.log(`${clip}: heard "${heard.map((w) => w.text).join(" ")}" (word edit distance ${distance})`);
  for (const [id, text] of lines) {
    const ws = heard.filter((_, k) => lineOf[k] === id);
    if (!ws.length) throw new Error(`${clip}: "${text}" not found`);
    // a little air before the first syllable and after the last; long pauses inside become jump cuts
    const segs: Seg[] = [{ from: Math.max(0, ws[0].start - 0.08), to: ws[0].end }];
    for (let k = 1; k < ws.length; k++) {
      const gap = ws[k].start - ws[k - 1].end;
      if (gap > MAX_GAP) {
        segs.at(-1)!.to = ws[k - 1].end + MAX_GAP / 2;
        segs.push({ from: ws[k].start - MAX_GAP / 2, to: ws[k].end });
      } else segs.at(-1)!.to = ws[k].end;
    }
    segs.at(-1)!.to += 0.12;
    result.lines[id] = { clip, from: segs[0].from, to: segs.at(-1)!.to, segs, text, heard: ws.map((w) => w.text).join(" "), words: ws };
  }
  const r = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();
  const [a, b] = r.split("/").map(Number);
  result.fps[clip] = a / (b || 1);
}
writeFileSync(join(OUT, "pip.json"), JSON.stringify(result, null, 1));
for (const [id, l] of Object.entries(result.lines)) console.log(`${id.padEnd(10)} ${l.clip} ${l.segs.map((g) => `${g.from.toFixed(2)}–${g.to.toFixed(2)}`).join(" + ")} = ${l.segs.reduce((a, g) => a + g.to - g.from, 0).toFixed(2)} s "${l.heard}"`);
