import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 }); // filling several real IRS forms per test; the 5 s default is tuned for one
import { describe, expect, it } from "vitest";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import { buildCoverModel, type CoverBlock } from "@/lib/tax2025/pdf/cover";
import { formatDollars, shortFingerprint } from "@/lib/tax2025/pdf/format";
import {
  EMPLOYER_NOT_READ,
  PAYER_NOT_READ,
  TABLE_COLUMNS,
  centsToWholeDollars,
  toPdfReturnView,
  type AdapterOverrides,
} from "@/lib/tax2025/pdf/adapter";
import { applyOverrides, formatOverrideNote, lineSnapshot, type OverrideRow } from "@/lib/tax2025/overrides";
import { ownerWording, ownerWordingDeep } from "@/lib/tax-wording";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { resolveFieldValue } from "@/lib/tax2025/pdf/policy";
import { computeTy2025Return, TY2025_ENGINE_VERSION } from "@/lib/tax2025/return";
import { LINE_KEYS, hasAmount, missingLeaf, type Ty2025Return } from "@/lib/tax2025/types";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { ERIC_ID, EVA_ID, dividend, emptyFacts, fullFacts, gl, interest, owner, w2 } from "./tax2025-fixtures";
import { readAllFields } from "./tax2025-pdf-harness";

const OPTS = { generatedAt: "2026-10-03T16:00:00.000Z", generatedBy: "Test User" } as const;

/** What the adapter derives from the fully answered fixture (attestations "No", nobody 65+ / blind). */
const ANSWERED_FIXTURE_ANSWERS = {
  filingStatus: "mfj",
  digitalAssets: "no",
  foreignAccounts: "no",
  foreignTrust: "no",
  fincenRequired: "no",
  age65Taxpayer: false,
  blindTaxpayer: false,
  age65Spouse: false,
  blindSpouse: false,
  // Schedule D: the golden household has no sales but its 1099-DIV boxes 2b-2d are not confirmed zero, so the 1040 line 7b box
  // is NOT ticked (schdNotRequired false); it stated "none" for the special-rate sales (QOF "no").
  schdNotRequired: false,
  "schd.qof": "no",
} as const;

function build(facts: Ty2025Facts, decisions: Parameters<typeof computeTy2025Return>[1] = {}) {
  const ret = computeTy2025Return(facts, decisions);
  return { ret, view: toPdfReturnView(ret, facts, OPTS) };
}

/** Deep walk: no Decimal (or any class instance other than plain objects/arrays) anywhere in the view. */
function assertPlainData(value: unknown, path = "view"): void {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") expect(Number.isFinite(value), `${path} is finite`).toBe(true);
    expect(typeof value).not.toBe("function");
    expect(typeof value).not.toBe("bigint");
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertPlainData(v, `${path}[${i}]`));
    return;
  }
  const proto: unknown = Object.getPrototypeOf(value);
  expect(proto === Object.prototype || proto === null, `${path} is a plain object (got ${(value as object).constructor?.name})`).toBe(true);
  for (const [k, v] of Object.entries(value)) assertPlainData(v, `${path}.${k}`);
}

/** The blocks between the "Open items" heading and the next heading. */
function openItemBullets(blocks: readonly CoverBlock[]): { heading: string; bullets: string[] } {
  const at = blocks.findIndex((b) => b.kind === "heading" && b.text.startsWith("Open items ("));
  expect(at).toBeGreaterThanOrEqual(0);
  const heading = (blocks[at] as { text: string }).text;
  const bullets: string[] = [];
  for (const b of blocks.slice(at + 1)) {
    if (b.kind === "heading") break;
    if (b.kind === "bullet") bullets.push(b.text);
  }
  return { heading, bullets };
}

