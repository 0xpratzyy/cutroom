// Brand kit: saved once per machine (~/.cutroom/brand, or $CUTROOM_HOME/brand) and applied
// to any project. Applying copies the logo and font into the project, so projects stay
// self-contained, and sets watermark, caption and hook colors in one undoable edit.
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join } from "node:path";
import { atomicWrite, type Origin, type ProjectStore } from "./project.js";
import { fontFamilyFromFile, FONT_EXT } from "./fonts.js";
import type { Op } from "./shared/ops.js";
import { DEFAULT_BRAND, type BrandKit } from "./shared/types.js";

export function brandDir(): string {
  return join(process.env.CUTROOM_HOME ?? join(homedir(), ".cutroom"), "brand");
}

export async function getBrand(): Promise<BrandKit> {
  try {
    const saved = JSON.parse(await readFile(join(brandDir(), "brand.json"), "utf8"));
    return { ...DEFAULT_BRAND, ...saved, watermark: { ...DEFAULT_BRAND.watermark, ...saved.watermark } };
  } catch {
    return { ...DEFAULT_BRAND };
  }
}

export async function saveBrand(patch: Partial<BrandKit>): Promise<BrandKit> {
  const current = await getBrand();
  const { logo: _l, fontFile: _f, ...safe } = patch; // files are set only through uploads
  const next: BrandKit = { ...current, ...safe, watermark: { ...current.watermark, ...(patch.watermark ?? {}) } };
  for (const k of ["primary", "secondary", "text"] as const) {
    if (!/^#[0-9a-fA-F]{6}$/.test(next[k])) throw new Error(`${k} must be a #rrggbb color`);
  }
  await mkdir(brandDir(), { recursive: true });
  await atomicWrite(join(brandDir(), "brand.json"), JSON.stringify(next, null, 2));
  return next;
}

const LOGO_EXT = /\.(png|jpe?g|webp|svg)$/i;

export async function setBrandLogo(name: string, data: Buffer): Promise<BrandKit> {
  if (!LOGO_EXT.test(name)) throw new Error("Logo must be a PNG, JPG, WebP or SVG (PNG with transparency works best)");
  const brand = await getBrand();
  await mkdir(brandDir(), { recursive: true });
  if (brand.logo) await rm(join(brandDir(), brand.logo), { force: true });
  const file = `logo${extname(name).toLowerCase()}`;
  await writeFile(join(brandDir(), file), data);
  return writeBrandField({ logo: file });
}

export async function setBrandFont(name: string, data: Buffer): Promise<BrandKit> {
  if (!FONT_EXT.test(name)) throw new Error("Font must be a .ttf, .otf or .woff2 file");
  const file = basename(name).replace(/[^\w.\- ]+/g, "_");
  await mkdir(brandDir(), { recursive: true });
  await writeFile(join(brandDir(), file), data);
  return writeBrandField({ fontFile: file, fontFamily: fontFamilyFromFile(file) });
}

async function writeBrandField(patch: Partial<BrandKit>): Promise<BrandKit> {
  const next = { ...(await getBrand()), ...patch };
  await atomicWrite(join(brandDir(), "brand.json"), JSON.stringify(next, null, 2));
  return next;
}

/** The edit ops that apply a brand to a project (files must already be copied in). */
export function brandOps(brand: BrandKit, logoInProject: string | null): Op[] {
  const font = brand.fontFamily ? `${brand.fontFamily}, Helvetica Neue, Arial, sans-serif` : undefined;
  const ops: Op[] = [];
  if (brand.captionPreset) ops.push({ op: "set_captions", preset: brand.captionPreset } as Op);
  ops.push({
    op: "set_captions",
    highlightColor: brand.secondary,
    boxColor: brand.primary,
    emphasisColor: brand.secondary,
    color: brand.text,
    ...(font ? { fontFamily: font } : {}),
  } as Op);
  ops.push({ op: "set_hook", accent: brand.primary, color: brand.text, ...(font ? { fontFamily: font } : {}) } as Op);
  if (logoInProject) ops.push({ op: "set_watermark", enabled: true, file: logoInProject, ...brand.watermark } as Op);
  if (brand.look) ops.push({ op: "set_look", lut: brand.look } as Op);
  return ops;
}

export async function applyBrand(store: ProjectStore, origin: Origin): Promise<{ brand: BrandKit; notes: string[] }> {
  const brand = await getBrand();
  let logo: string | null = null;
  if (brand.logo && existsSync(join(brandDir(), brand.logo))) {
    await mkdir(join(store.dir, "brand"), { recursive: true });
    logo = `brand/${brand.logo}`;
    await copyFile(join(brandDir(), brand.logo), join(store.dir, logo));
  }
  if (brand.fontFile && existsSync(join(brandDir(), brand.fontFile))) {
    await mkdir(join(store.dir, "fonts"), { recursive: true });
    await copyFile(join(brandDir(), brand.fontFile), join(store.dir, "fonts", brand.fontFile));
  }
  const r = await store.edit(brandOps(brand, logo), origin, `apply brand "${brand.name}"`);
  return { brand, notes: r.notes };
}
