-- Invoicing core, Phase 1 (ek-consulting-invoicing; plan .claude/pipeline/ek-consulting-invoicing/01-plan.md, section 5).
-- Additive only: NINE new tables (InvoicingProfile, Client, ClientContact, ReimbursableItem, BillingDocument, BillingLine,
-- BillingPayment, BillingAllocation, BillingEvent), their indexes and foreign keys. No existing table is altered, no row is
-- touched, no backfill. Status / kind / method columns are plain TEXT validated at the app layer (the repo's no-DB-enum
-- convention). Money is integer cents. Calendar days are stored at 00:00 UTC. Remit-to text and every EIN are stored encrypted
-- (lib/encrypt.ts); Stripe keys are never stored in the database.
--
-- Quotes (not estimates) and no credit memos (owner decisions 2026-10-16): BillingDocument.kind is invoice | quote, an allocation
-- belongs to a payment only (paymentId NOT NULL), and customer credit is a deposit (an unapplied payment).
--
-- Generated offline with `prisma migrate diff` (no database was contacted), then the CHECK constraints at the end were added BY
-- HAND: Prisma cannot express CHECKs and ignores them in diffs, so a future `migrate diff` will neither complain about them nor
-- recreate them (plan risk R12).
--
-- NOT applied by the coder: it is applied only when the owner pushes (the deploy runs `prisma migrate deploy`).

-- CreateTable
CREATE TABLE "InvoicingProfile" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "goLiveOn" TIMESTAMP(3) NOT NULL,
    "invoicePrefix" TEXT NOT NULL DEFAULT '',
    "nextInvoiceNumber" INTEGER NOT NULL,
    "quotePrefix" TEXT NOT NULL DEFAULT 'Q-',
    "nextQuoteNumber" INTEGER NOT NULL,
    "numberPad" INTEGER NOT NULL DEFAULT 0,
    "defaultNetDays" INTEGER NOT NULL DEFAULT 0,
    "termsLabel" TEXT NOT NULL DEFAULT 'Due upon receipt',
    "businessAddress" TEXT,
    "replyToEmail" TEXT,
    "fromName" TEXT,
    "einEncrypted" TEXT,
    "einLast4" TEXT,
    "showEinOnInvoice" BOOLEAN NOT NULL DEFAULT false,
    "logoKey" TEXT,
    "logoMime" TEXT,
    "footerText" TEXT,
    "termsText" TEXT,
    "remitToMailingAddress" TEXT,
    "checkPayableTo" TEXT,
    "remitToEncrypted" TEXT,
    "remitToUpdatedAt" TIMESTAMP(3),
    "includeRemitToByDefault" BOOLEAN NOT NULL DEFAULT false,
    "remitToApprovedAt" TIMESTAMP(3),
    "remitToApprovedById" TEXT,
    "glMap" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InvoicingProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "addressLine1" TEXT,
    "addressLine2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postalCode" TEXT,
    "country" TEXT NOT NULL DEFAULT 'US',
    "einEncrypted" TEXT,
    "einLast4" TEXT,
    "defaultNetDays" INTEGER,
    "defaultTaxable" BOOLEAN NOT NULL DEFAULT false,
    "w9DocumentId" TEXT,
    "w9ReceivedOn" TIMESTAMP(3),
    "notes" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientContact" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "role" TEXT NOT NULL,
    "roleLabel" TEXT,
    "receivesInvoices" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ClientContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReimbursableItem" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "unitCostCents" INTEGER NOT NULL,
    "pricingMode" TEXT NOT NULL,
    "markupBps" INTEGER,
    "billedUnitPriceCents" INTEGER,
    "glCodeId" TEXT NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),

    CONSTRAINT "ReimbursableItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingDocument" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "number" INTEGER,
    "displayNumber" TEXT,
    "billingModel" TEXT NOT NULL DEFAULT 'general',
    "title" TEXT,
    "poNumber" TEXT,
    "issueDate" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "netDays" INTEGER,
    "expiresOn" TIMESTAMP(3),
    "notes" TEXT,
    "internalNotes" TEXT,
    "subtotalCents" INTEGER NOT NULL DEFAULT 0,
    "discountKind" TEXT,
    "discountValue" INTEGER,
    "discountCents" INTEGER NOT NULL DEFAULT 0,
    "totalCents" INTEGER NOT NULL DEFAULT 0,
    "includeRemitTo" BOOLEAN NOT NULL DEFAULT false,
    "showEin" BOOLEAN NOT NULL DEFAULT false,
    "sourceQuoteId" TEXT,
    "scheduleId" TEXT,
    "schedulePeriod" TEXT,
    "planId" TEXT,
    "planRole" TEXT,
    "issuedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "lastSentAt" TIMESTAMP(3),
    "sendCount" INTEGER NOT NULL DEFAULT 0,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingLine" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(12,3) NOT NULL,
    "unit" TEXT,
    "unitPriceCents" INTEGER NOT NULL,
    "discountKind" TEXT,
    "discountValue" INTEGER,
    "lineTotalCents" INTEGER NOT NULL,
    "glCodeId" TEXT,
    "taxable" BOOLEAN NOT NULL DEFAULT false,
    "workDate" TIMESTAMP(3),
    "itemId" TEXT,
    "unitCostCents" INTEGER,
    "markupBps" INTEGER,
    "costTransactionId" TEXT,
    "receiptId" TEXT,

    CONSTRAINT "BillingLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPayment" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "receivedOn" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "feeCents" INTEGER NOT NULL DEFAULT 0,
    "reference" TEXT,
    "notes" TEXT,
    "depositTransactionId" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "requestKey" TEXT,
    "status" TEXT NOT NULL DEFAULT 'recorded',
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingPayment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingAllocation" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "appliedOn" TIMESTAMP(3) NOT NULL,
    "voidedAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingAllocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingEvent" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentId" TEXT,
    "paymentId" TEXT,
    "clientId" TEXT,
    "kind" TEXT NOT NULL,
    "actorId" TEXT,
    "eventKey" TEXT,
    "data" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InvoicingProfile_entityId_key" ON "InvoicingProfile"("entityId");

