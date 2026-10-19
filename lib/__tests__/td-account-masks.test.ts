import { describe, expect, it } from "vitest";
import { buildTdMaskMap, TD_FORMER_MASK_ALIASES } from "@/lib/td-account-masks";

const sorted = (m: Map<string, string>) => [...m.entries()].sort();

describe("TD_FORMER_MASK_ALIASES", () => {
  it("holds exactly the one owner-stated alias (8815 -> 3950), citing the 2026-10-19 statement", () => {
    expect(TD_FORMER_MASK_ALIASES).toHaveLength(1);
    expect(TD_FORMER_MASK_ALIASES[0]!.formerMask).toBe("8815");
    expect(TD_FORMER_MASK_ALIASES[0]!.currentMask).toBe("3950");
    expect(TD_FORMER_MASK_ALIASES[0]!.source).toMatch(/Owner statement 2026-10-19/);
    expect(TD_FORMER_MASK_ALIASES[0]!.source).toMatch(/Savings/);
  });
});

describe("buildTdMaskMap", () => {
  it("maps current masks and the former mask 8815 to the single 3950 account", () => {
    const m = buildTdMaskMap([
      { id: "sav", mask: "3950" },
      { id: "chk", mask: "2566" },
      { id: "nomask", mask: null },
    ]);
    expect(sorted(m)).toEqual([
      ["2566", "chk"],
      ["3950", "sav"],
      ["8815", "sav"],
    ]);
  });

  it("ignores the alias when no active account has mask 3950", () => {
    expect(sorted(buildTdMaskMap([{ id: "chk", mask: "2566" }]))).toEqual([["2566", "chk"]]);
  });

  it("ignores the alias (and drops 3950) when 3950 is ambiguous", () => {
    const m = buildTdMaskMap([
      { id: "a", mask: "3950" },
      { id: "b", mask: "3950" },
    ]);
    expect(m.size).toBe(0);
  });

  it("drops 8815 entirely when an active account's CURRENT mask is 8815", () => {
    const m = buildTdMaskMap([
      { id: "sav", mask: "3950" },
      { id: "other", mask: "8815" },
    ]);
    expect(sorted(m)).toEqual([["3950", "sav"]]);
  });

  it("drops any current mask held by two or more accounts", () => {
    const m = buildTdMaskMap([
      { id: "a", mask: "1111" },
      { id: "b", mask: "1111" },
      { id: "c", mask: "2222" },
    ]);
    expect(sorted(m)).toEqual([["2222", "c"]]);
  });

  it("drops a former mask that two aliases point at different accounts", () => {
    const aliases = [
      { formerMask: "9999", currentMask: "1111", source: "test" },
      { formerMask: "9999", currentMask: "2222", source: "test" },
    ];
    const m = buildTdMaskMap(
      [
        { id: "a", mask: "1111" },
        { id: "b", mask: "2222" },
      ],
      aliases
    );
    expect(sorted(m)).toEqual([
      ["1111", "a"],
      ["2222", "b"],
    ]);
  });

  it("two aliases with the same former mask and the same target are kept", () => {
    const aliases = [
      { formerMask: "9999", currentMask: "1111", source: "test" },
      { formerMask: "9999", currentMask: "1111", source: "test" },
    ];
    expect(buildTdMaskMap([{ id: "a", mask: "1111" }], aliases).get("9999")).toBe("a");
  });
});
