import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { buildTy2025ReturnWithOverrides } from "@/lib/tax2025-overrides-build";
import { formatOverrideNote } from "@/lib/tax2025/overrides";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import { noApprovalLookup } from "@/lib/tax2025-pdf-approval";
import {
  FINAL_PACKAGE_CHANGE_TYPE,
  PACKET_EXPORT_CHANGE_TYPE,
  type BuiltView,
  type PacketExportAudit,
  type PdfRouteDeps,
} from "@/lib/tax2025-pdf-route";

// ── DB-aware wiring for the TY2025 PDF routes ────────────────────────────────
// READ-ONLY apart from the single AuditLog insert in recordPacketExport (the export
// record the plan requires). Everything it feeds is plain data handed to the pure,
// unit-tested adapter and PDF engine; this module itself is not unit-tested (repo
// convention: a DB-touching wrapper around tested pure functions).
//
// Owner overrides: the view is built from buildTy2025ReturnWithOverrides, the SAME loader
// the review sheet and the CSV use, so the filled forms, the cover and the sheet show
// the same values and the same note (formatOverrideNote). The loader is fail-closed: if the
// recorded overrides cannot be read the export is refused with an error, never produced
// without them.

export async function buildPdfViewForYear(year: 2025, generatedBy: string): Promise<BuiltView> {
  const build = await buildTy2025ReturnWithOverrides(year);
  if ("error" in build) return { error: build.error };
  const ekc = await getEntityBySlug("ek-consulting");
  return {
    view: toPdfReturnView(build.ret, build.facts, {
      generatedAt: new Date().toISOString(),
      generatedBy,
      ekcName: ekc?.name ?? null,
      overrides: { effective: build.effective, formatNote: formatOverrideNote },
    }),
  };
}

/** One AuditLog row: which forms and which return state were exported. Ids and counts only, never a value or a reason. */
export async function recordPacketExport(entry: PacketExportAudit): Promise<void> {
  await db.auditLog.create({
    data: {
      changedBy: entry.userId,
      changeType: entry.kind === "final" ? FINAL_PACKAGE_CHANGE_TYPE : PACKET_EXPORT_CHANGE_TYPE,
      before: Prisma.JsonNull,
      after: {
        taxYear: entry.taxYear,
        kind: entry.kind,
        forms: entry.forms,
        stamp: entry.stamp,
        fingerprint: entry.fingerprint,
        engineVersion: entry.engineVersion,
        openItemCount: entry.openItemCount,
        overrideCount: entry.overrideCount,
        fileCount: entry.fileCount,
        ...(entry.fileSha256 === undefined ? {} : { fileSha256: entry.fileSha256 }),
      },
    },
  });
}

// `approval` stays "nothing is approved" until the review store (TaxReturnApproval, unit X) is wired in at merge time:
// replace noApprovalLookup with a lookup of the current approval for the fingerprint. Until then every clean copy is refused.
export const defaultPdfRouteDeps: PdfRouteDeps = {
  buildView: buildPdfViewForYear,
  recordExport: recordPacketExport,
  approval: noApprovalLookup,
};
