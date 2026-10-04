import { describe, it, expect } from "vitest";
import { parseDollarsToCents } from "@/lib/money-input";
import { parseIsoDateNoonUtc, taxYearBoundsUtc, taxYearOfDate, formatDateEt, toIsoDateInput } from "@/lib/tax-log-dates";
import { flagsForDonation, flagsForYear, loggedTotals } from "@/lib/donation-substantiation";
import { isNoneConfirmed } from "@/lib/tax-none-confirmation";
import { normalizeDonationInput } from "@/lib/donations";
import { normalizeFixedAssetInput, countEkcAssetsForYear, countBuildingAssetsForYear } from "@/lib/fixed-assets";
import { computePersonalFormPlan, computePersonalFormPlanBasis, type PersonalFormPlanInput } from "@/lib/tax-form-plan";
import { PERSONAL_FORM_PLAN, TAX_QUESTION_BANK, withoutSuddenValleyItems } from "@/lib/tax-guidance";
import { resolveFieldFixes, type FixContext } from "@/lib/tax-form-fixes";
import { buildFormsPageData, type FormsCatalogInput, type FormsEntityInput, type FormEntry, type FormsPageData } from "@/lib/tax-forms";

// Independent Tester probes (donation-log-and-fixed-assets).

describe("money parsing probes", () => {
  const ok = (s: string, cents: number) => expect(parseDollarsToCents(s), s).toEqual({ ok: true, cents });
  const bad = (s: string) => expect(parseDollarsToCents(s).ok, JSON.stringify(s)).toBe(false);

  it("accepts", () => {
    ok("1,234.50", 123450);
    ok("$1,234.50", 123450);
    ok("  $19.99  ", 1999);
    ok("1.15", 115);
    ok("0.07", 7);
    ok("0.10", 10);
  });
  it("rejects expression / junk / sign / precision", () => {
    for (const s of [
      "0.1+0.2", "1+1", "$", "$-5", "-5", "-0", "+5", "12.345", "1.234,5", "1,23", "1,2345", "12,34", ",123",
      "1e3", "0x10", ".5", "$.50", "5.", "", "   ", "abc", "1 000", "1_000", "NaN", "Infinity", "１２", "$ 5",
      "1,234.5.0", "1..5", "--5",
    ]) bad(s);
  });
  it("zero and ceiling", () => {
    bad("0");
    bad("0.00");
    expect(parseDollarsToCents("0", { allowZero: true })).toEqual({ ok: true, cents: 0 });
    ok("21474836.47", 2147483647);
    bad("21474836.48");
    bad("99999999999999999999");
    bad("21,474,836.48");
    ok("00000000000000000005", 500);
  });
  it("non-string input does not throw", () => {
    expect(parseDollarsToCents(undefined as unknown as string).ok).toBe(false);
    expect(parseDollarsToCents(null as unknown as string).ok).toBe(false);
    expect(parseDollarsToCents(5 as unknown as string).ok).toBe(false);
  });
});

