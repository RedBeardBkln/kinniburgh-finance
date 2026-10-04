// Cover page of the DRAFT packet (plan section 6.9). It is the owner's internal workfile: the final package has no
// cover (final-package.ts writes a neutral package index instead). Two steps so the content is
// testable without a PDF text extractor:
//   buildCoverModel(input) -> a plain list of blocks (pure; every open item appears once)
//   renderCover(model)     -> pdf-lib bytes, auto-paginated with Helvetica wrapping.
// The cover is its own file (00-cover.pdf): forms cannot be merged into one PDF
// without breaking AcroForm field ownership, so the packet is a zip of separate PDFs.

import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import { formatDollars, formatNewYorkDateTime, shortFingerprint } from "@/lib/tax2025/pdf/format";
import {
  BLANK_REASON_LABELS,
  type BlankReason,
  type ContinuationList,
  type PacketOpenItem,
  type PdfOpenItem,
  type PdfReturnView,
} from "@/lib/tax2025/pdf/types";
import { safeText } from "@/lib/tax2025/pdf/safe-text";
import { ownerWording } from "@/lib/tax-wording";
import type { MissingRequiredForm } from "@/lib/tax2025/pdf/no-pdf-forms";

export interface CoverForm {
  formId: string;
  title: string;
  included: boolean;
  /** Why it is included / omitted. */
  reason: string;
  blankByDesign: Partial<Record<BlankReason, number>>;
  /** Boxes / entries the app does not decide (MapBlank.note), listed one per bullet under "Left blank by design". */
  blankNotes?: string[];
  /** Extra note printed with the form (e.g. the CT-1040 flat-form note). */
  note?: string;
}

export interface CoverInput {
  view: PdfReturnView;
  forms: CoverForm[];
  /** Items raised while filling (blank lines, over-wide values, answers needed ...). */
  fillItems: PacketOpenItem[];
  continuations: ContinuationList[];
  /** Per-page stamp on (E1). */
  stamp: boolean;
  /** Forms the engine requires (or cannot rule out) that this packet has no PDF for (no-pdf-forms.ts). */
  missingForms?: MissingRequiredForm[];
}

export type CoverBlock =
  | { kind: "title"; text: string }
  | { kind: "heading"; text: string }
  | { kind: "para"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "kv"; label: string; value: string }
  | { kind: "spacer" };

export interface CoverModel {
  /** Number of cover strings replaced because they looked like an SSN (a blocking notice is in `blocks`). */
  redactedCount: number;
  fingerprint12: string;
  blocks: CoverBlock[];
}

const FRAMING =
  "Computed from the owner's answers, documents and books. This is a draft: the owner is the preparer of record and nothing here has been approved or filed. " +
  "It is not tax or legal advice. Social security numbers, EINs, bank numbers, birth dates, " +
  "signatures and PINs are never stored by this app and are always left blank.";

const BLANK_POLICY =
  "Blank-line policy: a line that could not be computed is left BLANK and listed below - it is never shown as 0. " +
  "A blank MONEY line that is not listed under 'Lines left blank on the forms' (and is not one of the boxes and entries listed " +
  "under 'Boxes and entries the app does not decide') is a computed or not-applicable zero (IRS convention: a blank is zero); " +
  "only totals and lines the form tells you to complete are printed as 0.";

const TOTALS_NOT_RECOMPUTED = "Totals are NOT recomputed for the overrides listed; you figure them out. Lines that depend on an override are flagged.";

/** "$1,234" / "-$1,234" (sign before the currency symbol). */
function money(n: number): string {
  return n < 0 ? `-$${formatDollars(-n)}` : `$${formatDollars(n)}`;
}

function dollars(n: number | null): string {
  return n === null ? "not computed" : money(n);
}

function sortOpen<T extends { severity: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "blocking" ? -1 : 1));
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const i of items) {
    if (seen.has(i.id)) continue;
    seen.add(i.id);
    out.push(i);
  }
  return out;
}

