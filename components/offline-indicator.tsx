"use client";

import { useEffect, useState } from "react";

/**
 * Mid-session connectivity indicator, mounted at the layout level alongside
 * GlobalErrorSafetyNet. Shows a small banner only while the browser's
 * network adapter reports no connection (window "offline"/"online" events).
 *
 * Deliberately connectivity-status-only: the copy never implies that any
 * on-screen data is current while offline (this app never caches financial
 * data — see the offline-resilience plan's scope boundary).
 *
 * Note: navigator.onLine/online/offline reflect local network adapter
 * state, not true internet reachability — a device on Wi-Fi with no actual
 * route to the internet will still report "online". This is an accepted
 * limitation of the browser API, not a bug.
 */
export function OfflineIndicator() {
  const [isOffline, setIsOffline] = useState(false);

  useEffect(() => {
    setIsOffline(!navigator.onLine);

    function handleOnline() {
      setIsOffline(false);
    }
    function handleOffline() {
      setIsOffline(true);
    }

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (!isOffline) {
    return null;
  }

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 9999,
        backgroundColor: "#d97706",
        color: "#fffbeb",
        fontSize: "13px",
        fontWeight: 600,
        textAlign: "center",
        padding: "6px 12px",
      }}
    >
      You&apos;re offline. Some actions won&apos;t work until your connection
      returns.
    </div>
  );
}
