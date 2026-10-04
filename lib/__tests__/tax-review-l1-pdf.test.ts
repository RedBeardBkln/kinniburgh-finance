import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { beforeAll, describe, expect, it } from "vitest";
import { PDFCheckBox, PDFHexString, PDFName, PDFTextField } from "pdf-lib";
import { lineMeta, type LineKey } from "@/lib/tax2025/line-catalog";
import { OVERFLOW_LABEL } from "@/lib/tax2025/pdf/fill";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { schBMap } from "@/lib/tax2025/pdf/maps/schB";
import type { FormMap, MapMoneyLine, MapTable, PdfLine, PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { L1Context } from "@/lib/tax-review/l1/context";
import { derivedAnswers, pdfAnswersCheck } from "@/lib/tax-review/l1/pdf-answers";
import { auditLabels, labelAuditCheck, labelMatches } from "@/lib/tax-review/l1/pdf-labels";
import { pdfMetadataCheck } from "@/lib/tax-review/l1/pdf-metadata";
import { readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { strayInkCheck } from "@/lib/tax-review/l1/pdf-stray-ink";
import { printedLineId, unkeyedLinesCheck } from "@/lib/tax-review/l1/pdf-unkeyed";
import { expectedHeader, expectedMoney, expectedTableCells, OVERFLOW_ROW_LABEL, pdfValuesCheck, printedDollars } from "@/lib/tax-review/l1/pdf-values";
import type { Finding } from "@/lib/tax-review/types";
import { buildPipeline, cleanScenario, editPacketFile, fieldOfLine, richScenario, setText } from "./tax-review-harness";

let clean: L1Context;
let rich: L1Context;

beforeAll(async () => {
  clean = (await buildPipeline(cleanScenario())).ctx;
  rich = (await buildPipeline(richScenario())).ctx;
});

/** A context whose packet files are private copies, so a hand edit never leaks into the shared fixture. */
function privateCopy(ctx: L1Context): L1Context {
  return { ...ctx, packet: { ...ctx.packet, files: ctx.packet.files.map((f) => ({ ...f })) } };
}

const run = async (check: { run: (c: L1Context) => Finding[] | Promise<Finding[]> }, ctx: L1Context): Promise<Finding[]> => check.run(ctx);

function line(over: Partial<PdfLine> & { status: PdfLine["status"]; amount: number | null }): PdfLine {
  return { key: "f1040.9", formLabel: "Form 1040", formLine: "9", label: "Total income", reason: null, ...over };
}

const money = (over: Partial<MapMoneyLine> = {}): MapMoneyLine => ({ kind: "money", field: "f", line: "f1040.9", ...over });

describe("expectedMoney re-states the blank-line policy", () => {
  const none = {};
  it("prints a computed non-zero amount with thousands commas and a leading minus", () => {
    expect(expectedMoney(line({ status: "computed", amount: 1234567 }), money(), none).text).toBe("1,234,567");
    expect(expectedMoney(line({ status: "computed", amount: -1234 }), money(), none).text).toBe("-1,234");
    expect(printedDollars(0)).toBe("0");
  });
  it("leaves a computed zero blank unless the map says zero:print", () => {
    expect(expectedMoney(line({ status: "computed", amount: 0 }), money(), none).text).toBeNull();
    expect(expectedMoney(line({ status: "computed", amount: 0 }), money({ zero: "print" }), none).text).toBe("0");
  });
  it("zeroWhen prints 0 only while its answer holds", () => {
    const e = money({ zeroWhen: { choice: "schdLine16Zero", equals: true } });
    expect(expectedMoney(line({ status: "computed", amount: 0 }), e, { schdLine16Zero: true }).text).toBe("0");
    expect(expectedMoney(line({ status: "computed", amount: 0 }), e, {}).text).toBeNull();
  });
  it("an override of $0 is an instruction and prints", () => {
    expect(expectedMoney(line({ status: "overridden", amount: 0 }), money(), none).text).toBe("0");
    expect(expectedMoney(line({ status: "overridden", amount: 500 }), money(), none).text).toBe("500");
  });
  it("not applicable is blank (0 only where the map prints zeros) and a non-zero one is an anomaly", () => {
    expect(expectedMoney(line({ status: "not_applicable", amount: 0 }), money(), none)).toEqual({ text: null });
    expect(expectedMoney(line({ status: "not_applicable", amount: 0 }), money({ zero: "print" }), none).text).toBe("0");
    expect(expectedMoney(line({ status: "not_applicable", amount: 5 }), money(), none).anomaly).toMatch(/non-zero/);
  });
  it("a line with no amount is ALWAYS blank, whatever the map says", () => {
    for (const status of ["missing_input", "needs_cpa_judgment", "needs_cpa_rule_unverified", "not_yet_computed"] as const) {
      expect(expectedMoney(line({ status, amount: null }), money({ zero: "print" }), none).text).toBeNull();
    }
    expect(expectedMoney(undefined, money({ zero: "print" }), none).text).toBeNull();
  });
  it("one signed amount feeds two lines: owed prints positives, refund prints the magnitude of negatives", () => {
    expect(expectedMoney(line({ status: "computed", amount: 4588 }), money({ sign: "owed" }), none).text).toBe("4,588");
    expect(expectedMoney(line({ status: "computed", amount: 4588 }), money({ sign: "refund" }), none).text).toBeNull();
    expect(expectedMoney(line({ status: "computed", amount: -300 }), money({ sign: "refund" }), none).text).toBe("300");
    expect(expectedMoney(line({ status: "computed", amount: -300 }), money({ sign: "owed" }), none).text).toBeNull();
  });
  it("a computed line without an amount is an anomaly", () => {
    expect(expectedMoney(line({ status: "computed", amount: null }), money(), none).anomaly).toBeDefined();
  });
});

describe("expectedTableCells and header", () => {
  const table: MapTable = {
    table: "schb.interest",
    rows: [{ payer: "p1", amount: "a1" }, { payer: "p2", amount: "a2" }],
    amountColumn: "amount",
    labelColumn: "payer",
    overflow: "summary_row_and_statement",
  };
  const view = (rows: { payer: string; amount: number }[]): PdfReturnView => ({ ...(clean.view as PdfReturnView), tables: { "schb.interest": rows.map((r) => ({ cells: r })) } });
  it("fills rows in order and leaves the rest empty", () => {
    expect(expectedTableCells(table, view([{ payer: "A", amount: 5 }]))).toEqual([{ payer: "A", amount: 5 }, {}]);
  });
  it("an overflowing table keeps rows 1..n-1 and sums the rest into 'Other (see statement)'", () => {
    const out = expectedTableCells(table, view([{ payer: "A", amount: 5 }, { payer: "B", amount: 7 }, { payer: "C", amount: 9 }]));
    expect(out[0]).toEqual({ payer: "A", amount: 5 });
    expect(out[1]).toEqual({ payer: OVERFLOW_ROW_LABEL, amount: 16 });
  });
  it("the overflow label equals the filler's", () => {
    expect(OVERFLOW_ROW_LABEL).toBe(OVERFLOW_LABEL);
  });
  it("header sources", () => {
    const v = { ...clean.view, header: { householdNames: "A B and C D", taxpayerName: "A B", spouseName: "C D", ekcName: "X LLC" } };
    expect(expectedHeader("household.names", v)).toBe("A B and C D");
    expect(expectedHeader("household.taxpayerFirst", v)).toBe("A");
    expect(expectedHeader("household.spouseLast", v)).toBe("D");
    expect(expectedHeader("entity.ekcName", v)).toBe("X LLC");
    expect(expectedHeader("year", v)).toBe("2025");
    expect(expectedHeader("household.spouse", { ...v, header: { ...v.header, spouseName: null } })).toBeNull();
  });
  it("the Schedule B map really uses these tables", () => {
    expect(schBMap.tables.length).toBeGreaterThan(0);
  });
});

describe("L1.B1 PDF equals the engine", () => {
  it("passes on a freshly built packet (clean and rich: ~1,800 fields read back)", async () => {
    expect(await run(pdfValuesCheck, clean)).toEqual([]);
    expect(await run(pdfValuesCheck, rich)).toEqual([]);
  });
  it("a printed amount changed by hand is a blocker; a blank where the return computed one is too", async () => {
    const ctx = privateCopy(clean);
    await editPacketFile(ctx.packet, "01-f1040.pdf", (form) => {
      setText(form, fieldOfLine(f1040Map, "f1040.1a"), "1");
      setText(form, fieldOfLine(f1040Map, "f1040.9"), "");
    });
    const f = await run(pdfValuesCheck, ctx);
    const lines = f.filter((x) => x.check === "L1.B1.money").map((x) => x.lineKey);
    expect(lines).toContain("f1040.1a");
    expect(lines).toContain("f1040.9");
    expect(f.find((x) => x.lineKey === "f1040.9")?.message).toMatch(/blank/);
  });
  it("a header name that differs, and a table cell that differs", async () => {
    const ctx = privateCopy(rich);
    const nameField = f1040Map.header.find((h) => h.source === "household.taxpayerFirst")?.field;
    if (!nameField) throw new Error("no taxpayer header field");
    await editPacketFile(ctx.packet, "01-f1040.pdf", (form) => setText(form, nameField, "Somebody Else"));
    const rows = schBMap.tables.find((t) => t.table === "schb.interest")?.rows[0];
    const amountField = rows?.["amount"];
    if (!amountField) throw new Error("no Schedule B amount cell");
    await editPacketFile(ctx.packet, "06-f1040sb.pdf", (form) => setText(form, amountField, "12,345"));
    const f = await run(pdfValuesCheck, ctx);
    expect(f.some((x) => x.check === "L1.B1.header")).toBe(true);
    expect(f.some((x) => x.check === "L1.B1.table")).toBe(true);
  });
  it("a packet file with no matching form map cannot be compared (blocker)", async () => {
    const f = await run(pdfValuesCheck, { ...clean, maps: clean.maps.filter((m) => m.formId !== "f1040sc") });
    expect(f.some((x) => x.check === "L1.B1.unbound" && x.formKey === "f1040sc")).toBe(true);
  });
  it("messages never echo field text that is not an amount", async () => {
    const ctx = privateCopy(clean);
    await editPacketFile(ctx.packet, "01-f1040.pdf", (form) => setText(form, fieldOfLine(f1040Map, "f1040.8"), "see attached secret words"));
    const f = await run(pdfValuesCheck, ctx);
    expect(JSON.stringify(f)).not.toMatch(/secret words/);
  });
});

describe("L1.B2 no stray ink", () => {
  const blankFieldWith = (map: FormMap, reason: string): string => {
    const b = map.blank.find((x) => x.reason === reason && "field" in x);
    if (b && "field" in b) return b.field;
    throw new Error(`no blank field with reason ${reason}`);
  };
  it("passes on a built packet", async () => {
    expect(await run(strayInkCheck, rich)).toEqual([]);
  });
  it("a field the map leaves blank for a private reason must stay empty", async () => {
    const ctx = privateCopy(clean);
    const ssnField = f1040Map.blank.find((b) => b.reason === "ssn" && "field" in b);
    const target = ssnField && "field" in ssnField ? ssnField.field : blankFieldWith(f1040Map, "signature_pin");
    await editPacketFile(ctx.packet, "01-f1040.pdf", (form) => setText(form, target, "x"));
    const f = await run(strayInkCheck, ctx);
    expect(f.some((x) => x.check === "L1.B2.private" && x.area === "privacy" && x.severity === "blocker")).toBe(true);
  });
  it("a checked box that the map does not fill is stray ink too", async () => {
    const ctx = privateCopy(clean);
    let touched = "";
    await editPacketFile(ctx.packet, "01-f1040.pdf", (form) => {
      const claimed = new Set(f1040Map.lines.map((l) => l.field));
      const box = form.getFields().find((f) => f instanceof PDFCheckBox && !claimed.has(f.getName()));
      if (!(box instanceof PDFCheckBox)) throw new Error("no unclaimed checkbox");
      box.check();
      touched = box.getName();
    });
    expect(touched).not.toBe("");
    const f = await run(strayInkCheck, ctx);
    expect(f.some((x) => x.severity === "blocker" && /stray|private|preparer/.test(x.check))).toBe(true);
  });
});

describe("L1.B3 printed-line label audit", () => {
  it("accepts equal labels and the single-letter sub-label, rejects the rest", () => {
    expect(labelMatches("11a", "11a")).toBe(true);
    expect(labelMatches("7b", "b")).toBe(true);
    expect(labelMatches("7b", "a")).toBe(false);
    expect(labelMatches("12e", "13a")).toBe(false);
  });
  it("the real maps agree with the independent table on every audited field", () => {
    const a = auditLabels(clean);
    expect(a.findings).toEqual([]);
    expect(a.compared).toBeGreaterThan(250);
  });
  it("reports the forms it could not audit instead of passing them silently", () => {
    const a = auditLabels(clean);
    expect(a.formsNotAudited.sort()).toEqual(["ct1040", "f1040sb", "f1040sd", "f8959", "f8995"].sort());
  });
  it("a pending (not yet emitted) key has no printed line and is skipped", () => {
    const pending: FormMap = { ...f1040Map, lines: [{ kind: "money", field: Object.keys(clean.lineLabels["f1040"] ?? {})[0] ?? "x", line: "f1040.pending" as unknown as LineKey }] };
    expect(auditLabels({ maps: [pending], lineLabels: clean.lineLabels }).findings).toEqual([]);
  });
  it("an exchanged pair is a blocker for both fields", () => {
    const a = fieldOfLine(f1040Map, "f1040.3b");
    const b = fieldOfLine(f1040Map, "f1040.4b");
    const swapped: FormMap = {
      ...f1040Map,
      lines: f1040Map.lines.map((l) => (l.kind === "money" && l.field === a ? { ...l, field: b } : l.kind === "money" && l.field === b ? { ...l, field: a } : l)),
    };
    const f = auditLabels({ maps: [swapped], lineLabels: clean.lineLabels }).findings;
    expect(f.map((x) => x.lineKey).sort()).toEqual(["f1040.3b", "f1040.4b"]);
    expect(f[0]?.acceptable).toBe(false);
    expect(labelAuditCheck.id).toBe("L1.B3");
  });
  it("the label table covers each of its forms completely against the engine's printed lines", () => {
    for (const map of FORM_MAPS) {
      const table = clean.lineLabels[map.formId];
      if (!table) continue;
      for (const e of map.lines) {
        if (e.kind !== "money" || table[e.field] === undefined) continue;
        expect(labelMatches(lineMeta(e.line as LineKey).formLine, table[e.field] ?? ""), `${map.formId} ${String(e.line)}`).toBe(true);
      }
    }
  });
});

describe("L1.B4 checkboxes and answers", () => {
  it("passes on a built packet, and derives the answers independently of the adapter", async () => {
    expect(await run(pdfAnswersCheck, clean)).toEqual([]);
    expect(await run(pdfAnswersCheck, rich)).toEqual([]);
    const d = derivedAnswers(clean);
    expect(d["filingStatus"]).toBe("mfj");
    expect(d["digitalAssets"]).toBe("no");
    expect(d["foreignAccounts"]).toBe("no");
  });
  it("an answer in the view that the return does not support is a blocker", async () => {
    const view = structuredClone(clean.view);
    (view.answers as Record<string, string | boolean | null>)["digitalAssets"] = "yes";
    const f = await run(pdfAnswersCheck, { ...clean, view });
    expect(f.some((x) => x.check === "L1.B4.answer")).toBe(true);
  });
  it("the Schedule D 'not required' box may be checked only when Exception 1 holds", async () => {
    const view = structuredClone(clean.view);
    (view.answers as Record<string, string | boolean | null>)["schdNotRequired"] = true;
    const f = await run(pdfAnswersCheck, { ...clean, view });
    expect(f.some((x) => x.check === "L1.B4.answer" && /schdNotRequired/.test(x.message))).toBe(true);
  });
  it("no filing-status box, or two, or a box other than married filing jointly, is a blocker", async () => {
    const boxes = f1040Map.lines.filter((l) => l.kind === "check" && l.choice === "filingStatus");
    expect(boxes.length).toBeGreaterThan(2);
    const none = privateCopy(clean);
    await editPacketFile(none.packet, "01-f1040.pdf", (form) => {
      for (const b of boxes) if (b.kind === "check") (form.getCheckBox(b.field)).uncheck();
    });
    expect((await run(pdfAnswersCheck, none)).some((x) => x.check === "L1.B4.filing-status" && /no filing status box/.test(x.message))).toBe(true);
    const two = privateCopy(clean);
    await editPacketFile(two.packet, "01-f1040.pdf", (form) => {
      for (const b of boxes.slice(0, 2)) if (b.kind === "check") form.getCheckBox(b.field).check();
    });
    expect((await run(pdfAnswersCheck, two)).some((x) => x.check === "L1.B4.filing-status")).toBe(true);
  });
  it("a checkbox that differs from its answer is a blocker", async () => {
    const ctx = privateCopy(clean);
    const box = f1040Map.lines.find((l) => l.kind === "check" && l.choice === "digitalAssets" && l.equals === "yes");
    if (!box || box.kind !== "check") throw new Error("no digital assets box");
    await editPacketFile(ctx.packet, "01-f1040.pdf", (form) => form.getCheckBox(box.field).check());
    const f = await run(pdfAnswersCheck, ctx);
    expect(f.some((x) => x.check === "L1.B4.box")).toBe(true);
  });
});

describe("L1.B5 printed money lines no map claims", () => {
  it("reads the line id of a printed line text", () => {
    expect(printedLineId("11a. Subtract line 10 from line 9")).toBe("11a");
    expect(printedLineId("Row: 1a. Totals")).toBeNull();
    expect(printedLineId("7. Add lines")).toBe("7");
  });
  it("lists unmodeled lines as information and never as a high on the real maps (sub-fields of a mapped line are not gaps)", async () => {
    const f = await run(unkeyedLinesCheck, rich);
    expect(f.filter((x) => x.severity === "high")).toEqual([]);
    expect(f.every((x) => x.severity === "info")).toBe(true);
    expect(f.length).toBeGreaterThan(0);
  });
  it("a line that is part of a footing rule but whose field no map fills is high", async () => {
    const without12e: FormMap = { ...f1040Map, lines: f1040Map.lines.filter((l) => !(l.kind === "money" && l.line === "f1040.12e")), blank: [...f1040Map.blank] };
    const maps = rich.maps.map((m) => (m.formId === "f1040" ? without12e : m));
    const f = await run(unkeyedLinesCheck, { ...rich, maps });
    expect(f.some((x) => x.check === "L1.B5.footing-part" && x.severity === "high" && x.acceptable)).toBe(true);
  });
});

describe("L1.B6 metadata and tooltips", () => {
  it("a draft packet says DRAFT in every file's properties", async () => {
    expect(await run(pdfMetadataCheck, clean)).toEqual([]);
  });
  it("a draft file whose properties do not say DRAFT is a blocker", async () => {
    const ctx = privateCopy(clean);
    await editPacketFile(ctx.packet, "01-f1040.pdf", (_form, doc) => {
      doc.setSubject("Tax year 2025");
      doc.setTitle("Form 1040");
      doc.setKeywords([]);
    });
    const f = await run(pdfMetadataCheck, ctx);
    expect(f.map((x) => x.check)).toEqual(["L1.B6.draft-marker"]);
  });
  it("a final package with neutral properties and tooltips passes; wording in a property or tooltip does not", async () => {
    const ctx = privateCopy({ ...clean, mode: "final" });
    for (const f of ctx.packet.files) {
      if (f.formId === null) continue;
      await editPacketFile(ctx.packet, f.name, (_form, doc) => {
        doc.setSubject("Tax year 2025");
        doc.setKeywords([]);
      });
    }
    expect(await run(pdfMetadataCheck, ctx)).toEqual([]);
    await editPacketFile(ctx.packet, "01-f1040.pdf", (form, doc) => {
      doc.setKeywords(["prepared by Claude"]);
      const field = form.getFields().find((x) => x instanceof PDFTextField);
      field?.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText("CPA override note"));
    });
    const f = await run(pdfMetadataCheck, ctx);
    expect(f.map((x) => x.check).sort()).toEqual(["L1.B6.property", "L1.B6.tooltip"]);
  });
  it("reads every form PDF back and skips the cover", async () => {
    const files = await readPacketFiles(clean.packet.files);
    expect(files.length).toBe(clean.packet.files.length - 1);
    expect(files.every((f) => f.fields.size > 10)).toBe(true);
  });
});

describe("table maps used by the PDF checks", () => {
  it("every table of every map has the columns its rows use", () => {
    for (const m of FORM_MAPS) {
      for (const t of m.tables) {
        if (t.overflow === "summary_row_and_statement") {
          expect(t.rows[0] && t.amountColumn in t.rows[0]).toBe(true);
          expect(t.rows[0] && t.labelColumn in t.rows[0]).toBe(true);
        }
      }
    }
  });
});