describe("toPdfReturnView: plain data and line coverage", () => {
  const { ret, view } = build(fullFacts());

  it("is JSON-safe plain data with no Decimal and integer-dollar amounts", () => {
    assertPlainData(view);
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
    for (const line of Object.values(view.lines)) {
      if (line?.amount !== null && line?.amount !== undefined) expect(Number.isInteger(line.amount)).toBe(true);
    }
  });

  it("carries every engine line exactly once with its status, amount and provenance text", () => {
    const engineKeys = LINE_KEYS.filter((k) => ret.lines[k] !== undefined);
    expect(engineKeys.length).toBeGreaterThan(100);
    expect(Object.keys(view.lines).sort()).toEqual([...engineKeys].sort());
    for (const key of engineKeys) {
      const base = ret.lines[key];
      const line = view.lines[key];
      expect(base).toBeDefined();
      expect(line, `line ${key}`).toBeDefined();
      if (!base || !line) continue;
      expect(line.key).toBe(key);
      expect(line.status).toBe(base.status);
      expect(line.amount).toBe(base.amount);
      // Engine prose is reworded once, at the adapter boundary (lib/tax-wording.ts); the text is otherwise the engine's.
      expect(line.reason).toBe(base.reason === null ? null : ownerWording(base.reason));
      expect(line.formLabel).toBe(base.form);
      expect(line.formLine).toBe(base.formLine);
      expect(line.label).toBe(base.label);
    }
  });

  it("every computed line of the fixture appears exactly once with its integer amount", () => {
    const computed = LINE_KEYS.filter((k) => ret.lines[k]?.status === "computed");
    expect(computed.length).toBeGreaterThan(50);
    for (const key of computed) {
      const matches = Object.values(view.lines).filter((l) => l?.key === key);
      expect(matches, `computed line ${key}`).toHaveLength(1);
      expect(matches[0]?.amount).toBe(ret.lines[key]?.amount ?? null);
      expect(matches[0]?.amount).not.toBeNull();
    }
  });

  it("amount is null for every status that carries none (never a silent 0)", () => {
    for (const line of Object.values(view.lines)) {
      if (!line) continue;
      if (line.status !== "overridden" && !hasAmount(line.status)) expect(line.amount).toBeNull();
    }
  });

  it("copies engine version, filing status, citations and headline", () => {
    expect(view.taxYear).toBe(2025);
    expect(view.filingStatus).toBe("mfj");
    expect(view.engineVersion).toBe(TY2025_ENGINE_VERSION);
    expect(view.citations).toEqual(ret.citations);
    expect(view.headline).toEqual(ownerWordingDeep(ret.headline));
    expect(view.answers).toEqual(ANSWERED_FIXTURE_ANSWERS);
    expect(view.generatedBy).toBe("Test User");
    expect(view.generatedAt).toBe(OPTS.generatedAt);
  });
});

describe("open-item consistency with the cover", () => {
  for (const [name, facts] of [
    ["fully answered fixture", fullFacts()],
    ["empty fixture (everything missing)", emptyFacts()],
  ] as const) {
    it(`${name}: the cover lists exactly the engine's open items`, () => {
      const { ret, view } = build(facts);
      expect(new Set(ret.openItems.map((i) => i.id)).size, "engine item ids are unique").toBe(ret.openItems.length);
      expect(view.openItems.filter((i) => !i.id.startsWith("adapter:"))).toHaveLength(ret.openItems.length);
      const adapterItems = view.openItems.filter((i) => i.id.startsWith("adapter:"));
      const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
      const { heading, bullets } = openItemBullets(model.blocks);
      expect(bullets).toHaveLength(ret.openItems.length + adapterItems.length);
      const blocking = ret.openItems.filter((i) => i.severity === "blocking").length + adapterItems.filter((i) => i.severity === "blocking").length;
      expect(heading).toBe(
        `Open items (${blocking} blocking, ${ret.openItems.length + adapterItems.length - blocking} advisory)`,
      );
      expect(ret.openItems.filter((i) => i.severity === "blocking")).toHaveLength(ret.headline.blockingItemCount);
      // Every engine item message appears on the cover once.
      for (const item of ret.openItems) {
        expect(bullets.filter((b) => b.includes(ownerWording(item.message).slice(0, 40)))).not.toHaveLength(0);
      }
    });
  }

  it("open items keep their line keys and derive the form label from the first key", () => {
    const { ret, view } = build(emptyFacts());
    const withKeys = ret.openItems.find((i) => i.lineKeys.length > 0);
    expect(withKeys).toBeDefined();
    if (!withKeys) return;
    const pdfItem = view.openItems.find((i) => i.id === withKeys.id);
    expect(pdfItem?.lineKeys).toEqual(withKeys.lineKeys);
    const first = withKeys.lineKeys[0];
    expect(pdfItem?.formLabel).toBe(first ? ret.lines[first]?.form : undefined);
    const general = ret.openItems.find((i) => i.lineKeys.length === 0);
    if (general) expect(view.openItems.find((i) => i.id === general.id)?.formLabel).toBe("General");
  });

  it("an incomplete return surfaces the PROVISIONAL block, never presenting it as computed", () => {
    const { ret, view } = build(emptyFacts());
    expect(ret.headline.complete).toBe(false);
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    const text = model.blocks.map((b) => ("text" in b ? b.text : "label" in b ? `${b.label} ${b.value}` : "")).join("\n");
    expect(text).toContain("PROVISIONAL");
    expect(text).not.toContain("Federal AGI:");
  });
});

