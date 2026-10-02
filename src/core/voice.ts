// Voice notes: a short recording made while watching becomes a feedback note. The speech is
// transcribed locally, and the note is anchored to the moment (and the words on screen).
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ProjectStore } from "./project.js";
import { mapWords } from "./shared/timeline.js";
import type { Feedback } from "./shared/types.js";
import { transcribe } from "./transcribe.js";

export interface VoiceNoteInput {
  audio: Buffer;
  ext: string;
  /** Timeline range the user was watching while talking. */
  start: number;
  end: number;
  region: Feedback["region"];
}

export async function createVoiceNote(store: ProjectStore, input: VoiceNoteInput, onProgress?: (f: number) => void): Promise<Feedback> {
  const dir = join(store.dataDir, "voice");
  await mkdir(dir, { recursive: true });
  const file = `note-${Date.now()}.${input.ext.replace(/[^a-z0-9]/gi, "") || "webm"}`;
  const path = join(dir, file);
  await writeFile(path, input.audio);

  // Short clips: the small multilingual model is quick and handles any language.
  const t = await transcribe("voice", path, dir, { model: process.env.CUTROOM_VOICE_MODEL ?? "base", language: "auto", onProgress });
  const text = t.words.map((w) => w.text).join(" ").replace(/\s+([,.!?])/g, "$1").trim();
  if (!text) throw new Error("Couldn't hear anything in that voice note");

  // Attach the transcript words that were playing, so the agent knows exactly what was on screen.
  const project = await store.load();
  const { transcripts } = await store.context();
  let words: Feedback["words"] = null;
  for (const tr of Object.values(transcripts)) {
    if (!tr) continue;
    const hit = mapWords(project, tr).filter((w) => w.kept && w.end > input.start - 0.15 && w.start < input.end + 0.15);
    if (hit.length) {
      words = { mediaId: tr.mediaId, from: hit[0].word.i, to: hit[hit.length - 1].word.i, text: hit.map((w) => w.word.text).join(" ") };
      break;
    }
  }
  return store.addFeedback({ note: text, time: { start: input.start, end: input.end > input.start + 0.3 ? input.end : null }, region: input.region, words, voice: file });
}
