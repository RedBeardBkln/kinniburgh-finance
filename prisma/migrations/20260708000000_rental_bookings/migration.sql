CREATE TABLE "RentalBooking" (
    "id" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "confirmationCode" TEXT NOT NULL,
    "payoutDate" TIMESTAMP(3) NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "nights" INTEGER NOT NULL,
    "guest" TEXT NOT NULL,
    "listing" TEXT NOT NULL,
    "grossEarnings" DECIMAL(10,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "RentalBooking_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RentalBooking_entityId_confirmationCode_key"
    ON "RentalBooking"("entityId", "confirmationCode");

ALTER TABLE "RentalBooking"
    ADD CONSTRAINT "RentalBooking_entityId_fkey"
    FOREIGN KEY ("entityId") REFERENCES "Entity"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
