// Offline cache for the app's own files. Market data requests (other origins) are never cached:
// an old quote must show with its own date, not be served silently as if it were fresh.
const CACHE = 'budget-v27';
const FILES = ['./', 'index.html', 'ui.js', 'budget.js', 'market.js', 'manifest.webmanifest', 'icon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES))));
self.addEventListener('activate', e => e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))));
// network first so updates show up, cache as offline fallback
self.addEventListener('fetch', e => {
  if (new URL(e.request.url).origin !== location.origin) return;
  // always revalidate: a new version shows at the next opening
  e.respondWith(fetch(e.request, { cache: 'no-cache' }).then(r => { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r; })
    .catch(() => caches.match(e.request)));
});
// a tapped notification opens the app on the tab it is about
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = `./?tab=${e.notification.data?.tab ?? 'dash'}`;
  e.waitUntil(clients.matchAll({ type: 'window' }).then(ws => (ws[0] ? ws[0].navigate(url).then(w => w?.focus()) : clients.openWindow(url))));
});
// alert sent by the user's own service while the app is closed (see cloudflare-worker.js)
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data?.json() ?? {}; } catch { /* unreadable message: generic notification */ }
  e.waitUntil(self.registration.showNotification(d.title ?? 'Boussole', { body: d.body ?? 'Nouvelle alerte', icon: 'icon-192.png', tag: 'alerte', data: { tab: d.tab ?? 'stock' } }));
});
