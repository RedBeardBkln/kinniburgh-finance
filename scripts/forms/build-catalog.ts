/**
 * Generate the field catalogs for every blank form in data/forms/manifest.json:
 * data/forms/2025/catalog/<formId>.fields.json (committed), and refresh the
 * manifest's derived columns (pages, fieldCount, sourceKind) from the PDFs.
 *
 *   pnpm forms:catalog
 *
 * Dev tool. The blank PDF is sha256-verified before it is read, so a catalog can
 * only ever describe a pinned file.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildCatalog, serializeCatalog } from "../../lib/tax2025/pdf/catalog";
import { catalogPath, getBlankBytes, loadManifest, manifestPath, type ManifestEntry } from "../../lib/tax2025/pdf/registry";

async function main(): Promise<void> {
  const manifest = loadManifest();
  const updated: ManifestEntry[] = [];
  for (const entry of manifest.forms) {
    const bytes = getBlankBytes(entry.formId);
    const catalog = await buildCatalog(entry.formId, bytes);
    const sourceKind: ManifestEntry["sourceKind"] = catalog.hadXfa ? "acroform_hybrid_xfa" : "flat";
    if (!catalog.hadXfa && catalog.fieldCount > 0) {
      throw new Error(`${entry.formId}: AcroForm without XFA is not a known source kind; extend SOURCE_KINDS deliberately`);
    }
    const target = catalogPath(entry.formId);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, serializeCatalog(catalog), "utf8");
    updated.push({ ...entry, pages: catalog.pages, fieldCount: catalog.fieldCount, sourceKind });
    console.log(
      `${entry.formId.padEnd(9)} pages=${catalog.pages} fields=${catalog.fieldCount} kind=${sourceKind}` +
        ` xfaOnly=${catalog.xfaOnlyFields.length} acroOnly=${catalog.acroOnlyFields.length}`,
    );
  }
  writeFileSync(manifestPath(), JSON.stringify({ schemaVersion: 1, taxYear: 2025, forms: updated }, null, 2) + "\n", "utf8");
  console.log(`\nWrote ${updated.length} catalogs and refreshed the manifest.`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
