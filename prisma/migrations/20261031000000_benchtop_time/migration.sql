-- Benchtop time import (EK Consulting invoicing; CLAUDE.md "Benchtop time import"). Purely additive: nullable columns on
-- InvoicingProfile and Client and one defaulted array column on BillingLine. No table, index, constraint or data change.
-- The deploy runs `prisma migrate deploy`, so pushing the code applies it.

-- AlterTable
ALTER TABLE "InvoicingProfile" ADD COLUMN     "benchtopKeyEncrypted" TEXT,
ADD COLUMN     "benchtopKeyLast4" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "benchtopClientId" TEXT,
ADD COLUMN     "hourlyRateCents" INTEGER;

-- AlterTable
ALTER TABLE "BillingLine" ADD COLUMN     "timeEntryIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
