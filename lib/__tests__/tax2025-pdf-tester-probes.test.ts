// Independent Tester probes for the TY2025 PDF engine core (task ty2025-pdf-engine-core).
// Written by the Tester, not the Coder: they re-derive facts from the REAL blank PDF
// dictionaries and from raw output objects instead of trusting the committed catalog or
// the Coder's helpers. The last three probes pinned defects D1 and D2 of 03-test-report.md
// (they were it.fails); both are fixed in round 2 and they are now ordinary passing tests.

import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { PDFCheckBox, PDFDict, PDFDocument, PDFName, PDFNumber, PDFHexString, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { getBlankBytes } from "@/lib/tax2025/pdf/registry";
import { sanitizeWinAnsi } from "@/lib/tax2025/pdf/winansi";
import { DEFAULT_FILL_OPTIONS, loadCatalog } from "./tax2025-pdf-harness";
import { f1040Lines, makeView, pdfLine } from "./fixtures/tax2025-pdf-view.fixture";

const P1 = "topmostSubform[0].Page1[0].";
const FS = `${P1}Checkbox_ReadOrder[0].`;

describe("tester: filing-status on-values straight from the real blank's field dictionaries", () => {
  it("the five boxes have on-values 1..5 and MFJ is /2 (plan 6.6 said /1: plan error)", async () => {
    const blank = await PDFDocument.load(getBlankBytes("f1040"));
    const form = blank.getForm();
    const boxes: Array<[string, string]> = [
      [`${FS}c1_8[0]`, "/1"],
      [`${FS}c1_8[1]`, "/2"],
      [`${FS}c1_8[2]`, "/3"],
      [`${P1}c1_8[0]`, "/4"],
      [`${P1}c1_8[1]`, "/5"],
    ];
    for (const [name, on] of boxes) expect(String(form.getCheckBox(name).acroField.getOnValue()), name).toBe(on);
  });

  it("filled MFJ: /V and widget /AS are /2 and the other four boxes are /Off", async () => {
    const result = await fillForm("f1040", makeView(), f1040Map, DEFAULT_FILL_OPTIONS);
    const form = (await PDFDocument.load(result.bytes)).getForm();
    const mfj = form.getCheckBox(`${FS}c1_8[1]`);
    expect(String(mfj.acroField.dict.lookup(PDFName.of("V")))).toBe("/2");
    expect(String(mfj.acroField.getWidgets()[0]?.dict.lookup(PDFName.of("AS")))).toBe("/2");
    for (const name of [`${FS}c1_8[0]`, `${FS}c1_8[2]`, `${P1}c1_8[0]`, `${P1}c1_8[1]`]) {
      expect(String(form.getCheckBox(name).acroField.getWidgets()[0]?.dict.lookup(PDFName.of("AS"))), name).toBe("/Off");
    }
  });
});

describe("tester: raw-object fidelity of the filled 1040", () => {
  it("no reachable /XFA /Perms /Extensions /NeedAppearances; no read-only flag (inherited Ff checked); 199 widgets all with /AP", async () => {
    const result = await fillForm("f1040", makeView(), f1040Map, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(result.bytes, { updateMetadata: false });
    const acro = doc.catalog.lookup(PDFName.of("AcroForm"), PDFDict);
    for (const k of ["XFA", "NeedAppearances"]) expect(acro.has(PDFName.of(k)), k).toBe(false);
    for (const k of ["Perms", "Extensions"]) expect(doc.catalog.has(PDFName.of(k)), k).toBe(false);
    const fields = doc.getForm().getFields();
    expect(fields).toHaveLength(199);
    let widgets = 0;
    for (const f of fields) {
      let d: PDFDict | undefined = f.acroField.dict;
      let ff = 0;
      while (d) {
        const v = d.lookup(PDFName.of("Ff"));
        if (v instanceof PDFNumber) {
          ff = v.asNumber();
          break;
        }
        d = d.lookupMaybe(PDFName.of("Parent"), PDFDict);
      }
      expect(ff & 1, `${f.getName()} read-only`).toBe(0);
      for (const w of f.acroField.getWidgets()) {
        widgets += 1;
        expect(w.dict.has(PDFName.of("AP")), `${f.getName()} has /AP`).toBe(true);
      }
    }
    expect(widgets).toBe(199);
    // not flattened: every widget is still a page annotation
    let annots = 0;
    for (const p of doc.getPages()) annots += p.node.Annots()?.size() ?? 0;
    expect(annots).toBe(199);
  });
});

describe("tester: 1040 blank-by-design classification re-derived from the catalog speak text", () => {
  it("every SSN / routing / account / PIN / preparer / designee / address / occupation / dependents field is an explicit non-not_modeled blank", () => {
    const sens =
      /social security|S S N|identifying number|E I N|routing|account number|account type|P I N|phone|email|address|preparer|designee|signature|occupation|dependent/i;
    const benign = new Set([
      `${P1}f1_29[0]`, // HOH/QSS child's name (name only, not_modeled blank)
      `${P1}f1_51[0]`, // 1e dependent care benefits (money line since T2a, text matches 'dependent')
      `${P1}f1_68[0]`, // 6a social security BENEFITS (money line)
      "topmostSubform[0].Page2[0].c2_1[0]", // 12a someone can claim you as a dependent
      "topmostSubform[0].Page2[0].c2_2[0]",
      "topmostSubform[0].Page2[0].f2_11[0]", // 19 child tax credit / other dependents
    ]);
    const blankByReason = new Map<string, string>();
    const names = loadCatalog("f1040").fields.map((f) => f.name);
    for (const b of f1040Map.blank) {
      if ("field" in b) blankByReason.set(b.field, b.reason);
      else for (const n of names) if (b.match.test(n)) blankByReason.set(n, b.reason);
    }
    const written = new Set([...f1040Map.lines.map((l) => l.field), ...f1040Map.header.map((h) => h.field)]);
    let checked = 0;
    for (const f of loadCatalog("f1040").fields) {
      if (!sens.test(f.speak ?? "") && !/SSN|Routing|Account|Address/.test(f.name)) continue;
      checked += 1;
      // Benign fields are money lines (or name-only boxes) whose speak text merely contains a sensitive word;
      // since the full 1040 map (T2a) they may be written. Every other sensitive field must never be.
      if (benign.has(f.name)) continue;
      expect(written.has(f.name), `${f.name} must never be written`).toBe(false);
      const reason = blankByReason.get(f.name);
      expect(reason, `${f.name} (${f.speak?.slice(0, 40)})`).toBeDefined();
      expect(reason, `${f.name}`).not.toBe("not_modeled");
    }
    expect(checked).toBeGreaterThan(60);
  });
});

describe("tester: sanitizer over the whole BMP", () => {
  it("sanitizeWinAnsi output always encodes in Helvetica (no throw for any BMP code point)", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (let cp = 0; cp <= 0xffff; cp += 1) {
      const s = sanitizeWinAnsi(`a${String.fromCharCode(cp)}b`); // includes lone surrogates
      font.encodeText(s);
    }
  });
});

describe("tester: former known defects D1 and D2 (fixed in round 2)", () => {
  // D1: plan 6.4 says containsSsnLikeText runs on EVERY string written to any PDF. Only form-field
  // text is guarded; cover blocks (open items, override notes, continuation cells), /TU tooltips and
  // stamp text are not.
  it("D1: SSN-like text in an engine open item must not reach the cover model", () => {
    const view = makeView({
      openItems: [
        {
          id: "x1",
          severity: "blocking",
          formLabel: "Form 1040",
          lineKeys: [],
          message: "Spouse SSN 987-65-4321 was typed into a note",
          action: "Check it",
        },
      ],
    });
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    expect(JSON.stringify(model.blocks)).not.toMatch(/987-65-4321/);
  });

  it("D1: SSN-like text in an override note must not be written to a field /TU tooltip", async () => {
    const lines = f1040Lines();
    lines["f1040.10"] = pdfLine({
      key: "f1040.10",
      formLabel: "Form 1040",
      formLine: "10",
      label: "Adjustments",
      status: "overridden",
      amount: 3000,
      override: { note: "CPA override: reason mentions SSN 987-65-4321", computedAmount: 1, stale: false },
    });
    const result = await fillForm("f1040", makeView({ lines }), f1040Map, DEFAULT_FILL_OPTIONS);
    const form = (await PDFDocument.load(result.bytes)).getForm();
    const tu = form.getTextField(`${P1}f1_74[0]`).acroField.dict.lookup(PDFName.of("TU"));
    expect(tu instanceof PDFHexString ? tu.decodeText() : "").not.toMatch(/987-65-4321/);
  });

  // D2: an answer that is present but unrecognised ("MFJ", "married", a typo) leaves every filing-status
  // box unchecked with NO open item; only a missing (undefined/null) answer raises "answer needed".
  it("D2: an unrecognised filing-status answer must raise an answer-needed item", async () => {
    const result = await fillForm("f1040", makeView({ answers: { filingStatus: "MFJ" } }), f1040Map, DEFAULT_FILL_OPTIONS);
    const doc = await PDFDocument.load(result.bytes);
    const checked = doc.getForm().getFields().filter((f) => f instanceof PDFCheckBox && f.isChecked());
    expect(checked).toHaveLength(0);
    expect(result.openItems.some((i) => i.id === "fill:f1040:answer:filingStatus")).toBe(true);
  });
});
