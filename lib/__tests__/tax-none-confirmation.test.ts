import { describe, it, expect } from "vitest";
import {
  NONE_CONFIRMATION_KEYS,
  NONE_CONFIRMATION_KEY_LIST,
  isNoneConfirmed,
} from "@/lib/tax-none-confirmation";
import { TAX_QUESTION_BANK } from "@/lib/tax-guidance";

const q = (key: string, answer: unknown, skippedReason: string | null = null) => ({ key, answer, skippedReason });

describe("isNoneConfirmed", () => {
  it('is true only for the exact answer "none" that is not skipped', () => {
    expect(isNoneConfirmed([q("donations_none", "none")], "donations_none")).toBe(true);
  });

  it('is false for "some", null, a skipped "none", a missing key or a non-string answer', () => {
    expect(isNoneConfirmed([q("donations_none", "some")], "donations_none")).toBe(false);
    expect(isNoneConfirmed([q("donations_none", null)], "donations_none")).toBe(false);
    expect(isNoneConfirmed([q("donations_none", "none", "skipped")], "donations_none")).toBe(false);
    expect(isNoneConfirmed([], "donations_none")).toBe(false);
    expect(isNoneConfirmed([q("other", "none")], "donations_none")).toBe(false);
    expect(isNoneConfirmed([q("donations_none", 0)], "donations_none")).toBe(false);
    expect(isNoneConfirmed([q("donations_none", { none: true })], "donations_none")).toBe(false);
    expect(isNoneConfirmed([q("donations_none", "None")], "donations_none")).toBe(false);
  });
});

describe("NONE_CONFIRMATION_KEYS", () => {
  it("are three keys that exist in the question bank with none/some options", () => {
    expect(NONE_CONFIRMATION_KEY_LIST).toHaveLength(3);
    expect(NONE_CONFIRMATION_KEYS).toEqual({
      donations: "donations_none",
      fixedAssetsEkc: "fixed_assets_ekc",
      fixedAssetsSv: "fixed_assets_sv",
    });
    for (const key of NONE_CONFIRMATION_KEY_LIST) {
      const def = TAX_QUESTION_BANK.find((x) => x.key === key);
      expect(def, key).toBeDefined();
      expect(def!.options?.map((o) => o.value)).toEqual(["none", "some"]);
    }
  });
});
