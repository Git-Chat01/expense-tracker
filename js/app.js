/* ================================================================
   消费轨迹系统 — app.js
   ExpenseApp 命名空间：主控制器
   初始化 / Tab 导航 / 数字键盘 / 记账流程 / Toast / 预算设置 / 编辑记录
   ================================================================ */

const ExpenseApp = (() => {
  'use strict';

  /* -----------------------------------------------------------------
     记账表单状态
     ----------------------------------------------------------------- */
  const _formState = {
    amountRaw: '',        // 原始输入字符串（如 "35" 或 "35.50"）
    categoryId: '',
    location: '',
    locationType: '',     // 'offline' | 'online' | ''
    paymentMethod: '',
    note: '',
    date: '',
    time: '',
  };

  let _currentView = 'home';
  let _editingExpenseId = null;  // 当前正在编辑的记录 ID（用于删除按钮）
  let _preEditView = 'home';     // 打开编辑面板前的页面，返回时用

  /* -----------------------------------------------------------------
     底部编辑面板的打开 / 关闭（同时控制面板和遮罩）
     ----------------------------------------------------------------- */
  function _openEditSheet() {
    const sheet = document.getElementById('overlay-edit');
    const backdrop = document.getElementById('overlay-edit-backdrop');
    if (sheet) sheet.classList.add('bottom-sheet--open');
    if (backdrop) backdrop.classList.add('bottom-sheet-backdrop--open');
  }

  function _closeEditSheet() {
    const sheet = document.getElementById('overlay-edit');
    const backdrop = document.getElementById('overlay-edit-backdrop');
    if (sheet) sheet.classList.remove('bottom-sheet--open');
    if (backdrop) backdrop.classList.remove('bottom-sheet-backdrop--open');
  }

  /* -----------------------------------------------------------------
     初始化入口
     ----------------------------------------------------------------- */
  function init() {
    // 1. 写入预设数据
    ExpenseData.initPresetData();

    // 2. 设置默认日期时间
    _resetFormDefaults();

    // 3. 渲染分类网格
    ExpenseCategories.renderGrid('add-category-grid', 'add-subcategories', (catId) => {
      _formState.categoryId = catId;
    });

    // 4. 渲染支付方式
    _renderPaymentMethods();

    // 5. 绑定事件
    _bindTabBar();
    _bindNumpad();
    _bindAddForm();
    _bindDateToggle();
    _bindOverlays();
    _bindHomeEvents();

    // 6. 初始化子模块的筛选/时段选择器
    if (typeof ExpenseList !== 'undefined') ExpenseList.initFilters();
    if (typeof ExpenseStats !== 'undefined') ExpenseStats.initPeriodSelector();

    // 7. 注册 Service Worker（PWA 离线缓存）
    //    带版本号强制检查更新；SW 激活后自动通知页面刷新
    if ('serviceWorker' in navigator) {
      // 监听 SW 发来的更新消息 → 自动刷新页面
      navigator.serviceWorker.addEventListener('message', function(event) {
        if (event.data && event.data.type === 'SW_UPDATED') {
          console.log('SW 已更新，自动刷新页面');
          window.location.reload();
        }
      });

      navigator.serviceWorker.register('sw.js?v=46').then(function(reg) {
        // 检测到 SW 更新 → 提示用户
        reg.addEventListener('updatefound', function() {
          var newWorker = reg.installing;
          if (!newWorker) return;
          newWorker.addEventListener('statechange', function() {
            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
              console.log('SW 有更新，即将刷新');
            }
          });
        });
      }).catch(function(err) {
        console.warn('SW registration failed:', err);
      });
    }

    // 8. 渲染首页
    ExpenseHome.render();
  }

  /* -----------------------------------------------------------------
     Tab 导航
     ----------------------------------------------------------------- */

  /** 将整个页面（window + body + html + 视图 + 所有子容器）滚回顶部。
   *  移动端浏览器（尤其是 iOS Safari）的实际滚动经常发生在 window 或 body/html
   *  层级，而不是 .main-view——光滚视图容器远远不够。 */
  function _scrollViewToTop(viewEl) {
    // 第一层：window / document 级别（移动端滚动最常出现在这里）
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.documentElement.scrollTo(0, 0);
    document.body.scrollTop = 0;
    document.body.scrollTo(0, 0);

    // 第二层：视图容器
    if (viewEl) {
      viewEl.scrollTop = 0;
      viewEl.scrollTo(0, 0);
    }

    // 第三层：所有子元素（stats-container / list-content 等嵌套滚动容器）
    var all = document.querySelectorAll('.main-view--active *');
    for (var i = 0; i < all.length; i++) {
      if (all[i].scrollTop > 0) {
        all[i].scrollTop = 0;
        try { all[i].scrollTo(0, 0); } catch (e) { /* ignore */ }
      }
    }
  }

  function navigate(viewId) {
    // 离开统计页时关闭 tooltip（否则 tooltip 是挂在 body 上的，不会随页面切换消失）
    if (_currentView === 'stats' && viewId !== 'stats' && typeof ExpenseStats !== 'undefined') {
      ExpenseStats.dismissTooltip();
    }

    // 切换 view 显示
    document.querySelectorAll('.main-view').forEach(v => v.classList.remove('main-view--active'));
    const target = document.getElementById(`view-${viewId}`);
    if (target) target.classList.add('main-view--active');

    // 切换 tab 高亮
    document.querySelectorAll('.tab-bar__item').forEach(t => t.classList.remove('tab-bar__item--active'));
    const tab = document.querySelector(`.tab-bar__item[data-view="${viewId}"]`);
    if (tab) tab.classList.add('tab-bar__item--active');

    _currentView = viewId;

    // 触发视图刷新
    if (viewId === 'home') {
      ExpenseHome.render();
    } else if (viewId === 'add') {
      _resetFormDefaults();
      ExpenseCategories.renderGrid('add-category-grid', 'add-subcategories', (catId) => {
        _formState.categoryId = catId;
      });
      _renderPaymentMethods();
      _updateAmountDisplay();
    } else if (viewId === 'list') {
      if (typeof ExpenseList !== 'undefined') ExpenseList.render();
    } else if (viewId === 'stats') {
      if (typeof ExpenseStats !== 'undefined') ExpenseStats.render();
    }

    // 切 Tab 后强制回到顶部。多时间点反复清零，因为：
    // - display:none→flex 后浏览器会异步恢复旧滚动位置（DOM 级别，晚于微任务）
    // - 移动端 Safari 的滚动恢复甚至可能在 rAF 之后
    // - render() 中的 DOM 操作也可能引起额外布局
    // 策略：立即 + rAF + rAF + setTimeout(100ms) 四连击，确保最终归零
    if (target) {
      _scrollViewToTop(target);
      requestAnimationFrame(function () {
        _scrollViewToTop(target);
        requestAnimationFrame(function () {
          _scrollViewToTop(target);
          setTimeout(function () {
            _scrollViewToTop(target);
          }, 100);
        });
      });
    }
  }

  function _bindTabBar() {
    document.querySelectorAll('.tab-bar__item').forEach(item => {
      item.addEventListener('click', () => {
        const viewId = item.dataset.view;
        if (viewId) navigate(viewId);
      });
    });
  }

  /* -----------------------------------------------------------------
     数字键盘逻辑
     ----------------------------------------------------------------- */
  /** 处理一次按键操作（数字键盘点击或物理键盘都走这里） */
  function _handleNumpadKey(k) {
    if (k === 'submit') {
      _handleSave();
    } else if (k === 'backspace') {
      _formState.amountRaw = _formState.amountRaw.slice(0, -1);
      _updateAmountDisplay();
    } else if (k === 'clear') {
      _formState.amountRaw = '';
      _updateAmountDisplay();
    } else if (k === '.') {
      if (!_formState.amountRaw.includes('.')) {
        _formState.amountRaw += _formState.amountRaw === '' ? '0.' : '.';
        _updateAmountDisplay();
      }
    } else {
      const parts = _formState.amountRaw.split('.');
      if (parts.length === 2 && parts[1].length >= 2) return;
      if (parts[0].length >= 8 && parts.length === 1) return;
      _formState.amountRaw += k;
      _updateAmountDisplay();
    }
  }

  function _bindNumpad() {
    // 触摸/点击事件
    document.querySelectorAll('.numpad__key').forEach(key => {
      key.addEventListener('click', () => _handleNumpadKey(key.dataset.key));
    });

    // 物理键盘支持（桌面端）：在记账页可见时监听
    document.addEventListener('keydown', (e) => {
      // 仅记账页可见时处理，避免在其他页面误触
      if (_currentView !== 'add') return;
      // 如果有 input/textarea 聚焦，不劫持（用户可能正在填写备注/地点）
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;

      if (e.key >= '0' && e.key <= '9') {
        _handleNumpadKey(e.key);
      } else if (e.key === '.' || e.key === '。') {
        _handleNumpadKey('.');
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        _handleNumpadKey('backspace');
      } else if (e.key === 'Escape') {
        _handleNumpadKey('clear');
      } else if (e.key === 'Enter') {
        _handleNumpadKey('submit');
      }
    });
  }

  function _updateAmountDisplay() {
    const display = document.getElementById('add-amount-display');
    const decimal = document.getElementById('add-amount-decimal');
    if (!display || !decimal) return;

    if (_formState.amountRaw === '') {
      display.textContent = '0';
      display.className = 'add-amount__value add-amount__value--empty';
      decimal.textContent = '.00';
    } else {
      const parts = _formState.amountRaw.split('.');
      display.textContent = parts[0] || '0';
      display.className = 'add-amount__value';
      if (parts.length === 2) {
        decimal.textContent = '.' + parts[1].padEnd(2, '0');
      } else {
        decimal.textContent = '.00';
      }
    }
  }

  /* -----------------------------------------------------------------
     支付方式渲染
     ----------------------------------------------------------------- */
  /* 将 hex 颜色转为 rgb 字符串，用于 rgba 半透明 */
  function _hexToRgb(hex) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `${r},${g},${b}`;
  }

  function _renderPaymentMethods() {
    const container = document.getElementById('add-payment-methods');
    if (!container) return;

    container.innerHTML = ExpenseData.PAYMENT_METHODS.map(pm => {
      const isActive = _formState.paymentMethod === pm.value;
      const rgb = _hexToRgb(pm.color);
      // 未选中：淡品牌色底 + 品牌色字；选中：实心品牌色 + 白字
      const bg   = isActive ? pm.color : `rgba(${rgb},0.1)`;
      const bd   = isActive ? pm.color : `rgba(${rgb},0.3)`;
      const text = isActive ? '#fff' : pm.color;
      return `<button class="chip chip--payment ${isActive ? 'chip--active' : ''}" data-pm="${pm.value}" style="background:${bg};border-color:${bd};color:${text}">${pm.label}</button>`;
    }).join('');

    container.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const val = chip.dataset.pm;
        _formState.paymentMethod = (_formState.paymentMethod === val) ? '' : val;
        _renderPaymentMethods();
      });
    });
  }

  /* -----------------------------------------------------------------
     记账表单绑定
     ----------------------------------------------------------------- */
  function _bindAddForm() {
    const locInput = document.getElementById('add-location');
    const noteInput = document.getElementById('add-note');
    const dateInput = document.getElementById('add-date');
    const timeInput = document.getElementById('add-time');

    if (locInput) locInput.addEventListener('input', () => { _formState.location = locInput.value; });
    if (noteInput) noteInput.addEventListener('input', () => { _formState.note = noteInput.value; });
    if (dateInput) dateInput.addEventListener('change', () => {
      _formState.date = dateInput.value;
      _updateDateLabels();
    });
    if (timeInput) timeInput.addEventListener('change', () => {
      _formState.time = timeInput.value;
      _updateDateLabels();
    });

    // 地点类型切换
    const ltypeContainer = document.getElementById('add-location-type');
    if (ltypeContainer) {
      ltypeContainer.querySelectorAll('.chip').forEach(chip => {
        chip.addEventListener('click', () => {
          const val = chip.dataset.ltype;
          _formState.locationType = (_formState.locationType === val) ? '' : val;
          ltypeContainer.querySelectorAll('.chip').forEach(c => {
            c.classList.toggle('chip--active', c.dataset.ltype === _formState.locationType);
          });
        });
      });
    }
  }

  /* -----------------------------------------------------------------
     日期显示更新：将 date/time 转为 "今天 14:30" 格式
     ----------------------------------------------------------------- */
  function _updateDateLabels() {
    const dateLabel = document.getElementById('add-date-label');
    const timeLabel = document.getElementById('add-time-label');
    if (!dateLabel || !timeLabel) return;

    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const yesterday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate() - 1).padStart(2, '0')}`;
    const tomorrow = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate() + 1).padStart(2, '0')}`;

    if (_formState.date === today) {
      dateLabel.textContent = '今天';
    } else if (_formState.date === yesterday) {
      dateLabel.textContent = '昨天';
    } else if (_formState.date === tomorrow) {
      dateLabel.textContent = '明天';
    } else {
      // 显示 "7月3日" 格式
      const parts = _formState.date.split('-');
      if (parts.length === 3) {
        dateLabel.textContent = `${parseInt(parts[1])}月${parseInt(parts[2])}日`;
      }
    }

    timeLabel.textContent = _formState.time || '';
  }

  /* -----------------------------------------------------------------
     日期行点击切换：展开/收起 date/time input
     ----------------------------------------------------------------- */
  function _bindDateToggle() {
    const toggleBtn = document.getElementById('add-date-quick');
    const inputs = document.getElementById('add-date-inputs');
    if (!toggleBtn || !inputs) return;

    toggleBtn.addEventListener('click', () => {
      const isOpen = inputs.style.display !== 'none';
      if (isOpen) {
        inputs.style.display = 'none';
        toggleBtn.innerHTML = `📅 <span id="add-date-label">今天</span> <span id="add-time-label">${_formState.time}</span> ▾`;
        // 重新获取 label 引用（innerHTML 替换后需要）
        _updateDateLabels();
      } else {
        inputs.style.display = 'flex';
        toggleBtn.innerHTML = `📅 <span id="add-date-label">今天</span> <span id="add-time-label">${_formState.time}</span> ▴`;
        _updateDateLabels();
      }
    });
  }

  /* -----------------------------------------------------------------
     重置表单默认值（每次进入记账页或保存后调用）
     ----------------------------------------------------------------- */
  function _resetFormDefaults() {
    const now = new Date();
    _formState.amountRaw = '';
    _formState.note = '';
    _formState.date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    _formState.time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    // 保留上一次的分类、地点、支付方式（方便连续记账）
    const dateInput = document.getElementById('add-date');
    const timeInput = document.getElementById('add-time');
    const locInput = document.getElementById('add-location');
    const noteInput = document.getElementById('add-note');
    if (dateInput) dateInput.value = _formState.date;
    if (timeInput) timeInput.value = _formState.time;
    if (locInput) locInput.value = _formState.location;
    if (noteInput) noteInput.value = '';

    // 更新日期标签显示 + 收起日期选择器
    _updateDateLabels();
    const dateInputs = document.getElementById('add-date-inputs');
    if (dateInputs) dateInputs.style.display = 'none';
  }

  /* -----------------------------------------------------------------
     保存消费记录
     ----------------------------------------------------------------- */
  function _handleSave() {
    // 校验
    const amount = parseFloat(_formState.amountRaw);
    if (!amount || amount <= 0) {
      _toast('请输入金额', 'warning');
      return;
    }
    if (!_formState.categoryId) {
      _toast('请选择消费分类', 'warning');
      return;
    }

    const record = ExpenseDB.addExpense({
      amount:        amount,
      categoryId:    _formState.categoryId,
      date:          _formState.date,
      time:          _formState.time,
      location:      _formState.location,
      locationType:  _formState.locationType,
      paymentMethod: _formState.paymentMethod,
      note:          _formState.note,
    });

    _toast(`已记录 ¥${amount.toFixed(2)}`, 'success');

    // 清空金额和备注，保留分类/地点/支付方式（方便连续记账）
    _formState.amountRaw = '';
    _formState.note = '';
    const noteInput = document.getElementById('add-note');
    if (noteInput) noteInput.value = '';
    _updateAmountDisplay();

    // 取消分类收起态，展开网格但保持已选分类高亮
    ExpenseCategories.uncollapse();
    ExpenseCategories.renderGrid('add-category-grid', 'add-subcategories', (catId) => {
      _formState.categoryId = catId;
    });

    // 刷新支付方式高亮（连续记账时保持上一次的支付选择状态）
    _renderPaymentMethods();
  }

  /* -----------------------------------------------------------------
     Toast 提示
     ----------------------------------------------------------------- */
  function _toast(message, type) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast--${type || ''}`;
    el.textContent = message;
    container.appendChild(el);

    // 1.5s 后开始消失动画
    setTimeout(() => {
      el.classList.add('toast--removing');

      // 动画结束后从 DOM 移除
      const removeEl = () => {
        if (el.parentNode) el.parentNode.removeChild(el);
      };
      el.addEventListener('animationend', removeEl, { once: true });

      // 兜底：0.35s 后强制移除（防止 animationend 不触发导致残留）
      setTimeout(removeEl, 350);
    }, 1500);
  }

  /* -----------------------------------------------------------------
     预算设置覆盖层
     ----------------------------------------------------------------- */
  function _openBudgetOverlay() {
    const overlay = document.getElementById('overlay-budget');
    const body = document.getElementById('overlay-budget-body');
    if (!overlay || !body) return;

    const budget = ExpenseDB.getBudget();
    const monthTotal = ExpenseDB.getMonthTotal();
    const monthlyBudget = budget.monthlyTotal || 0;

    body.innerHTML = `
      <div style="margin-bottom:24px">
        <label style="font-weight:600;display:block;margin-bottom:8px">月度总预算</label>
        <input type="number" class="input" id="budget-input-total" value="${monthlyBudget || ''}"
               placeholder="0 = 不限制" min="0" step="100"
               style="font-size:var(--font-size-xl);text-align:center">
        ${monthlyBudget > 0 ? `<p style="margin-top:8px;font-size:13px;color:var(--color-text-secondary);text-align:center">已用 ¥${monthTotal.toFixed(0)} · 剩余 ${Math.max(0, monthlyBudget - monthTotal).toFixed(0)}</p>` : ''}
      </div>

      <div style="margin-bottom:24px">
        <label style="font-weight:600;display:block;margin-bottom:8px">分类预算（一级分类，空白 = 不限）</label>
        <div style="display:flex;flex-direction:column;gap:12px">
          ${ExpenseDB.getParentCategories().map(cat => {
            const catBudget = (budget.categories && budget.categories[cat.id]) || '';
            const spent = ExpenseDB.getCategorySpent(cat.id);
            return `
              <div style="display:flex;align-items:center;gap:8px">
                <span style="width:32px;text-align:center">${cat.icon}</span>
                <span style="flex:1;font-size:14px">${cat.name}</span>
                <div style="display:flex;align-items:center;gap:4px">
                  <span style="font-size:14px">¥</span>
                  <input type="number" class="input cat-budget-input" data-cat-id="${cat.id}"
                         value="${catBudget}" placeholder="不限" min="0" step="100"
                         style="width:100px;text-align:right">
                </div>
                ${catBudget > 0 ? `<span style="font-size:11px;color:var(--color-text-tertiary);width:60px;text-align:right">${spent > catBudget ? '⚠️超支' : Math.round(spent/catBudget*100)+'%'}</span>` : '<span style="width:60px"></span>'}
              </div>`;
          }).join('')}
        </div>
      </div>

      <button class="btn btn--primary btn--block" id="budget-btn-save">保存</button>
      <button class="btn btn--ghost btn--block" id="budget-btn-reset" style="margin-top:8px;color:var(--color-danger)">重置全部预算</button>
    `;

    // 绑定保存
    document.getElementById('budget-btn-save').addEventListener('click', () => {
      const newBudget = {
        monthlyTotal: parseFloat(document.getElementById('budget-input-total').value) || 0,
        categories: {},
      };
      body.querySelectorAll('.cat-budget-input').forEach(input => {
        const val = parseFloat(input.value);
        if (val > 0) newBudget.categories[input.dataset.catId] = val;
      });
      ExpenseDB.saveBudget(newBudget);
      _toast('预算已保存', 'success');
      overlay.classList.remove('page-overlay--open');
      ExpenseHome.render();
    });

    // 重置
    document.getElementById('budget-btn-reset').addEventListener('click', () => {
      if (confirm('确定清空全部预算设置？')) {
        ExpenseDB.saveBudget(ExpenseData.DEFAULT_BUDGET);
        _toast('预算已重置', 'success');
        overlay.classList.remove('page-overlay--open');
        ExpenseHome.render();
      }
    });

    overlay.classList.add('page-overlay--open');
  }

  /* =================================================================
     分类管理 — 独立全屏页面（覆盖层，从右侧滑入）
     ================================================================= */

  /** 打开分类管理覆盖层，渲染分类列表 */
  function _openCategoryManager() {
    const overlay = document.getElementById('overlay-categories');
    if (!overlay) return;
    _renderCategoryManagerOverlay();
    overlay.classList.add('page-overlay--open');
  }

  /** 渲染分类列表到覆盖层 body */
  function _renderCategoryManagerOverlay() {
    const body = document.getElementById('overlay-categories-body');
    if (!body) return;

    const parents = ExpenseDB.getParentCategories();
    if (parents.length === 0) {
      body.innerHTML = '<div style="text-align:center;padding:32px;color:var(--color-text-tertiary);font-size:14px">暂无分类</div>';
      return;
    }

    body.innerHTML = parents.map(p => {
      const children = ExpenseDB.getChildCategories(p.id);
      return `
        <div style="margin-bottom:20px">
          <div style="display:flex;align-items:center;gap:6px;padding:6px 0;font-weight:600;font-size:15px">
            <span>${p.icon}</span>
            <span>${p.name}</span>
            <span style="font-size:11px;color:var(--color-text-tertiary);font-weight:400">${p.isPreset ? '预设' : '自定义'}</span>
            ${!p.isPreset ? `<button class="btn btn--ghost btn--small" data-del-cat="${p.id}" style="color:var(--color-danger);font-size:11px;margin-left:auto">删除</button>` : ''}
          </div>
          <div style="padding-left:24px">
            ${children.map(c => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-divider)">
                <span style="display:flex;align-items:center;gap:4px;font-size:14px">
                  <span>${c.icon}</span>
                  <span>${c.name}</span>
                  <span style="font-size:11px;color:var(--color-text-tertiary)">${c.isPreset ? '预设' : '自定义'}</span>
                </span>
                ${!c.isPreset ? `<button class="btn btn--ghost btn--small" data-del-cat="${c.id}" style="color:var(--color-danger);font-size:11px">删除</button>` : ''}
              </div>
            `).join('')}
            ${children.length === 0 ? '<div style="padding:6px 0;font-size:12px;color:var(--color-text-tertiary)">暂无子分类</div>' : ''}
          </div>
        </div>`;
    }).join('');

    // 绑定删除事件
    body.querySelectorAll('[data-del-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const catId = btn.dataset.delCat;
        const cat = ExpenseDB.getCategory(catId);
        if (!cat) return;
        if (confirm(`确定删除分类「${cat.name}」？`)) {
          ExpenseDB.deleteCategory(catId);
          if (_formState.categoryId === catId) _formState.categoryId = '';
          _renderCategoryManagerOverlay();
          ExpenseCategories.renderGrid('add-category-grid', 'add-subcategories', (cid) => {
            _formState.categoryId = cid;
          });
        }
      });
    });
  }

  /** 在覆盖层 body 中渲染新增分类表单 */
  function _showAddCategoryForm() {
    const body = document.getElementById('overlay-categories-body');
    if (!body) return;

    const parents = ExpenseDB.getParentCategories();
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">所属一级分类</label>
          <select class="input" id="new-cat-parent">
            <option value="">-- 新建一级分类 --</option>
            ${parents.map(p => `<option value="${p.id}">${p.icon} ${p.name}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">分类名称 <span style="color:var(--color-danger)">*</span></label>
          <input type="text" class="input" id="new-cat-name" placeholder="例如：宠物" maxlength="10">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">图标 Emoji</label>
          <input type="text" class="input" id="new-cat-icon" placeholder="例如：🐱（留空默认 📌）" maxlength="4">
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn--primary" id="new-cat-save" style="flex:1">确认添加</button>
          <button class="btn btn--ghost" id="new-cat-cancel">取消</button>
        </div>
      </div>
    `;

    document.getElementById('new-cat-save').addEventListener('click', () => {
      const name = document.getElementById('new-cat-name').value.trim();
      if (!name) { _toast('请输入分类名称', 'warning'); return; }
      const icon = document.getElementById('new-cat-icon').value.trim() || '📌';
      const parentId = document.getElementById('new-cat-parent').value || null;

      ExpenseDB.addCategory({ name, icon, parentId });
      _toast(`已添加分类「${name}」`, 'success');
      _renderCategoryManagerOverlay();
      ExpenseCategories.renderGrid('add-category-grid', 'add-subcategories', (catId) => {
        _formState.categoryId = catId;
      });
    });

    document.getElementById('new-cat-cancel').addEventListener('click', () => {
      _renderCategoryManagerOverlay();
    });
  }

  function _bindOverlays() {
    // 预算覆盖层
    document.getElementById('overlay-budget-back').addEventListener('click', () => {
      document.getElementById('overlay-budget').classList.remove('page-overlay--open');
    });

    // 编辑覆盖层 — 返回按钮：关闭面板后回到进入前的页面
    document.getElementById('overlay-edit-back').addEventListener('click', () => {
      _closeEditSheet();
      navigate(_preEditView);
    });

    // 编辑覆盖层 — 删除按钮（只绑定一次，通过 _editingExpenseId 获取当前记录）
    document.getElementById('overlay-edit-delete').addEventListener('click', () => {
      if (!_editingExpenseId) return;
      if (confirm('确定删除这条记录？此操作不可恢复。')) {
        ExpenseDB.deleteExpense(_editingExpenseId);
        _toast('已删除', 'success');
        _closeEditSheet();
        _editingExpenseId = null;
        if (typeof ExpenseList !== 'undefined') ExpenseList.render();
        ExpenseHome.render();
        if (typeof ExpenseStats !== 'undefined') ExpenseStats.render();
      }
    });

    // 记账页"⚙️ 管理"按钮 → 打开分类管理覆盖层（独立全屏页面）
    const manageBtn = document.getElementById('add-manage-categories');
    if (manageBtn) {
      manageBtn.addEventListener('click', _openCategoryManager);
    }

    // 分类管理覆盖层 — 右上角 ✕ 返回按钮：关闭覆盖层，切回记账页
    document.getElementById('overlay-categories-back').addEventListener('click', () => {
      document.getElementById('overlay-categories').classList.remove('page-overlay--open');
      navigate('add');
      // 刷新记账页的分类网格
      ExpenseCategories.renderGrid('add-category-grid', 'add-subcategories', (catId) => {
        _formState.categoryId = catId;
      });
    });

    // 分类管理覆盖层 — "+ 新增"按钮
    document.getElementById('overlay-categories-add').addEventListener('click', () => {
      _showAddCategoryForm();
    });

    // 编辑覆盖层 — 点击背景遮罩关闭
    const editBackdrop = document.getElementById('overlay-edit-backdrop');
    if (editBackdrop) {
      editBackdrop.addEventListener('click', () => _closeEditSheet());
    }
  }

  function _bindHomeEvents() {
    // 设置预算按钮
    const setBudgetBtn = document.getElementById('home-set-budget');
    if (setBudgetBtn) {
      setBudgetBtn.addEventListener('click', _openBudgetOverlay);
    }

    // 查看全部 → 跳转账单页
    const viewAllBtn = document.getElementById('home-view-all');
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', () => navigate('list'));
    }

    // 最近记录点击 → 打开编辑覆盖层（事件委托）
    const recentContainer = document.getElementById('home-recent');
    if (recentContainer) {
      recentContainer.addEventListener('click', (e) => {
        const item = e.target.closest('.home-recent__item');
        if (item && item.dataset.id) {
          _openEditOverlay(item.dataset.id);
        }
      });
    }

    // 数据备份：导出（优先用系统分享面板，不支持时下载文件）
    const exportBtn = document.getElementById('home-export-btn');
    if (exportBtn) {
      exportBtn.addEventListener('click', async () => {
        const data = ExpenseDB.exportAll();
        const json = JSON.stringify(data, null, 2);
        const now = new Date();
        const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
        const filename = `expense-tracker-backup-${ts}.json`;

        // 手机端：使用系统分享面板（可分享到微信/邮件/备忘录等）
        if (navigator.share && navigator.canShare) {
          const blob = new Blob([json], { type: 'application/json' });
          const file = new File([blob], filename, { type: 'application/json' });
          const shareData = { title: '消费轨迹备份', files: [file] };
          if (navigator.canShare(shareData)) {
            try {
              await navigator.share(shareData);
              ExpenseDB.recordBackupTime();
              _updateBackupBadge();
              _toast(`已分享 ${data.expenses.length} 条记录`, 'success');
              return;
            } catch (e) {
              // 用户取消分享，不提示错误，降级到下载
              if (e.name === 'AbortError') return;
            }
          }
        }

        // 降级方案：桌面端下载文件
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        ExpenseDB.recordBackupTime();
        _updateBackupBadge();
        _toast(`已导出 ${data.expenses.length} 条记录`, 'success');
      });
    }

    // 数据备份：导入（粘贴 JSON 文本）
    const importBtn = document.getElementById('home-import-btn');
    const importArea = document.getElementById('home-import-area');
    const importTextarea = document.getElementById('home-import-textarea');
    const importConfirm = document.getElementById('home-import-confirm');
    const importCancel = document.getElementById('home-import-cancel');
    if (importBtn && importArea && importTextarea && importConfirm && importCancel) {
      importBtn.addEventListener('click', () => {
        importArea.style.display = 'block';
        importTextarea.focus();
      });
      importCancel.addEventListener('click', () => {
        importArea.style.display = 'none';
        importTextarea.value = '';
      });
      importConfirm.addEventListener('click', () => {
        const raw = importTextarea.value.trim();
        if (!raw) { _toast('请粘贴备份内容', 'warning'); return; }
        let data;
        try {
          data = JSON.parse(raw);
        } catch (e) {
          _toast('内容格式错误，不是有效的 JSON', 'warning');
          return;
        }
        if (!data.expenses || !data.categories) {
          _toast('无效的备份文件：缺少数据字段', 'warning');
          return;
        }
        const msg = `即将恢复备份（${data.expenses.length} 条记录，${data.categories.length} 个分类）。\n\n当前数据将被覆盖，系统已自动留一份恢复前备份。\n\n确定继续？`;
        if (!confirm(msg)) return;
        const result = ExpenseDB.importAll(data);
        if (result.success) {
          _toast(result.message, 'success');
          _updateBackupBadge();
          importArea.style.display = 'none';
          importTextarea.value = '';
          ExpenseHome.render();
          if (typeof ExpenseList !== 'undefined') ExpenseList.render();
          if (typeof ExpenseStats !== 'undefined') ExpenseStats.render();
        } else {
          _toast(result.message, 'warning');
        }
      });
    }

    // 更新备份时间徽章
    _updateBackupBadge();

    // 时钟更新（每分钟刷新首页日期）
    setInterval(() => {
      if (_currentView === 'home') {
        const now = new Date();
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        const el = document.getElementById('home-date');
        if (el) el.textContent = `${now.getMonth() + 1}月${now.getDate()}日 周${weekdays[now.getDay()]}`;
        _updateBackupBadge();
      }
    }, 60000);
  }

  /** 更新首页备份时间徽章（未备份 / 上次备份日期 / 超过7天提醒） */
  function _updateBackupBadge() {
    const badge = document.getElementById('home-backup-badge');
    if (!badge) return;
    const last = ExpenseDB.getLastBackupTime();
    if (!last) {
      badge.textContent = '⚠️ 尚未备份';
      badge.style.color = 'var(--color-warning)';
      return;
    }
    const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    if (days > 7) {
      badge.textContent = `⚠️ ${days} 天前备份`;
      badge.style.color = 'var(--color-warning)';
    } else {
      const d = new Date(last);
      badge.textContent = `✓ ${d.getMonth()+1}月${d.getDate()}日已备份`;
      badge.style.color = 'var(--color-success)';
    }
  }

  /* -----------------------------------------------------------------
     从其他模块调用的公开方法
     ----------------------------------------------------------------- */
  function openBudgetSettings() { _openBudgetOverlay(); }
  function openEditExpense(expenseId) { _openEditOverlay(expenseId); }
  function showToast(msg, type) { _toast(msg, type); }
  function getCurrentView() { return _currentView; }

  /* -----------------------------------------------------------------
     编辑消费记录覆盖层（供账单页调用）
     ----------------------------------------------------------------- */
  function _openEditOverlay(expenseId) {
    const overlay = document.getElementById('overlay-edit');
    const body = document.getElementById('overlay-edit-body');
    if (!overlay || !body) return;

    const expense = ExpenseDB.getExpense(expenseId);
    if (!expense) return;

    // 记录进入编辑前的页面，关闭时回到该页面（而非总是跳首页）
    _preEditView = _currentView;

    // 存储当前编辑的记录 ID（供删除按钮使用，只绑定一次）
    _editingExpenseId = expenseId;

    const cat = ExpenseDB.getCategory(expense.categoryId);
    const parents = ExpenseDB.getParentCategories();

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">金额 ¥</label>
          <input type="number" class="input" id="edit-amount" value="${expense.amount}" step="0.01" min="0.01">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">分类</label>
          <select class="input" id="edit-category">
            ${_buildCategoryOptions(expense.categoryId)}
          </select>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">📍 地点</label>
          <input type="text" class="input" id="edit-location" value="${expense.location || ''}" maxlength="50">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">地点类型</label>
          <div style="display:flex;gap:8px">
            <button class="chip ${expense.locationType === 'offline' ? 'chip--active' : ''}" data-edit-ltype="offline">🏪 线下</button>
            <button class="chip ${expense.locationType === 'online' ? 'chip--active' : ''}" data-edit-ltype="online">🌐 线上</button>
          </div>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">支付方式</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${ExpenseData.PAYMENT_METHODS.map(pm => {
              const isActive = expense.paymentMethod === pm.value;
              const rgb = _hexToRgb(pm.color);
              const bg   = isActive ? pm.color : `rgba(${rgb},0.1)`;
              const bd   = isActive ? pm.color : `rgba(${rgb},0.3)`;
              const text = isActive ? '#fff' : pm.color;
              return `<button class="chip chip--payment ${isActive ? 'chip--active' : ''}" data-edit-pm="${pm.value}" style="background:${bg};border-color:${bd};color:${text}">${pm.label}</button>`;
            }).join('')}
          </div>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">📝 备注</label>
          <input type="text" class="input" id="edit-note" value="${expense.note || ''}" maxlength="100">
        </div>
        <div style="display:flex;gap:12px">
          <div style="flex:1">
            <label style="font-weight:600;display:block;margin-bottom:6px">📅 日期</label>
            <input type="date" class="input" id="edit-date" value="${expense.date || ''}">
          </div>
          <div style="flex:1">
            <label style="font-weight:600;display:block;margin-bottom:6px">⏰ 时间</label>
            <input type="time" class="input" id="edit-time" value="${expense.time || ''}">
          </div>
        </div>
        <button class="btn btn--primary btn--block" id="edit-btn-save">保存修改</button>
      </div>
    `;

    // 地点类型切换
    body.querySelectorAll('[data-edit-ltype]').forEach(btn => {
      btn.addEventListener('click', () => {
        const current = body.querySelector('[data-edit-ltype].chip--active');
        if (current === btn) {
          btn.classList.remove('chip--active');
        } else {
          if (current) current.classList.remove('chip--active');
          btn.classList.add('chip--active');
        }
      });
    });

    // 支付方式切换
    body.querySelectorAll('[data-edit-pm]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('chip--active')) {
          btn.classList.remove('chip--active');
        } else {
          body.querySelector('[data-edit-pm].chip--active')?.classList.remove('chip--active');
          btn.classList.add('chip--active');
        }
      });
    });

    // 保存按钮（每次打开覆盖层时重新创建，无需担心事件泄漏）
    document.getElementById('edit-btn-save').addEventListener('click', () => {
      const amountVal = parseFloat(document.getElementById('edit-amount').value);
      if (!amountVal || amountVal <= 0) {
        _toast('请输入有效金额', 'warning');
        return;
      }

      const ltypeBtn = body.querySelector('[data-edit-ltype].chip--active');
      const pmBtn = body.querySelector('[data-edit-pm].chip--active');

      ExpenseDB.updateExpense(expenseId, {
        amount:        amountVal,
        categoryId:    document.getElementById('edit-category').value,
        location:      document.getElementById('edit-location').value,
        locationType:  ltypeBtn ? ltypeBtn.dataset.editLtype : '',
        paymentMethod: pmBtn ? pmBtn.dataset.editPm : '',
        note:          document.getElementById('edit-note').value,
        date:          document.getElementById('edit-date').value,
        time:          document.getElementById('edit-time').value,
      });

      _toast('已更新', 'success');
      _closeEditSheet();
      _editingExpenseId = null;
      if (typeof ExpenseList !== 'undefined') ExpenseList.render();
      ExpenseHome.render();
      if (typeof ExpenseStats !== 'undefined') ExpenseStats.render();
    });

    _openEditSheet();
  }

  /** 构建分类 <select> 的 <option> 列表 */
  function _buildCategoryOptions(selectedId) {
    const parents = ExpenseDB.getParentCategories();
    let html = '<option value="">-- 请选择 --</option>';
    parents.forEach(p => {
      html += `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${p.icon} ${p.name}</option>`;
      const children = ExpenseDB.getChildCategories(p.id);
      children.forEach(c => {
        html += `<option value="${c.id}" ${c.id === selectedId ? 'selected' : ''}>&nbsp;&nbsp;└ ${c.icon} ${c.name}</option>`;
      });
    });
    return html;
  }

  /* =================================================================
     初始化 & 公开 API
     ================================================================= */
  document.addEventListener('DOMContentLoaded', init);

  return {
    navigate,
    getCurrentView,
    openBudgetSettings,
    openEditExpense,
    showToast,
  };
})();
