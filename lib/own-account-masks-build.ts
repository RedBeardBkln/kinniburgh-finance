// Read-only: which statement masks identify exactly ONE active TD Bank account of the household. Used by
// lib/month-spend.ts to recognise a bank-labelled transfer between own accounts, and by the /transactions pending note.
// The masks stay server-side as Map keys:
// they are never put in a payload, a log line or the UI. A former mask of a household account (owner-stated alias in
// lib/td-account-masks.ts) resolves to that account too. No auth here (callers run auth() first); no writes.
//
// Scope: "Online Xfer Transfer to/from XX xNNNN" is TD Bank wording, so only TD accounts can be its counterpart. This is
// the same institution lib/transfer-match-runner.ts limits its matching to; a TD transfer to a non-household account whose
// last 4 digits equal the mask of, say, a credit union or QuickBooks account of the household is therefore NOT excluded.
import { db } from "@/lib/db";
import { buildTdMaskMap } from "@/lib/td-account-masks";

/** The institution whose wording the label belongs to (mirrors the filter in lib/transfer-match-runner.ts). */
export const TD_BANK_INSTITUTION_NAME = "TD Bank";

export async function loadOwnAccountByMask(): Promise<Map<string, string>> {
  const rows = await db.account.findMany({
    where: { archivedAt: null, institution: { name: TD_BANK_INSTITUTION_NAME } },
    select: { id: true, mask: true },
  });
  // Same resolution rules as the TD matcher, including the owner-stated former-mask alias (lib/td-account-masks.ts).
  return buildTdMaskMap(rows);
}
