import { describe, it, expect } from "vitest";
import { findDuplicateGroups, type DedupeTxRow } from "@/lib/dedupe";

function d(iso: string) {
  return new Date(iso + "T00:00:00Z");
}

let seq = 0;
function tx(overrides: Partial<DedupeTxRow> & Pick<DedupeTxRow, "accountId" | "amount">): DedupeTxRow {
  seq++;
  return {
    id: overrides.id ?? `tx-${seq}`,
    accountId: overrides.accountId,
    entityId: overrides.entityId ?? "entity-1",
    postedAt: overrides.postedAt ?? d("2026-08-15"),
    amount: overrides.amount,
    payeeNormalized: overrides.payeeNormalized ?? "coffee shop",
    transferPairId: overrides.transferPairId ?? null,
  };
}

describe("findDuplicateGroups", () => {
  it("groups exact matches: same account, date, amount, payee", () => {
    const rows = [
      tx({ id: "a", accountId: "acct1", amount: "-12.50" }),
      tx({ id: "b", accountId: "acct1", amount: "-12.50" }),
      tx({ id: "c", accountId: "acct1", amount: "-12.50" }),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.keep.id).toBe("a");
    expect(groups[0]!.duplicates.map((x) => x.id)).toEqual(["b", "c"]);
  });

  it("keeps one when amounts differ by a cent", () => {
    const rows = [
      tx({ accountId: "acct1", amount: "-12.50" }),
      tx({ accountId: "acct1", amount: "-12.51" }),
    ];
    expect(findDuplicateGroups(rows)).toHaveLength(0);
  });

  it("keeps one when the date differs", () => {
    const rows = [
      tx({ accountId: "acct1", amount: "-12.50", postedAt: d("2026-08-15") }),
      tx({ accountId: "acct1", amount: "-12.50", postedAt: d("2026-08-16") }),
    ];
    expect(findDuplicateGroups(rows)).toHaveLength(0);
  });

  it("keeps one when the account differs (same day, amount, payee)", () => {
    const rows = [
      tx({ accountId: "acct1", amount: "-12.50" }),
      tx({ accountId: "acct2", amount: "-12.50" }),
    ];
    expect(findDuplicateGroups(rows)).toHaveLength(0);
  });

  it("keeps one when the payee differs", () => {
    const rows = [
      tx({ accountId: "acct1", amount: "-12.50", payeeNormalized: "coffee shop" }),
      tx({ accountId: "acct1", amount: "-12.50", payeeNormalized: "grocery store" }),
    ];
    expect(findDuplicateGroups(rows)).toHaveLength(0);
  });

  it("skips transfer legs entirely — matched pairs are legitimate", () => {
    const rows = [
      tx({ accountId: "acct1", amount: "-500.00", transferPairId: "pair-1" }),
      tx({ accountId: "acct2", amount: "500.00", transferPairId: "pair-1" }),
      // Two identical transfer legs on the same account still get skipped
      tx({ accountId: "acct1", amount: "-500.00", transferPairId: "pair-2" }),
    ];
    expect(findDuplicateGroups(rows)).toHaveLength(0);
  });

  it("matches by posted DATE, not timestamp — same day different time is still a duplicate", () => {
    const rows = [
      tx({ accountId: "acct1", amount: "-12.50", postedAt: new Date("2026-08-15T02:00:00Z") }),
      tx({ accountId: "acct1", amount: "-12.50", postedAt: new Date("2026-08-15T18:30:00Z") }),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups).toHaveLength(1);
  });

  it("handles null payeeNormalized consistently", () => {
    const rows = [
      tx({ accountId: "acct1", amount: "-12.50", payeeNormalized: null }),
      tx({ accountId: "acct1", amount: "-12.50", payeeNormalized: null }),
    ];
    expect(findDuplicateGroups(rows)).toHaveLength(1);
  });

  it("handles multiple independent duplicate groups", () => {
    const rows = [
      tx({ id: "a1", accountId: "acct1", amount: "-12.50", payeeNormalized: "coffee" }),
      tx({ id: "a2", accountId: "acct1", amount: "-12.50", payeeNormalized: "coffee" }),
      tx({ id: "b1", accountId: "acct1", amount: "-60.00", payeeNormalized: "gas station" }),
      tx({ id: "b2", accountId: "acct1", amount: "-60.00", payeeNormalized: "gas station" }),
      tx({ id: "b3", accountId: "acct1", amount: "-60.00", payeeNormalized: "gas station" }),
      tx({ id: "c1", accountId: "acct1", amount: "-1.00", payeeNormalized: "unique" }),
    ];
    const groups = findDuplicateGroups(rows);
    expect(groups).toHaveLength(2);
    const coffee = groups.find((g) => g.keep.id === "a1")!;
    expect(coffee.duplicates.map((x) => x.id)).toEqual(["a2"]);
    const gas = groups.find((g) => g.keep.id === "b1")!;
    expect(gas.duplicates.map((x) => x.id)).toEqual(["b2", "b3"]);
  });
});