import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildCoverModel, renderCover, type CoverBlock } from "@/lib/tax2025/pdf/cover";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import { SSN_PLACEHOLDER, safeText } from "@/lib/tax2025/pdf/safe-text";
import { stampPages } from "@/lib/tax2025/pdf/stamp";
import type { FormMap } from "@/lib/tax2025/pdf/types";
import { DEFAULT_FILL_OPTIONS, readAllFields } from "./tax2025-pdf-harness";
import { f1040Lines, makeView, pdfLine } from "./fixtures/tax2025-pdf-view.fixture";

const SSN = "987-65-4321";
const P1 = "topmostSubform[0].Page1[0].";

function allText(blocks: CoverBlock[]): string {
  return blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text)).join("\n");
}

describe("safeText", () => {
  it("refuses SSN-like text (dashes, spaces, dots, plain digits, unicode dashes) and returns the placeholder", () => {
    for (const raw of [`SSN ${SSN}`, "987 65 4321", "987.65.4321", "987654321", "987‑65‑4321", "９８７-65-4321"]) {
      const r = safeText(raw);
      expect(r.refused, raw).toBe(true);
      expect(r.text).toBe(SSN_PLACEHOLDER);
    }
  });

  it("passes ordinary text, money and ids through (sanitised for WinAnsi)", () => {
    expect(safeText("Total $123,456,789 on line 2b")).toEqual({ text: "Total $123,456,789 on line 2b", refused: false });
    expect(safeText("fp 123456789abc").refused).toBe(false);
    expect(safeText("“José”").text).toBe('"José"');
  });
});

