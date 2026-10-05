/**
 * Source pack fetcher for the AI Return Reviewer (ai-return-reviewer, plan 5.5.4).
 *
 *   node_modules/.bin/tsx scripts/tax-sources/fetch.ts            # download the pinned sources, extract text, write the pack
 *   node_modules/.bin/tsx scripts/tax-sources/fetch.ts --verify   # offline: check the committed text files against the manifest
 *   node_modules/.bin/tsx scripts/tax-sources/fetch.ts --accept-changes   # re-pin a source whose PDF changed at the publisher
 *
 * Writes data/tax-sources/2025/<id>.txt (text extracted with `pdftotext`, pages separated by a form feed) and
 * data/tax-sources/2025/manifest.json (url, retrievedOn, sha256 of the PDF and of the text, page count).
 * Same discipline as data/forms/manifest.json: a PDF whose sha256 differs from the manifest FAILS the run unless
 * --accept-changes is given (a re-issued source is a deliberate, reviewed change).
 *
 * Network: HTTPS only, and ONLY the hosts in ALLOWED_HOSTS (irs.gov, portal.ct.gov); a redirect to another host is refused.
 * Nothing here touches the database, reads an environment secret or sends any tax data anywhere.
 * The pack is used at review time ONLY as local text (lib/tax-review/llm/sources.ts); nothing is fetched while a review runs.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const ALLOWED_HOSTS: readonly string[] = ["www.irs.gov", "irs.gov", "portal.ct.gov"];

export interface SourceSpec {
  id: string;
  title: string;
  url: string;
}

const IRS = "https://www.irs.gov/pub/irs-prior";

/** The pinned 2025 sources. Keep this list small: only what the review passes cite. */
export const SOURCES: readonly SourceSpec[] = [
  { id: "i1040gi", title: "2025 Instructions for Form 1040 and Form 1040-SR", url: `${IRS}/i1040gi--2025.pdf` },
  { id: "i1040sa", title: "2025 Instructions for Schedule A (Itemized Deductions)", url: `${IRS}/i1040sca--2025.pdf` },
  { id: "i1040sb", title: "2025 Instructions for Schedule B (Interest and Ordinary Dividends)", url: `${IRS}/i1040sb--2025.pdf` },
  { id: "i1040sc", title: "2025 Instructions for Schedule C (Profit or Loss From Business)", url: `${IRS}/i1040sc--2025.pdf` },
  { id: "i1040sd", title: "2025 Instructions for Schedule D (Capital Gains and Losses)", url: `${IRS}/i1040sd--2025.pdf` },
  { id: "i1040sse", title: "2025 Instructions for Schedule SE (Self-Employment Tax)", url: `${IRS}/i1040sse--2025.pdf` },
  { id: "i8949", title: "2025 Instructions for Form 8949 (Sales and Other Dispositions of Capital Assets)", url: `${IRS}/i8949--2025.pdf` },
  { id: "i8959", title: "2025 Instructions for Form 8959 (Additional Medicare Tax)", url: `${IRS}/i8959--2025.pdf` },
  { id: "i8960", title: "2025 Instructions for Form 8960 (Net Investment Income Tax)", url: `${IRS}/i8960--2025.pdf` },
  { id: "i8995", title: "2025 Instructions for Form 8995 (Qualified Business Income Deduction)", url: `${IRS}/i8995--2025.pdf` },
  { id: "i2210", title: "2025 Instructions for Form 2210 (Underpayment of Estimated Tax)", url: `${IRS}/i2210--2025.pdf` },
  { id: "p936", title: "2025 Publication 936 (Home Mortgage Interest Deduction)", url: `${IRS}/p936--2025.pdf` },
  { id: "p587", title: "2025 Publication 587 (Business Use of Your Home)", url: `${IRS}/p587--2025.pdf` },
  { id: "ct1040i", title: "2025 Connecticut Form CT-1040 instructions (Department of Revenue Services)", url: "https://portal.ct.gov/-/media/drs/forms/2025/income/2025-ct-1040-instructions_1225.pdf" },
];

export interface ManifestEntry {
  id: string;
  title: string;
  url: string;
  retrievedOn: string;
  pdfSha256: string;
  pdfBytes: number;
  textSha256: string;
  textBytes: number;
  pages: number;
}

