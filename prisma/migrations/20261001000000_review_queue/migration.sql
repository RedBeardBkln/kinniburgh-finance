-- "Assign to Eva" transaction review queue (assign-to-eva-review-queue task).
-- Assignment state lives in new tables; Transaction is not altered (transactions
-- stay immutable facts). Statuses are plain TEXT validated at the app layer
-- (lib/review-queue.ts), matching the repo's no-DB-enum convention.
--
-- All columns needed by the later phases (token minting, SMS send status,
-- 24h reminder) are created here so the whole feature ships with one migration.
-- Phase 1 only reads/writes ReviewBatch (status = 'draft') and
-- TransactionAssignment.

CREATE TABLE "ReviewBatch" (
    "id"              TEXT NOT NULL,
    "assigneeUserId"  TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "status"          TEXT NOT NULL DEFAULT 'draft',
    "submittedAt"     TIMESTAMP(3),
    "firstOpenedAt"   TIMESTAMP(3),
    "completedAt"     TIMESTAMP(3),
    "expiresAt"       TIMESTAMP(3),
    "smsStatus"       TEXT,
    "smsSentAt"       TIMESTAMP(3),
    "smsError"        TEXT,
    "reminderStatus"  TEXT,
    "reminderSentAt"  TIMESTAMP(3),
    "reminderError"   TEXT,
    "createdAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReviewBatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ReviewLinkToken" (
    "id"        TEXT NOT NULL,
    "batchId"   TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "kind"      TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewLinkToken_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "TransactionAssignment" (
    "id"            TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "batchId"       TEXT NOT NULL,
    "status"        TEXT NOT NULL DEFAULT 'pending',
    "resolvedAt"    TIMESTAMP(3),
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TransactionAssignment_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ReviewLinkToken_tokenHash_key" ON "ReviewLinkToken"("tokenHash");

CREATE UNIQUE INDEX "TransactionAssignment_transactionId_batchId_key"
  ON "TransactionAssignment"("transactionId", "batchId");

ALTER TABLE "ReviewBatch" ADD CONSTRAINT "ReviewBatch_assigneeUserId_fkey"
  FOREIGN KEY ("assigneeUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReviewBatch" ADD CONSTRAINT "ReviewBatch_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ReviewLinkToken" ADD CONSTRAINT "ReviewLinkToken_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ReviewBatch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "TransactionAssignment" ADD CONSTRAINT "TransactionAssignment_transactionId_fkey"
  FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "TransactionAssignment" ADD CONSTRAINT "TransactionAssignment_batchId_fkey"
  FOREIGN KEY ("batchId") REFERENCES "ReviewBatch"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
