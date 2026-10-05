import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { packageDownloadOutcome } from "@/lib/tax-review/ui";
import { CLEAN_COPY_REFUSED } from "@/lib/tax2025-pdf-approval";

// "Download the final package" must never save a refusal as a file (integration tester O6): the card fetches the route, looks at the answer
// and shows the route's own message when it refused.

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8").replace(/\r\n/g, "\n");

const ok = (over: Partial<Parameters<typeof packageDownloadOutcome>[0]> = {}) => ({ ok: true, status: 200, contentType: "application/zip", disposition: 'attachment; filename="tax-2025-final.zip"', ...over });

describe("packageDownloadOutcome", () => {
  it("a 200 zip is a file, named from the Content-Disposition header (sanitised)", () => {
    expect(packageDownloadOutcome(ok(), null)).toEqual({ kind: "file", filename: "tax-2025-final.zip" });
    expect(packageDownloadOutcome(ok({ contentType: "application/octet-stream", disposition: 'attachment; filename="../../evil name.zip"' }), null)).toEqual({ kind: "file", filename: ".._.._evil_name.zip" });
    expect(packageDownloadOutcome(ok({ disposition: null }), null)).toEqual({ kind: "file", filename: "final-package.zip" });
  });
  it("the route's own JSON refusal (403 / 409) is shown as its message, never saved", () => {
    const body = JSON.stringify({ error: CLEAN_COPY_REFUSED });
    expect(packageDownloadOutcome({ ok: false, status: 403, contentType: "application/json; charset=utf-8", disposition: null }, body)).toEqual({ kind: "refused", message: CLEAN_COPY_REFUSED });
    expect(packageDownloadOutcome({ ok: false, status: 409, contentType: "application/json", disposition: null }, JSON.stringify({ error: "The final package cannot be built while a blocking item remains." }))).toEqual({
      kind: "refused",
      message: "The final package cannot be built while a blocking item remains.",
    });
  });
  it("a 200 that is not a zip (JSON, HTML) is a refusal too: a status that says ok is not enough", () => {
    expect(packageDownloadOutcome(ok({ contentType: "application/json" }), JSON.stringify({ error: "Something is off." }))).toEqual({ kind: "refused", message: "Something is off." });
    expect(packageDownloadOutcome(ok({ contentType: "text/html; charset=utf-8" }), "<html>Sign in</html>").kind).toBe("refused");
    expect(packageDownloadOutcome(ok({ contentType: null }), null).kind).toBe("refused");
  });
  it("a body that is not JSON, empty or odd falls back to a plain sentence for the status; nothing of the body is echoed", () => {
    for (const status of [401, 403, 409, 500]) {
      const r = packageDownloadOutcome({ ok: false, status, contentType: "text/html", disposition: null }, "<html><body>Stack trace 123-45-6789</body></html>");
      expect(r.kind).toBe("refused");
      if (r.kind === "refused") {
        expect(r.message.length).toBeGreaterThan(20);
        expect(r.message).not.toMatch(/Stack trace|123-45-6789|<html/);
      }
    }
    expect(packageDownloadOutcome({ ok: false, status: 403, contentType: null, disposition: null }, "")).toMatchObject({ kind: "refused" });
    // an over-long message is cut
    const long = packageDownloadOutcome({ ok: false, status: 409, contentType: "application/json", disposition: null }, JSON.stringify({ error: "x".repeat(2000) }));
    expect(long.kind === "refused" && long.message.length <= 300).toBe(true);
  });
});

describe("the approval card", () => {
  const src = read("components/tax/review/approval-card.tsx");
  it("fetches the final package and decides from the answer; the final link is no longer a plain download anchor", () => {
    expect(src).toContain("fetch(`${base}?final=1`");
    expect(src).toContain("packageDownloadOutcome(");
    expect(src).not.toMatch(/<a[^>]*href=\{`\$\{base\}\?final=1`\}/);
    expect(src).toContain('data-testid="download-final-package"');
  });
  it("a refusal goes to the result line and refreshes the page state", () => {
    expect(src).toMatch(/outcome\.kind === "refused"[\s\S]{0,200}setResult\(\{ ok: false, text: outcome\.message \}\)[\s\S]{0,200}router\.refresh\(\)/);
  });
});
