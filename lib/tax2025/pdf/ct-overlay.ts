// The Connecticut CT-1040 is a FLAT PDF (0 form fields; plan section 6.11). To let the
// CPA still edit values, this module adds our OWN AcroForm fields over rectangles that
// scripts/forms/calibrate-ct1040.ts measured from the form's drawn input boxes
// (data/forms/2025/geometry/ct1040.json, committed):
//
//   amount  right-aligned Helvetica 9, navy, over the white box left of a printed ".00"
//   text    left-aligned (names, employer ID, Schedule 3 description)
//   check   one checkbox (Married filing jointly)
//
// Field names are ours: ct1040.l<line> (ct1040.l18aA / l18aB for withholding columns A / B,
// ct1040.l60d for a Schedule 3 description cell). Only NAMES are filled for identity; SSN,
// signature, bank and PIN areas get no field at all, so nothing can be written there.
//
// Whether a field lines up with the printed box on screen/paper cannot be verified by the
// tests (guard tests check the geometry only: inside the page, no overlap, right edge before
// the ".00"); it is a live visual check.

import { PDFDocument, TextAlignment, rgb } from "pdf-lib";
import { z } from "zod";
import geometryJson from "@/data/forms/2025/geometry/ct1040.json";

export const CT1040_FORM_ID = "ct1040";

/** Cover-page note for the CT-1040 (cover.ts prints it next to the form). */
export const CT1040_FLAT_NOTE = "CT-1040 is a flat form: fields were added by this app";

/** Extra context printed on the cover after the note. */
export const CT1040_COVER_NOTE =
  `${CT1040_FLAT_NOTE}. The text boxes are aligned to the printed boxes by measurement; check the alignment on screen or on paper before relying on a printout. ` +
  "Treat this PDF as a review aid: the CPA files Connecticut electronically (whether a preparer must e-file CT is not verified here).";

const rectSchema = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });

const fieldSchema = z.object({
  name: z.string().regex(/^ct1040\.[A-Za-z0-9]+$/),
  page: z.number().int().min(0),
  kind: z.enum(["amount", "text", "check"]),
  line: z.string().min(1),
  rect: rectSchema,
  anchor: z.object({ x: z.number(), y: z.number() }).nullable(),
  basis: z.enum(["drawn", "derived"]),
});

const geometrySchema = z.object({
  schemaVersion: z.literal(1),
  formId: z.literal(CT1040_FORM_ID),
  taxYear: z.literal(2025),
  source: z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), bytes: z.number().int().positive(), pdfjsDist: z.string() }),
  pages: z.array(z.object({ width: z.number().positive(), height: z.number().positive() })).min(1),
  fields: z.array(fieldSchema).min(1),
});

export type CtOverlayField = z.infer<typeof fieldSchema>;
export type CtGeometry = z.infer<typeof geometrySchema>;

let cached: CtGeometry | null = null;

/** The calibrated geometry (parsed and validated once per process). */
export function ct1040Geometry(): CtGeometry {
  if (cached) return cached;
  const parsed = geometrySchema.parse(geometryJson);
  const seen = new Set<string>();
  for (const f of parsed.fields) {
    if (seen.has(f.name)) throw new Error(`ct1040 geometry: duplicate field ${f.name}`);
    seen.add(f.name);
    if (f.page >= parsed.pages.length) throw new Error(`ct1040 geometry: ${f.name} is on page ${f.page}, the form has ${parsed.pages.length}`);
  }
  cached = parsed;
  return parsed;
}

/** Names of every overlay field (what a CT-1040 map must claim exactly once). */
export function ctOverlayFieldNames(): string[] {
  return ct1040Geometry().fields.map((f) => f.name);
}

const NAVY = rgb(0, 0, 0.502); // the IRS forms' own entry colour

const MAX_LENGTH: Readonly<Record<CtOverlayField["kind"], number>> = {
  amount: 15,
  text: 40,
  check: 0,
};

/** Flat forms the app adds fields to, keyed by manifest form id. */
export const FLAT_FORM_COVER_NOTES: Readonly<Record<string, string>> = {
  [CT1040_FORM_ID]: CT1040_COVER_NOTE,
};

/**
 * Add the overlay fields for `formId` to a loaded blank form. Returns how many fields
 * were added (0 for any form that is not a registered flat form). Idempotence is not
 * needed: it runs once on a freshly loaded blank.
 */
export function applyFlatFormOverlay(formId: string, doc: PDFDocument): number {
  if (formId !== CT1040_FORM_ID) return 0;
  const geometry = ct1040Geometry();
  if (doc.getPageCount() !== geometry.pages.length) {
    throw new Error(`ct1040 overlay: the PDF has ${doc.getPageCount()} pages, the geometry was calibrated for ${geometry.pages.length}`);
  }
  const form = doc.getForm();
  for (const f of geometry.fields) {
    const page = doc.getPage(f.page);
    const box = { x: f.rect.x, y: f.rect.y, width: f.rect.width, height: f.rect.height };
    if (f.kind === "check") {
      const check = form.createCheckBox(f.name);
      check.addToPage(page, { ...box, borderWidth: 0, textColor: NAVY });
      continue;
    }
    const text = form.createTextField(f.name);
    text.setMaxLength(MAX_LENGTH[f.kind]);
    text.setAlignment(f.kind === "amount" ? TextAlignment.Right : TextAlignment.Left);
    text.addToPage(page, { ...box, borderWidth: 0, textColor: NAVY });
    // The default appearance (/DA) exists only after the widget is added.
    text.setFontSize(/^ct1040\.l\d+d$/.test(f.name) ? 8 : 9); // Schedule 3 description cells are narrower
  }
  return geometry.fields.length;
}
