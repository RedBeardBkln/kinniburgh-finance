import { describe, it, expect } from "vitest";
import { shouldShowInstallBanner } from "@/lib/pwa-install";

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
