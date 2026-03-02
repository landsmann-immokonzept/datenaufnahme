const CACHE_NAME = 'immokonzept-v3.0.0';
const ASSETS = [
  './',
  './index.html',
  './manifest.json'
];

// Install: Cache all assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      console.log('Caching app assets');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: Clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(key => key !== CACHE_NAME)
            .map(key => caches.delete(key))
      );
    })
  );
  self.clients.claim();
});

// Fetch: Cache-first strategy
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) {
        // Return cached, but also fetch new version (same-origin only)
        if (event.request.url.startsWith(self.location.origin)) {
          fetch(event.request).then(response => {
            if (response.ok) {
              caches.open(CACHE_NAME).then(cache => {
                cache.put(event.request, response);
              });
            }
          }).catch(() => {});
        }
        return cached;
      }

      // Not in cache, try network
      return fetch(event.request).then(response => {
        if (response.ok) {
          const responseClone = response.clone();
          caches.open(CACHE_NAME).then(cache => {
            cache.put(event.request, responseClone);
          });
        }
        return response;
      }).catch(() => {
        // Offline fallback for HTML pages
        if (event.request.headers.get('accept')?.includes('text/html')) {
          return caches.match('./index.html');
        }
      });
    })
  );
});

// Background sync for data
self.addEventListener('sync', event => {
  if (event.tag === 'sync-data') {
    event.waitUntil(syncFromQueue());
  }
});

async function syncFromQueue() {
  const DB_NAME = 'immokonzept-datenaufnahme';

  try {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    if (!db.objectStoreNames.contains('settings') || !db.objectStoreNames.contains('sync-queue')) {
      db.close();
      return;
    }

    // Get sync webhook URL
    const urlTx = db.transaction('settings', 'readonly');
    const urlReq = urlTx.objectStore('settings').get('sync_webhook_url');
    const syncUrl = await new Promise(resolve => {
      urlReq.onsuccess = () => resolve(urlReq.result?.value || '');
      urlReq.onerror = () => resolve('');
    });

    if (!syncUrl) { db.close(); return; }

    // Get pending items
    const tx = db.transaction('sync-queue', 'readonly');
    const idx = tx.objectStore('sync-queue').index('status');
    const pendingReq = idx.getAll('pending');
    const pending = await new Promise(resolve => {
      pendingReq.onsuccess = () => resolve(pendingReq.result || []);
      pendingReq.onerror = () => resolve([]);
    });

    // Send each item
    for (const item of pending) {
      try {
        const resp = await fetch(syncUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(item.payload)
        });
        if (resp.ok) {
          await new Promise((resolve, reject) => {
              const delTx = db.transaction('sync-queue', 'readwrite');
              delTx.objectStore('sync-queue').delete(item.id);
              delTx.oncomplete = resolve;
              delTx.onerror = () => reject(delTx.error);
          });
        }
      } catch (e) {
        console.warn('SW sync failed for item', item.id, e);
      }
    }

    db.close();
  } catch (e) {
    console.error('SW syncFromQueue error:', e);
  }
}
