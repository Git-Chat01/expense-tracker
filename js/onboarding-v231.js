/* ================================================================
   消费轨迹系统 — onboarding.js
   ExpenseOnboarding 命名空间：新手引导（首次访问全屏分步介绍）
   触发条件：settings.onboardingSeen !== true
   由 app.js init() 末尾调用 start()
   ================================================================ */

const ExpenseOnboarding = (() => {
  'use strict';

  /* -----------------------------------------------------------------
     引导步骤内容（图标 / 标题 / 描述）
     按实际需求修改文案只需改这个数组，无需动 HTML 或 CSS
     ----------------------------------------------------------------- */
  const STEPS = [
    { icon: 'pen-line', title: '记下第一笔支出', desc: '在「记一笔」里输入金额、选好分类，就可以保存。地点和备注按需填写。' },
    { icon: 'wallet', title: '看看这个月花了多少', desc: '首页汇总本月支出。设好预算后，还能看到本月剩余和每天可花的金额。' },
    { icon: 'book', title: '备份你的账本', desc: '账本保存在当前浏览器。换设备或清理浏览器前，请到首页「数据与备份」导出一份。' },
  ];

  const SWIPE_THRESHOLD = 50; // 滑动切换最小距离（px）

  /* 缓存 DOM 引用，start() 时初始化 */
  let _overlay, _track, _dots, _nextBtn, _skipBtn;
  let _index = 0;
  let _touchStartX = 0;
  let _bound = false;  // 事件只绑定一次

  /* -----------------------------------------------------------------
     入口：由 app.js init() 在首页渲染完成后调用
     ----------------------------------------------------------------- */
  function start() {
    // settings 中已有 onboardingSeen → 不展示
    if (ExpenseDB.getSettings().onboardingSeen === true) return;

    _overlay = document.getElementById('onboarding-overlay');
    _track   = document.getElementById('onboarding-track');
    _dots    = document.getElementById('onboarding-dots');
    _nextBtn = document.getElementById('onboarding-next');
    _skipBtn = document.getElementById('onboarding-skip');

    if (!_overlay || !_track || !_dots || !_nextBtn || !_skipBtn) return;

    _renderSlides();
    _renderDots();
    if (!_bound) { _bindEvents(); _bound = true; }

    _index = 0;
    _update();
    _overlay.classList.add('onboarding-overlay--open');
    _nextBtn.focus({ preventScroll: true });
  }

  /* -----------------------------------------------------------------
     渲染步骤卡片（由 STEPS 数组驱动，一次生成全部，靠 translateX 切换）
     ----------------------------------------------------------------- */
  function _renderSlides() {
    _track.innerHTML = STEPS.map(s => `
      <div class="onboarding-slide">
        <div class="onboarding-slide__icon" aria-hidden="true"><svg viewBox="0 0 24 24">${ExpenseIcons.CATEGORY_ICON_PATHS[s.icon]}</svg></div>
        <h2 class="onboarding-slide__title">${s.title}</h2>
        <p class="onboarding-slide__desc">${s.desc}</p>
      </div>
    `).join('');
  }

  function _renderDots() {
    _dots.innerHTML = STEPS.map((_, i) =>
      `<span class="onboarding-dot" data-dot="${i}" aria-hidden="true"></span>`
    ).join('');
  }

  /* -----------------------------------------------------------------
     状态同步：滑动轨道位置 + 圆点高亮 + 按钮文案
     ----------------------------------------------------------------- */
  function _update() {
    _track.style.transform = `translateX(${-_index * 100}%)`;
    Array.from(_track.children).forEach((slide, i) => {
      slide.setAttribute('aria-hidden', String(i !== _index));
    });
    const step = STEPS[_index];
    document.getElementById('onboarding-progress').textContent = `第 ${_index + 1} 步，共 ${STEPS.length} 步 · ${step.title}`;

    _dots.querySelectorAll('.onboarding-dot').forEach((dot, i) => {
      dot.classList.toggle('onboarding-dot--active', i === _index);
    });

    const isLast = _index === STEPS.length - 1;
    _nextBtn.textContent = isLast ? '开始使用' : '下一步';
  }

  /* -----------------------------------------------------------------
     导航逻辑
     ----------------------------------------------------------------- */
  function _next() {
    if (_index < STEPS.length - 1) {
      _index++;
      _update();
    } else {
      _finish();
    }
  }

  function _prev() {
    if (_index > 0) {
      _index--;
      _update();
    }
  }

  /**
   * 结束引导：写入 settings 后关闭覆盖层。
   * saveSettings 是浅合并，只更新 onboardingSeen 字段，不会覆盖其他设置。
   */
  function _finish() {
    if (!ExpenseDB.saveSettings({ onboardingSeen: true })) {
      if (typeof ExpenseApp !== 'undefined') {
        ExpenseApp.showToast('设置保存失败，操作已停止且原设置未覆盖。请勿清理浏览器数据，重新打开后重试', 'warning', { duration: 6000 });
      }
      return;
    }
    _overlay.classList.remove('onboarding-overlay--open');
    document.getElementById('home-primary-add')?.focus({ preventScroll: true });
  }

  /* -----------------------------------------------------------------
     事件绑定（只执行一次，由 _bound 标志控制）
     ----------------------------------------------------------------- */
  function _bindEvents() {
    // 下一步 / 开始使用
    _nextBtn.addEventListener('click', _next);

    // 跳过 → 直接结束
    _skipBtn.addEventListener('click', _finish);

    // 触摸滑动切换（只在引导卡片区域监听，避免遮罩区域误触）
    _track.addEventListener('touchstart', function (e) {
      _touchStartX = e.touches[0].clientX;
    }, { passive: true });

    _track.addEventListener('touchend', function (e) {
      var dx = e.changedTouches[0].clientX - _touchStartX;
      if (Math.abs(dx) < SWIPE_THRESHOLD) return;
      if (dx < 0) { _next(); } else { _prev(); }
    }, { passive: true });

    // 桌面端 Esc 键关闭（仅在引导打开时生效，避免影响其他功能）
    document.addEventListener('keydown', function (e) {
      if (!_overlay.classList.contains('onboarding-overlay--open')) return;
      if (e.key === 'Escape') {
        e.preventDefault();
        _finish();
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        (document.activeElement === _nextBtn ? _skipBtn : _nextBtn).focus();
      }
    });
  }

  /* -----------------------------------------------------------------
     公开 API
     ----------------------------------------------------------------- */
  return { start };
})();
