-- Add attempt counter to VaultOtp for brute-force protection
ALTER TABLE "VaultOtp" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
