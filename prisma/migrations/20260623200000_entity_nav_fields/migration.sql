-- Add navigation fields to Entity for dynamic tab management
ALTER TABLE "Entity" ADD COLUMN "slug" TEXT;
ALTER TABLE "Entity" ADD COLUMN "navLabel" TEXT;
ALTER TABLE "Entity" ADD COLUMN "hiddenInNav" BOOLEAN NOT NULL DEFAULT false;

-- Create unique index on slug (NULL values don't conflict in Postgres unique indexes)
CREATE UNIQUE INDEX "Entity_slug_key" ON "Entity"("slug");

-- Seed existing entities with their slugs and nav labels
UPDATE "Entity" SET slug = 'personal', "navLabel" = 'Personal' WHERE name = 'Personal' AND slug IS NULL;
UPDATE "Entity" SET slug = 'sudden-valley', "navLabel" = 'Sudden Valley' WHERE name = 'Sudden Valley Property Management, LLC' AND slug IS NULL;
UPDATE "Entity" SET slug = 'ek-consulting', "navLabel" = 'EK Consulting' WHERE name = 'Eric Kinniburgh Consulting, LLC' AND slug IS NULL;
UPDATE "Entity" SET slug = 'mezzo', "navLabel" = 'Mezzo' WHERE name = 'Mezzo' AND slug IS NULL;
