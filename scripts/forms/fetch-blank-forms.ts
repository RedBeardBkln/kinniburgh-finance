/**
 * Download the blank TY2025 forms listed in data/forms/manifest.json into
 * data/forms/2025/<formId>.pdf and verify each against its pinned sha256.
 *
 *   pnpm forms:fetch            # download missing files, verify all
 *   pnpm forms:fetch -- --force # re-download even when a file already exists
 *
 * Fails loudly (non-zero exit) on: a URL host outside the allowlist, a non-PDF
 * response, or a sha256 / byte-count mismatch. A re-issued form is a deliberate,
 * reviewed change: update the manifest hash AND regenerate the catalog and the
 * line maps' golden tests. A mismatching download is never written to disk.
 *
 * Dev tool only: never run in CI or at request time.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { blankPath, isAllowedUrl, loadManifest, sha256Hex } from "../../lib/tax2025/pdf/registry";

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function isPdf(bytes: Uint8Array): boolean {
  return bytes.length > 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
}

async function main(): Promise<void> {
  const force = process.argv.includes("--force");
  const manifest = loadManifest();
  const failures: string[] = [];
  let downloaded = 0;
  let verifiedExisting = 0;

  for (const entry of manifest.forms) {
    if (!isAllowedUrl(entry.url)) {
      failures.push(`${entry.formId}: URL host not allowed: ${entry.url}`);
      continue;
    }
    const target = blankPath(entry.formId);
    if (existsSync(target) && !force) {
      const actual = sha256Hex(new Uint8Array(readFileSync(target)));
      if (actual === entry.sha256) {
        verifiedExisting += 1;
        console.log(`ok (existing)  ${entry.formId}`);
        continue;
      }
      failures.push(`${entry.formId}: existing file sha256 ${actual} != manifest ${entry.sha256} (use --force to re-download)`);
      continue;
    }
    const res = await fetch(entry.url, { headers: { "User-Agent": USER_AGENT, Accept: "application/pdf" } });
    if (!res.ok) {
      failures.push(`${entry.formId}: HTTP ${res.status} for ${entry.url}`);
      continue;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!isPdf(bytes)) {
      failures.push(`${entry.formId}: response is not a PDF (no %PDF- header)`);
      continue;
    }
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256 || bytes.length !== entry.bytes) {
      failures.push(
        `${entry.formId}: MISMATCH sha256 ${actual} (${bytes.length} bytes), manifest ${entry.sha256} (${entry.bytes} bytes). Not written.`,
      );
      continue;
    }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, bytes);
    downloaded += 1;
    console.log(`ok (downloaded) ${entry.formId} ${bytes.length} bytes`);
  }

  console.log(`\n${downloaded} downloaded, ${verifiedExisting} already present and verified, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.error(`FAIL ${f}`);
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
