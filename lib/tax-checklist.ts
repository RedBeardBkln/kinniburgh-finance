// Entity-aware default tax-prep checklists for business tax workspaces.
// Auto-populated onto a new TaxWorkspace at creation time (see
// actions/tax.ts#ensureTaxWorkspace) so a new workspace never starts with an
// empty, unguided checklist -- the owner shouldn't have to already know what
// documents a filing needs in order to ask the system to track them.
//
// Personal workspaces don't use this -- they have their own fully-computed
// readiness system (lib/tax-form-plan.ts, lib/tax-compute-build.ts) that's
// already tied to real uploaded documents/answers, which this module can't
// improve on. getChecklistTemplateForEntity() returns [] for personal
// entities so callers skip checklist creation entirely for them.
//
// TaxChecklistItem has no linkage field to documents (plain `label` text,
// see prisma/schema.prisma) -- adding one would be a migration. Instead,
// linkedDocTypes here drives a live "N found" badge computed at render time
// by matching the item's *current* label text against this template data
// (components/tax/tax-workspace-client.tsx). It intentionally never
// auto-completes the checklist item itself -- a document existing doesn't
// always mean the item is actually done (e.g. one W-2 uploaded out of two
// expected), so the owner still confirms manually.

export interface ChecklistTemplateItem {
  label: string;
  /** DocType values (see actions/documents.ts DOC_TYPES) this item can be
   *  cross-referenced against for a live document-count badge. Omit for
   *  items with no single corresponding document type. */
  linkedDocTypes?: string[];
}

export const EKC_CHECKLIST: ChecklistTemplateItem[] = [
  { label: "Gather all 1099s and income statements", linkedDocTypes: ["1099"] },
  { label: "Reconcile all business bank accounts (extract, review, and import transactions)", linkedDocTypes: ["bank_statement"] },
  { label: "GL-code all imported business transactions" },
  { label: "Document home office square footage" },
  { label: "Compile mileage log" },
  { label: "Collect receipts for expenses > $75 (IRS Pub. 463 receipt threshold — see specs/10)" },
  { label: "Gather self-employed health insurance premium records" },
  { label: "Gather retirement plan contribution records (SEP-IRA / Solo 401(k))" },
  { label: "Confirm estimated tax payments made this year (federal + CT, all quarters)" },
  { label: "Attach prior-year Schedule C for reference", linkedDocTypes: ["tax_return"] },
  { label: "Prepare Schedule C draft for CPA" },
  { label: "Submit to CPA for review" },
  { label: "File with IRS/CT by the applicable deadline (confirm with CPA)" },
];

export const RENTAL_CHECKLIST: ChecklistTemplateItem[] = [
  { label: "Gather rental income records (bookings, deposits, statements)" },
  { label: "Reconcile all property bank accounts (extract, review, and import transactions)", linkedDocTypes: ["bank_statement"] },
  { label: "Gather mortgage interest statement(s) for the property", linkedDocTypes: ["mortgage_interest"] },
  { label: "Gather property tax bill(s)", linkedDocTypes: ["property_tax"] },
  { label: "Collect receipts for repairs, maintenance, and property management expenses" },
  { label: "Document property depreciation basis (purchase price, improvements, placed-in-service date)" },
  { label: "Confirm estimated tax payments made this year (federal + CT, all quarters)" },
  { label: "Prepare Schedule E draft for CPA" },
  { label: "Submit to CPA for review" },
  { label: "File with IRS/CT by the applicable deadline (confirm with CPA)" },
];

// Fallback for any business entity that isn't EK Consulting or Sudden
// Valley (e.g. Mezzo, or a future entity) -- generic enough to be true of
// most small-business filings without asserting a specific schedule/form.
export const GENERIC_BUSINESS_CHECKLIST: ChecklistTemplateItem[] = [
  { label: "Gather all 1099s and income statements", linkedDocTypes: ["1099"] },
  { label: "Reconcile all business bank accounts (extract, review, and import transactions)", linkedDocTypes: ["bank_statement"] },
  { label: "GL-code all imported business transactions" },
  { label: "Collect receipts for expenses > $75 (IRS Pub. 463 receipt threshold — see specs/10)" },
  { label: "Confirm estimated tax payments made this year (federal + CT, all quarters)" },
  { label: "Prepare draft for CPA" },
  { label: "Submit to CPA for review" },
  { label: "File with IRS/CT by the applicable deadline (confirm with CPA)" },
];

/**
 * Picks a checklist template for a new business tax workspace, by entity
 * slug. Returns [] for personal entities -- see module doc comment.
 */
export function getChecklistTemplateForEntity(entity: {
  type: string;
  slug: string | null;
}): ChecklistTemplateItem[] {
  if (entity.type !== "business") return [];
  if (entity.slug === "ek-consulting") return EKC_CHECKLIST;
  if (entity.slug === "sudden-valley") return RENTAL_CHECKLIST;
  return GENERIC_BUSINESS_CHECKLIST;
}

/** label -> linkedDocTypes, for the live document-count badge. */
export const CHECKLIST_LABEL_TO_DOC_TYPES: Record<string, string[]> = Object.fromEntries(
  [...EKC_CHECKLIST, ...RENTAL_CHECKLIST, ...GENERIC_BUSINESS_CHECKLIST]
    .filter((item): item is ChecklistTemplateItem & { linkedDocTypes: string[] } => !!item.linkedDocTypes)
    .map((item) => [item.label, item.linkedDocTypes])
);
