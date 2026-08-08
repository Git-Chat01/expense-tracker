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
    necessity: '',        // 价值评定：need/want/impulse，空串=未评估（可选填）
    note: '',
    date: '',
    time: '',
    dateTimeManuallyEdited: false,
  };
  const _LARGE_AMOUNT_THRESHOLD = 10000;
  let _confirmedLargeAmountRaw = null;
  let _paymentOptionsExpanded = false;
  let _necessityOptionsExpanded = false;  // 价值评定选择器展开状态（v187 起与支付方式同款交互）
  let _paymentHandTouched = false;   // 用户手动改过支付方式（切分类时不被习惯覆盖）
  let _necessityHandTouched = false; // 用户手动改过价值评定（切分类时不被习惯覆盖）

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
    _lockOverlayScroll();
  }

  function _closeEditSheet() {
    const sheet = document.getElementById('overlay-edit');
    const backdrop = document.getElementById('overlay-edit-backdrop');
    if (sheet) sheet.classList.remove('bottom-sheet--open');
    if (backdrop) backdrop.classList.remove('bottom-sheet-backdrop--open');
    _unlockOverlayScroll();
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

    // 4. 渲染支付方式 + 价值评定三键
    _renderPaymentMethods();
    _renderNecessityOptions();
    _updateAmountDisplay();

    // 5. 绑定事件
    _bindTabBar();
    _bindNumpad();
    _bindAddForm();
    _bindPaymentSummary();
    _bindNecessitySummary();
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

    // 9. 新手引导（仅首次访问展示，关闭后写入 settings.onboardingSeen）
    if (typeof ExpenseOnboarding !== 'undefined') ExpenseOnboarding.start();
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
        // v187：分类已清空 → 保持展开（有分类时按条件概率预填）
        _applyHabitDefaults();
      }
      _renderAddCategories();
      _renderPaymentMethods();
      _renderNecessityOptions();
      _renderMerchantSuggestions();
      _updateAmountDisplay();
    } else if (viewId === 'list') {
      if (typeof ExpenseList !== 'undefined') {
        try {
          ExpenseList.render();
        } catch (e) {
          console.error('[App] ExpenseList.render 异常:', e);
          var lc = document.getElementById('list-content');
          if (lc) lc.innerHTML = '<div class="empty-state"><div class="empty-state__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg></div><p class="empty-state__text">渲染出错</p><p class="empty-state__hint">' + ExpenseData.escapeHtml(e.message) + '</p></div>';
        }
      } else {
        console.error('[App] ExpenseList 未定义，list.js 可能加载失败');
        var lc2 = document.getElementById('list-content');
        if (lc2) lc2.innerHTML = '<div class="empty-state"><div class="empty-state__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg></div><p class="empty-state__text">模块加载失败</p><p class="empty-state__hint">请刷新页面重试</p></div>';
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
      // v187：选中分类后按条件概率预填支付方式与价值评定（无习惯则保持展开）
      _applyHabitDefaults();
      _renderPaymentMethods();
      _renderNecessityOptions();
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
      // v194：整数部分全为 0 且尚未输入小数点时直接替换（"00"+5 → "5"），不显示前导零
      if (parts.length === 1 && /^0+$/.test(parts[0])) {
        _formState.amountRaw = k;
      } else {
        _formState.amountRaw += k;
      }
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
  function _bindPaymentSummary() {
    const summary = document.getElementById('add-payment-summary');
    if (!summary) return;
    summary.addEventListener('click', () => {
      _paymentOptionsExpanded = !_paymentOptionsExpanded;
      _renderPaymentMethods();
    });
  }

  function _renderPaymentMethods() {
    const container = document.getElementById('add-payment-methods');
    const summary = document.getElementById('add-payment-summary');
    const summaryText = document.getElementById('add-payment-summary-text');
    const summaryDot = document.getElementById('add-payment-summary-dot');
    const summaryAction = document.getElementById('add-payment-summary-action');
    const section = document.querySelector('.add-payment-section');
    if (!container) return;

    const selectedMethod = ExpenseData.PAYMENT_METHODS.find(pm => pm.value === _formState.paymentMethod);
    const pickerOpen = _paymentOptionsExpanded;
    if (summary) {
      summary.style.display = 'grid';
      summary.setAttribute('aria-expanded', String(pickerOpen));
      summary.setAttribute('aria-label', selectedMethod
        ? `已选择${selectedMethod.label}，${pickerOpen ? '点击收起支付方式' : '点击更换支付方式'}`
        : `${pickerOpen ? '正在选择支付方式，点击收起' : '选择支付方式'}`);
    }
    container.style.display = pickerOpen ? 'grid' : 'none';
    if (section) {
      section.classList.toggle('add-payment-section--selected', Boolean(selectedMethod));
      section.classList.toggle('add-payment-section--expanded', pickerOpen);
    }

    if (summaryText) summaryText.textContent = selectedMethod
      ? `已选 ${selectedMethod.label}`
      : (pickerOpen ? '选择支付方式' : '可选');
    if (summaryAction) summaryAction.textContent = pickerOpen
      ? '收起'
      : (selectedMethod ? '更换' : '选择');
    if (summaryDot) {
      summaryDot.style.display = selectedMethod ? 'inline-block' : 'none';
      if (selectedMethod) summaryDot.style.background = selectedMethod.color;
    }

    if (!pickerOpen) return;

    container.innerHTML = ExpenseData.PAYMENT_METHODS.map(pm => {
      const isActive = _formState.paymentMethod === pm.value;
      const rgb = ExpenseData.hexToRgb(pm.color);
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
        _paymentHandTouched = true;  // v187：手动选择过，切分类时不再被习惯覆盖
        _renderPaymentMethods();
      });
    });
  }

  /* -----------------------------------------------------------------
     价值评定（必需/可选/冲动）
     v187 起与支付方式同款交互：默认收起为一个文字行，点按展开三键，
     选完自动收起（显示"已选 XX"），再点已选项 = 取消（回到未评估）
     ----------------------------------------------------------------- */
  function _bindNecessitySummary() {
    const summary = document.getElementById('add-necessity-summary');
    if (!summary) return;
    summary.addEventListener('click', () => {
      _necessityOptionsExpanded = !_necessityOptionsExpanded;
      _renderNecessityOptions();
    });
  }

  function _renderNecessityOptions() {
    const container = document.getElementById('add-necessity-options');
    const summary = document.getElementById('add-necessity-summary');
    const summaryText = document.getElementById('add-necessity-summary-text');
    const summaryDot = document.getElementById('add-necessity-summary-dot');
    const summaryAction = document.getElementById('add-necessity-summary-action');
    const section = document.querySelector('.add-necessity-section');
    if (!container) return;

    const selectedOpt = ExpenseData.NECESSITY_OPTIONS.find(o => o.value === _formState.necessity);
    const pickerOpen = _necessityOptionsExpanded;
    if (summary) {
      summary.setAttribute('aria-expanded', String(pickerOpen));
      summary.setAttribute('aria-label', selectedOpt
        ? `已选择${selectedOpt.label}，${pickerOpen ? '点击收起价值评定' : '点击更换价值评定'}`
        : `${pickerOpen ? '正在选择价值评定，点击收起' : '选择价值评定'}`);
    }
    container.style.display = pickerOpen ? 'grid' : 'none';
    if (section) section.classList.toggle('add-necessity-section--expanded', pickerOpen);

    if (summaryText) summaryText.textContent = selectedOpt
      ? `已选 ${selectedOpt.label}`
      : (pickerOpen ? '选择价值评定' : '可选');
    if (summaryAction) summaryAction.textContent = pickerOpen
      ? '收起'
      : (selectedOpt ? '更换' : '选择');
    if (summaryDot) {
      summaryDot.style.display = selectedOpt ? 'inline-block' : 'none';
      if (selectedOpt) summaryDot.style.background = selectedOpt.color;
    }

    if (!pickerOpen) return;

    container.innerHTML = ExpenseData.NECESSITY_OPTIONS.map(opt => {
      const isActive = _formState.necessity === opt.value;
      const rgb = ExpenseData.hexToRgb(opt.color);
      // 未选中：淡语义色底 + 语义色字；选中：实心语义色 + 白字（与支付方式 chip 同构）
      const bg   = isActive ? opt.color : `rgba(${rgb},0.1)`;
      const bd   = isActive ? opt.color : `rgba(${rgb},0.3)`;
      const text = isActive ? '#fff' : opt.color;
      return `<button class="chip chip--necessity ${isActive ? 'chip--active' : ''}" data-necessity="${opt.value}" type="button" style="background:${bg};border-color:${bd};color:${text}">${opt.icon} ${opt.label}</button>`;
    }).join('');

    container.querySelectorAll('.chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const val = chip.dataset.necessity;
        // 再点已选项 = 取消（未评估），点其他项 = 切换；选完自动收起
        _formState.necessity = (_formState.necessity === val) ? '' : val;
        _necessityOptionsExpanded = false;
        _necessityHandTouched = true;  // v187：手动选择过，切分类时不再被习惯覆盖
        _renderNecessityOptions();
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
    const addView = document.getElementById('view-add');

    // v211：只有地点或备注输入框真正获得焦点时才让出原生键盘。
    // blur 延后一拍复查，避免在两个文本框之间切换时数字键盘闪现。
    const syncTextInputFocus = () => {
      const active = document.activeElement;
      const isTextInputActive = active === locInput || active === noteInput;
      if (addView) addView.classList.toggle('add-text-input-active', isTextInputActive);
    };
    [locInput, noteInput].forEach(input => {
      if (!input) return;
      input.addEventListener('focus', syncTextInputFocus);
      input.addEventListener('blur', () => setTimeout(syncTextInputFocus, 0));
    });

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
      // v187：商家建议填充分类同样触发条件概率预填
      _applyHabitDefaults();
      _renderPaymentMethods();
      _renderNecessityOptions();
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
    return ExpenseDB.dateToYMD(date);
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
        toggleBtn.innerHTML = `<span aria-hidden="true">日历</span><span id="add-date-label">今天</span><span id="add-time-label">${ExpenseData.escapeHtml(_formState.time)}</span><span class="add-date-quick__chevron" aria-hidden="true">⌄</span>`;
        // 重新获取 label 引用（innerHTML 替换后需要）
        _updateDateLabels();
      } else {
        inputs.style.display = 'flex';
        toggleBtn.setAttribute('aria-expanded', 'true');
        toggleBtn.innerHTML = `<span aria-hidden="true">日历</span><span id="add-date-label">今天</span><span id="add-time-label">${ExpenseData.escapeHtml(_formState.time)}</span><span class="add-date-quick__chevron" aria-hidden="true">⌃</span>`;
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
     记账习惯预填（v187 · 条件概率版）
     按"所选分类 → 父分类（含其全部子分类）→ 全局"回退链统计
     用户行为习惯：P(支付方式|分类)、P(价值评定|分类)。
     某一层样本 ≥5 笔且某项占比 ≥70% 时，预填该项并收起（显示"已选"）；
     整条链都没有 → 不预填、展开选项让用户选。
     用户手动改过的字段不覆盖。纯读取历史账单，零写入，符合数据安全红线。
     ----------------------------------------------------------------- */
  let _habitStatsCache = null;   // { direct: {catId→层}, parent: {父分类Id→层}, global: 层 }
                                 // 层 = { counts: {paymentMethod: 次数}, total: 总样本数 }

  /** 数据变更后使习惯统计缓存失效（下次选分类时自动重建） */
  function _invalidateHabitStatsCache() {
    _habitStatsCache = null;
  }

  /** 一次遍历构建三层统计：direct=精确分类，parent=父分类（含其全部子分类账单），global=全局 */
  function _buildHabitStats() {
    // 分类关系：子分类 → 父分类映射 + 父分类集合（无 parentId 者视为父分类）
    const parentOf = {};
    const parentSet = new Set();
    ExpenseDB.getCategories().forEach(c => {
      if (c.parentId) parentOf[c.id] = c.parentId;
      else parentSet.add(c.id);
    });
    const stats = { direct: {}, parent: {}, global: { counts: {}, total: 0 } };

    ExpenseDB.getExpenses().forEach(e => {
      const v = e.paymentMethod;
      if (!v) return;
      // 全局层
      stats.global.counts[v] = (stats.global.counts[v] || 0) + 1;
      stats.global.total++;
      const catId = e.categoryId;
      if (!catId) return;
      // 精确分类层
      if (!stats.direct[catId]) stats.direct[catId] = { counts: {}, total: 0 };
      stats.direct[catId].counts[v] = (stats.direct[catId].counts[v] || 0) + 1;
      stats.direct[catId].total++;
      // 父级层：账单挂在父分类自己或任一子分类，都计入该父级
      const pid = parentOf[catId] || (parentSet.has(catId) ? catId : null);
      if (pid) {
        if (!stats.parent[pid]) stats.parent[pid] = { counts: {}, total: 0 };
        stats.parent[pid].counts[v] = (stats.parent[pid].counts[v] || 0) + 1;
        stats.parent[pid].total++;
      }
    });
    return stats;
  }

  function _applyHabitDefaults() {
    // 支付方式：按「分类 → 父分类 → 全局」条件概率预填（支付渠道有行为惯性，值得猜）
    // 价值评定：每笔消费的价值判断独立，从不自动默认，始终展开让用户自选
    if (_formState.categoryId) {
      if (!_paymentHandTouched) {
        _formState.paymentMethod = _guessHabitForCategory(
          ExpenseData.PAYMENT_METHODS.map(p => p.value),
          e => e.paymentMethod
        );
        _paymentOptionsExpanded = !_formState.paymentMethod;
      }
    } else {
      // 未选分类：不预填，完全展示让用户选
      _formState.paymentMethod = '';
      _paymentOptionsExpanded = true;
    }
    // 价值评定：非手动状态一律展开（手动选过后保持收起，尊重用户本次选择）
    if (!_necessityHandTouched) _necessityOptionsExpanded = true;
  }

  /** 按回退链逐层猜习惯：选中分类 → 父分类（含其所有子分类）→ 全局 → 空串（不猜） */
  function _guessHabitForCategory(values, pick) {
    // 统计缓存：账单只在数据变更时重建，避免每次选分类都全量遍历
    if (!_habitStatsCache) _habitStatsCache = _buildHabitStats();
    const stats = _habitStatsCache;
    const catId = _formState.categoryId;
    if (catId) {
      const cat = ExpenseDB.getCategory(catId);
      // 第一层：选中的具体分类（如"外卖"）
      if (stats.direct[catId]) {
        const direct = _pickHabitByThreshold(stats.direct[catId], values);
        if (direct) return direct;
      }
      // 第二层：父分类及其全部子分类（如"餐饮"下所有账单，样本更足）
      if (cat && cat.parentId && stats.parent[cat.parentId]) {
        const parentHit = _pickHabitByThreshold(stats.parent[cat.parentId], values);
        if (parentHit) return parentHit;
      }
    }
    // 第三层：全局习惯
    return _pickHabitByThreshold(stats.global, values);
  }

  /** 在某一层统计中找占比 ≥70% 且样本 ≥5 的项；没有则空串（与原 _guessHabit 判定完全一致） */
  function _pickHabitByThreshold(layer, values) {
    if (layer.total < 5) return '';
    for (const v of values) {
      if ((layer.counts[v] || 0) / layer.total >= 0.7) return v;
    }
    return '';
  }

  /* -----------------------------------------------------------------
     重置表单默认值（每次从其他页面进入记账页时调用）
     ----------------------------------------------------------------- */
  function _resetFormDefaults(options = {}) {
    const { clearTransient = true } = options;
    _formState.amountRaw = '';
    _confirmedLargeAmountRaw = null;
    _paymentOptionsExpanded = false;
    _necessityOptionsExpanded = false;
    _formState.note = '';
    _formState.date = ExpenseDB.today();
    _formState.time = ExpenseDB.now();
    _formState.dateTimeManuallyEdited = false;

    if (clearTransient) {
      _formState.location = '';
      _formState.paymentMethod = '';
      _formState.necessity = '';
      // 重置手动标记：下一笔重新从习惯/选择开始（分类选择后由 _applyHabitDefaults 再算）
      _paymentHandTouched = false;
      _necessityHandTouched = false;
      _paymentOptionsExpanded = true;    // 进页面未选分类：完全展示让用户选
      _necessityOptionsExpanded = true;
    }

    // 分类会保留为可见摘要，地点、支付方式和价值评定不会默默带入新的一笔。
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
      dateQuick.innerHTML = `<span aria-hidden="true">日历</span><span id="add-date-label">今天</span><span id="add-time-label">${ExpenseData.escapeHtml(_formState.time)}</span><span class="add-date-quick__chevron" aria-hidden="true">⌄</span>`;
      _updateDateLabels();
    }
  }

  function _refreshTimestampAfterSave() {
    // 用户手动回填过时间时绝不覆盖；普通连续记账则把下一笔更新为现在。
    if (_formState.dateTimeManuallyEdited) return;

    _formState.date = ExpenseDB.today();
    _formState.time = ExpenseDB.now();

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
      _confirmDialog({
        title: '确认这笔大额支出？',
        message: `将记录 ¥${amountText} 的支出。`,
        confirmText: '确认记录',
      }).then(ok => {
        if (!ok) return;
        _confirmedLargeAmountRaw = _formState.amountRaw;
        _commitSave();
      });
      return;
    }

    _commitSave();
  }

  /** 实际写入记录（大金额确认通过后调用；window.confirm 在 iOS 独立 PWA 被禁用，确认改为自绘弹窗） */
  function _commitSave() {
    const amount = parseFloat(_formState.amountRaw);
    const record = ExpenseDB.addExpense({
      amount:        amount,
      categoryId:    _formState.categoryId,
      date:          _formState.date,
      time:          _formState.time,
      location:      _formState.location,
      paymentMethod: _formState.paymentMethod,
      necessity:     _formState.necessity,   // 价值评定：need/want/impulse，未选则为空串
      note:          _formState.note,
    });

    if (!record) {
      _toast('保存失败，请检查浏览器存储空间后重试', 'warning');
      return;
    }
    _invalidateHabitStatsCache();  // 数据已变更，习惯统计缓存作废

    _toast(`已记录 ¥${amount.toFixed(2)}`, 'success', {
      actionLabel: '撤销',
      duration: 5000,
      onAction: () => {
        if (!ExpenseDB.deleteExpense(record.id)) {
          _toast('撤销失败，这笔记录仍然保留', 'warning');
          return;
        }
        _invalidateHabitStatsCache();
        _toast('已撤销本次记录', 'success');
        ExpenseHome.render();
        if (typeof ExpenseList !== 'undefined') ExpenseList.render();
        if (typeof ExpenseStats !== 'undefined') ExpenseStats.render();
        _renderMerchantSuggestions();
      },
    });

    // 连续记账只保留可见的分类摘要，避免地点、支付方式和价值评定悄悄误带。
    _formState.amountRaw = '';
    _confirmedLargeAmountRaw = null;
    _formState.note = '';
    _formState.location = '';
    _paymentHandTouched = false;
    _necessityHandTouched = false;
    _formState.paymentMethod = '';
    _formState.necessity = '';
    // v187：分类保留时按该分类的条件概率预填下一笔（无习惯则展开让用户选）
    _applyHabitDefaults();
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
    // 价值评定回到未评估状态（下一笔重新判断，不默带）
    _renderNecessityOptions();
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
     应用内确认弹窗（替代 window.confirm / confirm）
     背景：iOS 独立 PWA（添加到主屏幕）下 alert/confirm/prompt 被系统
     禁用并静默返回 false——删除记录与大金额确认在这些设备上点击无反应。
     自绘弹窗跨环境行为一致；单例 DOM 只创建一次，事件只绑定一次。
     ----------------------------------------------------------------- */
  let _confirmResolver = null;  // 当前弹窗的 resolve（同一时刻只允许一个确认弹窗）

  function _confirmDialog(options) {
    const { title = '请确认', message = '', confirmText = '确定', cancelText = '取消', danger = false } = options || {};

    // 单例：首次调用创建 DOM 并绑定事件，后续只更新文案
    let overlay = document.getElementById('confirm-dialog');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirm-dialog';
      overlay.className = 'confirm-dialog';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = `
        <div class="confirm-dialog__backdrop" data-confirm-cancel></div>
        <div class="confirm-dialog__card">
          <p class="confirm-dialog__title"></p>
          <p class="confirm-dialog__message"></p>
          <div class="confirm-dialog__actions">
            <button type="button" class="btn confirm-dialog__cancel" data-confirm-cancel>取消</button>
            <button type="button" class="btn confirm-dialog__ok" data-confirm-ok>确定</button>
          </div>
        </div>
      `;
      overlay.querySelector('[data-confirm-ok]').addEventListener('click', () => _resolveConfirm(true));
      overlay.querySelectorAll('[data-confirm-cancel]').forEach(el => el.addEventListener('click', () => _resolveConfirm(false)));
      document.body.appendChild(overlay);
    }

    overlay.querySelector('.confirm-dialog__title').textContent = title;
    overlay.querySelector('.confirm-dialog__message').textContent = message;
    overlay.querySelector('.confirm-dialog__cancel').textContent = cancelText;
    const okBtn = overlay.querySelector('.confirm-dialog__ok');
    okBtn.textContent = confirmText;
    // 危险操作（如删除）用红色按钮，普通确认用主色按钮
    okBtn.classList.toggle('btn--danger', danger);
    okBtn.classList.toggle('btn--primary', !danger);

    overlay.classList.add('confirm-dialog--open');
    return new Promise(resolve => { _confirmResolver = resolve; });
  }

  /** 关闭确认弹窗并返回用户选择（true=确认，false=取消/点遮罩） */
  function _resolveConfirm(result) {
    const overlay = document.getElementById('confirm-dialog');
    if (overlay) overlay.classList.remove('confirm-dialog--open');
    if (_confirmResolver) {
      const resolve = _confirmResolver;
      _confirmResolver = null;
      resolve(result);
    }
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
                <span style="flex:1;font-size:14px">${ExpenseData.escapeHtml(cat.name)}</span>
                <div style="display:flex;align-items:center;gap:4px">
                  <span style="font-size:14px">¥</span>
                  <input type="number" class="input cat-budget-input" data-cat-id="${ExpenseData.escapeHtml(cat.id)}"
                         value="${ExpenseData.escapeHtml(catBudget)}" placeholder="不限" min="0" step="100"
                         style="width:100px;text-align:right">
                </div>
                ${catBudget > 0 ? `<span style="font-size:11px;color:var(--color-text-tertiary);width:60px;text-align:right">${spent > catBudget ? '<svg viewBox="0 0 24 24" class="inline-icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg>超支' : Math.round(spent/catBudget*100)+'%'}</span>` : '<span style="width:60px"></span>'}
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
      if (!ExpenseDB.saveBudget(newBudget)) {
        _toast('预算保存失败，请检查浏览器存储空间', 'warning');
        return;
      }
      _toast('预算已保存', 'success');
      _unlockOverlayScroll();
      overlay.classList.remove('page-overlay--open');
      ExpenseHome.render();
    });

    // 重置
    document.getElementById('budget-btn-reset').addEventListener('click', () => {
      _confirmDialog({
        title: '清空全部预算设置？',
        message: '各分类预算将恢复为默认值。',
        confirmText: '清空',
        danger: true,
      }).then(ok => {
        if (!ok) return;
        if (!ExpenseDB.saveBudget(ExpenseData.DEFAULT_BUDGET)) {
          _toast('预算重置失败，请检查浏览器存储空间', 'warning');
          return;
        }
        _toast('预算已重置', 'success');
        _unlockOverlayScroll();
        overlay.classList.remove('page-overlay--open');
        ExpenseHome.render();
      });
    });

    overlay.classList.add('page-overlay--open');
    _lockOverlayScroll();
  }

  /* =================================================================
     分类管理 — 独立全屏页面（覆盖层，从右侧滑入）
     ================================================================= */

  let _overlayScrollYBefore = 0;

  /** 打开全屏覆盖层：锁住背景滚动并记录原位置（与分类抽屉同一模式，防移动端滚动穿透） */
  function _lockOverlayScroll() {
    _overlayScrollYBefore = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.style.top = `-${_overlayScrollYBefore}px`;
    document.body.classList.add('page-overlay-open');
    document.documentElement.classList.add('page-overlay-open');
  }

  /** 关闭全屏覆盖层：解锁滚动，精确回到打开前的位置 */
  function _unlockOverlayScroll() {
    document.body.style.top = '';
    document.body.classList.remove('page-overlay-open');
    document.documentElement.classList.remove('page-overlay-open');
    window.scrollTo(0, _overlayScrollYBefore);
  }

  /** 打开分类管理覆盖层，渲染分类列表 */
  function _openCategoryManager() {
    const overlay = document.getElementById('overlay-categories');
    if (!overlay) return;
    _renderCategoryManagerOverlay();
    overlay.classList.add('page-overlay--open');
    _lockOverlayScroll();
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
            <span>${ExpenseData.escapeHtml(p.name)}</span>
            <span style="font-size:11px;color:var(--color-text-tertiary);font-weight:400">${p.isPreset ? '预设' : '自定义'}</span>
            ${!p.isPreset ? `
              <span style="margin-left:auto;display:flex;gap:6px">
                <button class="btn btn--ghost btn--small" data-edit-cat="${ExpenseData.escapeHtml(p.id)}" style="font-size:11px">编辑</button>
                <button class="btn btn--ghost btn--small" data-del-cat="${ExpenseData.escapeHtml(p.id)}" style="color:var(--color-danger);font-size:11px">删除</button>
              </span>` : ''}
          </div>
          <div style="padding-left:24px">
            ${children.map(c => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--color-divider)">
                <span style="display:flex;align-items:center;gap:4px;font-size:14px">
                  ${ExpenseCategories.getIconMarkup(c)}
                  <span>${ExpenseData.escapeHtml(c.name)}</span>
                  <span style="font-size:11px;color:var(--color-text-tertiary)">${c.isPreset ? '预设' : '自定义'}</span>
                </span>
                ${!c.isPreset ? `
                  <span style="display:flex;gap:6px">
                    <button class="btn btn--ghost btn--small" data-edit-cat="${ExpenseData.escapeHtml(c.id)}" style="font-size:11px">编辑</button>
                    <button class="btn btn--ghost btn--small" data-del-cat="${ExpenseData.escapeHtml(c.id)}" style="color:var(--color-danger);font-size:11px">删除</button>
                  </span>` : ''}
              </div>
            `).join('')}
            ${children.length === 0 ? '<div style="padding:6px 0;font-size:12px;color:var(--color-text-tertiary)">暂无子分类</div>' : ''}
          </div>
        </div>`;
    }).join('');

    // 绑定删除事件（级联删除：一级分类的子分类会一并删除，确认框明示）
    body.querySelectorAll('[data-del-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const catId = btn.dataset.delCat;
        const cat = ExpenseDB.getCategory(catId);
        if (!cat) return;
        const children = ExpenseDB.getChildCategories(catId);
        const message = children.length > 0
          ? `该分类下的历史账单会显示为「未分类」，不会被删除。\n其 ${children.length} 个子分类（${children.map(c => c.name).join('、')}）将一并删除。`
          : '该分类下的历史账单会显示为「未分类」，不会被删除。';
        _confirmDialog({
          title: `删除分类「${cat.name}」？`,
          message,
          confirmText: '删除',
          danger: true,
        }).then(ok => {
          if (!ok) return;
          if (!ExpenseDB.deleteCategory(catId)) {
            _toast('分类删除失败，请检查浏览器存储空间', 'warning');
            return;
          }
          _invalidateHabitStatsCache();  // 分类关系变了，父级统计可能受影响
          // 当前选中分类被删（含被级联删除的子分类）→ 无分类，还原为展开让用户选
          if (_formState.categoryId && !ExpenseDB.getCategory(_formState.categoryId)) {
            _formState.categoryId = '';
            _applyHabitDefaults();
            _renderPaymentMethods();
            _renderNecessityOptions();
          }
          _renderCategoryManagerOverlay();
          _renderAddCategories();
          _updateSaveState();
        });
      });
    });

    // 绑定编辑事件
    body.querySelectorAll('[data-edit-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        _showEditCategoryForm(btn.dataset.editCat);
      });
    });
  }

  /** 渲染常用线条图标选择网格：点选把图标名填入输入框并高亮；手输 emoji 时联动取消高亮 */
  function _renderCategoryIconPicker(inputId, containerId) {
    const input = document.getElementById(inputId);
    const container = document.getElementById(containerId);
    if (!input || !container) return;

    // 线条图标网格（与预设分类同风格）；手输 emoji 依然可用，渲染端对非图标名值走 emoji 兜底
    // 按钮悬停/无障碍提示用中文名（图标名是存储标识符，用户不需要理解）
    container.innerHTML = ExpenseIcons.CATEGORY_ICON_PRESETS.map(name =>
      `<button type="button" class="cat-icon-pick" data-icon="${name}" title="${(ExpenseIcons.CATEGORY_ICON_NAMES_ZH[name] || name)}" aria-label="选择图标：${(ExpenseIcons.CATEGORY_ICON_NAMES_ZH[name] || name)}">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${ExpenseIcons.CATEGORY_ICON_PATHS[name]}</svg>
      </button>`
    ).join('');

    // 高亮与输入框当前值一致的图标（点选、手输都走这里；手输 emoji 无匹配 → 全部取消高亮）
    // 同时把当前图标的含义翻译成中文显示在输入框下方，避免用户面对英文标识符
    const nameHint = document.getElementById(inputId + '-name');
    const updateNameHint = () => {
      if (!nameHint) return;
      const current = input.value.trim();
      if (!current) {
        nameHint.textContent = '当前图标：未选择';
      } else if (ExpenseIcons.CATEGORY_ICON_NAMES_ZH[current]) {
        nameHint.textContent = '当前图标：' + ExpenseIcons.CATEGORY_ICON_NAMES_ZH[current];
      } else {
        nameHint.textContent = '当前图标：自定义表情';
      }
    };
    const syncHighlight = () => {
      const current = input.value.trim();
      container.querySelectorAll('.cat-icon-pick').forEach(btn => {
        btn.classList.toggle('cat-icon-pick--selected', btn.dataset.icon === current);
      });
      updateNameHint();
    };

    container.querySelectorAll('.cat-icon-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        input.value = btn.dataset.icon;
        syncHighlight();
      });
    });
    input.addEventListener('input', syncHighlight);
    syncHighlight();
  }

  /** 同层重名检测：父级相同（含同为顶级）且非自身即视为冲突 */
  function _isCategoryNameTaken(name, parentId, excludeId) {
    return ExpenseDB.getCategories().some(c =>
      c.id !== excludeId &&
      c.name === name &&
      (c.parentId || null) === (parentId || null)
    );
  }

  /** 在覆盖层 body 中渲染编辑分类表单（仅自定义分类；改名/改图标不影响历史账单） */
  function _showEditCategoryForm(catId) {
    const body = document.getElementById('overlay-categories-body');
    const cat = ExpenseDB.getCategory(catId);
    if (!body || !cat || cat.isPreset) return;

    // 一级分类可选的父级排除自身（不能把自己挂到自己下面）
    const parents = ExpenseDB.getParentCategories().filter(p => p.id !== catId);
    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">所属一级分类</label>
          <select class="input" id="edit-cat-parent">
            <option value="">-- 设为一级分类 --</option>
            ${parents.map(p => `<option value="${ExpenseData.escapeHtml(p.id)}" ${cat.parentId === p.id ? 'selected' : ''}>${ExpenseData.escapeHtml(p.icon)} ${ExpenseData.escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">分类名称 <span style="color:var(--color-danger)">*</span></label>
          <input type="text" class="input" id="edit-cat-name" value="${ExpenseData.escapeHtml(cat.name)}" placeholder="例如：宠物" maxlength="10">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">图标 <span style="font-weight:400;color:var(--color-text-tertiary);font-size:12px">点下方图标快速选择，或手输</span></label>
          <input type="text" class="input" id="edit-cat-icon" value="${ExpenseData.escapeHtml(cat.icon)}" placeholder="例如：🐱（留空默认 📌）" maxlength="4">
          <div class="cat-icon-name" id="edit-cat-icon-name"></div>
          <div class="cat-icon-picker" id="edit-cat-icon-picker"></div>
        </div>
        <div style="display:flex;gap:8px">
          <button class="btn btn--primary" id="edit-cat-save" style="flex:1">保存修改</button>
          <button class="btn btn--ghost" id="edit-cat-cancel">取消</button>
        </div>
      </div>
    `;

    document.getElementById('edit-cat-save').addEventListener('click', () => {
      const name = document.getElementById('edit-cat-name').value.trim();
      if (!name) { _toast('请输入分类名称', 'warning'); return; }
      const icon = document.getElementById('edit-cat-icon').value.trim() || '📌';
      const parentId = document.getElementById('edit-cat-parent').value || null;
      if (_isCategoryNameTaken(name, parentId, catId)) {
        _toast('同层已存在同名分类，请换一个名称', 'warning');
        return;
      }
      if (!ExpenseDB.updateCategory(catId, { name, icon, parentId })) {
        _toast('分类修改失败，请检查浏览器存储空间', 'warning');
        return;
      }
      _toast(`已保存分类「${name}」`, 'success');
      _invalidateHabitStatsCache();  // 换父级会让父分类聚合统计过期
      _renderCategoryManagerOverlay();
      // 名称/图标/父级变化会同步到记账页分类入口与已选分类摘要（renderGrid 内刷新）
      _renderAddCategories();
    });

    document.getElementById('edit-cat-cancel').addEventListener('click', () => {
      _renderCategoryManagerOverlay();
    });

    _renderCategoryIconPicker('edit-cat-icon', 'edit-cat-icon-picker');
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
            ${parents.map(p => `<option value="${ExpenseData.escapeHtml(p.id)}">${ExpenseData.escapeHtml(p.icon)} ${ExpenseData.escapeHtml(p.name)}</option>`).join('')}
          </select>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">分类名称 <span style="color:var(--color-danger)">*</span></label>
          <input type="text" class="input" id="new-cat-name" placeholder="例如：宠物" maxlength="10">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">图标 <span style="font-weight:400;color:var(--color-text-tertiary);font-size:12px">点下方图标快速选择，或手输</span></label>
          <input type="text" class="input" id="new-cat-icon" placeholder="例如：🐱（留空默认 📌）" maxlength="4">
          <div class="cat-icon-name" id="new-cat-icon-name"></div>
          <div class="cat-icon-picker" id="new-cat-icon-picker"></div>
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
      if (_isCategoryNameTaken(name, parentId)) {
        _toast('同层已存在同名分类，请换一个名称', 'warning');
        return;
      }

      if (!ExpenseDB.addCategory({ name, icon, parentId })) {
        _toast('分类添加失败，请检查浏览器存储空间', 'warning');
        return;
      }
      _toast(`已添加分类「${name}」`, 'success');
      _renderCategoryManagerOverlay();
      _renderAddCategories();
    });

    document.getElementById('new-cat-cancel').addEventListener('click', () => {
      _renderCategoryManagerOverlay();
    });

    _renderCategoryIconPicker('new-cat-icon', 'new-cat-icon-picker');
  }

  function _bindOverlays() {
    // 预算覆盖层
    document.getElementById('overlay-budget-back').addEventListener('click', () => {
      _unlockOverlayScroll();
      document.getElementById('overlay-budget').classList.remove('page-overlay--open');
    });

    // 编辑覆盖层 — 返回按钮：关闭面板后回到进入前的页面
    document.getElementById('overlay-edit-back').addEventListener('click', () => {
      _closeEditSheet();
      navigate(_preEditView);
    });

    // 编辑覆盖层 — 删除按钮（只绑定一次，通过 _editingExpenseId 获取当前记录）
    // 确认改用自绘弹窗：iOS 独立 PWA 下 window.confirm 被禁用、静默返回 false
    document.getElementById('overlay-edit-delete').addEventListener('click', () => {
      if (!_editingExpenseId) return;
      _confirmDialog({
        title: '删除这条记录？',
        message: '此操作不可恢复。',
        confirmText: '删除',
        danger: true,
      }).then(ok => {
        if (!ok) return;
        if (!ExpenseDB.deleteExpense(_editingExpenseId)) {
          _toast('删除失败，这笔记录仍然保留', 'warning');
          return;
        }
        _invalidateHabitStatsCache();
        _toast('已删除', 'success');
        _closeEditSheet();
        _editingExpenseId = null;
        if (typeof ExpenseList !== 'undefined') ExpenseList.render();
        ExpenseHome.render();
        if (typeof ExpenseStats !== 'undefined') ExpenseStats.render();
      });
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
      _unlockOverlayScroll();
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
        if (!Array.isArray(data.expenses) || !Array.isArray(data.categories)) {
          _toast('无效的备份文件：缺少数据字段', 'warning');
          return;
        }
        const msg = `即将恢复备份（${data.expenses.length} 条记录，${data.categories.length} 个分类）。当前数据将被覆盖，系统已自动留一份恢复前备份。`;
        _confirmDialog({
          title: '恢复备份？',
          message: msg,
          confirmText: '恢复',
          danger: true,
        }).then(ok => {
          if (!ok) return;
          const result = ExpenseDB.importAll(data);
          if (result.success) {
            _invalidateHabitStatsCache();  // 数据整体被替换，缓存作废
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
      badge.innerHTML = '<svg viewBox="0 0 24 24" class="inline-icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg> 尚未备份';
      badge.style.color = 'var(--color-warning)';
      return;
    }
    const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    if (days > 7) {
      badge.innerHTML = '<svg viewBox="0 0 24 24" class="inline-icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg> ' + days + ' 天前备份';
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
          <input type="number" class="input" id="edit-amount" value="${ExpenseData.escapeHtml(expense.amount)}" step="0.01" min="0.01">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">分类</label>
          <select class="input" id="edit-category">
            ${_buildCategoryOptions(expense.categoryId)}
          </select>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></g></svg> 地点</label>
          <input type="text" class="input" id="edit-location" value="${ExpenseData.escapeHtml(expense.location || '')}" maxlength="50">
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">支付方式</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${ExpenseData.PAYMENT_METHODS.map(pm => {
              const isActive = expense.paymentMethod === pm.value;
              const rgb = ExpenseData.hexToRgb(pm.color);
              const bg   = isActive ? pm.color : `rgba(${rgb},0.1)`;
              const bd   = isActive ? pm.color : `rgba(${rgb},0.3)`;
              const text = isActive ? '#fff' : pm.color;
              return `<button class="chip chip--payment ${isActive ? 'chip--active' : ''}" data-edit-pm="${pm.value}" style="background:${bg};border-color:${bd};color:${text}">${pm.label}</button>`;
            }).join('')}
          </div>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M13.744 17.736a6 6 0 1 1-7.48-7.48M15 6h1v4"/><path d="m6.134 14.768l.866-.5l2 3.464"/><circle cx="16" cy="8" r="6"/></g></svg> 价值评定</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${ExpenseData.NECESSITY_OPTIONS.map(opt => {
              const isActive = expense.necessity === opt.value;
              const rgb = ExpenseData.hexToRgb(opt.color);
              const bg   = isActive ? opt.color : `rgba(${rgb},0.1)`;
              const bd   = isActive ? opt.color : `rgba(${rgb},0.3)`;
              const text = isActive ? '#fff' : opt.color;
              return `<button class="chip chip--payment ${isActive ? 'chip--active' : ''}" data-edit-necessity="${opt.value}" style="background:${bg};border-color:${bd};color:${text}">${opt.icon} ${opt.label}</button>`;
            }).join('')}
          </div>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8"/></g></svg> 备注</label>
          <input type="text" class="input" id="edit-note" value="${ExpenseData.escapeHtml(expense.note || '')}" maxlength="100">
        </div>
        <div style="display:flex;gap:12px">
          <div style="flex:1">
            <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M8 2v3m8-3v3"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/></g></svg> 日期</label>
            <input type="date" class="input" id="edit-date" value="${ExpenseData.escapeHtml(expense.date || '')}">
          </div>
          <div style="flex:1">
            <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></g></svg> 时间</label>
            <input type="time" class="input" id="edit-time" value="${ExpenseData.escapeHtml(expense.time || '')}">
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

    // 价值评定切换（与支付方式同规则：互斥选中，再点已选项取消 = 回到未评估）
    body.querySelectorAll('[data-edit-necessity]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('chip--active')) {
          btn.classList.remove('chip--active');
        } else {
          body.querySelector('[data-edit-necessity].chip--active')?.classList.remove('chip--active');
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
      // v194：与新增记账一致，分类必选——防止账单被误存为「未分类」
      const categoryId = document.getElementById('edit-category').value;
      if (!categoryId) {
        _toast('请选择分类', 'warning');
        return;
      }

      const pmBtn = body.querySelector('[data-edit-pm].chip--active');
      const necessityBtn = body.querySelector('[data-edit-necessity].chip--active');
      // v194：日期/时间被清空时补当前值，避免产生空日期账单
      const dateVal = document.getElementById('edit-date').value || ExpenseDB.today();
      const timeVal = document.getElementById('edit-time').value || ExpenseDB.now();

      const updated = ExpenseDB.updateExpense(expenseId, {
        amount:        amountVal,
        categoryId:    categoryId,
        location:      document.getElementById('edit-location').value,
        paymentMethod: pmBtn ? pmBtn.dataset.editPm : '',
        necessity:     necessityBtn ? necessityBtn.dataset.editNecessity : '',
        note:          document.getElementById('edit-note').value,
        date:          dateVal,
        time:          timeVal,
      });

      if (!updated) {
        _toast('修改保存失败，请检查浏览器存储空间', 'warning');
        return;
      }
      _invalidateHabitStatsCache();
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
      html += `<option value="${ExpenseData.escapeHtml(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${ExpenseData.escapeHtml(p.icon)} ${ExpenseData.escapeHtml(p.name)}</option>`;
      const children = ExpenseDB.getChildCategories(p.id);
      children.forEach(c => {
        html += `<option value="${ExpenseData.escapeHtml(c.id)}" ${c.id === selectedId ? 'selected' : ''}>&nbsp;&nbsp;└ ${ExpenseData.escapeHtml(c.icon)} ${ExpenseData.escapeHtml(c.name)}</option>`;
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
