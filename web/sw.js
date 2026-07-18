// Tracy PWA service worker.
//
// Strategy: NETWORK-FIRST for the app shell so deploys reach users immediately
// (fall back to cache only when offline). An earlier cache-first version could
// serve a stale UI after an update — hence the version bump below. API calls to
// the backend are cross-origin and are never handled here.

const CACHE = "tracy-shell-v26";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./config.js",
  "./corrections.js",
  "./native.bundle.js",
  "./install.js",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== self.location.origin) return;
  // Network-first: always try the latest, cache it, fall back to cache offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// --- Push notifications ---
self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data && e.data.text() }; }
  const title = data.title || "Tracy";
  const options = {
    body: data.body || "",
    icon: "./icon-192.png",
    badge: "./icon-192.png",
    data: { url: data.url || "./" },
    tag: "tracy-checkin",
  };
  e.waitUntil(self.registration.showNotification(title, options));
});

// Focus an open tab if there is one, else open the app.
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || "./";
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) { if ("focus" in c) return c.focus(); }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// Report the running build version (the cache name) so the app can show which
// build a device is actually on — makes "am I on the latest?" easy to answer.
self.addEventListener("message", (e) => {
  if (e.data && e.data.type === "version" && e.ports && e.ports[0]) {
    e.ports[0].postMessage({ version: CACHE });
  }
});
