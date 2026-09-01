-- Reversible log of automatic duplicate-transaction removals.
-- Duplicate is archived; undo restores it and removes the log entry.

CREATE TABLE "DedupAction" (
    "id" TEXT NOT NULL,
    "duplicateTxId" TEXT NOT NULL,
    "keptTxId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "payeeNormalized" TEXT,
    "reason" TEXT NOT NULL DEFAULT 'exact_match',
    "detectedBy" TEXT NOT NULL DEFAULT 'cron',
    "undoneAt" TIMESTAMP(3),
    "undoneById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DedupAction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DedupAction_duplicateTxId_key" ON "DedupAction"("duplicateTxId");
CREATE INDEX "DedupAction_createdAt_idx" ON "DedupAction"("createdAt");
CREATE INDEX "DedupAction_entityId_idx" ON "DedupAction"("entityId");