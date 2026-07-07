/* ================================================================
   消费轨迹系统 — Service Worker
   PWA 离线缓存：首次访问后，无网络也能打开
   ================================================================ */

const CACHE_NAME = 'expense-tracker-v109';

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
  // 不自动 skipWaiting，等用户点击"更新"按钮后页面发消息再激活
});

// 接收页面发来的 skipWaiting 指令（用户点击更新按钮）
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    self.skipWaiting();
  }
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
   请求拦截：网络优先，缓存回退
   这样每次打开 PWA（有网时）都能拿到最新版本，不会卡在旧缓存里
   离线时仍可使用缓存版本
   ----------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  // SW 脚本本身的更新请求不走缓存（浏览器自行处理，这里显式放行）
  if (event.request.url.includes('sw.js')) return;

  event.respondWith(
    fetch(event.request).then((response) => {
      // 网络请求成功 → 更新缓存，返回最新内容
      if (response && response.status === 200) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, clone);
        });
      }
      return response;
    }).catch(() => {
      // 网络不可用 → 使用缓存
      return caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // HTML 请求特殊回退
        if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
          return caches.match('index.html');
        }
        return new Response('离线不可用', { status: 503 });
      });
    })
  );
});
