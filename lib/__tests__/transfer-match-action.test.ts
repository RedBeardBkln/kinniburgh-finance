import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  order: [] as string[],
  auth: vi.fn(),
  setAppSetting: vi.fn(),
  run: vi.fn(),
  owner: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: m.auth }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/settings", () => ({ setAppSetting: m.setAppSetting }));
vi.mock("@/lib/tax-year-close-owner", () => ({ resolveCloserForUser: m.owner }));
vi.mock("@/lib/transfer-match-runner", () => ({
  ONE_SIDED_SETTING_KEY: "transfer_one_sided_enabled",
  runTransferMatchingEngine: m.run,
}));

import { runTransferMatchingNow } from "@/actions/transfer-match";

beforeEach(() => {
  m.order.length = 0;
  m.auth.mockReset().mockImplementation(async () => {
    m.order.push("auth");
    return { user: { id: "u1" } };
  });
  m.setAppSetting.mockReset().mockImplementation(async () => {
    m.order.push("setting");
  });
  m.owner.mockReset().mockImplementation(async () => {
    m.order.push("owner");
    return { allowed: true, ownerName: "Eric Kinniburgh", reason: null };
  });
  m.run.mockReset().mockImplementation(async () => {
    m.order.push("run");
    return { matchedPairs: 0 };
  });
});

describe("runTransferMatchingNow", () => {
  it("owner: authenticates first, checks the owner, then switches the gate on, then runs the one-sided pass", async () => {
    await runTransferMatchingNow();
    expect(m.order).toEqual(["auth", "owner", "setting", "run"]);
    expect(m.owner).toHaveBeenCalledWith("u1");
    expect(m.setAppSetting).toHaveBeenCalledWith("transfer_one_sided_enabled", "1");
    expect(m.run).toHaveBeenCalledWith("manual", { oneSided: "run" });
  });

  it("non-owner (e.g. Eva): pairing only, no setting write, engine called with its default and no options", async () => {
    m.owner.mockResolvedValue({ allowed: false, ownerName: "Eric Kinniburgh", reason: "Only the owner's account can do this." });
    await expect(runTransferMatchingNow()).resolves.toEqual({ matchedPairs: 0 });
    expect(m.setAppSetting).not.toHaveBeenCalled();
    expect(m.run).toHaveBeenCalledTimes(1);
    expect(m.run.mock.calls[0]).toEqual(["manual"]);
  });

  it("failed owner lookup (allowed: false with a reason): same as a non-owner, no throw", async () => {
    m.owner.mockResolvedValue({
      allowed: false,
      ownerName: null,
      reason: "The owner's account could not be checked just now. Try again shortly.",
    });
    await expect(runTransferMatchingNow()).resolves.toBeDefined();
    expect(m.setAppSetting).not.toHaveBeenCalled();
    expect(m.run.mock.calls[0]).toEqual(["manual"]);
  });

  it("unauthenticated: throws with no setting write and no engine call", async () => {
    m.auth.mockResolvedValue(null);
    await expect(runTransferMatchingNow()).rejects.toThrow("Unauthorized");
    expect(m.setAppSetting).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
    expect(m.owner).not.toHaveBeenCalled();
  });
});

describe("app/envelope/page.tsx: the first owner run has room to finish", () => {
  it("exports maxDuration = 60", () => {
    expect(readFileSync(join(process.cwd(), "app/envelope/page.tsx"), "utf8")).toMatch(/^export const maxDuration = 60;$/m);
  });
});

describe("the cron and the Plaid sync keep the default (gated) one-sided mode", () => {
  const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");
  it("cron calls the engine without options and never sets the flag", () => {
    const src = read("app/api/cron/plaid-sync/route.ts");
    expect(src).toMatch(/runTransferMatchingEngine\("cron"\)/);
    expect(src).not.toMatch(/oneSided: "run"/);
    expect(src).not.toMatch(/transfer_one_sided_enabled|ONE_SIDED_SETTING_KEY/);
  });
  it("syncEntityPlaidAccounts calls the engine without options and never sets the flag", () => {
    const src = read("actions/plaid-sync.ts");
    expect(src).toMatch(/runTransferMatchingEngine\("manual"\)/);
    expect(src).not.toMatch(/oneSided: "run"/);
    expect(src).not.toMatch(/transfer_one_sided_enabled|ONE_SIDED_SETTING_KEY/);
  });
  it("the cron's one-sided log line is counts only", () => {
    const src = read("app/api/cron/plaid-sync/route.ts");
    const line = src.split(/\r?\n/).find((l) => l.includes("one-sided own transfer"));
    expect(line).toBeDefined();
    expect(line).not.toMatch(/payee|mask|txId|accountId/);
  });
});
