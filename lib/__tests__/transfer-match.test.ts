import { describe, it, expect } from "vitest";
import { decimalSign, matchTransferLegs, parseTransferLeg, type TransferLegCandidate } from "@/lib/transfer-match";

const PRIMARY = "acct-primary-checking"; // x2566
const HEATING = "acct-heating-electric"; // x2540
const MORTGAGE = "acct-mortgage-insurance"; // x2558
const SLUSH = "acct-slush-funds"; // x3612

const MASK_TO_ACCOUNT = new Map<string, string>([
  ["2566", PRIMARY],
  ["2540", HEATING],
  ["2558", MORTGAGE],
  ["3612", SLUSH],
]);

function d(iso: string) {
  return new Date(iso + "T00:00:00Z");
}

let seq = 0;
function leg(overrides: Partial<TransferLegCandidate> & Pick<TransferLegCandidate, "accountId" | "amount" | "payeeRaw">): TransferLegCandidate {
  seq++;
  return {
    id: overrides.id ?? `tx-${seq}`,
    accountId: overrides.accountId,
    postedAt: overrides.postedAt ?? d("2026-09-01"),
    amount: overrides.amount,
    payeeRaw: overrides.payeeRaw,
  };
}

describe("parseTransferLeg", () => {
  it("parses an outgoing leg", () => {
    expect(parseTransferLeg("Online Xfer Transfer to CK x2540")).toEqual({
      direction: "to",
      mask: "2540",
    });
  });

  it("parses an incoming leg", () => {
    expect(parseTransferLeg("Online Xfer Transfer from CK x2566")).toEqual({
      direction: "from",
      mask: "2566",
    });
  });

  it("parses an SV-coded leg (generic letter code, not hardcoded)", () => {
    expect(parseTransferLeg("Online Xfer Transfer to SV x8815")).toEqual({
      direction: "to",
      mask: "8815",
    });
  });

  it("returns null for non-transfer-shaped payees", () => {
    expect(parseTransferLeg("Amazon.com")).toBeNull();
    expect(parseTransferLeg("Online Xfer Transfer to CK x123")).toBeNull(); // 3-digit mask
    expect(parseTransferLeg("Online Xfer Transfer sideways CK x2540")).toBeNull();
  });
});