-- CreateIndex
CREATE INDEX "Client_entityId_idx" ON "Client"("entityId");

-- CreateIndex
CREATE UNIQUE INDEX "Client_entityId_name_key" ON "Client"("entityId", "name");

-- CreateIndex
CREATE INDEX "ClientContact_clientId_idx" ON "ClientContact"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "ReimbursableItem_entityId_name_key" ON "ReimbursableItem"("entityId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocument_sourceQuoteId_key" ON "BillingDocument"("sourceQuoteId");

-- CreateIndex
CREATE INDEX "BillingDocument_entityId_kind_status_idx" ON "BillingDocument"("entityId", "kind", "status");

-- CreateIndex
CREATE INDEX "BillingDocument_clientId_idx" ON "BillingDocument"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocument_entityId_kind_number_key" ON "BillingDocument"("entityId", "kind", "number");

-- CreateIndex
CREATE UNIQUE INDEX "BillingDocument_scheduleId_schedulePeriod_key" ON "BillingDocument"("scheduleId", "schedulePeriod");

-- CreateIndex
CREATE INDEX "BillingLine_documentId_sortOrder_idx" ON "BillingLine"("documentId", "sortOrder");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPayment_requestKey_key" ON "BillingPayment"("requestKey");

-- CreateIndex
CREATE INDEX "BillingPayment_entityId_status_idx" ON "BillingPayment"("entityId", "status");

-- CreateIndex
CREATE INDEX "BillingPayment_clientId_idx" ON "BillingPayment"("clientId");

-- CreateIndex
CREATE INDEX "BillingPayment_depositTransactionId_idx" ON "BillingPayment"("depositTransactionId");

-- CreateIndex
CREATE INDEX "BillingAllocation_invoiceId_idx" ON "BillingAllocation"("invoiceId");

-- CreateIndex
CREATE INDEX "BillingAllocation_paymentId_idx" ON "BillingAllocation"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "BillingEvent_eventKey_key" ON "BillingEvent"("eventKey");

-- CreateIndex
CREATE INDEX "BillingEvent_documentId_createdAt_idx" ON "BillingEvent"("documentId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingEvent_paymentId_createdAt_idx" ON "BillingEvent"("paymentId", "createdAt");

-- CreateIndex
CREATE INDEX "BillingEvent_entityId_createdAt_idx" ON "BillingEvent"("entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "InvoicingProfile" ADD CONSTRAINT "InvoicingProfile_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_w9DocumentId_fkey" FOREIGN KEY ("w9DocumentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClientContact" ADD CONSTRAINT "ClientContact_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursableItem" ADD CONSTRAINT "ReimbursableItem_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursableItem" ADD CONSTRAINT "ReimbursableItem_glCodeId_fkey" FOREIGN KEY ("glCodeId") REFERENCES "GlCode"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReimbursableItem" ADD CONSTRAINT "ReimbursableItem_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingDocument" ADD CONSTRAINT "BillingDocument_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingDocument" ADD CONSTRAINT "BillingDocument_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingDocument" ADD CONSTRAINT "BillingDocument_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingDocument" ADD CONSTRAINT "BillingDocument_sourceQuoteId_fkey" FOREIGN KEY ("sourceQuoteId") REFERENCES "BillingDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLine" ADD CONSTRAINT "BillingLine_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "BillingDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLine" ADD CONSTRAINT "BillingLine_glCodeId_fkey" FOREIGN KEY ("glCodeId") REFERENCES "GlCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLine" ADD CONSTRAINT "BillingLine_itemId_fkey" FOREIGN KEY ("itemId") REFERENCES "ReimbursableItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLine" ADD CONSTRAINT "BillingLine_costTransactionId_fkey" FOREIGN KEY ("costTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingLine" ADD CONSTRAINT "BillingLine_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_depositTransactionId_fkey" FOREIGN KEY ("depositTransactionId") REFERENCES "Transaction"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAllocation" ADD CONSTRAINT "BillingAllocation_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAllocation" ADD CONSTRAINT "BillingAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "BillingDocument"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAllocation" ADD CONSTRAINT "BillingAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BillingPayment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingAllocation" ADD CONSTRAINT "BillingAllocation_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "BillingDocument"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingEvent" ADD CONSTRAINT "BillingEvent_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "BillingPayment"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Hand-written CHECK constraints (not expressible in schema.prisma). Three in total.

-- An allocation applies part of a payment (a deposit on account) to an invoice; paymentId is NOT NULL, so no CHECK is needed for the
-- source. The amount is positive.
ALTER TABLE "BillingAllocation" ADD CONSTRAINT "BillingAllocation_amount_positive_chk" CHECK ("amountCents" > 0);

-- A payment is a positive gross amount; the processing fee is never negative.
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_amount_positive_chk" CHECK ("amountCents" > 0);
ALTER TABLE "BillingPayment" ADD CONSTRAINT "BillingPayment_fee_nonnegative_chk" CHECK ("feeCents" >= 0);
