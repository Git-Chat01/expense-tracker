/* ================================================================
   消费轨迹系统 — Service Worker
   PWA 离线缓存：首次访问后，无网络也能打开
   ================================================================ */

const CACHE_NAME = 'expense-tracker-v3';

// 需要预缓存的核心文件
const PRE_CACHE = [
  './',
  'index.html',
  'css/common.css',
  'css/home.css',
  'css/add.css',
  'css/list.css',
  'css/stats.css',
  'js/storage.js',
  'js/data.js',
  'js/home.js',
  'js/categories.js',
  'js/list.js',
  'js/stats.js',
  'js/app.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
];

/* -----------------------------------------------------------------
   安装：预缓存核心文件
   ----------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRE_CACHE).catch((err) => {
        // 部分文件加载失败不影响 SW 安装（如 CDN 资源）
        console.warn('SW: pre-cache partial fail', err);
      });
    })
  );
  // 不等待旧 SW，立即激活
  self.skipWaiting();
});

/* -----------------------------------------------------------------
   激活：清理旧版本缓存 + 通知页面刷新
   ----------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => {
      // 接管所有客户端后，通知页面有新版本可用
      return self.clients.claim();
    }).then(() => {
      // 通知所有打开的页面：SW 已更新，请刷新
      self.clients.matchAll().then(function(clients) {
        clients.forEach(function(client) {
          client.postMessage({ type: 'SW_UPDATED' });
        });
      });
    })
  );
});

/* -----------------------------------------------------------------
   请求拦截：缓存优先，网络回退
   ----------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  // 只处理 GET 请求
  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) {
        // 缓存命中 → 后台更新（下次访问拿到最新版本）
        const fetched = fetch(event.request).then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, clone);
            });
          }
          return response;
        }).catch(() => null);
        return cached;
      }

      // 缓存未命中 → 走网络，失败回退
      return fetch(event.request).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, clone);
          });
        }
        return response;
      }).catch(() => {
        // 网络不可用且缓存也无 → 对于 HTML 请求返回离线页
        if (event.request.headers.get('accept').includes('text/html')) {
          return caches.match('index.html');
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});
