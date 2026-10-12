// Service worker: the app must open instantly with no network, because the
// server is only reachable on the tailnet and the music is already on the phone.
//
// So this is cache-first, refreshed in the background: a launch never waits on
// the network, and a new build shows up on the launch after it was fetched.
// Bump VERSION when a file is removed from the app, to drop the old cache.
const VERSION = "2";
const CACHE = `gapless-amp-${VERSION}`;

const SHELL = [
  "./",
  "style.css",
  "app.js",
  "media.js",
  "tags.js",
  "store.js",
  "store-worker.js",
  "decode-worker.js",
  "player-worklet.js",
  "vendor/webamp.bundle.min.mjs",
  "vendor/mpg123-decoder.min.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png",
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(SHELL.map(url => new Request(url, { cache: "reload" }))))
      .then(() => self.skipWaiting()));
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n))))
      .then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const { request } = event;
  const url = new URL(request.url);
  // Only the app's own files. blob: URLs (the music) never reach here anyway.
  if (request.method !== "GET" || url.origin !== location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(request, { ignoreSearch: true });
    const fresh = fetch(request, { cache: "no-store" })
      .then(response => {
        if (response.ok) cache.put(url.pathname, response.clone());
        return response;
      });
    if (cached) {
      event.waitUntil(fresh.catch(() => {}));
      return cached;
    }
    return fresh;
  })());
});