describe("decisions marked default, undecided", () => {
  function homeOfficeFacts(): Ty2025Facts {
    const f = fullFacts();
    f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    f.income.scheduleC.homeOfficeSqft = owner(200);
    return f;
  }

  it("shows the undecided X1 default with alternatives and tags only the line the default feeds", () => {
    const { ret, view } = build(homeOfficeFacts());
    expect(ret.decisions.map((d) => d.id)).toContain("X1");
    const d = view.decisions.find((x) => x.id === "X1");
    expect(d?.status).toBe("default_undecided");
    expect(d?.chosen).toBe("simplified");
    expect(d?.effectNote).toMatch(/In force: .*Simplified/);
    expect(d?.effectNote).toMatch(/Alternatives: .*Actual expenses/);
    expect(view.lines["schc.30"]?.defaultUndecided).toMatch(/Home office/);
    expect(view.lines["schc.1"]?.defaultUndecided).toBeUndefined();
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    expect(model.blocks.some((b) => b.kind === "bullet" && b.text.includes("(default, undecided)"))).toBe(true);
  });

  it("the field tooltip says 'default, undecided: <label>' for that line", () => {
    const { view } = build(homeOfficeFacts());
    const line = view.lines["schc.30"];
    expect(line).toBeDefined();
    if (!line) return;
    const decision = resolveFieldValue("f1040sc", line, { kind: "money", field: "x", line: "schc.30" });
    expect(decision.write).not.toBeNull();
    expect(decision.tooltip).toMatch(/^default, undecided: Home office/);
  });

  it("a recorded decision is 'decided', carries by/at and tags no line", () => {
    const { view } = build(homeOfficeFacts(), {
      homeOfficeMethod: { chosen: "actual", by: "Eric", at: "2026-10-05T12:00:00.000Z" },
    });
    const d = view.decisions.find((x) => x.id === "X1");
    expect(d?.status).toBe("decided");
    expect(d?.decidedBy).toBe("Eric");
    expect(d?.decidedAt).toBe("2026-10-05T12:00:00.000Z");
    expect(Object.values(view.lines).some((l) => l?.defaultUndecided !== undefined)).toBe(false);
  });
});

describe("header names from facts (taxpayer = owner of EK Consulting)", () => {
  it("takes the Schedule C owner as taxpayer and the other person as spouse, with no open item", () => {
    const { view } = build(fullFacts());
    expect(view.header).toEqual({
      householdNames: "Eric and Eva",
      taxpayerName: "Eric",
      spouseName: "Eva",
      ekcName: null,
    });
    expect(view.openItems.some((i) => i.id === "adapter:header.owner-unknown")).toBe(false);
  });

  it("puts the owner first even when the people list is in the other order; trims; ekcName from options", () => {
    const f = fullFacts();
    f.household.people = [
      { userId: EVA_ID, name: "  Eva Example " },
      { userId: ERIC_ID, name: "Eric Example" },
    ];
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, { ...OPTS, ekcName: " Example Consulting, LLC " });
    expect(view.header.taxpayerName).toBe("Eric Example");
    expect(view.header.spouseName).toBe("Eva Example");
    expect(view.header.householdNames).toBe("Eric Example and Eva Example");
    expect(view.header.ekcName).toBe("Example Consulting, LLC");
  });

  it("owner unknown or not a household person -> taxpayer/spouse blank, an open item, household names still listed", () => {
    for (const ownerLeaf of [emptyFacts().income.scheduleC.ownerUserId, owner("user-stranger")]) {
      const f = emptyFacts();
      f.income.scheduleC.ownerUserId = ownerLeaf;
      const view = toPdfReturnView(computeTy2025Return(f), f, OPTS);
      expect(view.header.taxpayerName).toBeNull();
      expect(view.header.spouseName).toBeNull();
      expect(view.header.householdNames).toBe("Eric and Eva");
      const item = view.openItems.find((i) => i.id === "adapter:header.owner-unknown");
      expect(item?.severity).toBe("advisory");
      expect(item?.message).toMatch(/EK Consulting/);
    }
  });

  it("no people -> all names null (fill raises the 'header not available' items)", () => {
    const f = emptyFacts();
    f.household.people = [];
    const view = toPdfReturnView(computeTy2025Return(f), f, OPTS);
    expect(view.header).toEqual({ householdNames: null, taxpayerName: null, spouseName: null, ekcName: null });
  });

  it("the Schedule C owner's name reaches the real Schedule C / 1040 name fields when those maps are registered", async () => {
    const f = fullFacts();
    const view = toPdfReturnView(computeTy2025Return(f), f, OPTS);
    const f1040 = FORM_MAPS.find((m) => m.formId === "f1040");
    expect(f1040).toBeDefined();
    if (!f1040) return;
    const file = (await buildPacket(view, { maps: [f1040] })).files.find((x) => x.formId === "f1040");
    const fields = await readAllFields(file?.bytes ?? new Uint8Array());
    const nameFields = f1040.header.filter((h) => h.source.startsWith("household.taxpayer") || h.source.startsWith("household.spouse"));
    expect(nameFields.length).toBeGreaterThan(0);
    expect(nameFields.some((h) => fields.get(h.field) === "Eric")).toBe(true);
    expect(nameFields.some((h) => fields.get(h.field) === "Eva")).toBe(true);
  });
});

