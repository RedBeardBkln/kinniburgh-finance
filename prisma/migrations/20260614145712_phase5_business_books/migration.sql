-- AlterTable
ALTER TABLE "Transaction" ADD COLUMN     "glCodeId" TEXT;

-- CreateTable
CREATE TABLE "TaxWorkspace" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "taxYear" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'in_progress',
    "deadline" TIMESTAMP(3),
    "filedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxWorkspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxChecklistItem" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "completedAt" TIMESTAMP(3),
    "dueDate" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxChecklistItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxWorkspace_entityId_taxYear_key" ON "TaxWorkspace"("entityId", "taxYear");

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_glCodeId_fkey" FOREIGN KEY ("glCodeId") REFERENCES "GlCode"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxWorkspace" ADD CONSTRAINT "TaxWorkspace_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxChecklistItem" ADD CONSTRAINT "TaxChecklistItem_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "TaxWorkspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
