// Pure mapping from a MISSING Forms-page field (a PERSONAL_FORM_PLAN line) to the
// concrete ways the owner can supply that data. No DB, no "use server" — the
// result is plain serializable data so server components can hand it to the
// client dialogs.
//
// Each line's data comes from exactly one of: a planning-question answer, an
// uploaded/reviewed document, the books (GL-coded transactions), the mileage
// log, or the Solar loan account. Two kinds of line have no data source in the
// app at all (donations, depreciation) — those say so instead of pretending.
//
// IMPORTANT: keys are the exact `line` text in PERSONAL_FORM_PLAN
// (lib/tax-guidance.ts). A test pins that every plan line is handled here.

import type { FormsDocumentInput, FormsQuestionInput } from "@/lib/tax-forms";

/** Document types a missing field can be fixed by uploading / reviewing. */
export type FixDocType = "w2" | "1099" | "mortgage_interest" | "property_tax";

export interface FixExistingDoc {
  id: string;
  name: string;
  /** The Documents-list extraction label (e.g. "Verified", "Failed"). */
  statusLabel: string;
  /** Review/view screen, only when there is a reading to review. */
  reviewHref: string | null;
  verified: boolean;
}

export type FieldFix =
  /** Answer one planning question right here. */
  | { kind: "question"; questionKey: string }
  /** Upload a document, or open one already uploaded, to supply the data. */
  | {
      kind: "document";
      docType: FixDocType;
      docTypeLabel: string;
      /** Entity the upload files under (the Personal entity). */
      entityId: string;
      taxYear: number;
      /** What exactly is needed from the document. */
      hint: string;
      /** Documents of this type already on file for the year. */
      existing: FixExistingDoc[];
      /** The Documents page filtered to this type/year. */
      documentsHref: string;
    }
  /** Jump to the page where the data is entered. */
  | { kind: "link"; href: string; label: string }
  /** Nothing in the app can supply this yet — said honestly, not clickable. */
  | { kind: "none"; reason: string };

export interface FixContext {
  taxYear: number;
  personalEntityId: string | null;
  ekcSlug: string | null;
  svSlug: string | null;
  questions: readonly FormsQuestionInput[];
  documents: readonly FormsDocumentInput[];
  /** Plan line -> haveData, for lines whose fix depends on another line's state. */
  lineHasData: Readonly<Record<string, boolean>>;
}

const DOC_LABELS: Record<FixDocType, string> = {
  w2: "W-2",
  "1099": "1099",
  mortgage_interest: "Mortgage interest (1098)",
  property_tax: "Property tax bill",
};

function isAnswered(questions: readonly FormsQuestionInput[], key: string): boolean {
  const q = questions.find((x) => x.key === key);
  return !!q && q.answer !== null && !q.skippedReason;
}

function questionFixes(ctx: FixContext, keys: readonly string[]): FieldFix[] {
  return keys.filter((k) => !isAnswered(ctx.questions, k)).map((questionKey) => ({ kind: "question", questionKey }));
}

function documentFix(ctx: FixContext, docType: FixDocType, hint: string, hintWhenNoneOnFile?: string): FieldFix[] {
  if (!ctx.personalEntityId) return [{ kind: "none", reason: "The Personal entity was not found." }];
  const existing: FixExistingDoc[] = ctx.documents
    .filter(
      (d) =>
        d.archivedAt === null &&
        d.entityId === ctx.personalEntityId &&
        d.docType === docType &&
        d.taxYear === ctx.taxYear
    )
    .map((d) => ({
      id: d.id,
      name: d.documentName && d.documentName.trim() !== "" ? d.documentName : DOC_LABELS[docType],
      statusLabel: d.extraction?.label ?? (d.extractionStatus ? `extraction ${d.extractionStatus}` : "not extracted"),
      reviewHref: d.extraction?.actions.includes("review") ? `/documents/${d.id}/review` : null,
      verified: d.verified === true,
    }));
  return [
    {
      kind: "document",
      docType,
      docTypeLabel: DOC_LABELS[docType],
      entityId: ctx.personalEntityId,
      taxYear: ctx.taxYear,
      hint: existing.length === 0 && hintWhenNoneOnFile ? hintWhenNoneOnFile : hint,
      existing,
      documentsHref: `/documents?bucket=taxes&entityId=${encodeURIComponent(ctx.personalEntityId)}&docType=${encodeURIComponent(
        docType
      )}&year=${ctx.taxYear}`,
    },
  ];
}

function booksLink(slug: string | null, entityName: string, label: string): FieldFix[] {
  if (!slug) return [{ kind: "none", reason: `${entityName} was not found.` }];
  return [{ kind: "link", href: `/transactions?bucket=${encodeURIComponent(slug)}`, label }];
}

const NO_DONATION_LOG =
  "The app has no donation log yet, so nothing here can supply this line. Bring donation receipts / bank records to your CPA.";
const NO_DEPRECIATION_DATA =
  "The app holds no fixed-asset or purchase-price data for this, so it cannot be entered here. It is a CPA question.";

const PROPERTY_TAX_NONE_ON_FILE_HINT =
  "Upload the property tax bill, then open its review screen and enter the amount actually PAID in the tax year — the AI never fills that in, because a bill shows what is billed and due, not what was paid.";

