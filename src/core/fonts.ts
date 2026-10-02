// Fonts: system fonts, plus font files dropped into the project's fonts/ folder.
// Custom fonts are registered under a family name derived from the file name, both
// here (for exports) and in the browser (FontFace), so captions match.
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { GlobalFonts } from "@napi-rs/canvas";
import type { ProjectStore } from "./project.js";

export const FONT_EXT = /\.(ttf|otf|woff2?)$/i;

export function fontFamilyFromFile(file: string): string {
  return file.replace(FONT_EXT, "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}

export function fontsDir(store: ProjectStore) {
  return join(store.dir, "fonts");
}

export async function customFonts(store: ProjectStore): Promise<{ family: string; file: string }[]> {
  const dir = fontsDir(store);
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => FONT_EXT.test(f) && !f.startsWith(".")).map((file) => ({ family: fontFamilyFromFile(file), file }));
}

const registered = new Set<string>();
export async function registerProjectFonts(store: ProjectStore): Promise<void> {
  for (const f of await customFonts(store)) {
    const path = join(fontsDir(store), f.file);
    if (registered.has(path) || extname(path).toLowerCase() === ".woff") continue;
    GlobalFonts.registerFromPath(path, f.family);
    registered.add(path);
  }
}

/** Installed font families, sorted, without hidden/system-UI faces. */
export function systemFonts(): string[] {
  const fams = new Set<string>();
  for (const f of GlobalFonts.families) if (f.family && !f.family.startsWith(".")) fams.add(f.family);
  return [...fams].sort((a, b) => a.localeCompare(b));
}
