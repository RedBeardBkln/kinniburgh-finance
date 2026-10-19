// Tester round 2 (transactions-transfer-hiding, B1): runTransferMatchingNow through the REAL owner resolver
// (lib/tax-year-close-owner.ts -> lib/tax-year-close/closer.ts -> lib/tax-review/approver.ts). Only the db, the entity
// lookup, auth, the settings writer and the engine are mocked. No database is contacted.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  session: null as null | { user: { id?: string } },
  users: vi.fn(),
  entity: vi.fn(),
  setAppSetting: vi.fn(),
  run: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: async () => m.session }));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));
vi.mock("@/lib/db", () => ({ db: { user: { findMany: m.users } } }));
vi.mock("@/lib/entity", () => ({ getEntityBySlug: m.entity }));
vi.mock("@/lib/settings", () => ({ setAppSetting: m.setAppSetting }));
vi.mock("@/lib/transfer-match-runner", () => ({
  ONE_SIDED_SETTING_KEY: "transfer_one_sided_enabled",
  runTransferMatchingEngine: m.run,
}));

import { runTransferMatchingNow } from "@/actions/transfer-match";

const ERIC = { id: "u-eric", name: "Eric Kinniburgh" };
const EVA = { id: "u-eva", name: "Eva-Laura Ramirez-Wisiackas" };

beforeEach(() => {
  m.session = { user: { id: ERIC.id } };
  m.users.mockReset().mockResolvedValue([ERIC, EVA]);
  m.entity.mockReset().mockResolvedValue({ id: "ent-ekc", name: "Eric Kinniburgh Consulting, LLC", slug: "ek-consulting" });
  m.setAppSetting.mockReset().mockResolvedValue(undefined);
  m.run.mockReset().mockResolvedValue({ matchedPairs: 0 });
});

const ownerPath = () => {
  expect(m.setAppSetting).toHaveBeenCalledWith("transfer_one_sided_enabled", "1");
  expect(m.run.mock.calls).toEqual([["manual", { oneSided: "run" }]]);
};
const pairingOnly = () => {
  expect(m.setAppSetting).not.toHaveBeenCalled();
  expect(m.run.mock.calls).toEqual([["manual"]]);
};

describe("runTransferMatchingNow with the real owner rule", () => {
  it("Eric (named in the EK Consulting entity): switches the gate on and runs the one-sided pass", async () => {
    await runTransferMatchingNow();
    ownerPath();
  });

  it("Eva: pairing only, no setting write, no throw", async () => {
    m.session = { user: { id: EVA.id } };
    await expect(runTransferMatchingNow()).resolves.toEqual({ matchedPairs: 0 });
    pairingOnly();
  });

  it("ambiguous owner (two users match the entity name): nobody is owner, Eric's click only pairs", async () => {
    m.users.mockResolvedValue([ERIC, EVA, { id: "u-eric2", name: "Eric Kinniburgh" }]);
    await runTransferMatchingNow();
    pairingOnly();
  });

  it("EK Consulting entity missing: nobody is owner", async () => {
    m.entity.mockResolvedValue(null);
    await runTransferMatchingNow();
    pairingOnly();
  });

  it("owner lookup throws (db down): fail-soft to pairing only, logs err.name only", async () => {
    m.users.mockRejectedValue(new Error("connection refused to secret-host"));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runTransferMatchingNow()).resolves.toEqual({ matchedPairs: 0 });
    pairingOnly();
    expect(err.mock.calls.flat().join(" ")).not.toMatch(/secret-host/);
    err.mockRestore();
  });

  it("unauthenticated (no session, or a session without a user id): throws before any read or write", async () => {
    for (const s of [null, { user: {} }]) {
      m.session = s;
      await expect(runTransferMatchingNow()).rejects.toThrow("Unauthorized");
    }
    expect(m.users).not.toHaveBeenCalled();
    expect(m.entity).not.toHaveBeenCalled();
    expect(m.setAppSetting).not.toHaveBeenCalled();
    expect(m.run).not.toHaveBeenCalled();
  });

  it("a failing setting write on the owner path stops before the one-sided run (no half-switched run)", async () => {
    m.setAppSetting.mockRejectedValue(new Error("write failed"));
    await expect(runTransferMatchingNow()).rejects.toThrow("write failed");
    expect(m.run).not.toHaveBeenCalled();
  });
});
