-- Project Tracker: transform savings-goal Project into cross-entity expense tracker
-- Renames targetAmount → budget, drops savedAmount, adds entityId + projectId FKs

-- 1. Rename targetAmount to budget and drop savedAmount
ALTER TABLE "Project" RENAME COLUMN "targetAmount" TO "budget";
ALTER TABLE "Project" DROP COLUMN "savedAmount";

-- 2. Add entityId (master entity for the project — nullable, populated going forward)
ALTER TABLE "Project" ADD COLUMN "entityId" TEXT;
ALTER TABLE "Project" ADD CONSTRAINT "Project_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 3. Add projectId to Transaction (optional cross-account/cross-entity assignment)
ALTER TABLE "Transaction" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. Add projectId to Receipt (optional assignment)
ALTER TABLE "Receipt" ADD COLUMN "projectId" TEXT;
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;
