// Zod schemas for edit ops. Validates input from MCP, the editor's HTTP API and the CLI,
// and generates the MCP tool's JSON schema.
import { z } from "zod";
import { EditError, type Op } from "./shared/ops.js";

const t = (d: string) => z.number().describe(d);
const focus = { x: z.number().min(0).max(1).optional(), y: z.number().min(0).max(1).optional() };
const pip = z.object({ x: z.number(), y: z.number(), w: z.number() }).describe("Picture-in-picture box, normalized 0-1 to the output frame");

export const OpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("cut"), start: t("Timeline seconds"), end: t("Timeline seconds") }).describe("Remove a timeline range (ripples everything after it)"),
  z.object({ op: z.literal("cut_source"), mediaId: z.string(), start: t("Source seconds"), end: t("Source seconds") }).describe("Remove a source-time range wherever it appears"),
  z.object({ op: z.literal("remove_words"), mediaId: z.string(), from: z.number().int(), to: z.number().int() }).describe("Cut transcript words from..to (inclusive word indices)"),
  z.object({ op: z.literal("restore_source"), mediaId: z.string(), start: z.number(), end: z.number() }).describe("Bring back a source-time range that was cut"),
  z.object({ op: z.literal("restore_words"), mediaId: z.string(), from: z.number().int(), to: z.number().int() }).describe("Bring back previously cut words"),
  z
    .object({ op: z.literal("remove_text"), text: z.string(), mediaId: z.string().optional(), occurrence: z.union([z.number().int().min(1), z.literal("all")]).optional() })
    .describe("Cut an exact phrase from the kept transcript (case/punctuation-insensitive). occurrence defaults to 1"),
  z
    .object({ op: z.literal("remove_silences"), mediaId: z.string().optional(), minDuration: z.number().min(0).optional(), keep: z.number().min(0).optional() })
    .describe("Cut pauses longer than minDuration (default 0.6s), leaving `keep` seconds (default 0.2) on each side"),
  z.object({ op: z.literal("remove_fillers"), mediaId: z.string().optional(), words: z.array(z.string()).optional() }).describe("Cut filler words (um, uh, ...) or a custom word list"),
  z.object({ op: z.literal("split"), at: t("Timeline seconds") }),
  z.object({ op: z.literal("add_clip"), mediaId: z.string(), in: z.number().optional(), out: z.number().optional(), index: z.number().int().optional() }).describe("Add a source range to the main track"),
  z.object({ op: z.literal("remove_clip"), id: z.string() }),
  z.object({ op: z.literal("trim_clip"), id: z.string(), in: z.number().optional(), out: z.number().optional() }).describe("Change a clip's source in/out points"),
  z.object({ op: z.literal("move_clip"), id: z.string(), index: z.number().int() }),
  z.object({ op: z.literal("set_focus"), id: z.string().optional(), x: z.number().min(0).max(1), y: z.number().min(0).max(1) }).describe("Focal point for cropping (e.g. reframing 16:9 to 9:16). Omit id for all clips"),
  z
    .object({
      op: z.literal("add_broll"),
      mediaId: z.string(),
      start: t("Timeline seconds"),
      duration: z.number().optional(),
      in: z.number().optional().describe("Source in-point"),
      mode: z.enum(["full", "pip"]).optional(),
      volume: z.number().min(0).max(2).optional().describe("0 = muted (default)"),
      pip: pip.optional(),
    })
    .describe("Overlay b-roll (video or image) on the main track"),
  z.object({
    op: z.literal("update_overlay"),
    id: z.string(),
    start: z.number().optional(),
    duration: z.number().optional(),
    in: z.number().optional(),
    mode: z.enum(["full", "pip"]).optional(),
    volume: z.number().min(0).max(2).optional(),
    pip: pip.optional(),
    focus: z.object(focus).optional(),
  }),
  z.object({ op: z.literal("remove_overlay"), id: z.string() }),
  z
    .object({ op: z.literal("add_zoom"), start: t("Timeline seconds"), end: t("Timeline seconds"), scale: z.number().min(1).max(4).optional(), ease: z.number().min(0).max(5).optional().describe("Seconds to ease in/out (smooth push). 0 or omitted = instant punch-in"), ...focus })
    .describe("Punch-in zoom (default ×1.3, focus x 0.5 y 0.4) for emphasis"),
  z.object({ op: z.literal("update_zoom"), id: z.string(), start: z.number().optional(), end: z.number().optional(), scale: z.number().min(1).max(4).optional(), ease: z.number().min(0).max(5).optional(), ...focus }),
  z.object({ op: z.literal("remove_zoom"), id: z.string() }),
  z
    .object({ op: z.literal("jump_cut_zoom"), scale: z.number().min(1.02).max(2).optional().describe("Default 1.15"), minGap: z.number().min(0).optional() })
    .describe("Hide jump cuts: alternate framing at each cut by punching in on every other clip"),
  z
    .object({
      op: z.literal("set_captions"),
      enabled: z.boolean().optional(),
      maxWords: z.number().int().min(1).optional(),
      maxChars: z.number().int().min(4).optional(),
      position: z.number().min(0).max(1).optional().describe("Vertical center, 0 top – 1 bottom"),
      fontSize: z.number().optional().describe("Fraction of output height, e.g. 0.055"),
      fontFamily: z.string().optional(),
      fontWeight: z.number().optional(),
      color: z.string().optional(),
      highlightColor: z.string().optional(),
      strokeColor: z.string().optional(),
      strokeWidth: z.number().optional(),
      uppercase: z.boolean().optional(),
      highlight: z.boolean().optional().describe("Highlight the word being spoken"),
      background: z.string().nullable().optional(),
      preset: z.enum(["pop", "karaoke", "bold", "reveal", "boxed", "underline", "neon", "clean"]).nullable().optional().describe("Apply a caption template first; other fields in the same op override it"),
      animation: z.enum(["none", "pop", "bounce", "fade", "rise", "reveal"]).optional(),
      highlightStyle: z.enum(["color", "box", "scale", "underline"]).optional(),
      boxColor: z.string().optional(),
      glow: z.string().nullable().optional(),
      emphasisWords: z.array(z.string()).optional().describe("Words to draw in emphasisColor, e.g. key terms and numbers"),
      emphasisColor: z.string().optional(),
    })
    .describe("Burned-in captions generated from the transcript"),
  z
    .object({
      op: z.literal("set_look"),
      lut: z.string().nullable().optional().describe('Built-in look id (clean, warm, teal-orange, moody, film, vivid, bleach, bw), "custom:<file.cube>" from the project luts/ folder, or null'),
      intensity: z.number().min(0).max(1).optional(),
      exposure: z.number().min(-1).max(1).optional(),
      contrast: z.number().min(-1).max(1).optional(),
      saturation: z.number().min(-1).max(1).optional(),
      temperature: z.number().min(-1).max(1).optional().describe("-1 cool … 1 warm"),
    })
    .describe("Color grade for the main track"),
  z
    .object({
      op: z.literal("set_hook"),
      enabled: z.boolean().optional(),
      text: z.string().max(140).optional().describe("Short, punchy line (3-8 words). Setting text turns the hook on"),
      start: z.number().min(0).optional(),
      duration: z.number().min(0.5).max(15).optional(),
      position: z.number().min(0).max(1).optional(),
      preset: z.enum(["highlight", "headline", "outline", "minimal"]).optional(),
      fontFamily: z.string().optional(),
      fontWeight: z.number().optional(),
      fontSize: z.number().min(0.02).max(0.2).optional(),
      color: z.string().optional(),
      accent: z.string().optional(),
      uppercase: z.boolean().optional(),
    })
    .describe("Big title over the opening seconds"),
  z
    .object({
      op: z.literal("set_watermark"),
      enabled: z.boolean().optional(),
      file: z.string().nullable().optional().describe("Image path relative to the project folder"),
      corner: z.enum(["tl", "tr", "bl", "br"]).optional(),
      size: z.number().min(0.03).max(0.6).optional(),
      opacity: z.number().min(0).max(1).optional(),
      margin: z.number().min(0).max(0.3).optional(),
    })
    .describe("Logo in a corner (apply_brand sets this up from the brand kit)"),
  z
    .object({
      op: z.literal("set_audio"),
      preset: z.enum(["off", "clean", "podcast", "crisp", "broadcast"]).optional().describe("Studio sound: noise reduction, EQ, de-essing, compression"),
      strength: z.number().min(0).max(1).optional(),
    })
    .describe("Voice cleanup for the main track"),
  z
    .object({
      op: z.literal("set_settings"),
      aspect: z.enum(["16:9", "9:16", "1:1", "4:5"]).optional(),
      width: z.number().int().optional(),
      height: z.number().int().optional(),
      fps: z.number().optional(),
      background: z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb color").optional(),
      normalizeAudio: z.boolean().optional(),
      cutFadeMs: z.number().optional(),
    })
    .describe("Output format"),
]);

/** Validate untrusted ops (HTTP body, CLI argument). Throws EditError with a readable message. */
export function parseOps(input: unknown): Op[] {
  const r = z.array(OpSchema).min(1).safeParse(input);
  if (r.success) return r.data as Op[];
  throw new EditError(r.error.issues.map((i) => (i.path.length ? `ops.${i.path.join(".")}: ` : "ops: ") + i.message).join("; "));
}
