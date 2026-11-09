const CACHE = 'mobile-secretary-v8';
const ASSETS = ['./', 'index.html', 'push-config.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS))); self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))));
  self.clients.claim();
});
// 網路優先，離線時用快取
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(fetch(e.request).then(r => {
    const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return r;
  }).catch(() => caches.match(e.request)));
});
// 點通知時打開 App
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    for (const c of cs) if ('focus' in c) return c.focus();
    return self.clients.openWindow('./');
  }));
});

// 雲端推播：收到推播後，去雲端取通知內容再顯示
self.addEventListener('push', e => {
  e.waitUntil((async () => {
    let msgs = [];
    try {
      const cfgRes = await (await caches.open('ms-config')).match('push-cfg');
      const cfg = cfgRes ? await cfgRes.json() : null;
      if (cfg && cfg.api) {
        const r = await fetch(`${cfg.api}/pending?id=${encodeURIComponent(cfg.id)}`, { cache: 'no-store' });
        msgs = (await r.json()).messages || [];
      }
    } catch (err) {}
    if (!msgs.length) msgs = [{ title: '📋 行動秘書', body: '打開看看今天還有哪些事沒完成', tag: 'daily' }];
    for (const m of msgs) {
      await self.registration.showNotification(m.title, { body: m.body, tag: m.tag, icon: 'icon-192.png', badge: 'icon-192.png' });
    }
  })());
});
