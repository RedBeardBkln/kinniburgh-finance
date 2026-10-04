// ai-return-reviewer A5: the FINAL package (lib/tax2025/pdf/final-package.ts) built from the real engine on the golden
// fixtures: layout, no page stamp, neutral document properties and tooltips, the self-prepared index, attachment statements,
// the paid-preparer block left blank, the banned-wording guard, and fail-closed refusals.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 90000 });
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { PDFArray, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFString, decodePDFRawStream } from "pdf-lib";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { applyOverrides, formatOverrideNote, lineSnapshot, type OverrideRow } from "@/lib/tax2025/overrides";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import {
  FINAL_INDEX_FILE_NAME,
  SELF_PREPARED_LINE,
  buildAttachments,
  buildFinalPackage,
  buildIndexLines,
  formPropertyProblems,
  scanChrome,
} from "@/lib/tax2025/pdf/final-package";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { getManifestEntry } from "@/lib/tax2025/pdf/registry";
import { findFinalPackageBannedWording } from "@/lib/tax-wording";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { PdfReturnView } from "@/lib/tax2025/pdf/types";
import { emptyFacts, fullFacts, interest } from "./tax2025-fixtures";
import { readAllFields } from "./tax2025-pdf-harness";

const OPTS = { generatedAt: "2026-10-08T16:00:00.000Z", generatedBy: "Test User" } as const;

function viewOf(facts: Ty2025Facts = fullFacts(), extra: Partial<Parameters<typeof toPdfReturnView>[2]> = {}): PdfReturnView {
  return toPdfReturnView(computeTy2025Return(facts), facts, { ...OPTS, ...extra });
}

const hex = (s: string): string => Buffer.from(s, "latin1").toString("hex").toUpperCase();

/** All page content text of a PDF (decoded streams, latin1). */
async function contentText(bytes: Uint8Array): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  let all = "";
  for (const page of doc.getPages()) {
    const contents = page.node.Contents();
    const streams: unknown[] = [];
    if (contents instanceof PDFArray) for (let i = 0; i < contents.size(); i++) streams.push(contents.lookup(i));
    else streams.push(contents);
    for (const s of streams) if (s instanceof PDFRawStream) all += Buffer.from(decodePDFRawStream(s).decode()).toString("latin1");
  }
  return all;
}

const textOfIndex = (view: PdfReturnView, approvedAt: string | null = null): string =>
  buildIndexLines({ view, formFiles: [{ name: "forms/01-f1040.pdf", title: "Form 1040" }], attachments: [], notIncluded: [], hasForm8949Summary: false, approvedAt })
    .map((l) => (l.block.kind === "kv" ? `${l.block.label}: ${l.block.value}` : l.block.kind === "spacer" ? "" : l.block.text))
    .join("\n");

