// Fill one blank official form from the effective return view (plan section 6.8).
//
//  - The blank bytes come from the registry (sha256-verified); nothing is ignored
//    silently (an encrypted or malformed file throws).
//  - /XFA, /Perms and /Extensions are deleted deliberately (otherwise Acrobat ignores
//    the filled values and/or warns that the signed usage rights were broken).
//  - The AcroForm is kept and NEVER flattened: the CPA can edit every field.
//  - Appearance streams are generated for the fields we write (Helvetica, the form's
//    own /DA size and colour); NeedAppearances is not set; save() does not
//    regenerate (updateFieldAppearances: false).
//  - SSN, bank, routing, DOB, signature, PIN fields are only ever claimed by a map's
//    `blank` list and are never written; text that looks like an SSN is refused.

import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFString,
  PDFTextField,
  StandardFonts,
  type PDFField,
} from "pdf-lib";
import { collectClaims } from "@/lib/tax2025/pdf/completeness";
import { applyFlatFormOverlay } from "@/lib/tax2025/pdf/ct-overlay";
import { fitCell, type FitKind } from "@/lib/tax2025/pdf/fit-text";
import { formatDollars, splitName } from "@/lib/tax2025/pdf/format";
import { resolveFieldValue } from "@/lib/tax2025/pdf/policy";
import { getBlankBytes, getManifestEntry } from "@/lib/tax2025/pdf/registry";
import { DRAFT_SUBJECT, draftStampText, stampPages } from "@/lib/tax2025/pdf/stamp";
import { ownerWording } from "@/lib/tax-wording";
import type {
  BlankReason,
  ContinuationList,
  FillOptions,
  FillResult,
  FormMap,
  HeaderSource,
  MapTable,
  PacketOpenItem,
  PdfReturnView,
} from "@/lib/tax2025/pdf/types";
import { safeText } from "@/lib/tax2025/pdf/safe-text";

export const OVERFLOW_LABEL = "Other (see statement)";
const MAX_TOOLTIP = 600;

function tooltipText(base: string, original: string | null): string {
  const combined = original ? `${base} | ${original}` : base;
  return combined.length > MAX_TOOLTIP ? `${combined.slice(0, MAX_TOOLTIP - 3)}...` : combined;
}

/** Set the field tooltip (/TU). The note goes through safeText; returns true when it was refused as SSN-like. */
function setTooltip(field: PDFField, note: string): boolean {
  const dict = field.acroField.dict;
  const existing = dict.lookup(PDFName.of("TU"));
  const original =
    existing instanceof PDFString || existing instanceof PDFHexString ? safeText(existing.decodeText()).text : null;
  // The note can quote engine prose: reword it like every other owner-visible string.
  const safe = safeText(ownerWording(note));
  dict.set(PDFName.of("TU"), PDFHexString.fromText(tooltipText(safe.text, original)));
  return safe.refused;
}

/** Final form: Title = the form title; Subject, Keywords and Author (IRS-internal codes) are removed. */
function setFinalDocumentProperties(doc: PDFDocument, title: string): void {
  const info = doc.context.lookupMaybe(doc.context.trailerInfo.Info, PDFDict);
  if (info !== undefined) for (const key of ["Subject", "Keywords", "Author"]) info.delete(PDFName.of(key));
  doc.setTitle(title);
}

function headerValue(source: HeaderSource, view: PdfReturnView): { text: string | null; split: boolean } {
  const h = view.header;
  switch (source) {
    case "household.names":
      return { text: h.householdNames, split: false };
    case "household.taxpayer":
      return { text: h.taxpayerName, split: false };
    case "household.spouse":
      return { text: h.spouseName, split: false };
    case "household.taxpayerFirst":
      return { text: h.taxpayerName ? splitName(h.taxpayerName).first : null, split: true };
    case "household.taxpayerLast":
      return { text: h.taxpayerName ? splitName(h.taxpayerName).last : null, split: true };
    case "household.spouseFirst":
      return { text: h.spouseName ? splitName(h.spouseName).first : null, split: true };
    case "household.spouseLast":
      return { text: h.spouseName ? splitName(h.spouseName).last : null, split: true };
    case "entity.ekcName":
      return { text: h.ekcName, split: false };
    case "year":
      return { text: String(view.taxYear), split: false };
  }
}

