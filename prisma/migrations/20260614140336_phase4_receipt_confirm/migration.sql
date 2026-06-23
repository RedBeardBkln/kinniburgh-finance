-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedById" TEXT,
ADD COLUMN     "ocrRaw" JSONB;
