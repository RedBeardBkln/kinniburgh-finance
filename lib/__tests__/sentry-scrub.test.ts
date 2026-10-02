import { describe, it, expect } from "vitest";
import {
  QUEUE_PATH_PLACEHOLDER,
  scrubQueueTokens,
  scrubQueueTokensFromEvent,
} from "@/lib/sentry-scrub";

const TOKEN = "Zk3_-Ab9".repeat(5) + "xyz"; // 43 base64url chars
const URL_ = `https://finance.example.test/queue/${TOKEN}`;

describe("scrubQueueTokens", () => {
  it("rewrites /queue/<token> to /queue/[token] and leaves other strings alone", () => {
    expect(TOKEN).toHaveLength(43);
    expect(scrubQueueTokens(URL_)).toBe(`https://finance.example.test${QUEUE_PATH_PLACEHOLDER}`);
    expect(scrubQueueTokens(`/queue/${TOKEN}?x=1`)).toBe("/queue/[token]?x=1");
    expect(scrubQueueTokens("/transactions?tab=review")).toBe("/transactions?tab=review");
    expect(scrubQueueTokens("GET /queue/[token]")).toBe("GET /queue/[token]");
  });
  it("scrubs several occurrences and truncated tokens", () => {
    expect(scrubQueueTokens(`a /queue/${TOKEN} b /queue/${TOKEN}`)).toBe("a /queue/[token] b /queue/[token]");
    expect(scrubQueueTokens(`/queue/${TOKEN.slice(0, 25)}`)).toBe("/queue/[token]");
  });
});

describe("scrubQueueTokensFromEvent", () => {
  it("scrubs request url, transaction name, breadcrumbs, spans and headers (beforeSend / beforeSendTransaction shapes)", () => {
    const event = {
      transaction: `GET /queue/${TOKEN}`,
      request: { url: URL_, headers: { referer: URL_ }, method: "GET" },
      breadcrumbs: [{ category: "http", data: { url: URL_ }, message: `fetch ${URL_}` }],
      contexts: { trace: { data: { "http.url": URL_, "url.full": URL_, "http.target": `/queue/${TOKEN}` } } },
      spans: [{ description: `GET /queue/${TOKEN}`, data: { "url.path": `/queue/${TOKEN}` } }],
      tags: ["a", `/queue/${TOKEN}`],
    };
    const out = scrubQueueTokensFromEvent(event);
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    expect(out.transaction).toBe("GET /queue/[token]");
    expect(out.request.url).toBe("https://finance.example.test/queue/[token]");
    expect(out.request.method).toBe("GET");
    expect(out.spans[0]!.description).toBe("GET /queue/[token]");
  });

  it("does not break on cycles, nulls and non-objects", () => {
    const a: Record<string, unknown> = { url: URL_ };
    a.self = a;
    expect(() => scrubQueueTokensFromEvent(a)).not.toThrow();
    expect(a.url).toBe("https://finance.example.test/queue/[token]");
    expect(scrubQueueTokensFromEvent(null)).toBeNull();
    expect(scrubQueueTokensFromEvent("x" as unknown)).toBe("x");
  });
});

describe("Sentry config wiring", () => {
  it("server and edge configs both scrub in beforeSend and beforeSendTransaction", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of ["sentry.server.config.ts", "sentry.edge.config.ts"]) {
      const src = readFileSync(join(process.cwd(), file), "utf8");
      expect(src, file).toMatch(/beforeSend:\s*\(event\)\s*=>\s*scrubQueueTokensFromEvent\(event\)/);
      expect(src, file).toMatch(/beforeSendTransaction:\s*\(event\)\s*=>\s*scrubQueueTokensFromEvent\(event\)/);
    }
  });
});
