CREATE TABLE "PasswordResetToken" (
  id           TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "userId"     TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
  "tokenHash"  TEXT NOT NULL UNIQUE,
  "expiresAt"  TIMESTAMPTZ NOT NULL,
  "usedAt"     TIMESTAMPTZ,
  "createdAt"  TIMESTAMPTZ NOT NULL DEFAULT now()
);
