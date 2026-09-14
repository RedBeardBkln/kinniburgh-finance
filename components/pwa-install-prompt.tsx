"use client";

import { useEffect, useState } from "react";
import { shouldShowInstallBanner } from "@/lib/pwa-install";

const DISMISSED_KEY = "pwaInstallDismissed";

/**
 * `beforeinstallprompt` isn't in lib.dom.d.ts yet — declared locally.
 * Chromium-only (Chrome/Edge/Android WebView); never fires in Safari/Firefox.
 */
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
  prompt(): Promise<void>;
}

/**
 * Mid-session "Install app" banner, mounted at the layout level alongside
 * GlobalErrorSafetyNet and OfflineIndicator. Chromium-only — captures the
 * `beforeinstallprompt` event (browsers that never fire it, like Safari and
 * Firefox, simply never show this banner; no broken UI there).
 *
 * Does nothing when already running installed (standalone display mode).
 * Dismissal is remembered permanently via localStorage — this is a 2-person
 * household app with known, returning users, so re-nagging every session
 * after an explicit "no" is worse than leaving the browser's own native
 * install affordance (e.g. Chrome's address-bar icon) as the fallback.
 */
export function PwaInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const isStandalone = window.matchMedia("(display-mode: standalone)").matches;
    if (isStandalone) {
      return;
    }

    const dismissed = window.localStorage.getItem(DISMISSED_KEY) === "1";

    function handleBeforeInstallPrompt(event: Event) {
      event.preventDefault();
      const promptEvent = event as BeforeInstallPromptEvent;
      setDeferredPrompt(promptEvent);
      setVisible(
        shouldShowInstallBanner({ hasDeferredPrompt: true, isStandalone, dismissed })
      );
    }

    function handleAppInstalled() {
      setDeferredPrompt(null);
      setVisible(false);
    }

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  async function handleInstall() {
    if (!deferredPrompt) {
      return;
    }
    await deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    setVisible(false);
  }

  function handleDismiss() {
    window.localStorage.setItem(DISMISSED_KEY, "1");
    setVisible(false);
  }

  if (!visible) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        backgroundColor: "#d97706",
        color: "#fffbeb",
        fontSize: "13px",
        fontWeight: 600,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        flexWrap: "wrap",
        padding: "8px 12px",
      }}
    >
      <span>Install Banana Stand for faster access.</span>
      <button
        type="button"
        onClick={handleInstall}
        style={{
          backgroundColor: "#fffbeb",
          color: "#92400e",
          border: "none",
          borderRadius: "4px",
          padding: "4px 10px",
          fontSize: "13px",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Install
      </button>
      <button
        type="button"
        onClick={handleDismiss}
        style={{
          backgroundColor: "transparent",
          color: "#fffbeb",
          border: "1px solid #fffbeb",
          borderRadius: "4px",
          padding: "4px 10px",
          fontSize: "13px",
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        Not now
      </button>
    </div>
  );
}
