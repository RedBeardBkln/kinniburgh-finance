import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked at the db boundary: no database is contacted.
const m = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  txFindMany: vi.fn(),
  txUpdate: vi.fn(),
  txUpdateMany: vi.fn(),
  tagCreateMany: vi.fn(),
  tagFindFirst: vi.fn(),
  scheduleFindMany: vi.fn(),
  settingFindUnique: vi.fn(),
  txTxUpdateMany: vi.fn(),
  txTagCreateMany: vi.fn(),
  transaction: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    account: { findMany: m.accountFindMany },
    transaction: { findMany: m.txFindMany, update: m.txUpdate, updateMany: m.txUpdateMany },
    transactionTag: { createMany: m.tagCreateMany },
    tag: { findFirst: m.tagFindFirst },
    scheduledTransfer: { findMany: m.scheduleFindMany },
    appSetting: { findUnique: m.settingFindUnique },
    $transaction: m.transaction,
  },
}));

import { ONE_SIDED_SETTING_KEY, runTransferMatchingEngine } from "@/lib/transfer-match-runner";

const PRIMARY = "acc-primary"; // 2566
const SLUSH = "acc-slush"; // 3612
const SAVINGS = "acc-savings"; // 3950 (former 8815)
const OUT_TAG = { id: "tag-out", name: "Transfer Out" };
const IN_TAG = { id: "tag-in", name: "Transfer In" };

interface Row {
  id: string;
  accountId: string;
  postedAt: Date;
  amount: { toString(): string };
  payeeRaw: string;
  ownTransferAccountId: string | null;
  tags: { tagId: string }[];
}

function row(o: Partial<Row> & Pick<Row, "id" | "accountId" | "payeeRaw"> & { amount: string }): Row {
  const amt = o.amount;
  return {
    postedAt: new Date("2026-04-06T00:00:00Z"),
    ownTransferAccountId: null,
    tags: [],
    ...o,
    amount: { toString: () => amt },
  };
}

let candidates: Row[] = [];
let unlinkedLegs: { id: string; accountId: string; amount: string; transferPairId: string }[] = [];

beforeEach(() => {
  for (const f of Object.values(m)) f.mockReset();
  candidates = [];
  unlinkedLegs = [];
  m.accountFindMany.mockResolvedValue([
    { id: PRIMARY, mask: "2566" },
    { id: SLUSH, mask: "3612" },
    { id: SAVINGS, mask: "3950" },
  ]);
  m.txFindMany.mockImplementation(async (arg: { where: { transferPairId: unknown } }) =>
    arg.where.transferPairId === null ? candidates : unlinkedLegs
  );
  m.scheduleFindMany.mockResolvedValue([]);
  m.tagFindFirst.mockImplementation(async (arg: { where: { name: string } }) =>
    arg.where.name === "Transfer Out" ? OUT_TAG : arg.where.name === "Transfer In" ? IN_TAG : null
  );
  m.settingFindUnique.mockResolvedValue(null);
  m.txUpdate.mockImplementation((arg: unknown) => ({ op: "update", arg }));
  m.tagCreateMany.mockImplementation((arg: unknown) => ({ op: "createMany", arg }));
  m.txUpdateMany.mockResolvedValue({ count: 0 });
  m.txTxUpdateMany.mockResolvedValue({ count: 1 });
  m.txTagCreateMany.mockResolvedValue({ count: 1 });
  m.transaction.mockImplementation(async (arg: unknown) => {
    if (Array.isArray(arg)) return arg;
    return (arg as (tx: unknown) => Promise<unknown>)({
      transaction: { updateMany: m.txTxUpdateMany },
      transactionTag: { createMany: m.txTagCreateMany },
    });
  });
});

const weeklySavings = () =>
  row({ id: "wk", accountId: PRIMARY, amount: "-10.00", payeeRaw: "Online  Xfer Transfer to SV x8815" });
const inFromSavings = () =>
  row({ id: "in1", accountId: SLUSH, amount: "25.00", payeeRaw: "Online Xfer Transfer from SV x8815" });

describe("runTransferMatchingEngine: candidate query", () => {
  it("has no description condition, keeps pending/archived/pair guards and the TD-only account list", async () => {
    await runTransferMatchingEngine("cron");
    const where = m.txFindMany.mock.calls[0]![0].where;
    expect(where).toEqual({
      archivedAt: null,
      transferPairId: null,
      pending: false,
      AND: [{ payeeRaw: { startsWith: "Online" } }, { payeeRaw: { contains: "Transfer" } }],
      accountId: { in: [PRIMARY, SLUSH, SAVINGS] },
    });
    expect("description" in where).toBe(false);
    expect(m.accountFindMany.mock.calls[0]![0].where).toEqual({ institution: { name: "TD Bank" }, archivedAt: null });
    // the coarse prefilter admits the historical double-space label
    const label = "Online  Xfer Transfer to CK x2558";
    expect(label.startsWith("Online") && label.includes("Transfer")).toBe(true);
  });
});

