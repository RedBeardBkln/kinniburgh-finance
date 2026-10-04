// The FINAL package (ai-return-reviewer, step A5; plan 5.7): what Eric prints, signs and files once he has approved the
// return. It exists only for an owner-approved return (lib/tax2025-pdf-route.ts refuses `?final=1` otherwise) and it
// reads like a return an individual prepared:
//
//   00-package-index.pdf   for Eric's use, not for filing: title, "Prepared by Eric Kinniburgh (self-prepared)", the
//                          forms and attachments, the forms the return needs that this app has no PDF for, and the
//                          "enter by hand" checklist (SSNs, signatures ...). It lists no findings and no open items.
//   forms/                 the filled IRS forms in IRS attachment order (+ forms/ct/ct1040.pdf): no page stamp, no
//                          override / draft note in the field tooltips, neutral document properties.
//   attachments/           real statement PDFs for every continuation list (Schedule B payers, Schedule C other
//                          expenses, the CT withholding list) and the Form 8949 summary rows.
//
// What the package must NEVER say (lib/tax-wording.ts, findFinalPackageBannedWording): Claude, AI, "this app", draft,
// provisional, estimate, computed by, review, override, CPA, or any preparer other than the owner. Every string WE write
// (the "chrome": titles, headings, notes, document properties) is scanned before the zip is returned; a hit makes the
// build fail closed (ok: false). Text that is the owner's DATA (names, payers, amounts) or an IRS form title is not scanned.
//
// Self-prepared: the paid-preparer / firm / PTIN block of Form 1040 stays blank (maps/f1040.ts, reason "preparer"); the
// package never fills it. Pure apart from the blank-form reads in fill.ts: no DB, no network, no clock.

import { zipSync, type Zippable } from "fflate";
import { renderBlocks, type CoverBlock } from "@/lib/tax2025/pdf/cover";
import { formatNewYorkDate, formatNewYorkDateTime, shortFingerprint } from "@/lib/tax2025/pdf/format";
import { requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { fillPacketForms, type PacketFile } from "@/lib/tax2025/pdf/packet";
import { PDFDocument } from "pdf-lib";
import { getManifestEntry } from "@/lib/tax2025/pdf/registry";
import type { ContinuationList, FormMap, PdfReturnView, PdfTableRow, TableKey } from "@/lib/tax2025/pdf/types";
import { findFinalPackageBannedWording } from "@/lib/tax-wording";

export const FINAL_INDEX_FILE_NAME = "00-package-index.pdf";
export const SELF_PREPARED_LINE = "Prepared by Eric Kinniburgh (self-prepared)";

export interface FinalPackageOptions {
  maps: readonly FormMap[];
  /** ISO timestamp of the owner's approval (printed in the index when the approval store supplies it). */
  approvedAt?: string | null;
}

export interface FinalPackageFile extends PacketFile {
  kind: "index" | "form" | "attachment";
}

export type FinalPackageResult =
  | { ok: true; zip: Uint8Array; files: FinalPackageFile[]; forms: string[]; attachmentCount: number }
  | { ok: false; reason: string };

/** A block plus whether it is the owner's/IRS's data (not scanned for banned wording) or our own chrome (scanned). */
interface Line {
  block: CoverBlock;
  data: boolean;
}

const chrome = (block: CoverBlock): Line => ({ block, data: false });
const data = (block: CoverBlock): Line => ({ block, data: true });

function textOf(block: CoverBlock): string {
  switch (block.kind) {
    case "kv":
      return `${block.label}: ${block.value}`;
    case "spacer":
      return "";
    default:
      return block.text;
  }
}

/** Banned wording found in the chrome of `lines` (and in any extra chrome strings), as "what: text" for the failure reason. */
export function scanChrome(lines: readonly Line[], extra: readonly string[] = []): string[] {
  const hits: string[] = [];
  const check = (text: string): void => {
    for (const name of findFinalPackageBannedWording(text)) hits.push(`${name} in "${text.slice(0, 80)}"`);
  };
  for (const l of lines) if (!l.data) check(textOf(l.block));
  for (const t of extra) check(t);
  return hits;
}

// ── Attachments ───────────────────────────────────────────────────────────────

interface TableStatement {
  title: string;
  file: string;
  columns: Readonly<Record<string, string>>;
}

const TABLE_STATEMENTS: Readonly<Partial<Record<TableKey, TableStatement>>> = {
  "schb.interest": { title: "Schedule B, Part I - interest, all payers", file: "schedule-b-interest", columns: { payer: "Payer", amount: "Amount" } },
  "schb.dividends": { title: "Schedule B, Part II - ordinary dividends, all payers", file: "schedule-b-dividends", columns: { payer: "Payer", amount: "Amount" } },
  "ct.withholding": {
    title: "CT-1040, line 18 - Connecticut income tax withheld, all employers",
    file: "ct1040-withholding",
    columns: { ein: "Employer ID", wages: "Connecticut wages", withheld: "Connecticut tax withheld" },
  },
  "schc.otherExpenses": { title: "Schedule C, Part V - other expenses, all items", file: "schedule-c-other-expenses", columns: { label: "Expense", amount: "Amount" } },
  "ct.propertyTax": { title: "CT-1040, Schedule 3 - property tax, all items", file: "ct1040-property-tax", columns: { description: "Description", amount: "Amount" } },
  "f8283.sectionA": { title: "Form 8283, Section A - donated property, all items", file: "form-8283-section-a", columns: {} },
};

const F8949_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["a", "Description"],
  ["d", "Proceeds"],
  ["e", "Cost or other basis"],
  ["f", "Code"],
  ["g", "Adjustment"],
  ["h", "Gain or (loss)"],
];

