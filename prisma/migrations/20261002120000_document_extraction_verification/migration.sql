-- Document extraction verification (document-extraction-status-and-review task, pass 1).
-- Additive, nullable, no backfill, no defaults: every existing document stays
-- "not verified" (extractionConfirmedAt NULL) with no corrections and no
-- recorded error. extractionStatus keeps its existing meaning ("the AI run
-- finished"); "verified" is the separate extractionConfirmedAt/ById pair.
-- extractionCorrections is an owner-corrections overlay (JSONB) that never
-- overwrites the AI output in extractionData. ON DELETE SET NULL on the
-- confirming user, matching Document_subjectUserId_fkey.

ALTER TABLE "Document" ADD COLUMN "extractionConfirmedAt" TIMESTAMP(3);
ALTER TABLE "Document" ADD COLUMN "extractionConfirmedById" TEXT;
ALTER TABLE "Document" ADD COLUMN "extractionCorrections" JSONB;
ALTER TABLE "Document" ADD COLUMN "extractionError" TEXT;

ALTER TABLE "Document" ADD CONSTRAINT "Document_extractionConfirmedById_fkey" FOREIGN KEY ("extractionConfirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
