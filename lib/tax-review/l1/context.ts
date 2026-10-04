// What every L1 check receives (plan section 5.3): ONE read-only snapshot of the return as it is about to be filed,
// assembled by lib/tax-review-build.ts (production) or the test harness. Checks are pure functions of this context:
// no DB, no network, no clock, and they never mutate it.

import type { Finding } from "@/lib/tax-review/types";
import type { Ty2025Facts } from "@/lib/tax2025/facts";
import type { EffectiveReturn, OverrideRow } from "@/lib/tax2025/overrides";
import type { FormCatalog } from "@/lib/tax2025/pdf/catalog";
import type { CoverModel } from "@/lib/tax2025/pdf/cover";
import type { ContinuationList, FormMap, PacketOpenItem, PdfReturnView } from "@/lib/tax2025/pdf/types";
import type { CoverForm } from "@/lib/tax2025/pdf/cover";
import type { RawTy2025Inputs } from "@/lib/tax2025/resolve-facts";
import type { Ty2025Return } from "@/lib/tax2025/types";
import type { SheetModel } from "@/lib/tax2025-sheet";

export interface L1PacketFile {
  /** "00-cover.pdf", "01-f1040.pdf", "03-f8949-a-1.pdf", "ct/ct1040.pdf" ... */
  name: string;
  /** null for the cover. */
  formId: string | null;
  bytes: Uint8Array;
}

export interface L1Packet {
  files: readonly L1PacketFile[];
  forms: readonly CoverForm[];
  openItems: readonly PacketOpenItem[];
  continuations: readonly ContinuationList[];
}

/**
 * The final package as the download route would build it for this return (buildFinalPackage, approval date left out): either its
 * files (forms with a formId; the index and the attachments have none) or the reason the route would refuse (409). null / absent
 * = not built (the checks that need it are skipped, and say so in the run summary).
 */
export type FinalPackageProbe = { ok: true; files: readonly L1PacketFile[] } | { ok: false; reason: string };

/** formId -> AcroForm field name -> the printed line label found next to it on the blank PDF (data/forms/2025/line-labels.json). */
export type LineLabelTable = Readonly<Record<string, Readonly<Record<string, string>>>>;

/** One PDF of the packet read back from its bytes. */
export interface ReadPdfFile {
  name: string;
  formId: string;
  /** Text fields as their string ("" when empty) and checkboxes as boolean. */
  fields: ReadonlyMap<string, string | boolean>;
  /** The /TU tooltip of each field that has one. */
  tooltips: ReadonlyMap<string, string>;
  info: { title: string | undefined; subject: string | undefined; keywords: string | undefined; author: string | undefined; creator: string | undefined; producer: string | undefined };
}

export interface L1Context {
  /** "draft" = the stamped packet; "final" = the package that would be released after approval (adds the packaging bans). */
  mode: "draft" | "final";
  ret: Ty2025Return;
  /** The return with the recorded overrides applied; null when the caller built no override layer. */
  effective: EffectiveReturn | null;
  /** The effective view every printed value comes from. */
  view: PdfReturnView;
  facts: Ty2025Facts;
  sheet: SheetModel;
  /** The CSV export text of the sheet. */
  csvText: string;
  /** The cover page model of the packet (null = not built). */
  cover: CoverModel | null;
  packet: L1Packet;
  /** The final package as the download route would build it (see FinalPackageProbe); absent in the unit tests that do not need it. */
  finalPackage?: FinalPackageProbe | null;
  maps: readonly FormMap[];
  /** Parsed field catalogs of the blank forms, by formId (for the unkeyed-line check). */
  catalogs: Readonly<Record<string, FormCatalog>>;
  lineLabels: LineLabelTable;
  /** Form ids that have a pinned blank PDF in the manifest. */
  blankFormIds: ReadonlySet<string>;
  /** The full effective extraction of every Personal document: SERVER SIDE ONLY, never sent anywhere. null = not available. */
  raw: RawTy2025Inputs | null;
  overrideRows: readonly OverrideRow[];
  /** The packet read back from bytes (filled by runL1 when absent). */
  read?: readonly ReadPdfFile[];
}

export interface L1Check {
  /** "L1.F1", "L1.B1", ... (the plan's check ids). */
  id: string;
  description: string;
  run(ctx: L1Context): Finding[] | Promise<Finding[]>;
}