describe("buildFinalPackage on the golden return", () => {
  it("is a zip with the index first, forms/ in IRS order, no cover and no draft file names", async () => {
    const result = await buildFinalPackage(viewOf(), { maps: FORM_MAPS });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const names = result.files.map((f) => f.name);
    expect(names[0]).toBe(FINAL_INDEX_FILE_NAME);
    expect(names).not.toContain("00-cover.pdf");
    expect(names.filter((n) => n !== FINAL_INDEX_FILE_NAME).every((n) => n.startsWith("forms/") || n.startsWith("attachments/"))).toBe(true);
    expect(names.slice(1, 4)).toEqual(["forms/01-f1040.pdf", "forms/02-f1040s1.pdf", "forms/03-f1040s1a.pdf"]); // Schedule 1-A follows Schedule 1 (PACKET_ORDER)
    expect(names).toContain("forms/ct/ct1040.pdf");
    expect(names).toContain("attachments/01-ct1040-withholding.pdf"); // the CT withholding list is a real statement now
    expect(result.forms).toContain("f1040");
    const unzipped = unzipSync(result.zip);
    expect(Object.keys(unzipped).sort()).toEqual([...names].sort());
    for (const f of result.files) {
      expect(new TextDecoder().decode(f.bytes.slice(0, 5))).toBe("%PDF-");
      await PDFDocument.load(f.bytes);
    }
  });

  it("no page carries a DRAFT stamp and no document property is a draft marker; Title is the form title", async () => {
    const result = await buildFinalPackage(viewOf(), { maps: FORM_MAPS });
    if (!result.ok) throw new Error(result.reason);
    for (const f of result.files.filter((x) => x.kind === "form")) {
      expect(await contentText(f.bytes), f.name).not.toContain(hex("DRAFT"));
      expect(await formPropertyProblems(f.name, f.formId as string, f.bytes), f.name).toEqual([]);
      const doc = await PDFDocument.load(f.bytes);
      expect(doc.getTitle()).toBe(getManifestEntry(f.formId as string).title);
    }
  });

  it("same field values as the draft form: only the stamp, the tooltips and the properties differ", async () => {
    const view = viewOf();
    const draft = await fillForm("f1040", view, f1040Map, { stamp: true, fingerprint: "abcdef012345", stampDate: "2026-10-08" });
    const final = await fillForm("f1040", view, f1040Map, { stamp: false, fingerprint: "abcdef012345", stampDate: "2026-10-08", final: true });
    expect([...(await readAllFields(final.bytes)).entries()]).toEqual([...(await readAllFields(draft.bytes)).entries()]);
    expect(await contentText(draft.bytes)).toContain(hex("DRAFT - not approved for filing"));
    expect(await contentText(final.bytes)).not.toContain(hex("DRAFT"));
  });

  it("an override note reaches the draft tooltip but never the final form", async () => {
    const f = fullFacts();
    const ret = computeTy2025Return(f);
    const l = ret.lines["sch1.3"];
    if (!l) throw new Error("no sch1.3");
    const row: OverrideRow = {
      id: "00000000-0000-4000-8000-0000000000cc",
      taxYear: 2025,
      targetKind: "line",
      targetKey: "sch1.3",
      version: 1,
      valueKind: "money_cents",
      valueCents: 6_000_000,
      valueText: null,
      computedSnapshot: lineSnapshot(l, ret.engineVersion),
      authority: "owner",
      reason: "corrected figure",
      setByName: "Eric Kinniburgh",
      setAt: new Date("2026-10-05T14:00:00Z"),
      archivedAt: null,
    };
    const view = toPdfReturnView(ret, f, { ...OPTS, overrides: { effective: applyOverrides(ret, [row]), formatNote: formatOverrideNote } });
    const tips = async (bytes: Uint8Array): Promise<string[]> => {
      const doc = await PDFDocument.load(bytes);
      const out: string[] = [];
      for (const field of doc.getForm().getFields()) {
        const tu = field.acroField.dict.lookup(PDFName.of("TU"));
        if (tu instanceof PDFString || tu instanceof PDFHexString) out.push(tu.decodeText());
      }
      return out;
    };
    const s1 = FORM_MAPS.find((m) => m.formId === "f1040s1");
    if (!s1) throw new Error("no schedule 1 map");
    const opts = { stamp: false, fingerprint: "abcdef012345", stampDate: "2026-10-08" };
    const draft = await fillForm("f1040s1", view, s1, opts);
    const final = await fillForm("f1040s1", view, s1, { ...opts, final: true });
    expect((await tips(draft.bytes)).some((t) => /Owner override: was/.test(t))).toBe(true);
    expect((await tips(final.bytes)).some((t) => /override/i.test(t))).toBe(false);
  });

  it("the paid-preparer / designee block of Form 1040 stays blank in the final package", async () => {
    const result = await buildFinalPackage(viewOf(), { maps: FORM_MAPS });
    if (!result.ok) throw new Error(result.reason);
    const f1040 = result.files.find((f) => f.name === "forms/01-f1040.pdf");
    if (!f1040) throw new Error("no 1040");
    const fields = await readAllFields(f1040.bytes);
    const preparerFields = f1040Map.blank.filter((b) => b.reason === "preparer").flatMap((b) => ("field" in b ? [b.field] : [...fields.keys()].filter((n) => b.match.test(n))));
    expect(preparerFields.length).toBeGreaterThan(8);
    for (const name of preparerFields) expect(fields.get(name), name).toBe(typeof fields.get(name) === "boolean" ? false : "");
  });
});

