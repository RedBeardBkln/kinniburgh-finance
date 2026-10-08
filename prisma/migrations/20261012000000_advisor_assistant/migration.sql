-- Advisor assistant (advisor-ai-chatbot task, Phase 1).
-- Additive only: four NEW tables (AdvisorConversation, AdvisorMessage, AdvisorMemory, AdvisorUsage), no existing row or column
-- touched, no backfill, no seed rows. The User table gets back-relations in schema.prisma only (no SQL change to "User").
-- Every status / role / category / source column is plain TEXT validated at the app layer (lib/advisor/**), matching the repo's
-- no-DB-enum convention; no DB CHECK constraints.
-- Conversations and memory notes are archive-only (nothing is hard-deleted: tax content can appear in answers). AdvisorMessage and
-- AdvisorUsage are insert-only. AdvisorUsage holds COUNTS only (no text, no arguments). The tables are NOT read by the TY2025 engine,
-- the return fingerprint or the AI reviewer.
-- Generated offline with `prisma migrate diff --from-schema-datamodel <old> --to-schema-datamodel <new> --script`.
-- NOT applied by the Coder: applying it (a push to main runs `prisma migrate deploy`) needs the owner's explicit OK.

-- CreateTable
CREATE TABLE "AdvisorConversation" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "titleSource" TEXT NOT NULL DEFAULT 'auto',
    "messageCount" INTEGER NOT NULL DEFAULT 0,
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdvisorConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvisorMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "role" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "toolCalls" JSONB,
    "stopReason" TEXT,
    "model" TEXT,
    "pageRoute" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvisorMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvisorMemory" (
    "id" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "createdById" TEXT,
    "createdByName" TEXT NOT NULL,
    "conversationId" TEXT,
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archivedAt" TIMESTAMP(3),
    "archivedById" TEXT,
    "archivedByName" TEXT,
    "archiveKind" TEXT,

    CONSTRAINT "AdvisorMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdvisorUsage" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheWriteTokens" INTEGER NOT NULL DEFAULT 0,
    "cacheReadTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "iterations" INTEGER NOT NULL DEFAULT 0,
    "toolCalls" INTEGER NOT NULL DEFAULT 0,
    "fallbackUsed" BOOLEAN NOT NULL DEFAULT false,
    "outcome" TEXT NOT NULL,
    "durationMs" INTEGER NOT NULL DEFAULT 0,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdvisorUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AdvisorConversation_userId_archivedAt_lastMessageAt_idx" ON "AdvisorConversation"("userId", "archivedAt", "lastMessageAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdvisorMessage_conversationId_seq_key" ON "AdvisorMessage"("conversationId", "seq");

-- CreateIndex
CREATE INDEX "AdvisorMemory_archivedAt_createdAt_idx" ON "AdvisorMemory"("archivedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AdvisorUsage_userId_at_idx" ON "AdvisorUsage"("userId", "at");

-- AddForeignKey
ALTER TABLE "AdvisorConversation" ADD CONSTRAINT "AdvisorConversation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvisorMessage" ADD CONSTRAINT "AdvisorMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "AdvisorConversation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvisorMemory" ADD CONSTRAINT "AdvisorMemory_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdvisorUsage" ADD CONSTRAINT "AdvisorUsage_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

