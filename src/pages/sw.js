self.addEventListener("push", (event) => {
  if (!event.data) return;
  const data = event.data.json();

  event.waitUntil(
    self.registration.showNotification(data.title || "mousing", {
      body: data.body || "",
      icon: data.icon || "/assets/icon-192.png",
      badge: "/assets/icon-192.png",
      tag: data.tag || "mousing-alert",
      data: { url: data.url || self.registration.scope },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;

  event.waitUntil(
    self.clients.matchAll({ type: "window" }).then((clients) => {
      for (const client of clients) {
        if (client.url.startsWith(self.registration.scope) && "focus" in client) {
          return client.navigate(url).then((c) => (c || client).focus());
        }
      }
      return self.clients.openWindow(url);
    })
  );
});