function sumDollars(values: ReadonlyArray<string | number | null | undefined>): { total: number; bad: number } {
  let total = 0;
  let bad = 0;
  for (const v of values) {
    if (typeof v === "number" && Number.isSafeInteger(v)) total += v;
    else if (v !== null && v !== undefined && v !== "") bad += 1;
  }
  return { total, bad };
}

/** Fill `formId` from the view using `map`. Returns the PDF bytes plus every open item raised. */
export async function fillForm(
  formId: string,
  view: PdfReturnView,
  map: FormMap,
  opts: FillOptions,
): Promise<FillResult> {
  if (map.formId !== formId) throw new Error(`fillForm: map is for ${map.formId}, not ${formId}`);

  const doc = await PDFDocument.load(getBlankBytes(formId), { updateMetadata: false });
  // A flat form (CT-1040) has no fields: add our own over the calibrated boxes before the map is checked.
  applyFlatFormOverlay(formId, doc);

  // Strip the signed usage-rights and XFA packet deliberately, then assert they are gone.
  doc.catalog.delete(PDFName.of("Perms"));
  doc.catalog.delete(PDFName.of("Extensions"));
  const acro = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (acro) acro.delete(PDFName.of("XFA"));
  const form = doc.getForm();
  if (form.acroForm.dict.has(PDFName.of("XFA"))) throw new Error(`fillForm ${formId}: XFA could not be removed`);

  const fieldNames = form.getFields().map((f) => f.getName());
  const known = new Set(fieldNames);

  // Run-time soundness: a map naming a field the form does not have, or claiming a field twice, is a defect.
  const seen = new Set<string>();
  for (const claim of collectClaims(map, fieldNames)) {
    if (!known.has(claim.field)) throw new Error(`fillForm ${formId}: map references unknown field "${claim.field}"`);
    if (seen.has(claim.field)) throw new Error(`fillForm ${formId}: field "${claim.field}" is claimed more than once`);
    seen.add(claim.field);
  }

  const font = await doc.embedFont(StandardFonts.Helvetica);
  const items = new Map<string, PacketOpenItem>();
  const addItem = (item: PacketOpenItem): void => {
    // Item messages can carry engine text (reasons, labels): never let SSN-like digits through.
    const safe = safeText(item.message);
    if (safe.refused) {
      const id = `fill:${formId}:ssnlike:item:${item.id}`;
      if (!items.has(id)) {
        items.set(id, {
          id,
          severity: "blocking",
          source: "fill",
          formId,
          message: `An open-item message (${item.id}) looked like a Social Security Number and was withheld.`,
        });
      }
      item = { ...item, message: safe.text };
    }
    if (!items.has(item.id)) items.set(item.id, item);
  };
  const filled: string[] = [];
  // Values each choice's sibling boxes expect, to tell "unanswered" from "answered with something unrecognised".
  const expectedByChoice = new Map<string, Set<string | boolean>>();
  for (const l of map.lines) {
    if (l.kind !== "check") continue;
    const set = expectedByChoice.get(l.choice) ?? new Set<string | boolean>();
    set.add(l.equals);
    expectedByChoice.set(l.choice, set);
  }
  const recognised = (choice: string, answer: string | boolean): boolean => {
    const expected = expectedByChoice.get(choice);
    if (expected === undefined) return false;
    // A yes/no attestation mapped as `equals: true` also accepts `false` (answered "no": unchecked, nothing to flag).
    if (typeof answer === "boolean" && [...expected].some((e) => typeof e === "boolean")) return true;
    return expected.has(answer);
  };
  const continuations: ContinuationList[] = [];

  const textField = (name: string): PDFTextField => {
    const f = form.getFieldMaybe(name);
    if (!(f instanceof PDFTextField)) throw new Error(`fillForm ${formId}: field "${name}" is not a text field`);
    return f;
  };

  /** Write sanitized text into a text field, guarding SSN-like text and over-wide values. Returns true if written. */
  const writeText = (name: string, raw: string, note?: string, fit?: FitKind): boolean => {
    const safe = safeText(raw);
    let text = safe.text.trim();
    if (text === "") return false;
    if (safe.refused) {
      addItem({
        id: `fill:${formId}:ssnlike:${name}`,
        severity: "blocking",
        source: "fill",
        formId,
        field: name,
        message: `A value for field ${name} looked like a Social Security Number and was refused; the field is left blank.`,
      });
      return false;
    }
    const f = textField(name);
    if (fit !== undefined) {
      // Fit the text into the cell (fit-text.ts): a smaller font first, then a recognisable shortening. Anything the cell
      // cannot show goes to the cover as an advisory item with the FULL text.
      const widget = f.acroField.getWidgets()[0];
      if (widget !== undefined) {
        const result = fitCell(font, fit, text, widget.getRectangle().width);
        f.setFontSize(result.fontSize);
        if (result.changed) {
          addItem({
            id: `fill:${formId}:fit:${name}`,
            severity: "advisory",
            source: "fill",
            formId,
            field: name,
            message: `The text for field ${name} did not fit its cell and was ${result.truncated ? "cut" : "shortened"} to "${result.text}"; the full text is: "${text}".`,
          });
          text = result.text;
        }
      }
    }
    const max = f.getMaxLength();
    if (max !== undefined && text.length > max) {
      addItem({
        id: `fill:${formId}:toowide:${name}`,
        severity: "blocking",
        source: "fill",
        formId,
        field: name,
        message: `A value for field ${name} is ${text.length} characters but the field holds ${max}; left blank - key it manually.`,
      });
      return false;
    }
    f.setText(text);
    if (note && setTooltip(f, note)) {
      addItem({
        id: `fill:${formId}:ssnlike:tooltip:${name}`,
        severity: "blocking",
        source: "fill",
        formId,
        field: name,
        message: `A tooltip note for field ${name} looked like a Social Security Number and was replaced by a placeholder.`,
      });
    }
    filled.push(name);
    return true;
  };

  for (const entry of map.lines) {
    if (entry.kind === "money") {
      const decision = resolveFieldValue(formId, view.lines[entry.line], entry, view.answers);
      for (const item of decision.items) addItem(item);
      // A FINAL form carries no override / draft note in its tooltips: the IRS's own tooltip text stays as it is.
      if (decision.write !== null) writeText(entry.field, decision.write, opts.final === true ? undefined : decision.tooltip);
      else textField(entry.field); // type-check the target even when blank
    } else if (entry.kind === "check") {
      const box = form.getFieldMaybe(entry.field);
      if (!(box instanceof PDFCheckBox)) throw new Error(`fillForm ${formId}: field "${entry.field}" is not a checkbox`);
      const answer = view.answers[entry.choice];
      if (answer !== undefined && answer !== null && !recognised(entry.choice, answer)) {
        // Present but not one of the values any sibling box expects: never guess, say so.
        const shown = safeText(String(answer).slice(0, 40));
        addItem({
          id: `fill:${formId}:answer:${entry.choice}`,
          severity: shown.refused ? "blocking" : "advisory",
          source: "fill",
          formId,
          field: entry.field,
          message: `Answer not recognised: ${entry.label ?? entry.choice} = "${shown.text}"; the boxes are left unchecked.`,
        });
      } else if (answer === undefined || answer === null) {
        if (entry.required) {
          addItem({
            id: `fill:${formId}:answer:${entry.choice}`,
            severity: "advisory",
            source: "fill",
            formId,
            field: entry.field,
            message: `Answer needed: ${entry.label ?? entry.choice}; the box is left unchecked.`,
          });
        }
      } else if (answer === entry.equals) {
        box.check();
        filled.push(entry.field);
      }
    } else {
      const answer = view.answers[entry.answer];
      if (typeof answer === "string") writeText(entry.field, answer);
      else textField(entry.field);
    }
  }

  for (const h of map.header) {
    const { text, split } = headerValue(h.source, view);
    if (text === null || text.trim() === "") {
      textField(h.field);
      addItem({
        id: `fill:${formId}:header:${h.source}`,
        severity: "advisory",
        source: "fill",
        formId,
        field: h.field,
        message: `Header value "${h.source}" is not available; the field is left blank.`,
      });
      continue;
    }
    if (writeText(h.field, text) && split) {
      addItem({
        id: `fill:${formId}:namesplit`,
        severity: "advisory",
        source: "fill",
        formId,
        field: h.field,
        message: "A single full name was split into first and last name fields (last word = last name); verify the split.",
      });
    }
  }

  for (const t of map.tables) fillTable(formId, t, view, writeText, addItem, continuations, textField);

  const blankByDesign: Partial<Record<BlankReason, number>> = {};
  const blankNotes: string[] = [];
  for (const b of map.blank) {
    let matched = 0;
    for (const n of fieldNames) {
      if ("field" in b) {
        if (n === b.field) matched += 1;
      } else {
        b.match.lastIndex = 0;
        if (b.match.test(n)) matched += 1;
      }
    }
    blankByDesign[b.reason] = (blankByDesign[b.reason] ?? 0) + matched;
    if (b.note !== undefined && matched > 0 && !blankNotes.includes(b.note)) blankNotes.push(b.note);
  }

  form.updateFieldAppearances(font);
  if (opts.final === true) {
    setFinalDocumentProperties(doc, getManifestEntry(formId).title);
  } else {
    // A clean (?stamp=0) single form has no page marking: keep the DRAFT status in the document properties.
    doc.setSubject(DRAFT_SUBJECT);
  }

  if (opts.alternativeLabel) {
    stampPages(doc, font, opts.alternativeLabel);
  } else if (opts.stamp && opts.final !== true) {
    stampPages(doc, font, draftStampText(opts.stampDate, opts.fingerprint));
  }

  const bytes = await doc.save({ updateFieldAppearances: false });
  return {
    formId,
    bytes,
    openItems: [...items.values()],
    filledFields: filled,
    blankByDesign,
    blankNotes,
    continuations,
  };
}

