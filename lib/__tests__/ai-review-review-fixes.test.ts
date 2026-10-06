import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));

import { APPEND_TRANSACTION_OPTIONS, dbAiRunStore, type L3StoreDb, type L3StoreTx } from "@/lib/tax-review-l3-store";
import { loadSourcePack, SourcePackIntegrityError } from "@/lib/tax-review-sources";
import { HARD_CEILING_TOKENS, retryBudget, TASKS } from "@/lib/tax-review/llm/tasks";

// Fixes made at the final review of ai-review-token-budget: (a) the output ceiling must fit the request timeout, (b) the atomic append of a
// run start that copies reused tasks must not run on Prisma's 5 s default transaction timeout, (c) the source pack text is verified against
// the manifest hashes when it is loaded, so reuse can rely on the manifest hash as the identity of the pack.

describe("(a) output ceiling vs request timeout", () => {
  // the action's request timeout, read from the source (so a later change of either number is caught here)
  const actionSource = readFileSync(path.join(process.cwd(), "actions", "tax-review.ts"), "utf8");
  const timeoutMs = Number(/timeoutMs:\s*([\d_]+)/.exec(actionSource)?.[1]?.replace(/_/g, ""));
  /** Slowest output rate measured on the live run (tokens a second); the fastest was about 100. */
  const SLOWEST_TOKENS_PER_SECOND = 75;
  const MARGIN_SECONDS = 30;

  it("the action sets a request timeout and the page keeps a longer maxDuration", () => {
    expect(timeoutMs).toBe(280_000);
    const page = readFileSync(path.join(process.cwd(), "app", "tax", "forms", "[year]", "final-review", "page.tsx"), "utf8");
    expect(Number(/export const maxDuration = (\d+)/.exec(page)?.[1])).toBeGreaterThan(timeoutMs / 1000);
  });
  it("the hard ceiling is 18,000 tokens and its worst-case duration at the slowest measured rate fits the timeout with margin", () => {
    expect(HARD_CEILING_TOKENS).toBe(18_000);
    expect(HARD_CEILING_TOKENS / SLOWEST_TOKENS_PER_SECOND).toBeLessThanOrEqual(timeoutMs / 1000 - MARGIN_SECONDS);
  });
  it("every first budget and every retry budget of every task fits too, and no retry is above the ceiling", () => {
    for (const t of TASKS) {
      expect(t.maxTokens / SLOWEST_TOKENS_PER_SECOND, `${t.id} first`).toBeLessThanOrEqual(timeoutMs / 1000 - MARGIN_SECONDS);
      expect(retryBudget(t) / SLOWEST_TOKENS_PER_SECOND, `${t.id} retry`).toBeLessThanOrEqual(timeoutMs / 1000 - MARGIN_SECONDS);
      expect(retryBudget(t), t.id).toBeLessThanOrEqual(HARD_CEILING_TOKENS);
    }
  });
});

describe("(b) the atomic append runs with an explicit transaction timeout", () => {
  it("the options are generous (well above Prisma's 5 s default) and bounded", () => {
    expect(APPEND_TRANSACTION_OPTIONS.timeout).toBeGreaterThanOrEqual(30_000);
    expect(APPEND_TRANSACTION_OPTIONS.timeout).toBeLessThanOrEqual(60_000);
    expect(APPEND_TRANSACTION_OPTIONS.maxWait).toBeGreaterThan(2_000);
  });
  it("append passes them to $transaction (events and findings in the one transaction)", async () => {
    const seen: Array<{ maxWait?: number; timeout?: number } | undefined> = [];
    const ops: string[] = [];
    const tx: L3StoreTx = {
      taxReviewRunEvent: {
        async createMany({ data }) {
          ops.push("events");
          return { count: data.length };
        },
      },
      taxReviewFinding: {
        async findMany() {
          return [];
        },
        async createMany({ data }) {
          ops.push("findings");
          return { count: data.length };
        },
      },
    };
    const db: L3StoreDb = {
      ...tx,
      taxReviewRunEvent: { ...tx.taxReviewRunEvent, async findMany() { return []; } },
      async $transaction(fn, options) {
        seen.push(options);
        return fn(tx);
      },
    };
    await dbAiRunStore(db).append("r1", [{ runId: "r1", eventKey: "run_started", kind: "run_started", taskId: null, attempt: null, data: {} }], []);
    expect(seen).toEqual([APPEND_TRANSACTION_OPTIONS]);
    expect(ops).toEqual(["events"]);
  });
  it("the source passes the options to the only $transaction of the store", () => {
    const src = readFileSync(path.join(process.cwd(), "lib", "tax-review-l3-store.ts"), "utf8");
    expect((src.match(/\$transaction\(/g) ?? []).length).toBe(1);
    expect(src).toMatch(/\},\s*APPEND_TRANSACTION_OPTIONS\);/);
  });
});

describe("(c) the source pack is verified against the manifest when it is loaded", () => {
  const dirs: string[] = [];
  const sha = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");
  const TEXT = "Line one of the instructions.\nLine two of the instructions.\f";

  function makePack(manifestText: string, fileText: string): string {
    const dir = mkdtempSync(path.join(tmpdir(), "srcpack-"));
    dirs.push(dir);
    const manifest = { version: 1, taxYear: 2025, sources: [{ id: "s1", title: "S1", url: "https://www.irs.gov/s1", retrievedOn: "2026-10-01", textSha256: sha(manifestText), pages: 1 }] };
    writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    writeFileSync(path.join(dir, "topics.json"), JSON.stringify({ version: 1, topics: [] }));
    writeFileSync(path.join(dir, "s1.txt"), fileText);
    return dir;
  }
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it("a text file that hashes to the manifest value loads (CRLF line ends are ignored, as when the hash was pinned)", () => {
    expect(loadSourcePack(makePack(TEXT, TEXT)).texts["s1"]).toBe(TEXT);
    expect(loadSourcePack(makePack(TEXT, TEXT.replace(/\n/g, "\r\n"))).texts["s1"]).toBe(TEXT);
  });
  it("a text file edited without re-pinning the manifest is refused (fail closed) and the error names the source, not the text", () => {
    const dir = makePack(TEXT, TEXT.replace("Line two", "Line 2"));
    expect(() => loadSourcePack(dir)).toThrow(SourcePackIntegrityError);
    try {
      loadSourcePack(dir);
    } catch (err) {
      expect(err).toBeInstanceOf(SourcePackIntegrityError);
      expect((err as SourcePackIntegrityError).sourceIds).toEqual(["s1"]);
      expect((err as Error).message).toContain("s1");
      expect((err as Error).message).not.toContain("instructions");
    }
  });
  it("the committed pack still loads (file == manifest for every source)", () => {
    const pack = loadSourcePack();
    expect(pack.manifest.length).toBeGreaterThan(0);
    for (const m of pack.manifest) expect(sha(pack.texts[m.id] ?? ""), m.id).toBe(m.textSha256);
  });
});