describe("D1: SSN-like text never reaches any part of a PDF", () => {
  const rawContents = async (bytes: Uint8Array): Promise<string> => {
    const doc = await PDFDocument.load(bytes);
    let all = "";
    for (const page of doc.getPages()) {
      const c = page.node.Contents();
      const streams: unknown[] = [];
      if (c instanceof PDFArray) for (let i = 0; i < c.size(); i++) streams.push(c.lookup(i));
      else streams.push(c);
      for (const s of streams) if (s instanceof PDFRawStream) all += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
    }
    return all;
  };
  const hex = (s: string): string => Buffer.from(s, "latin1").toString("hex").toUpperCase();

  it("cover: engine open item, override entry, decision, citation and acknowledged id are replaced; one blocking notice, no digits", () => {
    const view = makeView({
      openItems: [{ id: "a", severity: "blocking", formLabel: "Form 1040", lineKeys: [], message: `Spouse SSN ${SSN} typed`, action: "fix" }],
      overrides: [{ key: "f1040.10", formLabel: "Form 1040", formLine: "10", note: `CPA override: reason ${SSN}`, stale: false }],
      decisions: [{ id: "X1", label: "Home office", chosen: "simplified", status: "default_undecided", effectNote: `note ${SSN}` }],
      citations: [`cite ${SSN}`],
      acknowledged: [`rule ${SSN}`],
    });
    const model = buildCoverModel({ view, forms: [], fillItems: [], continuations: [], stamp: true });
    const text = allText(model.blocks);
    expect(text).not.toContain("987");
    expect(text).not.toMatch(/\d{3}-\d{2}-\d{4}/);
    expect(model.redactedCount).toBe(5);
    expect(text).toContain(SSN_PLACEHOLDER);
    const notices = model.blocks.filter((b) => b.kind === "bullet" && b.text.startsWith("[BLOCKING] 5 text value(s)"));
    expect(notices).toHaveLength(1);
  });

  it("cover: fill items and continuation-list cells are guarded; a clean cover has no notice", () => {
    const rows = [{ payer: `Bank ${SSN}`, amount: 10 }];
    const model = buildCoverModel({
      view: makeView(),
      forms: [],
      fillItems: [{ id: "f", severity: "blocking", source: "fill", formId: "f1040", message: `value ${SSN}` }],
      continuations: [{ formId: "f1040sb", table: "schb.interest", rows }],
      stamp: true,
    });
    const text = allText(model.blocks);
    expect(text).not.toContain("987");
    expect(model.redactedCount).toBe(2);
    expect(buildCoverModel({ view: makeView(), forms: [], fillItems: [], continuations: [], stamp: true }).redactedCount).toBe(0);
  });

  it("renderCover re-guards a raw model (digits are not drawn into the page content)", async () => {
    const { bytes } = await renderCover({ redactedCount: 0, fingerprint12: "abcdef012345", blocks: [{ kind: "bullet", text: `leak ${SSN}` }] });
    const content = await rawContents(bytes);
    expect(content).not.toContain(hex(SSN));
    expect(content).not.toContain(hex("987"));
  });

  it("packet: the SSN-like cover text is replaced in the zip and reported as a blocking open item without the digits", async () => {
    const view = makeView({
      openItems: [{ id: "a", severity: "blocking", formLabel: "Form 1040", lineKeys: [], message: `SSN ${SSN}`, action: "fix" }],
    });
    const result = await buildPacket(view, { maps: [f1040Map] });
    const item = result.openItems.find((i) => i.id === "cover:ssnlike");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).not.toContain("987");
    const cover = result.files.find((f) => f.formId === null);
    expect(cover).toBeDefined();
    expect(await rawContents(cover!.bytes)).not.toContain(hex("987"));
  });

  it("tooltip: an SSN-like override note becomes the placeholder and raises a blocking item (no digits)", async () => {
    const lines = f1040Lines();
    lines["f1040.10"] = pdfLine({
      key: "f1040.10",
      formLabel: "Form 1040",
      formLine: "10",
      label: "Adjustments",
      status: "overridden",
      amount: 3000,
      override: { note: `CPA override: reason ${SSN}`, computedAmount: 1, stale: false },
    });
    const result = await fillForm("f1040", makeView({ lines }), f1040Map, DEFAULT_FILL_OPTIONS);
    const form = (await PDFDocument.load(result.bytes)).getForm();
    const tu = form.getTextField(`${P1}f1_74[0]`).acroField.dict.lookup(PDFName.of("TU"));
    expect(tu instanceof PDFHexString ? tu.decodeText() : "").toBe(SSN_PLACEHOLDER);
    const item = result.openItems.find((i) => i.id === `fill:f1040:ssnlike:tooltip:${P1}f1_74[0]`);
    expect(item?.severity).toBe("blocking");
    expect(item?.message).not.toContain("987");
    // the amount itself is still written
    expect((await readAllFields(result.bytes)).get(`${P1}f1_74[0]`)).toBe("3,000");
  });

  it("fill items built from engine reasons are guarded at the source (message replaced, extra blocking item)", async () => {
    const lines = f1040Lines();
    lines["f1040.2b"] = pdfLine({ key: "f1040.2b", formLabel: "Form 1040", formLine: "2b", label: "Interest", status: "missing_input", amount: null, reason: `payer ${SSN}` });
    const result = await fillForm("f1040", makeView({ lines }), f1040Map, DEFAULT_FILL_OPTIONS);
    expect(JSON.stringify(result.openItems)).not.toContain("987");
    expect(result.openItems.find((i) => i.id === "blank:f1040:f1040.2b")?.message).toContain(SSN_PLACEHOLDER);
    expect(result.openItems.some((i) => i.id === "fill:f1040:ssnlike:item:blank:f1040:f1040.2b" && i.severity === "blocking")).toBe(true);
  });

  it("table cells: an SSN-like payer is refused (cell blank, blocking item), the other rows are written", async () => {
    const cat = (await import("./tax2025-pdf-harness")).loadCatalog("f1040sb").fields.filter((f) => f.type === "text");
    const rows = [0, 1].map((i) => ({ payer: cat[2 + i * 2]?.name ?? "", amount: cat[3 + i * 2]?.name ?? "" }));
    const map: FormMap = {
      formId: "f1040sb",
      lines: [],
      tables: [{ table: "schb.interest", rows, amountColumn: "amount", labelColumn: "payer", overflow: "summary_row_and_statement" }],
      header: [],
      blank: [],
    };
    const view = makeView({
      tables: { "schb.interest": [{ cells: { payer: `Bank ${SSN}`, amount: 100 } }, { cells: { payer: "Good Bank", amount: 200 } }] },
    });
    const result = await fillForm("f1040sb", view, map, DEFAULT_FILL_OPTIONS);
    const fields = await readAllFields(result.bytes);
    expect(fields.get(rows[0]?.payer ?? "")).toBe("");
    expect(fields.get(rows[0]?.amount ?? "")).toBe("100");
    expect(fields.get(rows[1]?.payer ?? "")).toBe("Good Bank");
    const item = result.openItems.find((i) => i.id.startsWith("fill:f1040sb:ssnlike:"));
    expect(item?.severity).toBe("blocking");
    expect(JSON.stringify(result.openItems)).not.toContain("987");
  });

  it("stamp: SSN-like stamp text is replaced by the placeholder", async () => {
    const doc = await PDFDocument.create({ updateMetadata: false });
    doc.addPage([612, 792]);
    const font = await doc.embedFont("Helvetica");
    stampPages(doc, font, `DRAFT ${SSN}`);
    const content = await rawContents(await doc.save());
    expect(content).not.toContain(hex(SSN));
    expect(content).toContain(hex(SSN_PLACEHOLDER));
  });
});

