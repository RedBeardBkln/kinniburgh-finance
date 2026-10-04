/**
 * PDF gap report: per mapped form, the printed money lines no map claims, the
 * pending line keys still used, and the mapped lines that print blank with the reason.
 *
 *   pnpm tax2025:pdf-gap            # fixture return with every answer given
 *   pnpm tax2025:pdf-gap --empty    # fixture with nothing known yet (every gap visible)
 *
 * Uses the synthetic fixture only: no database, no network, no real data. The report is
 * what the orchestrator relays to the owners of the engine (1a / 1b / Phase 2) so they
 * can add the missing line keys.
 */

import { readFileSync } from "node:fs";
import { emptyFacts, fullFacts } from "../lib/__tests__/tax2025-fixtures";
import { formatGapReport, buildGapReport } from "../lib/tax2025-pdf-gap";
import { toPdfReturnView } from "../lib/tax2025/pdf/adapter";
import type { FormCatalog } from "../lib/tax2025/pdf/catalog";
import { FORM_MAPS } from "../lib/tax2025/pdf/maps";
import { catalogPath } from "../lib/tax2025/pdf/registry";
import { computeTy2025Return } from "../lib/tax2025/return";

function main(): void {
  const empty = process.argv.includes("--empty");
  const facts = empty ? emptyFacts() : fullFacts();
  const ret = computeTy2025Return(facts);
  const view = toPdfReturnView(ret, facts, { generatedAt: "2026-10-03T12:00:00.000Z", generatedBy: "gap script" });

  const catalogs: Record<string, FormCatalog> = {};
  for (const map of FORM_MAPS) {
    catalogs[map.formId] = JSON.parse(readFileSync(catalogPath(map.formId), "utf8")) as FormCatalog;
  }

  const gaps = buildGapReport(view, FORM_MAPS, catalogs);
  console.log(`TY2025 PDF gap report (${empty ? "empty" : "full"} fixture facts, engine ${ret.engineVersion})`);
  console.log(`engine lines: ${Object.keys(ret.lines).length}; mapped forms: ${FORM_MAPS.map((m) => m.formId).join(", ")}\n`);
  console.log(formatGapReport(gaps));
}

main();