describe("date / tax-year boundary probes", () => {
  it("stored noon UTC displays as the SAME calendar day in ET and derives the right year", () => {
    const dec31 = parseIsoDateNoonUtc("2025-12-31")!;
    const jan1 = parseIsoDateNoonUtc("2026-01-01")!;
    expect(formatDateEt(dec31)).toBe("Dec 31, 2025");
    expect(formatDateEt(jan1)).toBe("Jan 1, 2026");
    expect(taxYearOfDate(dec31)).toBe(2025);
    expect(taxYearOfDate(jan1)).toBe(2026);
    expect(toIsoDateInput(dec31)).toBe("2025-12-31");
    const b25 = taxYearBoundsUtc(2025);
    expect(dec31 >= b25.start && dec31 < b25.endExclusive).toBe(true);
    expect(jan1 >= b25.start && jan1 < b25.endExclusive).toBe(false);
    // half-open: the exact instant of next Jan 1 00:00Z is out, one ms before is in
    expect(new Date(b25.endExclusive.getTime() - 1) < b25.endExclusive).toBe(true);
  });
  it("rejects bad dates", () => {
    for (const s of ["2025-02-30", "2025-13-01", "25-1-1", "1999-12-31", "2101-01-01", "2025-2-3", "2025-04-31", "", "2025-12-31T23:00:00Z", "2025/12/31"])
      expect(parseIsoDateNoonUtc(s), s).toBeNull();
    expect(parseIsoDateNoonUtc("2024-02-29")).not.toBeNull();
    expect(parseIsoDateNoonUtc("2025-02-29")).toBeNull();
    expect(parseIsoDateNoonUtc("2000-01-01")).not.toBeNull();
    expect(parseIsoDateNoonUtc("2100-12-31")).not.toBeNull();
  });
  it("normalizeDonationInput on 2025-12-31 gives year 2025 / 2026-01-01 gives 2026", () => {
    const base = { recipient: "X", amount: "10", kind: "cash", substantiation: "none" };
    const a = normalizeDonationInput({ ...base, date: "2025-12-31" });
    const b = normalizeDonationInput({ ...base, date: "2026-01-01" });
    expect(a.ok && taxYearOfDate(a.value.date)).toBe(2025);
    expect(b.ok && taxYearOfDate(b.value.date)).toBe(2026);
  });
  it("a DST-edge ET evening instant is still within its ET year only if the app stored noon (documented)", () => {
    // 2025-12-31 23:30 ET == 2026-01-01T04:30Z. The app never stores such an instant (always noon UTC).
    const lateEvening = new Date("2026-01-01T04:30:00Z");
    expect(taxYearOfDate(lateEvening)).toBe(2026); // would be wrong for ET, but cannot occur via parseIsoDateNoonUtc
  });
});

describe("substantiation boundary probes", () => {
  const f = (amountCents: number, kind: string, substantiation: string, receiptDocumentId: string | null = null) =>
    flagsForDonation({ amountCents, kind, substantiation, receiptDocumentId }).map((x) => x.code);
  it("$249.99 vs $250.00", () => {
    expect(f(24999, "cash", "none")).toEqual(["cash_no_record"]);
    expect(f(24999, "cash", "bank_record")).toEqual([]);
    expect(f(25000, "cash", "none")).toEqual(["ack_needed_250"]);
    expect(f(25000, "cash", "bank_record")).toEqual(["ack_needed_250"]);
    expect(f(25000, "cash", "written_acknowledgment")).toEqual(["ack_not_uploaded"]);
    expect(f(25000, "cash", "written_acknowledgment", "doc")).toEqual([]);
    expect(f(24999, "noncash", "none")).toEqual(["noncash_no_record"]);
    expect(f(25000, "noncash", "none")).toEqual(["ack_needed_250"]);
    expect(f(24999, "noncash", "written_acknowledgment", "d")).toEqual([]);
  });
  const row = (amountCents: number, kind = "noncash", archivedAt: Date | null = null) => ({
    amountCents, kind, substantiation: "none", receiptDocumentId: null, archivedAt,
  });
  it("noncash $500.00 vs $500.01 per YEAR total", () => {
    expect(flagsForYear([row(50000)])).toEqual([]);
    expect(flagsForYear([row(50001)]).map((x) => x.code)).toEqual(["noncash_over_500_form_8283"]);
    // aggregated across gifts
    expect(flagsForYear([row(30000), row(20000)])).toEqual([]);
    expect(flagsForYear([row(30000), row(20001)]).map((x) => x.code)).toEqual(["noncash_over_500_form_8283"]);
    // archived and cash excluded
    expect(flagsForYear([row(30000), row(20001, "noncash", new Date())])).toEqual([]);
    expect(flagsForYear([row(30000), row(20001, "cash")])).toEqual([]);
    expect(flagsForYear([row(50001, "noncash", new Date())])).toEqual([]);
    const f = flagsForYear([row(50001)])[0]!;
    expect(f.level).toBe("cpa");
    expect(f.message).toMatch(/You decide/);
  });
  it("loggedTotals excludes archived and does not compute a deduction", () => {
    expect(loggedTotals([row(100, "cash"), row(200, "noncash"), row(999, "cash", new Date())])).toEqual({ cashCents: 100, noncashCents: 200 });
  });
});

