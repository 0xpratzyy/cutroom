// MCP server: lets any agent (Claude Code, Claude Desktop, Cursor, ...) edit videos.
//
// Design: a few coarse tools. The agent perceives the footage through text
// (transcripts, timeline summaries) and images (contact sheets, rendered previews),
// and changes it through one batched `edit` tool with validated operations.
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ALL_STEPS,
  ProjectStore,
  analyzeMedia,
  annotatedFrame,
  feedbackMarkdown,
  contactSheet,
  defaultExportName,
  formatSilences,
  formatTime,
  formatTranscript,
  importMedia,
  render,
  sampleTimes,
  sheetFromVideo,
  summarizeProject,
  timelineDuration,
  timelineToSource,
  toOTIO,
  toSRT,
  type Op,
} from "../core/index.js";
import { startServer, type RunningServer } from "../server/server.js";
import { customFonts, systemFonts } from "../core/fonts.js";
import { applyBrand, getBrand } from "../core/brand.js";
import { BUILTIN_LOOKS } from "../core/shared/looks.js";
import { CAPTION_PRESETS } from "../core/shared/captions.js";
import { findRetakes, useTakeOps } from "../core/shared/retakes.js";
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { OpSchema } from "./schema.js";

const VERSION: string = (() => {
  try {
    return JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;
  } catch {
    return "0.0.0";
  }
})();

const INSTRUCTIONS = `cutroom is a local video editor for talking-head videos. Typical workflow:
1. create_project (or open_project) with the recording(s). Import runs transcription + silence detection.
2. get_timeline and get_transcript to understand the footage; view_frames to see it; find_retakes for redone lines.
3. edit with batched ops: remove_fillers, remove_silences, remove_text / remove_words for flubs,
   retakes and rambling; add_zoom for emphasis (ease 0.3-0.6 for a smooth push, 0 for a punch-in);
   jump_cut_zoom to hide jump cuts after heavy cutting; add_broll; set_settings aspect "9:16" + set_focus to reframe;
   set_captions (preset=pop|karaoke|bold|reveal|boxed|underline|neon|clean, emphasisWords for key terms) for
   burned-in captions; set_look for a color grade; set_hook for an opening title; set_audio for studio
   sound; apply_brand for the user's logo/colors/font (list_styles shows all options).
4. preview a range to check the real rendered result (captions, zooms, b-roll) before export.
5. export. The user may be watching in the editor (open_editor); get_selection tells you what they point at.
Feedback loop: the user pins numbered notes to the video in the editor (a spot on the frame, transcript words,
a range or a clip). get_feedback returns them with the rendered frame and marker; wait_for_feedback blocks until
new notes arrive. For each note: update_feedback status "working", make the edit, preview it, then
update_feedback status "resolved" with a short reply saying what you changed. Keep calling wait_for_feedback
to stay in the loop until the user says they're done.
Times: "timeline" = position in the edited output; "source" = position in a media file. Word indices are stable.
Everything is undoable (undo / redo). Prefer one edit call with many ops over many calls.`;

