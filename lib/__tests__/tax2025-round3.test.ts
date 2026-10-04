// Round 3 (reviewer B1, B2, S1-S7, nits). The loader tests use a mocked db (same idea as tax2025-tester-loader.test.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";

const h = vi.hoisted(() => {
  const calls: { model: string; method: string; args: unknown }[] = [];
  const state: {
    entities: Record<string, { id: string; name: string; slug: string | null; navLabel: string | null; type: string } | null>;
    documents: unknown[];
    uncodedRows: unknown[];
    codedRows: unknown[];
    glCodes: unknown[];
  } = { entities: {}, documents: [], uncodedRows: [], codedRows: [], glCodes: [] };
  const handler = (model: string, method: string) => async (args: unknown) => {
    calls.push({ model, method, args });
    if (/^(create|update|upsert|delete|executeRaw|queryRaw)/.test(method)) throw new Error(`WRITE ATTEMPTED: db.${model}.${method}`);
    const key = `${model}.${method}`;
    switch (key) {
      case "entity.findFirst":
        return state.entities[(args as { where: { slug: string } }).where.slug] ?? null;
      case "document.findMany":
        return state.documents;
      case "transaction.groupBy": {
        const g = (args as { where: { glCodeId: unknown } }).where.glCodeId;
        return g === null ? state.uncodedRows : state.codedRows;
      }
      case "glCode.findMany":
        return state.glCodes;
      default:
        return method === "findMany" ? [] : null;
    }
  };
  const db = new Proxy({}, { get: (_t, model: string) => new Proxy({}, { get: (_t2, method: string) => handler(model, method) }) });
  return { calls, state, db };
});

vi.mock("@/lib/db", () => ({ db: h.db }));

