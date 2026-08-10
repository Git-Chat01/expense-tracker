/* ================================================================
   消费轨迹系统 — 更新确认与更新完成提示（v216）

   - waiting：保留“先看说明，再决定是否立即更新”的确认流程
   - applied：浏览器在无旧页面时自动激活后，补一次诚实的“已更新”说明
   - 页面回到前台、恢复显示或重新联网时，主动检查新版本
   ================================================================ */
(function() {
  'use strict';

  if (!('serviceWorker' in navigator)) return;

  var versionEl = document.getElementById('app-version');
  var bar = document.getElementById('sw-update-bar');
  var head = document.getElementById('sw-update-bar-head');
  var detail = document.getElementById('sw-update-bar-detail');
  var listEl = document.getElementById('sw-update-bar-list');
  var titleEl = document.getElementById('sw-update-bar-title');
  var subEl = bar ? bar.querySelector('.sw-update-bar__sub') : null;
  var laterBtn = document.getElementById('sw-update-btn-later');
  var updateBtn = document.getElementById('sw-update-btn-now');
  var homeView = document.getElementById('view-home');
  var tabBar = document.querySelector('.tab-bar');
  if (!versionEl || !bar || !head || !detail || !listEl || !titleEl || !subEl || !laterBtn || !updateBtn) return;

  var DEFERRED_VERSION_KEY = 'sw-deferred-update-version';
  var JUST_UPDATED_KEY = 'sw-just-updated';
  var RELEASE_STATE_CACHE = 'expense-tracker-release-state';
  var UPDATE_CHECK_INTERVAL = 15000;
  var currentVersion = String(versionEl.getAttribute('data-version') || '').trim();
  var releaseStateUrl = currentVersion
    ? new URL('release-state-v' + currentVersion + '.json', window.location.href).href
    : '';

  var cardMode = 'hidden';
  var changelogItems = null;
  var pendingVersion = '';
  var changelogLoading = null;
  var changelogRequestId = 0;
  var deferRequested = false;
  var scrollFrame = 0;
  var registration = null;
  var watchedRegistration = null;
  var watchedWorker = null;
  var displayedWaitingWorker = null;
  var updateCheck = null;
  var lastUpdateCheckAt = 0;

  function getSessionValue(key) {
    try { return sessionStorage.getItem(key) || ''; } catch (err) { return ''; }
  }

  function setSessionValue(key, value) {
    try { sessionStorage.setItem(key, value); } catch (err) { /* 会话存储不可用时不影响更新 */ }
  }

  function removeSessionValue(key) {
    try { sessionStorage.removeItem(key); } catch (err) { /* 会话存储不可用时不影响更新 */ }
  }

  function readReleaseState() {
    if (!releaseStateUrl || !('caches' in window)) return Promise.resolve(null);
    return caches.open(RELEASE_STATE_CACHE)
      .then(function(cache) { return cache.match(releaseStateUrl); })
      .then(function(response) { return response ? response.json() : null; })
      .catch(function() { return null; });
  }

  function acknowledgeAppliedRelease() {
    if (!releaseStateUrl || !('caches' in window)) {
      return Promise.reject(new Error('Release state cache is unavailable'));
    }
    var state = {
      version: currentVersion,
      phase: 'acknowledged',
      updatedAt: Date.now(),
    };
    return caches.open(RELEASE_STATE_CACHE).then(function(cache) {
      return cache.put(releaseStateUrl, new Response(JSON.stringify(state), {
        headers: { 'Content-Type': 'application/json; charset=utf-8' },
      }));
    });
  }

  function resetChangelog() {
    changelogRequestId += 1;
    changelogItems = null;
    changelogLoading = null;
    pendingVersion = cardMode === 'applied' ? currentVersion : '';
  }

  function renderChangelog() {
    var items = changelogItems || ['本次更新优化了体验与稳定性'];
    listEl.textContent = '';
    items.forEach(function(text) {
      var item = document.createElement('li');
      item.textContent = text;
      listEl.appendChild(item);
    });
  }

  function isDeferred() {
    return Boolean(cardMode === 'waiting' && pendingVersion && (
      deferRequested || getSessionValue(DEFERRED_VERSION_KEY) === pendingVersion
    ));
  }

  function syncUpdateSummary() {
    if (cardMode === 'applied') {
      titleEl.textContent = pendingVersion ? '已更新到 v' + pendingVersion : '应用已更新';
      subEl.textContent = '点击查看这次更新内容';
      return;
    }

    titleEl.textContent = '发现新版本';
    if (!pendingVersion) {
      subEl.textContent = '点击查看这次更新内容';
      return;
    }
    subEl.textContent = isDeferred()
      ? 'v' + pendingVersion + ' 已选择继续使用当前版本'
      : 'v' + pendingVersion + ' 已就绪 · 点击查看更新内容';
  }

  function fillChangelog() {
    if (changelogItems) {
      renderChangelog();
      syncUpdateSummary();
      return Promise.resolve();
    }
    if (changelogLoading) return changelogLoading;

    var requestMode = cardMode;
    var requestId = ++changelogRequestId;
    changelogLoading = fetch('updates.json?v=' + Date.now())
      .then(function(res) { return res.ok ? res.json() : null; })
      .then(function(data) {
        if (requestId !== changelogRequestId || requestMode !== cardMode) return;
        if (data && data.versions && data.versions.length) {
          var entry = null;
          if (requestMode === 'applied' && currentVersion) {
            data.versions.some(function(candidate) {
              if (String(candidate.version) !== currentVersion) return false;
              entry = candidate;
              return true;
            });
            // CDN 可能暂时返回旧 updates.json；此时保留真实当前版本和兜底说明，绝不冒充旧版本。
            pendingVersion = currentVersion;
          } else {
            entry = data.versions[0];
            pendingVersion = String(entry.version || data.latest || pendingVersion || '');
          }
          if (entry && entry.items) changelogItems = entry.items;
          if (requestMode === 'waiting' && deferRequested && pendingVersion) {
            setSessionValue(DEFERRED_VERSION_KEY, pendingVersion);
          }
        }
        syncUpdateSummary();
        renderChangelog();
      })
      .catch(function() {
        if (requestId !== changelogRequestId || requestMode !== cardMode) return;
        syncUpdateSummary();
        renderChangelog();
      })
      .then(function() {
        if (requestId === changelogRequestId && requestMode === cardMode) {
          changelogLoading = null;
        }
      });
    return changelogLoading;
  }

  function cancelUpdateCardAlignment() {
    if (scrollFrame) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = 0;
    }
  }

  function getUpdateScrollContainer() {
    if (homeView && homeView.scrollHeight > homeView.clientHeight + 1) return homeView;
    return null;
  }

  function moveScrollableElementBy(target, offset, behavior) {
    if (!target || Math.abs(offset) < 1) return 0;

    var maxScrollTop = Math.max(0, target.scrollHeight - target.clientHeight);
    var available = offset > 0
      ? maxScrollTop - target.scrollTop
      : target.scrollTop;
    var applied = Math.sign(offset) * Math.min(Math.abs(offset), Math.max(0, available));
    if (Math.abs(applied) < 1) return 0;

    if (typeof target.scrollBy === 'function') {
      target.scrollBy({ top: applied, behavior: behavior });
    } else {
      target.scrollTop += applied;
    }
    return applied;
  }

  function moveUpdateCardBy(offset, behavior) {
    if (Math.abs(offset) < 1) return;

    var target = getUpdateScrollContainer();
    var remaining = offset - moveScrollableElementBy(target, offset, behavior);
    if (Math.abs(remaining) >= 1) window.scrollBy({ top: remaining, behavior: behavior });
  }

  function resetScrollTop(target) {
    if (!target) return;
    target.scrollTop = 0;
    try { target.scrollTo(0, 0); } catch (err) { /* 部分移动端对象不支持 scrollTo */ }
  }

  function scrollHomeToTop() {
    cancelUpdateCardAlignment();
    window.scrollTo(0, 0);
    resetScrollTop(document.documentElement);
    resetScrollTop(document.body);
    resetScrollTop(homeView);
  }

  // 更新卡位于首页末尾。展开后把完整内容避开底部导航；收起后回到紧凑位置。
  function alignUpdateCard(expanded) {
    cancelUpdateCardAlignment();
    scrollFrame = window.requestAnimationFrame(function() {
      scrollFrame = window.requestAnimationFrame(function() {
        scrollFrame = 0;
        if (bar.hidden) return;

        var cardRect = bar.getBoundingClientRect();
        var tabRect = tabBar ? tabBar.getBoundingClientRect() : null;
        var viewRect = homeView ? homeView.getBoundingClientRect() : null;
        var visibleTop = Math.max(12, viewRect ? viewRect.top + 12 : 12);
        var visibleBottom = Math.min(
          window.innerHeight - 12,
          tabRect ? tabRect.top - 12 : window.innerHeight - 12,
          viewRect ? viewRect.bottom - 12 : window.innerHeight - 12
        );
        if (visibleBottom <= visibleTop) return;

        var offset = 0;
        if (cardRect.bottom > visibleBottom) {
          offset = cardRect.bottom - visibleBottom;
        } else if (expanded && cardRect.top < visibleTop) {
          offset = cardRect.top - visibleTop;
        } else if (!expanded && cardRect.bottom < visibleBottom - 8) {
          offset = cardRect.bottom - (visibleBottom - 8);
        }
        moveUpdateCardBy(offset, 'smooth');
      });
    });
  }

  function setExpanded(expanded, shouldAlign) {
    detail.hidden = !expanded;
    head.setAttribute('aria-expanded', String(expanded));
    if (shouldAlign === false) {
      cancelUpdateCardAlignment();
    } else {
      alignUpdateCard(expanded);
    }
  }

  function configureCard(mode, forceReset) {
    if (cardMode !== mode || forceReset) {
      cardMode = mode;
      resetChangelog();
      setExpanded(false, false);
    }

    bar.setAttribute('data-mode', mode);
    laterBtn.hidden = mode === 'applied';
    updateBtn.disabled = false;
    updateBtn.textContent = mode === 'applied' ? '知道了' : '立即更新';
    updateBtn.style.marginLeft = mode === 'applied' ? 'auto' : '';
    versionEl.hidden = true;
    bar.hidden = false;
    syncUpdateSummary();
    fillChangelog();
  }

  function showWaitingBar(worker) {
    var nextWorker = worker || (registration && registration.waiting) || null;
    var workerChanged = Boolean(
      nextWorker && displayedWaitingWorker && nextWorker !== displayedWaitingWorker
    );
    var shouldReset = cardMode !== 'waiting' || workerChanged;
    if (workerChanged) deferRequested = false;
    if (nextWorker) displayedWaitingWorker = nextWorker;
    configureCard('waiting', shouldReset);
  }

  function showAppliedBar() {
    if (cardMode === 'waiting') return;
    configureCard('applied');
  }

  function hideAppliedBar() {
    setExpanded(false, false);
    bar.hidden = true;
    versionEl.hidden = false;
    cardMode = 'hidden';
  }

  function watchInstallingWorker(worker) {
    if (!worker || watchedWorker === worker) return;
    watchedWorker = worker;
    worker.addEventListener('statechange', function() {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        showWaitingBar(worker);
      }
    });
  }

  function watchRegistration(reg) {
    if (!reg || watchedRegistration === reg) return;
    watchedRegistration = reg;
    reg.addEventListener('updatefound', function() {
      watchInstallingWorker(reg.installing);
    });
    watchInstallingWorker(reg.installing);
  }

  function checkForUpdates(reg, force) {
    if (!reg) return Promise.resolve();
    if (reg.waiting) showWaitingBar(reg.waiting);
    if (updateCheck) return updateCheck;

    var now = Date.now();
    if (!force && now - lastUpdateCheckAt < UPDATE_CHECK_INTERVAL) return Promise.resolve();
    lastUpdateCheckAt = now;

    updateCheck = reg.update()
      .then(function() {
        if (reg.waiting) showWaitingBar(reg.waiting);
      })
      .catch(function() { /* 离线或浏览器拒绝检查时继续使用现有版本 */ })
      .then(function() {
        updateCheck = null;
      });
    return updateCheck;
  }

  function requestUpdateCheck(force) {
    if (registration) return checkForUpdates(registration, force);
    return navigator.serviceWorker.ready.then(function(reg) {
      registration = reg;
      watchRegistration(reg);
      return checkForUpdates(reg, force);
    });
  }

  var justUpdated = getSessionValue(JUST_UPDATED_KEY);
  var suppressAppliedCard = Boolean(justUpdated && Date.now() - parseInt(justUpdated, 10) < 3000);
  if (justUpdated) removeSessionValue(JUST_UPDATED_KEY);

  navigator.serviceWorker.ready.then(function(reg) {
    registration = reg;
    watchRegistration(reg);
    if (reg.waiting) showWaitingBar(reg.waiting);

    return readReleaseState().then(function(state) {
      if (!suppressAppliedCard && state && state.version === currentVersion && state.phase === 'automatic') {
        showAppliedBar();
      }
    }).then(function() {
      return checkForUpdates(reg, true);
    });
  });

  // PWA 从后台恢复时不会重新执行页面脚本，因此在这些生命周期节点补做检查。
  document.addEventListener('visibilitychange', function() {
    if (document.visibilityState === 'visible') requestUpdateCheck(false);
  });
  window.addEventListener('pageshow', function() {
    requestUpdateCheck(false);
  });
  window.addEventListener('online', function() {
    if (cardMode !== 'hidden' && !changelogItems) fillChangelog();
    requestUpdateCheck(true);
  });

  // 点击条头部：展开/收起更新内容。
  head.addEventListener('click', function() {
    var expanded = detail.hidden;
    setExpanded(expanded);
    if (expanded) {
      renderChangelog();
      fillChangelog().then(function() {
        if (!detail.hidden) alignUpdateCard(true);
      });
    }
  });

  // 继续当前版本：收起卡片并记住本次选择，仍可随时重新打开更新。
  laterBtn.addEventListener('click', function() {
    if (cardMode !== 'waiting') return;
    deferRequested = true;
    if (pendingVersion) setSessionValue(DEFERRED_VERSION_KEY, pendingVersion);
    setExpanded(false);
    syncUpdateSummary();
  });

  updateBtn.addEventListener('click', function() {
    if (updateBtn.disabled) return;

    if (cardMode === 'applied') {
      updateBtn.disabled = true;
      updateBtn.textContent = '正在确认…';
      acknowledgeAppliedRelease().then(function() {
        hideAppliedBar();
      }).catch(function() {
        updateBtn.disabled = false;
        updateBtn.textContent = '重试';
        subEl.textContent = '暂时无法记住确认状态，请重试';
      });
      return;
    }

    // 立即更新：仅由用户点此按钮激活 waiting 的新 Service Worker。
    navigator.serviceWorker.ready.then(function(reg) {
      if (!reg.waiting) {
        updateBtn.disabled = true;
        updateBtn.textContent = '已是最新版本';
        return;
      }
      deferRequested = false;
      removeSessionValue(DEFERRED_VERSION_KEY);
      setSessionValue(JUST_UPDATED_KEY, String(Date.now()));
      updateBtn.disabled = true;
      updateBtn.textContent = '正在更新…';
      setExpanded(false, false);
      reg.waiting.postMessage('skipWaiting');
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
      scrollHomeToTop();
    }).catch(function() {
      updateBtn.disabled = false;
      updateBtn.textContent = '立即更新';
    });
  });

  // SW 激活后刷新页面（确保回到顶部，不被浏览器还原滚动位置）。
  var refreshing = false;
  navigator.serviceWorker.addEventListener('controllerchange', function() {
    if (refreshing) return;
    refreshing = true;
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    scrollHomeToTop();
    window.location.reload();
  });
})();