export interface Manifest {
  version: 1;
  taxYear: 2025;
  /** Tool used for the text: pdftotext without -layout (two-column pages stay readable). */
  extractor: string;
  sources: ManifestEntry[];
}

export function hostAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
}

const sha256 = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

const PACK_DIR = path.join(process.cwd(), "data", "tax-sources", "2025");

async function download(url: string): Promise<Uint8Array> {
  if (!hostAllowed(url)) throw new Error(`refused: ${url} is not on the allow-list (${ALLOWED_HOSTS.join(", ")})`);
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  if (!hostAllowed(res.url)) throw new Error(`refused: redirect to a host that is not on the allow-list (${new URL(res.url).hostname})`);
  return new Uint8Array(await res.arrayBuffer());
}

function extractText(pdf: Uint8Array): string {
  const dir = mkdtempSync(path.join(tmpdir(), "tax-sources-"));
  try {
    const file = path.join(dir, "in.pdf");
    writeFileSync(file, pdf);
    return execFileSync("pdftotext", [file, "-"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).replace(/\r/g, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function readManifest(): Manifest | null {
  const file = path.join(PACK_DIR, "manifest.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Manifest) : null;
}

function verify(): number {
  const manifest = readManifest();
  if (manifest === null) {
    console.error("no manifest");
    return 1;
  }
  let bad = 0;
  for (const s of manifest.sources) {
    const file = path.join(PACK_DIR, `${s.id}.txt`);
    if (!existsSync(file)) {
      console.error(`${s.id}: text file missing`);
      bad += 1;
      continue;
    }
    if (sha256(readFileSync(file, "utf8").replace(/\r/g, "")) !== s.textSha256) {
      console.error(`${s.id}: text sha256 differs from the manifest`);
      bad += 1;
    }
  }
  console.log(bad === 0 ? `verified ${manifest.sources.length} sources` : `${bad} problem(s)`);
  return bad === 0 ? 0 : 1;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--verify")) process.exit(verify());
  const accept = args.includes("--accept-changes");
  const previous = readManifest();
  mkdirSync(PACK_DIR, { recursive: true });
  const retrievedOn = new Date().toISOString().slice(0, 10);
  const entries: ManifestEntry[] = [];
  let failed = 0;
  for (const spec of SOURCES) {
    try {
      const pdf = await download(spec.url);
      const pdfSha = sha256(pdf);
      const before = previous?.sources.find((s) => s.id === spec.id);
      if (before !== undefined && before.pdfSha256 !== pdfSha && !accept) {
        console.error(`${spec.id}: the PDF changed at the publisher (sha256 differs); re-run with --accept-changes after reviewing`);
        failed += 1;
        if (before !== undefined) entries.push(before);
        continue;
      }
      const text = extractText(pdf);
      writeFileSync(path.join(PACK_DIR, `${spec.id}.txt`), text, "utf8");
      entries.push({
        id: spec.id,
        title: spec.title,
        url: spec.url,
        retrievedOn: before !== undefined && before.pdfSha256 === pdfSha ? before.retrievedOn : retrievedOn,
        pdfSha256: pdfSha,
        pdfBytes: pdf.byteLength,
        textSha256: sha256(text),
        textBytes: Buffer.byteLength(text, "utf8"),
        pages: text.split("\f").length - 1,
      });
      console.log(`${spec.id}: ${entries[entries.length - 1]?.pages} pages, ${Buffer.byteLength(text, "utf8")} bytes`);
    } catch (err) {
      console.error(`${spec.id}: failed (${err instanceof Error ? err.message : "unknown error"})`);
      failed += 1;
    }
  }
  if (failed === 0) {
    const manifest: Manifest = { version: 1, taxYear: 2025, extractor: "pdftotext (xpdf) without -layout; pages separated by a form feed", sources: entries };
    writeFileSync(path.join(PACK_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    console.log(`wrote manifest with ${entries.length} sources`);
  }
  process.exit(failed === 0 ? 0 : 1);
}

if (process.argv[1] !== undefined && /fetch\.ts$/.test(process.argv[1].replace(/\\/g, "/"))) {
  void main();
}
