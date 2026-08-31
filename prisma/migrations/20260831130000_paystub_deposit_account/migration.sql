-- Paystub direct-deposit account selector

ALTER TABLE "Paystub" ADD COLUMN "depositAccountId" TEXT;

ALTER TABLE "Paystub" ADD CONSTRAINT "Paystub_depositAccountId_fkey"
    FOREIGN KEY ("depositAccountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "Paystub_depositAccountId_idx" ON "Paystub"("depositAccountId");