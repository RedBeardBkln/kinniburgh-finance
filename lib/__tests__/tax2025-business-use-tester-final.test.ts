// TESTER: the shared-use cover section stays OUT of the final package (index, forms, attachments), the draft cover has no banned
// owner wording (no "CPA"), and a decided / undecided state both build.
import { vi } from "vitest";
vi.setConfig({ testTimeout: 120000 });
import { describe, expect, it } from "vitest";
import { unzipSync } from "fflate";
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { applyOverrides, decisionsFromOverrides, formatOverrideNote, type OverrideRow } from "@/lib/tax2025/overrides";
import { computeTy2025Return } from "@/lib/tax2025/return";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { buildCoverModel, type CoverForm } from "@/lib/tax2025/pdf/cover";
import { buildFinalPackage } from "@/lib/tax2025/pdf/final-package";
import { FORM_MAPS } from "@/lib/tax2025/pdf/maps";
import { findOwnerBannedWording } from "@/lib/tax-wording";
import { fullFacts1b, gl } from "./tax2025-fixtures";

const OPTS = { generatedAt: "2026-10-06T16:00:00.000Z", generatedBy: "Test User" } as const;
const row = (valueText: string): OverrideRow => ({
  id: "r1", taxYear: 2025, targetKind: "decision", targetKey: "businessUse.internet_phone", version: 1, valueKind: "choice", valueCents: null, valueText,
  computedSnapshot: { status: "default_undecided", cents: null, engineVersion: "ty2025-1b.9" }, authority: "owner", reason: "Bill split and a usage log were kept.", setByName: "Eric", setAt: new Date("2026-10-06T16:00:00.000Z"), archivedAt: null,
});
function viewOf(rows: OverrideRow[]) {
  const f = fullFacts1b();
  f.income.scheduleC.glLines = [...f.income.scheduleC.glLines, gl("6100", "Utilities:Internet & Phone", "expense", 261_017)];
  const ret = computeTy2025Return(f, decisionsFromOverrides(rows));
  return toPdfReturnView(ret, f, { ...OPTS, overrides: { effective: applyOverrides(ret, rows), formatNote: formatOverrideNote } });
}
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
const forms: CoverForm[] = [{ formId: "f1040", title: "Form 1040", included: true, reason: "always", blankByDesign: {} }];

describe("TESTER: final package vs draft cover separation", () => {
  for (const [name, rows] of [["undecided", []], ["70%", [row("70")]], ["0%", [row("0")]]] as const) {
    it(`${name}: the draft cover section has no 'CPA' wording; the final package files carry no business-use / decision / personal-portion text`, async () => {
      const view = viewOf([...rows]);
      const cover = buildCoverModel({ view, forms, fillItems: [], continuations: [], stamp: true }).blocks.map((b) => (b.kind === "kv" ? `${b.label}: ${b.value}` : b.kind === "spacer" ? "" : b.text)).join("\n");
      const at = cover.indexOf("Shared-use accounts");
      expect(at).toBeGreaterThan(-1);
      const section = cover.slice(at, cover.indexOf("Left blank by design", at));
      expect(findOwnerBannedWording(section)).toEqual([]);
      const result = await buildFinalPackage(view, { maps: FORM_MAPS });
      if (!result.ok) throw new Error(`final package refused: ${result.reason}`);
      const zip = unzipSync(result.zip);
      let scanned = 0;
      for (const [fileName, bytes] of Object.entries(zip)) {
        if (!fileName.endsWith(".pdf")) continue;
        const text = await contentText(bytes);
        scanned++;
        for (const needle of ["Shared-use", "business-use", "Business-use", "X6", "personal portion", "Personal portion", "undecided", "not verified by documents", "Internet &"]) {
          expect(text.includes(needle), `${fileName} contains "${needle}"`).toBe(false);
        }
      }
      expect(scanned).toBeGreaterThan(3);
      // the Schedule C line 25 value that IS in the package is the whole-dollar amount
      expect(view.lines["schc.25"]?.amount).toBe(name === "undecided" ? 2610 : name === "70%" ? 1827 : 0);
    });
  }
});
