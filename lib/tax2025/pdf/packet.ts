// Build the DRAFT packet: a zip of separate PDFs (cover first, then the forms in IRS
// attachment order). Merging forms into one PDF would break AcroForm field ownership
// (widgets are copied but the fields are not registered), so the CPA could not edit
// the fields; hence a zip. Nothing is persisted; the caller streams the bytes.

import { zipSync, type Zippable } from "fflate";
import { buildCoverModel, renderCover, type CoverForm } from "@/lib/tax2025/pdf/cover";
import { FLAT_FORM_COVER_NOTES } from "@/lib/tax2025/pdf/ct-overlay";
import { fillFormCopies } from "@/lib/tax2025/pdf/copies";
import { formatNewYorkDate, shortFingerprint } from "@/lib/tax2025/pdf/format";
import { requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { formInclusion } from "@/lib/tax2025/pdf/policy";
import { getManifestEntry } from "@/lib/tax2025/pdf/registry";
import type { ContinuationList, FormMap, PacketOpenItem, PdfReturnView } from "@/lib/tax2025/pdf/types";

/** Leading IRS attachment order (plan section 4.2); every other form follows by ascending Seq, CT last. */
export const PACKET_ORDER: readonly string[] = [
  "f1040",
  "f1040s1",
  "f1040s1a",
  "f1040s2",
  "f1040s3",
  "f2210",
  "f1040sa",
  "f1040sb",
  "f1040sc",
  "f1040sd",
  "f8949",
  "f1040sse",
];

export const COVER_FILE_NAME = "00-cover.pdf";

function isCt(formId: string): boolean {
  return formId.startsWith("ct");
}

/** Order maps for the packet: leading list, then other federal forms by Seq (nulls last), then CT forms. */
export function orderMaps(maps: readonly FormMap[]): FormMap[] {
  const rank = (m: FormMap): [number, number, string] => {
    const lead = PACKET_ORDER.indexOf(m.formId);
    if (lead !== -1) return [0, lead, m.formId];
    if (isCt(m.formId)) return [2, 0, m.formId];
    const seq = getManifestEntry(m.formId).attachmentSeq;
    return [1, seq ?? Number.MAX_SAFE_INTEGER, m.formId];
  };
  return [...maps].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || ra[2].localeCompare(rb[2]);
  });
}

export interface PacketOptions {
  /** Per-page DRAFT footer on the forms (E1). Default true; false yields clean copies. */
  stamp?: boolean;
  /** Maps to consider (inclusion rule decides which are emitted). */
  maps: readonly FormMap[];
}

export interface PacketFile {
  name: string;
  formId: string | null;
  bytes: Uint8Array;
}

export interface PacketResult {
  zip: Uint8Array;
  files: PacketFile[];
  forms: CoverForm[];
  openItems: PacketOpenItem[];
  continuations: ContinuationList[];
  coverPageCount: number;
}

export interface FilledPacketForms {
  forms: CoverForm[];
  files: PacketFile[];
  openItems: PacketOpenItem[];
  continuations: ContinuationList[];
}

export interface FillPacketOptions {
  maps: readonly FormMap[];
  /** Per-page DRAFT footer. Ignored (always off) when `final` is set. */
  stamp: boolean;
  /** FINAL clean forms (fill.ts `final`): no stamp, no draft/override tooltip notes, neutral document properties. */
  final: boolean;
  /** Folder for the form files inside the zip ("" for the draft packet, "forms/" for the final package). */
  folder: string;
}

/**
 * Fill every form the inclusion rule selects, in IRS attachment order. Shared by the DRAFT packet and the final package so
 * both file the same forms with the same field values; only the stamp, the tooltips, the document properties and the
 * file locations differ.
 */