function dollar(n: number): string {
  const body = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n < 0 ? `-$${body}` : `$${body}`;
}

function cell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  return typeof v === "number" ? dollar(v) : v;
}

interface Attachment {
  name: string;
  title: string;
  lines: Line[];
}

function header(view: PdfReturnView, title: string): Line[] {
  const names = view.header.householdNames;
  return [
    chrome({ kind: "title", text: `Statement - ${title}` }),
    chrome({ kind: "para", text: `Tax year ${view.taxYear} - married filing jointly` }),
    data({ kind: "kv", label: "Name(s) shown on return", value: names ?? "" }),
    chrome({ kind: "kv", label: "Social security number", value: "(enter by hand)" }),
    chrome({ kind: "spacer" }),
  ];
}

function continuationAttachment(view: PdfReturnView, c: ContinuationList, n: number): Attachment | null {
  const spec = TABLE_STATEMENTS[c.table];
  if (spec === undefined || c.rows.length === 0) return null;
  const lines = header(view, spec.title);
  lines.push(chrome({ kind: "para", text: `All ${c.rows.length} entries, in the order they are listed on the form.` }));
  c.rows.forEach((row, i) => {
    const parts = Object.entries(row)
      .filter(([, v]) => v !== null && v !== "")
      .map(([k, v]) => `${spec.columns[k] ?? k}: ${cell(v)}`);
    lines.push(data({ kind: "bullet", text: `${i + 1}. ${parts.join(" | ")}` }));
  });
  return { name: `attachments/${String(n).padStart(2, "0")}-${spec.file}.pdf`, title: spec.title, lines };
}

function f8949Attachment(view: PdfReturnView, n: number): Attachment | null {
  const partI = view.tables["f8949.partI"] ?? [];
  const partII = view.tables["f8949.partII"] ?? [];
  if (partI.length + partII.length === 0) return null;
  const title = "Form 8949 - summary of the transactions reported";
  const lines = header(view, title);
  lines.push(chrome({ kind: "para", text: "One row per broker and box, as entered on Form 8949 (Part I short-term, Part II long-term)." }));
  const totals = [...(view.tables["f8949.totalsI"] ?? []), ...(view.tables["f8949.totalsII"] ?? [])];
  const section = (label: string, rows: readonly PdfTableRow[]): void => {
    if (rows.length === 0) return;
    lines.push(chrome({ kind: "heading", text: label }));
    const boxes = [...new Set(rows.map((r) => String(r.cells.box ?? "")))].sort();
    for (const box of boxes) {
      lines.push(chrome({ kind: "heading", text: `Box ${box}` }));
      for (const r of rows.filter((x) => String(x.cells.box ?? "") === box)) {
        const parts = F8949_COLUMNS.map(([k, name]) => [name, cell(r.cells[k])] as const).filter(([, v]) => v !== "").map(([name, v]) => `${name}: ${v}`);
        lines.push(data({ kind: "bullet", text: parts.join(" | ") }));
      }
      const t = totals.find((x) => String(x.cells.box ?? "") === box);
      if (t !== undefined) {
        const parts = F8949_COLUMNS.filter(([k]) => k !== "a" && k !== "f")
          .map(([k, name]) => [name, cell(t.cells[k])] as const)
          .filter(([, v]) => v !== "")
          .map(([name, v]) => `${name}: ${v}`);
        lines.push(data({ kind: "kv", label: `Box ${box} totals`, value: parts.join(" | ") }));
      }
    }
  };
  section("Part I - short-term", partI);
  section("Part II - long-term", partII);
  return { name: `attachments/${String(n).padStart(2, "0")}-form-8949-summary.pdf`, title, lines };
}

