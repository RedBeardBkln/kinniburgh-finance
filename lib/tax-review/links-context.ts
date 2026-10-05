// Builds the plain-JSON LinkContext that lib/tax-review/links.ts resolves findings against (final-review-deep-links).
// PURE given its inputs (the review sheet model the sheet page renders, the engine return, the registered form maps and the field
// catalogs of the blank forms, which the caller reads from disk): no DB, no fs, no clock. The page numbers come from the same two
// sources the PDF filler uses: the map says which AcroForm field prints a line, the catalog says which page that field is on.
//
// Server only (it imports the engine modules); only the JSON it returns reaches a browser.

import { conflictAnchorId, formGroupAnchorId } from "@/lib/tax-anchors";
import { engineFormOfLine, plainText } from "@/lib/tax-review/l1/helpers";
import { fnv1a, type FormLinkInfo, type LinkContext } from "@/lib/tax-review/links";
import type { SheetModel } from "@/lib/tax2025-sheet";
import type { FormCatalog } from "@/lib/tax2025/pdf/catalog";
import { ct1040Geometry } from "@/lib/tax2025/pdf/ct-overlay";
import type { FormMap } from "@/lib/tax2025/pdf/types";
import type { Ty2025Return } from "@/lib/tax2025/types";

/** The printed name of each form the review can point at (a test pins that every registered map has one). */
export const FORM_LINK_LABELS: Readonly<Record<string, string>> = {
  f1040: "Form 1040",
  f1040s1: "Schedule 1",
  f1040s1a: "Schedule 1-A",
  f1040s2: "Schedule 2",
  f1040s3: "Schedule 3",
  f1040sa: "Schedule A",
  f1040sb: "Schedule B",
  f1040sc: "Schedule C",
  f1040sd: "Schedule D",
  f1040sse: "Schedule SE",
  f8949: "Form 8949",
  f8959: "Form 8959",
  f8960: "Form 8960",
  f8995: "Form 8995",
  ct1040: "CT-1040",
  // forms the engine knows that have no filled PDF here
  f2210: "Form 2210",
  f4562: "Form 4562",
  f5695: "Form 5695",
  f6251: "Form 6251",
  f8283: "Form 8283",
  f8829: "Form 8829",
  f8880: "Form 8880",
  f8889: "Form 8889",
};

/** Card id on the Forms page (lib/tax-forms.ts) of each form, keyed by the canonical form id. A form without a card is absent. */
export const FORM_CARD_IDS: Readonly<Record<string, string>> = {
  f1040: "form-1040",
  f1040s1: "schedule-1",
  f1040s3: "schedule-3-federal",
  f1040sa: "schedule-a",
  f1040sc: "schedule-c",
  f1040sse: "schedule-se",
  f8995: "qbi-deduction",
  f8959: "additional-medicare-tax",
  f2210: "form-2210",
  f4562: "form-4562",
  f5695: "form-5695",
  f8829: "form-8829",
  f8880: "form-8880",
  f8889: "form-8889",
  ct1040: "ct-1040",
};

/** Engine forms that have no PDF map here, with the id the engine uses (canonical id = that id). */
const ENGINE_ONLY_FORMS: readonly string[] = ["f2210", "f4562", "f5695", "f6251", "f8283", "f8829", "f8880", "f8889"];

const shortFieldName = (name: string): string => name.split(".").slice(-2).join(".");

export interface LinkContextInput {
  model: SheetModel;
  /** Optional: only used to list the lines each engine rule produces (the register links). The review sheet page leaves it out. */
  ret?: Pick<Ty2025Return, "results">;
  maps: readonly FormMap[];
  /** Field catalogs of the blank forms keyed by form id (data/forms/2025/catalog). */
  catalogs: Readonly<Record<string, FormCatalog>>;
}

