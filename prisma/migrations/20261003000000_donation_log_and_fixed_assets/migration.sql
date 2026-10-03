-- Donation log + fixed-asset register (donation-log-and-fixed-assets task).
-- Additive only: two NEW tables, no existing row touched, no backfill. kind /
-- substantiation are plain TEXT validated at the app layer (lib/donations.ts),
-- matching the repo's no-DB-enum convention; no DB CHECK constraints.
-- Tax-related records are never hard-deleted (archivedAt only). Money is
-- integer cents.

-- CreateTable
CREATE TABLE "Donation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "recipient" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "substantiation" TEXT NOT NULL DEFAULT 'none',
    "receiptDocumentId" TEXT,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Donation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FixedAsset" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "placedInServiceDate" TIMESTAMP(3) NOT NULL,
    "costBasisCents" INTEGER NOT NULL,
    "isRealProperty" BOOLEAN NOT NULL DEFAULT false,
    "landValueCents" INTEGER,
    "businessUsePercent" INTEGER NOT NULL DEFAULT 100,
    "invoiceDocumentId" TEXT,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FixedAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Donation_entityId_date_idx" ON "Donation"("entityId", "date");

-- CreateIndex
CREATE INDEX "FixedAsset_entityId_placedInServiceDate_idx" ON "FixedAsset"("entityId", "placedInServiceDate");

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_receiptDocumentId_fkey" FOREIGN KEY ("receiptDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Donation" ADD CONSTRAINT "Donation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_invoiceDocumentId_fkey" FOREIGN KEY ("invoiceDocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FixedAsset" ADD CONSTRAINT "FixedAsset_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