function engineItemText(i: PdfOpenItem): string {
  const where = i.lineKeys.length > 0 ? ` (lines: ${i.lineKeys.join(", ")})` : "";
  return `[${i.severity.toUpperCase()}] ${i.formLabel}: ${i.message}${where} Action: ${i.action}`;
}

function fillItemText(i: PacketOpenItem): string {
  return `[${i.severity.toUpperCase()}] ${i.message}`;
}

export function buildCoverModel(input: CoverInput): CoverModel {
  const { view } = input;
  const fp12 = shortFingerprint(view.fingerprint);
  const b: CoverBlock[] = [];
  b.push({ kind: "title", text: "DRAFT - not a filed return - not yet approved" });
  b.push({ kind: "para", text: `Tax year ${view.taxYear} - married filing jointly - Form 1040 packet` });
  // One-line status (review S5): blocking engine items + notices raised while filling, and forms not generated.
  const missing = input.missingForms ?? [];
  const engineBlocking = dedupeById(view.openItems).filter((i) => i.severity === "blocking").length;
  const fillBlocking = dedupeById(input.fillItems).filter((i) => i.source === "fill" && i.severity === "blocking").length;
  const blockingTotal = engineBlocking + fillBlocking;
  const missingText = `${missing.length} form(s) the engine requires are not generated by this packet (see below)`;
  b.push({
    kind: "heading",
    text:
      blockingTotal > 0
        ? `STATUS: ${blockingTotal} blocking item(s) remain - NOT ready to file${missing.length > 0 ? `; ${missingText}` : ""}.`
        : missing.length > 0
          ? `STATUS: no blocking items, but ${missingText} - NOT ready to file; your own review and approval are still required.`
          : "STATUS: no blocking items; your own review and approval are still required.",
  });
  b.push({ kind: "kv", label: "Generated", value: formatNewYorkDateTime(view.generatedAt) });
  b.push({ kind: "kv", label: "Generated by", value: view.generatedBy });
  b.push({ kind: "kv", label: "Return fingerprint", value: fp12 });
  if (view.engineVersion) b.push({ kind: "kv", label: "Engine version", value: view.engineVersion });
  b.push({
    kind: "kv",
    label: "Page stamp",
    value: input.stamp ? "ON (DRAFT footer on every form page)" : "OFF (clean copy)",
  });
  b.push({ kind: "spacer" });
  const notice = view.overrideNotice;
  if (notice.count > 0) {
    b.push({
      kind: "para",
      text: `OVERRIDES: ${notice.count} owner override(s) are in force and are listed below with who, when and why.${notice.totalsNotRecomputed ? " " + TOTALS_NOT_RECOMPUTED : ""}`,
    });
  }
  b.push({ kind: "para", text: FRAMING });
  b.push({ kind: "para", text: BLANK_POLICY });

  // Headline numbers.
  b.push({ kind: "heading", text: "Headline numbers" });
  const h = view.headline;
  const strictLines = (suffix: string): void => {
    b.push({ kind: "kv", label: `Federal AGI${suffix}`, value: dollars(h.federal.agi.amount) });
    b.push({ kind: "kv", label: `Federal taxable income${suffix}`, value: dollars(h.federal.taxableIncome.amount) });
    b.push({ kind: "kv", label: `Federal total tax${suffix}`, value: dollars(h.federal.totalTax.amount) });
    b.push({ kind: "kv", label: `Federal total payments${suffix}`, value: dollars(h.federal.totalPayments.amount) });
    b.push({ kind: "kv", label: `Federal balance (positive = owed, negative = refund)${suffix}`, value: dollars(h.federal.balance.amount) });
    b.push({ kind: "kv", label: `CT AGI${suffix}`, value: dollars(h.connecticut.ctAgi.amount) });
    b.push({ kind: "kv", label: `CT tax${suffix}`, value: dollars(h.connecticut.tax.amount) });
    b.push({ kind: "kv", label: `CT total payments${suffix}`, value: dollars(h.connecticut.totalPayments.amount) });
    b.push({ kind: "kv", label: `CT balance (positive = owed, negative = refund)${suffix}`, value: dollars(h.connecticut.balance.amount) });
  };
  if (h.complete) {
    strictLines("");
  } else if (notice.totalsNotRecomputed) {
    b.push({ kind: "para", text: `${TOTALS_NOT_RECOMPUTED} The figures below are the ENGINE's own and do NOT reflect the overrides.` });
    strictLines(" (engine, not recomputed for overrides)");
    for (const m of notice.headlineMarks) {
      b.push({
        kind: "bullet",
        text: `${m.label}: ${m.overridden ? `a source line is OVERRIDDEN${m.effectiveAmount !== null ? `; the figure with the override is ${dollars(m.effectiveAmount)}` : ""}` : ""}${m.overridden && m.dependsOnOverride ? "; " : ""}${m.dependsOnOverride ? "depends on an override and was not recomputed" : ""}.`,
      });
    }
    if (h.provisional) b.push({ kind: "para", text: `Estimate for the return as a whole: ${h.provisional.note}` });
    b.push({ kind: "kv", label: "Blocking items", value: String(h.blockingItemCount) });
  } else {
    b.push({
      kind: "para",
      text: "PROVISIONAL - the return is not complete, so these are NOT computed figures. Lines the engine could not resolve were treated as $0 for the estimate below.",
    });
    const p = h.provisional;
    if (p) {
      b.push({ kind: "para", text: p.note });
      b.push({
        kind: "para",
        text: `PROVISIONAL: these lines were treated as $0: ${p.assumedZeroLines.length > 0 ? p.assumedZeroLines.join(", ") : "(none listed)"}`,
      });
      if (p.assumedFacts && p.assumedFacts.length > 0) {
        b.push({ kind: "para", text: "PROVISIONAL: these facts were assumed (missing inputs filled with a neutral value):" });
        for (const a of p.assumedFacts) b.push({ kind: "bullet", text: a });
      }
      b.push({ kind: "kv", label: "Provisional federal AGI", value: dollars(p.agi) });
      b.push({ kind: "kv", label: "Provisional federal taxable income", value: dollars(p.taxableIncome) });
      b.push({ kind: "kv", label: "Provisional federal total tax", value: dollars(p.totalTax) });
      b.push({ kind: "kv", label: "Provisional federal total payments", value: dollars(p.totalPayments) });
      b.push({ kind: "kv", label: "Provisional federal balance (positive = owed)", value: dollars(p.federalBalance) });
      b.push({ kind: "kv", label: "Provisional CT tax", value: dollars(p.ctTax) });
      b.push({ kind: "kv", label: "Provisional CT payments", value: dollars(p.ctPayments) });
      b.push({ kind: "kv", label: "Provisional CT balance (positive = owed)", value: dollars(p.ctBalance) });
    } else {
      b.push({ kind: "para", text: "No provisional estimate was produced; every headline figure is not computed." });
    }
    b.push({ kind: "kv", label: "Blocking items", value: String(h.blockingItemCount) });
  }

  // Forms the engine requires that this packet cannot generate (never silently absent).
  b.push({ kind: "heading", text: `Required forms this packet does NOT contain (${missing.length})` });
  if (missing.length === 0) {
    b.push({ kind: "para", text: "None: every form the engine requires or cannot rule out is in this packet." });
  } else {
    b.push({
      kind: "para",
      text: "The engine says the forms below are required, or cannot rule them out yet, but this app has no PDF for them. Prepare these forms outside this app; amounts that flow from them may already appear on Form 1040 / Schedule 1 with no supporting form here.",
    });
    for (const m of missing) {
      b.push({
        kind: "bullet",
        text: `${m.title} (${m.formId}) - ${m.required === "blocking" ? "the engine cannot rule it out yet" : "the engine says it is required"}: ${m.reason}`,
      });
    }
  }

  // Forms.
  b.push({ kind: "heading", text: "Forms in this packet" });
  const included = input.forms.filter((f) => f.included);
  const omitted = input.forms.filter((f) => !f.included);
  for (const f of included) {
    b.push({ kind: "bullet", text: `${f.title} (${f.formId}) - included: ${f.reason}` });
    if (f.note) b.push({ kind: "bullet", text: `NOTE for ${f.formId}: ${f.note}` });
  }
  if (included.length === 0) b.push({ kind: "para", text: "(no forms included)" });
  if (omitted.length > 0) {
    b.push({ kind: "heading", text: "Forms omitted" });
    for (const f of omitted) b.push({ kind: "bullet", text: `${f.title} (${f.formId}) - omitted: ${f.reason}` });
  }

  // Engine open items (listed once each by id).
  const engineItems = sortOpen(dedupeById(view.openItems));
  const blockingCount = engineItems.filter((i) => i.severity === "blocking").length;
  b.push({
    kind: "heading",
    text: `Open items (${blockingCount} blocking, ${engineItems.length - blockingCount} advisory)`,
  });
  if (engineItems.length === 0) b.push({ kind: "para", text: "None reported by the engine." });
  for (const i of engineItems) b.push({ kind: "bullet", text: engineItemText(i) });
  if (view.acknowledged.length > 0) {
    b.push({ kind: "heading", text: "Acknowledged by the owner (not blocking)" });
    for (const a of view.acknowledged) b.push({ kind: "bullet", text: a.note === "" ? a.ruleId : a.note });
  }
  if (view.resolvedByOverride.length > 0) {
    b.push({ kind: "heading", text: `Resolved by owner override (no longer blocking) (${view.resolvedByOverride.length})` });
    for (const r of view.resolvedByOverride) b.push({ kind: "bullet", text: `${r.message}${r.note === "" ? "" : ` Supplied by: ${r.note}`}` });
  }

  // Items raised while filling.
  const fill = sortOpen(dedupeById(input.fillItems));
  const lineBlanks = fill.filter((i) => i.source === "line_blank");
  const fillIssues = fill.filter((i) => i.source === "fill");
  b.push({ kind: "heading", text: `Lines left blank on the forms (${lineBlanks.length})` });
  if (lineBlanks.length === 0) b.push({ kind: "para", text: "None." });
  for (const i of lineBlanks) b.push({ kind: "bullet", text: fillItemText(i) });
  b.push({ kind: "heading", text: `Fill notes (${fillIssues.length})` });
  if (fillIssues.length === 0) b.push({ kind: "para", text: "None." });
  for (const i of fillIssues) b.push({ kind: "bullet", text: fillItemText(i) });

  // Overrides.
  const live = view.overrides.filter((o) => !o.stale);
  const stale = view.overrides.filter((o) => o.stale);
  b.push({ kind: "heading", text: "Overrides in force" });
  if (live.length === 0) b.push({ kind: "para", text: "None." });
  for (const o of live) b.push({ kind: "bullet", text: `${o.formLabel} line ${o.formLine}: ${o.note}${o.supplied === true ? " [supplied: the engine had no value for this line]" : ""}` });
  if (stale.length > 0) {
    b.push({ kind: "heading", text: "Stale overrides (re-confirm or clear)" });
    for (const o of stale) b.push({ kind: "bullet", text: `${o.formLabel} line ${o.formLine}: ${o.note}` });
  }
  if (notice.dependents.length > 0) {
    b.push({ kind: "heading", text: `Totals NOT recomputed for these overrides (${notice.dependents.length} dependent line(s))` });
    b.push({ kind: "para", text: `${TOTALS_NOT_RECOMPUTED} These lines depend on an override and print the engine's figure; confirm each or override it too.` });
    for (const d of notice.dependents) b.push({ kind: "bullet", text: `${d.formLabel} line ${d.formLine} depends on ${d.dependsOn.join(", ")}` });
  }
  if (notice.engineChanged.length > 0) {
    b.push({ kind: "heading", text: "Engine changed since an override was set (value unchanged)" });
    for (const m of notice.engineChanged) b.push({ kind: "bullet", text: m });
  }

  // Decisions.
  const defaults = view.decisions.filter((d) => d.status === "default_undecided");
  const decided = view.decisions.filter((d) => d.status === "decided");
  b.push({ kind: "heading", text: "Defaults in force (undecided)" });
  if (defaults.length === 0) b.push({ kind: "para", text: "None." });
  for (const d of defaults) {
    b.push({
      kind: "bullet",
      text: `${d.label}: ${d.chosen} (default, undecided)${d.effectNote ? ` - ${d.effectNote}` : ""}`,
    });
  }
  if (decided.length > 0) {
    b.push({ kind: "heading", text: "Decisions recorded" });
    for (const d of decided) {
      b.push({
        kind: "bullet",
        text: `${d.label}: ${d.chosen}${d.decidedBy ? ` - decided by ${d.decidedBy}` : ""}${d.decidedAt ? ` on ${d.decidedAt}` : ""}${d.overrideNote ? ` (${d.overrideNote})` : ""}`,
      });
    }
  }

  // Left blank by design.
  b.push({ kind: "heading", text: "Left blank by design" });
  b.push({
    kind: "para",
    text: "SSN / EIN / bank / PIN / signature / preparer / address fields are never filled by this app.",
  });
  for (const f of included) {
    const parts = (Object.entries(f.blankByDesign) as Array<[BlankReason, number]>)
      .filter(([, n]) => n > 0)
      .map(([reason, n]) => `${BLANK_REASON_LABELS[reason]}: ${n}`);
    if (parts.length > 0) b.push({ kind: "bullet", text: `${f.title}: ${parts.join("; ")}` });
  }
  const noted = included.filter((f) => (f.blankNotes ?? []).length > 0);
  if (noted.length > 0) {
    b.push({ kind: "heading", text: "Boxes and entries the app does not decide (to check)" });
    for (const f of noted) for (const note of f.blankNotes ?? []) b.push({ kind: "bullet", text: `${f.title}: ${note}` });
  }

  // Citations.
  b.push({ kind: "heading", text: "Constants and citations used" });
  b.push({
    kind: "para",
    text: view.citations.length > 0 ? view.citations.join(", ") : "(none recorded)",
  });

  // Continuation lists (the owner's own data: payer names and amounts are never reworded).
  const dataBlocks = new Set<CoverBlock>();
  for (const c of input.continuations) {
    b.push({ kind: "heading", text: `Continuation: ${c.table} (${c.formId}), all ${c.rows.length} rows` });
    c.rows.forEach((row, idx) => {
      const cells = Object.entries(row)
        .map(([k, v]) => `${k}: ${typeof v === "number" ? money(v) : (v ?? "")}`)
        .join(" | ");
      const rowBlock: CoverBlock = { kind: "bullet", text: `${idx + 1}. ${cells}` };
      dataBlocks.add(rowBlock);
      b.push(rowBlock);
    });
  }

  // Every string on the cover passes through safeText (plan 6.4): SSN-like text is replaced by a
  // placeholder and ONE blocking notice (without the digits) is added at the top.
  let refused = 0;
  const guard = (t: string, reword = true): string => {
    // Belt and braces: engine prose that reached the cover without passing the view adapter is reworded here too.
    const s = safeText(reword ? ownerWording(t) : t);
    if (s.refused) refused += 1;
    return s.text;
  };
  const safeBlocks: CoverBlock[] = b.map((blk): CoverBlock => {
    switch (blk.kind) {
      case "kv":
        return { kind: "kv", label: guard(blk.label), value: guard(blk.value) };
      case "spacer":
        return blk;
      default:
        return { kind: blk.kind, text: guard(blk.text, !dataBlocks.has(blk)) };
    }
  });
  if (refused > 0) {
    safeBlocks.splice(1, 0, {
      kind: "bullet",
      text: `[BLOCKING] ${refused} text value(s) on this cover looked like a Social Security Number and were replaced by a placeholder; check the source text (open-item messages, override notes, payer names).`,
    });
  }
  return { fingerprint12: fp12, blocks: safeBlocks, redactedCount: refused };
}

