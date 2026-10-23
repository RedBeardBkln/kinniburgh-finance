import { describe, it, expect } from "vitest";
import { isPublicInvoicePath, isReviewQueuePath, shouldShowInstallBanner } from "@/lib/pwa-install";

describe("shouldShowInstallBanner", () => {
  it("shows when a deferred prompt exists, not standalone, not dismissed", () => {
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: true, isStandalone: false, dismissed: false })
    ).toBe(true);
  });

  it("hides when there is no deferred prompt (the common no-event case)", () => {
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: false, isStandalone: false, dismissed: false })
    ).toBe(false);
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: false, isStandalone: true, dismissed: false })
    ).toBe(false);
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: false, isStandalone: false, dismissed: true })
    ).toBe(false);
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: false, isStandalone: true, dismissed: true })
    ).toBe(false);
  });

  it("hides when already running standalone, even with a deferred prompt", () => {
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: true, isStandalone: true, dismissed: false })
    ).toBe(false);
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: true, isStandalone: true, dismissed: true })
    ).toBe(false);
  });

  it("hides when previously dismissed, regardless of other state", () => {
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: true, isStandalone: false, dismissed: true })
    ).toBe(false);
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: false, isStandalone: false, dismissed: true })
    ).toBe(false);
  });

  it("hides when neither standalone nor dismissed but also no deferred prompt", () => {
    expect(
      shouldShowInstallBanner({ hasDeferredPrompt: false, isStandalone: false, dismissed: false })
    ).toBe(false);
  });
});

describe("isReviewQueuePath", () => {
  it("is true for /queue and anything under /queue/", () => {
    expect(isReviewQueuePath("/queue")).toBe(true);
    expect(isReviewQueuePath("/queue/abc123")).toBe(true);
  });
  it("is false for every other path, including look-alikes, and for a missing pathname", () => {
    for (const p of ["/", "/transactions", "/queue-admin", "/queues", "/api/queue", "/tags/queue/x"]) {
      expect(isReviewQueuePath(p)).toBe(false);
    }
    expect(isReviewQueuePath(null)).toBe(false);
    expect(isReviewQueuePath(undefined)).toBe(false);
  });
});

describe("isPublicInvoicePath (the client's invoice link: no install banner there)", () => {
  it("is true for /i and anything under /i/", () => {
    for (const p of ["/i", "/i/abc", "/i/paid", "/i/cancelled"]) expect(isPublicInvoicePath(p), p).toBe(true);
  });
  it("is false for look-alikes and a missing pathname; the queue rule is unchanged", () => {
    for (const p of ["/", "/invoices", "/income", "/insurance", "/ix", "/business/ek-consulting/invoices", "/api/i/x"]) expect(isPublicInvoicePath(p), p).toBe(false);
    expect(isPublicInvoicePath(null)).toBe(false);
    expect(isReviewQueuePath("/i/abc")).toBe(false);
  });
  it("the install prompt hides on both", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const src = readFileSync(join(process.cwd(), "components/pwa-install-prompt.tsx"), "utf8");
    expect(src).toMatch(/isReviewQueuePath\(pathname\) \|\| isPublicInvoicePath\(pathname\)/);
  });
});
