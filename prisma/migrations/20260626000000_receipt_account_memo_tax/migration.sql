-- Receipt enhancements: memo, bank account link, tax category
ALTER TABLE "Receipt" ADD COLUMN "memo" TEXT;
ALTER TABLE "Receipt" ADD COLUMN "accountId" TEXT;
ALTER TABLE "Receipt" ADD COLUMN "taxCategory" TEXT;
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
