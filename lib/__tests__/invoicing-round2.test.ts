// Round 2 fixes (ek-consulting-invoicing, 03-test-report.md): D-7 request key never constant, D-10 logo limit below the framework body limit.
import { describe, expect, it } from "vitest";
import { LOGO_MAX_BYTES, LOGO_MAX_LABEL } from "@/lib/invoicing/constants";
import { newRequestKey, uuidFromBytes } from "@/lib/invoicing/request-key";
import { isUuid } from "@/lib/invoicing/validate";

describe("D-7: payment request key", () => {
  it("uses crypto.randomUUID when it exists", () => {
    expect(newRequestKey({ randomUUID: () => "11111111-1111-4111-8111-111111111111" })).toBe("11111111-1111-4111-8111-111111111111");
  });

  it("without randomUUID (plain-http origin) it builds a valid v4 UUID from getRandomValues, unique per call", () => {
    let seed = 123456789; // a small deterministic generator (xorshift32) standing in for the browser's random source
    const next = () => {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      return (seed >>> 0) & 0xff;
    };
    const fake = {
      getRandomValues: <T extends ArrayBufferView>(a: T): T => {
        const u = a as unknown as Uint8Array;
        for (let i = 0; i < u.length; i += 1) u[i] = next();
        return a;
      },
    };
    const keys = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const k = newRequestKey(fake);
      expect(isUuid(k)).toBe(true);
      keys.add(k);
    }
    expect(keys.size).toBe(500);
  });

  it("with no crypto at all it is still unique per call and still a valid UUID (never a constant)", () => {
    const keys = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const k = newRequestKey(undefined);
      expect(isUuid(k)).toBe(true);
      keys.add(k);
    }
    expect(keys.size).toBe(2000);
    expect(keys.has("00000000-0000-4000-8000-000000000000")).toBe(false);
  });

  it("the real runtime crypto path returns valid distinct keys", () => {
    expect(newRequestKey()).not.toBe(newRequestKey());
    expect(isUuid(newRequestKey())).toBe(true);
  });

  it("uuidFromBytes sets the version and variant bits", () => {
    expect(uuidFromBytes(new Array(16).fill(0xff))).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
    expect(uuidFromBytes([])).toBe("00000000-0000-4000-8000-000000000000");
  });
});

describe("D-10: logo size limit", () => {
  it("is comfortably below Next's 1 MB default Server Action body limit, so the friendly message shows", () => {
    expect(LOGO_MAX_BYTES).toBeLessThanOrEqual(768 * 1024);
    expect(LOGO_MAX_BYTES).toBeGreaterThan(0);
    expect(LOGO_MAX_LABEL).toBe("512 KB");
    expect(LOGO_MAX_BYTES).toBe(512 * 1024);
  });
});