/** Statement attachments for every continuation list and the Form 8949 summary rows. Order: lists as filled, then Form 8949. */
export function buildAttachments(view: PdfReturnView, continuations: readonly ContinuationList[]): Attachment[] {
  const out: Attachment[] = [];
  const seen = new Set<string>();
  for (const c of continuations) {
    // A table can be reported by two copies of a form: one statement per table.
    if (seen.has(c.table)) continue;
    seen.add(c.table);
    const a = continuationAttachment(view, c, out.length + 1);
    if (a !== null) out.push(a);
  }
  const f = f8949Attachment(view, out.length + 1);
  if (f !== null) out.push(f);
  return out;
}

// ── Package index ─────────────────────────────────────────────────────────────

const BY_HAND: readonly string[] = [
  "Social security numbers of both spouses",
  "Employer identification numbers, where a form asks for them",
  "Dates of birth",
  "Bank routing and account numbers (refund or payment)",
  "Identity protection PINs and any other PINs",
  "Signatures and signing dates of both spouses (this is a joint return)",
  "Occupations, phone numbers and addresses",
];

export interface IndexInput {
  view: PdfReturnView;
  formFiles: readonly { name: string; title: string }[];
  attachments: readonly { name: string; title: string }[];
  /** Forms the return needs that this app has no PDF for (IRS titles). */
  notIncluded: readonly { title: string; formId: string }[];
  hasForm8949Summary: boolean;
  approvedAt?: string | null;
}

export function buildIndexLines(input: IndexInput): Line[] {
  const { view } = input;
  const fp12 = shortFingerprint(view.fingerprint);
  const l: Line[] = [];
  l.push(chrome({ kind: "title", text: `Tax year ${view.taxYear} - Form 1040 and CT-1040 - married filing jointly` }));
  l.push(chrome({ kind: "para", text: SELF_PREPARED_LINE }));
  l.push(
    chrome({
      kind: "para",
      text:
        input.approvedAt !== undefined && input.approvedAt !== null
          ? `Approved by owner on ${formatNewYorkDateTime(input.approvedAt)}`
          : "Approved by owner",
    }),
  );
  l.push(chrome({ kind: "kv", label: "Package date", value: formatNewYorkDate(view.generatedAt) }));
  l.push(chrome({ kind: "kv", label: "Return fingerprint", value: fp12 }));
  l.push(chrome({ kind: "para", text: "This page is for your own use; it is not part of the filing." }));

  l.push(chrome({ kind: "heading", text: `Forms in this package (${input.formFiles.length})` }));
  for (const f of input.formFiles) l.push(data({ kind: "bullet", text: `${f.title} - ${f.name}` }));
  if (input.attachments.length > 0) {
    l.push(chrome({ kind: "heading", text: `Attachments (${input.attachments.length})` }));
    for (const a of input.attachments) l.push(data({ kind: "bullet", text: `${a.title} - ${a.name}` }));
  }

  l.push(chrome({ kind: "heading", text: `Not included in this package (${input.notIncluded.length})` }));
  if (input.notIncluded.length === 0) {
    l.push(chrome({ kind: "para", text: "None: every form the return needs is in this package." }));
  } else {
    l.push(chrome({ kind: "para", text: "The return needs the forms below, but there is no PDF for them here. Prepare each one yourself and file it with the return." }));
    for (const m of input.notIncluded) l.push(data({ kind: "bullet", text: `${m.title} (${m.formId})` }));
  }

  l.push(chrome({ kind: "heading", text: "Enter by hand before filing" }));
  l.push(chrome({ kind: "para", text: "These are never stored or filled in. Complete them on the printed forms:" }));
  for (const t of BY_HAND) l.push(chrome({ kind: "bullet", text: t }));
  l.push(chrome({ kind: "para", text: "The paid preparer, firm and PTIN boxes stay blank on a return you prepared yourself." }));

  if (input.hasForm8949Summary) {
    l.push(chrome({ kind: "heading", text: "Also attach" }));
    l.push(
      chrome({
        kind: "bullet",
        text: "Your broker's Form 1099-B detail pages: the Form 8949 rows say \"see attached statement\" (see the Form 8949 instructions).",
      }),
    );
  }
  return l;
}