describe("D2: a present-but-unrecognised answer raises an open item", () => {
  const checkedBoxes = async (bytes: Uint8Array): Promise<string[]> =>
    [...(await readAllFields(bytes)).entries()].filter(([n, v]) => v === true && /c1_8|c1_10/.test(n)).map(([n]) => n);

  it.each(["MFJ", "married", "mfj ", "", "1"])("filingStatus %j leaves every box unchecked and raises 'answer not recognised'", async (bad) => {
    const result = await fillForm("f1040", makeView({ answers: { filingStatus: bad } }), f1040Map, DEFAULT_FILL_OPTIONS);
    expect(await checkedBoxes(result.bytes)).toEqual([]);
    const item = result.openItems.find((i) => i.id === "fill:f1040:answer:filingStatus");
    expect(item?.message).toContain("Answer not recognised");
    expect(item?.message).toContain(`"${bad}"`);
    expect(item?.severity).toBe("advisory");
  });

  it("non-string answers (true, 1) are unrecognised too", async () => {
    for (const bad of [true, false]) {
      const result = await fillForm("f1040", makeView({ answers: { filingStatus: bad } }), f1040Map, DEFAULT_FILL_OPTIONS);
      expect(result.openItems.find((i) => i.id === "fill:f1040:answer:filingStatus")?.message).toContain("Answer not recognised");
    }
  });

  it("digitalAssets: 'maybe' leaves both boxes unchecked with an item; a recognised answer raises none", async () => {
    const bad = await fillForm("f1040", makeView({ answers: { filingStatus: "mfj", digitalAssets: "maybe" } }), f1040Map, DEFAULT_FILL_OPTIONS);
    expect((await checkedBoxes(bad.bytes)).filter((n) => n.includes("c1_10"))).toEqual([]);
    expect(bad.openItems.find((i) => i.id === "fill:f1040:answer:digitalAssets")?.message).toContain('"maybe"');
    const ok = await fillForm("f1040", makeView({ answers: { filingStatus: "mfj", digitalAssets: "no" } }), f1040Map, DEFAULT_FILL_OPTIONS);
    expect(ok.openItems.some((i) => i.id === "fill:f1040:answer:digitalAssets")).toBe(false);
    expect(ok.openItems.some((i) => i.id === "fill:f1040:answer:filingStatus")).toBe(false);
  });

  it("the offending value is truncated to 40 characters and SSN-safe (blocking, placeholder, no digits)", async () => {
    const long = await fillForm("f1040", makeView({ answers: { filingStatus: "x".repeat(100) } }), f1040Map, DEFAULT_FILL_OPTIONS);
    const msg = long.openItems.find((i) => i.id === "fill:f1040:answer:filingStatus")?.message ?? "";
    expect(msg).toContain(`"${"x".repeat(40)}"`);
    expect(msg).not.toContain("x".repeat(41));
    const ssn = await fillForm("f1040", makeView({ answers: { filingStatus: SSN } }), f1040Map, DEFAULT_FILL_OPTIONS);
    const item = ssn.openItems.find((i) => i.id === "fill:f1040:answer:filingStatus");
    expect(item?.severity).toBe("blocking");
    expect(item?.message).toContain(SSN_PLACEHOLDER);
    expect(JSON.stringify(ssn.openItems)).not.toContain("987");
  });
});

describe("O5: negative amounts on the cover read -$100", () => {
  it("prints the sign before the currency symbol everywhere", () => {
    const view = makeView();
    const model = buildCoverModel({
      view: { ...view, headline: { ...view.headline, federal: { ...view.headline.federal, balance: { status: "computed", amount: -100, reason: null } } } },
      forms: [],
      fillItems: [],
      continuations: [{ formId: "f1040sb", table: "schb.interest", rows: [{ payer: "Bank", amount: -250 }] }],
      stamp: true,
    });
    const text = allText(model.blocks);
    expect(text).toContain("Federal balance (positive = owed, negative = refund): -$100");
    expect(text).toContain("amount: -$250");
    expect(text).not.toContain("$-");
  });
});
