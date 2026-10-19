import { describe, expect, it } from "vitest";
import {
  NEEDS_REVIEW_WHERE,
  PENDING_NOTE_WHERE,
  countPendingForReview,
  pendingNoteText,
  transferKindOf,
  transferVisibilityWhere,
} from "@/lib/transactions-list-filter";
import { accountTransactionsHref } from "@/lib/account-links";

describe("transferVisibilityWhere", () => {
  it("hides paired and one-sided legs without an account filter", () => {
    expect(transferVisibilityWhere(false)).toEqual({ transferPairId: null, ownTransferAccountId: null });
  });
  it("includes them in the per-account view", () => {
    expect(transferVisibilityWhere(true)).toEqual({});
  });
});

describe("review and pending wheres", () => {
  it("Needs Review: untagged, not paired, not marked, posted", () => {
    expect(NEEDS_REVIEW_WHERE).toEqual({
      tags: { none: {} },
      transferPairId: null,
      ownTransferAccountId: null,
      pending: false,
    });
  });
  it("pending note: the same but pending", () => {
    expect(PENDING_NOTE_WHERE).toEqual({ ...NEEDS_REVIEW_WHERE, pending: true });
  });
});

describe("transferKindOf", () => {
  it("paired wins over one-sided; neither is null", () => {
    expect(transferKindOf({ transferPairId: "p", ownTransferAccountId: "a" })).toBe("paired");
    expect(transferKindOf({ transferPairId: null, ownTransferAccountId: "a" })).toBe("one_sided");
    expect(transferKindOf({ transferPairId: null, ownTransferAccountId: null })).toBeNull();
  });
});

describe("pendingNoteText", () => {
  it("is omitted at 0 and singular/plural otherwise", () => {
    expect(pendingNoteText(0)).toBeNull();
    expect(pendingNoteText(1)).toBe("1 pending transaction will appear here once it posts");
    expect(pendingNoteText(3)).toBe("3 pending transactions will appear here once they post");
  });
});

describe("countPendingForReview", () => {
  const maskMap = new Map([
    ["2566", "chk"],
    ["3612", "slush"],
    ["8815", "sav"],
  ]);
  it("leaves out pending rows whose label validates to ANOTHER household account with an agreeing sign", () => {
    const n = countPendingForReview(
      [
        { id: "own", accountId: "chk", payeeRaw: "Online  Xfer Transfer to CK x3612", amount: "-5.00" }, // left out
        { id: "alias", accountId: "chk", payeeRaw: "Online Xfer Transfer to SV x8815", amount: "-10.00" }, // left out
        { id: "unres", accountId: "chk", payeeRaw: "Online Xfer Transfer to CK x0000", amount: "-5.00" }, // counted
        { id: "self", accountId: "chk", payeeRaw: "Online Xfer Transfer to CK x2566", amount: "-5.00" }, // counted
        { id: "sign", accountId: "chk", payeeRaw: "Online Xfer Transfer to CK x3612", amount: "5.00" }, // counted
        { id: "shop", accountId: "chk", payeeRaw: "STOP & SHOP", amount: "-40.00" }, // counted
        { id: "null", accountId: "chk", payeeRaw: null, amount: "-1.00" }, // counted
      ],
      maskMap
    );
    expect(n).toBe(5);
  });
});

describe("accountTransactionsHref", () => {
  it("opens the account's OWN entity bucket, tab=all, with the account filter", () => {
    expect(accountTransactionsHref({ id: "acc-1", entitySlug: "ek-consulting" })).toBe(
      "/transactions?bucket=ek-consulting&tab=all&accountId=acc-1"
    );
  });
  it("falls back to the all-entities bucket when the entity has no slug", () => {
    expect(accountTransactionsHref({ id: "acc-2", entitySlug: null })).toBe(
      "/transactions?bucket=taxes&tab=all&accountId=acc-2"
    );
  });
  it("URL-encodes the parameters", () => {
    expect(accountTransactionsHref({ id: "a b&c", entitySlug: "x/y" })).toBe(
      "/transactions?bucket=x%2Fy&tab=all&accountId=a+b%26c"
    );
  });
});