const PROPERTY_TAX_HINT =
  "Open the bill's review screen and enter the amount actually PAID in the tax year — the AI never fills it, because a bill shows what is billed and due, not what was paid.";

/**
 * The ways to supply the data for one missing plan line, in the order to show
 * them. Empty only for a line this module does not know (the test guards that).
 */
export function resolveFieldFixes(line: string, ctx: FixContext): FieldFix[] {
  const year = ctx.taxYear;
  switch (line) {
    // Form 1040
    case "Wages (line 1a)":
      return documentFix(ctx, "w2", `Upload the ${year} W-2 (box 1 wages), or open one that is already on file to fix its reading.`);
    case "Interest income (line 2b)":
      return documentFix(ctx, "1099", `Upload the ${year} 1099 (interest box 1), or open one that is already on file to fix its reading.`);
    case "Business income (Schedule 1)":
    case "Gross receipts (line 1)":
      return booksLink(
        ctx.ekcSlug,
        "EK Consulting",
        `Open EK Consulting transactions — assign the deposits to a revenue category for ${year}`
      );
    case "Rental income (Schedule 1)":
    case "Rents received (line 3)":
      return booksLink(
        ctx.svSlug,
        "Sudden Valley",
        `Open Sudden Valley transactions — assign the rental deposits to a revenue category for ${year}`
      );
    case "Adjustments (Schedule 1, Part II)":
      return questionFixes(ctx, ["retirement_contributions"]);
    case "Standard or itemized (line 12)": {
      const fixes: FieldFix[] = [];
      if (ctx.lineHasData["Home mortgage interest (line 8a)"] === false) {
        fixes.push(...documentFix(ctx, "mortgage_interest", `Upload the ${year} Form 1098 (mortgage interest).`));
      }
      if (ctx.lineHasData["State/local taxes (line 5e)"] === false) {
        fixes.push(...documentFix(ctx, "property_tax", PROPERTY_TAX_HINT, PROPERTY_TAX_NONE_ON_FILE_HINT));
      }
      return fixes;
    }
    case "Credits (lines 19-21)":
      return questionFixes(ctx, ["solar_credit", "ev_vehicle", "household_members", "retirement_contributions"]);
    case "Payments/withholding (line 25)":
      return [
        ...documentFix(ctx, "w2", `Upload the ${year} W-2 (box 2 federal withholding).`),
        ...questionFixes(ctx, ["estimated_taxes_2025"]),
      ];

    // Schedule A
    case "Home mortgage interest (line 8a)":
      return documentFix(ctx, "mortgage_interest", `Upload the ${year} Form 1098 (mortgage interest), or open one on file to fix its reading.`);
    case "State/local taxes (line 5e)":
    case "Property tax credit":
      return documentFix(ctx, "property_tax", PROPERTY_TAX_HINT, PROPERTY_TAX_NONE_ON_FILE_HINT);
    case "Gifts to charity (line 11)":
      return [{ kind: "none", reason: NO_DONATION_LOG }];

    // Schedule C
    case "Car and truck expenses (line 9)":
      return ctx.ekcSlug
        ? [
            {
              kind: "link",
              href: `/business/${encodeURIComponent(ctx.ekcSlug)}/mileage`,
              label: `Open the EK Consulting mileage log — log ${year} business trips`,
            },
          ]
        : [{ kind: "none", reason: "EK Consulting was not found." }];
    case "Home office (line 30)":
      return questionFixes(ctx, ["home_office_ekc"]);
    case "Depreciation (line 13)":
    case "Depreciation (line 18)":
      return [{ kind: "none", reason: NO_DEPRECIATION_DATA }];

    // Schedule E
    case "Taxes (line 16)":
      return booksLink(
        ctx.svSlug,
        "Sudden Valley",
        `Open Sudden Valley transactions — assign property-tax payments to the Property Tax category for ${year}`
      );
    case "Insurance (line 15)":
      return booksLink(
        ctx.svSlug,
        "Sudden Valley",
        `Open Sudden Valley transactions — assign insurance payments to the Insurance category for ${year}`
      );

    // Form 5695
    case "Qualified solar electric property cost (line 1)":
    case "Credit (30%)":
      return [
        {
          kind: "link",
          href: "/personal/debt-free",
          label: "Open Debt-free — set the Solar loan's original balance (the system cost)",
        },
      ];

    // CT-1040
    case "CT adjusted gross income": {
      const fixes: FieldFix[] = questionFixes(ctx, ["filing_status"]);
      const hasIncome =
        ctx.lineHasData["Wages (line 1a)"] === true ||
        ctx.lineHasData["Business income (Schedule 1)"] === true ||
        ctx.lineHasData["Rental income (Schedule 1)"] === true;
      if (!hasIncome) {
        fixes.push(...documentFix(ctx, "w2", `Upload the ${year} W-2 so there is income to start from.`));
      }
      return fixes;
    }
    case "CT withholding (W-2 box 17)":
      return documentFix(ctx, "w2", `Upload the ${year} W-2 (box 17 state withholding), or open one on file to fix its reading.`);

    default:
      return [];
  }
}
