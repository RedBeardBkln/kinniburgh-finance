-- Paystubs (personal income verification) + projected revenue (business forecast-only income)

CREATE TABLE "Paystub" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "fileKey" TEXT NOT NULL,
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "extractStatus" TEXT NOT NULL DEFAULT 'pending',
    "employeeName" TEXT,
    "employerName" TEXT,
    "payPeriodStart" TIMESTAMP(3),
    "payPeriodEnd" TIMESTAMP(3),
    "payDate" TIMESTAMP(3),
    "payFrequency" TEXT,
    "grossPayCents" INTEGER,
    "pretaxDeductions" JSONB,
    "taxesCents" INTEGER,
    "taxBreakdown" JSONB,
    "netPayCents" INTEGER,
    "balanceDiffCents" INTEGER,
    "extractionRaw" JSONB,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Paystub_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProjectedRevenue" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "accountId" TEXT,
    "description" TEXT NOT NULL,
    "expectedDate" TIMESTAMP(3) NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "notes" TEXT,
    "realizedAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectedRevenue_pkey" PRIMARY KEY ("id")
);

-- Foreign keys
ALTER TABLE "Paystub" ADD CONSTRAINT "Paystub_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectedRevenue" ADD CONSTRAINT "ProjectedRevenue_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ProjectedRevenue" ADD CONSTRAINT "ProjectedRevenue_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes
CREATE INDEX "Paystub_entityId_idx" ON "Paystub"("entityId");
CREATE INDEX "Paystub_payDate_idx" ON "Paystub"("payDate");
CREATE INDEX "ProjectedRevenue_entityId_idx" ON "ProjectedRevenue"("entityId");
CREATE INDEX "ProjectedRevenue_expectedDate_idx" ON "ProjectedRevenue"("expectedDate");