describe("none predicate probes", () => {
  const q = (answer: unknown, skippedReason: string | null = null, key = "donations_none") => [{ key, answer, skippedReason }];
  it("needs EXACT none", () => {
    expect(isNoneConfirmed(q("none"), "donations_none")).toBe(true);
    for (const a of ["some", "None", "NONE", " none", "none ", "", null, undefined, 0, false, ["none"], { v: "none" }])
      expect(isNoneConfirmed(q(a), "donations_none"), JSON.stringify(a)).toBe(false);
    expect(isNoneConfirmed(q("none", "skipped"), "donations_none")).toBe(false);
    expect(isNoneConfirmed([], "donations_none")).toBe(false);
    expect(isNoneConfirmed(q("none", null, "other"), "donations_none")).toBe(false);
  });
});

describe("fixed asset normalizer probes", () => {
  const base = {
    description: "Bldg", placedInServiceDate: "2025-01-01", costBasis: "100000", isRealProperty: true,
    landValue: "20000", businessUsePercent: 100,
  };
  it("rules", () => {
    expect(normalizeFixedAssetInput(base).ok).toBe(true);
    expect(normalizeFixedAssetInput({ ...base, landValue: "100000" }).ok).toBe(true);
    expect(normalizeFixedAssetInput({ ...base, landValue: "0" }).ok).toBe(true);
    expect(normalizeFixedAssetInput({ ...base, landValue: "100000.01" }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, landValue: null }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, landValue: "  " }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, landValue: "-1" }).ok).toBe(false);
    const eq = normalizeFixedAssetInput({ ...base, isRealProperty: false, landValue: "5" });
    expect(eq.ok && eq.value.landValueCents).toBeNull();
    for (const bu of [0, 101, -1, 50.5, Number.NaN, "100" as unknown as number]) expect(normalizeFixedAssetInput({ ...base, businessUsePercent: bu }).ok, String(bu)).toBe(false);
    for (const bu of [1, 100]) expect(normalizeFixedAssetInput({ ...base, businessUsePercent: bu }).ok).toBe(true);
    expect(normalizeFixedAssetInput({ ...base, costBasis: "0" }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, description: "   " }).ok).toBe(false);
    expect(normalizeFixedAssetInput({ ...base, invoiceDocumentId: "not-a-uuid" }).ok).toBe(false);
    expect(normalizeFixedAssetInput(null).ok).toBe(false);
    expect(normalizeFixedAssetInput(undefined).ok).toBe(false);
  });
  it("donation normalizer", () => {
    const d = { date: "2025-05-05", recipient: "R", amount: "5", kind: "cash", substantiation: "none" };
    expect(normalizeDonationInput(d).ok).toBe(true);
    expect(normalizeDonationInput({ ...d, kind: "noncash", substantiation: "bank_record" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...d, kind: "noncash", substantiation: "written_acknowledgment" }).ok).toBe(true);
    expect(normalizeDonationInput({ ...d, receiptDocumentId: "x" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...d, kind: "weird" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...d, recipient: "   " }).ok).toBe(false);
    expect(normalizeDonationInput({ ...d, recipient: "x".repeat(201) }).ok).toBe(false);
    expect(normalizeDonationInput({ ...d, amount: "-5" }).ok).toBe(false);
    expect(normalizeDonationInput({ ...d, entityId: "evil" }).ok).toBe(true); // extra key is stripped, never forwarded
    const n = normalizeDonationInput({ ...d, entityId: "evil" });
    expect(n.ok && Object.keys(n.value)).not.toContain("entityId");
  });
});

