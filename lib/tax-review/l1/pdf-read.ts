// Reads the filled PDFs of the packet back from their BYTES (not from the objects that were used to write them), so the
// L1.B checks see exactly what a reader of the file would see. pdf-lib only; no file or network access (the bytes come
// from the caller). The proven method is the one the map tests use (tax2025-pdf-harness readAllFields).

import { PDFCheckBox, PDFDocument, PDFHexString, PDFName, PDFString, PDFTextField } from "pdf-lib";
import { copiesOf, viewForCopy } from "@/lib/tax2025/pdf/copies";
import type { FormMap, PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { L1Context, L1PacketFile, ReadPdfFile } from "@/lib/tax-review/l1/context";

export async function readPdfFile(file: L1PacketFile & { formId: string }): Promise<ReadPdfFile> {
  const doc = await PDFDocument.load(file.bytes, { updateMetadata: false });
  const fields = new Map<string, string | boolean>();
  const tooltips = new Map<string, string>();
  for (const field of doc.getForm().getFields()) {
    const name = field.getName();
    if (field instanceof PDFTextField) fields.set(name, field.getText() ?? "");
    else if (field instanceof PDFCheckBox) fields.set(name, field.isChecked());
    const tu = field.acroField.dict.lookup(PDFName.of("TU"));
    if (tu instanceof PDFString || tu instanceof PDFHexString) tooltips.set(name, tu.decodeText());
  }
  return {
    name: file.name,
    formId: file.formId,
    fields,
    tooltips,
    info: {
      title: doc.getTitle(),
      subject: doc.getSubject(),
      keywords: doc.getKeywords(),
      author: doc.getAuthor(),
      creator: doc.getCreator(),
      producer: doc.getProducer(),
    },
  };
}

/** Every form PDF of the packet (the cover, which has no formId, is not a form). */
export async function readPacketFiles(files: readonly L1PacketFile[]): Promise<ReadPdfFile[]> {
  const out: ReadPdfFile[] = [];
  for (const f of files) {
    if (f.formId === null) continue;
    out.push(await readPdfFile({ ...f, formId: f.formId }));
  }
  return out;
}

export interface FileBinding {
  file: ReadPdfFile;
  /** null when no map is registered for the file's form id. */
  map: FormMap | null;
  /** The view this very file was filled from (the base view, or the view of its Form 8949 copy). null when its copy cannot be identified. */
  view: PdfReturnView | null;
}

/** Ties each read file to its map and to the exact view it was filled from. */
export function bindFiles(ctx: Pick<L1Context, "maps" | "view">, files: readonly ReadPdfFile[]): FileBinding[] {
  return files.map((file): FileBinding => {
    const map = ctx.maps.find((m) => m.formId === file.formId) ?? null;
    if (map === null) return { file, map: null, view: null };
    const copies = copiesOf(map, ctx.view);
    if (copies.length === 0) return { file, map, view: ctx.view };
    const copy = copies.find((c) => file.name.endsWith(`-${c.suffix}.pdf`));
    return { file, map, view: copy === undefined ? null : viewForCopy(ctx.view, copy) };
  });
}

/** Last two path segments of an AcroForm field name, for readable evidence ("Page1[0].f1_47[0]"). */
export function shortFieldName(name: string): string {
  return name.split(".").slice(-2).join(".");
}

export function evidenceRefForField(formId: string, name: string): string {
  return `pdf:${formId}:${shortFieldName(name)}`;
}
