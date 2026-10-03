-- CPA-input questionnaires (cpa-input-questionnaires task).
-- Additive only: one NEW table, no existing row touched, no backfill. The
-- questionnaire id is plain TEXT validated at the app layer
-- (lib/tax-questionnaire-content.ts), matching the repo's no-DB-enum convention;
-- no DB CHECK constraints. Tax-related records are never hard-deleted: there is
-- no delete path for this table ("reset" empties answers/note and the audit row
-- keeps the prior answer values).

-- CreateTable
CREATE TABLE "TaxQuestionnaire" (
    "id" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "entityId" TEXT NOT NULL,
    "questionnaireId" TEXT NOT NULL,
    "definitionVersion" INTEGER NOT NULL DEFAULT 1,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "note" TEXT,
    "noteUpdatedAt" TIMESTAMP(3),
    "noteUpdatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxQuestionnaire_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxQuestionnaire_taxYear_entityId_questionnaireId_key" ON "TaxQuestionnaire"("taxYear", "entityId", "questionnaireId");

-- AddForeignKey
ALTER TABLE "TaxQuestionnaire" ADD CONSTRAINT "TaxQuestionnaire_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxQuestionnaire" ADD CONSTRAINT "TaxQuestionnaire_noteUpdatedById_fkey" FOREIGN KEY ("noteUpdatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
