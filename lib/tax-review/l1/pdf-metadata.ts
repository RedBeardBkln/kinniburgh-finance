// L1.B6: PDF metadata and field tooltips, and the final package (plan sections 5.3 and 5.7).
//   draft packet : every PDF must say DRAFT in its document properties (the per-page stamp is not readable from the field
//                  data, so the subject is the machine-checkable marker);
//   final package: no document property and no field tooltip may carry draft / override / AI / app / preparer-of-record
//                  wording. The package says only what the owner may file (specs/11).
// Two ways a final package is checked, both against the SAME rules the download route enforces (lib/tax2025/pdf/final-package.ts):
//   - ctx.mode === "final": the context's own packet IS the final package (unit tests and the seeded-defects harness);
//   - ctx.finalPackage (production): the draft packet is checked as a draft, and the final package is built the way the
//     `?final=1` route builds it. If the route would refuse (409) the review says so now (a blocker), so approval cannot be
//     reached for a return whose final package cannot be released; if it builds, its forms must carry neutral properties
//     (Title = the form title, no Subject / Keywords / Author, the same test the route runs), no draft / override / tool
//     tooltip, and exactly the field values of the draft that the other L1 checks read back.
// Page content text (stamp, cover, index) is not read here: those are built from models that have their own banned-token tests.

import { makeFinding, type Finding } from "@/lib/tax-review/types";
import type { L1Check, L1Context, L1PacketFile, ReadPdfFile } from "@/lib/tax-review/l1/context";
import { readPacketFiles } from "@/lib/tax-review/l1/pdf-read";
import { getManifestEntry } from "@/lib/tax2025/pdf/registry";
import { plainText } from "@/lib/tax-review/l1/helpers";

/** Words that must not appear in a FINAL package's document properties (plan 7.5 / 5.7 banned list). */
export const FINAL_BANNED_PROPERTY = /claude|artificial|\bAI\b|banana stand|this app|draft|provisional|computed by|\bCPA\b|review/i;
/** Words that must not appear in a final field tooltip (the printed IRS tooltips themselves legitimately say "review" nowhere, but "override" / "undecided" are ours). */
export const FINAL_BANNED_TOOLTIP = /claude|artificial|\bAI\b|banana stand|this app|draft|provisional|computed by|\bCPA\b|override|undecided/i;

const INFO_KEYS = ["title", "subject", "keywords", "author", "creator", "producer"] as const;

function manifestTitle(formId: string): string | null {
  try {
    return getManifestEntry(formId).title;
  } catch {
    return null;
  }
}

function infoProblems(file: ReadPdfFile): { field: string; text: string }[] {
  const out: { field: string; text: string }[] = [];
  const irsTitle = manifestTitle(file.formId);
  for (const k of INFO_KEYS) {
    const v = file.info[k];
    if (v === undefined || v === "") continue;
    // the IRS's own form title is not our wording
    if (k === "title" && irsTitle !== null && v === irsTitle) continue;
    if (FINAL_BANNED_PROPERTY.test(v)) out.push({ field: k, text: v });
  }
  return out;
}

/** The route's own test of a final form's properties (final-package.ts formPropertyProblems): Title = the form title, nothing else set. */
function routePropertyProblems(file: ReadPdfFile): string[] {
  const out: string[] = [];
  const irsTitle = manifestTitle(file.formId);
  if (irsTitle === null || file.info.title !== irsTitle) out.push("title");
  if (file.info.subject !== undefined) out.push("subject");
  if (file.info.keywords !== undefined) out.push("keywords");
  if (file.info.author !== undefined) out.push("author");
  return out;
}

function draftFindings(file: ReadPdfFile): Finding[] {
  const marker = [file.info.subject, file.info.title, file.info.keywords].some((v) => v !== undefined && /draft/i.test(v));
  if (marker) return [];
  return [
    makeFinding({
      layer: "L1",
      check: "L1.B6.draft-marker",
      severity: "blocker",
      area: "packaging",
      formKey: file.formId,
      ruleTag: file.name,
      message: `${file.name} is part of a draft packet but its document properties do not say DRAFT, so a clean-looking copy could be mistaken for a final one.`,
      evidence: [{ ref: `form:${file.formId}`, amount: null, status: "no draft marker" }],
      recommendedAction: "Do not use this file. Rebuild the draft packet.",
      acceptable: false,
    }),
  ];
}

function finalFindings(file: ReadPdfFile, checkRoutePropertyRule: boolean): Finding[] {
  const out: Finding[] = [];
  for (const p of infoProblems(file)) {
    out.push(
      makeFinding({
        layer: "L1",
        check: "L1.B6.property",
        severity: "blocker",
        area: "packaging",
        formKey: file.formId,
        ruleTag: `${file.name}|${p.field}`,
        message: `${file.name}: the document ${p.field} contains wording that must not be in a final package (draft, review, AI, app or preparer-tool wording).`,
        evidence: [{ ref: `form:${file.formId}`, amount: null, status: `property ${p.field}` }],
        recommendedAction: "Do not release this package. Rebuild the final package from the app.",
        acceptable: false,
      })
    );
  }
  if (checkRoutePropertyRule) {
    const bad = routePropertyProblems(file);
    if (bad.length > 0) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.B6.property-rule",
          severity: "blocker",
          area: "packaging",
          formKey: file.formId,
          ruleTag: file.name,
          message: `${file.name}: the document properties are not neutral (${bad.join(", ")}): a final form's title is the IRS form title and it has no subject, keywords or author. The download route would refuse this package.`,
          evidence: [{ ref: `form:${file.formId}`, amount: null, status: `properties ${bad.join("/")}` }],
          recommendedAction: "Do not release this package. Rebuild the final package from the app.",
          acceptable: false,
        })
      );
    }
  }
  for (const [field, tip] of file.tooltips) {
    if (!FINAL_BANNED_TOOLTIP.test(tip)) continue;
    out.push(
      makeFinding({
        layer: "L1",
        check: "L1.B6.tooltip",
        severity: "blocker",
        area: "packaging",
        formKey: file.formId,
        ruleTag: `${file.name}|${field}`,
        message: `${file.name}: a field tooltip carries draft, override or tool wording (it is saved inside the PDF and anyone who opens the file can read it).`,
        evidence: [{ ref: `pdf:${file.formId}:${field.split(".").slice(-2).join(".")}`, amount: null, status: "tooltip" }],
        recommendedAction: "Do not release this package. Rebuild the final package from the app.",
        acceptable: false,
      })
    );
  }
  return out;
}

