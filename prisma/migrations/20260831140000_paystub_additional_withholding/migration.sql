-- Additional federal/state withholding on paystubs (extra W-4 elections)
-- Note: this was originally folded into 20260831120000_tax_questions, which
-- had already been applied in production — shipped here as a new migration.

ALTER TABLE "Paystub" ADD COLUMN "additionalWithholding" JSONB;