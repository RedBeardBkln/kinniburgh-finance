import { vi } from "vitest";
vi.setConfig({ testTimeout: 90000 });
import { unzipSync } from "fflate";
import { PDFCheckBox, PDFDocument, PDFName, PDFTextField } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { LINE_KEYS } from "@/lib/tax2025/line-catalog";
import { checkCompleteness } from "@/lib/tax2025/pdf/completeness";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { CT1040_FLAT_NOTE, ct1040Geometry, ctOverlayFieldNames, type CtOverlayField } from "@/lib/tax2025/pdf/ct-overlay";
import { ctPropertyTaxRows } from "@/lib/tax2025/pdf/ct-property-tax";
import { OVERFLOW_LABEL, fillForm } from "@/lib/tax2025/pdf/fill";
import { ct1040Map } from "@/lib/tax2025/pdf/maps/ct1040";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import { PENDING_LINE_KEYS } from "@/lib/tax2025/pdf/pending-line-keys";
import { getManifestEntry } from "@/lib/tax2025/pdf/registry";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { bill, fullFacts } from "./tax2025-fixtures";
import { engineLine, linesOf, required, viewFromEngine, viewWith } from "./fixtures/tax2025-pdf-mvp2-ct.fixture";
import { DEFAULT_FILL_OPTIONS, assertMapGolden, readAllFields } from "./tax2025-pdf-harness";

const NO_STAMP = { ...DEFAULT_FILL_OPTIONS, stamp: false };
const geometry = ct1040Geometry();

function overlap(a: CtOverlayField["rect"], b: CtOverlayField["rect"]): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

// ── Guard tests on the calibrated geometry ────────────────────────────────────

