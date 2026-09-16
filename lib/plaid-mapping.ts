import { db } from "@/lib/db";
import { getPlaidClient } from "@/lib/plaid";
import { resolveOrCreateInstitution } from "@/lib/institutions";
import { type AccountType } from "@/lib/account-types";
import { Prisma } from "@prisma/client";

// ── Plaid account-mapping helpers ──────────────────────────────────────────
// DB+Plaid-aware — not unit tested directly, matching this repo's established
// DB-boundary-mocking convention (see memory). Shared between
// app/api/plaid/exchange/route.ts (fresh Link session) and
// app/api/plaid/pending-accounts/[itemId]/route.ts (resume-without-Link).

export interface PlaidAccountSuggestion {
  plaidAccountId: string;
  mask: string | null;
  name: string;
  /** Plaid's high-level account type (depository/credit/loan/investment/...) */
  type: string | null;
  subtype: string | null;
  ourAccountId: string | null;
  ourAccountNickname: string | null;
}

/**
 * Fetches this item's Plaid accounts and auto-matches them to existing
 * (non-archived) seeded Account rows by last-4-digit mask. Extracted from
 * app/api/plaid/exchange/route.ts so both the fresh-Link exchange flow and
 * the resume-without-Link pending-mapping flow can share it.
 */
export async function getPlaidAccountSuggestions(accessToken: string): Promise<PlaidAccountSuggestion[]> {
  const accountsRes = await getPlaidClient().accountsGet({ access_token: accessToken });
  const plaidAccounts = accountsRes.data.accounts;

  const seededAccounts = await db.account.findMany({
    where: { archivedAt: null },
    select: { id: true, nickname: true, mask: true },
  });

  return plaidAccounts.map((pa) => {
    const mask = pa.mask ?? null;
    const match = mask ? seededAccounts.find((sa) => sa.mask === mask) : undefined;
    return {
      plaidAccountId: pa.account_id,
      mask,
      name: pa.name,
      type: pa.type ?? null,
      subtype: pa.subtype ?? null,
      ourAccountId: match?.id ?? null,
      ourAccountNickname: match?.nickname ?? null,
    };
  });
}

export interface NewAccountFromPlaid {
  plaidAccountId: string;
  entityId: string;
  nickname: string;
  accountType: AccountType;
  mask?: string;
}

/**
 * Creates a new Account row per requested new-account mapping, resolving/
 * creating the Institution from the PlaidItem's stored institutionName/
 * institutionId. Runs sequentially (not Promise.all) — avoids a race on
 * first-institution-creation when multiple rows share the same
 * plaidItem.institutionName, and gives cleaner per-row error attribution.
 */
export async function createAccountsFromPlaidMapping(
  itemId: string,
  newAccounts: NewAccountFromPlaid[]
): Promise<void> {
  if (newAccounts.length === 0) return;

  const plaidItem = await db.plaidItem.findUnique({ where: { itemId } });
  if (!plaidItem) throw new Error(`PlaidItem not found: ${itemId}`);

  for (const newAccount of newAccounts) {
    // Defensive check: no existing non-archived Account should already hold
    // this plaidAccountId — this is the exact class of bug that orphaned
    // CorePlus (nothing else claiming the account), worth guarding even
    // though nothing in today's code path should trigger it if the UI is
    // used as designed. Not airtight against a race between two
    // near-simultaneous submits — see plan Risks.
    const alreadyMapped = await db.account.findFirst({
      where: { plaidAccountId: newAccount.plaidAccountId, archivedAt: null },
      select: { id: true },
    });
    if (alreadyMapped) {
      throw new Error(
        `An account is already mapped to Plaid account ${newAccount.plaidAccountId} — refusing to double-map it.`
      );
    }

    if (!plaidItem.institutionName) {
      // Never fabricate a name (ground rule 1) — block with a clear error.
      throw new Error(
        "This bank connection has no institution name on file from Plaid — can't create a new account without one."
      );
    }

    const institution = await resolveOrCreateInstitution(plaidItem.institutionName, {
      plaidInstitutionId: plaidItem.institutionId,
      plaidCoverageNotes: "supported",
    });

    try {
      await db.account.create({
        data: {
          institutionId: institution.id,
          entityId: newAccount.entityId,
          nickname: newAccount.nickname,
          mask: newAccount.mask ?? null,
          accountType: newAccount.accountType,
          integrationMode: "plaid",
          plaidAccountId: newAccount.plaidAccountId,
          plaidItemId: itemId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new Error(
          `An account named "${newAccount.nickname}" already exists for this entity — choose a different nickname.`
        );
      }
      throw err;
    }
  }
}
