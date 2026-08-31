-- Tax planning questions for personal tax workspaces + paystub additional withholding.
-- Tax-related records are never hard-deleted.

-- Additional federal/state withholding on paystubs (extra W-4 elections)
ALTER TABLE "Paystub" ADD COLUMN "additionalWithholding" JSONB;

CREATE TABLE "TaxQuestion" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "options" JSONB,
    "answer" JSONB,
    "answeredAt" TIMESTAMP(3),
    "skippedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxQuestion_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "TaxQuestion" ADD CONSTRAINT "TaxQuestion_workspaceId_fkey"
    FOREIGN KEY ("workspaceId") REFERENCES "TaxWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "TaxQuestion_workspaceId_idx" ON "TaxQuestion"("workspaceId");

CREATE UNIQUE INDEX "TaxQuestion_workspaceId_key_key" ON "TaxQuestion"("workspaceId", "key");