-- Bank statements: uploaded statement files + extracted period balances.
-- Source of truth for monthly/quarterly/annual balance sheets.
-- Tax-relevant: archive only, never hard-delete.

CREATE TABLE "BankStatement" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "documentId" TEXT,
    "accountId" TEXT,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "institutionName" TEXT,
    "accountMask" TEXT,
    "openingBalance" DECIMAL(14,2),
    "closingBalance" DECIMAL(14,2),
    "extractStatus" TEXT NOT NULL DEFAULT 'pending',
    "extractionData" JSONB,
    "extractModel" TEXT,
    "confirmedAt" TIMESTAMP(3),
    "confirmedById" TEXT,
    "notes" TEXT,
    "uploadedBy" TEXT NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankStatement_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "BankStatement_documentId_key" ON "BankStatement"("documentId");
CREATE INDEX "BankStatement_entityId_periodEnd_idx" ON "BankStatement"("entityId", "periodEnd");

ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_entityId_fkey"
  FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_accountId_fkey"
  FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "BankStatement" ADD CONSTRAINT "BankStatement_documentId_fkey"
  FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;