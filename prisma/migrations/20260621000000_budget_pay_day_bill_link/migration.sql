-- AlterTable: add payDay to Budget
ALTER TABLE "Budget" ADD COLUMN "payDay" INTEGER;

-- AlterTable: add budgetTagId and budgetEntityId to ScheduledBill
ALTER TABLE "ScheduledBill" ADD COLUMN "budgetTagId" TEXT;
ALTER TABLE "ScheduledBill" ADD COLUMN "budgetEntityId" TEXT;

-- CreateIndex: unique constraint on (budgetTagId, budgetEntityId)
-- NULLs don't conflict in Postgres, so existing rows are unaffected
CREATE UNIQUE INDEX "ScheduledBill_budgetTagId_budgetEntityId_key" ON "ScheduledBill"("budgetTagId", "budgetEntityId");