// ── Rendering ─────────────────────────────────────────────────────────────────

const PAGE_W = 612;
const PAGE_H = 792;
const MARGIN = 54;
const BODY = 9.5;
const LEAD = 12.5;

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  for (const para of safeText(text).text.split("\n")) {
    let line = "";
    for (const word of para.split(" ")) {
      let w = word;
      // Hard-break tokens wider than the line.
      while (font.widthOfTextAtSize(w, size) > width) {
        let cut = w.length - 1;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut -= 1;
        if (line) {
          out.push(line);
          line = "";
        }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const candidate = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(candidate, size) <= width) {
        line = candidate;
      } else {
        if (line) out.push(line);
        line = w;
      }
    }
    out.push(line);
  }
  return out;
}

export interface RenderedCover {
  bytes: Uint8Array;
  pageCount: number;
}

export async function renderCover(model: CoverModel): Promise<RenderedCover> {
  return renderBlocks(model.blocks, (idx, total) => `DRAFT - not a filed return - fp ${model.fingerprint12} - cover page ${idx + 1} of ${total}`);
}

export interface RenderBlocksOptions {
  /** PDF Title (document property). Omitted: no Title. */
  title?: string;
}

/**
 * Lay out blocks (title / heading / para / bullet / kv) on auto-paginated Letter pages with a footer on every page.
 * Shared by the DRAFT cover and the final package's index and attachment statements (final-package.ts). Every string
 * goes through safeText; the caller decides what the footer says.
 */
