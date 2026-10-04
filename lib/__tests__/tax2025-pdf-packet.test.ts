import { vi } from "vitest";
vi.setConfig({ testTimeout: 60000 });
import { unzipSync } from "fflate";
import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { f1040Map } from "@/lib/tax2025/pdf/maps/f1040";
import { COVER_FILE_NAME, buildPacket, orderMaps } from "@/lib/tax2025/pdf/packet";
import { getManifestEntry } from "@/lib/tax2025/pdf/registry";
import type { FormMap } from "@/lib/tax2025/pdf/types";
import { makeOpenItems, makeView, pdfLine } from "./fixtures/tax2025-pdf-view.fixture";
import { readAllFields } from "./tax2025-pdf-harness";

const stubMap = (formId: string): FormMap => ({ formId, lines: [], tables: [], header: [], blank: [] });

describe("packet ordering", () => {
  it("IRS attachment order: leading list, then by sequence number, CT last", () => {
    const ids = ["ct1040", "f8995", "f1040sse", "f1040sc", "f1040", "f1040s3", "f8959", "f1040sa", "f1040s1", "f1040s2", "f4562"];
    expect(orderMaps(ids.map(stubMap)).map((m) => m.formId)).toEqual([
      "f1040",
      "f1040s1",
      "f1040s2",
      "f1040s3",
      "f1040sa",
      "f1040sc",
      "f1040sse",
      "f8995", // Seq 55
      "f8959", // Seq 71
      "f4562", // Seq 179
      "ct1040",
    ]);
    expect(getManifestEntry("f8995").attachmentSeq).toBe(55);
  });
});

describe("buildPacket (trial 1040 map)", () => {
  it("zip opens, cover first, every PDF loads; the 1040 inside has the expected field values", async () => {
    const view = makeView({ openItems: makeOpenItems(60) });
    const result = await buildPacket(view, { maps: [f1040Map] });
    const unzipped = unzipSync(result.zip);
    const names = Object.keys(unzipped);
    expect(names).toEqual([COVER_FILE_NAME, "01-f1040.pdf"]);
    for (const name of names) {
      const doc = await PDFDocument.load(unzipped[name]!);
      expect(doc.getPageCount(), name).toBeGreaterThan(0);
    }
    const cover = await PDFDocument.load(unzipped[COVER_FILE_NAME]!);
    expect(cover.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(result.coverPageCount).toBe(cover.getPageCount());
    const fields = await readAllFields(unzipped["01-f1040.pdf"]!);
    expect(fields.get("topmostSubform[0].Page1[0].f1_47[0]")).toBe("100,000");
    // the packet 1040 is plain AcroForm: no XFA, not flattened
    const f = await PDFDocument.load(unzipped["01-f1040.pdf"]!);
    expect(f.getForm().getFields()).toHaveLength(199);
    expect(f.catalog.has(PDFName.of("Perms"))).toBe(false);
  });

  it("is deterministic for the same view (same bytes)", async () => {
    const view = makeView();
    const a = await buildPacket(view, { maps: [f1040Map] });
    const b = await buildPacket(view, { maps: [f1040Map] });
    expect(Buffer.from(a.zip).equals(Buffer.from(b.zip))).toBe(true);
  });

  it("stamp off still produces the same field values", async () => {
    const view = makeView();
    const on = await buildPacket(view, { maps: [f1040Map], stamp: true });
    const off = await buildPacket(view, { maps: [f1040Map], stamp: false });
    const fa = await readAllFields(on.files[1]!.bytes);
    const fb = await readAllFields(off.files[1]!.bytes);
    expect([...fa.entries()]).toEqual([...fb.entries()]);
    expect(Buffer.from(on.files[1]!.bytes).equals(Buffer.from(off.files[1]!.bytes))).toBe(false);
  });

  it("omits a form whose mapped lines are all zero / not applicable and says why on the cover model", async () => {
    const sch2: FormMap = {
      formId: "f1040s2",
      lines: [{ kind: "money", field: "form1[0].Page1[0].f1_03[0]", line: "sch2.3" }],
      tables: [],
      header: [],
      blank: [],
    };
    const view = makeView({
      lines: { ...makeView().lines, "sch2.3": pdfLine({ key: "sch2.3", formLabel: "Schedule 2", formLine: "3", label: "x", status: "not_applicable", amount: 0 }) },
    });
    const result = await buildPacket(view, { maps: [f1040Map, sch2] });
    expect(result.files.map((f) => f.name)).toEqual([COVER_FILE_NAME, "01-f1040.pdf"]);
    const omitted = result.forms.find((f) => f.formId === "f1040s2");
    expect(omitted?.included).toBe(false);
    expect(omitted?.reason).toMatch(/not applicable, zero or not yet computed/);
  });

  it("collects fill items from every form once", async () => {
    const result = await buildPacket(makeView(), { maps: [f1040Map] });
    const ids = result.openItems.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("fill:f1040:answer:digitalAssets");
  });
});