describe("asset year counting probes", () => {
  const A = (entityId: string, iso: string, isRealProperty = false, landValueCents: number | null = null) => ({
    entityId, placedInServiceDate: parseIsoDateNoonUtc(iso)!, isRealProperty, landValueCents,
  });
  it("EKC", () => {
    expect(countEkcAssetsForYear([A("e", "2025-12-31")], "e", 2025)).toBe(1);
    expect(countEkcAssetsForYear([A("e", "2026-01-01")], "e", 2025)).toBe(0);
    expect(countEkcAssetsForYear([A("e", "2019-06-01")], "e", 2025)).toBe(1);
    expect(countEkcAssetsForYear([A("s", "2025-01-01")], "e", 2025)).toBe(0);
    expect(countEkcAssetsForYear([A("e", "2025-01-01")], null, 2025)).toBe(0);
  });
  it("SV building", () => {
    expect(countBuildingAssetsForYear([A("s", "2026-02-01", false)], "s", 2026)).toBe(0);
    expect(countBuildingAssetsForYear([A("s", "2026-02-01", true, null)], "s", 2026)).toBe(0);
    expect(countBuildingAssetsForYear([A("s", "2026-02-01", true, 0)], "s", 2026)).toBe(1);
    expect(countBuildingAssetsForYear([A("s", "2026-02-01", true, 5)], "s", 2025)).toBe(0);
    expect(countBuildingAssetsForYear([A("e", "2026-02-01", true, 5)], "s", 2026)).toBe(0);
  });
});

// ── plan / fixes / catalog ────────────────────────────────────────────────────
const EMPTY: PersonalFormPlanInput = {
  documents: [], questions: [], ekConsultingPL: null, suddenValleyPL: null, ekConsultingMileageCount: 0,
  solarLoanOriginalCostCents: null, donationCount: 0, ekConsultingFixedAssetCount: 0, suddenValleyBuildingAssetCount: 0,
};
const LINES = ["Gifts to charity (line 11)", "Depreciation (line 13)", "Depreciation (line 18)"] as const;

describe("plan basis consistency and every-line fix handler", () => {
  it("basis !== missing iff haveData over a matrix of inputs, 24 fields / 6 forms", () => {
    const answers: unknown[] = ["none", "some", null];
    for (const a of answers) for (const skip of [null, "skipped"]) for (const d of [0, 1]) for (const e of [0, 2]) for (const s of [0, 1]) {
      const questions = ["donations_none", "fixed_assets_ekc", "fixed_assets_sv"].map((key) => ({ key, answer: a, skippedReason: skip as string | null }));
      const input = { ...EMPTY, questions, donationCount: d, ekConsultingFixedAssetCount: e, suddenValleyBuildingAssetCount: s };
      const plan = computePersonalFormPlan(input);
      expect(plan.length).toBe(6);
      const flat = plan.flatMap((f) => f.fields);
      expect(flat.length).toBe(24);
      const basis = computePersonalFormPlanBasis(input);
      for (const fld of flat) expect(basis[fld.line] !== "missing", fld.line).toBe(fld.haveData);
      for (const line of LINES) {
        const have = flat.find((x) => x.line === line)!.haveData;
        const cnt = line === LINES[0] ? d : line === LINES[1] ? e : s;
        expect(have, `${line} a=${String(a)} skip=${skip}`).toBe(cnt > 0 || (a === "none" && skip === null));
      }
    }
  });
  it("D5: entries after none -> still satisfied; none then archived entries -> still satisfied by none", () => {
    const questions = [{ key: "donations_none", answer: "none", skippedReason: null }];
    const f = (n: number) => computePersonalFormPlan({ ...EMPTY, questions, donationCount: n }).flatMap((x) => x.fields).find((x) => x.line === LINES[0])!.haveData;
    expect(f(0)).toBe(true);
    expect(f(3)).toBe(true);
  });
  it("every PERSONAL_FORM_PLAN line has a fix handler, with the entity missing too", () => {
    const base: FixContext = {
      taxYear: 2025, personalEntityId: "p", ekcSlug: "ek-consulting", svSlug: "sudden-valley", ekcEntityId: "e", svEntityId: "s",
      questions: [], documents: [], lineHasData: Object.fromEntries(PERSONAL_FORM_PLAN.flatMap((f) => f.fields.map((x) => [x.line, false]))),
    };
    for (const form of PERSONAL_FORM_PLAN) for (const field of form.fields) {
      expect(resolveFieldFixes(field.line, base), field.line).not.toHaveLength(0);
      expect(resolveFieldFixes(field.line, { ...base, personalEntityId: null, ekcEntityId: null, svEntityId: null }), field.line).not.toHaveLength(0);
    }
    const kinds = (l: string, c = base) => resolveFieldFixes(l, c).map((f) => f.kind);
    expect(kinds(LINES[0])).toEqual(["donation", "confirm_none", "link"]);
    expect(kinds(LINES[1])).toEqual(["fixed_asset", "confirm_none", "link"]);
    expect(kinds(LINES[2])).toEqual(["fixed_asset", "confirm_none", "link"]);
    expect(kinds(LINES[0], { ...base, personalEntityId: null })).toEqual(["none"]);
    expect(kinds(LINES[1], { ...base, ekcEntityId: null })).toEqual(["none"]);
    expect(kinds(LINES[2], { ...base, svEntityId: null })).toEqual(["none"]);
    const a = resolveFieldFixes(LINES[1], base).find((f) => f.kind === "fixed_asset");
    const b = resolveFieldFixes(LINES[2], base).find((f) => f.kind === "fixed_asset");
    expect(a && a.kind === "fixed_asset" && a.entityId).toBe("e");
    expect(a && a.kind === "fixed_asset" && a.realProperty).toBe(false);
    expect(b && b.kind === "fixed_asset" && b.entityId).toBe("s");
    expect(b && b.kind === "fixed_asset" && b.realProperty).toBe(true);
    // 'some' answer must NOT suppress the confirm chip
    const some = [{ key: "donations_none", answer: "some", skippedReason: null }];
    expect(kinds(LINES[0], { ...base, questions: some })).toContain("confirm_none");
    const none = [{ key: "donations_none", answer: "none", skippedReason: null }];
    expect(kinds(LINES[0], { ...base, questions: none })).not.toContain("confirm_none");
    // hrefs
    const link = resolveFieldFixes(LINES[1], base).find((f) => f.kind === "link");
    expect(link && link.kind === "link" && link.href).toBe("/tax/fixed-assets/2025");
  });
});

