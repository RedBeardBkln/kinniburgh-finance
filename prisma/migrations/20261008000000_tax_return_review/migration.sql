-- TY2025 AI Return Reviewer and owner approval (ai-return-reviewer task, Phase A).
-- Additive only: four NEW tables, no existing table or row is touched, no backfill. Written from the output of
-- `prisma migrate diff --from-schema-datamodel <main schema> --to-schema-datamodel <this schema> --script`
-- (offline, no database). All four tables are INSERT-ONLY at the app layer (pinned by a source-reading test):
-- there is no update or delete path; tax records are never hard-deleted. Enumerated columns are plain TEXT
-- validated by the app (repo no-DB-enum convention). Reason / typed-confirmation columns are tax records and
-- are never written to AuditLog. NOT applied by the coder: applying it needs the owner's explicit OK because a
-- push to main runs `prisma migrate deploy` on Vercel.

-- CreateTable
CREATE TABLE "TaxReviewRun" (
    "id" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "engineVersion" TEXT NOT NULL,
    "startedById" TEXT,
    "startedByName" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "config" JSONB NOT NULL,
    "l1Summary" JSONB NOT NULL,
    "l2Summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxReviewRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxReviewFinding" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "layer" TEXT NOT NULL,
    "check" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "area" TEXT NOT NULL,
    "formKey" TEXT,
    "lineKey" TEXT,
    "message" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "citation" JSONB NOT NULL,
    "recommendedAction" TEXT NOT NULL,
    "acceptable" BOOLEAN NOT NULL,
    "origin" TEXT NOT NULL,
    "pass" TEXT,
    "downgradedFrom" TEXT,
    "challenge" TEXT,
    "rejectedReason" TEXT,
    "evidenceHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxReviewFinding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxReviewFindingDisposition" (
    "id" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "findingKey" TEXT NOT NULL,
    "evidenceHash" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "byId" TEXT,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxReviewFindingDisposition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxReturnApproval" (
    "id" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "verdictSnapshot" JSONB NOT NULL,
    "attestationVersion" TEXT,
    "attestationTextHash" TEXT,
    "typedConfirmationHash" TEXT,
    "reason" TEXT,
    "approvedById" TEXT,
    "approvedByName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxReturnApproval_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TaxReviewRun_taxYear_entityId_startedAt_idx" ON "TaxReviewRun"("taxYear", "entityId", "startedAt");

-- CreateIndex
CREATE INDEX "TaxReviewFinding_runId_idx" ON "TaxReviewFinding"("runId");

-- CreateIndex
CREATE INDEX "TaxReviewFinding_runId_key_idx" ON "TaxReviewFinding"("runId", "key");

-- CreateIndex
CREATE INDEX "TaxReviewFindingDisposition_taxYear_entityId_findingKey_idx" ON "TaxReviewFindingDisposition"("taxYear", "entityId", "findingKey");

-- CreateIndex
CREATE INDEX "TaxReturnApproval_taxYear_entityId_at_idx" ON "TaxReturnApproval"("taxYear", "entityId", "at");

-- AddForeignKey
ALTER TABLE "TaxReviewRun" ADD CONSTRAINT "TaxReviewRun_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReviewRun" ADD CONSTRAINT "TaxReviewRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReviewFinding" ADD CONSTRAINT "TaxReviewFinding_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaxReviewRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReviewFindingDisposition" ADD CONSTRAINT "TaxReviewFindingDisposition_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReviewFindingDisposition" ADD CONSTRAINT "TaxReviewFindingDisposition_byId_fkey" FOREIGN KEY ("byId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnApproval" ADD CONSTRAINT "TaxReturnApproval_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnApproval" ADD CONSTRAINT "TaxReturnApproval_runId_fkey" FOREIGN KEY ("runId") REFERENCES "TaxReviewRun"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxReturnApproval" ADD CONSTRAINT "TaxReturnApproval_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