describe("answers the maps read", () => {
  it("sets filingStatus = mfj, derives only what the engine carries, and leaves the rest undefined", () => {
    const { view } = build(fullFacts());
    expect(view.answers).toEqual(ANSWERED_FIXTURE_ANSWERS);
    for (const k of [
      "schC.accountingMethod",
      "schC.materialParticipation",
      "schC.principalBusiness",
      "schC.businessCode",
      "schC.homeSqft",
    ]) {
      expect(view.answers[k]).toBeUndefined();
    }
  });

  it("office square footage comes from the facts only for an exclusive-use home office", () => {
    const f = fullFacts();
    f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    f.income.scheduleC.homeOfficeSqft = owner(180);
    expect(build(f).view.answers["schC.officeSqft"]).toBe("180");
    f.income.scheduleC.homeOfficeEligibility = owner("yes_shared");
    expect(build(f).view.answers["schC.officeSqft"]).toBeUndefined();
    f.income.scheduleC.homeOfficeEligibility = owner("no");
    expect(build(f).view.answers["schC.officeSqft"]).toBeUndefined();
    f.income.scheduleC.homeOfficeEligibility = owner("yes_exclusive");
    f.income.scheduleC.homeOfficeSqft = emptyFacts().income.scheduleC.homeOfficeSqft;
    expect(build(f).view.answers["schC.officeSqft"]).toBeUndefined();
  });

  it("caller answers pass through but can never override the filing status", () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, {
      ...OPTS,
      answers: { digitalAssets: "no", "schC.accountingMethod": "cash", filingStatus: "single" },
    });
    expect(view.answers).toEqual({ ...ANSWERED_FIXTURE_ANSWERS, "schC.accountingMethod": "cash" });
  });
});

describe("answers wired from the engine (review S1)", () => {
  it("digital assets: Yes / No become 'yes' / 'no'; unsure or missing stays undefined", () => {
    const yes = fullFacts();
    yes.returnAnswers.attestations.digitalAssets = owner(true);
    expect(build(yes).view.answers["digitalAssets"]).toBe("yes");
    const unsure = fullFacts();
    unsure.returnAnswers.attestations.digitalAssets = { ...missingLeaf<boolean>(), basis: "answer_owner" };
    expect(build(unsure).ret.attestations.digitalAssets.status).toBe("unsure");
    expect(build(unsure).view.answers["digitalAssets"]).toBeUndefined();
    const missing = fullFacts();
    missing.returnAnswers.attestations.digitalAssets = missingLeaf<boolean>();
    expect(build(missing).view.answers["digitalAssets"]).toBeUndefined();
  });

  it("the foreign accounts-and-trusts question: an answered No fills Part III (accounts, FinCEN, trust) as 'no'; Yes / unsure / missing set none of them", () => {
    const no = build(fullFacts()).view.answers;
    expect([no["foreignAccounts"], no["fincenRequired"], no["foreignTrust"]]).toEqual(["no", "no", "no"]);
    for (const leaf of [owner(true), { ...missingLeaf<boolean>(), basis: "answer_owner" as const }, missingLeaf<boolean>()]) {
      const f = fullFacts();
      f.returnAnswers.attestations.foreignAccounts = leaf;
      const a = build(f).view.answers;
      expect([a["foreignAccounts"], a["fincenRequired"], a["foreignTrust"]]).toEqual([undefined, undefined, undefined]);
    }
  });

  it("12d: per-person answers go to taxpayer (the Schedule C owner) and spouse, only when answered", () => {
    const f = fullFacts();
    const eric = f.returnAnswers.people.find((p) => p.userId === ERIC_ID);
    const eva = f.returnAnswers.people.find((p) => p.userId === EVA_ID);
    if (!eric || !eva) throw new Error("fixture people missing");
    eric.bornBefore1961 = owner(true);
    eva.blind = owner(true);
    eva.bornBefore1961 = missingLeaf<boolean>(); // unanswered
    const a = build(f).view.answers;
    expect(a["age65Taxpayer"]).toBe(true);
    expect(a["blindTaxpayer"]).toBe(false);
    expect(a["age65Spouse"]).toBeUndefined();
    expect(a["blindSpouse"]).toBe(true);
    // if the Schedule C owner were the other person, the roles swap
    f.income.scheduleC.ownerUserId = { ...f.income.scheduleC.ownerUserId, value: EVA_ID };
    const swapped = build(f).view.answers;
    expect(swapped["age65Taxpayer"]).toBeUndefined();
    expect(swapped["blindTaxpayer"]).toBe(true);
    expect(swapped["age65Spouse"]).toBe(true);
    expect(swapped["blindSpouse"]).toBe(false);
  });

  it("unknown taxpayer (owner not matched): no 12d answers are guessed", () => {
    const f = fullFacts();
    f.income.scheduleC.ownerUserId = missingLeaf();
    const a = build(f).view.answers;
    for (const k of ["age65Taxpayer", "blindTaxpayer", "age65Spouse", "blindSpouse"]) expect(a[k], k).toBeUndefined();
  });

  it("the fingerprint covers table rows and the forms verdicts", () => {
    const f = fullFacts();
    const base = build(f).view.fingerprint;
    const g = fullFacts();
    g.income.interest = [interest({ docId: "i9", payer: "Another Bank", box1Cents: 500, box3Cents: 0 })];
    expect(build(g).view.fingerprint).not.toBe(base);
    const { ret } = build(f);
    const changed: Ty2025Return = { ...ret, formsRequired: { ...ret.formsRequired, f8283: { required: true, reason: "x" } } };
    expect(toPdfReturnView(changed, f, OPTS).fingerprint).not.toBe(base);
  });
});

