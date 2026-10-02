import { describe, it, expect, vi } from "vitest";
import { runBulkExtraction, type BulkRunOutcome } from "@/lib/bulk-extraction";
import { ALREADY_UP_TO_DATE_ERROR, BULK_CONCURRENCY, MAX_BULK_EXTRACT } from "@/lib/document-extraction-state";

const ids = (n: number) => Array.from({ length: n }, (_, i) => `doc-${i}`);
const ok: BulkRunOutcome = { ok: true };

describe("runBulkExtraction", () => {
  it("runs at most MAX_BULK_EXTRACT documents per click and reports the remainder", async () => {
    const run = vi.fn(async () => ok);
    const result = await runBulkExtraction({ ids: ids(40), run });
    expect(run).toHaveBeenCalledTimes(MAX_BULK_EXTRACT);
    expect(result.total).toBe(MAX_BULK_EXTRACT);
    expect(result.succeeded).toBe(MAX_BULK_EXTRACT);
    expect(result.remaining).toBe(15);
    // First 25, in order of dispatch.
    expect(run.mock.calls.map((c) => (c as unknown as [string])[0])).toEqual(ids(25));
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const run = async (): Promise<BulkRunOutcome> => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return ok;
    };
    await runBulkExtraction({ ids: ids(12), run });
    expect(peak).toBeLessThanOrEqual(BULK_CONCURRENCY);
    expect(peak).toBeGreaterThan(1);
  });

  it("Stop prevents new calls from starting; in-flight ones finish", async () => {
    let stop = false;
    const started: string[] = [];
    const run = async (id: string): Promise<BulkRunOutcome> => {
      started.push(id);
      if (started.length === 3) stop = true; // user clicks Stop while the first batch is in flight
      await new Promise((r) => setTimeout(r, 5));
      return ok;
    };
    const result = await runBulkExtraction({ ids: ids(10), run, shouldStop: () => stop, concurrency: 3 });
    expect(started.length).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.stopped).toBe(7);
  });

  it("aggregates failures with reasons, counts up-to-date skips separately, and survives a rejecting run", async () => {
    const run = async (id: string): Promise<BulkRunOutcome> => {
      if (id === "doc-1") return { ok: false, error: "Output was cut off" };
      if (id === "doc-2") return { ok: false, error: ALREADY_UP_TO_DATE_ERROR };
      if (id === "doc-3") throw new Error("network down");
      return ok;
    };
    const progressSeen: number[] = [];
    const result = await runBulkExtraction({ ids: ids(5), run, onProgress: (p) => progressSeen.push(p.done) });
    expect(result.succeeded).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(2);
    expect(result.failures).toEqual([
      { id: "doc-1", error: "Output was cut off" },
      { id: "doc-3", error: "The request failed before extraction finished" },
    ]);
    expect(result.done).toBe(5);
    expect(progressSeen).toHaveLength(5);
    expect(Math.max(...progressSeen)).toBe(5);
  });

  it("an empty list makes no calls", async () => {
    const run = vi.fn(async () => ok);
    const result = await runBulkExtraction({ ids: [], run });
    expect(run).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 0, succeeded: 0, failed: 0, remaining: 0 });
  });
});
