-- TY2025 return overrides (ty2025-overrides-core task).
-- Additive only: one NEW table, no existing row touched, no backfill. The
-- target kind / value kind / authority / archive kind columns are plain TEXT
-- validated at the app layer (lib/tax2025/overrides.ts), matching the repo's
-- no-DB-enum convention; no DB CHECK constraints. Tax-related records are never
-- hard-deleted: there is no delete path for this table. A change inserts
-- version + 1 and sets archivedAt on the previous row ("superseded"); clearing
-- only sets archivedAt ("cleared"). The reason columns are tax records but are
-- never written to AuditLog. "Active" = archivedAt IS NULL.

-- CreateTable
CREATE TABLE "TaxReturnOverride" (
    "id" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "targetKind" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "valueKind" TEXT NOT NULL,
    "valueCents" INTEGER,
    "valueText" TEXT,
    "computedSnapshot" JSONB NOT NULL,
    "authority" TEXT NOT NULL DEFAULT 'cpa',
    "reason" TEXT NOT NULL,
    "setById" TEXT,
    "setByName" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archiveKind" TEXT,
    "archiveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxReturnOverride_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxReturnOverride_taxYear_entityId_archivedAt_idx" ON "TaxReturnOverride"("taxYear", "entityId", "archivedAt");

-- CreateIndex
-- (Postgres truncates identifiers to 63 bytes; Prisma names this one with "_ver_key".)
CREATE UNIQUE INDEX "TaxReturnOverride_taxYear_entityId_targetKind_targetKey_ver_key" ON "TaxReturnOverride"("taxYear", "entityId", "targetKind", "targetKey", "version");

-- AddForeignKey
ALTER TABLE "TaxReturnOverride" ADD CONSTRAINT "TaxReturnOverride_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnOverride" ADD CONSTRAINT "TaxReturnOverride_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnOverride" ADD CONSTRAINT "TaxReturnOverride_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
