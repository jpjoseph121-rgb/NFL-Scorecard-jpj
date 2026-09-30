// Service worker: enables installing the scorecard to the Home Screen (required
// for notifications on iOS) and lets lock reminders display through the OS.
// Deliberately no offline caching of API data — scores must always be live.
const SHELL = "nfl2026-shell-v1";

self.addEventListener("install", (e) => { self.skipWaiting(); });
self.addEventListener("activate", (e) => { e.waitUntil(self.clients.claim()); });

// Tapping a reminder focuses the app (or opens it) rather than starting a new tab.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) if ("focus" in c) return c.focus();
      if (self.clients.openWindow) return self.clients.openWindow("./");
    })
  );
});

// Optional upgrade path: real server-sent push (works with the app fully closed)
// would deliver here. Left wired so it can be switched on without a rewrite.
self.addEventListener("push", (event) => {
  let d = { title: "🏈 Games lock soon", body: "Open your scorecard to get picks in." };
  try { if (event.data) d = Object.assign(d, event.data.json()); } catch (_) {}
  event.waitUntil(self.registration.showNotification(d.title, { body: d.body, tag: "nfl-lock", renotify: true }));
});
