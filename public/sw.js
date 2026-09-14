self.addEventListener("push", (event) => {
  const data = event.data ? event.data.json() : {};
  const title = data.title ?? "Kinniburgh Finance";
  const body = data.body ?? "";
  const url = data.url ?? "/notifications";
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/favicon.ico",
      data: { url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: "window" }).then((windowClients) => {
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && "focus" in client) {
          return client.focus();
        }
      }
      return clients.openWindow(event.notification.data?.url ?? "/notifications");
    })
  );
});

// --- Offline fallback -------------------------------------------------
//
// Precaches only the static /offline document (nothing else — no app
// shell, no JS/CSS chunks, no API/server-action responses) and serves it
// when a top-level navigation fails due to no network connection. This is
// intentionally minimal: Next.js build-hash-named asset URLs change every
// deploy, so caching anything beyond this one static page risks serving
// stale/mismatched assets after a redeploy.

const OFFLINE_CACHE_NAME = "offline-v1";
const OFFLINE_URL = "/offline";

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(OFFLINE_CACHE_NAME).then((cache) => cache.addAll([OFFLINE_URL]))
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== OFFLINE_CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
});

self.addEventListener("fetch", (event) => {
  // Only intercept top-level navigation requests (page loads). Every other
  // request type (assets, client-side fetch() calls, server actions) is
  // left completely untouched so it fails with normal browser behavior.
  if (event.request.mode !== "navigate") {
    return;
  }

  event.respondWith(
    fetch(event.request).catch(() => caches.match(OFFLINE_URL))
  );
});
