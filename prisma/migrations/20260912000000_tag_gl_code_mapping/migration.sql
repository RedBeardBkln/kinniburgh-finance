-- Tag → GL code mapping: per-entity config used to auto-assign
-- Transaction.glCodeId from a transaction's tags (retroactive backfill +
-- going-forward automation). See prisma/schema.prisma comment above
-- TagGlCodeMapping for why entity-scoping of glCodeId is app-enforced only.

CREATE TABLE "TagGlCodeMapping" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "glCodeId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TagGlCodeMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TagGlCodeMapping_entityId_tagId_key" ON "TagGlCodeMapping"("entityId", "tagId");

ALTER TABLE "TagGlCodeMapping" ADD CONSTRAINT "TagGlCodeMapping_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TagGlCodeMapping" ADD CONSTRAINT "TagGlCodeMapping_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TagGlCodeMapping" ADD CONSTRAINT "TagGlCodeMapping_glCodeId_fkey"
  FOREIGN KEY ("glCodeId") REFERENCES "GlCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
