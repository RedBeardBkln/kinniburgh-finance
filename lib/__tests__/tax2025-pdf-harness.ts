// Shared harness for the PDF map tests (plan sections 6.3 and T1 step 8):
//   assertMapComplete(map)               every catalog field claimed exactly once
//   assertMapGolden(map, view, expected) fill from a fixture view, SAVE, RE-LOAD from the
//                                        bytes, read every field and compare: expected
//                                        fields equal exact strings/booleans, every other
//                                        field is empty / unchecked.
// Not a test file itself (no .test suffix); T2a/T2b/T3 reuse it for their maps.

import { readFileSync } from "node:fs";
import { PDFCheckBox, PDFDocument, PDFTextField } from "pdf-lib";
import { expect } from "vitest";
import { checkCompleteness } from "@/lib/tax2025/pdf/completeness";
import { fillForm } from "@/lib/tax2025/pdf/fill";
import { catalogPath } from "@/lib/tax2025/pdf/registry";
import type { FillOptions, FillResult, FormMap, PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { FormCatalog } from "@/lib/tax2025/pdf/catalog";

export const DEFAULT_FILL_OPTIONS: FillOptions = {
  stamp: true,
  fingerprint: "abcdef012345",
  stampDate: "2026-10-03",
};

export function loadCatalog(formId: string): FormCatalog {
  return JSON.parse(readFileSync(catalogPath(formId), "utf8")) as FormCatalog;
}

export function assertMapComplete(map: FormMap): void {
  const names = loadCatalog(map.formId).fields.map((f) => f.name);
  const report = checkCompleteness(map, names);
  expect(report.unknown, `unknown fields claimed by the ${map.formId} map`).toEqual([]);
  expect(report.duplicated, `fields claimed more than once in the ${map.formId} map`).toEqual([]);
  expect(report.unclaimed, `fields of ${map.formId} claimed by nothing`).toEqual([]);
}

export type FieldValue = string | boolean;

/** Every text field (string, "" when empty) and checkbox (boolean) of a PDF, read from its bytes. */
export async function readAllFields(bytes: Uint8Array): Promise<Map<string, FieldValue>> {
  const doc = await PDFDocument.load(bytes);
  const out = new Map<string, FieldValue>();
  for (const field of doc.getForm().getFields()) {
    if (field instanceof PDFTextField) out.set(field.getName(), field.getText() ?? "");
    else if (field instanceof PDFCheckBox) out.set(field.getName(), field.isChecked());
  }
  return out;
}

export async function assertMapGolden(
  map: FormMap,
  view: PdfReturnView,
  expected: Readonly<Record<string, FieldValue>>,
  opts: FillOptions = DEFAULT_FILL_OPTIONS,
): Promise<FillResult> {
  const result = await fillForm(map.formId, view, map, opts);
  const actual = await readAllFields(result.bytes);
  for (const name of Object.keys(expected)) {
    expect(actual.has(name), `expected field ${name} exists`).toBe(true);
  }
  for (const [name, value] of actual) {
    const want = expected[name];
    if (want !== undefined) {
      expect(value, `field ${name}`).toBe(want);
    } else {
      expect(value, `field ${name} must be empty/unchecked`).toBe(typeof value === "boolean" ? false : "");
    }
  }
  return result;
}
