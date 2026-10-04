// Assembles the L1 context from a computed return (plan section 5.3): the same effective view, review sheet, CSV and DRAFT
// packet that the real outputs are built from, so what L1 checks is what would be handed out. PURE apart from the PDF engine's
// own reads of the pinned blank forms; no DB, no network. lib/tax-review-build.ts (production) and the test harness both call it.
//
// Hooks exist ONLY for the seeded-defects harness: each one lets a test change one stage's output after that stage ran, to prove
// a defect injected there is caught. Production passes none.

import { buildSheetModel, type SheetRawDocument } from "@/lib/tax2025-sheet";
import { sheetToCsv } from "@/lib/tax2025-sheet-csv";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import { formatOverrideNote, type EffectiveReturn, type OverrideRow } from "@/lib/tax2025/overrides";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import type { FormCatalog } from "@/lib/tax2025/pdf/catalog";
import { buildCoverModel } from "@/lib/tax2025/pdf/cover";
import { buildFinalPackage } from "@/lib/tax2025/pdf/final-package";
import { requiredFormsWithoutPdf } from "@/lib/tax2025/pdf/no-pdf-forms";
import { buildPacket } from "@/lib/tax2025/pdf/packet";
import type { FormMap, PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import type { Ty2025Return } from "@/lib/tax2025/types";
import type { FinalPackageProbe, L1Context, L1Packet, LineLabelTable } from "@/lib/tax-review/l1/context";

export interface AssembleInput {
  ret: Ty2025Return;
  effective: EffectiveReturn | null;
  facts: Ty2025Facts;
  raw: RawTy2025Inputs | null;
  overrideRows: readonly OverrideRow[];
  maps: readonly FormMap[];
  mode: "draft" | "final";
  generatedAt: string;
  generatedBy: string;
  ekcName: string | null;
  catalogs: Readonly<Record<string, FormCatalog>>;
  lineLabels: LineLabelTable;
  blankFormIds: ReadonlySet<string>;
  /** The documents as the sheet lists them (ids, types, years, verification). */
  sheetDocuments: readonly SheetRawDocument[];
  /**
   * Also build the final package exactly as the `?final=1` route would (buildFinalPackage, no approval date), so L1 can say whether
   * the package can be released for this return and that it carries the same field values as the checked draft. Production: true.
   */
  includeFinalPackage?: boolean;
}

export interface AssembleHooks {
  /** Change the view after the adapter built it (before the packet is filled from it). */
  afterView?: (view: PdfReturnView) => void;
  /** Change the packet after it was built (e.g. edit a PDF's bytes). */
  afterPacket?: (packet: L1Packet) => void | Promise<void>;
  /** Change the CSV text after it was produced. */
  afterCsv?: (csv: string) => string;
  /** Use these maps for the check but the unmodified ones for filling (or the reverse); see the seeded-defects harness. */
  mapsForChecks?: readonly FormMap[];
}

export async function assembleL1Context(input: AssembleInput, hooks: AssembleHooks = {}): Promise<L1Context> {
  const view = toPdfReturnView(input.ret, input.facts, {
    generatedAt: input.generatedAt,
    generatedBy: input.generatedBy,
    ekcName: input.ekcName,
    ...(input.effective !== null ? { overrides: { effective: input.effective, formatNote: formatOverrideNote } } : {}),
  });
  hooks.afterView?.(view);
  const sheet = buildSheetModel({
    ret: input.ret,
    documents: input.sheetDocuments,
    now: new Date(input.generatedAt),
    ...(input.effective !== null ? { effective: input.effective } : {}),
  });
  const csvText = hooks.afterCsv ? hooks.afterCsv(sheetToCsv(sheet)) : sheetToCsv(sheet);
  const stamp = input.mode === "draft";
  const built = await buildPacket(view, { stamp, maps: input.maps });
  const packet: L1Packet = { files: built.files, forms: built.forms, openItems: built.openItems, continuations: built.continuations };
  await hooks.afterPacket?.(packet);
  let finalPackage: FinalPackageProbe | null = null;
  if (input.includeFinalPackage === true) {
    const result = await buildFinalPackage(view, { maps: input.maps, approvedAt: null });
    finalPackage = result.ok ? { ok: true, files: result.files.map((f) => ({ name: f.name, formId: f.formId, bytes: f.bytes })) } : { ok: false, reason: result.reason };
  }
  const cover = buildCoverModel({ view, forms: built.forms, fillItems: built.openItems, continuations: built.continuations, stamp, missingForms: requiredFormsWithoutPdf(view) });
  return {
    mode: input.mode,
    ret: input.ret,
    effective: input.effective,
    view,
    facts: input.facts,
    sheet,
    csvText,
    cover,
    packet,
    finalPackage,
    maps: hooks.mapsForChecks ?? input.maps,
    catalogs: input.catalogs,
    lineLabels: input.lineLabels,
    blankFormIds: input.blankFormIds,
    raw: input.raw,
    overrideRows: input.overrideRows,
  };
}
