// The LaunchTime Solutions brand assets of the invoice PDF (invoice-template/): Roboto + Roboto Slab (Apache 2.0, data/invoicing/fonts)
// and the default logo (data/invoicing/launchtime-logo.png). Server only. Read once per server instance from disk (next.config.ts ships
// data/invoicing with the PDF route). A missing or unreadable file never blocks an invoice: the renderer then falls back to the
// standard PDF fonts (Helvetica) and to no default logo.

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BrandFonts {
  regular: Uint8Array;
  medium: Uint8Array;
  italic: Uint8Array;
  slab: Uint8Array;
  slabMedium: Uint8Array;
  slabSemiBold: Uint8Array;
}

export interface BrandAssets {
  fonts: BrandFonts | null;
  logo: { bytes: Uint8Array; mime: string } | null;
}

const DIR = join(process.cwd(), "data", "invoicing");
const FONT_FILES: Record<keyof BrandFonts, string> = {
  regular: "Roboto-Regular.ttf",
  medium: "Roboto-Medium.ttf",
  italic: "Roboto-Italic.ttf",
  slab: "RobotoSlab-Regular.ttf",
  slabMedium: "RobotoSlab-Medium.ttf",
  slabSemiBold: "RobotoSlab-SemiBold.ttf",
};

async function loadFonts(): Promise<BrandFonts | null> {
  try {
    const entries = await Promise.all(
      (Object.keys(FONT_FILES) as (keyof BrandFonts)[]).map(async (k) => [k, new Uint8Array(await readFile(join(DIR, "fonts", FONT_FILES[k])))] as const),
    );
    return Object.fromEntries(entries) as unknown as BrandFonts;
  } catch {
    return null;
  }
}

async function loadLogo(): Promise<BrandAssets["logo"]> {
  try {
    return { bytes: new Uint8Array(await readFile(join(DIR, "launchtime-logo.png"))), mime: "image/png" };
  } catch {
    return null;
  }
}

let cached: Promise<BrandAssets> | null = null;

/** The brand fonts and default logo, read once. Never throws. */
export function loadBrandAssets(): Promise<BrandAssets> {
  cached ??= Promise.all([loadFonts(), loadLogo()]).then(([fonts, logo]) => ({ fonts, logo }));
  return cached;
}