describe("matchTransferLegs", () => {
  it("pairs a real happy-path outgoing/incoming leg", () => {
    const candidates = [
      leg({ id: "out-256", accountId: PRIMARY, amount: "-256.00", payeeRaw: "Online Xfer Transfer to CK x2540" }),
      leg({ id: "in-256", accountId: HEATING, amount: "256.00", payeeRaw: "Online Xfer Transfer from CK x2566" }),
    ];
    const { pairs, unmatched } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(unmatched).toEqual([]);
    expect(pairs).toEqual([
      { outgoingTxId: "out-256", incomingTxId: "in-256", fromAccountId: PRIMARY, toAccountId: HEATING },
    ]);
  });

  it("leaves the real unresolvable-mask row (SV x8815) completely alone", () => {
    const candidates = [
      leg({ id: "unresolvable", accountId: PRIMARY, amount: "-10.00", payeeRaw: "Online Xfer Transfer to SV x8815" }),
    ];
    const { pairs, unmatched } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(pairs).toEqual([]);
    expect(unmatched).toEqual([{ txId: "unresolvable", reason: "unresolvable_mask" }]);
  });

  it("resolves the real same-day/same-amount $2350 collision into two independent pairs, never cross-linked", () => {
    const candidates = [
      leg({ id: "out-a", accountId: PRIMARY, amount: "-2350.00", payeeRaw: "Online Xfer Transfer to CK x2558", postedAt: d("2026-09-15") }),
      leg({ id: "out-b", accountId: PRIMARY, amount: "-2350.00", payeeRaw: "Online Xfer Transfer to CK x2558", postedAt: d("2026-09-15") }),
      leg({ id: "in-a", accountId: MORTGAGE, amount: "2350.00", payeeRaw: "Online Xfer Transfer from CK x2566", postedAt: d("2026-09-15") }),
      leg({ id: "in-b", accountId: MORTGAGE, amount: "2350.00", payeeRaw: "Online Xfer Transfer from CK x2566", postedAt: d("2026-09-15") }),
    ];
    const { pairs, unmatched } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(unmatched).toEqual([]);
    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual([
      { outgoingTxId: "out-a", incomingTxId: "in-a", fromAccountId: PRIMARY, toAccountId: MORTGAGE },
      { outgoingTxId: "out-b", incomingTxId: "in-b", fromAccountId: PRIMARY, toAccountId: MORTGAGE },
    ]);
  });

  it("leaves the extra leg unmatched (no_counterpart) on an uneven 2-vs-1 collision", () => {
    const candidates = [
      leg({ id: "out-a", accountId: PRIMARY, amount: "-2350.00", payeeRaw: "Online Xfer Transfer to CK x2558", postedAt: d("2026-09-15") }),
      leg({ id: "out-b", accountId: PRIMARY, amount: "-2350.00", payeeRaw: "Online Xfer Transfer to CK x2558", postedAt: d("2026-09-15") }),
      leg({ id: "in-a", accountId: MORTGAGE, amount: "2350.00", payeeRaw: "Online Xfer Transfer from CK x2566", postedAt: d("2026-09-15") }),
    ];
    const { pairs, unmatched } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(pairs).toEqual([
      { outgoingTxId: "out-a", incomingTxId: "in-a", fromAccountId: PRIMARY, toAccountId: MORTGAGE },
    ]);
    expect(unmatched).toEqual([{ txId: "out-b", reason: "no_counterpart" }]);
  });

  it("does not pair legs with mismatched amounts (same day, same account pair)", () => {
    const candidates = [
      leg({ id: "out-150", accountId: PRIMARY, amount: "-150.00", payeeRaw: "Online Xfer Transfer to CK x3612" }),
      leg({ id: "in-149", accountId: SLUSH, amount: "149.00", payeeRaw: "Online Xfer Transfer from CK x2566" }),
    ];
    const { pairs, unmatched } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(pairs).toEqual([]);
    expect(unmatched.map((u) => u.txId).sort()).toEqual(["in-149", "out-150"]);
    expect(unmatched.every((u) => u.reason === "no_counterpart")).toBe(true);
  });

  it("does not pair legs with mismatched dates (same account pair, same amount)", () => {
    const candidates = [
      leg({ id: "out-1", accountId: PRIMARY, amount: "-150.00", payeeRaw: "Online Xfer Transfer to CK x3612", postedAt: d("2026-09-01") }),
      leg({ id: "in-1", accountId: SLUSH, amount: "150.00", payeeRaw: "Online Xfer Transfer from CK x2566", postedAt: d("2026-09-02") }),
    ];
    const { pairs, unmatched } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(pairs).toEqual([]);
    expect(unmatched.map((u) => u.txId).sort()).toEqual(["in-1", "out-1"]);
  });

  it("ignores non-transfer-shaped payees entirely, not as unmatched", () => {
    const candidates = [
      leg({ id: "grocery", accountId: PRIMARY, amount: "-45.12", payeeRaw: "Whole Foods Market" }),
    ];
    const { pairs, unmatched } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(pairs).toEqual([]);
    expect(unmatched).toEqual([]);
  });
});