export async function renderBlocks(
  blocks: readonly CoverBlock[],
  footerOf: (pageIndex: number, pageCount: number) => string,
  options: RenderBlocksOptions = {},
): Promise<RenderedCover> {
  // updateMetadata:false keeps the bytes deterministic (no creation/modification timestamps).
  const doc = await PDFDocument.create({ updateMetadata: false });
  if (options.title !== undefined) doc.setTitle(safeText(options.title).text);
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const pages: PDFPage[] = [];
  let page = doc.addPage([PAGE_W, PAGE_H]);
  pages.push(page);
  let y = PAGE_H - MARGIN;
  const textWidth = PAGE_W - 2 * MARGIN;

  const ensure = (needed: number): void => {
    if (y - needed < MARGIN + 14) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      pages.push(page);
      y = PAGE_H - MARGIN;
    }
  };
  const drawLines = (lines: string[], font: PDFFont, size: number, indent: number, lead: number, hanging = 0): void => {
    lines.forEach((ln, idx) => {
      ensure(lead);
      page.drawText(ln, {
        x: MARGIN + indent + (idx > 0 ? hanging : 0),
        y: y - size,
        size,
        font,
        color: rgb(0.1, 0.1, 0.1),
      });
      y -= lead;
    });
  };

  for (const block of blocks) {
    switch (block.kind) {
      case "title":
        drawLines(wrap(block.text, bold, 15, textWidth), bold, 15, 0, 19);
        y -= 4;
        break;
      case "heading":
        y -= 8;
        ensure(LEAD * 3);
        drawLines(wrap(block.text, bold, 11.5, textWidth), bold, 11.5, 0, 15);
        y -= 2;
        break;
      case "para":
        drawLines(wrap(block.text, regular, BODY, textWidth), regular, BODY, 0, LEAD);
        y -= 3;
        break;
      case "bullet":
        drawLines(wrap(`- ${block.text}`, regular, BODY, textWidth - 10), regular, BODY, 8, LEAD, 8);
        y -= 1;
        break;
      case "kv":
        drawLines(wrap(`${block.label}: ${block.value}`, regular, BODY, textWidth), regular, BODY, 0, LEAD);
        break;
      case "spacer":
        y -= 8;
        break;
    }
  }

  // Footer on every page (needs the final page count).
  const total = pages.length;
  pages.forEach((p, idx) => {
    p.drawText(safeText(footerOf(idx, total)).text, {
      x: MARGIN,
      y: MARGIN - 24,
      size: 7,
      font: regular,
      color: rgb(0.45, 0.45, 0.45),
    });
  });

  const bytes = await doc.save();
  return { bytes, pageCount: total };
}
