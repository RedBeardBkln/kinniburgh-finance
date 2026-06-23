-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "extractedAt" TIMESTAMP(3),
ADD COLUMN     "extractionData" JSONB,
ADD COLUMN     "extractionModel" TEXT,
ADD COLUMN     "extractionStatus" TEXT;

-- CreateTable
CREATE TABLE "InsurancePolicy" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentId" TEXT,
    "policyType" TEXT NOT NULL,
    "insurer" TEXT NOT NULL,
    "policyNumber" TEXT,
    "faceAmountCents" INTEGER,
    "monthlyPremiumCents" INTEGER,
    "effectiveDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InsurancePolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyCashValue" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "asOf" TIMESTAMP(3) NOT NULL,
    "cashValueCents" INTEGER NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyCashValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SolarEntry" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "billAmountCents" INTEGER NOT NULL,
    "usageKwh" DECIMAL(10,2),
    "gridCreditCents" INTEGER,
    "documentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SolarEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonthlyReview" (
    "id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonthlyReview_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InsurancePolicy_documentId_key" ON "InsurancePolicy"("documentId");

-- CreateIndex
CREATE UNIQUE INDEX "MonthlyReview_period_key" ON "MonthlyReview"("period");

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InsurancePolicy" ADD CONSTRAINT "InsurancePolicy_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyCashValue" ADD CONSTRAINT "PolicyCashValue_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "InsurancePolicy"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SolarEntry" ADD CONSTRAINT "SolarEntry_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;
