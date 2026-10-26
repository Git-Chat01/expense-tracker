/* ================================================================
   消费轨迹系统 — 更新确认与更新完成提示（v229）

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
  var previousController = navigator.serviceWorker.controller;
  var activatedWorker = null;
  var updateRequestedByThisPage = false;
  var workerVersions = new WeakMap();
  var workerVersionRequests = new WeakMap();

  // 版本来自目标 Worker 本身，不能把可能滞后的 updates.json 首项当成目标版本。
  function getWorkerVersion(worker) {
    if (!worker || typeof MessageChannel === 'undefined') return Promise.resolve('');
    if (workerVersions.has(worker)) return Promise.resolve(workerVersions.get(worker));
    if (workerVersionRequests.has(worker)) return workerVersionRequests.get(worker);
    var request = new Promise(function(resolve) {
      var channel = new MessageChannel();
      var complete = false;
      var timer;
      function finish(version) {
        if (complete) return;
        complete = true;
        clearTimeout(timer);
        channel.port1.close();
        channel.port2.close();
        if (version) workerVersions.set(worker, version);
        resolve(version);
      }
      channel.port1.onmessage = function(event) {
        var data = event.data;
        if (data && data.type === 'SW_VERSION' && /^\d+$/.test(String(data.version))) {
          finish(String(data.version));
        }
      };
      timer = setTimeout(function() { finish(''); }, 1500);
      try { worker.postMessage({ type: 'GET_VERSION' }, [channel.port2]); }
      catch (err) { finish(''); }
    }).then(function(version) {
      workerVersionRequests.delete(worker);
      return version;
    });
    workerVersionRequests.set(worker, request);
    return request;
  }

  function hasUnsavedDraft() {
    try {
      // 主应用尚未准备好或状态读取失败时，保守保留页面，不能假定没有草稿。
      return typeof ExpenseApp === 'undefined' || typeof ExpenseApp.hasUnsavedDraft !== 'function'
        ? true : Boolean(ExpenseApp.hasUnsavedDraft());
    } catch (err) { return true; }
  }

  function guardDraft() {
    if (!hasUnsavedDraft()) return false;
    updateRequestedByThisPage = false;
    updateBtn.disabled = false;
    subEl.textContent = '请先保存或处理未完成的内容，再更新；当前输入仍然保留';
    return true;
  }

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
    var items = changelogItems || ['更新说明暂未同步，请稍后重新展开查看'];
    listEl.textContent = '';
    items.forEach(function(text) {
      var item = document.createElement('li');
      item.textContent = text;
      listEl.appendChild(item);
    });
  }

  function isDeferred() {
    return Boolean((cardMode === 'waiting' || cardMode === 'reload') && pendingVersion && (
      deferRequested || getSessionValue(DEFERRED_VERSION_KEY) === pendingVersion
    ));
  }

  function syncUpdateSummary() {
    if (cardMode === 'applied') {
      titleEl.textContent = pendingVersion ? '已更新到 v' + pendingVersion : '应用已更新';
      subEl.textContent = '点击查看这次更新内容';
      return;
    }

    titleEl.textContent = cardMode === 'reload' ? '新版本已就绪' : '发现新版本';
    if (!pendingVersion) {
      subEl.textContent = '正在确认目标版本；当前页面可继续使用';
      return;
    }
    if (cardMode === 'reload') {
      subEl.textContent = 'v' + pendingVersion + ' 已就绪，处理好未保存内容后重新加载';
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
    var targetWorker = requestMode === 'waiting' ? displayedWaitingWorker : activatedWorker;
    changelogLoading = (requestMode === 'applied'
      ? Promise.resolve(currentVersion) : getWorkerVersion(targetWorker))
      .then(function(version) {
        if (requestId !== changelogRequestId || requestMode !== cardMode) return null;
        pendingVersion = version;
        bar.setAttribute('data-target-version', version);
        syncUpdateSummary();
        return fetch('updates.json?v=' + Date.now());
      })
      .then(function(res) { return res && res.ok ? res.json() : null; })
      .then(function(data) {
        if (requestId !== changelogRequestId || requestMode !== cardMode) return;
        if (data && data.versions && data.versions.length) {
          var entry = null;
          data.versions.some(function(candidate) {
            if (!pendingVersion || String(candidate.version) !== pendingVersion) return false;
            entry = candidate;
            return true;
          });
          if (entry && Array.isArray(entry.items)) changelogItems = entry.items.filter(function(item) { return typeof item === 'string'; });
          if (requestMode !== 'applied' && deferRequested && pendingVersion) {
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
    updateBtn.textContent = mode === 'applied' ? '知道了' : (mode === 'reload' ? '重新加载更新' : '立即更新');
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
    if (cardMode === 'waiting' || cardMode === 'reload') return;
    configureCard('applied');
  }

  function showReloadBar(worker) {
    var changed = worker !== activatedWorker;
    activatedWorker = worker || navigator.serviceWorker.controller;
    configureCard('reload', changed);
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
    if (cardMode !== 'waiting' && cardMode !== 'reload') return;
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

    if (guardDraft()) return;
    if (cardMode === 'reload') {
      reloadConfirmedPage();
      return;
    }

    // 立即更新只确认当前页；其他页继续保留输入，等各自处理完再重载。
    navigator.serviceWorker.ready.then(function(reg) {
      if (guardDraft()) return;
      if (!reg.waiting) {
        getWorkerVersion(navigator.serviceWorker.controller).then(function(version) {
          if (version && version !== currentVersion) showReloadBar(navigator.serviceWorker.controller);
          else {
            updateBtn.disabled = false;
            subEl.textContent = '暂未找到待更新版本，请稍后重试';
          }
        });
        return;
      }
      updateRequestedByThisPage = true;
      deferRequested = false;
      removeSessionValue(DEFERRED_VERSION_KEY);
      updateBtn.disabled = true;
      updateBtn.textContent = '正在更新…';
      setExpanded(false, false);
      reg.waiting.postMessage('skipWaiting');
      if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
      scrollHomeToTop();
    }).catch(function() {
      updateRequestedByThisPage = false;
      updateBtn.disabled = false;
      updateBtn.textContent = '立即更新';
    });
  });

  // 只重载本页明确确认、且此刻没有未保存输入的页面。
  var refreshing = false;
  function reloadConfirmedPage() {
    if (refreshing) return;
    if (guardDraft()) return;
    refreshing = true;
    setSessionValue(JUST_UPDATED_KEY, String(Date.now()));
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    scrollHomeToTop();
    window.location.reload();
  }

  navigator.serviceWorker.addEventListener('controllerchange', function() {
    var controller = navigator.serviceWorker.controller;
    var hadController = Boolean(previousController);
    previousController = controller;
    if (!controller || refreshing) return;
    if (updateRequestedByThisPage && !hasUnsavedDraft()) {
      reloadConfirmedPage();
      return;
    }
    updateRequestedByThisPage = false;
    getWorkerVersion(controller).then(function(version) {
      if (controller !== navigator.serviceWorker.controller || refreshing) return;
      // 首次安装接管本页只建立离线能力，不刷新、不误报“已更新”。
      if (!hadController && (!version || version === currentVersion)) return;
      if (version === currentVersion) return;
      showReloadBar(controller);
    });
  });
})();
