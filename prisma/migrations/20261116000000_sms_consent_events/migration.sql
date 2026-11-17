-- SMS consent events (twilio-sms-consent).
-- Additive only: one NEW table, no existing table altered, no row touched, no backfill. The kind column is plain TEXT
-- ("consented" | "withdrawn") validated at the app layer, matching the repo's no-DB-enum convention. INSERT-ONLY: giving and
-- withdrawing consent to review-queue text messages are each a new row; there is no update or delete path. The current state
-- of a user is the row with the highest seq. The user FK is ON DELETE RESTRICT so a user row cannot silently take consent
-- evidence with it. Generated offline with `prisma migrate diff` (no database was contacted). NOT applied by the coder: it is
-- applied only when the owner pushes (the deploy runs `prisma migrate deploy`).
-- CreateTable
CREATE TABLE "SmsConsentEvent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "phoneE164" TEXT NOT NULL,
    "wordingVersion" TEXT NOT NULL,
    "wordingSha256" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SmsConsentEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SmsConsentEvent_userId_createdAt_idx" ON "SmsConsentEvent"("userId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "SmsConsentEvent_userId_seq_key" ON "SmsConsentEvent"("userId", "seq");

-- AddForeignKey
ALTER TABLE "SmsConsentEvent" ADD CONSTRAINT "SmsConsentEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

