-- Document attribution (tax-forms-page-and-doc-tagging task, pass 1).
-- Additive, nullable, no backfill: existing documents intentionally stay
-- "Unassigned" (subjectType NULL) with no issuer. subjectType is plain TEXT
-- ("person" | "joint") validated at the app layer (lib/document-attribution.ts),
-- matching the repo's no-DB-enum convention. No DB CHECK on the person/userId
-- pairing: ON DELETE SET NULL on a deleted user would violate it.

ALTER TABLE "Document" ADD COLUMN "subjectType" TEXT;
ALTER TABLE "Document" ADD COLUMN "subjectUserId" TEXT;
ALTER TABLE "Document" ADD COLUMN "issuerName" TEXT;

ALTER TABLE "Document" ADD CONSTRAINT "Document_subjectUserId_fkey" FOREIGN KEY ("subjectUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
