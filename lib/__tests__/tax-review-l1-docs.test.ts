import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { beforeAll, describe, expect, it } from "vitest";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { PdfLine } from "@/lib/tax2025/pdf/types";
import type { RawDocument, RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import type { L1Context } from "@/lib/tax-review/l1/context";
import { doubleCountCheck } from "@/lib/tax-review/l1/double-count";
import { sourceTieoutCheck } from "@/lib/tax-review/l1/source-tieout";
import { docSignature, isUsableFor2025, uniqueDocs, unusableReason } from "@/lib/tax-review/l1/source-docs";
import type { Finding } from "@/lib/tax-review/types";
import { owner } from "./tax2025-fixtures";
import { buildPipeline, cleanScenario, doc, richScenario } from "./tax-review-harness";

let clean: L1Context;
let rich: L1Context;

beforeAll(async () => {
  clean = (await buildPipeline(cleanScenario())).ctx;
  rich = (await buildPipeline(richScenario())).ctx;
});

const run = async (check: { run: (c: L1Context) => Finding[] | Promise<Finding[]> }, ctx: L1Context): Promise<Finding[]> => check.run(ctx);
const has = (f: Finding[], check: string, severity?: string): boolean => f.some((x) => x.check === check && (severity === undefined || x.severity === severity));

/** A copy of the context whose raw documents / view lines / facts can be changed. */
function edited(
  ctx: L1Context,
  edit: { raw?: (raw: RawTy2025Inputs) => void; lines?: (lines: Partial<Record<string, PdfLine>>) => void; facts?: (f: Ty2025Facts) => void }
): L1Context {
  const raw = ctx.raw ? structuredClone(ctx.raw) : null;
  if (raw && edit.raw) edit.raw(raw);
  const view = structuredClone(ctx.view);
  if (edit.lines) edit.lines(view.lines as Partial<Record<string, PdfLine>>);
  const facts = structuredClone(ctx.facts);
  if (edit.facts) edit.facts(facts);
  return { ...ctx, raw, view, facts };
}

function data(d: RawDocument): Record<string, unknown> {
  return (d.extractionData as { data: Record<string, unknown> }).data;
}

function docOf(raw: RawTy2025Inputs, docType: string, nth = 0): RawDocument {
  const d = raw.documents.filter((x) => x.docType === docType)[nth];
  if (!d) throw new Error(`no ${docType} #${nth}`);
  return d;
}

function bumpLine(lines: Partial<Record<string, PdfLine>>, key: string, by: number): void {
  const l = lines[key];
  if (!l || l.amount === null) throw new Error(`${key} has no amount`);
  l.amount += by;
}

describe("L1.C1 source documents tie to the return", () => {
  it("passes on the clean and the rich return (the documents, the facts and the lines agree)", async () => {
    expect(await run(sourceTieoutCheck, clean)).toEqual([]);
    expect(await run(sourceTieoutCheck, rich)).toEqual([]);
  });
  it("W-2 box 1 and box 2 against lines 1a and 25a", async () => {
    const c = edited(rich, { raw: (r) => { data(docOf(r, "w2"))["wagesCents"] = (data(docOf(r, "w2"))["wagesCents"] as number) + 12_300; data(docOf(r, "w2"))["federalWithheldCents"] = 1; } });
    const f = await run(sourceTieoutCheck, c);
    expect(has(f, "L1.C1.w2-box1", "blocker")).toBe(true);
    expect(has(f, "L1.C1.w2-box2", "blocker")).toBe(true);
    expect(f.find((x) => x.check === "L1.C1.w2-box1")?.acceptable).toBe(false);
  });
  it("boxes 3 and 7 of the self-employed person against Schedule SE line 8a", async () => {
    const c = edited(rich, { raw: (r) => { data(docOf(r, "w2"))["socialSecurityWagesCents"] = 1_000_000; } });
    expect(has(await run(sourceTieoutCheck, c), "L1.C1.w2-box3-7", "blocker")).toBe(true);
  });
  it("boxes 5 and 6 against Form 8959 when that form is filed", async () => {
    const c = edited(rich, { raw: (r) => { data(docOf(r, "w2"))["medicareWagesCents"] = 1_000_000; data(docOf(r, "w2"))["medicareWithheldCents"] = 5; } });
    const f = await run(sourceTieoutCheck, c);
    expect(has(f, "L1.C1.w2-box5")).toBe(true);
    expect(has(f, "L1.C1.w2-box6")).toBe(true);
  });
  it("Connecticut withholding: each W-2 is rounded on its own (Column C) or the total once; anything else is a blocker", async () => {
    const setCt = (r: RawTy2025Inputs): void => {
      for (const d of r.documents.filter((x) => x.docType === "w2")) {
        (data(d)["stateLines"] as { stateWithheldCents: number }[])[0]!.stateWithheldCents = 150;
      }
    };
    const w2Count = rich.raw?.documents.filter((x) => x.docType === "w2").length ?? 0;
    expect(w2Count).toBe(3);
    const perRow = 2 * w2Count; // $1.50 rounds to $2 on each of three W-2s
    const ofSum = 5; // $4.50 rounds to $5 once
    const at = (n: number) => edited(rich, { raw: setCt, lines: (l) => { const x = l["ct1040.18"]; if (x) x.amount = n; } });
    expect(has(await run(sourceTieoutCheck, at(perRow)), "L1.C1.w2-box17-ct")).toBe(false);
    expect(has(await run(sourceTieoutCheck, at(ofSum)), "L1.C1.w2-box17-ct")).toBe(false);
    expect(has(await run(sourceTieoutCheck, at(7)), "L1.C1.w2-box17-ct", "blocker")).toBe(true);
  });
  it("a W-2 with no person assigned, and wages attributed to the wrong person", async () => {
    const noPerson = edited(rich, { raw: (r) => { const d = docOf(r, "w2"); d.subjectType = "joint"; } });
    expect(has(await run(sourceTieoutCheck, noPerson), "L1.C1.w2-no-person", "high")).toBe(true);
    const wrong = edited(rich, { facts: (f) => { const w = f.income.w2s[0]; if (w) w.personUserId = "user-eva"; } });
    expect(has(await run(sourceTieoutCheck, wrong), "L1.C1.w2-person", "blocker")).toBe(true);
  });
  it("box 12 deferrals, box 7 tips and box 14 overtime against the questionnaire answers", async () => {
    const deferral = edited(rich, { facts: (f) => { const p = f.returnAnswers.people[0]; if (p) p.deferralsCents = owner(2_000_000); } });
    expect(has(await run(sourceTieoutCheck, deferral), "L1.C1.w2-deferrals", "medium")).toBe(true);
    const tips = edited(rich, { raw: (r) => { data(docOf(r, "w2"))["socialSecurityTipsCents"] = 454_580; } });
    expect(has(await run(sourceTieoutCheck, tips), "L1.C1.w2-tips", "medium")).toBe(true);
    const ot = edited(rich, { raw: (r) => { data(docOf(r, "w2"))["box14"] = [{ label: "OT PREMIUM", amountCents: 120_000 }]; } });
    expect(has(await run(sourceTieoutCheck, ot), "L1.C1.w2-overtime", "medium")).toBe(true);
  });
  it("interest, dividends, qualified dividends and 1099 withholding", async () => {
    const c = edited(rich, {
      raw: (r) => {
        const i = r.documents.find((d) => data(d)["formVariant"] === "1099-INT");
        const v = r.documents.find((d) => data(d)["formVariant"] === "1099-DIV");
        if (!i || !v) throw new Error("no 1099-INT / 1099-DIV");
        data(i)["int_box1Cents"] = 999_999;
        data(i)["federalWithheldCents"] = 1_234;
        data(v)["div_box1aCents"] = 1;
        data(v)["div_box1bCents"] = 2;
      },
    });
    const f = await run(sourceTieoutCheck, c);
    for (const id of ["int", "div-ordinary", "div-qualified", "1099-withholding"]) expect(has(f, `L1.C1.${id}`, "blocker"), id).toBe(true);
  });
  it("1099-B category totals against the Schedule D cells they feed", async () => {
    const c = edited(rich, { lines: (l) => { bumpLine(l, "schd.1b.d", 50); bumpLine(l, "schd.8a.e", 50); bumpLine(l, "schd.1b.g", 3); } });
    const f = await run(sourceTieoutCheck, c);
    expect(has(f, "L1.C1.1099b-1b-d")).toBe(true);
    expect(has(f, "L1.C1.1099b-8a-e")).toBe(true);
    expect(has(f, "L1.C1.1099b-1b-g")).toBe(true);
  });
  it("a sales category that has no Schedule D line on the return is a blocker", async () => {
    const ret = { ...rich.ret, scheduleD: rich.ret.scheduleD ? { ...rich.ret.scheduleD, categories: rich.ret.scheduleD.categories.filter((cat) => cat.box !== "B") } : null };
    expect(has(await run(sourceTieoutCheck, { ...rich, ret }), "L1.C1.1099b-missing-category", "blocker")).toBe(true);
  });
  it("1099 boxes outside interest / dividends / sales must be on a line or in an open item", async () => {
    const withNec = edited(rich, { raw: (r) => { data(docOf(r, "1099"))["nec_box1Cents"] = 500_000; } });
    expect(has(await run(sourceTieoutCheck, withNec), "L1.C1.other-boxes", "high")).toBe(true);
    const id = docOf(withNec.raw as RawTy2025Inputs, "1099").id;
    const explained: L1Context = { ...withNec, ret: { ...withNec.ret, openItems: [...withNec.ret.openItems, { id: "other-income-boxes", severity: "blocking", message: "m", action: "a", lineKeys: [], refs: [{ kind: "document", id, label: "1099" }] }] } };
    expect(has(await run(sourceTieoutCheck, explained), "L1.C1.other-boxes")).toBe(false);
  });
  it("Form 1098: deducting more than reported is a blocker, less is high (a limit may apply), mortgage insurance is never deducted", async () => {
    const more = edited(rich, { lines: (l) => bumpLine(l, "scha.8a", 5_000) });
    expect(has(await run(sourceTieoutCheck, more), "L1.C1.1098-interest", "blocker")).toBe(true);
    const less = edited(rich, { lines: (l) => bumpLine(l, "scha.8a", -5_000) });
    const lf = await run(sourceTieoutCheck, less);
    expect(has(lf, "L1.C1.1098-interest-less", "high")).toBe(true);
    expect(lf.find((x) => x.check === "L1.C1.1098-interest-less")?.acceptable).toBe(true);
    const mip = edited(rich, { raw: (r) => { data(docOf(r, "mortgage_interest"))["mortgageInsurancePremiumsCents"] = 120_000; }, lines: (l) => bumpLine(l, "scha.8a", 1_200) });
    const mf = await run(sourceTieoutCheck, mip);
    const f = mf.find((x) => x.check === "L1.C1.1098-mip");
    expect(f?.severity).toBe("blocker");
    expect(f?.citation.sources[0]?.url).toContain("irs.gov/publications/p936");
  });
  it("property tax deducted above what the bills show was paid is a blocker", async () => {
    const c = edited(rich, { lines: (l) => bumpLine(l, "scha.5b", 4_000) });
    expect(has(await run(sourceTieoutCheck, c), "L1.C1.property-tax", "blocker")).toBe(true);
  });
  it("a K-1 with amounts that no open item explains is high", async () => {
    const k1 = doc("k1", { box1Cents: 100_000 }, { id: "00000000-0000-4000-8000-0000000000e1" });
    const c = edited(rich, { raw: (r) => { r.documents.push(k1); } });
    expect(has(await run(sourceTieoutCheck, c), "L1.C1.k1", "high")).toBe(true);
  });
  it("estimated and extension payments against lines 26, Schedule 3 line 10 and CT lines 19 / 20", async () => {
    const c = edited(rich, {
      facts: (f) => {
        f.payments.federalEstimates = owner([{ paidOn: "2025-04-15", amountCents: 500_000, appliesToTaxYear: 2025 }]);
        f.payments.federalExtensionPayment = owner(100_000);
        f.payments.ctEstimates = owner([{ paidOn: "2025-04-15", amountCents: 200_000, appliesToTaxYear: 2025 }]);
        f.payments.ctExtensionPayment = owner(50_000);
      },
    });
    const f = await run(sourceTieoutCheck, c);
    for (const id of ["fed-estimates", "fed-extension", "ct-estimates", "ct-extension"]) expect(has(f, `L1.C1.${id}`, "blocker"), id).toBe(true);
  });
  it("inventory: a document with no tax year or an unfinished extraction is not used (high); a usable one nothing reflects is high", async () => {
    const noYear = doc("w2", { wagesCents: 1 }, { id: "00000000-0000-4000-8000-0000000000e2", taxYear: null });
    const failed = doc("1099", { amountCents: 1 }, { id: "00000000-0000-4000-8000-0000000000e3", extractionStatus: "failed" });
    const orphan = doc("w2", { wagesCents: 100, federalWithheldCents: 0, socialSecurityWagesCents: 100, medicareWagesCents: 100 }, { id: "00000000-0000-4000-8000-0000000000e4" });
    const c = edited(rich, { raw: (r) => { r.documents.push(noYear, failed, orphan); } });
    const f = await run(sourceTieoutCheck, c);
    expect(f.filter((x) => x.check === "L1.C1.doc-unusable").length).toBe(2);
    expect(has(f, "L1.C1.doc-not-reflected", "high")).toBe(true);
  });
  it("without the documents the check says so (high) instead of passing", async () => {
    const f = await run(sourceTieoutCheck, { ...clean, raw: null });
    expect(f.map((x) => x.check)).toEqual(["L1.C1.no-documents"]);
  });
  it("findings carry document ids and amounts, never a payer name or an EIN", async () => {
    const c = edited(rich, { raw: (r) => { data(docOf(r, "w2"))["wagesCents"] = 1; } });
    const json = JSON.stringify(await run(sourceTieoutCheck, c));
    expect(json).not.toMatch(/Sample|11-1111111|55-5555555/);
  });
});

describe("source document helpers", () => {
  it("signatures ignore the person only when asked", () => {
    const a = doc("w2", { employerEIN: "11-1111111", wagesCents: 5 }, { subjectUserId: "u1" });
    const b = doc("w2", { employerEIN: "11-1111111", wagesCents: 5 }, { subjectUserId: "u2" });
    expect(docSignature(a)).not.toBe(docSignature(b));
    expect(docSignature(a, { ignorePerson: true })).toBe(docSignature(b, { ignorePerson: true }));
  });
  it("uniqueDocs keeps the verified copy", () => {
    const a = doc("w2", { employerEIN: "11-1111111", wagesCents: 5 }, { verified: false });
    const b = doc("w2", { employerEIN: "11-1111111", wagesCents: 5 }, { verified: true });
    expect(uniqueDocs([a, b], "w2").map((d) => d.id)).toEqual([b.id]);
  });
  it("usability: wrong year is not an error; no year or unfinished extraction is", () => {
    expect(unusableReason(doc("w2", {}, { taxYear: 2024 }))).toBeNull();
    expect(unusableReason(doc("w2", {}, { taxYear: null }))).toMatch(/no tax year/);
    expect(unusableReason(doc("w2", {}, { extractionStatus: "processing" }))).toMatch(/not complete/);
    expect(isUsableFor2025(doc("w2", {}, { extractionStatus: "failed", reextractIncomplete: true }))).toBe(true);
    expect(unusableReason(doc("tax_return", {}, { extractionStatus: "failed" }))).toBeNull();
  });
});

describe("L1.C2 double counting", () => {
  it("passes on the clean and the rich return", async () => {
    expect(await run(doubleCountCheck, clean)).toEqual([]);
    expect(await run(doubleCountCheck, rich)).toEqual([]);
  });
  it("two documents with the same issuer, year and amounts are reported once (high, acceptable)", async () => {
    const dup = JSON.parse(JSON.stringify(docOf(rich.raw as RawTy2025Inputs, "1099", 0))) as RawDocument;
    dup.id = "00000000-0000-4000-8000-0000000000f1";
    const c = edited(rich, { raw: (r) => { r.documents.push(dup); } });
    const f = await run(doubleCountCheck, c);
    expect(f.filter((x) => x.check === "L1.C2.duplicate").length).toBe(1);
    expect(f[0]?.severity).toBe("high");
    expect(f[0]?.acceptable).toBe(true);
  });
  it("a repeated estimated payment is high", async () => {
    const e = { paidOn: "2025-06-15", amountCents: 100_000, appliesToTaxYear: 2025 };
    const c = edited(rich, { facts: (f) => { f.payments.federalEstimates = owner([e, { ...e }]); } });
    expect(has(await run(doubleCountCheck, c), "L1.C2.estimate-repeat", "high")).toBe(true);
  });
  it("books interest next to a 1099-INT is information with both numbers, never an error", async () => {
    const scheduleC = { ...(rich.ret.scheduleC as NonNullable<typeof rich.ret.scheduleC>), booksInterest: [{ code: "4100", name: "Interest", amountCents: 12_345 }] };
    const f = await run(doubleCountCheck, { ...rich, ret: { ...rich.ret, scheduleC } });
    const info = f.find((x) => x.check === "L1.C2.books-interest");
    expect(info?.severity).toBe("info");
    expect(info?.evidence.length).toBe(2);
  });
});
