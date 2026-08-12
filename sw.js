/* ================================================================
   消费轨迹系统 — Service Worker
   PWA 离线缓存：首次访问后，无网络也能打开
   ================================================================ */

const APP_VERSION = '220';
const CACHE_NAME = 'expense-tracker-v' + APP_VERSION;
const RELEASE_STATE_CACHE = 'expense-tracker-release-state';
const RELEASE_STATE_URL = new URL(
  'release-state-v' + APP_VERSION + '.json',
  self.registration.scope
).href;

// 需要预缓存的核心文件
const CORE_PRE_CACHE = [
  './',
  'index.html',
  'updates.json',
  'css/common.css',
  'css/home.css',
  'css/add.css',
  'css/add-flow-v213.css',
  'css/add-budget-impact-v214.css',
  'css/add-choice-density-v215.css',
  'css/add-payment-options-v217.css',
  'css/add-choice-alignment-v218.css',
  'css/list.css',
  'css/stats.css',
  'css/onboarding.css',
  'css/monthly-report-v220.css',
  'js/storage.js',
  'js/storage-v214.js',
  'js/data.js',
  'js/icons.js',
  'js/home.js',
  'js/categories.js',
  'js/list.js',
  'js/stats.js',
  'js/monthly-report-v220.js',
  'js/onboarding.js',
  'js/app.js',
  'js/app-v217.js',
  'js/budget-impact-v214.js',
  'js/update-flow-v216.js',
  'js/vendor-chart.umd-4.4.7.min.js',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
];

function readReleaseState() {
  return caches.open(RELEASE_STATE_CACHE)
    .then((cache) => cache.match(RELEASE_STATE_URL))
    .then((response) => response ? response.json() : null);
}

function writeReleaseState(phase) {
  const state = {
    version: APP_VERSION,
    phase,
    updatedAt: Date.now(),
  };
  return caches.open(RELEASE_STATE_CACHE).then((cache) => {
    return cache.put(RELEASE_STATE_URL, new Response(JSON.stringify(state), {
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    }));
  });
}

function finalizeReleaseState() {
  return readReleaseState().then((state) => {
    // 安装时存在旧 active Worker，但没有页面继续占用它时，浏览器会自动激活新版。
    if (state && state.version === APP_VERSION && state.phase === 'pending') {
      return writeReleaseState('automatic');
    }
    return undefined;
  });
}

/* -----------------------------------------------------------------
   安装：预缓存核心文件
   ----------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  const installPhase = self.registration.active ? 'pending' : 'fresh';
  event.waitUntil(
    Promise.all([
      caches.open(CACHE_NAME).then((cache) => {
        // 同源核心文件必须完整写入；任何一项失败都阻止不完整 Worker 安装。
        return cache.addAll(CORE_PRE_CACHE);
      }),
      writeReleaseState(installPhase).catch((err) => {
        // 更新状态只用于补提示；失败不能阻止核心应用安装。
        console.warn('SW: release state write fail', err);
      }),
    ])
  );
  // 新版本下载后保持 waiting，等用户在页面中确认“立即更新”后再激活。
});

// 用户确认更新后，页面向 waiting 的新版本发送此消息。
self.addEventListener('message', (event) => {
  if (event.data === 'skipWaiting') {
    event.waitUntil(
      writeReleaseState('confirmed')
        .catch((err) => {
          console.warn('SW: release confirmation write fail', err);
        })
        .then(() => self.skipWaiting())
    );
  }
});

/* -----------------------------------------------------------------
   激活：清理旧版本缓存 + 通知页面刷新
   ----------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    finalizeReleaseState().catch((err) => {
      // 元数据失败只会少一次“已更新”提示，不影响缓存切换。
      console.warn('SW: release state finalize fail', err);
    }).then(() => caches.keys()).then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME && key !== RELEASE_STATE_CACHE)
          .map((key) => caches.delete(key))
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
