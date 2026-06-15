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
