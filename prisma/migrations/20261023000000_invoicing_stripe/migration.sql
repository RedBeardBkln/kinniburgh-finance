-- Invoicing Phase 2: Stripe pay link and the client's view link (ek-consulting-stripe-pay-link; plan
-- .claude/pipeline/ek-consulting-stripe-pay-link/01-plan.md, section 6).
-- Additive only: TWO new tables (BillingAccessToken, StripeEvent), new columns on InvoicingProfile (stripePayEnabled DEFAULT false,
-- publicTokenTtlDays DEFAULT 90) and on BillingPayment (four nullable stripe* columns, one UNIQUE index). ADD COLUMN only, every new
-- column is nullable or has a DEFAULT, no existing row's values are rewritten, no backfill, no CHECK is added (the three Phase-1 CHECKs
-- already admit a Stripe payment: method card | ach, source stripe, amount > 0, fee >= 0; vocabularies stay app-validated).
-- Only sha256 hashes of link tokens are stored; Stripe keys are never stored in the database.
--
-- Generated offline with `prisma migrate diff` (no database was contacted). The core migration is not edited.
--
-- NOT applied by the coder: it is applied only when the owner pushes (the deploy runs `prisma migrate deploy`). Until then the
-- Phase-1 pages keep working: the new columns are read only by the Phase-2 loaders, which fail soft (P2021 / P2022).

-- AlterTable
ALTER TABLE "InvoicingProfile" ADD COLUMN     "publicTokenTtlDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "stripePayEnabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "BillingPayment" ADD COLUMN     "stripeChargeId" TEXT,
ADD COLUMN     "stripeCheckoutSessionId" TEXT,
ADD COLUMN     "stripeFeeStatus" TEXT,
ADD COLUMN     "stripePaymentIntentId" TEXT;

-- CreateTable
CREATE TABLE "BillingAccessToken" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "mintKey" TEXT,
    "purpose" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "firstViewedAt" TIMESTAMP(3),
    "lastViewedAt" TIMESTAMP(3),
    "viewCount" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BillingAccessToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StripeEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "outcome" TEXT NOT NULL,
    "entityId" TEXT,
    "documentId" TEXT,
    "paymentId" TEXT,

    CONSTRAINT "StripeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccessToken_tokenHash_key" ON "BillingAccessToken"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "BillingAccessToken_mintKey_key" ON "BillingAccessToken"("mintKey");

-- CreateIndex
CREATE INDEX "BillingAccessToken_documentId_idx" ON "BillingAccessToken"("documentId");

-- CreateIndex
CREATE INDEX "StripeEvent_outcome_receivedAt_idx" ON "StripeEvent"("outcome", "receivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_stripePaymentIntentId_key" ON "BillingPayment"("stripePaymentIntentId");

-- AddForeignKey
ALTER TABLE "BillingAccessToken" ADD CONSTRAINT "BillingAccessToken_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAccessToken" ADD CONSTRAINT "BillingAccessToken_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "BillingDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAccessToken" ADD CONSTRAINT "BillingAccessToken_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