export async function fillPacketForms(view: PdfReturnView, options: FillPacketOptions): Promise<FilledPacketForms> {
  const stamp = options.final ? false : options.stamp;
  const fp12 = shortFingerprint(view.fingerprint);
  const stampDate = formatNewYorkDate(view.generatedAt);
  const ordered = orderMaps(options.maps);

  const forms: CoverForm[] = [];
  const files: PacketFile[] = [];
  const itemById = new Map<string, PacketOpenItem>();
  const continuations: ContinuationList[] = [];

  let n = 0;
  for (const map of ordered) {
    const entry = getManifestEntry(map.formId);
    const inclusion = formInclusion(map, view);
    if (!inclusion.include) {
      forms.push({ formId: map.formId, title: entry.title, included: false, reason: inclusion.reason, blankByDesign: {} });
      continue;
    }
    // A form filed in several copies (Form 8949) yields one file per copy; every other form exactly one.
    let filled: Awaited<ReturnType<typeof fillFormCopies>>;
    try {
      filled = await fillFormCopies(map.formId, view, map, { stamp, fingerprint: fp12, stampDate, final: options.final });
    } catch (err) {
      // A defect in a copy builder (e.g. a row whose box is not a box of its Part) must not take the whole packet down
      // or hide: the form is left out and a BLOCKING item says so. Only the error class is shown (messages can quote values).
      const id = `fill:${map.formId}:build-failed`;
      itemById.set(id, {
        id,
        severity: "blocking",
        source: "fill",
        formId: map.formId,
        message: `${entry.title} could not be built (${err instanceof Error ? err.name : "unknown error"}) and is NOT in this packet; prepare it outside this app.`,
      });
      forms.push({ formId: map.formId, title: entry.title, included: false, reason: "it could not be built (see the blocking item)", blankByDesign: {} });
      continue;
    }
    const first = filled[0];
    if (!first) throw new Error(`fillFormCopies returned no sheet for ${map.formId}`);
    const copyLines: string[] = [];
    for (const { copy, result } of filled) {
      n += 1;
      const prefix = String(n).padStart(2, "0");
      const name = `${options.folder}${
        isCt(map.formId) ? `ct/${map.formId}.pdf` : copy === null ? `${prefix}-${map.formId}.pdf` : `${prefix}-${map.formId}-${copy.suffix}.pdf`
      }`;
      files.push({ name, formId: map.formId, bytes: result.bytes });
      if (copy !== null) copyLines.push(`${name}: ${copy.label}`);
      for (const item of result.openItems) if (!itemById.has(item.id)) itemById.set(item.id, item);
      continuations.push(...result.continuations);
    }
    const flatNote = FLAT_FORM_COVER_NOTES[map.formId];
    const copiesNote = copyLines.length > 0 ? `${copyLines.length} sheet(s) - ${copyLines.join("; ")}.` : undefined;
    const note = [flatNote, copiesNote].filter((t): t is string => t !== undefined).join(" ");
    forms.push({
      formId: map.formId,
      title: entry.title,
      included: true,
      reason: inclusion.reason,
      blankByDesign: first.result.blankByDesign,
      blankNotes: first.result.blankNotes,
      ...(note === "" ? {} : { note }),
    });
  }

  return { forms, files, openItems: [...itemById.values()], continuations };
}

export async function buildPacket(view: PdfReturnView, options: PacketOptions): Promise<PacketResult> {
  const stamp = options.stamp ?? true;
  const { forms, files, openItems, continuations } = await fillPacketForms(view, { maps: options.maps, stamp, final: false, folder: "" });
  const model = buildCoverModel({ view, forms, fillItems: openItems, continuations, stamp, missingForms: requiredFormsWithoutPdf(view) });
  const cover = await renderCover(model);
  if (model.redactedCount > 0) {
    openItems.push({
      id: "cover:ssnlike",
      severity: "blocking",
      source: "fill",
      formId: "cover",
      message: `${model.redactedCount} cover text value(s) looked like a Social Security Number and were replaced by a placeholder.`,
    });
  }

  const mtime = new Date(view.generatedAt);
  const zippable: Zippable = { [COVER_FILE_NAME]: [cover.bytes, { mtime, level: 0 }] };
  for (const f of files) zippable[f.name] = [f.bytes, { mtime, level: 0 }];
  const zip = zipSync(zippable);

  return {
    zip,
    files: [{ name: COVER_FILE_NAME, formId: null, bytes: cover.bytes }, ...files],
    forms,
    openItems,
    continuations,
    coverPageCount: cover.pageCount,
  };
}