describe("tables from facts", () => {
  it("builds Schedule B payer rows (box 1 + box 3, whole dollars) and flags an unread payer", () => {
    const f = fullFacts();
    f.income.interest = [
      interest({ docId: "i1", payer: "First Bank", box1Cents: 12_345, box3Cents: 100 }),
      interest({ docId: "i2", payer: null, box1Cents: 99_950, box3Cents: 0 }),
    ];
    f.income.dividends = [dividend({ docId: "d1", payer: "Broker Co", box1aCents: 150_049, box1bCents: 0 })];
    const { ret, view } = build(f);
    const cols = TABLE_COLUMNS["schb.interest"];
    expect(view.tables["schb.interest"]).toEqual([
      { cells: { [cols.label]: "First Bank", [cols.amount]: 124 } }, // 12,445 cents -> $124 (half-up rounding)
      { cells: { [cols.label]: PAYER_NOT_READ, [cols.amount]: 1000 } }, // 99,950 cents -> $1,000
    ]);
    expect(view.tables["schb.dividends"]).toEqual([
      { cells: { [TABLE_COLUMNS["schb.dividends"].label]: "Broker Co", [TABLE_COLUMNS["schb.dividends"].amount]: 1500 } },
    ]);
    expect(view.openItems.some((i) => i.id === "adapter:schb.payer-not-read")).toBe(true);
    // Rows are rounded one by one, the line once: the adapter says so when they differ.
    const rounding = view.openItems.find((i) => i.id === "adapter:schb.interest-rounding");
    expect(ret.lines["schb.2"]?.amount).toBe(1124); // 112,395 cents rounded once
    expect(rounding).toBeUndefined(); // 124 + 1000 = 1124: no rounding difference here
  });

  it("raises a rounding note when the rounded rows do not sum to the engine line", () => {
    const f = fullFacts();
    f.income.interest = [
      interest({ docId: "i1", payer: "A", box1Cents: 150, box3Cents: 0 }), // $1.50 -> 2
      interest({ docId: "i2", payer: "B", box1Cents: 150, box3Cents: 0 }), // $1.50 -> 2   rows total 4, line = round(3.00) = 3
    ];
    const { ret, view } = build(f);
    expect(ret.lines["schb.2"]?.amount).toBe(3);
    const note = view.openItems.find((i) => i.id === "adapter:schb.interest-rounding");
    expect(note?.severity).toBe("advisory");
    expect(note?.lineKeys).toEqual(["schb.2"]);
    expect(note?.message).toContain("$4");
    expect(note?.message).toContain("$3");
  });

  it("a payer row with a missing box leaves the amount cell null (never 0) and adds no rounding note", () => {
    const f = fullFacts();
    f.income.interest = [interest({ docId: "i1", payer: "A", box1Cents: null, box3Cents: 0 })];
    const { view } = build(f);
    expect(view.tables["schb.interest"]).toEqual([
      { cells: { [TABLE_COLUMNS["schb.interest"].label]: "A", [TABLE_COLUMNS["schb.interest"].amount]: null } },
    ]);
    expect(view.openItems.some((i) => i.id.startsWith("adapter:schb.interest-rounding"))).toBe(false);
  });

  it("builds CT withholding rows from the W-2s (employer, FEIN, CT wages, CT tax) and flags a missing FEIN", () => {
    const f = fullFacts();
    f.income.w2s = [
      w2({
        docId: "w-a",
        employer: "Alpine Bio",
        employerEin: "12-3456789",
        wagesCents: 9_000_000,
        ctWithheldCents: 300_000,
        stateLines: [{ stateCode: "CT", wagesCents: 9_000_000, withheldCents: 300_000 }],
      }),
      w2({ docId: "w-b", employer: null, employerEin: null, personUserId: EVA_ID, ctWithheldCents: 120_050, stateLines: [] }),
      w2({ docId: "w-c", employer: "No CT", ctWithheldCents: 0 }),
    ];
    const { view } = build(f);
    const c = TABLE_COLUMNS["ct.withholding"];
    expect(view.tables["ct.withholding"]).toEqual([
      { cells: { [c.label]: "Alpine Bio", [c.ein]: "12-3456789", [c.wages]: 90_000, [c.amount]: 3000 } },
      { cells: { [c.label]: EMPLOYER_NOT_READ, [c.ein]: null, [c.wages]: null, [c.amount]: 1201 } },
    ]);
    expect(view.openItems.some((i) => i.id === "adapter:ct.withholding-ein")).toBe(true);
  });

  it("exposes Schedule C other-expense items from the engine detail", () => {
    const f = fullFacts();
    f.income.scheduleC.glLines.push(gl("5090", "General business expenses:Bank fees & service charges", "expense", 12_350));
    const { ret, view } = build(f);
    expect(ret.scheduleC?.otherExpenseItems.length).toBeGreaterThan(0);
    const rows = view.tables["schc.otherExpenses"];
    expect(rows).toBeDefined();
    const c = TABLE_COLUMNS["schc.otherExpenses"];
    const row = rows?.find((r) => r.cells[c.label] === "Bank fees & service charges");
    expect(row?.cells[c.amount]).toBe(124);
    expect(c).toEqual({ label: "label", amount: "amount" }); // the Schedule C map's Part V columns
    expect(view.openItems.some((i) => i.id === "adapter:schc.other-no-items")).toBe(false);
  });

  it("a non-zero line 27b with no per-item data raises an advisory item and leaves the Part V rows empty", () => {
    const f = fullFacts();
    f.income.scheduleC.glLines.push(gl("5090", "General business expenses:Bank fees & service charges", "expense", 12_350));
    const ret = computeTy2025Return(f);
    expect(ret.lines["schc.27b"]?.amount).toBeGreaterThan(0);
    if (!ret.scheduleC) throw new Error("fixture has no scheduleC detail");
    const stripped: Ty2025Return = { ...ret, scheduleC: { ...ret.scheduleC, otherExpenseItems: [] } };
    const view = toPdfReturnView(stripped, f, OPTS);
    expect(view.tables["schc.otherExpenses"]).toEqual([]);
    const item = view.openItems.find((i) => i.id === "adapter:schc.other-no-items");
    expect(item?.severity).toBe("advisory");
    expect(item?.lineKeys).toEqual(["schc.27b", "schc.48"]);
  });

  it("no scheduleC detail at all (books unreadable) leaves the Part V table unset", () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView({ ...ret, scheduleC: null }, f, OPTS);
    expect(view.tables["schc.otherExpenses"]).toBeUndefined();
  });

  it("centsToWholeDollars uses the engine's half-up rounding, also for negatives", () => {
    expect(centsToWholeDollars(250)).toBe(3);
    expect(centsToWholeDollars(249)).toBe(2);
    expect(centsToWholeDollars(-250)).toBe(-3);
    expect(centsToWholeDollars(0)).toBe(0);
  });
});

