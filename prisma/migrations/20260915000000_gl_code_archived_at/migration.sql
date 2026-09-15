-- GL code edit/delete (gl-code-edit-delete): adds soft-delete/archive support
-- to GlCode so "delete" on an in-use code can archive instead of hard-delete,
-- keeping historical Transaction.glCodeId references (and therefore
-- historical P&L) intact. Matches the nullable-no-default archivedAt shape
-- used by every other soft-deletable model in this schema.

ALTER TABLE "GlCode" ADD COLUMN "archivedAt" TIMESTAMP(3);
