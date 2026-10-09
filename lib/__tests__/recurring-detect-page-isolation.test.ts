import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

// Source-reading pin (review round 1): the recurring-pattern view must be built AFTER the ledger and inside its own
// try/catch so a throw in toUiDetection can never blank the agenda.
for (const file of ["app/page.tsx", "app/forecast/page.tsx"]) {
  describe(`${file}: recurring view fail-soft isolation`, () => {
    const src = readFileSync(path.join(process.cwd(), file), "utf8").replace(/\r\n/g, "\n");
    const calls = src.split("toUiDetection(").length - 1;

    it("calls toUiDetection exactly once", () => {
      expect(calls).toBe(1);
    });

    it("builds it after toUiLedger, inside its own try whose catch resets it to null", () => {
      const ledgerAt = src.indexOf("upcoming = toUiLedger(");
      const callAt = src.indexOf("toUiDetection(");
      expect(ledgerAt).toBeGreaterThan(-1);
      expect(callAt).toBeGreaterThan(ledgerAt);
      const between = src.slice(ledgerAt, callAt);
      expect(between).toMatch(/try \{\s*upcomingDetection = loaded\.detection\s*\?\s*$/);
      const after = src.slice(callAt, callAt + 400);
      expect(after).toMatch(/\} catch \(err\) \{\s*upcomingDetection = null;/);
    });
  });
}