/** "forms/03-f1040s1a.pdf" and "03-f1040s1a.pdf" are the same file of the draft and the final package. */
function baseName(name: string): string {
  return name.replace(/^forms\//, "");
}

/** Field name -> value pairs that differ between a draft form and the final form (names only, never a value). */
function fieldDifferences(draft: ReadPdfFile, final: ReadPdfFile): string[] {
  const names = new Set<string>([...draft.fields.keys(), ...final.fields.keys()]);
  const out: string[] = [];
  for (const n of names) {
    const a = draft.fields.get(n);
    const b = final.fields.get(n);
    // an unset text field reads as "" in both
    if ((a ?? "") !== (b ?? "")) out.push(n);
  }
  return out;
}

async function finalPackageFindings(ctx: L1Context, draftFiles: readonly ReadPdfFile[]): Promise<Finding[]> {
  const probe = ctx.finalPackage;
  if (probe === null || probe === undefined) return [];
  if (!probe.ok) {
    return [
      makeFinding({
        layer: "L1",
        check: "L1.B6.final-package",
        severity: "blocker",
        area: "packaging",
        ruleTag: "refused",
        message: `The final package cannot be built for this return, so it could not be released after approval: ${plainText(probe.reason, 400)}`,
        evidence: [{ ref: "check:final-package", amount: null, status: "refused" }],
        recommendedAction: "Resolve what the message names (a line that could not be filled, wording that must not appear, a form that could not be built), then run the checks again.",
        acceptable: false,
      }),
    ];
  }
  const finalForms: L1PacketFile[] = probe.files.filter((f) => f.formId !== null);
  const read = await readPacketFiles(finalForms);
  const out: Finding[] = [];
  const draftByName = new Map(draftFiles.map((f) => [baseName(f.name), f]));
  for (const file of read) {
    out.push(...finalFindings(file, true));
    const draft = draftByName.get(baseName(file.name));
    if (draft === undefined) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.B6.final-extra-form",
          severity: "blocker",
          area: "packaging",
          formKey: file.formId,
          ruleTag: file.name,
          message: `${file.name} is in the final package but not in the draft packet that the other checks read back, so what would be filed is not what was checked.`,
          evidence: [{ ref: `form:${file.formId}`, amount: null, status: "only in the final package" }],
          recommendedAction: "Do not release this package. Rebuild it from the app and run the checks again.",
          acceptable: false,
        })
      );
      continue;
    }
    const diff = fieldDifferences(draft, file);
    if (diff.length > 0) {
      out.push(
        makeFinding({
          layer: "L1",
          check: "L1.B6.final-differs",
          severity: "blocker",
          area: "packaging",
          formKey: file.formId,
          ruleTag: file.name,
          message: `${file.name}: ${diff.length} printed field(s) in the final package differ from the draft packet that the other checks read back, so the figures that would be filed were not the ones that were checked.`,
          evidence: [{ ref: `form:${file.formId}`, amount: diff.length, status: "fields differ" }],
          recommendedAction: "Do not release this package. Rebuild it from the app and run the checks again.",
          acceptable: false,
        })
      );
    }
  }
  const finalNames = new Set(read.map((f) => baseName(f.name)));
  for (const d of draftFiles) {
    if (finalNames.has(baseName(d.name))) continue;
    out.push(
      makeFinding({
        layer: "L1",
        check: "L1.B6.final-missing-form",
        severity: "blocker",
        area: "packaging",
        formKey: d.formId,
        ruleTag: d.name,
        message: `${d.name} is in the draft packet but not in the final package, so a form that was checked would not be filed.`,
        evidence: [{ ref: `form:${d.formId}`, amount: null, status: "missing from the final package" }],
        recommendedAction: "Do not release this package. Rebuild it from the app and run the checks again.",
        acceptable: false,
      })
    );
  }
  return out;
}

export const pdfMetadataCheck: L1Check = {
  id: "L1.B6",
  description: "Draft packets say DRAFT in their properties; final packages carry no draft / override / AI / app wording and the same figures as the draft",
  async run(ctx: L1Context): Promise<Finding[]> {
    const files = ctx.read ?? (await readPacketFiles(ctx.packet.files));
    const out: Finding[] = [];
    for (const file of files) out.push(...(ctx.mode === "draft" ? draftFindings(file) : finalFindings(file, false)));
    out.push(...(await finalPackageFindings(ctx, files)));
    return out;
  },
};