describe("CT-1040 overlay geometry (guards)", () => {
  it("is tied to the pinned blank (sha256 and size match the manifest)", () => {
    const entry = getManifestEntry("ct1040");
    expect(geometry.source.sha256).toBe(entry.sha256);
    expect(geometry.source.bytes).toBe(entry.bytes);
    expect(geometry.pages).toHaveLength(entry.pages);
    expect(entry.sourceKind).toBe("flat");
    expect(entry.fieldCount).toBe(0);
  });

  it("has the expected number of fields per page and unique names", () => {
    expect(geometry.fields).toHaveLength(96);
    expect(new Set(ctOverlayFieldNames()).size).toBe(96);
    const perPage = geometry.pages.map((_, i) => geometry.fields.filter((f) => f.page === i).length);
    expect(perPage).toEqual([21, 35, 25, 15]);
    for (const f of geometry.fields) expect(f.name).toMatch(/^ct1040\.[A-Za-z0-9]+$/);
  });

  it("every rectangle lies inside its page", () => {
    for (const f of geometry.fields) {
      const page = geometry.pages[f.page]!;
      expect(f.rect.x, f.name).toBeGreaterThanOrEqual(0);
      expect(f.rect.y, f.name).toBeGreaterThanOrEqual(0);
      expect(f.rect.x + f.rect.width, f.name).toBeLessThanOrEqual(page.width);
      expect(f.rect.y + f.rect.height, f.name).toBeLessThanOrEqual(page.height);
    }
  });

  it("no two rectangles overlap", () => {
    const fields = geometry.fields;
    for (let i = 0; i < fields.length; i++) {
      for (let j = i + 1; j < fields.length; j++) {
        const a = fields[i]!;
        const b = fields[j]!;
        if (a.page !== b.page) continue;
        expect(overlap(a.rect, b.rect), `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
  });

  it("an amount box's right edge stays left of the printed '.00' anchor, on the same row", () => {
    let checked = 0;
    for (const f of geometry.fields) {
      if (f.anchor === null) continue;
      checked += 1;
      expect(f.rect.x + f.rect.width, `${f.name} right edge`).toBeLessThanOrEqual(f.anchor.x);
      // The anchor's baseline sits inside the box's vertical extent.
      expect(f.anchor.y, `${f.name} baseline`).toBeGreaterThanOrEqual(f.rect.y - 3);
      expect(f.anchor.y, `${f.name} baseline`).toBeLessThanOrEqual(f.rect.y + f.rect.height + 3);
    }
    // Every right-hand dollar box has an anchor; only withholding column A/B boxes, names, descriptions and the checkbox do not.
    const anchored = geometry.fields.filter((f) => f.kind === "amount" && !/^18[a-e]B$/.test(f.line));
    expect(anchored.every((f) => f.anchor !== null)).toBe(true);
    expect(checked).toBe(anchored.length);
  });

  it("never covers an SSN, signature, routing/account, designee or PIN area (those get no field)", () => {
    // Boxes measured from the form's drawn input rectangles (pdfjs), same coordinate system as the geometry.
    const keepClear: Array<{ page: number; what: string; rect: CtOverlayField["rect"] }> = [
      { page: 0, what: "your SSN", rect: { x: 54, y: 617.7, width: 157, height: 14.9 } },
      { page: 0, what: "spouse SSN", rect: { x: 320.5, y: 617.8, width: 157, height: 14.9 } },
      { page: 0, what: "address / city block", rect: { x: 54, y: 440, width: 440, height: 105 } },
      ...[0, 1, 2, 3].map((page) => ({ page, what: "SSN header", rect: { x: 376.4, y: 728.8, width: 148.7, height: 16.2 } })),
      { page: 1, what: "refund bank block (25a-25d)", rect: { x: 40, y: 335, width: 520, height: 32 } },
      { page: 1, what: "signature / preparer / designee block", rect: { x: 30, y: 45, width: 535, height: 160 } },
    ];
    for (const k of keepClear) {
      for (const f of geometry.fields.filter((x) => x.page === k.page)) {
        expect(overlap(f.rect, k.rect), `${f.name} intrudes on ${k.what}`).toBe(false);
      }
    }
    expect(ctOverlayFieldNames().some((n) => /ssn|sign|routing|account|pin|bank|preparer/i.test(n))).toBe(false);
  });

  it("the overlay adds exactly those fields to the flat blank, at those rectangles", async () => {
    const result = await fillForm("ct1040", viewWith({ lines: {} }), ct1040Map, NO_STAMP);
    const doc = await PDFDocument.load(result.bytes);
    const fields = doc.getForm().getFields();
    expect(fields).toHaveLength(96);
    const byName = new Map(fields.map((x) => [x.getName(), x]));
    for (const g of geometry.fields) {
      const field = byName.get(g.name);
      expect(field, g.name).toBeDefined();
      const w = field!.acroField.getWidgets()[0]!.getRectangle();
      expect(w.x).toBeCloseTo(g.rect.x, 1);
      expect(w.y).toBeCloseTo(g.rect.y, 1);
      expect(w.width).toBeCloseTo(g.rect.width, 1);
      expect(w.height).toBeCloseTo(g.rect.height, 1);
      expect(doc.getPages().indexOf(doc.getPage(g.page))).toBe(g.page);
      expect(field instanceof (g.kind === "check" ? PDFCheckBox : PDFTextField)).toBe(true);
    }
    expect(doc.catalog.has(PDFName.of("Perms"))).toBe(false);
  });
});

// ── The map ───────────────────────────────────────────────────────────────────

describe("CT-1040 map", () => {
  it("claims every overlay field exactly once", () => {
    const report = checkCompleteness(ct1040Map, ctOverlayFieldNames());
    expect(report.unknown).toEqual([]);
    expect(report.duplicated).toEqual([]);
    expect(report.unclaimed).toEqual([]);
  });

  it("every money line is a real engine LINE_KEY or a pending key; the keys the engine emits are real", () => {
    const real = new Set<string>(LINE_KEYS);
    const pending = new Set<string>(PENDING_LINE_KEYS);
    const used = ct1040Map.lines.flatMap((l) => (l.kind === "money" ? [l.line] : []));
    for (const k of used) expect(real.has(k) || pending.has(k), k).toBe(true);
    for (const k of ["ct1040.1", "ct1040.additions", "ct1040.subtractions", "ct1040.ctAgi", "ct1040.6", "ct1040.9", "ct1040.10", "ct1040.11", "ct1040.15", "ct1040.18", "ct1040.19", "ct1040.20", "ct1040.27", "ct1040.28", "ct1040.balance"]) {
      expect(real.has(k), `${k} is an engine key`).toBe(true);
      expect(used, `${k} is mapped`).toContain(k);
    }
    // Every Schedule 1 detail line 31-49 is its own engine key (rules/ct-schedule1.ts) and is mapped to the matching printed box.
    for (const id of ["31", "32", "33", "34", "35", "36", "36a", "37", "39", "40", "41", "42", "43", "44", "45", "46", "47", "48", "48a", "48b", "48c", "48d", "49"]) {
      expect(real.has(`ct1040.s1.${id}`), `ct1040.s1.${id} is an engine key`).toBe(true);
      expect(ct1040Map.lines.some((l) => l.kind === "money" && l.line === `ct1040.s1.${id}` && l.field === `ct1040.l${id}`), `l${id} maps ct1040.s1.${id}`).toBe(true);
      expect(ct1040Map.blank.some((b) => "field" in b && b.field === `ct1040.l${id}`), `l${id} is not a blank any more`).toBe(false);
    }
    // Pending keys used are exactly the lines the engine does not emit; none of them is a real key.
    for (const k of used.filter((u) => !real.has(u))) expect(pending.has(k), k).toBe(true);
  });

  const FULL = linesOf([
    ["ct1040.1", 150000],
    ["ct1040.additions", 1200],
    ["ct1040.subtractions", 200],
    ["ct1040.s1.42", 1000], // a detail line with an amount prints on its own printed line
    ["ct1040.s1.39", 0], // a zero detail line stays blank, like the totals 38 / 50 when zero
    ["ct1040.ctAgi", 151000],
    ["ct1040.6", 7000],
    ["ct1040.10", 7000],
    ["ct1040.11", 300],
    ["ct1040.15", 0],
    ["ct1040.18", 5000],
    ["ct1040.balance", 1700],
  ]);

  it("golden read-back: lines, names, MFJ box, balance on line 26, everything else empty", async () => {
    FULL["ct1040.9"] = engineLine("ct1040.9", 0, "not_applicable", "No federal AMT.");
    const view = viewWith({ lines: FULL, formsRequired: { ct1040: required(true) } });
    const result = await assertMapGolden(
      ct1040Map,
      view,
      {
        "ct1040.firstName": "Alex",
        "ct1040.lastName": "Example",
        "ct1040.spouseFirstName": "Sam Q",
        "ct1040.spouseLastName": "Example",
        "ct1040.fsMfj": true,
        "ct1040.l1": "150,000",
        "ct1040.l2": "1,200",
        "ct1040.l4": "200",
        "ct1040.l5": "151,000",
        "ct1040.l6": "7,000",
        // line 9 is not applicable (0): blank
        "ct1040.l10": "7,000",
        "ct1040.l11": "300",
        "ct1040.l15": "0", // printed instruction: if no tax is due, enter 0
        "ct1040.l18": "5,000",
        "ct1040.l26": "1,700", // tax due: the positive balance
        "ct1040.l38": "1,200",
        "ct1040.l42": "1,000",
        "ct1040.l50": "200",
        "ct1040.l68": "300",
        "ct1040.l69": "0",
      },
      NO_STAMP,
    );
    expect(result.continuations).toEqual([]);
    expect(result.blankByDesign.not_modeled).toBe(ct1040Map.blank.length);
  });

  it("a blocked Schedule 1 detail line stays blank and is a blocking item on the cover; line 38 / 50 totals still print", async () => {
    const lines = linesOf([
      ["ct1040.additions", 1200],
      ["ct1040.subtractions", 200],
      engineLine("ct1040.s1.40", null, "missing_input", "Needs an owner / CPA statement."),
    ]);
    const result = await fillForm("ct1040", viewWith({ lines }), ct1040Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get("ct1040.l40")).toBe("");
    expect(f.get("ct1040.l38")).toBe("1,200");
    expect(f.get("ct1040.l50")).toBe("200");
    expect(result.openItems.find((o) => o.id === "blank:ct1040:ct1040.s1.40")?.severity).toBe("blocking");
  });

  describe("line 15 / Schedule 4 line 69 (individual use tax): 'If no tax is due, enter 0'", () => {
    it("a computed 0 and a not-applicable 0 both print '0'", async () => {
      for (const status of ["computed", "not_applicable"] as const) {
        const lines = linesOf([engineLine("ct1040.15", 0, status)]);
        const result = await fillForm("ct1040", viewWith({ lines }), ct1040Map, NO_STAMP);
        const f = await readAllFields(result.bytes);
        expect(f.get("ct1040.l15"), status).toBe("0");
        expect(f.get("ct1040.l69"), status).toBe("0");
      }
    });

    it("an amount prints as is on both lines", async () => {
      const result = await fillForm("ct1040", viewWith({ lines: linesOf([["ct1040.15", 40]]) }), ct1040Map, NO_STAMP);
      const f = await readAllFields(result.bytes);
      expect(f.get("ct1040.l15")).toBe("40");
      expect(f.get("ct1040.l69")).toBe("40");
    });

    it("an unanswered use-tax question is NEVER invented as 0: blank plus a blocking item", async () => {
      const lines = linesOf([engineLine("ct1040.15", null, "missing_input", "Line 15 must be answered with 0 or an amount.")]);
      const result = await fillForm("ct1040", viewWith({ lines }), ct1040Map, NO_STAMP);
      const f = await readAllFields(result.bytes);
      expect(f.get("ct1040.l15")).toBe("");
      expect(f.get("ct1040.l69")).toBe("");
      expect(result.openItems.find((o) => o.id === "blank:ct1040:ct1040.15")?.severity).toBe("blocking");
    });

    it("an engine that does not emit line 15 at all still raises the 'expected' item", async () => {
      const result = await fillForm("ct1040", viewWith({ lines: {} }), ct1040Map, NO_STAMP);
      expect(result.openItems.some((o) => o.id === "noemit:ct1040:ct1040.15")).toBe(true);
    });
  });

  describe("the signed CT balance prints on line 26 (due) or line 22 (overpayment), never both", () => {
    const run = async (balance: number) => {
      const result = await fillForm("ct1040", viewWith({ lines: linesOf([["ct1040.balance", balance]]) }), ct1040Map, NO_STAMP);
      return readAllFields(result.bytes);
    };
    it("positive: tax due on line 26 only", async () => {
      const f = await run(1234);
      expect(f.get("ct1040.l26")).toBe("1,234");
      expect(f.get("ct1040.l22")).toBe("");
    });
    it("negative: overpayment (as a positive number) on line 22 only", async () => {
      const f = await run(-987);
      expect(f.get("ct1040.l22")).toBe("987");
      expect(f.get("ct1040.l26")).toBe("");
    });
    it("zero: both blank", async () => {
      const f = await run(0);
      expect(f.get("ct1040.l22")).toBe("");
      expect(f.get("ct1040.l26")).toBe("");
    });
    it("a missing balance leaves both blank with a blocking item", async () => {
      const lines = linesOf([engineLine("ct1040.balance", null, "missing_input", "a CT line is not computed")]);
      const result = await fillForm("ct1040", viewWith({ lines }), ct1040Map, NO_STAMP);
      const f = await readAllFields(result.bytes);
      expect(f.get("ct1040.l22")).toBe("");
      expect(f.get("ct1040.l26")).toBe("");
      expect(result.openItems.find((o) => o.id === "blank:ct1040:ct1040.balance")?.severity).toBe("blocking");
    });
  });

  describe("withholding schedule 18a-18e", () => {
    const row = (n: number) => ({ cells: { employer: `Employer ${n} Corp`, ein: n % 2 === 0 ? null : `98-76543${n}0`, wages: 1000 * n, withheld: 10 * n } });

    it("fills Column A (employer ID, blank when unknown), B (wages) and C (withheld) in row order", async () => {
      const view = viewWith({ lines: linesOf([["ct1040.18", 30]]), tables: { "ct.withholding": [row(1), row(2)] } });
      const result = await fillForm("ct1040", view, ct1040Map, NO_STAMP);
      const f = await readAllFields(result.bytes);
      expect(f.get("ct1040.l18aA")).toBe("98-7654310");
      expect(f.get("ct1040.l18aB")).toBe("1,000");
      expect(f.get("ct1040.l18a")).toBe("10");
      expect(f.get("ct1040.l18bA")).toBe(""); // EIN unknown: blank, never invented
      expect(f.get("ct1040.l18bB")).toBe("2,000");
      expect(f.get("ct1040.l18b")).toBe("20");
      expect(f.get("ct1040.l18cB")).toBe("");
      expect(f.get("ct1040.l18")).toBe("30");
    });

    it("the form has no employer-name column, so the cover lists every row in order (even when they all fit)", async () => {
      const view = viewWith({ lines: linesOf([["ct1040.18", 30]]), tables: { "ct.withholding": [row(1), row(2)] }, formsRequired: { ct1040: required(true) } });
      const packet = await buildPacket(view, { maps: [ct1040Map] });
      expect(packet.continuations.map((c) => c.table)).toEqual(["ct.withholding"]);
      const model = buildCoverModel({ view, forms: packet.forms, fillItems: packet.openItems, continuations: packet.continuations, stamp: true });
      const text = model.blocks.map((b) => ("text" in b ? b.text : "")).join("\n");
      expect(text).toContain("Continuation: ct.withholding (ct1040), all 2 rows");
      expect(text).toContain("Employer 1 Corp");
      expect(text).toContain("Employer 2 Corp");
    });

    it("more than 5 W-2 rows: rows 1-4 as given, row 5 = 'Other (see statement)' + the sum of the rest; one cover list", async () => {
      const rows = [1, 2, 3, 4, 5, 6, 7].map(row);
      const view = viewWith({ lines: linesOf([["ct1040.18", 280]]), tables: { "ct.withholding": rows } });
      const result = await fillForm("ct1040", view, ct1040Map, NO_STAMP);
      const f = await readAllFields(result.bytes);
      expect(f.get("ct1040.l18d")).toBe("40");
      expect(f.get("ct1040.l18eA")).toBe(OVERFLOW_LABEL);
      expect(f.get("ct1040.l18e")).toBe(String(50 + 60 + 70));
      let printed = 0;
      for (const r of ["a", "b", "c", "d", "e"]) printed += Number((f.get(`ct1040.l18${r}`) as string) || "0");
      expect(printed).toBe(10 + 20 + 30 + 40 + 50 + 60 + 70);
      expect(result.continuations).toHaveLength(1);
      expect(result.continuations[0]!.rows).toHaveLength(7);
    });
  });

  describe("Schedule 3 (property tax credit) lists only the engine's qualifying bills", () => {
    const bills = [
      bill({ docId: "b-home", label: "Town A real estate", address: "1 Example Lane", paidInYearCents: 450_000, kind: "primary_residence" }),
      bill({ docId: "b-arbor", label: "Town A second property", address: "99 Arbor Example Rd", paidInYearCents: 900_000, kind: "other_real_estate" }),
      bill({ docId: "b-car1", label: "2020 Example Sedan", paidInYearCents: 30_000, kind: "motor_vehicle" }),
      bill({ docId: "b-car2", label: "2018 Example Truck", paidInYearCents: 50_000, kind: "motor_vehicle" }),
      bill({ docId: "b-car3", label: "2010 Example Wagon", paidInYearCents: 10_000, kind: "motor_vehicle" }),
      bill({ docId: "b-boat", label: "Example Boat", paidInYearCents: 20_000, kind: "other_personal_property" }),
      bill({ docId: "b-unk", label: "Unknown bill", paidInYearCents: 5_000, kind: "unclassified" }),
    ];

    it("primary residence first, then the two largest vehicles; other real estate, other personal property and unclassified never appear", () => {
      const { rows, excluded } = ctPropertyTaxRows(bills);
      expect(rows).toEqual([
        { cells: { description: "1 Example Lane", amount: 4500 } },
        { cells: { description: "2018 Example Truck", amount: 500 } },
        { cells: { description: "2020 Example Sedan", amount: 300 } },
      ]);
      expect(excluded.sort()).toEqual(["2010 Example Wagon", "Example Boat", "Town A second property", "Unknown bill"].sort());
      expect(JSON.stringify(rows)).not.toContain("Arbor");
    });

    it("the filled form never mentions the excluded property anywhere", async () => {
      const { rows } = ctPropertyTaxRows(bills);
      const view = viewWith({ lines: linesOf([["ct1040.11", 300]]), tables: { "ct.propertyTax": rows } });
      const result = await fillForm("ct1040", view, ct1040Map, NO_STAMP);
      const f = await readAllFields(result.bytes);
      expect(f.get("ct1040.l60d")).toBe("1 Example Lane");
      expect(f.get("ct1040.l60")).toBe("4,500");
      expect(f.get("ct1040.l61d")).toBe("2018 Example Truck");
      expect(f.get("ct1040.l61")).toBe("500");
      expect(f.get("ct1040.l62d")).toBe("2020 Example Sedan");
      expect(f.get("ct1040.l62")).toBe("300");
      expect(f.get("ct1040.l68")).toBe("300"); // the engine's credit
      for (const value of f.values()) if (typeof value === "string") expect(value).not.toMatch(/Arbor|Boat|Wagon|Unknown/);
    });

    it("only Arbor Rd (no qualifying bill): Schedule 3 stays empty", () => {
      expect(ctPropertyTaxRows([bills[1]!]).rows).toEqual([]);
    });

    it("no primary residence but a vehicle: the vehicle stays on line 61 (line 60 left empty)", () => {
      const { rows } = ctPropertyTaxRows([bills[2]!]);
      expect(rows).toEqual([{ cells: {} }, { cells: { description: "2020 Example Sedan", amount: 300 } }]);
    });

    it("an unpaid (not entered) amount stays null, never 0", () => {
      const { rows } = ctPropertyTaxRows([bill({ docId: "x", label: "Home", address: "1 Example Lane", paidInYearCents: null, kind: "primary_residence" })]);
      expect(rows[0]?.cells.amount).toBeNull();
    });

    it("two bills for the home are added into one primary-residence row (as the engine does)", () => {
      const { rows } = ctPropertyTaxRows([
        bill({ docId: "h1", label: "Home Jul", address: "1 Example Lane", paidInYearCents: 100_000, kind: "primary_residence" }),
        bill({ docId: "h2", label: "Home Jan", address: "1 Example Lane", paidInYearCents: 120_050, kind: "primary_residence" }),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.cells.amount).toBe(2201); // 2200.50 rounded half up as the engine does for a line
    });
  });

  it("identity: names only; a missing spouse name leaves the box blank with an advisory item", async () => {
    const view = viewWith({ lines: {}, header: { spouseName: null } });
    const result = await fillForm("ct1040", view, ct1040Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get("ct1040.firstName")).toBe("Alex");
    expect(f.get("ct1040.spouseFirstName")).toBe("");
    expect(result.openItems.some((o) => o.id === "fill:ct1040:header:household.spouseFirst")).toBe(true);
  });

  it("the MFJ box is checked only when the answer is mfj", async () => {
    const yes = await readAllFields((await fillForm("ct1040", viewWith({ lines: {} }), ct1040Map, NO_STAMP)).bytes);
    expect(yes.get("ct1040.fsMfj")).toBe(true);
    const none = await fillForm("ct1040", viewWith({ lines: {}, answers: {} }), ct1040Map, NO_STAMP);
    expect((await readAllFields(none.bytes)).get("ct1040.fsMfj")).toBe(false);
    expect(none.openItems.some((o) => o.id === "fill:ct1040:answer:filingStatus")).toBe(true);
  });

  it("SSN-like text in a Schedule 3 description is refused, never written", async () => {
    const view = viewWith({ lines: {}, tables: { "ct.propertyTax": [{ cells: { description: "123-45-6789", amount: 10 } }] } });
    const result = await fillForm("ct1040", view, ct1040Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    expect(f.get("ct1040.l60d")).toBe("");
    expect(f.get("ct1040.l60")).toBe("10");
    expect(result.openItems.some((o) => o.id.includes("ssnlike"))).toBe(true);
  });
});

// ── Packet and cover ─────────────────────────────────────────────────────────

describe("CT-1040 in the packet", () => {
  it("is included, placed last under ct/, and the cover states that it is a flat form", async () => {
    const view = viewWith({ lines: linesOf([["ct1040.1", 100]]), formsRequired: { ct1040: required(true, "Connecticut resident return.") } });
    const packet = await buildPacket(view, { maps: [ct1040Map] });
    expect(Object.keys(unzipSync(packet.zip))).toEqual(["00-cover.pdf", "ct/ct1040.pdf"]);
    const model = buildCoverModel({ view, forms: packet.forms, fillItems: packet.openItems, continuations: packet.continuations, stamp: true });
    const text = model.blocks.map((b) => ("text" in b ? b.text : "")).join("\n");
    expect(text).toContain(CT1040_FLAT_NOTE);
    expect(text).toContain("CT-1040 is a flat form: fields were added by this app");
    // The packet CT-1040 is a normal AcroForm: our fields are editable and not flattened.
    const ct = await PDFDocument.load(unzipSync(packet.zip)["ct/ct1040.pdf"]!);
    expect(ct.getPageCount()).toBe(4);
    expect(ct.getForm().getFields()).toHaveLength(96);
    expect(ct.getForm().getFields().every((x) => !x.isReadOnly())).toBe(true);
  });
});

// ── Against the REAL engine ──────────────────────────────────────────────────

describe("CT-1040 map against the real engine output", () => {
  const ret = computeTy2025Return(fullFacts());
  const view = viewFromEngine(ret);

  it("fills the engine's CT lines on the right printed lines", async () => {
    const result = await fillForm("ct1040", view, ct1040Map, NO_STAMP);
    const f = await readAllFields(result.bytes);
    const fmt = (n: number): string => n.toLocaleString("en-US");
    const amount = (key: Parameters<typeof engineLine>[0]): number => {
      const l = ret.lines[key];
      if (!l || l.amount === null) throw new Error(`engine did not compute ${key}`);
      return l.amount;
    };
    expect(f.get("ct1040.l1")).toBe(fmt(amount("ct1040.1")));
    expect(f.get("ct1040.l5")).toBe(fmt(amount("ct1040.ctAgi")));
    expect(f.get("ct1040.l6")).toBe(fmt(amount("ct1040.6")));
    expect(f.get("ct1040.l10")).toBe(fmt(amount("ct1040.10")));
    expect(f.get("ct1040.l18")).toBe(fmt(amount("ct1040.18")));
    expect(f.get("ct1040.l15")).toBe("0"); // use tax answered 0
    expect(f.get("ct1040.l69")).toBe("0");
    const balance = amount("ct1040.balance");
    expect(f.get(balance > 0 ? "ct1040.l26" : "ct1040.l22")).toBe(fmt(Math.abs(balance)));
    expect(f.get(balance > 0 ? "ct1040.l22" : "ct1040.l26")).toBe("");
    // The engine's penalty / interest lines need the CPA: blank + blocking item, never 0.
    expect(f.get("ct1040.l27")).toBe("");
    expect(result.openItems.find((o) => o.id === "blank:ct1040:ct1040.27")?.severity).toBe("blocking");
  });

  it("the engine requires the CT-1040 (formsRequired.ct1040) so the packet includes it", async () => {
    expect(ret.formsRequired.ct1040?.required).toBe(true);
    const packet = await buildPacket(view, { maps: [ct1040Map] });
    expect(packet.files.map((x) => x.name)).toContain("ct/ct1040.pdf");
  });
});
