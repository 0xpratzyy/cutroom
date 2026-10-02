// Feedback helpers shared by the editor, the server and the MCP server.
import { formatTime, sourceToTimeline } from "./timeline.js";
import type { Feedback, Project } from "./types.js";

/** Where a note sits on the current timeline (follows its source anchor through edits). */
export function feedbackTime(project: Pick<Project, "clips">, fb: Feedback): { start: number; end: number | null; cut: boolean } {
  if (!fb.anchor) return { ...fb.time, cut: false };
  const start = sourceToTimeline(project, fb.anchor.mediaId, fb.anchor.start);
  if (start === null) return { ...fb.time, cut: true };
  if (fb.time.end === null) return { start, end: null, cut: false };
  const end = sourceToTimeline(project, fb.anchor.mediaId, fb.anchor.end);
  return { start, end: end !== null && end > start ? end : start + (fb.time.end - fb.time.start), cut: false };
}

function pct(n: number) {
  return `${Math.round(n * 100)}%`;
}

export function describeRegion(r: NonNullable<Feedback["region"]>): string {
  if (r.w < 0.01 && r.h < 0.01) return `point at x ${pct(r.x)}, y ${pct(r.y)} of the frame`;
  return `box x ${pct(r.x)}–${pct(r.x + r.w)}, y ${pct(r.y)}–${pct(r.y + r.h)} of the frame`;
}

/** Structured markdown for pasting into any agent (or returned over MCP). */
export function feedbackMarkdown(project: Project, items: Feedback[]): string {
  const dur = project.clips.reduce((n, c) => n + c.out - c.in, 0);
  const lines = [`## Video feedback: "${project.name}" (${formatTime(dur)}, ${project.settings.width}×${project.settings.height})`, ""];
  for (const fb of items) {
    const t = feedbackTime(project, fb);
    const when = t.end !== null ? `${formatTime(t.start)}–${formatTime(t.end)}` : formatTime(t.start);
    lines.push(`### ${fb.n}. ${when}${t.cut ? " (footage since cut)" : ""} [${fb.status}]  id: ${fb.id}`);
    if (fb.words) lines.push(`- Words: "${fb.words.text}" (${fb.words.mediaId} #${fb.words.from}–${fb.words.to})`);
    if (fb.region) lines.push(`- Frame: ${describeRegion(fb.region)}`);
    if (fb.target) lines.push(`- Item: ${fb.target.type} ${fb.target.id}`);
    if (fb.anchor) lines.push(`- Source: ${fb.anchor.mediaId} ${fb.anchor.start.toFixed(2)}–${fb.anchor.end.toFixed(2)}s`);
    lines.push(`- Note${fb.voice ? " (voice note, transcribed)" : ""}: ${fb.note}`);
    for (const r of fb.replies) lines.push(`  - ${r.author === "agent" ? "Agent" : "User"}: ${r.text}`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}
