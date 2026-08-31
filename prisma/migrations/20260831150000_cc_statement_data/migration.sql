-- Credit card statement data (due date, statement balance, minimum payment, APR)
-- pulled from Plaid Liabilities on every sync. Pay statementBalance by ccDueDate
-- to avoid interest.

ALTER TABLE "Account" ADD COLUMN "ccDueDate" TIMESTAMP(3);
ALTER TABLE "Account" ADD COLUMN "ccStatementBalance" DECIMAL(14,2);
ALTER TABLE "Account" ADD COLUMN "ccMinimumPayment" DECIMAL(14,2);
ALTER TABLE "Account" ADD COLUMN "ccApr" DECIMAL(6,3);
ALTER TABLE "Account" ADD COLUMN "ccDataAt" TIMESTAMP(3);