"use client";

import { useState } from "react";
import { subscribePush, unsubscribePush } from "@/actions/notifications";

interface Props {
  initialSubscribed: boolean;
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

export function PushSubscribeButton({ initialSubscribed }: Props) {
  const [subscribed, setSubscribed] = useState(initialSubscribed);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleEnable() {
    setLoading(true);
    setError(null);
    try {
      if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
        setError("Push notifications are not supported in this browser.");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setError("Push notification permission was denied.");
        return;
      }

      const reg = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const vapidRes = await fetch("/api/push/vapid-key");
      const { publicKey } = await vapidRes.json() as { publicKey: string };

      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
      });

      const json = sub.toJSON();
      await subscribePush({
        endpoint: json.endpoint!,
        p256dh: json.keys!["p256dh"]!,
        auth: json.keys!["auth"]!,
      });

      setSubscribed(true);
    } catch (e) {
      setError((e as Error).message ?? "Failed to enable push notifications.");
    } finally {
      setLoading(false);
    }
  }

  async function handleDisable() {
    setLoading(true);
    setError(null);
    try {
      await unsubscribePush();
      if ("serviceWorker" in navigator) {
        const reg = await navigator.serviceWorker.getRegistration("/sw.js");
        if (reg) {
          const sub = await reg.pushManager.getSubscription();
          if (sub) await sub.unsubscribe();
        }
      }
      setSubscribed(false);
    } catch (e) {
      setError((e as Error).message ?? "Failed to disable push notifications.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-2">
      {subscribed ? (
        <div className="flex items-center gap-3">
          <span className="text-sm text-green-600 font-medium">Push notifications enabled</span>
          <button
            onClick={handleDisable}
            disabled={loading}
            className="rounded-md border px-3 py-1.5 text-sm text-muted-foreground hover:bg-accent disabled:opacity-50"
          >
            {loading ? "Disabling…" : "Disable"}
          </button>
        </div>
      ) : (
        <button
          onClick={handleEnable}
          disabled={loading}
          className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {loading ? "Enabling…" : "Enable push notifications"}
        </button>
      )}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
