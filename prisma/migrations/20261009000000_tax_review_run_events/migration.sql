-- TY2025 AI Return Reviewer, Phase B: the append-only event log of the AI review passes (L3).
-- Additive only: ONE new table, no existing table or row is touched, no backfill, no foreign key (the run row it belongs to is
-- immutable and is not altered). Written from the output of
-- `prisma migrate diff --from-schema-datamodel <schema before> --to-schema-datamodel <this schema> --script`
-- (offline, no database). The table is INSERT-ONLY at the app layer (pinned by a source-reading test): a step of an AI review is a
-- new row, never an update; the state of a review is derived from the rows. The unique index on ("runId", "eventKey") makes every
-- append idempotent and lets two browser tabs race for the same task safely. NOT applied by the coder: applying it needs the owner's
-- explicit OK because a push to main runs `prisma migrate deploy` on Vercel. Depends on nothing in 20261008000000_tax_return_review
-- (it can be applied before or after it), but the AI review reads its run rows, so apply both.

-- CreateTable
CREATE TABLE "TaxReviewRunEvent" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "eventKey" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "taskId" TEXT,
    "attempt" INTEGER,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxReviewRunEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxReviewRunEvent_runId_createdAt_idx" ON "TaxReviewRunEvent"("runId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TaxReviewRunEvent_runId_eventKey_key" ON "TaxReviewRunEvent"("runId", "eventKey");