describe("fingerprint", () => {
  it("is stable for equal return state and independent of generatedAt/generatedBy", () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    const a = toPdfReturnView(ret, f, OPTS);
    const b = toPdfReturnView(computeTy2025Return(f), f, { generatedAt: "2030-01-01T00:00:00.000Z", generatedBy: "Someone Else" });
    expect(a.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("changes when a computed amount changes", () => {
    const base = build(fullFacts()).view.fingerprint;
    const f = fullFacts();
    f.income.interest = [interest({ docId: "int-1", box1Cents: 60_000 })];
    expect(build(f).view.fingerprint).not.toBe(base);
  });
});

describe("overrides (the real applyOverrides output)", () => {
  let seq = 0;
  function row(ret: Ty2025Return, key: (typeof LINE_KEYS)[number], valueCents: number, over: Partial<OverrideRow> = {}): OverrideRow {
    const l = ret.lines[key];
    if (!l) throw new Error(`fixture has no ${key}`);
    seq += 1;
    return {
      id: `00000000-0000-4000-8000-${String(7000 + seq).padStart(12, "0")}`,
      taxYear: 2025,
      targetKind: "line",
      targetKey: key,
      version: 1,
      valueKind: "money_cents",
      valueCents,
      valueText: null,
      computedSnapshot: lineSnapshot(l, ret.engineVersion),
      authority: "cpa",
      reason: "CPA said so",
      setByName: "Eric Kinniburgh",
      setAt: new Date("2026-10-12T02:30:00Z"),
      archivedAt: null,
      ...over,
    };
  }
  function withRows(ret: Ty2025Return, rows: OverrideRow[]): AdapterOverrides {
    return { effective: applyOverrides(ret, rows), formatNote: formatOverrideNote };
  }
  const NOTE = "Advisor override: was $50,000 computed, now $130,000, by Eric Kinniburgh (per advisor, recorded earlier) on 2026-10-11, reason: CPA said so";

  it("pins the override amount, status 'overridden', the note, the dependents and the cover entry", () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    expect(ret.lines["sch1.3"]?.amount).toBe(50_000);
    const view = toPdfReturnView(ret, f, { ...OPTS, overrides: withRows(ret, [row(ret, "sch1.3", 13_000_000)]) });
    const line = view.lines["sch1.3"];
    expect(line?.status).toBe("overridden");
    expect(line?.amount).toBe(130_000);
    expect(line?.override).toEqual({ note: NOTE, computedAmount: 50_000, stale: false, supplied: false });
    expect(view.overrides).toEqual([{ key: "sch1.3", formLabel: "Schedule 1", formLine: "3", note: NOTE, stale: false, supplied: false }]);
    expect(view.lines["f1040.9"]?.dependsOnOverridden).toEqual(["Schedule 1 line 3"]);
    expect(view.overrideNotice.totalsNotRecomputed).toBe(true);
    expect(view.overrideNotice.count).toBe(1);
    expect(view.overrideNotice.dependents.some((d) => d.key === "f1040.9" && d.dependsOn.includes("Schedule 1 line 3"))).toBe(true);
    expect(view.overrideNotice.headlineMarks.find((m) => m.label === "Federal AGI")).toMatchObject({ overridden: false, dependsOnOverride: true });
    // The policy writes the override and carries the note as the field tooltip.
    const decision = resolveFieldValue("f1040s1", line, { kind: "money", field: "x", line: "sch1.3" });
    expect(decision.write).toBe(formatDollars(130_000));
    expect(decision.tooltip).toBe(NOTE);
    // The base return is untouched and the fingerprint reflects the override.
    expect(ret.lines["sch1.3"]?.status).toBe("computed");
    expect(view.fingerprint).not.toBe(toPdfReturnView(ret, f, OPTS).fingerprint);
  });

  it("without overrides the view carries no marks (and fingerprints exactly as before)", () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    const plain = toPdfReturnView(ret, f, OPTS);
    const empty = toPdfReturnView(ret, f, { ...OPTS, overrides: withRows(ret, []) });
    expect(plain.overrideNotice).toEqual({ totalsNotRecomputed: false, dependents: [], headlineMarks: [], engineChanged: [], count: 0 });
    expect(empty.fingerprint).toBe(plain.fingerprint);
    expect(empty.overrides).toEqual([]);
    expect(Object.values(empty.lines).every((l) => l?.dependsOnOverridden === undefined && l?.override === undefined)).toBe(true);
  });

  it("the fingerprint covers the override METADATA: value, reason, authority and version each change it", () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    const fp = (over: Partial<OverrideRow>): string => toPdfReturnView(ret, f, { ...OPTS, overrides: withRows(ret, [row(ret, "sch1.3", 13_000_000, { id: "00000000-0000-4000-8000-0000000000f1", ...over })]) }).fingerprint;
    const base = fp({});
    expect(fp({})).toBe(base); // deterministic
    expect(fp({ valueCents: 13_100_000 })).not.toBe(base);
    expect(fp({ reason: "A different reason" })).not.toBe(base);
    expect(fp({ authority: "owner" })).not.toBe(base);
    expect(fp({ version: 2 })).not.toBe(base);
  });

  it("flags a stale override (the computed value changed after it was set) and lists it in the cover's stale section", () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    const stale = row(ret, "sch1.3", 13_000_000, { computedSnapshot: { status: "computed", cents: 1_000_000, engineVersion: ret.engineVersion } });
    const view = toPdfReturnView(ret, f, { ...OPTS, overrides: withRows(ret, [stale]) });
    expect(view.lines["sch1.3"]?.override?.stale).toBe(true);
    expect(view.overrides[0]?.stale).toBe(true);
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    expect(model.blocks.some((b) => b.kind === "heading" && b.text.startsWith("Stale overrides"))).toBe(true);
  });

  it("a pin on a BLOCKED line prints (is no longer blank), is marked supplied, and its engine item moves to the resolved list", () => {
    const f = emptyFacts();
    const ret = computeTy2025Return(f);
    expect(ret.lines["sch3.1"]?.amount).toBeNull();
    const view = toPdfReturnView(ret, f, { ...OPTS, overrides: withRows(ret, [row(ret, "sch3.1", 250_000)]) });
    const line = view.lines["sch3.1"];
    expect(line).toMatchObject({ status: "overridden", amount: 2500, reason: null });
    expect(line?.override?.supplied).toBe(true);
    const decision = resolveFieldValue("f1040s3", line, { kind: "money", field: "x", line: "sch3.1" });
    expect(decision.write).toBe(formatDollars(2500));
    expect(decision.items).toEqual([]); // no `line_blank` item for it
    expect(view.resolvedByOverride.map((r) => r.id)).toEqual(["rule:foreign-tax-credit"]);
    expect(view.openItems.some((i) => i.id === "rule:foreign-tax-credit")).toBe(false);
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    const text = model.blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text)).join("\n");
    expect(text).toContain("Resolved by owner override (no longer blocking) (1)");
    expect(text).toContain("[supplied: the engine had no value for this line]");
    expect(text).toContain("Totals NOT recomputed for these overrides");
  });

  it("an acknowledgement and a recorded decision keep their notes (who / when / why)", () => {
    const f = emptyFacts();
    const ret = computeTy2025Return(f);
    const result = ret.results.find((r) => r.ruleId === "foreign-tax-credit");
    const ack: OverrideRow = {
      ...row(ret, "sch3.1", 0),
      targetKind: "rule_ack",
      targetKey: "foreign-tax-credit",
      valueKind: "ack",
      valueCents: null,
      computedSnapshot: { status: result?.status ?? "missing_input", cents: null, engineVersion: ret.engineVersion },
    };
    const view = toPdfReturnView(ret, f, { ...OPTS, overrides: withRows(ret, [ack]) });
    expect(view.acknowledged).toHaveLength(1);
    expect(view.acknowledged[0]?.ruleId).toBe("foreign-tax-credit");
    expect(view.acknowledged[0]?.note).toContain("Advisor acknowledged rule foreign-tax-credit");
    expect(view.acknowledged[0]?.note).toContain("reason: CPA said so");
    expect(view.overrideNotice.count).toBe(1);
    expect(view.overrideNotice.totalsNotRecomputed).toBe(false); // an acknowledgement changes no number
  });
});

