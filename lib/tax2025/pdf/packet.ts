// Build the DRAFT packet: a zip of separate PDFs (cover first, then the forms in IRS
// attachment order). Merging forms into one PDF would break AcroForm field ownership
// (widgets are copied but the fields are not registered), so the CPA could not edit
// the fields; hence a zip. Nothing is persisted; the caller streams the bytes.

import { zipSync, type Zippable } from "fflate";
import { buildCoverModel, renderCover, type CoverForm } from "@/lib/tax2025/pdf/cover";
import { FLAT_FORM_COVER_NOTES } from "@/lib/tax2025/pdf/ct-overlay";
import { fillForm } from "@/lib/tax2025/pdf/fill";
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

export async function buildPacket(view: PdfReturnView, options: PacketOptions): Promise<PacketResult> {
  const stamp = options.stamp ?? true;
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
    const result = await fillForm(map.formId, view, map, { stamp, fingerprint: fp12, stampDate });
    n += 1;
    const prefix = String(n).padStart(2, "0");
    const name = isCt(map.formId) ? `ct/${map.formId}.pdf` : `${prefix}-${map.formId}.pdf`;
    files.push({ name, formId: map.formId, bytes: result.bytes });
    const note = FLAT_FORM_COVER_NOTES[map.formId];
    forms.push({
      formId: map.formId,
      title: entry.title,
      included: true,
      reason: inclusion.reason,
      blankByDesign: result.blankByDesign,
      blankNotes: result.blankNotes,
      ...(note === undefined ? {} : { note }),
    });
    for (const item of result.openItems) if (!itemById.has(item.id)) itemById.set(item.id, item);
    continuations.push(...result.continuations);
  }

  const openItems = [...itemById.values()];
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
