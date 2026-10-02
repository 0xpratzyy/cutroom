import type { ProjectStore } from "./project.js";
import { paginateCaptions } from "./shared/captions.js";
import { timelineWords } from "./shared/timeline.js";

/** SubRip captions for the edited timeline (uses the caption paging settings, enabled or not). */
export async function toSRT(store: ProjectStore): Promise<string> {
  const p = await store.load();
  const { transcripts } = await store.context();
  const pages = paginateCaptions(timelineWords(p, transcripts), { ...p.captions, maxWords: Math.max(p.captions.maxWords, 6), maxChars: Math.max(p.captions.maxChars, 42) });
  const ts = (t: number) => {
    const ms = Math.round(t * 1000);
    const h = Math.floor(ms / 3_600_000);
    const m = Math.floor((ms % 3_600_000) / 60_000);
    const s = Math.floor((ms % 60_000) / 1000);
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
  };
  return pages.map((pg, i) => `${i + 1}\n${ts(pg.start)} --> ${ts(pg.end)}\n${pg.words.map((w) => w.text).join(" ")}\n`).join("\n");
}
