-- Annual budget frequency. Budget.budgeted / ScheduledBill.expectedAmount keep
-- their meaning (a MONTHLY total — for an annual bill, the monthly set-aside
-- that accrues in the funding account). The new columns hold the due month and
-- the total due; the due day reuses Budget.payDay / ScheduledBill.autopayDay and
-- the total due on ScheduledBill reuses the existing annualBudget column.
-- Additive only: nullable columns, no backfill, existing rows untouched.
ALTER TABLE "Budget" ADD COLUMN "payMonth" INTEGER;
ALTER TABLE "Budget" ADD COLUMN "annualAmountDue" DECIMAL(14,2);

ALTER TABLE "ScheduledBill" ADD COLUMN "payMonth" INTEGER;
