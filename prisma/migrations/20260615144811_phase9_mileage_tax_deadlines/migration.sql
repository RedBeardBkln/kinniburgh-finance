-- CreateTable
CREATE TABLE "MileageEntry" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "miles" INTEGER NOT NULL,
    "purpose" TEXT NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT false,
    "ratePerMile" DECIMAL(5,3) NOT NULL DEFAULT 0.700,
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MileageEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxDeadline" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'upcoming',
    "notes" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TaxDeadline_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "MileageEntry" ADD CONSTRAINT "MileageEntry_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDeadline" ADD CONSTRAINT "TaxDeadline_entityId_fkey" FOREIGN KEY ("entityId") REFERENCES "Entity"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