type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export async function startMcp(initialProject?: string): Promise<void> {
  let store: ProjectStore | undefined = initialProject ? await ProjectStore.open(initialProject) : undefined;
  let editor: RunningServer | undefined;

  const server = new McpServer({ name: "cutroom", version: VERSION }, { instructions: INSTRUCTIONS });

  // Presence heartbeat so the editor can show that an agent is connected (and watching for feedback).
  let watching = false;
  const beat = () => (store ? store.setAgent({ pid: process.pid, watching }).catch(() => {}) : Promise.resolve());
  const heartbeat = setInterval(() => void beat(), 5000);
  heartbeat.unref();
  const goodbye = () => {
    if (store) void store.setAgent(null);
  };
  process.once("exit", goodbye);
  process.stdin.once("close", () => {
    goodbye();
    setTimeout(() => process.exit(0), 200);
  });

  const need = () => {
    if (!store) throw new Error("No project open. Call create_project or open_project first.");
    return store;
  };
  const text = (s: string): { content: Content[] } => ({ content: [{ type: "text", text: s }] });
  const tool = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    fn: (args: z.infer<z.ZodObject<S>>, progress: (p: number, msg?: string) => void) => Promise<{ content: Content[] }>,
    annotations: { readOnlyHint?: boolean; destructiveHint?: boolean } = {},
  ) => {
    server.registerTool(name, { description, inputSchema, annotations }, (async (args: any, extra: any) => {
      const token = extra?._meta?.progressToken;
      const progress = (p: number, message?: string) => {
        if (token === undefined) return;
        void extra.sendNotification({ method: "notifications/progress", params: { progressToken: token, progress: Math.round(p * 100), total: 100, message } }).catch(() => {});
      };
      try {
        return await fn(args, progress);
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err instanceof Error ? err.message : String(err)}` }], isError: true };
      }
    }) as never);
  };

  const analyzeAll = async (s: ProjectStore, ids: string[], progress: (p: number, m?: string) => void, opts: { model?: string; language?: string } = {}) => {
    const lines: string[] = [];
    for (const [n, id] of ids.entries()) {
      const r = await analyzeMedia(s, id, { ...opts, onOverall: (f, step) => progress((n + f) / ids.length, `${id}: ${step}`) });
      lines.push(`${id}: ${Object.entries(r).map(([k, v]) => `${k} ${v}`).join(", ") || "nothing to analyze"}`);
    }
    return lines.join("\n");
  };

  // Switch the active project. A running editor is restarted on the new store (same port, so an
  // open tab can reconnect); otherwise it would keep showing the old project.
  const switchStore = async (next: ProjectStore): Promise<string> => {
    if (store && store !== next) {
      void store.setAgent(null);
      store.close();
    }
    store = next;
    void beat();
    if (!editor) return "";
    const old = editor;
    editor = undefined;
    // close() waits for open connections to drain; the listening socket is released right away.
    await Promise.race([old.close(), new Promise((r) => setTimeout(r, 1000))]);
    editor = await startServer(next, { port: old.port });
    return `\nEditor now showing this project at ${editor.url}`;
  };

  // ---------------------------------------------------------------- project

  tool(
    "create_project",
    "Create a project folder (cutroom.json) and import recordings. The first recording goes on the main track; others go to the media library unless role is 'main'. Runs analysis (transcript, silences) unless analyze=false.",
    {
      path: z.string().describe("Project directory (created if missing)"),
      media: z.array(z.string()).optional().describe("Absolute paths of videos/images to import"),
      name: z.string().optional(),
      analyze: z.boolean().optional(),
      model: z.string().optional().describe("Whisper model, e.g. base.en (default), small.en, small, medium"),
      language: z.string().optional(),
    },
    async (a, progress) => {
      const s = await ProjectStore.create(resolve(a.path), a.name);
      let report = `Project at ${s.dir}${await switchStore(s)}`;
      if (a.media?.length) {
        const assets = await importMedia(s, a.media, { origin: "agent" });
        if (a.analyze !== false) report += "\n" + (await analyzeAll(s, assets.map((x) => x.id), progress, a));
      }
      const p = await s.load();
      return text(`${report}\n\n${summarizeProject(p, await s.context())}`);
    },
  );

  tool("open_project", "Open an existing project (directory containing cutroom.json).", { path: z.string() }, async (a) => {
    const s = await ProjectStore.open(a.path);
    const note = await switchStore(s);
    return text(summarizeProject(await s.load(), await s.context()) + note);
  });

  tool(
    "import_media",
    "Add media files to the project. role 'main' appends to the main track (A-roll); 'library' just adds to the bin (b-roll, images).",
    {
      paths: z.array(z.string()),
      role: z.enum(["main", "library"]).optional(),
      analyze: z.boolean().optional().describe("Default true (transcript for audio, thumbnails for video)"),
      model: z.string().optional(),
      language: z.string().optional(),
    },
    async (a, progress) => {
      const s = need();
      const assets = await importMedia(s, a.paths, { role: a.role, origin: "agent" });
      let report = assets.map((x) => `${x.id}  ${x.kind}  ${x.name}  ${x.kind === "image" ? "" : x.duration.toFixed(2) + "s"}`).join("\n");
      const toAnalyze = assets.filter((x) => x.kind !== "image" && a.analyze !== false).map((x) => x.id);
      if (toAnalyze.length) report += "\n" + (await analyzeAll(s, toAnalyze, progress, a));
      return text(report);
    },
  );

  tool(
    "analyze",
    `(Re)run analysis on a media item. Steps: ${ALL_STEPS.join(", ")}. Use force to redo (e.g. with a bigger model for a better transcript).`,
    {
      mediaId: z.string(),
      steps: z.array(z.enum(["waveform", "silences", "transcript", "proxy", "thumbs"])).optional(),
      force: z.boolean().optional(),
      model: z.string().optional(),
      language: z.string().optional(),
      silenceThresholdDb: z.number().optional().describe("Default -35. Raise (e.g. -30) for noisy rooms"),
    },
    async (a, progress) => {
      const s = need();
      const r = await analyzeMedia(s, a.mediaId, { ...a, onOverall: (f, step) => progress(f, step) });
      return text(Object.entries(r).map(([k, v]) => `${k}: ${v}`).join("\n"));
    },
  );

  // ------------------------------------------------------------- perception

  tool(
    "get_timeline",
    "Summary of the project: media, main-track clips (timeline ↔ source), b-roll, zooms, captions, output format.",
    {},
    async () => {
      const s = need();
      return text(summarizeProject(await s.load(), await s.context()));
    },
    { readOnlyHint: true },
  );

  tool(
    "get_transcript",
    "Word-level transcript with timeline times and stable word indices (for remove_words/restore_words). Cut words are shown as ~i:word~. Optionally limit to a timeline range and include detected silences.",
    {
      mediaId: z.string().optional().describe("Defaults to every transcribed media on the main track"),
      start: z.number().optional(),
      end: z.number().optional(),
      showCut: z.boolean().optional(),
      silences: z.boolean().optional(),
    },
    async (a) => {
      const s = need();
      const p = await s.load();
      const ctx = await s.context();
      const ids = a.mediaId ? [a.mediaId] : [...new Set(p.clips.map((c) => c.mediaId))];
      const range = a.start !== undefined || a.end !== undefined ? { start: a.start ?? 0, end: a.end ?? Infinity } : undefined;
      const parts: string[] = [];
      for (const id of ids) {
        const t = ctx.transcripts[id];
        if (!t) {
          parts.push(`${id}: no transcript (run analyze)`);
          continue;
        }
        parts.push(formatTranscript(p, t, { range, showCut: a.showCut }));
        const sil = ctx.silences[id];
        if (a.silences && sil) parts.push(formatSilences(p, id, sil));
      }
      return text(parts.join("\n\n") || "Nothing on the main track yet.");
    },
    { readOnlyHint: true },
  );

  tool(
    "view_frames",
    "See the footage: a labeled contact sheet of frames at timeline times (fast, from source; shows b-roll but not zoom/captions). Give explicit times, or start/end/count.",
    {
      times: z.array(z.number()).optional(),
      start: z.number().optional(),
      end: z.number().optional(),
      count: z.number().int().min(1).max(24).optional(),
    },
    async (a) => {
      const s = need();
      const p = await s.load();
      const total = timelineDuration(p);
      const times = a.times?.length ? a.times : sampleTimes(a.start ?? 0, Math.min(a.end ?? total, total), a.count ?? 8);
      const jpg = await contactSheet(s, times);
      return { content: [{ type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `Frames at ${times.map((t) => formatTime(t)).join(", ")}` }] };
    },
    { readOnlyHint: true },
  );

  tool(
    "preview",
    "Render a low-res draft of a timeline range exactly as it will export (cuts, crop, zooms, b-roll, captions) and return sampled frames. Use to verify edits.",
    { start: z.number(), end: z.number(), frames: z.number().int().min(1).max(16).optional() },
    async (a, progress) => {
      const s = need();
      const p = await s.load();
      await mkdir(s.previewDir, { recursive: true });
      const out = join(s.previewDir, `preview-${Date.now()}.mp4`);
      const { duration } = await render(s, { out, range: { start: a.start, end: a.end }, scale: 0.4, quality: "draft", onProgress: (f) => progress(f, "rendering") });
      const count = a.frames ?? 6;
      const times = sampleTimes(0, duration, count);
      const jpg = await sheetFromVideo(out, times, times.map((t) => formatTime(a.start + t)), p.settings.height / p.settings.width, s.dataDir);
      return { content: [{ type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" }, { type: "text", text: `Rendered ${duration.toFixed(2)}s preview: ${out}` }] };
    },
    { readOnlyHint: true },
  );

  tool(
    "get_selection",
    "What the user is pointing at in the open editor: playhead, selected range, clips/overlays/zooms, and selected transcript words. Use when the user says 'this', 'here', 'the selected part'.",
    {},
    async () => {
      const s = need();
      const sel = await s.getSelection();
      const p = await s.load();
      const ctx = await s.context();
      const lines = [`playhead ${formatTime(sel.playhead)} (${sel.playhead.toFixed(2)}s)`];
      const at = timelineToSource(p, sel.playhead);
      if (at) lines.push(`  → clip ${at.placed.clip.id}, ${at.placed.clip.mediaId} source ${at.src.toFixed(2)}s`);
      if (sel.range) lines.push(`range ${formatTime(sel.range.start)}–${formatTime(sel.range.end)} (${sel.range.start.toFixed(2)}–${sel.range.end.toFixed(2)}s)`);
      for (const it of sel.items) lines.push(`selected ${it.type} ${it.id}`);
      if (sel.words) {
        const t = ctx.transcripts[sel.words.mediaId];
        const words = t?.words.slice(sel.words.from, sel.words.to + 1).map((w) => w.text).join(" ");
        lines.push(`words ${sel.words.mediaId} ${sel.words.from}-${sel.words.to}: "${words ?? "?"}"`);
      }
      if (sel.updatedAt.startsWith("1970")) lines.push("(the editor hasn't reported a selection yet; is it open?)");
      return text(lines.join("\n"));
    },
    { readOnlyHint: true },
  );

  tool(
    "list_styles",
    "Style options: built-in color looks, the project's custom .cube LUTs, caption templates, the project's custom fonts, and installed system fonts.",
    { fontQuery: z.string().optional().describe("Filter system fonts by name") },
    async (a) => {
      const s = need();
      const fonts = await customFonts(s);
      const luts = existsSync(join(s.dir, "luts")) ? (await readdir(join(s.dir, "luts"))).filter((f) => /\.cube$/i.test(f)) : [];
      const sys = systemFonts().filter((f) => !a.fontQuery || f.toLowerCase().includes(a.fontQuery.toLowerCase()));
      return text(
        [
          "LOOKS (set_look lut=…): " + BUILTIN_LOOKS.map((l) => `${l.id} (${l.description})`).join("; "),
          "CUSTOM LUTS: " + (luts.map((f) => `custom:${f}`).join(", ") || "none (the user can add .cube files in the editor)"),
          "CAPTION TEMPLATES (set_captions preset=…): " + CAPTION_PRESETS.map((p) => `${p.id} = ${p.name}`).join(", "),
          "CUSTOM FONTS (fontFamily): " + (fonts.map((f) => f.family).join(", ") || "none"),
          await getBrand().then((b) => `BRAND KIT (apply_brand): "${b.name}" primary ${b.primary}, secondary ${b.secondary}, text ${b.text}, font ${b.fontFamily ?? "default"}, logo ${b.logo ? "yes" : "none"}`),
          "HOOK TITLE (set_hook preset=…): highlight, headline, outline, minimal. STUDIO SOUND (set_audio preset=…): clean, podcast, crisp, broadcast",
          `SYSTEM FONTS (${sys.length}${a.fontQuery ? ` matching "${a.fontQuery}"` : ""}): ` + sys.slice(0, 120).join(", ") + (sys.length > 120 ? ", …" : ""),
        ].join("\n"),
      );
    },
    { readOnlyHint: true },
  );

  tool(
    "find_retakes",
    "Find repeated attempts at the same line (false starts and full redos) and the suggested best take of each. With apply=true, keep the suggested take of every group (or only `groups`) and cut the rest, as one undoable edit.",
    { apply: z.boolean().optional(), groups: z.array(z.string()).optional().describe("Group ids to apply (default: all)") },
    async (a) => {
      const s = need();
      const p = await s.load();
      const groups = findRetakes(p, (await s.context()).transcripts);
      if (!groups.length) return text("No retakes found.");
      const lines = groups.map((g) =>
        [`GROUP ${g.id}`, ...g.takes.map((t, k) => `  ${k === g.best ? "★" : " "} take ${k + 1}: ${t.kept ? "" : "[cut] "}"${t.text}" (${t.mediaId} #${t.from}-${t.to}, ${t.start.toFixed(1)}s${t.fillers ? `, ${t.fillers} filler` : ""}${t.complete ? "" : ", unfinished"})`)].join("\n"),
      );
      if (!a.apply) return text(`${groups.length} retake group(s); ★ = suggested take.\n${lines.join("\n")}\nCall find_retakes apply=true to keep the suggestions, or edit with remove_words/restore_words to choose differently.`);
      const chosen = groups.filter((g) => !a.groups || a.groups.includes(g.id));
      const ops = chosen.flatMap((g) => useTakeOps(g, g.best));
      if (!ops.length) return text("The suggested takes are already the ones in the edit.");
      const r = await s.edit(ops, "agent", `keep best takes (${chosen.length})`);
      return text(`Kept the best take in ${chosen.length} group(s).\n${r.notes.join("\n")}`);
    },
  );

  tool(
    "apply_brand",
    "Apply the user's saved brand kit to this project: logo watermark, caption and hook colors, brand font (and its caption template / look if set). One undoable edit.",
    {},
    async () => {
      const r = await applyBrand(need(), "agent");
      return text(`Applied brand "${r.brand.name}":\n${r.notes.join("\n")}`);
    },
  );

  // --------------------------------------------------------------- feedback

  const feedbackContent = async (s: ProjectStore, status: "open" | "unresolved" | "all", images: boolean): Promise<Content[]> => {
    const p = await s.load();
    const all = await s.getFeedback();
    const items = all.filter((f) => (status === "all" ? true : status === "open" ? f.status === "open" : f.status !== "resolved"));
    if (!items.length) return [{ type: "text", text: `No ${status === "all" ? "" : status + " "}feedback. (${all.length} total)` }];
    const content: Content[] = [{ type: "text", text: feedbackMarkdown(p, items) }];
    if (images) {
      for (const fb of items.slice(0, 6)) {
        const jpg = await annotatedFrame(s, fb);
        if (jpg) content.push({ type: "text", text: `Frame for #${fb.n}:` }, { type: "image", data: jpg.toString("base64"), mimeType: "image/jpeg" });
      }
      if (items.length > 6) content.push({ type: "text", text: `(${items.length - 6} more without frames; call again after resolving some)` });
    }
    return content;
  };

  tool(
    "get_feedback",
    "Notes the user pinned to the video in the editor: what they're about (time, frame region, transcript words, clip) plus the rendered frame with their marker drawn. Default: notes not yet resolved.",
    { status: z.enum(["open", "unresolved", "all"]).optional(), images: z.boolean().optional().describe("Include annotated frames (default true)") },
    async (a) => ({ content: await feedbackContent(need(), a.status ?? "unresolved", a.images !== false) }),
    { readOnlyHint: true },
  );

  tool(
    "wait_for_feedback",
    "Block until the user leaves new feedback (status open) in the editor, then return it like get_feedback. Returns immediately if open notes already exist. Use this to stay in an edit loop with the user.",
    { timeoutSec: z.number().min(5).max(3600).optional().describe("Default 600") },
    async (a) => {
      const s = need();
      const deadline = Date.now() + (a.timeoutSec ?? 600) * 1000;
      watching = true;
      void beat();
      try {
        while (Date.now() < deadline) {
          if ((await s.getFeedback()).some((f) => f.status === "open")) return { content: await feedbackContent(s, "open", true) };
          await new Promise((r) => setTimeout(r, 1000));
        }
        return text("No new feedback yet. Call wait_for_feedback again to keep waiting.");
      } finally {
        watching = false;
        void beat();
      }
    },
    { readOnlyHint: true },
  );

  tool(
    "update_feedback",
    'Mark feedback as "working" when you start on it and "resolved" when done, with a short reply describing the change (shown to the user in the editor). id is the feedback id or its number.',
    { id: z.string(), status: z.enum(["open", "working", "resolved"]).optional(), reply: z.string().optional() },
    async (a) => {
      const fb = await need().updateFeedback(a.id, { status: a.status, reply: a.reply ? { author: "agent", text: a.reply } : undefined });
      return text(`#${fb.n} is ${fb.status}`);
    },
  );

  // ---------------------------------------------------------------- editing

  tool(
    "edit",
    "Apply a batch of edit operations atomically (all or nothing, one undo step). Returns what changed and the new duration.",
    { ops: z.array(OpSchema).min(1), label: z.string().optional().describe("Short description for the undo history") },
    async (a) => {
      const s = need();
      const before = timelineDuration(await s.load());
      const r = await s.edit(a.ops as Op[], "agent", a.label);
      const after = timelineDuration(r.project);
      return text(`${r.notes.join("\n")}\nDuration ${formatTime(before)} → ${formatTime(after)} (${(after - before).toFixed(2)}s)`);
    },
    { destructiveHint: false },
  );

  tool("undo", "Undo the last edit (from the agent or the editor).", {}, async () => {
    const e = await need().undo();
    return text(e ? `Undid "${e.label}" (${e.origin})` : "Nothing to undo");
  });

  tool("redo", "Redo the last undone edit.", {}, async () => {
    const e = await need().redo();
    return text(e ? `Redid "${e.label}"` : "Nothing to redo");
  });

  // ----------------------------------------------------------------- output

  tool(
    "export",
    "Export the edit. format mp4 (default) renders video into <project>/exports; srt writes captions; otio writes an OpenTimelineIO timeline for Resolve/Premiere.",
    { format: z.enum(["mp4", "srt", "otio"]).optional(), quality: z.enum(["draft", "standard", "high"]).optional(), filename: z.string().optional() },
    async (a, progress) => {
      const s = need();
      const p = await s.load();
      await mkdir(s.exportDir, { recursive: true });
      const format = a.format ?? "mp4";
      const base = (a.filename ?? defaultExportName(p, s.exportDir)).replace(/\.(mp4|srt|otio)$/i, "").replace(/[/\\]/g, "-");
      const out = join(s.exportDir, `${base}.${format}`);
      if (format === "srt") await writeFile(out, await toSRT(s));
      else if (format === "otio") await writeFile(out, JSON.stringify(await toOTIO(s), null, 2));
      else await render(s, { out, quality: a.quality ?? "standard", onProgress: (f) => progress(f, "rendering") });
      return text(`Exported ${out}`);
    },
  );

  tool(
    "open_editor",
    "Start the cutroom web editor for this project and return its URL, so the user can watch edits live and point at things.",
    { launch: z.boolean().optional().describe("Also open it in the default browser (default true)") },
    async (a) => {
      const s = need();
      editor ??= await startServer(s);
      if (a.launch !== false) openBrowser(editor.url);
      return text(`Editor running at ${editor.url}`);
    },
  );

  server.registerPrompt(
    "edit_talking_head",
    {
      description: "Turn a raw talking-head recording into a tight, captioned edit",
      argsSchema: { video: z.string().describe("Path to the recording"), format: z.string().optional().describe("e.g. 'vertical short' or 'youtube'") },
    },
    ({ video, format }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: `Edit ${video} into a ${format ?? "tight YouTube"} video with cutroom.
1. create_project next to the file and open_editor so I can watch.
2. Read the full transcript. Remove fillers and long silences. Use find_retakes to catch false starts and repeated takes (check the suggestions, then apply), and cut other flubs with remove_text or remove_words.
3. Add a few punch-in zooms on key lines. ${format?.includes("vertical") || format?.includes("short") ? 'Set aspect "9:16" and check framing with view_frames; adjust set_focus if the speaker is off-center.' : ""}
4. Turn on captions.
5. preview the opening 10 seconds and one zoom, fix anything off, then export.
Tell me what you cut and why.`,
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    "address_feedback",
    { description: "Work through the notes the user pinned in the editor, then keep watching for more" },
    () => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: "Open the cutroom editor if it isn't open. Call get_feedback and work through every note: mark it working, make the edit, check it with preview, then resolve it with a one-line reply. When none are left, call wait_for_feedback and repeat until I say stop.",
          },
        },
      ],
    }),
  );

  await server.connect(new StdioServerTransport());
  void beat();
}

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

export { openBrowser };