import { buildTy2025Return, loadTy2025RawInputs } from "@/lib/tax2025-build";
import { resolveFacts, type RawDocument, type RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import { computeScheduleC, type ScheduleCInput } from "@/lib/tax2025/rules/schedule-c";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { GL_SCHEDULE_C_MAP } from "@/lib/tax2025/gl-schedule-c-map";
import { missingLeaf, type LineKey, type RuleResult } from "@/lib/tax2025/types";
import { ERIC_ID, EVA_ID, fullFacts, gl, owner } from "@/lib/__tests__/tax2025-fixtures";

const PERSONAL = { id: "ent-personal", name: "Personal", slug: "personal", navLabel: "Personal", type: "personal" };
const EKC = { id: "ent-ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting", navLabel: "EKC", type: "llc" };

beforeEach(() => {
  h.calls.length = 0;
  h.state.entities = { personal: PERSONAL, "ek-consulting": EKC };
  h.state.documents = [];
  h.state.uncodedRows = [];
  h.state.codedRows = [];
  h.state.glCodes = [];
});

function amt(r: RuleResult, key: LineKey): string | null {
  const l = r.lines.find((x) => x.key === key);
  if (!l) throw new Error(`no line ${key}`);
  return l.amount === null ? null : l.amount.toString();
}
function st(r: RuleResult, key: LineKey): string | undefined {
  return r.lines.find((x) => x.key === key)?.status;
}

describe("B1: uncoded EK Consulting transactions are never invisible", () => {
  it("loader: reads a count of 2025 EKC transactions with glCodeId null (archivedAt null, transferPairId null, same UTC window as the P&L) and only reads", async () => {
    h.state.uncodedRows = [{ glCodeId: null, _count: { _all: 3 } }];
    const raw = await loadTy2025RawInputs(2025);
    if ("error" in raw) throw new Error(raw.error);
    expect(raw.ekc.uncodedTransactionCount).toBe(3);
    const uncodedCall = h.calls.find((c) => c.model === "transaction" && (c.args as { where: { glCodeId: unknown } }).where.glCodeId === null);
    expect(uncodedCall).toBeDefined();
    const where = (uncodedCall!.args as { where: { entityId: string; archivedAt: null; transferPairId: null; postedAt: { gte: Date; lte: Date } } }).where;
    expect(where.entityId).toBe("ent-ekc");
    expect(where.archivedAt).toBeNull();
    expect(where.transferPairId).toBeNull();
    expect(where.postedAt.gte.toISOString()).toBe("2025-01-01T00:00:00.000Z");
    expect(where.postedAt.lte.toISOString()).toBe("2025-12-31T23:59:59.000Z");
    expect(h.calls.every((c) => /^find|groupBy$/.test(c.method))).toBe(true);
  });

  it("loader: zero uncoded rows gives 0; no EKC entity gives 0 and no transaction read", async () => {
    expect((await loadTy2025RawInputs(2025) as RawTy2025Inputs).ekc.uncodedTransactionCount).toBe(0);
    h.calls.length = 0;
    h.state.entities = { personal: PERSONAL };
    const raw = (await loadTy2025RawInputs(2025)) as RawTy2025Inputs;
    expect(raw.ekc.uncodedTransactionCount).toBe(0);
    expect(h.calls.some((c) => c.model === "transaction")).toBe(false);
  });

  const base = (over: Partial<ScheduleCInput> = {}): ScheduleCInput => ({
    glLines: [gl("4000", "Services", "revenue", 6_000_000), gl("5010", "Office expenses:Software & apps", "expense", 600_000)],
    booksEmpty: false,
    mileage: [],
    mileageNoneConfirmed: true,
    homeOfficeEligibility: "no",
    homeOfficeSqft: null,
    fixedAssets: [],
    fixedAssetsNoneConfirmed: true,
    ...over,
  });

  it("rule: with uncoded transactions lines 28, 29 and 31 are missing_input with the count in the reason (income and the expense lines still show)", () => {
    const { result } = computeScheduleC(base({ uncodedTransactionCount: 3 }));
    for (const k of ["schc.28", "schc.29", "schc.31"] as const) {
      expect(st(result, k)).toBe("missing_input");
      expect(amt(result, k)).toBeNull();
      expect(result.lines.find((l) => l.key === k)?.reason).toContain("3 2025 EK Consulting transaction(s)");
    }
    expect(amt(result, "schc.7")).toBe("60000");
    expect(result.inputsMissing.join(" ")).toContain("GL code");
    // zero / absent behaves as before
    expect(amt(computeScheduleC(base({ uncodedTransactionCount: 0 })).result, "schc.31")).toBe("54000");
    expect(amt(computeScheduleC(base()).result, "schc.31")).toBe("54000");
  });

  it("resolver + return: a BLOCKING item, no Schedule C profit, SE tax blocked, headline incomplete; the provisional pass ignores them and says so", () => {
    const f = fullFacts();
    f.income.scheduleC.uncodedTransactionCount = 2;
    const { openItems } = resolveFacts({
      taxYear: 2025,
      people: [{ userId: ERIC_ID, name: "Eric" }],
      scheduleCOwner: null,
      documents: [],
      planning: { filingStatus: "mfj", householdMembers: null, evVehicle: null, businessMileage: null, homeOfficeEligibility: null, homeOfficeSqft: null, solarCredit: null, donationsNone: false, fixedAssetsEkcNone: false, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
      primaryResidence: null,
      paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
      ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, uncodedTransactionCount: 2, mileage: [], fixedAssets: [] },
      donations: [],
    });
    const item = openItems.find((o) => o.id === "ekc-uncoded-transactions");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain("2 EK Consulting transaction(s)");
    const ret = computeTy2025Return(f, {}, { openItems });
    expect(ret.lines["schc.31"]?.status).toBe("missing_input");
    expect(ret.lines["se.12"]?.status).toBe("missing_input");
    expect(ret.lines["f1040.11a"]?.status).not.toBe("computed");
    expect(ret.headline.complete).toBe(false);
    expect(ret.headline.provisional?.assumedFacts.join(" ")).toContain("uncoded EK Consulting transaction(s) ignored");
  });

  it("golden fixture (no uncoded rows) is unchanged", () => {
    const ret = computeTy2025Return(fullFacts());
    expect(ret.headline.federal.totalTax.amount).toBe(27015);
    expect(ret.lines["schc.31"]?.amount).toBe(50000);
  });
});

describe("S5: signed GL sums", () => {
  it("loader reads signed sums per GL code and carries them on the facts", async () => {
    h.state.glCodes = [{ id: "g1", code: "4000", name: "Services", type: "revenue" }, { id: "g2", code: "5010", name: "Office expenses:Software & apps", type: "expense" }];
    h.state.codedRows = [
      { glCodeId: "g1", _sum: { amount: new Decimal("-250.00") }, _count: { _all: 2 } },
      { glCodeId: "g2", _sum: { amount: new Decimal("-80.00") }, _count: { _all: 1 } },
    ];
    const raw = await loadTy2025RawInputs(2025);
    if ("error" in raw) throw new Error(raw.error);
    expect(raw.ekc.glLines.map((g) => [g.code, g.glType, g.totalCents, g.signedCents])).toEqual([
      ["4000", "revenue", 25_000, -25_000],
      ["5010", "expense", 8_000, -8_000],
    ]);
  });

  const rawWith = (glLines: RawTy2025Inputs["ekc"]["glLines"]): RawTy2025Inputs => ({
    taxYear: 2025,
    people: [],
    scheduleCOwner: null,
    documents: [],
    planning: { filingStatus: "mfj", householdMembers: null, evVehicle: null, businessMileage: null, homeOfficeEligibility: null, homeOfficeSqft: null, solarCredit: null, donationsNone: false, fixedAssetsEkcNone: false, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
    primaryResidence: null,
    paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
    ekc: { glLines, booksEmpty: false, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
    donations: [],
  });

  it("a revenue account netting negative, or an expense account netting positive, is a BLOCKING open item; Returns and allowances (refunds) is exempt", () => {
    const { openItems } = resolveFacts(
      rawWith([
        { ...gl("4000", "Services", "revenue", 25_000), signedCents: -25_000 },
        { ...gl("5010", "Office expenses:Software & apps", "expense", 8_000), signedCents: 8_000 },
        { ...gl("4100", "Refunds to customers", "revenue", 10_000), signedCents: -10_000 },
        { ...gl("4200", "Sales", "revenue", 99_000), signedCents: 99_000 },
      ])
    );
    const ids = openItems.filter((o) => o.id.startsWith("gl-sign-flip:")).map((o) => o.id).sort();
    expect(ids).toEqual(["gl-sign-flip:4000", "gl-sign-flip:5010"]);
    expect(openItems.find((o) => o.id === "gl-sign-flip:4000")?.severity).toBe("blocking");
  });

  it("rule: a sign-flipped account is needs_cpa_judgment (never counted in the wrong direction); a normal refund account is fine", () => {
    const input: ScheduleCInput = {
      glLines: [
        gl("4000", "Services", "revenue", 6_000_000),
        { ...gl("4010", "Sales", "revenue", 100_000), signedCents: -100_000 },
        { ...gl("4020", "Refunds to customers", "revenue", 50_000), signedCents: -50_000 },
      ],
      booksEmpty: false,
      mileage: [],
      mileageNoneConfirmed: true,
      homeOfficeEligibility: "no",
      homeOfficeSqft: null,
      fixedAssets: [],
      fixedAssetsNoneConfirmed: true,
    };
    const { result, detail } = computeScheduleC(input);
    expect(st(result, "schc.7")).toBe("needs_cpa_judgment");
    expect(detail.needsCpa.map((n) => n.code)).toEqual(["4010"]);
    // without the flipped account the refund account reduces line 3 as before
    const ok = computeScheduleC({ ...input, glLines: [input.glLines[0]!, input.glLines[2]!] }).result;
    expect(amt(ok, "schc.2")).toBe("500");
    expect(amt(ok, "schc.3")).toBe("59500");
  });
});

describe("B2 (resolved by Phase 1b): the per-person age 65+ / blind answers are the ONE source of the standard deduction", () => {
  it("unanswered: 12e, taxable income and the headline are blocked with ONE blocking item (no separate none-group item); answered no: the golden return is unchanged", () => {
    const f = fullFacts();
    f.returnAnswers.people[0]!.blind = missingLeaf();
    const ret = computeTy2025Return(f);
    expect(ret.lines["f1040.12e"]?.status).toBe("missing_input");
    expect(ret.lines["f1040.14"]?.status).not.toBe("computed");
    expect(ret.lines["f1040.15"]?.status).not.toBe("computed");
    expect(ret.headline.complete).toBe(false);
    const items = ret.openItems.filter((o) => o.severity === "blocking" && (o.id === "rule:standard-deduction" || o.id.includes("age_blind")));
    expect(items.map((o) => o.id)).toEqual(["rule:standard-deduction"]);
    // the provisional pass lists the assumption and still gives numbers
    expect(ret.headline.provisional?.assumedFacts.join(" ")).toContain("age 65 / blind");
    expect(ret.headline.provisional?.taxableIncome).toBe(137174);
    expect(computeTy2025Return(fullFacts()).headline.federal.taxableIncome.amount).toBe(137174);
  });

  it("a spouse who IS 65+ or blind adds 1,600 per box to the standard deduction (never the base amount); 'not sure' is needs_cpa_judgment", () => {
    const f = fullFacts();
    f.returnAnswers.people[0]!.bornBefore1961 = owner(true);
    expect(computeTy2025Return(f).lines["std.total"]?.amount).toBe(33100);
    f.returnAnswers.people[1]!.blind = { value: null, basis: "answer_owner", refs: [] };
    const ret = computeTy2025Return(f);
    expect(ret.lines["f1040.12e"]?.status).toBe("needs_cpa_judgment");
    expect(ret.lines["f1040.15"]?.status).not.toBe("computed");
  });
});

describe("S1: complete is not 'nothing left to check'", () => {
  it("golden: complete = true with 0 blocking items, and the caveats list names the uncomputed federal penalty and the CT penalty / interest", () => {
    const ret = computeTy2025Return(fullFacts());
    expect(ret.headline.complete).toBe(true);
    expect(ret.headline.blockingItemCount).toBe(0);
    const ids = ret.openItems.filter((o) => o.severity === "advisory").map((o) => o.id);
    for (const id of ["info:f1040.38", "info:ct1040.27", "info:ct1040.28", "info:f1040.7b", "info:f1040.35a", "info:f1040.36"]) expect(ids).toContain(id);
    expect(ret.lines["f1040.38"]?.status).toBe("not_yet_computed");
    expect(ret.lines["f1040.38"]?.informational).toBe(true);
    expect(ret.headline.caveats.join(" ")).toContain("Estimated tax penalty");
    expect(ret.headline.caveats.join(" ")).toContain("Late payment penalty");
    expect(ret.headline.unverifiedDocumentCount).toBe(0);
    expect(ret.headline.derivedInputCount).toBe(0);
    expect(ret.headline.undecidedDecisionCount).toBe(0);
  });

  it("counts unverified AI reads, derived inferences and default decisions, and lists them as caveats while staying complete", () => {
    const f = fullFacts();
    f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    f.income.scheduleC.homeOfficeSqft = owner(200);
    const ret = computeTy2025Return(f, {}, {
      openItems: [
        { id: "doc-unverified:a", severity: "advisory", message: "W-2 is an unverified AI extraction", action: "", lineKeys: [], refs: [] },
        { id: "doc-unverified:b", severity: "advisory", message: "1099 is an unverified AI extraction", action: "", lineKeys: [], refs: [] },
        { id: "schedule-c-owner-derived", severity: "advisory", message: "Owner by name match", action: "", lineKeys: [], refs: [] },
        { id: "primary-residence-derived", severity: "advisory", message: "Residence by 1098", action: "", lineKeys: [], refs: [] },
      ],
    });
    expect(ret.headline.complete).toBe(true);
    expect(ret.headline.unverifiedDocumentCount).toBe(2);
    expect(ret.headline.derivedInputCount).toBe(2);
    expect(ret.headline.undecidedDecisionCount).toBe(1);
    expect(ret.headline.caveats.join(" | ")).toContain("2 document(s) counted in the numbers are unverified AI reads");
    expect(ret.headline.caveats.join(" | ")).toContain("default, undecided");
    expect(ret.headline.caveats).toContain("Owner by name match");
  });
});

describe("S2: GL map owner-only LLC corrections", () => {
  const target = (name: string) => GL_SCHEDULE_C_MAP.find((e) => e.account === name)!.target;
  it("employee benefit / health / retirement accounts, business mortgage interest and bad debt are needs_cpa; workers' comp stays insurance (line 15)", () => {
    for (const a of ["Employee benefits", "Employee benefits:Employee retirement plans", "Employee benefits:Group term life insurance", "Employee benefits:Health & accident plans", "Interest paid:Mortgage interest", "General business expenses:Bad Debt"]) {
      expect(target(a).kind, a).toBe("needs_cpa");
    }
    expect(target("Employee benefits:Worker's compensation insurance")).toEqual({ kind: "line", line: "15" });
    expect(target("Interest paid:Business loan interest")).toEqual({ kind: "line", line: "16b" });
    expect(GL_SCHEDULE_C_MAP.filter((e) => e.target.kind === "needs_cpa")).toHaveLength(14);
    const t = target("Employee benefits:Health & accident plans");
    expect(t.kind === "needs_cpa" ? t.reason : "").toContain("Schedule 1 line 17");
  });
  it("a balance in a health plan account blocks the Schedule C profit instead of reducing it", () => {
    const { result } = computeScheduleC({
      glLines: [gl("4000", "Services", "revenue", 6_000_000), gl("5100", "Employee benefits:Health & accident plans", "expense", 300_000)],
      booksEmpty: false,
      mileage: [],
      mileageNoneConfirmed: true,
      homeOfficeEligibility: "no",
      homeOfficeSqft: null,
      fixedAssets: [],
      fixedAssetsNoneConfirmed: true,
    });
    expect(st(result, "schc.28")).toBe("needs_cpa_judgment");
    expect(st(result, "schc.31")).toBe("needs_cpa_judgment");
  });
});

describe("S3: provisional pass lists the 1098 handling and exposes provisional lines", () => {
  it("a non-primary 1098 forced to primary-residence interest in the fill pass is in assumedFacts; provisional.lines carries the computed amounts", () => {
    const f = fullFacts();
    f.deductions.mortgages.push({ ...f.deductions.mortgages[0]!, docId: "m2", propertyAddress: "56 Arbor Rd" });
    delete f.statedNone.se_other; // make the strict return incomplete so the provisional pass runs
    const ret = computeTy2025Return(f);
    expect(ret.lines["scha.8a"]?.status).toBe("needs_cpa_judgment");
    const prov = ret.headline.provisional!;
    expect(prov.assumedFacts.join(" ")).toContain("not (or cannot be shown to be) the primary residence");
    expect(prov.lines["f1040.11a"]).toBe(prov.agi);
    expect(typeof prov.lines["f1040.24"]).toBe("number");
  });
});

describe("S4: 1099-DIV boxes 2b-2d are not read", () => {
  const raw = (answers?: RawTy2025Inputs["answers"]): RawTy2025Inputs => ({
    ...rawBase(),
    ...(answers ? { answers } : {}),
    documents: [
      {
        id: "div",
        docType: "1099",
        taxYear: 2025,
        extractionStatus: "complete",
        extractionData: { data: { formVariant: "1099-DIV", payerName: "Robinhood", div_box1aCents: 100_000, div_box1bCents: 80_000 } },
        verified: true,
        legacyFormat: false,
        subjectType: "person",
        subjectUserId: ERIC_ID,
      } as RawDocument,
    ],
  });
  function rawBase(): RawTy2025Inputs {
    return {
      taxYear: 2025,
      people: [{ userId: ERIC_ID, name: "Eric" }, { userId: EVA_ID, name: "Eva" }],
      scheduleCOwner: null,
      documents: [],
      planning: { filingStatus: "mfj", householdMembers: null, evVehicle: null, businessMileage: null, homeOfficeEligibility: null, homeOfficeSqft: null, solarCredit: null, donationsNone: false, fixedAssetsEkcNone: false, retirementContributionCents: null, estimatedPaymentsCombinedCents: null },
      primaryResidence: null,
      paystubs: { federalWithheldCents: 0, ctWithheldCents: 0 },
      ekc: { glLines: [], booksEmpty: true, glExcludedTransactionCount: 0, mileage: [], fixedAssets: [] },
      donations: [],
    };
  }
  it("any dividend document raises a BLOCKING item on the QDCG validity until the owner confirms boxes 2b-2d are zero", () => {
    const item = resolveFacts(raw()).openItems.find((o) => o.id === "dividend-boxes-2b-2d");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain("2b");
    expect(item?.lineKeys).toContain("f1040.16");
    expect(resolveFacts(raw({ dividendBoxes2b2dConfirmedZero: true })).openItems.some((o) => o.id === "dividend-boxes-2b-2d")).toBe(false);
    expect(resolveFacts(rawBase()).openItems.some((o) => o.id === "dividend-boxes-2b-2d")).toBe(false);
  });
});

describe("S6: the public build result carries no document extraction data", () => {
  it("buildTy2025Return's raw has document metadata only (no extractionData, no names); the loader header documents the 1c checklist", async () => {
    h.state.documents = [
      {
        id: "d1", entityId: "ent-personal", docType: "w2", taxYear: 2025, extractionStatus: "complete",
        extractionData: { data: { wagesCents: 1_000_000, employerEIN: "12-3456789", employerName: "Secret Co" } },
        extractionCorrections: null, extractionConfirmedAt: null, subjectType: "person", subjectUserId: "u1", documentName: "Secret W-2", archivedAt: null,
      },
    ];
    const out = await buildTy2025Return(2025);
    if ("error" in out) throw new Error(out.error);
    expect(out.raw.documents).toHaveLength(1);
    expect(Object.keys(out.raw.documents[0]!).sort()).toEqual(["docType", "id", "legacyFormat", "subjectType", "taxYear", "verified"]);
    expect(out.raw.documents[0]).toMatchObject({ id: "d1", docType: "w2", taxYear: 2025, verified: false, subjectType: "person" });
    expect(JSON.stringify(out.raw)).not.toContain("12-3456789");
    expect(JSON.stringify(out.raw)).not.toContain("Secret");
  });
});

describe("N4: forms the engine does not compute are listed for the CPA", () => {
  it("8889 / 8880 / 5695 / 4562 / 8829 / Schedule D are explicit entries (blocking when they cannot be ruled out)", () => {
    const ret = computeTy2025Return(fullFacts());
    // Phase 1b: the stated HSA / saver's amounts of fullFacts() (0) rule both forms out; with nothing stated the rules decide (below)
    expect(ret.formsRequired.f8889?.required).toBe(false);
    expect(ret.formsRequired.f8880?.required).toBe(false);
    expect(ret.formsRequired.f5695?.required).toBe(false); // solar_credit stated none
    expect(ret.formsRequired.f4562?.required).toBe(false);
    expect(ret.formsRequired.f8829?.required).toBe(false);
    expect(ret.formsRequired.schd?.required).toBe(false);
    const f = fullFacts();
    f.statedNone.solar_credit = missingLeaf();
    f.adjustments.hsa = missingLeaf();
    f.credits.savers = missingLeaf();
    f.income.otherIncomeBoxes = [{ docId: "b", payer: "Broker", basis: "doc_verified", variant: "1099-B", box: "1d", label: "Proceeds", amountCents: 1 }];
    f.income.w2s[0]!.box12 = [{ code: "W", amountCents: 100_000 }];
    const r2 = computeTy2025Return(f);
    expect(r2.formsRequired.f5695?.required).toBe("blocking");
    expect(r2.formsRequired.schd?.required).toBe("blocking");
    expect(r2.formsRequired.f8889?.reason).toContain("code W");
    expect(r2.formsRequired.f8880?.required).toBe("blocking"); // AGI is blocked here (HSA unanswered), so the saver's credit cannot be decided
  });
});
