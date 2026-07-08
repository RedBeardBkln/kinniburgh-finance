-- Add additionalAmountCents to Budget
ALTER TABLE "Budget" ADD COLUMN "additionalAmountCents" DECIMAL(14,2) NOT NULL DEFAULT 0;

-- Create RecurringExpense table
CREATE TABLE "RecurringExpense" (
  "id"          TEXT NOT NULL,
  "entityId"    TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "amountCents" INTEGER NOT NULL,
  "frequency"   TEXT NOT NULL,
  "dueDay"      INTEGER,
  "nextDueDate" TIMESTAMP(3),
  "tagId"       TEXT,
  "notes"       TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RecurringExpense_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "RecurringExpense"
  ADD CONSTRAINT "RecurringExpense_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "Entity"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecurringExpense"
  ADD CONSTRAINT "RecurringExpense_tagId_fkey"
  FOREIGN KEY ("tagId") REFERENCES "Tag"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
