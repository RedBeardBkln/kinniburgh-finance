import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findMany: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { account: { findMany: mocks.findMany } } }));

import { loadOwnAccountByMask, TD_BANK_INSTITUTION_NAME } from "@/lib/own-account-masks-build";
import { buildMonthSpend } from "@/lib/month-spend";
import { D, TAGS, resetSeq, tx } from "./month-spend-fixtures";

describe("loadOwnAccountByMask", () => {
  beforeEach(() => {
    mocks.findMany.mockReset();
  });

  it("reads only active accounts, selecting nothing but id and mask", async () => {
    mocks.findMany.mockResolvedValue([]);
    await loadOwnAccountByMask();
    expect(mocks.findMany).toHaveBeenCalledTimes(1);
    const arg = mocks.findMany.mock.calls[0]![0];
    expect(arg.where).toEqual({ archivedAt: null, institution: { name: "TD Bank" } });
    expect(arg.select).toEqual({ id: true, mask: true });
  });

  it("maps each mask to its one account, ignoring accounts without a mask", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "a", mask: "1111" },
      { id: "b", mask: "2222" },
      { id: "c", mask: null },
    ]);
    const m = await loadOwnAccountByMask();
    expect([...m.entries()].sort()).toEqual([
      ["1111", "a"],
      ["2222", "b"],
    ]);
  });

  it("drops a mask shared by two active accounts (ambiguous: never classify by it)", async () => {
    mocks.findMany.mockResolvedValue([
      { id: "a", mask: "1111" },
      { id: "b", mask: "1111" },
      { id: "c", mask: "3333" },
      { id: "d", mask: "1111" },
    ]);
    const m = await loadOwnAccountByMask();
    expect([...m.keys()]).toEqual(["3333"]);
  });
});

describe("scope: the mask map belongs to the institution whose wording the label is (TD Bank)", () => {
  it("uses the same institution name as the TD matcher", () => {
    const runner = readFileSync(join(process.cwd(), "lib/transfer-match-runner.ts"), "utf8");
    expect(runner).toContain(`name: "${TD_BANK_INSTITUTION_NAME}"`);
    expect(TD_BANK_INSTITUTION_NAME).toBe("TD Bank");
  });

  it("a TD transfer whose last four digits equal a NON-TD household account's mask is not excluded", async () => {
    const accounts = [
      { id: "td-1", mask: "1111", institution: "TD Bank" },
      { id: "cu-1", mask: "5555", institution: "CorePlus Credit Union" },
      { id: "qb-1", mask: "6666", institution: "QuickBooks/Green Dot" },
    ];
    mocks.findMany.mockImplementation(async (arg: { where: { institution: { name: string } } }) =>
      accounts.filter((a) => a.institution === arg.where.institution.name).map(({ id, mask }) => ({ id, mask }))
    );
    const masks = await loadOwnAccountByMask();
    expect([...masks.keys()]).toEqual(["1111"]);

    resetSeq(5000);
    const m = buildMonthSpend(
      [
        tx({ amount: "-80", payee: "Online Xfer Transfer to CK x5555", accountId: "td-9" }), // foreign TD transfer; 5555 is a credit union account here
        tx({ amount: "-70", payee: "Online Xfer Transfer to CK x6666", accountId: "td-9" }),
        tx({ amount: "-20", payee: "Online Xfer Transfer to CK x1111", accountId: "td-9" }), // a real own TD account
      ],
      TAGS,
      [],
      { ownAccountByMask: masks }
    );
    expect(m.spent.toFixed(2)).toBe("150.00");
    expect(m.excluded.find((g) => g.cls === "own_transfer")?.count).toBe(1);
    void D;
  });
});
