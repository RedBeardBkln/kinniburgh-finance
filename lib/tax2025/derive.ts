// Small PURE derivations the loader needs before resolveFacts(): who owns EK
// Consulting, which address is the primary residence, and how the Planning answers
// (raw TaxQuestion rows) map onto RawPlanning. Anything inferred is returned with
// basis "derived" and a note saying how, so the sheet can ask the owner to confirm;
// nothing here ever guesses silently.

import { addressesMatch, normalizeAddress, type RawDocument, type RawPlanning, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";

// ── Schedule C owner ─────────────────────────────────────────────────────────

/**
 * The household member whose name matches the single-member LLC's name
 * ("Eric Kinniburgh Consulting, LLC" -> the user named Eric Kinniburgh). A full-name
 * match beats a first-name match; ties or no match -> null (the sheet then asks).
 */
export function inferScheduleCOwner(
  entityName: string,
  users: readonly { id: string; name: string }[]
): RawTy2025Inputs["scheduleCOwner"] {
  const entity = entityName.toLowerCase().replace(/\s+/g, " ").trim();
  const entityFirst = entity.split(" ")[0] ?? "";
  const scored = users
    .map((u) => {
      const name = u.name.toLowerCase().replace(/\s+/g, " ").trim();
      const first = name.split(" ")[0] ?? "";
      const score = name !== "" && entity.includes(name) ? 2 : first.length >= 3 && first === entityFirst ? 1 : 0;
      return { user: u, score };
    })
    .filter((s) => s.score > 0);
  if (scored.length === 0) return null;
  const best = Math.max(...scored.map((s) => s.score));
  const winners = scored.filter((s) => s.score === best);
  if (winners.length !== 1) return null;
  return {
    userId: winners[0]!.user.id,
    basis: "derived",
    note: `${winners[0]!.user.name} matches the entity name "${entityName}"`,
  };
}

// ── Primary residence ────────────────────────────────────────────────────────

/** The one property address that appears on a home mortgage Form 1098 for the year; null if none or more than one. */
export function inferPrimaryResidence(
  documents: readonly RawDocument[],
  taxYear: number
): RawTy2025Inputs["primaryResidence"] {
  const addresses: string[] = [];
  for (const d of documents) {
    if (d.taxYear !== taxYear || (d.docType !== "mortgage_interest" && d.docType !== "form_1098")) continue;
    const data = (d.extractionData as { data?: Record<string, unknown> } | null)?.data;
    const addr = typeof data?.propertyAddress === "string" ? data.propertyAddress.trim() : "";
    if (addr !== "" && !addresses.some((a) => addressesMatch(a, addr))) addresses.push(addr);
  }
  if (addresses.length !== 1) return null;
  return {
    address: addresses[0]!,
    basis: "derived",
    note: `the address on the home mortgage Form 1098 (${normalizeAddress(addresses[0]!)})`,
  };
}

// ── Planning answers ─────────────────────────────────────────────────────────

export interface PlanningRow {
  key: string;
  answer: unknown;
  skippedReason: string | null;
}

export interface PlanningParsers {
  parseDollarAnswerToCents: (answer: unknown, skippedReason: string | null) => { cents: number | null; unparseable: boolean };
  parseSqftAnswer: (answer: unknown, skippedReason: string | null) => { sqft: number | null; unparseable: boolean };
}

/** Maps raw TaxQuestion rows onto RawPlanning. An unanswered or skipped question is null / false, never a default answer. */
export function planningFromRows(rows: readonly PlanningRow[], parsers: PlanningParsers): RawPlanning {
  const row = (key: string): PlanningRow | undefined => rows.find((r) => r.key === key);
  const text = (key: string): string | null => {
    const r = row(key);
    if (!r || r.skippedReason !== null || typeof r.answer !== "string") return null;
    const t = r.answer.trim();
    return t === "" ? null : t;
  };
  const dollars = (key: string): number | null => {
    const r = row(key);
    return parsers.parseDollarAnswerToCents(r?.answer ?? null, r?.skippedReason ?? null).cents;
  };
  const sqftRow = row("home_office_sqft");
  return {
    filingStatus: text("filing_status"),
    householdMembers: text("household_members"),
    evVehicle: text("ev_vehicle"),
    businessMileage: text("business_mileage"),
    homeOfficeEligibility: text("home_office_ekc"),
    homeOfficeSqft: parsers.parseSqftAnswer(sqftRow?.answer ?? null, sqftRow?.skippedReason ?? null).sqft,
    solarCredit: text("solar_credit"),
    // "none" is the only answer that satisfies these (a stricter test than "answered"): see lib/tax-none-confirmation.ts
    donationsNone: text("donations_none") === "none",
    fixedAssetsEkcNone: text("fixed_assets_ekc") === "none",
    retirementContributionCents: dollars("retirement_contribution_amount"),
    estimatedPaymentsCombinedCents: dollars("estimated_tax_payments_amount"),
  };
}