// ── transactions-transfer-hiding: normalization, self mask, sign check, one-sided legs ──────────────────────────────
describe("matchTransferLegs: historical labels, self masks, signs and one-sided legs", () => {
  const SAVINGS = "acct-savings"; // current mask 3950, former mask 8815 (owner statement 2026-10-19)

  it("pairs a double-space imported leg with a single-space Plaid leg (the real Apr 2026 shape)", () => {
    const candidates = [
      leg({ id: "imp", accountId: PRIMARY, amount: "-100.00", payeeRaw: "Online  Xfer Transfer to CK x3612", postedAt: d("2026-04-06") }),
      leg({ id: "pl", accountId: SLUSH, amount: "100.00", payeeRaw: "Online Xfer Transfer from CK x2566", postedAt: d("2026-04-06") }),
    ];
    const { pairs, unmatched, oneSided } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(pairs).toEqual([{ outgoingTxId: "imp", incomingTxId: "pl", fromAccountId: PRIMARY, toAccountId: SLUSH }]);
    expect(unmatched).toEqual([]);
    expect(oneSided).toEqual([]);
  });

  it("tolerates tabs and leading/trailing whitespace", () => {
    const candidates = [
      leg({ id: "o", accountId: PRIMARY, amount: "-5.00", payeeRaw: "  Online\tXfer  Transfer to CK  x3612 " }),
      leg({ id: "i", accountId: SLUSH, amount: "5.00", payeeRaw: "Online Xfer\t\tTransfer from CK x2566\n" }),
    ];
    expect(matchTransferLegs(candidates, MASK_TO_ACCOUNT).pairs).toHaveLength(1);
  });

  it("parseTransferLeg itself stays strict about inner whitespace", () => {
    expect(parseTransferLeg("Online  Xfer Transfer to CK x3612")).toBeNull();
  });

  it("a mask naming the row's own account is unresolvable (never paired, never one-sided)", () => {
    const { pairs, unmatched, oneSided } = matchTransferLegs(
      [leg({ id: "self", accountId: PRIMARY, amount: "-5.00", payeeRaw: "Online Xfer Transfer to CK x2566" })],
      MASK_TO_ACCOUNT
    );
    expect(pairs).toEqual([]);
    expect(unmatched).toEqual([{ txId: "self", reason: "unresolvable_mask" }]);
    expect(oneSided).toEqual([]);
  });

  it("reports a direction/sign disagreement in both directions, and zero, as sign_mismatch", () => {
    const { pairs, unmatched, oneSided } = matchTransferLegs(
      [
        leg({ id: "to-pos", accountId: PRIMARY, amount: "10.00", payeeRaw: "Online Xfer Transfer to CK x3612" }),
        leg({ id: "from-neg", accountId: SLUSH, amount: "-10.00", payeeRaw: "Online Xfer Transfer from CK x2566" }),
        leg({ id: "zero", accountId: PRIMARY, amount: "0.00", payeeRaw: "Online Xfer Transfer to CK x3612" }),
        leg({ id: "negzero", accountId: SLUSH, amount: "-0.00", payeeRaw: "Online Xfer Transfer from CK x2566" }),
      ],
      MASK_TO_ACCOUNT
    );
    expect(pairs).toEqual([]);
    expect(unmatched.map((u) => [u.txId, u.reason]).sort()).toEqual([
      ["from-neg", "sign_mismatch"],
      ["negzero", "sign_mismatch"],
      ["to-pos", "sign_mismatch"],
      ["zero", "sign_mismatch"],
    ]);
    expect(oneSided).toEqual([]);
  });

  it("returns a no-counterpart leg as one-sided with the account the label names", () => {
    const { unmatched, oneSided } = matchTransferLegs(
      [
        leg({ id: "out", accountId: PRIMARY, amount: "-20.00", payeeRaw: "Online  Xfer Transfer to CK x2558" }),
        leg({ id: "in", accountId: SLUSH, amount: "30.00", payeeRaw: "Online Xfer Transfer from CK x2540" }),
      ],
      MASK_TO_ACCOUNT
    );
    expect(unmatched.every((u) => u.reason === "no_counterpart")).toBe(true);
    expect(oneSided.sort((a, b) => a.txId.localeCompare(b.txId))).toEqual([
      { txId: "in", counterpartAccountId: HEATING, direction: "from" },
      { txId: "out", counterpartAccountId: MORTGAGE, direction: "to" },
    ]);
  });

  it("an uneven 2-vs-1 leftover is one-sided (signs agree), a wrong-sign extra is not", () => {
    const candidates = [
      leg({ id: "out-a", accountId: PRIMARY, amount: "-50.00", payeeRaw: "Online Xfer Transfer to CK x3612" }),
      leg({ id: "out-b", accountId: PRIMARY, amount: "-50.00", payeeRaw: "Online Xfer Transfer to CK x3612" }),
      leg({ id: "out-c", accountId: PRIMARY, amount: "50.00", payeeRaw: "Online Xfer Transfer to CK x3612" }),
      leg({ id: "in-a", accountId: SLUSH, amount: "50.00", payeeRaw: "Online Xfer Transfer from CK x2566" }),
    ];
    const { pairs, unmatched, oneSided } = matchTransferLegs(candidates, MASK_TO_ACCOUNT);
    expect(pairs).toHaveLength(1);
    expect(oneSided).toEqual([{ txId: "out-b", counterpartAccountId: SLUSH, direction: "to" }]);
    expect(unmatched.find((u) => u.txId === "out-c")?.reason).toBe("sign_mismatch");
  });

  it("the weekly 'to SV x8815' leg is one-sided to Savings with the alias map, unresolvable without it", () => {
    const weekly = leg({ id: "wk", accountId: PRIMARY, amount: "-10.00", payeeRaw: "Online  Xfer Transfer to SV x8815" });
    const withAlias = new Map([...MASK_TO_ACCOUNT, ["3950", SAVINGS], ["8815", SAVINGS]]);
    expect(matchTransferLegs([weekly], withAlias).oneSided).toEqual([
      { txId: "wk", counterpartAccountId: SAVINGS, direction: "to" },
    ]);
    const without = matchTransferLegs([weekly], MASK_TO_ACCOUNT);
    expect(without.unmatched).toEqual([{ txId: "wk", reason: "unresolvable_mask" }]);
    expect(without.oneSided).toEqual([]);
  });
});

describe("decimalSign", () => {
  it("reads the sign of a decimal string without float maths", () => {
    expect(decimalSign("-10.00")).toBe(-1);
    expect(decimalSign("10.00")).toBe(1);
    expect(decimalSign("+0.01")).toBe(1);
    expect(decimalSign("0")).toBe(0);
    expect(decimalSign("-0.00")).toBe(0);
    expect(decimalSign("abc")).toBeNull();
    expect(decimalSign("")).toBeNull();
    expect(decimalSign("-")).toBeNull();
  });
});
