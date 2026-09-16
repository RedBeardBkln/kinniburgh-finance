import { describe, it, expect } from "vitest";
import { runWithConcurrencyLimit } from "@/lib/concurrency";

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

describe("runWithConcurrencyLimit", () => {
  it("returns results in input order even when later items resolve first", async () => {
    const items = [
      { id: "a", delayMs: 30 },
      { id: "b", delayMs: 10 },
      { id: "c", delayMs: 20 },
    ];

    const results = await runWithConcurrencyLimit(items, 3, (item) => delay(item.delayMs, item.id));

    expect(results).toEqual(["a", "b", "c"]);
  });

  it("never runs more than `limit` calls concurrently", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let inFlight = 0;
    let maxInFlight = 0;

    const results = await runWithConcurrencyLimit(items, 3, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5, undefined);
      inFlight -= 1;
      return item * 2;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(results).toEqual(items.map((i) => i * 2));
  });

  it("returns an empty array for empty input", async () => {
    const results = await runWithConcurrencyLimit<number, number>([], 4, async (item) => item);
    expect(results).toEqual([]);
  });

  it("works when limit is larger than items.length", async () => {
    const items = [1, 2, 3];
    let maxInFlight = 0;
    let inFlight = 0;

    const results = await runWithConcurrencyLimit(items, 10, async (item) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await delay(5, undefined);
      inFlight -= 1;
      return item;
    });

    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(results).toEqual([1, 2, 3]);
  });
});