// ── Build ─────────────────────────────────────────────────────────────────────

/** Document properties of a FINAL form: Title is the manifest title; Subject, Keywords and Author are absent. */
export async function formPropertyProblems(name: string, formId: string, bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const problems: string[] = [];
  if (doc.getTitle() !== getManifestEntry(formId).title) problems.push(`${name}: Title is not the form title`);
  if (doc.getSubject() !== undefined) problems.push(`${name}: has a Subject`);
  if (doc.getKeywords() !== undefined) problems.push(`${name}: has Keywords`);
  if (doc.getAuthor() !== undefined) problems.push(`${name}: has an Author`);
  return problems;
}

/**
 * Build the final package for an APPROVED return. The caller (the route) has already checked the owner's approval for
 * `view.fingerprint`; this function additionally refuses (ok: false) when a form could not be filled, when a fill item is
 * blocking, or when any text we wrote contains banned wording, so a clean package never goes out half-built.
 */
export async function buildFinalPackage(view: PdfReturnView, options: FinalPackageOptions): Promise<FinalPackageResult> {
  const filled = await fillPacketForms(view, { maps: options.maps, stamp: false, final: true, folder: "forms/" });

  // A blocking item raised while filling (a line the engine could not compute, a value that could not be written, a form that
  // could not be built) means a number is missing from a form: never ship a clean package with such a gap.
  const blocking = filled.openItems.filter((i) => i.severity === "blocking");
  if (blocking.length > 0) {
    return { ok: false, reason: `${blocking.length} line(s) or field(s) could not be filled; the final package is not built until they are resolved.` };
  }

  const attachments = buildAttachments(view, filled.continuations);
  const formFiles = filled.files.map((f) => ({ name: f.name, title: filled.forms.find((x) => x.formId === f.formId)?.title ?? (f.formId ?? f.name) }));
  const index = buildIndexLines({
    view,
    formFiles,
    attachments: attachments.map((a) => ({ name: a.name, title: a.title })),
    notIncluded: requiredFormsWithoutPdf(view).map((m) => ({ title: m.title, formId: m.formId })),
    hasForm8949Summary: attachments.some((a) => a.name.endsWith("form-8949-summary.pdf")),
    approvedAt: options.approvedAt ?? null,
  });

  // Scan everything WE wrote: the index, every attachment, the document properties.
  const indexTitle = `Tax year ${view.taxYear} - Form 1040 and CT-1040 - married filing jointly`;
  const hits = [
    ...scanChrome(index, [indexTitle]),
    ...attachments.flatMap((a) => scanChrome(a.lines, [`Statement - ${a.title}`])),
  ];
  if (hits.length > 0) return { ok: false, reason: `The package text contains wording that must not appear in a final package (${hits.join("; ")}).` };

  const footer = (what: string) => (i: number, n: number) => `Tax year ${view.taxYear} - ${what} - page ${i + 1} of ${n}`;
  const indexPdf = await renderBlocks(index.map((x) => x.block), footer("package index"), { title: indexTitle });
  const files: FinalPackageFile[] = [{ name: FINAL_INDEX_FILE_NAME, formId: null, bytes: indexPdf.bytes, kind: "index" }];
  for (const f of filled.files) files.push({ ...f, kind: "form" });
  for (const a of attachments) {
    const pdf = await renderBlocks(a.lines.map((x) => x.block), footer("statement"), { title: `Statement - ${a.title}` });
    files.push({ name: a.name, formId: null, bytes: pdf.bytes, kind: "attachment" });
  }

  // The filled forms: neutral document properties (Title = the form title; no Subject, Keywords or Author).
  const propertyProblems: string[] = [];
  for (const f of filled.files) {
    if (f.formId !== null) propertyProblems.push(...(await formPropertyProblems(f.name, f.formId, f.bytes)));
  }
  if (propertyProblems.length > 0) return { ok: false, reason: `A form's document properties are not neutral (${propertyProblems.join("; ")}).` };

  const mtime = new Date(view.generatedAt);
  const zippable: Zippable = {};
  for (const f of files) zippable[f.name] = [f.bytes, { mtime, level: 0 }];
  return {
    ok: true,
    zip: zipSync(zippable),
    files,
    forms: [...new Set(filled.files.flatMap((f) => (f.formId === null ? [] : [f.formId])))],
    attachmentCount: attachments.length,
  };
}
