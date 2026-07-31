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
    paymentMethod: '',
    note: '',
    date: '',
    time: '',
    dateTimeManuallyEdited: false,
  };
  const _LARGE_AMOUNT_THRESHOLD = 10000;
  let _confirmedLargeAmountRaw = null;
  let _paymentOptionsExpanded = false;

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
    _renderAddCategories();

    // 4. 渲染支付方式
    _renderPaymentMethods();
    _updateAmountDisplay();

    // 5. 绑定事件
    _bindTabBar();
    _bindNumpad();
    _bindAddForm();
    _bindPaymentSummary();
    _bindDateToggle();
    _bindDateShortcuts();
    _bindOverlays();
    _bindHomeEvents();

    // 6. 初始化子模块的筛选/时段选择器
    if (typeof ExpenseList !== 'undefined') ExpenseList.initFilters();
    if (typeof ExpenseStats !== 'undefined') ExpenseStats.initPeriodSelector();

    // 7. 注册 Service Worker（PWA 离线缓存）
    //    更新检测和提示由 index.html 内联脚本统一处理
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function(err) {
        console.warn('SW registration failed:', err);
      });
    }

    // 8. 渲染首页
    ExpenseHome.render();
    _renderMerchantSuggestions();
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
    const previousView = _currentView;
    // 离开统计页时关闭 tooltip（否则 tooltip 是挂在 body 上的，不会随页面切换消失）
    if (_currentView === 'stats' && viewId !== 'stats' && typeof ExpenseStats !== 'undefined') {
      ExpenseStats.dismissTooltip();
    }

    // 切换 view 显示
    document.querySelectorAll('.main-view').forEach(v => v.classList.remove('main-view--active'));
    const target = document.getElementById(`view-${viewId}`);
    if (target) target.classList.add('main-view--active');

    // 切换 tab 高亮
    document.querySelectorAll('.tab-bar__item').forEach(t => {
      t.classList.remove('tab-bar__item--active');
      t.removeAttribute('aria-current');
    });
    const tab = document.querySelector(`.tab-bar__item[data-view="${viewId}"]`);
    if (tab) {
      tab.classList.add('tab-bar__item--active');
      tab.setAttribute('aria-current', 'page');
    }

    _currentView = viewId;

    // 触发视图刷新
    if (viewId === 'home') {
      ExpenseHome.render();
    } else if (viewId === 'add') {
      // 从其他页面发起一笔新记录时清空易误带字段；覆盖层返回时保留正在填写的内容。
      if (previousView !== 'add') {
        _resetFormDefaults({ clearTransient: true });
        _formState.categoryId = '';
        ExpenseCategories.clearSelection();
      }
      _renderAddCategories();
      _renderPaymentMethods();
      _renderMerchantSuggestions();
      _updateAmountDisplay();
    } else if (viewId === 'list') {
      if (typeof ExpenseList !== 'undefined') {
        try {
          ExpenseList.render();
        } catch (e) {
          console.error('[App] ExpenseList.render 异常:', e);
          var lc = document.getElementById('list-content');
          if (lc) lc.innerHTML = '<div class="empty-state"><div class="empty-state__icon">⚠️</div><p class="empty-state__text">渲染出错</p><p class="empty-state__hint">' + e.message + '</p></div>';
        }
      } else {
        console.error('[App] ExpenseList 未定义，list.js 可能加载失败');
        var lc2 = document.getElementById('list-content');
        if (lc2) lc2.innerHTML = '<div class="empty-state"><div class="empty-state__icon">⚠️</div><p class="empty-state__text">模块加载失败</p><p class="empty-state__hint">请刷新页面重试</p></div>';
      }
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

  function _renderAddCategories() {
    ExpenseCategories.renderGrid('add-category-picker-grid', 'add-category-picker-subcategories', (catId) => {
      _formState.categoryId = catId;
      _setCategoryValidation(false);
      _updateSaveState();
    });
  }

  function _setCategoryValidation(isInvalid) {
    const area = document.querySelector('.add-category-area');
    if (area) area.classList.toggle('add-category-area--invalid', Boolean(isInvalid));
  }

  function _setAmountValidation(isInvalid) {
    const amountDisplay = document.querySelector('.add-amount-display');
    if (amountDisplay) amountDisplay.classList.toggle('add-amount-display--invalid', Boolean(isInvalid));
  }

  /* -----------------------------------------------------------------
     数字键盘逻辑
     ----------------------------------------------------------------- */
  /** 处理一次按键操作（数字键盘点击或物理键盘都走这里） */
  function _handleNumpadKey(k) {
    if (k === 'submit') {
      _handleSave();
      return;
    }

    const previousAmountRaw = _formState.amountRaw;
    if (k === 'backspace') {
      _formState.amountRaw = _formState.amountRaw.slice(0, -1);
    } else if (k === 'clear') {
      _formState.amountRaw = '';
    } else if (k === '.') {
      if (!_formState.amountRaw.includes('.')) {
        _formState.amountRaw += _formState.amountRaw === '' ? '0.' : '.';
      }
    } else {
      const parts = _formState.amountRaw.split('.');
      if (parts.length === 2 && parts[1].length >= 2) return;
      if (parts[0].length >= 8 && parts.length === 1) return;
      _formState.amountRaw += k;
    }

    if (_formState.amountRaw === previousAmountRaw) return;
    _confirmedLargeAmountRaw = null;
    _setAmountValidation(false);
    _updateAmountDisplay();
  }

  function _bindNumpad() {
    // 触摸/点击事件
    document.querySelectorAll('.numpad__key').forEach(key => {
      key.addEventListener('click', () => _handleNumpadKey(key.dataset.key));
    });

    // 物理键盘支持（桌面端）：在记账页可见时监听
    document.addEventListener('keydown', (e) => {
      if (e.defaultPrevented) return;
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
    const submitAmount = document.getElementById('add-submit-amount');
    if (!display || !decimal) return;

    if (_formState.amountRaw === '') {
      display.textContent = '0';
      display.className = 'add-amount__value add-amount__value--empty';
      decimal.textContent = '.00';
      if (submitAmount) submitAmount.textContent = '¥0.00';
    } else {
      const parts = _formState.amountRaw.split('.');
      display.textContent = parts[0] || '0';
      display.className = 'add-amount__value';
      if (parts.length === 2) {
        decimal.textContent = '.' + parts[1].padEnd(2, '0');
      } else {
        decimal.textContent = '.00';
      }
      if (submitAmount) {
        const amount = parseFloat(_formState.amountRaw);
        submitAmount.textContent = `¥${Number.isFinite(amount) ? amount.toFixed(2) : '0.00'}`;
      }
    }
    _updateSaveState();
  }

  function _updateSaveState() {
    const label = document.getElementById('add-submit-label');
    const submit = document.querySelector('.numpad__key--submit');
    const amount = parseFloat(_formState.amountRaw);
    const hasAmount = Number.isFinite(amount) && amount > 0;
    let text = '保存';

    if (!hasAmount) text = '输入金额';
    else if (!_formState.categoryId) text = '选择分类';

    if (label) label.textContent = text;
    if (submit) {
      const amountText = hasAmount ? `，金额 ¥${amount.toFixed(2)}` : '';
      submit.setAttribute('aria-label', `${text}${amountText}`);
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

  function _bindPaymentSummary() {
    const summary = document.getElementById('add-payment-summary');
    if (!summary) return;
    summary.addEventListener('click', () => {
      _paymentOptionsExpanded = true;
      _renderPaymentMethods();
    });
  }

  function _renderPaymentMethods() {
    const container = document.getElementById('add-payment-methods');
    const header = document.getElementById('add-payment-header');
    const summary = document.getElementById('add-payment-summary');
    const summaryText = document.getElementById('add-payment-summary-text');
    const summaryDot = document.getElementById('add-payment-summary-dot');
    const section = document.querySelector('.add-payment-section');
    if (!container) return;

    const selectedMethod = ExpenseData.PAYMENT_METHODS.find(pm => pm.value === _formState.paymentMethod);
    const showSummary = Boolean(selectedMethod) && !_paymentOptionsExpanded;
    if (header) header.style.display = showSummary ? 'none' : 'flex';
    if (summary) summary.style.display = showSummary ? 'grid' : 'none';
    container.style.display = showSummary ? 'none' : 'grid';
    if (section) section.classList.toggle('add-payment-section--selected', showSummary);

    if (showSummary) {
      if (summaryText) summaryText.textContent = `已选 ${selectedMethod.label}`;
      if (summaryDot) summaryDot.style.background = selectedMethod.color;
      if (summary) summary.setAttribute('aria-label', `已选择${selectedMethod.label}，点击更换支付方式`);
      return;
    }

    container.innerHTML = ExpenseData.PAYMENT_METHODS.map(pm => {
      const isActive = _formState.paymentMethod === pm.value;
      const rgb = _hexToRgb(pm.color);
      // 未选中：淡品牌色底 + 品牌色字；选中：实心品牌色 + 白字
      const bg   = isActive ? pm.color : `rgba(${rgb},0.1)`;
      const bd   = isActive ? pm.color : `rgba(${rgb},0.3)`;
      const text = isActive ? '#fff' : pm.color;
      return `<button class="chip chip--payment ${isActive ? 'chip--active' : ''}" data-pm="${pm.value}" type="button" style="background:${bg};border-color:${bd};color:${text}">${pm.label}</button>`;
    }).join('');

    container.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const val = chip.dataset.pm;
        _formState.paymentMethod = (_formState.paymentMethod === val) ? '' : val;
        _paymentOptionsExpanded = false;
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
      _formState.dateTimeManuallyEdited = true;
      _updateDateLabels();
    });
    if (timeInput) timeInput.addEventListener('change', () => {
      _formState.time = timeInput.value;
      _formState.dateTimeManuallyEdited = true;
      _updateDateLabels();
    });

  }

  function _getMerchantSuggestions() {
    const suggestions = new Map();

    ExpenseDB.getExpenses().slice(0, 80).forEach((expense, index) => {
      const note = (expense.note || '').trim();
      const location = (expense.location || '').trim();
      if (!note && !location) return;

      const key = `${note}\u0000${location}`;
      const recencyWeight = Math.max(1, 10 - Math.floor(index / 8));
      const existing = suggestions.get(key);
      if (existing) {
        existing.score += recencyWeight;
      } else {
        suggestions.set(key, {
          note,
          location,
          categoryId: expense.categoryId,
          score: recencyWeight,
        });
      }
    });

    return [...suggestions.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, 4);
  }

  function _renderMerchantSuggestions() {
    const container = document.getElementById('add-merchant-suggestions');
    if (!container) return;

    const suggestions = _getMerchantSuggestions();
    container.replaceChildren();
    container.hidden = suggestions.length === 0;
    if (suggestions.length === 0) return;

    const label = document.createElement('p');
    label.className = 'add-merchant-suggestions__label';
    label.textContent = '常用内容';
    container.appendChild(label);

    const chips = document.createElement('div');
    chips.className = 'add-merchant-suggestions__chips';
    suggestions.forEach(suggestion => {
      const category = ExpenseDB.getCategory(suggestion.categoryId);
      const button = document.createElement('button');
      button.className = 'add-merchant-suggestion';
      button.type = 'button';
      button.title = suggestion.note || suggestion.location;

      const icon = document.createElement('span');
      icon.className = 'add-merchant-suggestion__icon';
      icon.innerHTML = ExpenseCategories.getIconMarkup(category);

      const text = document.createElement('span');
      text.className = 'add-merchant-suggestion__text';
      text.textContent = suggestion.note || suggestion.location;

      button.append(icon, text);
      button.addEventListener('click', () => _applyMerchantSuggestion(suggestion));
      chips.appendChild(button);
    });
    container.appendChild(chips);
  }

  function _applyMerchantSuggestion(suggestion) {
    _formState.note = suggestion.note;
    _formState.location = suggestion.location;

    const noteInput = document.getElementById('add-note');
    const locationInput = document.getElementById('add-location');
    const moreFields = document.getElementById('add-more-fields');
    if (noteInput) noteInput.value = suggestion.note;
    if (locationInput) locationInput.value = suggestion.location;
    if (moreFields) moreFields.open = true;

    if (ExpenseDB.getCategory(suggestion.categoryId)) {
      _formState.categoryId = suggestion.categoryId;
      ExpenseCategories.setSelected(suggestion.categoryId, { collapse: true });
      _renderAddCategories();
      _setCategoryValidation(false);
      _updateSaveState();
    }
  }

  /* -----------------------------------------------------------------
     日期显示更新：将 date/time 转为 "今天 14:30" 格式
     ----------------------------------------------------------------- */
  function _updateDateLabels() {
    const dateLabel = document.getElementById('add-date-label');
    const timeLabel = document.getElementById('add-time-label');
    if (!dateLabel || !timeLabel) return;

    const today = _relativeDateValue(0);
    const yesterday = _relativeDateValue(-1);
    const tomorrow = _relativeDateValue(1);

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
    _updateDateShortcutState();
  }

  function _dateValue(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function _timeValue(date) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function _relativeDateValue(offset) {
    const date = new Date();
    date.setDate(date.getDate() + offset);
    return _dateValue(date);
  }

  function _updateDateShortcutState() {
    const today = _relativeDateValue(0);
    const yesterday = _relativeDateValue(-1);
    document.querySelectorAll('[data-date-shortcut]').forEach(button => {
      const shortcut = button.dataset.dateShortcut;
      const isActive = (shortcut === 'today' && _formState.date === today)
        || (shortcut === 'yesterday' && _formState.date === yesterday);
      button.classList.toggle('add-date-shortcut--active', isActive);
    });
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
        toggleBtn.setAttribute('aria-expanded', 'false');
        toggleBtn.innerHTML = `<span aria-hidden="true">日历</span><span id="add-date-label">今天</span><span id="add-time-label">${_formState.time}</span><span class="add-date-quick__chevron" aria-hidden="true">⌄</span>`;
        // 重新获取 label 引用（innerHTML 替换后需要）
        _updateDateLabels();
      } else {
        inputs.style.display = 'flex';
        toggleBtn.setAttribute('aria-expanded', 'true');
        toggleBtn.innerHTML = `<span aria-hidden="true">日历</span><span id="add-date-label">今天</span><span id="add-time-label">${_formState.time}</span><span class="add-date-quick__chevron" aria-hidden="true">⌃</span>`;
        _updateDateLabels();
      }
    });
  }

  function _bindDateShortcuts() {
    document.querySelectorAll('[data-date-shortcut]').forEach(button => {
      button.addEventListener('click', () => {
        const shortcut = button.dataset.dateShortcut;
        if (shortcut === 'today') {
          _formState.date = _relativeDateValue(0);
        } else if (shortcut === 'yesterday') {
          _formState.date = _relativeDateValue(-1);
        } else if (shortcut === 'now') {
          const now = new Date();
          _formState.date = _dateValue(now);
          _formState.time = _timeValue(now);
        }

        _formState.dateTimeManuallyEdited = true;
        const dateInput = document.getElementById('add-date');
        const timeInput = document.getElementById('add-time');
        if (dateInput) dateInput.value = _formState.date;
        if (timeInput) timeInput.value = _formState.time;
        _updateDateLabels();
      });
    });
  }

  /* -----------------------------------------------------------------
     重置表单默认值（每次从其他页面进入记账页时调用）
     ----------------------------------------------------------------- */
  function _resetFormDefaults(options = {}) {
    const { clearTransient = true } = options;
    const now = new Date();
    _formState.amountRaw = '';
    _confirmedLargeAmountRaw = null;
    _paymentOptionsExpanded = false;
    _formState.note = '';
    _formState.date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    _formState.time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    _formState.dateTimeManuallyEdited = false;

    if (clearTransient) {
      _formState.location = '';
      _formState.paymentMethod = '';
    }

    // 分类会保留为可见摘要，地点和支付方式不会默默带入新的一笔。
    const dateInput = document.getElementById('add-date');
    const timeInput = document.getElementById('add-time');
    const locInput = document.getElementById('add-location');
    const noteInput = document.getElementById('add-note');
    const moreFields = document.getElementById('add-more-fields');
    if (dateInput) dateInput.value = _formState.date;
    if (timeInput) timeInput.value = _formState.time;
    if (locInput) locInput.value = _formState.location;
    if (noteInput) noteInput.value = '';
    if (moreFields) moreFields.open = Boolean(_formState.location || _formState.note);

    // 更新日期标签显示 + 收起日期选择器
    _updateDateLabels();
    const dateInputs = document.getElementById('add-date-inputs');
    if (dateInputs) dateInputs.style.display = 'none';
    const dateQuick = document.getElementById('add-date-quick');
    if (dateQuick) {
      dateQuick.setAttribute('aria-expanded', 'false');
      dateQuick.innerHTML = `<span aria-hidden="true">日历</span><span id="add-date-label">今天</span><span id="add-time-label">${_formState.time}</span><span class="add-date-quick__chevron" aria-hidden="true">⌄</span>`;
      _updateDateLabels();
    }
  }

  function _refreshTimestampAfterSave() {
    // 用户手动回填过时间时绝不覆盖；普通连续记账则把下一笔更新为现在。
    if (_formState.dateTimeManuallyEdited) return;

    const now = new Date();
    _formState.date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    _formState.time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const dateInput = document.getElementById('add-date');
    const timeInput = document.getElementById('add-time');
    if (dateInput) dateInput.value = _formState.date;
    if (timeInput) timeInput.value = _formState.time;
    _updateDateLabels();
  }

  /* -----------------------------------------------------------------
     保存消费记录
     ----------------------------------------------------------------- */
  function _handleSave() {
    // 校验
    const amount = parseFloat(_formState.amountRaw);
    if (!amount || amount <= 0) {
      _setAmountValidation(true);
      _toast('请输入金额', 'warning');
      return;
    }
    _setAmountValidation(false);
    if (!_formState.categoryId) {
      _setCategoryValidation(true);
      const categoryArea = document.querySelector('.add-category-area');
      if (categoryArea) categoryArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
      _toast('请选择消费分类', 'warning');
      return;
    }

    if (amount >= _LARGE_AMOUNT_THRESHOLD && _confirmedLargeAmountRaw !== _formState.amountRaw) {
      const amountText = amount.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      if (!window.confirm(`确认记录 ¥${amountText} 的支出？`)) return;
      _confirmedLargeAmountRaw = _formState.amountRaw;
    }

    const record = ExpenseDB.addExpense({
      amount:        amount,
      categoryId:    _formState.categoryId,
      date:          _formState.date,
      time:          _formState.time,
      location:      _formState.location,
      paymentMethod: _formState.paymentMethod,
      note:          _formState.note,
    });

    _toast(`已记录 ¥${amount.toFixed(2)}`, 'success', {
      actionLabel: '撤销',
      duration: 5000,
      onAction: () => {
        ExpenseDB.deleteExpense(record.id);
        _toast('已撤销本次记录', 'success');
        ExpenseHome.render();
        if (typeof ExpenseList !== 'undefined') ExpenseList.render();
        if (typeof ExpenseStats !== 'undefined') ExpenseStats.render();
        _renderMerchantSuggestions();
      },
    });

    // 连续记账只保留可见的分类摘要，避免地点和支付方式悄悄误带。
    _formState.amountRaw = '';
    _confirmedLargeAmountRaw = null;
    _formState.note = '';
    _formState.location = '';
    _formState.paymentMethod = '';
    _paymentOptionsExpanded = false;
    const noteInput = document.getElementById('add-note');
    const locInput = document.getElementById('add-location');
    const moreFields = document.getElementById('add-more-fields');
    if (noteInput) noteInput.value = '';
    if (locInput) locInput.value = '';
    if (moreFields) moreFields.open = false;
    _updateAmountDisplay();
    _refreshTimestampAfterSave();

    // 分类继续保持收纳状态；想换分类时可点摘要展开。
    _renderAddCategories();

    // 支付方式回到“可选”状态，不让上一笔支付渠道造成误记。
    _renderPaymentMethods();
    _renderMerchantSuggestions();
  }

  /* -----------------------------------------------------------------
     Toast 提示
     ----------------------------------------------------------------- */
  function _toast(message, type, options = {}) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast--${type || ''}`;
    if (options.actionLabel && typeof options.onAction === 'function') el.classList.add('toast--actionable');
    const copy = document.createElement('span');
    copy.className = 'toast__copy';
    copy.textContent = message;
    el.appendChild(copy);

    if (options.actionLabel && typeof options.onAction === 'function') {
      const action = document.createElement('button');
      action.className = 'toast__action';
      action.type = 'button';
      action.textContent = options.actionLabel;
      el.appendChild(action);
      action.addEventListener('click', () => {
        removeEl();
        options.onAction();
      }, { once: true });
    }

    container.appendChild(el);

    const removeEl = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };

    // 默认 1.5 秒；带撤销的成功反馈延长，给用户稳定的纠错窗口。
    setTimeout(() => {
      if (!el.parentNode) return;
      el.classList.add('toast--removing');

      // 动画结束后从 DOM 移除
      el.addEventListener('animationend', removeEl, { once: true });

      // 兜底：0.35s 后强制移除（防止 animationend 不触发导致残留）
      setTimeout(removeEl, 350);
    }, options.duration || 1500);
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
                <span style="width:32px;display:inline-flex;align-items:center;justify-content:center">${ExpenseCategories.getIconMarkup(cat)}</span>
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
            ${ExpenseCategories.getIconMarkup(p)}
            <span>${p.name}</span>
            <span style="font-size:11px;color:var(--color-text-tertiary);font-weight:400">${p.isPreset ? '预设' : '自定义'}</span>
            ${!p.isPreset ? `<button class="btn btn--ghost btn--small" data-del-cat="${p.id}" style="color:var(--color-danger);font-size:11px;margin-left:auto">删除</button>` : ''}
          </div>
          <div style="padding-left:24px">
            ${children.map(c => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-divider)">
                <span style="display:flex;align-items:center;gap:4px;font-size:14px">
                  ${ExpenseCategories.getIconMarkup(c)}
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
          _renderAddCategories();
          _updateSaveState();
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
      _renderAddCategories();
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
      manageBtn.addEventListener('click', () => {
        ExpenseCategories.closePicker();
        _openCategoryManager();
      });
    }

    // 分类管理覆盖层 — 右上角 ✕ 返回按钮：关闭覆盖层，切回记账页
    document.getElementById('overlay-categories-back').addEventListener('click', () => {
      document.getElementById('overlay-categories').classList.remove('page-overlay--open');
      navigate('add');
      // 刷新记账页的分类入口
      _renderAddCategories();
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
    const primaryAddBtn = document.getElementById('home-primary-add');
    if (primaryAddBtn) {
      primaryAddBtn.addEventListener('click', () => navigate('add'));
    }

    // 设置预算按钮
    const setBudgetBtn = document.getElementById('home-set-budget');
    if (setBudgetBtn) {
      setBudgetBtn.addEventListener('click', _openBudgetOverlay);
    }

    // 预算提醒卡片 ⚙️ → 打开预算设置
    const budgetEditBtn = document.getElementById('home-budget-alert-edit');
    if (budgetEditBtn) {
      budgetEditBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _openBudgetOverlay();
      });
    }

    // 查看全部 → 跳转账单页
    const viewAllBtn = document.getElementById('home-view-all');
    if (viewAllBtn) {
      viewAllBtn.addEventListener('click', () => navigate('list'));
    }

    // 最近记录点击 → 打开编辑覆盖层 / 跳转记账页（事件委托）
    const recentContainer = document.getElementById('home-recent');
    if (recentContainer) {
      recentContainer.addEventListener('click', (e) => {
        // "+ 记一笔"入口 → 跳转到记账页
        if (e.target.closest('.home-recent__add')) {
          navigate('add');
          return;
        }
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

      const pmBtn = body.querySelector('[data-edit-pm].chip--active');

      ExpenseDB.updateExpense(expenseId, {
        amount:        amountVal,
        categoryId:    document.getElementById('edit-category').value,
        location:      document.getElementById('edit-location').value,
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