describe("the package index", () => {
  const view = viewOf();

  it("says who prepared it, and nothing about how it was computed or checked", () => {
    const text = textOfIndex(view, "2026-10-08T22:30:00.000Z");
    expect(text).toContain("Tax year 2025 - Form 1040 and CT-1040 - married filing jointly");
    expect(text).toContain(SELF_PREPARED_LINE);
    expect(SELF_PREPARED_LINE).toBe("Prepared by Eric Kinniburgh (self-prepared)");
    expect(text).toContain("Approved by owner on 2026-10-08 18:30 EDT");
    expect(text).toContain(`Return fingerprint: ${view.fingerprint.slice(0, 12)}`);
    expect(text).toContain("Enter by hand before filing");
    expect(text).toContain("The paid preparer, firm and PTIN boxes stay blank");
    expect(findFinalPackageBannedWording(text)).toEqual([]);
    for (const banned of [/claude/i, /\bAI\b/, /this app/i, /draft/i, /\bCPA\b/, /review/i, /override/i, /provisional/i]) expect(text).not.toMatch(banned);
  });

  it("lists the forms the return needs that this app has no PDF for, by IRS title, with the instruction to prepare them", () => {
    const lines = buildIndexLines({
      view,
      formFiles: [],
      attachments: [],
      notIncluded: [{ title: "Form 8960 (Net Investment Income Tax)", formId: "f8960" }],
      hasForm8949Summary: true,
    }).map((l) => (l.block.kind === "spacer" ? "" : l.block.kind === "kv" ? `${l.block.label}: ${l.block.value}` : l.block.text));
    const text = lines.join("\n");
    expect(text).toContain("Not included in this package (1)");
    expect(text).toContain("Prepare each one yourself");
    expect(text).toContain("\nForm 8960 (Net Investment Income Tax)");
    expect(text).not.toContain("(f8960)");
    expect(text).toContain("Your broker's Form 1099-B detail pages");
  });

  it("scanChrome reports banned wording in text we write and ignores the owner's data", () => {
    expect(scanChrome([{ block: { kind: "para", text: "DRAFT - not approved" }, data: false }]).length).toBeGreaterThan(0);
    expect(scanChrome([{ block: { kind: "para", text: "Computed by Claude" }, data: false }]).length).toBeGreaterThan(0);
    expect(scanChrome([{ block: { kind: "bullet", text: "AI Capital Partners - $100" }, data: true }])).toEqual([]);
    expect(scanChrome([{ block: { kind: "para", text: "ok" }, data: false }], ["Tax year 2025 - review"]).length).toBe(1);
  });
});

describe("attachments", () => {
  it("every Schedule B interest payer gets a row on a real statement (16 payers, 14 fit on the form)", async () => {
    const f = fullFacts();
    f.income.interest = Array.from({ length: 16 }, (_, i) => interest({ docId: `int-${i + 1}`, payer: `Bank ${String(i + 1).padStart(2, "0")}`, box1Cents: 50_000 + i * 1_000 }));
    const view = viewOf(f);
    const result = await buildFinalPackage(view, { maps: FORM_MAPS });
    if (!result.ok) throw new Error(result.reason);
    const att = result.files.filter((x) => x.kind === "attachment").map((x) => x.name);
    expect(att).toContain("attachments/01-schedule-b-interest.pdf");
    expect(att).toContain("attachments/02-ct1040-withholding.pdf");
    // the statement model lists all 16 rows (the overflow row on the form says "Other (see statement)")
    const filled = await import("@/lib/tax2025/pdf/packet").then((m) => m.fillPacketForms(view, { maps: FORM_MAPS, stamp: false, final: true, folder: "forms/" }));
    const statements = buildAttachments(view, filled.continuations);
    const interestStatement = statements.find((s) => s.name.endsWith("schedule-b-interest.pdf"));
    const bullets = (interestStatement?.lines ?? []).filter((l) => l.block.kind === "bullet");
    expect(bullets).toHaveLength(16);
    expect(bullets.map((b) => ("text" in b.block ? b.block.text : "")).join("\n")).toContain("Bank 16");
    // attachment chrome is clean; the payer rows are data
    expect(scanChrome(interestStatement?.lines ?? [], [`Statement - ${interestStatement?.title ?? ""}`])).toEqual([]);
  });

  it("Form 8949 summary rows become a statement with the box totals", () => {
    const view = viewOf();
    const withSales: PdfReturnView = {
      ...view,
      tables: {
        ...view.tables,
        "f8949.partI": [{ cells: { box: "A", a: "Example Broker - see attached statement", b: null, c: null, d: 12_000, e: 10_000, f: "M", g: null, h: 2_000 } }],
        "f8949.totalsI": [{ cells: { box: "A", d: 12_000, e: 10_000, g: null, h: 2_000 } }],
        "f8949.partII": [{ cells: { box: "D", a: "Example Broker - see attached statement", b: null, c: null, d: 3_000, e: 4_000, f: "MW", g: 100, h: -900 } }],
        "f8949.totalsII": [{ cells: { box: "D", d: 3_000, e: 4_000, g: 100, h: -900 } }],
      },
    };
    const statements = buildAttachments(withSales, []);
    expect(statements.map((s) => s.name)).toEqual(["attachments/01-form-8949-summary.pdf"]);
    const text = (statements[0]?.lines ?? []).map((l) => (l.block.kind === "kv" ? `${l.block.label}: ${l.block.value}` : l.block.kind === "spacer" ? "" : l.block.text)).join("\n");
    expect(text).toContain("Box A");
    expect(text).toContain("Proceeds: $12,000");
    expect(text).toContain("Gain or (loss): -$900");
    expect(text).toContain("Box D totals: Proceeds: $3,000");
    expect(scanChrome(statements[0]?.lines ?? [])).toEqual([]);
  });
});

describe("fail closed", () => {
  it("refuses to build while a form could not be filled (blank lines the engine could not compute)", async () => {
    const result = await buildFinalPackage(viewOf(emptyFacts()), { maps: FORM_MAPS });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/could not be filled/);
  });
});
