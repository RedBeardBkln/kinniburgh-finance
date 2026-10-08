-- Household tax year close events (tax-carry-screen-and-year-close, Phase B).
-- Additive only: one NEW table, no existing table altered, no row touched, no backfill. The kind column is plain TEXT
-- ("closed" | "reopened") validated at the app layer, matching the repo's no-DB-enum convention. INSERT-ONLY: marking a
-- tax year filed and reopening it for revision are each a new row; there is no update or delete path. The current state of
-- a year is the row with the highest seq for (entityId, taxYear). The note column holds a close note or the required reopen
-- reason; it is a tax record and is never written to AuditLog. There is deliberately no confirmation-number column.
-- Generated offline with `prisma migrate diff` (no database was contacted). NOT applied by the coder: it is applied only when
-- the owner pushes (the deploy runs `prisma migrate deploy`).

-- CreateTable
CREATE TABLE "TaxYearCloseEvent" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "filedOn" TIMESTAMP(3),
    "note" TEXT,
    "byId" TEXT,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxYearCloseEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxYearCloseEvent_entityId_taxYear_idx" ON "TaxYearCloseEvent"("entityId", "taxYear");

-- CreateIndex
CREATE UNIQUE INDEX "TaxYearCloseEvent_entityId_taxYear_seq_key" ON "TaxYearCloseEvent"("entityId", "taxYear", "seq");

-- AddForeignKey
ALTER TABLE "TaxYearCloseEvent" ADD CONSTRAINT "TaxYearCloseEvent_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxYearCloseEvent" ADD CONSTRAINT "TaxYearCloseEvent_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
