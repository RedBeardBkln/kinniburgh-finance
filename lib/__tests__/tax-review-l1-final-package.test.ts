import { vi } from "vitest";
vi.setConfig({ testTimeout: 180000, hookTimeout: 180000 });
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, PDFTextField } from "pdf-lib";
import type { FinalPackageProbe, L1Context, L1PacketFile } from "@/lib/tax-review/l1/context";
import { pdfMetadataCheck } from "@/lib/tax-review/l1/pdf-metadata";
import { runL1 } from "@/lib/tax-review/l1/run-l1";
import { buildPipeline, cleanScenario, richScenario } from "./tax-review-harness";

// L1.B6 against the final package the download route would build (ai-return-reviewer integration): the review says NOW whether the
// route would refuse, and that the forms that would be filed carry the figures that were read back.

let clean: L1Context;
let rich: L1Context;

beforeAll(async () => {
  clean = (await buildPipeline(cleanScenario(), { includeFinalPackage: true })).ctx;
  rich = (await buildPipeline(richScenario(), { includeFinalPackage: true })).ctx;
});

const run = (ctx: L1Context) => pdfMetadataCheck.run(ctx);

function probeFiles(ctx: L1Context): L1PacketFile[] {
  const p = ctx.finalPackage;
  if (p === null || p === undefined || !p.ok) throw new Error("no final package in this context");
  return p.files.map((f) => ({ ...f }));
}

async function edited(ctx: L1Context, formId: string, edit: (doc: PDFDocument) => void): Promise<L1Context> {
  const files = probeFiles(ctx);
  const i = files.findIndex((f) => f.formId === formId);
  const current = files[i];
  if (i === -1 || current === undefined) throw new Error(`no final file for ${formId}`);
  const doc = await PDFDocument.load(current.bytes, { updateMetadata: false });
  edit(doc);
  files[i] = { ...current, bytes: await doc.save({ updateFieldAppearances: false }) };
  return { ...ctx, finalPackage: { ok: true, files } satisfies FinalPackageProbe };
}

describe("L1.B6 final package", () => {
  it("the production assembler builds the final package for the clean and the rich return, and nothing is raised", async () => {
    for (const ctx of [clean, rich]) {
      expect(ctx.finalPackage?.ok).toBe(true);
      expect(await run(ctx)).toEqual([]);
    }
    const files = probeFiles(rich);
    expect(files.some((f) => f.name === "00-package-index.pdf")).toBe(true);
    expect(files.some((f) => f.formId === "f8960")).toBe(true);
    expect(files.some((f) => f.formId === "f1040s1a") || rich.view.formsRequired?.sch1a?.required !== true).toBe(true);
  });

  it("is skipped (not failed) when the context has no final package (a unit-test context)", async () => {
    const { finalPackage: _unused, ...rest } = clean;
    void _unused;
    expect(await run(rest as L1Context)).toEqual([]);
  });

  it("a package the route would refuse (409) is a blocker that says why, and cannot be accepted", async () => {
    const ctx = { ...clean, finalPackage: { ok: false, reason: "2 line(s) or field(s) could not be filled; the final package is not built until they are resolved." } satisfies FinalPackageProbe };
    const f = await run(ctx);
    expect(f.map((x) => x.check)).toEqual(["L1.B6.final-package"]);
    expect(f[0]?.severity).toBe("blocker");
    expect(f[0]?.acceptable).toBe(false);
    expect(f[0]?.message).toMatch(/could not be filled/);
    expect(f[0]?.message).not.toMatch(/\bCPA\b/);
  });

  it("a final form with a Subject (or no IRS title) breaks the route's own property rule", async () => {
    const withSubject = await edited(clean, "f1040", (doc) => doc.setSubject("Computed for a reviewer"));
    const f = await run(withSubject);
    expect(f.some((x) => x.check === "L1.B6.property-rule" && x.severity === "blocker")).toBe(true);
    expect(f.some((x) => x.check === "L1.B6.property")).toBe(true); // and the wording scan agrees ("review")
    const noTitle = await edited(clean, "f1040", (doc) => doc.setTitle("Draft"));
    expect((await run(noTitle)).some((x) => x.check === "L1.B6.property-rule")).toBe(true);
  });

  it("a final form whose printed figure differs from the checked draft is a blocker (names the form, never a value)", async () => {
    const files = probeFiles(clean);
    const target = files.find((f) => f.formId === "f1040");
    if (!target) throw new Error("no 1040");
    const doc = await PDFDocument.load(target.bytes, { updateMetadata: false });
    const text = doc.getForm().getFields().find((fld) => fld instanceof PDFTextField && (fld.getText() ?? "").length > 0 && /^[\d,]+$/.test(fld.getText() ?? ""));
    if (!(text instanceof PDFTextField)) throw new Error("no numeric field");
    const ctx = await edited(clean, "f1040", (d) => {
      const fld = d.getForm().getTextField(text.getName());
      fld.setText("999999");
    });
    const f = await run(ctx);
    const hit = f.find((x) => x.check === "L1.B6.final-differs");
    expect(hit?.severity).toBe("blocker");
    expect(hit?.acceptable).toBe(false);
    expect(hit?.message).not.toMatch(/999999/);
  });

  it("a form that is in the draft but missing from the final package, and one only in the final, are blockers", async () => {
    const files = probeFiles(clean).filter((f) => f.formId !== "f1040sc");
    const missing = await run({ ...clean, finalPackage: { ok: true, files } });
    expect(missing.some((x) => x.check === "L1.B6.final-missing-form")).toBe(true);
    const draftWithoutSc = { ...clean, packet: { ...clean.packet, files: clean.packet.files.filter((f) => f.formId !== "f1040sc") } };
    const extra = await run(draftWithoutSc as L1Context);
    expect(extra.some((x) => x.check === "L1.B6.final-extra-form")).toBe(true);
  });

  it("the whole L1 run on the production assembler stays clean of blockers on the clean return", async () => {
    const result = await runL1(clean);
    expect(result.status).toBe("completed");
    expect(result.findings.filter((x) => x.severity === "blocker" || x.severity === "high" || x.severity === "medium")).toEqual([]);
  });
});