export function buildLinkContext(input: LinkContextInput): LinkContext {
  const { model, maps, catalogs } = input;
  const groups = [...model.federal, ...model.connecticut];

  // sheet lines and the block (group) each engine form's lines sit in
  const sheetLines: Record<string, string> = {};
  const groupOfEngineForm = new Map<string, string>();
  for (const g of groups) {
    for (const l of g.lines) {
      sheetLines[l.key] = `${l.form} line ${l.formLine}`;
      const engine = engineFormOfLine(l.key);
      if (engine !== null && !groupOfEngineForm.has(engine)) groupOfEngineForm.set(engine, formGroupAnchorId(g.form));
    }
  }

  const decisions: Record<string, { label: string; recorded: boolean }> = {};
  for (const d of model.decisions) decisions[d.id] = { label: d.label, recorded: d.override !== null };

  const openItems: Record<string, string> = {};
  for (const i of model.openItems) openItems[i.id] = fnv1a(plainText(i.message));

  const documents: Record<string, string> = {};
  for (const d of model.documents) documents[d.id] = `${d.docTypeLabel}${d.taxYear === null ? "" : ` ${d.taxYear}`}`;

  // forms: every key a finding may carry (the PDF form id and the engine's own id) -> one info object
  const forms: Record<string, FormLinkInfo> = {};
  const addForm = (canonical: string, pdf: string | null, engineId: string | undefined): void => {
    const info: FormLinkInfo = {
      label: FORM_LINK_LABELS[canonical] ?? canonical,
      pdf,
      card: FORM_CARD_IDS[canonical] ?? null,
      group: groupOfEngineForm.get(engineId ?? canonical) ?? null,
    };
    forms[canonical] = info;
    if (engineId !== undefined) forms[engineId] = info;
  };
  for (const m of maps) addForm(m.formId, m.formId, m.engineFormId);
  for (const id of ENGINE_ONLY_FORMS) if (!(id in forms)) addForm(id, null, undefined);

  // lines -> the page the filled form prints them on; fields -> pages beyond the first; signature boxes
  const linePdf: Record<string, string> = {};
  const fieldPages: Record<string, number> = {};
  const signaturePages: Record<string, number> = {};
  for (const m of maps) {
    const catalog = catalogs[m.formId];
    if (catalog === undefined) continue;
    const pageOf = new Map<string, number>();
    // the CT-1040 is a flat printed form: its fields are our own overlay boxes, whose page is in the calibrated geometry
    if (m.formId === "ct1040") for (const f of ct1040Geometry().fields) pageOf.set(f.name, f.page + 1);
    for (const f of catalog.fields) {
      if (f.page === null) continue;
      pageOf.set(f.name, f.page + 1);
      if (f.page >= 1) fieldPages[`${m.formId}|${shortFieldName(f.name)}`] = f.page + 1;
    }
    for (const e of m.lines) {
      if (e.kind !== "money") continue;
      const page = pageOf.get(e.field);
      if (page === undefined) continue;
      const key = String(e.line);
      const mine = engineFormOfLine(key) === m.engineFormId || (m.engineFormId === undefined && engineFormOfLine(key) === "f1040");
      // the first field that prints a line wins; a later FORM replaces it only when that form is the line's own (a line printed twice on one form keeps its first page)
      const prev = linePdf[key];
      if (prev === undefined || (mine && prev.slice(0, prev.lastIndexOf(":")) !== m.formId)) linePdf[key] = `${m.formId}:${page}`;
    }
    for (const b of m.blank) {
      if (b.reason !== "signature_pin") continue;
      const hit = "field" in b ? (pageOf.get(b.field) === undefined ? [] : [pageOf.get(b.field) as number]) : catalog.fields.filter((f) => b.match.test(f.name) && f.page !== null).map((f) => (f.page as number) + 1);
      for (const page of hit) signaturePages[m.formId] = Math.min(signaturePages[m.formId] ?? page, page);
    }
  }

  const ruleLines: Record<string, string[]> = {};
  for (const r of input.ret?.results ?? []) {
    const keys = r.lines.map((l) => String(l.key));
    if (keys.length > 0) ruleLines[r.ruleId] = keys.slice(0, 6);
  }

  return {
    year: 2025,
    sheetLines,
    decisions,
    openItems,
    conflicts: model.conflicts.map((c) => conflictAnchorId(c.factKey)),
    documents,
    forms,
    linePdf,
    fieldPages,
    signaturePages,
    ruleLines,
  };
}
