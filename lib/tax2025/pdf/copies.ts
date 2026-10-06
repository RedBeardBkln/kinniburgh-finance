// Forms filed in several copies (Form 8949: one Part I box and one Part II box per sheet). A map that
// declares `copies` is filled once per copy with the UNCHANGED fillForm against a derived view; every copy is
// its own PDF (merging pages would drop the AcroForm field ownership, same reason the packet is a zip).

import { fillForm } from "@/lib/tax2025/pdf/fill";
import type { FillOptions, FillResult, FormCopy, FormMap, PdfReturnView } from "@/lib/tax2025/pdf/types";

/** The copies a map wants for this view: [] for a one-sheet form and for a copy-form with nothing to file. */
export function copiesOf(map: FormMap, view: PdfReturnView): FormCopy[] {
  const copies = map.copies ? map.copies(view) : [];
  const seen = new Set<string>();
  for (const c of copies) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(c.suffix)) throw new Error(`${map.formId}: copy suffix "${c.suffix}" is not a lowercase file-name token`);
    if (seen.has(c.suffix)) throw new Error(`${map.formId}: copy suffix "${c.suffix}" is used twice`);
    seen.add(c.suffix);
  }
  return copies;
}

/** The base view with the copy's answers merged in and its tables and lines replacing the same keys. */
export function viewForCopy(view: PdfReturnView, copy: FormCopy): PdfReturnView {
  return {
    ...view,
    answers: { ...view.answers, ...copy.answers },
    tables: { ...view.tables, ...copy.tables },
    ...(copy.lines === undefined ? {} : { lines: { ...view.lines, ...copy.lines } }),
  };
}

export interface FilledCopy {
  /** null for a one-sheet form (or the single blank sheet of a copy-form with nothing to file). */
  copy: FormCopy | null;
  result: FillResult;
}

/** Fill every copy of a form. A form without copies, or with none to file, yields exactly one sheet. */
export async function fillFormCopies(formId: string, view: PdfReturnView, map: FormMap, opts: FillOptions): Promise<FilledCopy[]> {
  const copies = copiesOf(map, view);
  if (copies.length === 0) return [{ copy: null, result: await fillForm(formId, view, map, opts) }];
  const out: FilledCopy[] = [];
  for (const copy of copies) out.push({ copy, result: await fillForm(formId, viewForCopy(view, copy), map, opts) });
  return out;
}
