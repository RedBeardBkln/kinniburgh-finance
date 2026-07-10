-- CreateTable
CREATE TABLE "DebtDetail" (
    "id" TEXT NOT NULL,
    "accountId" TEXT,
    "name" TEXT NOT NULL,
    "originalBalanceCents" INTEGER,
    "manualBalanceCents" INTEGER,
    "interestRate" DECIMAL(5,3),
    "monthlyPaymentCents" INTEGER,
    "paymentDay" INTEGER,
    "tagId" TEXT,
    "notes" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DebtDetail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DebtDetail_accountId_key" ON "DebtDetail"("accountId");

-- AddForeignKey
ALTER TABLE "DebtDetail" ADD CONSTRAINT "DebtDetail_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DebtDetail" ADD CONSTRAINT "DebtDetail_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;
