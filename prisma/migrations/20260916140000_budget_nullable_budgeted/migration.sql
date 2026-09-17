-- Budget.budgeted becomes nullable: a blank budgeted amount now means
-- "auto-sum from this line's nested children in the same account, recursively"
-- (budget-parent-auto-sum task). Pure type relaxation — every existing row
-- already has a non-null value, so no data migration is needed.
ALTER TABLE "Budget" ALTER COLUMN "budgeted" DROP NOT NULL;
