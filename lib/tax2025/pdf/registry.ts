// Blank-form registry for the TY2025 PDF engine (plan section 6.2).
//
// data/forms/manifest.json is the single source of truth for which blank forms
// exist, where they came from and what their sha256 is. The PDFs themselves are
// byte-identical first-party downloads (IRS / CT DRS) and are verified against the
// manifest before any use: a re-issued form must be a deliberate, reviewed change
// (scripts/forms/fetch-blank-forms.ts fails loudly on a hash mismatch).
//
// Node-only (fs/path/crypto). Never import this from a client component.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

/** The only hosts a blank form may be downloaded from. */
export const ALLOWED_HOSTS: readonly string[] = ["www.irs.gov", "portal.ct.gov"];

export const SOURCE_KINDS = ["acroform_hybrid_xfa", "flat"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

const manifestEntrySchema = z.object({
  formId: z.string().regex(/^[a-z0-9]+$/),
  title: z.string().min(1),
  taxYear: z.number().int(),
  url: z.string().url(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  bytes: z.number().int().positive(),
  pages: z.number().int().positive(),
  fieldCount: z.number().int().nonnegative(),
  sourceKind: z.enum(SOURCE_KINDS),
  /** "Attachment Sequence No." printed on the form, or null (Form 1040, CT-1040, unknown). */
  attachmentSeq: z.number().int().nullable(),
  retrievedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  taxYear: z.literal(2025),
  forms: z.array(manifestEntrySchema),
});

export type ManifestEntry = z.infer<typeof manifestEntrySchema>;
export type Manifest = z.infer<typeof manifestSchema>;

export const SUPPORTED_YEAR = 2025;

export function formsRoot(): string {
  return path.join(process.cwd(), "data", "forms");
}

export function manifestPath(): string {
  return path.join(formsRoot(), "manifest.json");
}

export function blankPath(formId: string): string {
  return path.join(formsRoot(), String(SUPPORTED_YEAR), `${formId}.pdf`);
}

export function catalogPath(formId: string): string {
  return path.join(formsRoot(), String(SUPPORTED_YEAR), "catalog", `${formId}.fields.json`);
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isAllowedUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

let manifestCache: Manifest | null = null;

/** Parse and validate the manifest (cached per process). Throws on a malformed file. */
export function loadManifest(): Manifest {
  if (manifestCache) return manifestCache;
  const raw = JSON.parse(readFileSync(manifestPath(), "utf8")) as unknown;
  const parsed = manifestSchema.parse(raw);
  const seen = new Set<string>();
  for (const f of parsed.forms) {
    if (seen.has(f.formId)) throw new Error(`Duplicate formId in manifest: ${f.formId}`);
    seen.add(f.formId);
  }
  manifestCache = parsed;
  return parsed;
}

/** Test hook: forget cached manifest and per-process verification results. */
export function resetRegistryCache(): void {
  manifestCache = null;
  verified.clear();
}

export function listFormIds(): string[] {
  return loadManifest().forms.map((f) => f.formId);
}

/** Whitelist check used by routes: only ids present in the manifest are servable. */
export function isKnownFormId(formId: string): boolean {
  return loadManifest().forms.some((f) => f.formId === formId);
}

export function getManifestEntry(formId: string): ManifestEntry {
  const entry = loadManifest().forms.find((f) => f.formId === formId);
  if (!entry) throw new Error(`Unknown form id: ${formId}`);
  return entry;
}

const verified = new Map<string, Uint8Array>();

/**
 * Bytes of the blank PDF for a form. The sha256 is verified against the manifest the
 * first time a form is read in this process (and the verified bytes are kept), so a
 * corrupted or swapped file can never be filled.
 */
export function getBlankBytes(formId: string): Uint8Array {
  const cached = verified.get(formId);
  if (cached) return cached;
  const entry = getManifestEntry(formId);
  const p = blankPath(formId);
  if (!existsSync(p)) throw new Error(`Blank form file missing for ${formId}: ${p}`);
  const bytes = new Uint8Array(readFileSync(p));
  verifyBlankBytes(entry, bytes);
  verified.set(formId, bytes);
  return bytes;
}

/** Throw unless `bytes` are exactly the pinned blank (sha256 and byte count). */
export function verifyBlankBytes(entry: ManifestEntry, bytes: Uint8Array): void {
  const actual = sha256Hex(bytes);
  if (actual !== entry.sha256) {
    throw new Error(`Blank form ${entry.formId} sha256 mismatch: manifest ${entry.sha256}, file ${actual}`);
  }
  if (bytes.length !== entry.bytes) {
    throw new Error(`Blank form ${entry.formId} size mismatch: manifest ${entry.bytes}, file ${bytes.length}`);
  }
}
