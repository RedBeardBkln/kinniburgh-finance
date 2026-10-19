-- One-sided own-account transfer marker (transactions-transfer-hiding).
-- Additive only: one NEW nullable column on "Transaction", no default, no backfill, no index, no row touched. It holds the
-- id of the OTHER household account named by a validated TD Bank transfer label ("Online Xfer Transfer to/from XX xNNNN")
-- when that leg has no counterpart in the records. Plain TEXT with no foreign key (accounts are archived, never deleted).
-- Metadata only: the transaction facts are never changed. Written only by lib/transfer-match-runner.ts. Hand-written and
-- checked offline with `prisma migrate diff` (no database was contacted). NOT applied by the coder: it is applied only
-- when the owner pushes (the deploy runs `prisma migrate deploy`).

-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN "ownTransferAccountId" TEXT;
