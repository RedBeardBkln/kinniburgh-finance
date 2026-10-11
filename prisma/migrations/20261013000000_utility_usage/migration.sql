-- Owner-uploaded utility usage history (utility-usage-upload, seasonal energy step 3).
-- Additive only: one NEW table, no existing table altered, no row touched, no backfill. The kind / unit / source columns
-- are plain TEXT validated at the app layer, matching the repo's no-DB-enum convention. INSERT-ONLY plus archive: a row is
-- never updated except to set archivedAt (and clear liveKey) and is never deleted. liveKey is set while a row is live and
-- NULL once it is archived (Postgres allows many NULLs in a unique index), which is the race-safe idempotency key: two
-- tabs inserting the same month cannot both succeed. costCents is the amount BILLED to the owner (positive = owed), not a
-- ledger amount. archivedById is a plain column with no foreign key. Generated offline with `prisma migrate diff` (no
-- database was contacted). NOT applied by the coder: it is applied only when the owner pushes (the deploy runs
-- `prisma migrate deploy`).

-- CreateTable
CREATE TABLE "UtilityUsage" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "occurredOn" TIMESTAMP(3) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit" TEXT NOT NULL,
    "costCents" INTEGER,
    "note" TEXT,
    "source" TEXT NOT NULL,
    "importBatchId" TEXT,
    "liveKey" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,

    CONSTRAINT "UtilityUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UtilityUsage_liveKey_key" ON "UtilityUsage"("liveKey");

-- CreateIndex
CREATE INDEX "UtilityUsage_entityId_kind_period_idx" ON "UtilityUsage"("entityId", "kind", "period");

-- AddForeignKey
ALTER TABLE "UtilityUsage" ADD CONSTRAINT "UtilityUsage_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UtilityUsage" ADD CONSTRAINT "UtilityUsage_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
