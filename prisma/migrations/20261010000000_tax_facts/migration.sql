-- Tax facts carry-forward store (tax-facts-carry-forward-store task).
-- Additive only: one NEW table, no existing row or column touched, no backfill, no seed rows
-- (the owner loads the TY2025 facts from the /tax/facts page). Every category / value kind / carry
-- policy / change kind / source kind column is plain TEXT validated at the app layer
-- (lib/tax-facts/validate.ts), matching the repo's no-DB-enum convention; no DB CHECK constraints.
-- Tax-related records are never hard-deleted: there is no delete path for this table. A change
-- inserts version + 1 and sets archivedAt on the previous row (superseded); nothing else is ever
-- modified. The latest version of a key is the row with archivedAt IS NULL. The reason column is a
-- tax record but is never written to AuditLog. The table is NOT read by the TY2025 engine, the
-- return fingerprint or the AI reviewer.
-- Generated offline with `prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel <new> --script`.
-- NOT applied by the Coder: applying it (a push to main runs `prisma migrate deploy`) needs the owner's explicit OK.

-- CreateTable
CREATE TABLE "TaxFact" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "factKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "valueKind" TEXT NOT NULL,
    "valueCents" INTEGER,
    "valueText" TEXT,
    "carryPolicy" TEXT NOT NULL,
    "changeKind" TEXT NOT NULL,
    "sourceKind" TEXT NOT NULL,
    "sourceRef" TEXT,
    "reason" TEXT,
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "setById" TEXT,
    "setByName" TEXT NOT NULL,
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxFact_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxFact_entityId_archivedAt_idx" ON "TaxFact"("entityId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaxFact_entityId_factKey_version_key" ON "TaxFact"("entityId", "factKey", "version");

-- AddForeignKey
ALTER TABLE "TaxFact" ADD CONSTRAINT "TaxFact_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxFact" ADD CONSTRAINT "TaxFact_setById_fkey" FOREIGN KEY ("setById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxFact" ADD CONSTRAINT "TaxFact_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
