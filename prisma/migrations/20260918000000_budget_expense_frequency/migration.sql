-- Budget expense frequency (weekly / biweekly / monthly). Budget.budgeted and
-- ScheduledBill.expectedAmount keep their existing meaning (a MONTHLY total)
-- regardless of frequency — frequency only controls scheduling/display.
-- NOT NULL DEFAULT 'monthly' backfills every existing row automatically, no
-- data loss, zero behavior change for rows that never set the new fields.
ALTER TABLE "Budget" ADD COLUMN "frequency" TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE "Budget" ADD COLUMN "payDayOfWeek" INTEGER;
ALTER TABLE "Budget" ADD COLUMN "biweeklyAnchorDate" TIMESTAMP(3);

ALTER TABLE "ScheduledBill" ADD COLUMN "frequency" TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE "ScheduledBill" ADD COLUMN "payDayOfWeek" INTEGER;
ALTER TABLE "ScheduledBill" ADD COLUMN "biweeklyAnchorDate" TIMESTAMP(3);
