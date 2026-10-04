import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { getEntityBySlug } from "@/lib/entity";
import { buildTy2025Return } from "@/lib/tax2025-build";
import { toPdfReturnView } from "@/lib/tax2025/pdf/adapter";
import {
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
// T9b: once the overrides module lands (lib/tax2025/overrides*.ts), swap
// buildTy2025Return(2025) for buildTy2025ReturnWithOverrides and pass
// `overrides: { effective, formatNote: formatOverrideNote }` to toPdfReturnView.

export async function buildPdfViewForYear(year: 2025, generatedBy: string): Promise<BuiltView> {
  const build = await buildTy2025Return(year);
  if ("error" in build) return { error: build.error };
  const ekc = await getEntityBySlug("ek-consulting");
  return {
    view: toPdfReturnView(build.ret, build.facts, {
      generatedAt: new Date().toISOString(),
      generatedBy,
      ekcName: ekc?.name ?? null,
    }),
  };
}

/** One AuditLog row: which forms and which return state were exported. Ids and counts only, never a value. */
export async function recordPacketExport(entry: PacketExportAudit): Promise<void> {
  await db.auditLog.create({
    data: {
      changedBy: entry.userId,
      changeType: PACKET_EXPORT_CHANGE_TYPE,
      before: Prisma.JsonNull,
      after: {
        taxYear: entry.taxYear,
        kind: entry.kind,
        forms: entry.forms,
        stamp: entry.stamp,
        fingerprint: entry.fingerprint,
        engineVersion: entry.engineVersion,
        openItemCount: entry.openItemCount,
        fileCount: entry.fileCount,
      },
    },
  });
}

export const defaultPdfRouteDeps: PdfRouteDeps = {
  buildView: buildPdfViewForYear,
  recordExport: recordPacketExport,
};
