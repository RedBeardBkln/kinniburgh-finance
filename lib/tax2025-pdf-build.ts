import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { loadReviewInputs } from "@/lib/tax-review-build";
import { storeApprovalLookup } from "@/lib/tax-review-approval-lookup";
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
// Owner overrides: the view is built by loadReviewInputs, the SAME loader the AI Return Reviewer runs on (it wraps
// buildTy2025ReturnWithOverrides, the loader the review sheet and the CSV use), so the filled forms, the cover, the sheet
// and the review all show the same values and the same note (formatOverrideNote). The loader is fail-closed: if the
// recorded overrides (or the questionnaire answers) cannot be read the export is refused with an error, never produced
// without them.
//
// The fingerprint. loadReviewInputs also computes the RETURN FINGERPRINT v2 (lib/tax-review/fingerprint.ts) from the very
// same raw read: the engine version, the view, the answers, the printed header, the facts, the document set (with their
// verification and corrections), the questionnaires, the overrides and the decisions. It is computed HERE, on the server,
// for every request, and put into `view.fingerprint` (replacing the older view-only fingerprint). So the number stamped on
// the draft, printed in the package index, used in the download file names, written to the audit row and looked up in the
// approval store is ONE identifier, and a client can neither supply nor influence it (the routes take no fingerprint input).

export async function buildPdfViewForYear(year: 2025, generatedBy: string): Promise<BuiltView> {
  const inputs = await loadReviewInputs(year, generatedBy);
  if ("error" in inputs) return { error: inputs.error };
  return { view: { ...inputs.view, fingerprint: inputs.fingerprint.fingerprint } };
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

// `approval` is the review store (TaxReturnApproval): a clean copy or the final package is served only for the latest
// non-withdrawn approval whose fingerprint equals the CURRENT return fingerprint v2 (see buildPdfViewForYear).
export const defaultPdfRouteDeps: PdfRouteDeps = {
  buildView: buildPdfViewForYear,
  recordExport: recordPacketExport,
  approval: storeApprovalLookup,
};