describe("runTransferMatchingEngine: one-sided gate", () => {
  it("gate off (default, no setting): no marker and no one-sided tag write; ran=false", async () => {
    candidates = [weeklySavings()];
    const s = await runTransferMatchingEngine("cron");
    expect(m.settingFindUnique).toHaveBeenCalledWith({ where: { key: ONE_SIDED_SETTING_KEY } });
    expect(m.txTxUpdateMany).not.toHaveBeenCalled();
    expect(m.txTagCreateMany).not.toHaveBeenCalled();
    expect(m.transaction).not.toHaveBeenCalled();
    expect(s.oneSided).toEqual({ ran: false, marked: 0, tagsAdded: 0, alreadyMarked: 0, alreadyHadOtherTag: 0, tagMissing: 0 });
    expect(s.unmatchedByReason.no_counterpart).toBe(1);
  });

  it("a setting value other than \"1\" is off", async () => {
    candidates = [weeklySavings()];
    m.settingFindUnique.mockResolvedValue({ key: ONE_SIDED_SETTING_KEY, value: "0" });
    expect((await runTransferMatchingEngine("cron")).oneSided.ran).toBe(false);
  });

  it("a failed read of the setting counts as off (pairing still runs)", async () => {
    candidates = [
      row({ id: "o", accountId: PRIMARY, amount: "-5.00", payeeRaw: "Online  Xfer Transfer to CK x3612" }),
      row({ id: "i", accountId: SLUSH, amount: "5.00", payeeRaw: "Online Xfer Transfer from CK x2566" }),
      weeklySavings(),
    ];
    m.settingFindUnique.mockRejectedValue(new Error("db down"));
    const s = await runTransferMatchingEngine("cron");
    expect(s.matchedPairs).toBe(1);
    expect(s.oneSided.ran).toBe(false);
    expect(m.txTxUpdateMany).not.toHaveBeenCalled();
  });

  it("gate on via the setting: marks with a conditional updateMany and tags with skipDuplicates by sign", async () => {
    candidates = [weeklySavings(), inFromSavings()];
    m.settingFindUnique.mockResolvedValue({ key: ONE_SIDED_SETTING_KEY, value: "1" });
    const s = await runTransferMatchingEngine("cron");
    expect(m.txTxUpdateMany).toHaveBeenCalledTimes(2);
    const calls = m.txTxUpdateMany.mock.calls.map((c) => c[0]).sort((a, b) => a.where.id.localeCompare(b.where.id));
    expect(calls).toEqual([
      {
        where: { id: "in1", transferPairId: null, ownTransferAccountId: null, archivedAt: null },
        data: { ownTransferAccountId: SAVINGS },
      },
      {
        where: { id: "wk", transferPairId: null, ownTransferAccountId: null, archivedAt: null },
        data: { ownTransferAccountId: SAVINGS },
      },
    ]);
    const tagCalls = m.txTagCreateMany.mock.calls.map((c) => c[0]);
    expect(tagCalls).toContainEqual({ data: [{ transactionId: "wk", tagId: OUT_TAG.id }], skipDuplicates: true });
    expect(tagCalls).toContainEqual({ data: [{ transactionId: "in1", tagId: IN_TAG.id }], skipDuplicates: true });
    expect(s.oneSided).toEqual({ ran: true, marked: 2, tagsAdded: 2, alreadyMarked: 0, alreadyHadOtherTag: 0, tagMissing: 0 });
  });

  it("oneSided: \"run\" marks without reading the setting", async () => {
    candidates = [weeklySavings()];
    const s = await runTransferMatchingEngine("manual", { oneSided: "run" });
    expect(m.settingFindUnique).not.toHaveBeenCalled();
    expect(s.oneSided.ran).toBe(true);
    expect(s.oneSided.marked).toBe(1);
  });
});

