import { cookies } from "next/headers";
import { db } from "@/lib/db";

export const VAULT_COOKIE = "vault-session";
export const VAULT_SESSION_HOURS = 4;

export async function getVaultSession(userId: string): Promise<boolean> {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(VAULT_COOKIE)?.value;
  if (!sessionId) return false;

  const session = await db.vaultSession.findFirst({
    where: {
      id: sessionId,
      userId,
      expiresAt: { gt: new Date() },
    },
  });

  return session !== null;
}
