-- Estimated draw dates/amounts per AccrualEnvelope (accrual-draw-dates task).
-- Lets an accrued ScheduledBill's forecast use real lump-sum draw dates
-- instead of a flat monthly spread, when the owner has entered any.

CREATE TABLE "AccrualDraw" (
    "id"                TEXT NOT NULL,
    "accrualEnvelopeId" TEXT NOT NULL,
    "estimatedDate"     TIMESTAMP(3) NOT NULL,
    "estimatedAmount"   DECIMAL(14,2) NOT NULL,
    "notes"             TEXT,
    "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"         TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccrualDraw_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "AccrualDraw" ADD CONSTRAINT "AccrualDraw_accrualEnvelopeId_fkey"
  FOREIGN KEY ("accrualEnvelopeId") REFERENCES "AccrualEnvelope"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Optional link from an AccrualEnvelope to the ScheduledBill it funds.
-- Nullable: envelopes without a matching bill aren't forced to have one
-- (e.g. Sudden Valley's "McCarthy Oil (Arbor Retreat)" bill has no envelope
-- today and stays that way).
ALTER TABLE "AccrualEnvelope" ADD COLUMN "scheduledBillId" TEXT;

CREATE UNIQUE INDEX "AccrualEnvelope_scheduledBillId_key" ON "AccrualEnvelope"("scheduledBillId");

ALTER TABLE "AccrualEnvelope" ADD CONSTRAINT "AccrualEnvelope_scheduledBillId_fkey"
  FOREIGN KEY ("scheduledBillId") REFERENCES "ScheduledBill"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: link the 3 existing AccrualEnvelope rows to their matching
-- ScheduledBill, confirmed against live production data 2026-09-16 by
-- reading both tables directly (not guessed/invented). Matched by
-- accountId + real name — see .claude/pipeline/accrual-draw-dates/01-plan.md
-- for the full worked match table, including the one bill (Sudden Valley's
-- "McCarthy Oil (Arbor Retreat)") intentionally left unlinked.
UPDATE "AccrualEnvelope" ae
SET "scheduledBillId" = sb.id
FROM "ScheduledBill" sb
WHERE ae.name = 'McCarthy Oil'
  AND sb.payee = 'McCarthy Heating & Oil'
  AND ae."accountId" = sb."accountId"
  AND ae."scheduledBillId" IS NULL;

UPDATE "AccrualEnvelope" ae
SET "scheduledBillId" = sb.id
FROM "ScheduledBill" sb
WHERE ae.name = 'Firewood'
  AND sb.payee = 'Firewood'
  AND ae."accountId" = sb."accountId"
  AND ae."scheduledBillId" IS NULL;

UPDATE "AccrualEnvelope" ae
SET "scheduledBillId" = sb.id
FROM "ScheduledBill" sb
WHERE ae.name = 'Property taxes — 56 Arbor Rd'
  AND sb.payee = 'Property taxes — 56 Arbor Rd'
  AND ae."accountId" = sb."accountId"
  AND ae."scheduledBillId" IS NULL;
