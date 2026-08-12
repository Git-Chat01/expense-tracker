/* ================================================================
   消费轨迹系统 — app-v217.js
   ExpenseApp 命名空间：主控制器
   职责（审计高危 No.2 拆分后）：初始化 / Tab 导航 / 数字键盘 / 记账表单编排
   已拆出的独立模块（加载于本文件之前，详见各自文件头注释）：
     ExpenseToast / ExpenseConfirm / ExpenseUi / ExpenseHabitPredictor /
     ExpenseBudgetOverlay / ExpenseCategoryManager / ExpenseEditOverlay /
     ExpenseBackupManager
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
  // 新建记账只提供四种明确渠道；全局字典仍保留 other，兼容历史账单显示与编辑。
  const ADD_PAYMENT_METHODS = ExpenseData.PAYMENT_METHODS.filter(pm => pm.value !== 'other');
  let _paymentOptionsExpanded = false;
  let _necessityOptionsExpanded = false;  // 价值评定选择器展开状态（v187 起与支付方式同款交互）
  let _paymentHandTouched = false;   // 用户手动改过支付方式（切分类时不被习惯覆盖）
  let _necessityHandTouched = false; // 用户手动改过价值评定（切分类时不被习惯覆盖）

  let _currentView = 'home';
  // 编辑覆盖层的记录 ID / 进入前页面状态已迁至 ExpenseEditOverlay 模块

  /* -----------------------------------------------------------------
     共享模块引用（原定义已按审计高危 No.2 拆出；别名仅为减少调用点改动，
     实现位于对应模块文件，改样式/弹窗逻辑时去改模块文件而非本控制器）
     ----------------------------------------------------------------- */
  const _toast = ExpenseToast.show;
  const _confirmDialog = ExpenseConfirm.open;
  const _confirmThen = ExpenseConfirm.confirmThen;
  const _storageFailText = ExpenseUi.storageFailText;
  const _storageFailToast = ExpenseUi.storageFailToast;
  const _renderChipGroup = ExpenseUi.renderChipGroup;
  const _refreshAllDataViews = ExpenseUi.refreshAllDataViews;
  const _bindOrWarn = ExpenseUi.bindOrWarn;
  const _invalidateHabitStatsCache = ExpenseHabitPredictor.invalidate;

  /* -----------------------------------------------------------------
     日期快捷行按钮内部模板（依赖表单状态，保留在主控制器；共享 UI 模板已迁至 ExpenseUi）
     ----------------------------------------------------------------- */

  /** 日期快捷行按钮的内部模板（收起/展开只差 chevron 方向，新增页三处共用） */
  function _dateQuickInnerHtml(chevron) {
    return `<span aria-hidden="true">日历</span><span id="add-date-label">今天</span><span id="add-time-label">${ExpenseData.escapeHtml(_formState.time)}</span><span class="add-date-quick__chevron" aria-hidden="true">${chevron}</span>`;
  }

  /* -----------------------------------------------------------------
     初始化入口
     ----------------------------------------------------------------- */
  function init() {
    // 1. 先确认核心数据可读；读取异常时不执行任何初始化写入。
    const initialStorageStatus = ExpenseDB.getCoreReadStatus();
    const presetDataReady = initialStorageStatus.ok && ExpenseData.initPresetData();

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

    // 5.5 初始化拆分出的独立模块（各自绑定覆盖层静态按钮 / 首页备份入口）
    ExpenseBudgetOverlay.init();
    ExpenseEditOverlay.init();
    ExpenseCategoryManager.init({
      renderAddCategories: _renderAddCategories,
      updateSaveState: _updateSaveState,
      syncFormCategoryState: _syncFormCategoryState,
    });
    ExpenseBackupManager.init({
      getCurrentView,
      refreshFormAfterImport: _refreshFormAfterImport,
    });

    // 6. 初始化子模块的筛选/时段选择器
    if (typeof ExpenseList !== 'undefined') ExpenseList.initFilters();
    if (typeof ExpenseStats !== 'undefined') ExpenseStats.initPeriodSelector();

    // 7. 注册 Service Worker（PWA 离线缓存）
    //    更新检测和提示由独立的版本化更新脚本统一处理
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function(err) {
        console.warn('SW registration failed:', err);
      });
    }

    // 8. 渲染首页
    ExpenseHome.render();
    _renderMerchantSuggestions();

    // 8.5 挂载月度报告（入口卡 + 未读角标；引擎脚本在 stats.js 之后加载）
    if (typeof ExpenseMonthlyReport !== 'undefined') ExpenseMonthlyReport.init();

    // 9. 读取异常时明确告知“当前数据状态未知”，且本次会话的核心写入已被存储层暂停。
    const finalStorageStatus = ExpenseDB.getCoreReadStatus();
    if (!finalStorageStatus.ok) {
      const categoryGraphInvalid = finalStorageStatus.code === 'CATEGORY_GRAPH_INVALID';
      const domainDataInvalid = finalStorageStatus.code === 'DOMAIN_DATA_INVALID';
      const recoveryAvailable = categoryGraphInvalid || domainDataInvalid;
      const exportButton = document.getElementById('home-export-btn');
      if (recoveryAvailable && exportButton) exportButton.textContent = '导出救援副本';
      _confirmDialog({
        title: categoryGraphInvalid
          ? '检测到旧版分类层级异常'
          : (domainDataInvalid ? '检测到旧版账单或预算字段异常' : '本地数据读取失败'),
        message: categoryGraphInvalid
          ? '账单仍保持只读可见，但写入、普通备份和恢复已暂停，应用不会自动改写历史分类。请在“数据与备份”中导出只读救援副本并妥善保存；该文件不能直接恢复，需交由维护人员处理。'
          : (domainDataInvalid
            ? '账单仍保持只读可见，但检测到无法安全用于新写入的旧字段。应用不会自动取整、迁移或覆盖；请在“数据与备份”中导出只读救援副本并妥善保存。'
            : '应用无法完整读取当前账本，不能据此判断数据为空。为避免覆盖，写入和备份已暂停。请勿清理浏览器数据，重新打开后重试；若持续失败，请保留现有备份。'),
        confirmText: '知道了',
        notice: true,
      });
    } else {
      if (!presetDataReady) {
        _toast('初始化数据保存失败，原数据未覆盖。请保留页面并检查浏览器存储空间', 'warning', { duration: 6000 });
      }
      // 新手引导（仅首次访问展示，关闭后写入 settings.onboardingSeen）
      if (typeof ExpenseOnboarding !== 'undefined') ExpenseOnboarding.start();
    }
  }

  /* -----------------------------------------------------------------
     Tab 导航
     ----------------------------------------------------------------- */

  /** 将 window / documentElement / body 及视图容器滚回顶部（廉价，可高频调用）。
   *  移动端浏览器（尤其是 iOS Safari）的实际滚动经常发生在 window 或 body/html
   *  层级，而不是 .main-view——光滚视图容器远远不够。 */
  function _scrollWindowToTop(viewEl) {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    if (viewEl) viewEl.scrollTop = 0;
  }

  /** 将激活视图内所有嵌套滚动容器（stats-container / list-content 等）滚回顶部。
   *  全树扫描较贵（逐元素读 scrollTop），只在切换的收尾各扫一次，不进高频路径。 */
  function _scrollNestedToTop() {
    var all = document.querySelectorAll('.main-view--active *');
    for (var i = 0; i < all.length; i++) {
      if (all[i].scrollTop > 0) {
        all[i].scrollTop = 0;
        try { all[i].scrollTo(0, 0); } catch (e) { /* 兼容不支持 scrollTo 的旧引擎 */ }
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
      // 切回统计页刷新月报入口卡/未读角标
      if (typeof ExpenseMonthlyReport !== 'undefined') ExpenseMonthlyReport.refreshEntry();
    }

    // 切 Tab 后强制回到顶部。多时间点反复清零，因为：
    // - display:none→flex 后浏览器会异步恢复旧滚动位置（DOM 级别，晚于微任务）
    // - 移动端 Safari 的滚动恢复甚至可能在 rAF 之后
    // - render() 中的 DOM 操作也可能引起额外布局
    // 策略：window 层立即 + rAF + rAF + setTimeout(100ms) 四连击确保最终归零；
    //       全树嵌套容器扫描较贵，只在首、尾各扫一次（首尾覆盖已足够）。
    if (target) {
      _scrollWindowToTop(target);
      _scrollNestedToTop();
      requestAnimationFrame(function () {
        _scrollWindowToTop(target);
        requestAnimationFrame(function () {
          _scrollWindowToTop(target);
          setTimeout(function () {
            _scrollWindowToTop(target);
            _scrollNestedToTop();
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
      const confirmDialog = document.getElementById('confirm-dialog');
      if (confirmDialog && confirmDialog.classList.contains('confirm-dialog--open')) return;
      // 如果有 input/textarea 聚焦，不劫持（用户可能正在填写备注/地点）
      if (document.activeElement && document.activeElement.tagName === 'INPUT') return;
      if (document.activeElement && document.activeElement.tagName === 'TEXTAREA') return;

      if (e.key >= '0' && e.key <= '9') {
        e.preventDefault();
        _handleNumpadKey(e.key);
      } else if (e.key === '.' || e.key === '。') {
        e.preventDefault();
        _handleNumpadKey('.');
      } else if (e.key === 'Backspace' || e.key === 'Delete') {
        e.preventDefault();
        _handleNumpadKey('backspace');
      } else if (e.key === 'Escape') {
        e.preventDefault();
        _handleNumpadKey('clear');
      } else if (e.key === 'Enter') {
        // 必须 preventDefault：焦点落在按钮上（分类/支付 chip 等）时，
        // Enter 会同时触发该按钮的 click 与提交，产生组合误操作。
        e.preventDefault();
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
        const money = ExpenseDB.validateMoney(_formState.amountRaw);
        submitAmount.textContent = `¥${money.ok ? money.value.toFixed(2) : '0.00'}`;
      }
    }
    _updateSaveState();
  }

  function _updateSaveState() {
    const label = document.getElementById('add-submit-label');
    const submit = document.querySelector('.numpad__key--submit');
    const money = ExpenseDB.validateMoney(_formState.amountRaw);
    const hasAmount = money.ok;
    let text = '保存';

    if (!hasAmount) text = '输入金额';
    else if (!_formState.categoryId) text = '选择分类';

    if (label) label.textContent = text;
    if (submit) {
      const amountText = hasAmount ? `，金额 ¥${money.value.toFixed(2)}` : '';
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

    const selectedMethod = ADD_PAYMENT_METHODS.find(pm => pm.value === _formState.paymentMethod);
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

    container.innerHTML = _renderChipGroup(ADD_PAYMENT_METHODS, {
      activeValue: _formState.paymentMethod,
      dataAttr: 'data-pm',
      extraClass: 'chip--payment',
    });

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

    container.innerHTML = _renderChipGroup(ExpenseData.NECESSITY_OPTIONS, {
      activeValue: _formState.necessity,
      dataAttr: 'data-necessity',
      extraClass: 'chip--necessity',
    });

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
    const activeCategoryIds = new Set(ExpenseDB.getCategories().map(category => category.id));

    ExpenseDB.getExpenses().slice(0, 80).forEach((expense, index) => {
      if (!activeCategoryIds.has(expense.categoryId)) return;
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
      const category = ExpenseDB.getActiveCategory(suggestion.categoryId);
      if (!category) return;
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
    if (!ExpenseDB.getActiveCategory(suggestion.categoryId)) {
      _renderMerchantSuggestions();
      _toast('该建议使用的分类已被删除，请重新选择分类', 'warning');
      return;
    }
    _formState.note = suggestion.note;
    _formState.location = suggestion.location;

    const noteInput = document.getElementById('add-note');
    const locationInput = document.getElementById('add-location');
    const moreFields = document.getElementById('add-more-fields');
    if (noteInput) noteInput.value = suggestion.note;
    if (locationInput) locationInput.value = suggestion.location;
    if (moreFields) moreFields.open = true;

    if (ExpenseDB.getActiveCategory(suggestion.categoryId)) {
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
    } else if (!_formState.date) {
      // 用户在日期输入框清空内容后：标签必须同步为空，不能残留上一次的"今天/昨天"旧文案
      dateLabel.textContent = '未选择日期';
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
        toggleBtn.innerHTML = _dateQuickInnerHtml('⌄');
        // 重新获取 label 引用（innerHTML 替换后需要）
        _updateDateLabels();
      } else {
        inputs.style.display = 'flex';
        toggleBtn.setAttribute('aria-expanded', 'true');
        toggleBtn.innerHTML = _dateQuickInnerHtml('⌃');
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
          // 连同时间一起重置：否则昨夜 23:30 记账后，今早点「今天」记早餐仍沿用 23:30
          _formState.time = _timeValue(new Date());
        } else if (shortcut === 'yesterday') {
          _formState.date = _relativeDateValue(-1);
          _formState.time = _timeValue(new Date());
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
  function _applyHabitDefaults() {
    // 支付方式：按「分类 → 父分类 → 全局」条件概率预填（支付渠道有行为惯性，值得猜）
    // 价值评定：每笔消费的价值判断独立，从不自动默认，始终展开让用户自选
    // 三层统计与阈值判定已迁至 ExpenseHabitPredictor（纯数据计算，零写入）
    if (_formState.categoryId) {
      if (!_paymentHandTouched) {
        _formState.paymentMethod = ExpenseHabitPredictor.guessForCategory(
          _formState.categoryId,
          ADD_PAYMENT_METHODS.map(p => p.value),
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

  /* -----------------------------------------------------------------
     重置表单默认值（每次从其他页面进入记账页时调用）
     ----------------------------------------------------------------- */
  function _resetFormDefaults(options = {}) {
    const { clearTransient = true } = options;
    _formState.amountRaw = '';
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
      dateQuick.innerHTML = _dateQuickInnerHtml('⌄');
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
  function _ensureCurrentCategoryActive() {
    if (_formState.categoryId && ExpenseDB.getActiveCategory(_formState.categoryId)) return true;
    const readStatus = ExpenseDB.getCoreReadStatus();
    _formState.categoryId = '';
    ExpenseCategories.clearSelection();
    _renderAddCategories();
    _updateSaveState();
    if (!readStatus.ok) {
      _storageFailToast('无法安全读取分类数据，保存已停止且原数据未覆盖');
    } else {
      _toast('所选分类已被删除或失效，请重新选择', 'warning');
    }
    return false;
  }

  /* -----------------------------------------------------------------
     供拆分模块注入的表单同步回调
     （分类管理/备份导入成功后，记账表单可能引用已消失的分类，由主控制器统一清理）
     ----------------------------------------------------------------- */

  /** 分类被删除后：清理表单中失效的分类选中，并按新状态重排支付/价值评定预填 */
  function _syncFormCategoryState() {
    if (_formState.categoryId && !ExpenseDB.getActiveCategory(_formState.categoryId)) {
      _formState.categoryId = '';
      ExpenseCategories.clearSelection();
      _applyHabitDefaults();
      _renderPaymentMethods();
      _renderNecessityOptions();
    }
  }

  /** 备份导入成功后：同步分类入口/商家建议/保存按钮状态 */
  function _refreshFormAfterImport() {
    if (_formState.categoryId && !ExpenseDB.getActiveCategory(_formState.categoryId)) {
      _formState.categoryId = '';
      ExpenseCategories.clearSelection();
    }
    _renderAddCategories();
    _renderMerchantSuggestions();
    _updateSaveState();
  }

  function _buildAddExpenseDraft() {
    return {
      amount: _formState.amountRaw,
      categoryId: _formState.categoryId,
      date: _formState.date,
      time: _formState.time,
      location: _formState.location,
      paymentMethod: _formState.paymentMethod,
      necessity: _formState.necessity,
      note: _formState.note,
    };
  }

  function _showExpenseValidationError(validation) {
    const error = validation && validation.error;
    if (!error) return;
    if (error.field === 'amount') _setAmountValidation(true);
    if (error.field === 'categoryId') {
      _setCategoryValidation(true);
      if (_formState.categoryId && !_ensureCurrentCategoryActive()) return;
      const categoryArea = document.querySelector('.add-category-area');
      if (categoryArea) categoryArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    _toast(error.message, 'warning');
  }

  function _handleSave() {
    const validation = ExpenseDB.validateExpenseDraft(_buildAddExpenseDraft());
    if (!validation.ok) {
      _showExpenseValidationError(validation);
      return;
    }
    _setAmountValidation(false);
    _setCategoryValidation(false);
    if (!_ensureCurrentCategoryActive()) return;

    if (validation.cents >= ExpenseData.LARGE_AMOUNT_THRESHOLD_CENTS) {
      const confirmedCents = validation.cents;
      const amountText = validation.value.amount.toLocaleString('zh-CN', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });
      _confirmThen({
        title: '确认这笔大额支出？',
        message: `将记录 ¥${amountText} 的支出。`,
        confirmText: '确认记录',
      }, () => {
        const latest = ExpenseDB.validateExpenseDraft(_buildAddExpenseDraft());
        if (!latest.ok) {
          _showExpenseValidationError(latest);
          return;
        }
        if (latest.cents !== confirmedCents) {
          _toast('金额已变更，请重新确认', 'warning');
          return;
        }
        _commitSave(confirmedCents);
      });
      return;
    }

    _commitSave(validation.cents);
  }

  /** 实际写入记录（大金额确认通过后调用；window.confirm 在 iOS 独立 PWA 被禁用，确认改为自绘弹窗） */
  function _commitSave(expectedCents) {
    const validation = ExpenseDB.validateExpenseDraft(_buildAddExpenseDraft());
    if (!validation.ok) {
      _showExpenseValidationError(validation);
      return;
    }
    if (expectedCents != null && validation.cents !== expectedCents) {
      _toast('金额已变更，请重新确认', 'warning');
      return;
    }
    if (!_ensureCurrentCategoryActive()) return;
    const record = ExpenseDB.addExpense(validation.value);

    if (!record) {
      _storageFailToast('保存失败：无法安全读取或写入本地数据，操作已停止且原数据未覆盖');
      return;
    }
    _invalidateHabitStatsCache();  // 数据已变更，习惯统计缓存作废

    _toast(`已记录 ¥${validation.value.amount.toFixed(2)}`, 'success', {
      actionLabel: '撤销',
      duration: 5000,
      onAction: () => {
        if (!ExpenseDB.deleteExpense(record.id)) {
          _toast('撤销失败，这笔记录仍然保留', 'warning');
          return;
        }
        _invalidateHabitStatsCache();
        _toast('已撤销本次记录', 'success');
        _refreshAllDataViews();
        _renderMerchantSuggestions();
      },
    });

    // 连续记账只保留可见的分类摘要，避免地点、支付方式和价值评定悄悄误带。
    _formState.amountRaw = '';
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
     Toast / 确认弹窗 / 预算设置覆盖层 / 覆盖层滚动锁 / 分类管理
     已整体迁出（审计高危 No.2），实现见：
       toast.js / confirm-dialog.js / ui-utils.js /
       budget-overlay.js / category-manager.js
     主控制器经头部别名（_toast / _confirmThen / _storageFailToast 等）继续调用。
     ----------------------------------------------------------------- */

  /* 分类管理剩余函数（列表渲染/图标选择/重名校验/新增/编辑表单）已迁至 category-manager.js */

  function _bindOverlays() {
    // 记账页"⚙️ 管理"按钮 → 打开分类管理覆盖层（独立全屏页面）
    // 其余覆盖层静态按钮（预算返回/编辑返回/删除/遮罩/分类返回/新增）已随拆分迁入各自模块的 init()
    const manageBtn = document.getElementById('add-manage-categories');
    if (manageBtn) {
      manageBtn.addEventListener('click', () => {
        ExpenseCategories.closePicker();
        ExpenseCategoryManager.open();
      });
    }
  }

  function _bindHomeEvents() {
    const primaryAddBtn = document.getElementById('home-primary-add');
    if (primaryAddBtn) {
      primaryAddBtn.addEventListener('click', () => navigate('add'));
    }

    // 设置预算按钮（实现已迁至 ExpenseBudgetOverlay）
    const setBudgetBtn = document.getElementById('home-set-budget');
    if (setBudgetBtn) {
      setBudgetBtn.addEventListener('click', () => ExpenseBudgetOverlay.open());
    }

    // 预算提醒卡片 ⚙️ → 打开预算设置
    const budgetEditBtn = document.getElementById('home-budget-alert-edit');
    if (budgetEditBtn) {
      budgetEditBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        ExpenseBudgetOverlay.open();
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
          ExpenseEditOverlay.open(item.dataset.id);
        }
      });
    }

    // 数据备份（导出/导入/备份徽章/首页时钟）已迁至 backup-manager.js
  }

  /* _performImport / _updateBackupBadge 已迁至 backup-manager.js */

  /* -----------------------------------------------------------------
     从其他模块调用的公开方法
     （实现已随拆分迁入对应模块，此处保持对外 API 不变）
     ----------------------------------------------------------------- */
  function openBudgetSettings() { ExpenseBudgetOverlay.open(); }
  function openEditExpense(expenseId) { ExpenseEditOverlay.open(expenseId); }
  function showToast(msg, type, options) { ExpenseToast.show(msg, type, options); }
  function getCurrentView() { return _currentView; }

  /* -----------------------------------------------------------------
     编辑消费记录覆盖层 + _buildCategoryOptions
     已整体迁至 edit-expense.js（含审计低危项：四个内嵌函数提级为模块级）
     ----------------------------------------------------------------- */

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
