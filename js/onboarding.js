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
    { icon: '✍️', title: '让每一笔消费都有迹可循', desc: '3秒完成记录，不打扰你的生活节奏' },
    { icon: '📊', title: '你的消费，看得见',       desc: '分类占比、月度趋势、地点排行，用图表读懂消费' },
    { icon: '🎯', title: '预算在手，心里有数',     desc: '设置月度预算，超支自动提醒，告别月光' },
    { icon: '🔒', title: '数据安全，始终在本地',   desc: '所有数据只存在你的浏览器中，可随时导出备份' },
    { icon: '🚀', title: '从第一笔记账开始',       desc: '记录真实消费，让数据为你讲述消费故事' },
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
  }

  /* -----------------------------------------------------------------
     渲染步骤卡片（由 STEPS 数组驱动，一次生成全部，靠 translateX 切换）
     ----------------------------------------------------------------- */
  function _renderSlides() {
    _track.innerHTML = STEPS.map(s => `
      <div class="onboarding-slide">
        <div class="onboarding-slide__icon" aria-hidden="true">${s.icon}</div>
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
        ExpenseApp.showToast('设置保存失败，请检查浏览器存储空间', 'warning');
      }
      return;
    }
    _overlay.classList.remove('onboarding-overlay--open');
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
      if (e.key === 'Escape' && _overlay.classList.contains('onboarding-overlay--open')) {
        _finish();
      }
    });
  }

  /* -----------------------------------------------------------------
     公开 API
     ----------------------------------------------------------------- */
  return { start };
})();
