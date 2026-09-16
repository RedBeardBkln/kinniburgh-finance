-- Auto-link-envelope-transfers: ties a matched transfer-leg pair
-- (Transaction.transferPairId) to the ScheduledTransfer it fulfills, when
-- one exists. Nullable, no default, no onDelete override in the Prisma
-- field — Prisma's default for optional relations is SET NULL, matching the
-- existing glCodeId/projectId/receiptId pattern on this same table. No
-- separate index added, matching the same precedent (those three comparable
-- nullable FK columns aren't indexed either).

ALTER TABLE "Transaction" ADD COLUMN "scheduledTransferId" TEXT;

ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_scheduledTransferId_fkey"
  FOREIGN KEY ("scheduledTransferId") REFERENCES "ScheduledTransfer"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
