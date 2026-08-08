/* ================================================================
   消费轨迹系统 — Service Worker
   PWA 离线缓存：首次访问后，无网络也能打开
   ================================================================ */

const CACHE_NAME = 'expense-tracker-v212';

// 需要预缓存的核心文件
const CORE_PRE_CACHE = [
  './',
  'index.html',
  'updates.json',
  'css/common.css',
  'css/home.css',
  'css/add.css',
  'css/add-numpad-v212.css',
  'css/list.css',
  'css/stats.css',
  'css/onboarding.css',
  'js/storage.js',
  'js/data.js',
  'js/icons.js',
  'js/home.js',
  'js/categories.js',
  'js/list.js',
  'js/stats.js',
  'js/onboarding.js',
  'js/app.js',
  'js/add-numpad-v212.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
];

const OPTIONAL_PRE_CACHE = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js',
];

/* -----------------------------------------------------------------
   安装：预缓存核心文件
   ----------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // 同源核心文件必须完整写入；任何一项失败都阻止不完整 Worker 安装。
      return cache.addAll(CORE_PRE_CACHE).then(() => {
        // 第三方图表为可选增强，失败时统计页会使用既有 CSS 降级展示。
        return Promise.all(OPTIONAL_PRE_CACHE.map((url) => {
          return cache.add(url).catch((err) => {
            console.warn('SW: optional pre-cache fail', url, err);
          });
        }));
      });
    })
  );
  // 新版本下载后保持 waiting，等用户在页面中确认“立即更新”后再激活。
});

// 用户确认更新后，页面向 waiting 的新版本发送此消息。
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
      return caches.open(CACHE_NAME).then((cache) => cache.match(event.request, { ignoreSearch: true })).then((cached) => {
        if (cached) return cached;
        // HTML 请求特殊回退
        if (event.request.headers.get('accept') && event.request.headers.get('accept').includes('text/html')) {
          return caches.open(CACHE_NAME).then((cache) => cache.match('index.html'));
        }
        return new Response('离线不可用', { status: 503 });
      });
    })
  );
});