function fillTable(
  formId: string,
  table: MapTable,
  view: PdfReturnView,
  writeText: (name: string, raw: string, note?: string, fit?: FitKind) => boolean,
  addItem: (item: PacketOpenItem) => void,
  continuations: ContinuationList[],
  textField: (name: string) => PDFTextField,
): void {
  const data = view.tables[table.table] ?? [];
  const capacity = table.rows.length;
  const writeRow = (rowIndex: number, cells: Readonly<Record<string, string | number | null>>): void => {
    const columns = table.rows[rowIndex];
    if (!columns) return;
    for (const [col, field] of Object.entries(columns)) {
      const v = cells[col];
      if (v === undefined || v === null || v === "") {
        textField(field);
        continue;
      }
      if (typeof v === "number") {
        if (!Number.isSafeInteger(v)) {
          addItem({
            id: `fill:${formId}:${table.table}:nonint:${rowIndex}`,
            severity: "blocking",
            source: "fill",
            formId,
            field,
            message: `Table ${table.table} row ${rowIndex + 1} holds a non-integer amount; left blank.`,
          });
          continue;
        }
        writeText(field, formatDollars(v));
      } else {
        writeText(field, v, undefined, table.fit?.[col]);
      }
    }
  };

  if (table.coverList && data.length > 0) {
    // The printed form has no column that identifies a row: list every row on the cover, in form order.
    continuations.push({ formId, table: table.table, rows: data.map((r) => ({ ...r.cells })) });
  }

  if (data.length <= capacity) {
    data.forEach((row, i) => writeRow(i, row.cells));
    return;
  }
  if (table.overflow === "none") {
    // Never truncate or summarise silently: the map's `copies` must have split the rows (Form 8949).
    throw new Error(`fillForm ${formId}: table ${table.table} has ${data.length} rows but the form holds ${capacity} and the table does not overflow`);
  }

  // Overflow: rows 1..N-1 as-is; the last row carries "Other (see statement)" and the remainder's sum.
  for (let i = 0; i < capacity - 1; i++) {
    const row = data[i];
    if (row) writeRow(i, row.cells);
  }
  const rest = data.slice(capacity - 1);
  const { total, bad } = sumDollars(rest.map((r) => r.cells[table.amountColumn]));
  writeRow(capacity - 1, { [table.labelColumn]: OVERFLOW_LABEL, [table.amountColumn]: total });
  if (!table.coverList) continuations.push({ formId, table: table.table, rows: data.map((r) => ({ ...r.cells })) });
  addItem({
    id: `fill:${formId}:${table.table}:overflow`,
    severity: "advisory",
    source: "fill",
    formId,
    message: `${data.length} rows exceed the ${capacity} rows on ${formId}; the last row holds the total of the remaining ${rest.length} (see the continuation list on the cover page).`,
  });
  if (bad > 0) {
    addItem({
      id: `fill:${formId}:${table.table}:badamount`,
      severity: "blocking",
      source: "fill",
      formId,
      message: `${bad} row(s) of ${table.table} have a non-integer or missing amount and were not included in the overflow total.`,
    });
  }
}