describe("the adapter feeds the real packet builder", () => {
  // With the engine's verdict wired (view.formsRequired), the packet holds exactly the forms the engine says
  // the return needs: for the golden fixture the standard deduction wins (no Schedule A), interest and
  // dividends are under the Schedule B threshold, there is no Schedule 3 amount and no Form 8959.
  const GOLDEN_OMITTED = ["f1040s3", "f1040sa", "f1040sb", "f1040sd", "f8949", "f8959"];

  it("fills every INCLUDED map from the fixture view: each computed mapped line is written once with its formatted amount", async () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    const view = toPdfReturnView(ret, f, OPTS);
    const packet = await buildPacket(view, { maps: FORM_MAPS });
    expect(packet.files[0]?.name).toBe("00-cover.pdf");
    expect(packet.files.length).toBeGreaterThanOrEqual(2);
    // every map is either in the packet or listed as omitted with the engine's reason; none is lost
    expect(packet.forms.map((x) => x.formId).sort()).toEqual(FORM_MAPS.map((m) => m.formId).sort());
    expect(packet.forms.filter((x) => !x.included).map((x) => x.formId).sort()).toEqual(GOLDEN_OMITTED);
    for (const omitted of packet.forms.filter((x) => !x.included)) {
      expect(omitted.reason, omitted.formId).toContain("the engine reports it is not required");
      expect(packet.files.some((x) => x.formId === omitted.formId), `${omitted.formId} must not be in the packet`).toBe(false);
    }
    for (const map of FORM_MAPS) {
      if (GOLDEN_OMITTED.includes(map.formId)) continue;
      const file = packet.files.find((x) => x.formId === map.formId);
      expect(file, `${map.formId} included`).toBeDefined();
      if (!file) continue;
      const fields = await readAllFields(file.bytes);
      const seen = new Set<string>();
      for (const entry of map.lines) {
        if (entry.kind !== "money") continue;
        // Only the CT-1040 legitimately shows one engine amount in two boxes (page-1 line and the schedule
        // that totals it, or the signed balance split into 22 / 26); everywhere else a repeat is a mapping bug.
        if (map.formId !== "ct1040") expect(seen.has(entry.line), `line ${entry.line} mapped twice on ${map.formId}`).toBe(false);
        seen.add(entry.line);
        const line = view.lines[entry.line];
        if (line?.status === "computed" && line.amount !== null && line.amount !== 0) {
          // `sign`: one signed amount feeds two printed lines, each printing only its own direction.
          const shown = entry.sign === undefined ? line.amount : entry.sign === "owed" ? Math.max(line.amount, 0) : Math.max(-line.amount, 0);
          const want = shown === 0 ? "" : formatDollars(shown);
          expect(fields.get(entry.field), `${map.formId} ${entry.line}`).toBe(want);
        }
      }
    }
    expect(packet.coverPageCount).toBeGreaterThanOrEqual(1);
    // The cover fingerprint is the view's.
    const cover = buildCoverModel({ view, forms: packet.forms, fillItems: packet.openItems, continuations: [], stamp: true });
    expect(cover.fingerprint12).toBe(shortFingerprint(view.fingerprint));
  });
});