describe("runTransferMatchingEngine: one-sided counts", () => {
  it("already-marked legs are counted and not written again (a re-run marks 0 new rows)", async () => {
    candidates = [{ ...weeklySavings(), ownTransferAccountId: SAVINGS }];
    const s = await runTransferMatchingEngine("manual", { oneSided: "run" });
    expect(m.txTxUpdateMany).not.toHaveBeenCalled();
    expect(s.oneSided).toMatchObject({ ran: true, marked: 0, alreadyMarked: 1, tagsAdded: 0 });
  });

  it("a row already carrying the transfer tag adds 0 tags; another owner tag is counted (never removed)", async () => {
    candidates = [
      { ...weeklySavings(), tags: [{ tagId: OUT_TAG.id }] },
      { ...inFromSavings(), tags: [{ tagId: "tag-owner" }] },
    ];
    m.txTagCreateMany.mockImplementation(async (arg: { data: { transactionId: string }[] }) => ({
      count: arg.data[0]!.transactionId === "wk" ? 0 : 1,
    }));
    const s = await runTransferMatchingEngine("manual", { oneSided: "run" });
    expect(s.oneSided).toMatchObject({ marked: 2, tagsAdded: 1, alreadyHadOtherTag: 1 });
  });

  it("a missing Transfer Out tag still marks, is counted under tagMissing and no tag is created", async () => {
    candidates = [weeklySavings()];
    m.tagFindFirst.mockImplementation(async (arg: { where: { name: string } }) =>
      arg.where.name === "Transfer In" ? IN_TAG : null
    );
    const s = await runTransferMatchingEngine("manual", { oneSided: "run" });
    expect(m.txTxUpdateMany).toHaveBeenCalledTimes(1);
    expect(m.txTagCreateMany).not.toHaveBeenCalled();
    expect(s.oneSided).toMatchObject({ marked: 1, tagsAdded: 0, tagMissing: 1 });
  });

  it("a row changed meanwhile (updateMany count 0) gets no tag and is not counted", async () => {
    candidates = [weeklySavings()];
    m.txTxUpdateMany.mockResolvedValue({ count: 0 });
    const s = await runTransferMatchingEngine("manual", { oneSided: "run" });
    expect(m.txTagCreateMany).not.toHaveBeenCalled();
    expect(s.oneSided.marked).toBe(0);
  });

  it("unresolvable, self-mask and sign-mismatch legs are never marked or tagged", async () => {
    candidates = [
      row({ id: "unres", accountId: PRIMARY, amount: "-5.00", payeeRaw: "Online Xfer Transfer to CK x0000" }),
      row({ id: "self", accountId: PRIMARY, amount: "-5.00", payeeRaw: "Online Xfer Transfer to CK x2566" }),
      row({ id: "sign", accountId: PRIMARY, amount: "5.00", payeeRaw: "Online Xfer Transfer to CK x3612" }),
    ];
    const s = await runTransferMatchingEngine("manual", { oneSided: "run" });
    expect(m.txTxUpdateMany).not.toHaveBeenCalled();
    expect(m.txTagCreateMany).not.toHaveBeenCalled();
    expect(s.unmatchedByReason).toEqual({ unresolvable_mask: 2, sign_mismatch: 1, no_counterpart: 0 });
    expect(s.oneSided.marked).toBe(0);
  });
});

describe("runTransferMatchingEngine: pairing", () => {
  it("pairs the double-space imported leg with its Plaid counterpart and clears any one-sided marker on both legs", async () => {
    candidates = [
      row({ id: "imp", accountId: PRIMARY, amount: "-100.00", payeeRaw: "Online  Xfer Transfer to CK x3612", ownTransferAccountId: SLUSH }),
      row({ id: "pl", accountId: SLUSH, amount: "100.00", payeeRaw: "Online Xfer Transfer from CK x2566" }),
    ];
    const s = await runTransferMatchingEngine("cron");
    expect(s.matchedPairs).toBe(1);
    const updates = m.txUpdate.mock.calls.map((c) => c[0]);
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.data.ownTransferAccountId).toBeNull();
      expect(typeof u.data.transferPairId).toBe("string");
    }
    expect(m.tagCreateMany).toHaveBeenCalledWith({
      data: [
        { transactionId: "imp", tagId: OUT_TAG.id },
        { transactionId: "pl", tagId: IN_TAG.id },
      ],
      skipDuplicates: true,
    });
  });

  it("the retroactive schedule pass is unchanged", async () => {
    m.scheduleFindMany.mockResolvedValue([{ id: "sch", fromAccountId: PRIMARY, toAccountId: SLUSH, createdAt: new Date() }]);
    unlinkedLegs = [
      { id: "a", accountId: PRIMARY, amount: "-50.00", transferPairId: "p1" },
      { id: "b", accountId: SLUSH, amount: "50.00", transferPairId: "p1" },
    ];
    const s = await runTransferMatchingEngine("cron");
    expect(m.txUpdateMany).toHaveBeenCalledWith({ where: { id: { in: ["a", "b"] } }, data: { scheduledTransferId: "sch" } });
    expect(s.retroactivelyLinked).toBe(1);
  });
});

describe("runTransferMatchingEngine: source guards", () => {
  const src = readFileSync(join(process.cwd(), "lib/transfer-match-runner.ts"), "utf8");
  it("never deletes anything", () => {
    expect(src).not.toMatch(/\.delete(Many)?\(/);
  });
  it("logs nothing (counts are returned, never a payee, mask or id)", () => {
    expect(src).not.toMatch(/console\./);
  });
});