describe("question bank probes", () => {
  it("3 keys; SV-hide only for fixed_assets_sv", () => {
    for (const k of ["donations_none", "fixed_assets_ekc", "fixed_assets_sv"]) {
      const def = TAX_QUESTION_BANK.find((x) => x.key === k)!;
      expect(def).toBeTruthy();
      expect(def.context.length).toBeGreaterThan(60);
      expect(def.options!.map((o) => o.value)).toEqual(["none", "some"]);
      for (const o of def.options!) expect(o.note.length).toBeGreaterThan(40);
    }
    const bank = withoutSuddenValleyItems(TAX_QUESTION_BANK, false).map((x) => x.key);
    expect(bank).not.toContain("fixed_assets_sv");
    expect(bank).toContain("fixed_assets_ekc");
    expect(bank).toContain("donations_none");
    expect(new Set(TAX_QUESTION_BANK.map((x) => x.key)).size).toBe(TAX_QUESTION_BANK.length);
  });
});

describe("Forms catalog: SV inactive year hides line 18", () => {
  const PERSONAL: FormsEntityInput = { id: "ent-personal", name: "Personal", slug: "personal", type: "personal", foundedDate: null, taxStatusNotes: null };
  const EKC: FormsEntityInput = { id: "ent-ekc", name: "EKC", slug: "ek-consulting", type: "business", foundedDate: null, taxStatusNotes: "disregarded" };
  const SV: FormsEntityInput = { id: "ent-sv", name: "SV", slug: "sudden-valley", type: "business", foundedDate: new Date("2026-02-01"), taxStatusNotes: null };
  const mk = (taxYear: number): FormsCatalogInput => ({
    taxYear, people: [], entities: [PERSONAL, EKC, SV], documents: [], questions: [], personalWorkspaceExists: true, workspaceIds: {}, checklists: {},
    formPlanInput: EMPTY, taxDraft: { status: "not_computed" },
  });
  const all = (d: FormsPageData): FormEntry[] => [...d.federal, ...d.connecticut, ...d.needsCpaInput, ...d.entities.flatMap((s) => s.entries)];
  it("2025 (SV inactive): no entry carries Depreciation (line 18); 2026: it does", () => {
    const has = (d: FormsPageData) => all(d).some((e) => e.fields.some((f) => f.line === "Depreciation (line 18)"));
    expect(has(buildFormsPageData(mk(2025)))).toBe(false);
    expect(has(buildFormsPageData(mk(2026)))).toBe(true);
  });
});
