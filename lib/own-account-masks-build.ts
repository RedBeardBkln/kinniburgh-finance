// Read-only: which statement masks identify exactly ONE active TD Bank account of the household. Used only by
// lib/month-spend.ts to recognise a bank-labelled transfer between own accounts. The masks stay server-side as Map keys:
// they are never put in a payload, a log line or the UI. No auth here (callers run auth() first); no writes.
//
// Scope: "Online Xfer Transfer to/from XX xNNNN" is TD Bank wording, so only TD accounts can be its counterpart. This is
// the same institution lib/transfer-match-runner.ts limits its matching to; a TD transfer to a non-household account whose
// last 4 digits equal the mask of, say, a credit union or QuickBooks account of the household is therefore NOT excluded.
import { db } from "@/lib/db";

/** The institution whose wording the label belongs to (mirrors the filter in lib/transfer-match-runner.ts). */
export const TD_BANK_INSTITUTION_NAME = "TD Bank";

export async function loadOwnAccountByMask(): Promise<Map<string, string>> {
  const rows = await db.account.findMany({
    where: { archivedAt: null, institution: { name: TD_BANK_INSTITUTION_NAME } },
    select: { id: true, mask: true },
  });
  const seen = new Map<string, string | null>();
  for (const r of rows) {
    if (!r.mask) continue;
    // a mask shared by two active accounts is ambiguous: never classify by it
    seen.set(r.mask, seen.has(r.mask) ? null : r.id);
  }
  const out = new Map<string, string>();
  for (const [mask, id] of seen) if (id) out.set(mask, id);
  return out;
}
