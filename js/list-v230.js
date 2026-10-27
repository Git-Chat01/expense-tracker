/* ================================================================
   消费轨迹系统 — list.js
   ExpenseList 命名空间：账单列表渲染
   日期分组 / 7 种筛选 / 关键词搜索 / 排序 / 底部汇总 / 编辑删除
   ================================================================ */

const ExpenseList = (() => {
  'use strict';

  /* -----------------------------------------------------------------
     筛选状态
     ----------------------------------------------------------------- */
  const _filters = {
    dateFrom: '',
    dateTo: '',
    categoryIds: [],
    categoryExact: false,
    locationIds: [],
    paymentMethods: [],
    necessities: [],
    noteKeyword: '',
    sortBy: 'date',
    sortOrder: 'desc',
  };

  let _sortState = 2; // 0=金额↓, 1=金额↑, 2=日期↓, 3=日期↑
  let _filterPanel = null; // 面板内仅修改临时选择，确认后才应用。
  let _drilldownContext = null;
  const _arrayFields = { category: 'categoryIds', location: 'locationIds', payment: 'paymentMethods', necessity: 'necessities' };
  const _sortOptions = [
    { value: 'amount-desc', label: '金额从高到低' },
    { value: 'amount-asc', label: '金额从低到高' },
    { value: 'date-desc', label: '日期从新到旧' },
    { value: 'date-asc', label: '日期从旧到新' },
  ];
  const PAGE_SIZE = 100;
  let _visibleCount = PAGE_SIZE;
  let _lastFilterKey = '';
  let _filteredExpenses = [];
  let _dateSummaries = new Map();
  let _categorySnapshot = new Map();
  let _composing = false;
  const _boundContainers = new WeakSet();

  /* -----------------------------------------------------------------
     渲染入口
     ----------------------------------------------------------------- */
  function render() {
    // 同一筛选下的数据更新保留已加载位置；改变筛选/排序才回到首批。
    const filterKey = JSON.stringify(_filters);
    if (filterKey !== _lastFilterKey) _visibleCount = PAGE_SIZE;
    _lastFilterKey = filterKey;
    _categorySnapshot = new Map();
    const allExpenses = ExpenseDB.getExpenses();
    const filtered = _applyFilters(allExpenses);
    _renderList(filtered);
    _renderSummary(filtered);
    // 每次渲染都同步刷新筛选条件 chip 行（包括"清除筛选"按钮的显隐）
    _renderActiveFilters();
    _syncSearch();
  }

  /** 分类按本次渲染缓存；保留对已删除分类的历史查询能力。 */
  function _getCategory(id) {
    if (!_categorySnapshot.has(id)) _categorySnapshot.set(id, ExpenseDB.getCategory(id));
    return _categorySnapshot.get(id);
  }

  /* -----------------------------------------------------------------
     过滤链
     ----------------------------------------------------------------- */
  function _applyFilters(expenses) {
    let result = [...expenses];

    // 日期范围
    if (_filters.dateFrom) {
      result = result.filter(e => e.date >= _filters.dateFrom);
    }
    if (_filters.dateTo) {
      result = result.filter(e => e.date <= _filters.dateTo);
    }

    // 分类（选中一级 = 自动包含所有子分类）
    if (_filters.categoryIds.length > 0) {
      const selectedIds = new Set(_filters.categoryIds);
      const parentIdByCategory = new Map();
      result = result.filter(expense => {
        if (selectedIds.has(expense.categoryId)) return true;
        if (_filters.categoryExact) return false;
        if (!parentIdByCategory.has(expense.categoryId)) {
          const category = _getCategory(expense.categoryId);
          parentIdByCategory.set(expense.categoryId, category && category.parentId ? category.parentId : null);
        }
        const parentId = parentIdByCategory.get(expense.categoryId);
        return Boolean(parentId && selectedIds.has(parentId));
      });
    }

    // 地点
    if (_filters.locationIds.length > 0) {
      result = result.filter(e => _filters.locationIds.includes(e.location));
    }


    // 支付方式
    if (_filters.paymentMethods.length > 0) {
      result = result.filter(e => _filters.paymentMethods.includes(e.paymentMethod));
    }

    // 缺失值只作为未评估读取，不回填历史数据。
    if (_filters.necessities.length) {
      result = result.filter(e => _filters.necessities.includes(e.necessity || ''));
    }
    // 同时匹配备注、地点、分类和一级分类。
    if (_filters.noteKeyword) {
      const kw = _filters.noteKeyword.toLowerCase();
      const names = new Map();
      result = result.filter(e => {
        if (!names.has(e.categoryId)) {
          const cat = _getCategory(e.categoryId);
          const parent = cat && cat.parentId ? _getCategory(cat.parentId) : null;
          names.set(e.categoryId, [cat && cat.name, parent && parent.name].filter(Boolean));
        }
        return [e.note, e.location, ...names.get(e.categoryId)]
          .some(value => String(value || '').toLowerCase().includes(kw));
      });
    }

    // 排序
    result.sort((a, b) => {
      let cmp = 0;
      if (_filters.sortBy === 'amount') {
        cmp = b.amount - a.amount;
      } else if (_filters.sortBy === 'date') {
        cmp = b.date.localeCompare(a.date);
        if (cmp === 0) cmp = (b.time || '').localeCompare(a.time || '');
      }
      return _filters.sortOrder === 'asc' ? -cmp : cmp;
    });

    return result;
  }

  /* -----------------------------------------------------------------
     渲染分组列表
     ----------------------------------------------------------------- */
  function _renderList(expenses) {
    const container = document.getElementById('list-content');
    if (!container) return;
    _filteredExpenses = expenses;
    _dateSummaries = new Map();
    expenses.forEach(expense => {
      const summary = _dateSummaries.get(expense.date) || { count: 0, cents: 0 };
      summary.count++;
      summary.cents += ExpenseSummary.toCents(expense.amount);
      _dateSummaries.set(expense.date, summary);
    });

    if (expenses.length === 0) {
      const hasAnyData = ExpenseDB.getExpenseCount() > 0;
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon"><svg viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="m21 21l-4.34-4.34"/><circle cx="11" cy="11" r="8"/></g></svg></div>
          <p class="empty-state__text">${hasAnyData ? '没有找到匹配的记录' : '还没有消费记录'}</p>
          <p class="empty-state__hint">${hasAnyData ? '试试换个筛选条件' : '去「记账」Tab 添加第一笔吧'}</p>
        </div>`;
      return;
    }

    _visibleCount = Math.min(Math.max(PAGE_SIZE, _visibleCount), expenses.length);
    container.innerHTML = _renderChunk(0, _visibleCount) + _loadMoreMarkup();
    _bindItemClicks(container);
  }

  /** 仅生成这一批行；日期组头的笔数和金额仍按全部筛选结果计算。 */
  function _renderChunk(start, end) {
    let html = '';
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const showDate = _filters.sortBy === 'amount';
    const today = ExpenseDB.today();
    for (let i = start; i < end; i++) {
      const expense = _filteredExpenses[i];
      if (!showDate && (i === 0 || expense.date !== _filteredExpenses[i - 1].date)) {
        const [year, month, day] = expense.date.split('-').map(Number);
        const weekday = weekdays[new Date(year, month - 1, day).getDay()];
        const summary = _dateSummaries.get(expense.date);
        html += `<div class="list-group-header">
          <span class="list-group-header__date">${ExpenseSummary.dateLabel(expense.date, today)} 周${weekday}</span>
          <span class="list-group-header__summary">共 ${summary.count} 笔 · ¥${ExpenseSummary.money(summary.cents)}</span>
        </div>`;
      }
      html += _renderItem(expense, { showDate });
    }
    return html;
  }

  function _loadMoreMarkup() {
    if (_filteredExpenses.length <= PAGE_SIZE) return '';
    return `<div class="list-load-more">
      <p class="list-load-more__status" role="status">已显示 ${_visibleCount} / ${_filteredExpenses.length} 笔，汇总包含全部结果</p>
      <button type="button" class="btn btn--ghost list-load-more__button" ${_visibleCount >= _filteredExpenses.length ? 'hidden' : ''}>加载更多</button>
    </div>`;
  }

  function _loadMore(container) {
    const footer = container.querySelector('.list-load-more');
    if (!footer || _visibleCount >= _filteredExpenses.length) return;
    const start = _visibleCount;
    const button = footer.querySelector('button');
    const restoreFocus = document.activeElement === button;
    _visibleCount = Math.min(_visibleCount + PAGE_SIZE, _filteredExpenses.length);
    footer.insertAdjacentHTML('beforebegin', _renderChunk(start, _visibleCount));
    footer.querySelector('.list-load-more__status').textContent = `已显示 ${_visibleCount} / ${_filteredExpenses.length} 笔，汇总包含全部结果`;
    button.hidden = _visibleCount >= _filteredExpenses.length;
    if (restoreFocus) container.querySelectorAll('.list-item')[start]?.focus({ preventScroll: true });
  }

  /** 给渲染好的列表绑定点击（打开编辑面板）；分组与平铺两种视图共用 */
  function _bindItemClicks(container) {
    // 委托只绑定一次，加载更多不为每行增加监听器，也不重新创建已显示的行。
    if (_boundContainers.has(container)) return;
    _boundContainers.add(container);
    container.addEventListener('click', event => {
      if (event.target.closest('.list-load-more__button')) { _loadMore(container); return; }
      const row = event.target.closest('.list-item');
      if (row && row.dataset.id) ExpenseApp.openEditExpense(row.dataset.id);
    });
    container.addEventListener('keydown', event => {
      const row = event.target.closest('.list-item');
      if (!row || (event.key !== 'Enter' && event.key !== ' ')) return;
      event.preventDefault();
      if (!event.repeat && row.dataset.id) ExpenseApp.openEditExpense(row.dataset.id);
    });
  }

  function _highlightEscaped(value, keyword) {
    const text = String(value ?? '');
    if (!keyword) return ExpenseData.escapeHtml(text);
    const re = new RegExp(keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    let html = '';
    let lastIndex = 0;
    text.replace(re, (match, offset) => {
      html += ExpenseData.escapeHtml(text.slice(lastIndex, offset));
      html += `<mark>${ExpenseData.escapeHtml(match)}</mark>`;
      lastIndex = offset + match.length;
      return match;
    });
    return html + ExpenseData.escapeHtml(text.slice(lastIndex));
  }

  /** 渲染单条记录；options.showDate=true 时在 meta 开头补日期（金额排序平铺视图用） */
  function _renderItem(expense, options) {
    const cat = _getCategory(expense.categoryId);
    const name = cat ? cat.name : '未分类';
    const icon = ExpenseCategories.getIconMarkup(cat);

    // 备注优先承担“这笔是什么”的角色；没有备注时才以分类作为标题。
    let titleHtml = _highlightEscaped(name, _filters.noteKeyword);
    if (expense.note && _filters.noteKeyword) {
      titleHtml = _highlightEscaped(expense.note, _filters.noteKeyword);
    } else if (expense.note) {
      titleHtml = ExpenseData.escapeHtml(expense.note);
    }

    // 元数据只保留能帮助回忆这笔记录的信息，不再堆叠装饰性 Emoji。
    const metaParts = [];
    // 平铺视图没有日期组头，日期信息放 meta 最前
    if (options && options.showDate && expense.date) {
      metaParts.push(ExpenseSummary.dateLabel(expense.date, ExpenseDB.today()));
    }
    // 时间放最前：账单是时间线上的事件，与首页「最近消费」及主流记账 App 的阅读习惯一致
    if (expense.time) metaParts.push(ExpenseData.escapeHtml(expense.time));
    if (expense.location) metaParts.push(_highlightEscaped(expense.location, _filters.noteKeyword));
    if (expense.paymentMethod) {
      const pm = ExpenseData.PAYMENT_METHODS.find(p => p.value === expense.paymentMethod);
      metaParts.push(ExpenseData.escapeHtml(pm ? pm.label : expense.paymentMethod));
    }
    // 有备注时标题被备注占用，分类名补位到这里
    if (expense.note) metaParts.push(_highlightEscaped(name, _filters.noteKeyword));
    // 价值评定是彩色状态徽章，放末尾收尾：不打断灰色事实信息的连续阅读，又保留一眼可见的识别度
    if (expense.necessity) {
      const opt = ExpenseData.NECESSITY_OPTIONS.find(o => o.value === expense.necessity);
      if (opt) metaParts.push(`${opt.icon}${opt.label}`);
    }

    return `
      <div class="list-item" data-id="${ExpenseData.escapeHtml(expense.id)}" role="button" tabindex="0" aria-label="${ExpenseData.escapeHtml(`编辑 ${expense.date || ''} ${expense.note || name}，金额 ${expense.amount.toFixed(2)} 元`)}">
        <span class="list-item__category-icon">${icon}</span>
        <div class="list-item__body">
          <div class="list-item__header">
            <span class="list-item__name">${titleHtml}</span>
          </div>
          ${metaParts.length ? `<div class="list-item__meta">${metaParts.join(' · ')}</div>` : ''}
        </div>
        <span class="list-item__amount">-¥${expense.amount.toFixed(2)}</span>
      </div>`;
  }

  /* -----------------------------------------------------------------
     底部汇总
     ----------------------------------------------------------------- */
  function _renderSummary(expenses) {
    const el = document.getElementById('list-summary');
    if (!el) return;

    if (expenses.length === 0 && ExpenseDB.getExpenseCount() === 0) {
      el.style.display = 'none';
      return;
    }

    el.style.display = 'flex';
    const totalCents = ExpenseSummary.sumCents(expenses);
    document.getElementById('list-summary-count').textContent = `共 ${expenses.length} 笔`;
    document.getElementById('list-summary-total').textContent = `¥${ExpenseSummary.money(totalCents)}`;
  }

  /* -----------------------------------------------------------------
     筛选绑定（由 app.js 初始化时调用或直接绑定）
     ----------------------------------------------------------------- */
  function initFilters() {
    const saved = ExpenseDB.getSettings().listSort;
    const states = ['amount-desc', 'amount-asc', 'date-desc', 'date-asc'];
    if (states.includes(saved)) _sortState = states.indexOf(saved);
    const state = states[_sortState].split('-');
    _filters.sortBy = state[0];
    _filters.sortOrder = state[1];
    const sortBtn = document.querySelector('[data-filter="sort"]');
    if (sortBtn) sortBtn.textContent = (state[0] === 'date' ? '日期' : '金额') + (state[1] === 'desc' ? '↓' : '↑');
    const searchInput = document.getElementById('list-search-input');
    const clear = document.getElementById('list-search-clear');
    if (searchInput) {
      const applySearch = () => {
        const keyword = searchInput.value.trim();
        if (keyword === _filters.noteKeyword) { _syncSearch(); return; }
        _filters.noteKeyword = keyword;
        render();
      };
      searchInput.addEventListener('compositionstart', () => { _composing = true; });
      searchInput.addEventListener('compositionend', () => { _composing = false; applySearch(); });
      searchInput.addEventListener('input', event => {
        if (_composing || event.isComposing) return;
        applySearch();
      });
      searchInput.addEventListener('keydown', event => {
        if (_composing || event.isComposing) return;
        if (event.key === 'Enter') searchInput.blur();
        if (event.key === 'Escape') {
          searchInput.value = '';
          _filters.noteKeyword = '';
          render();
        }
      });
    }
    if (clear) clear.addEventListener('click', () => {
      searchInput.value = '';
      _filters.noteKeyword = '';
      render();
      searchInput.focus();
    });
    _syncSearch();

    // 筛选栏按钮
    document.querySelectorAll('#view-list [data-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        const filterType = btn.dataset.filter;
        _toggleFilterDropdown(filterType, btn);
      });
      btn.setAttribute('aria-haspopup', 'dialog');
      btn.setAttribute('aria-expanded', 'false');
    });
  }

  /** 搜索始终可见；清空按钮只清关键词，保留其他筛选和排序。 */
  function _syncSearch() {
    const clear = document.getElementById('list-search-clear');
    const input = document.getElementById('list-search-input');
    if (clear) clear.hidden = !input || !input.value;
    const sort = document.querySelector('[data-filter="sort"]');
    if (sort) {
      sort.textContent = (_filters.sortBy === 'date' ? '日期' : '金额') + (_filters.sortOrder === 'desc' ? '↓' : '↑');
      sort.setAttribute('aria-label', '选择排序，当前' +
      (_filters.sortBy === 'date'
        ? (_filters.sortOrder === 'desc' ? '日期从新到旧' : '日期从旧到新')
        : (_filters.sortOrder === 'desc' ? '金额从高到低' : '金额从低到高')));
    }
  }

  /** 用户明确选择排序，记忆失败时仍保留本次结果并给出反馈。 */
  function _applySort(value) {
    const index = _sortOptions.findIndex(option => option.value === value);
    if (index < 0) return;
    _sortState = index;
    const [sortBy, sortOrder] = value.split('-');
    _filters.sortBy = sortBy;
    _filters.sortOrder = sortOrder;
    if (!ExpenseDB.saveSettings({ listSort: value })) {
      ExpenseToast.show('本次排序已切换，但未能记住，下次打开可能恢复原排序', 'warning');
    }
    _closeFilterPanel();
    render();
  }

  function _makeFilterDraft(type) {
    if (type === 'date') return { dateFrom: _filters.dateFrom, dateTo: _filters.dateTo };
    return _arrayFields[type] ? [..._filters[_arrayFields[type]]] : [];
  }

  function _toggleDraftValue(draft, value) {
    const index = draft.indexOf(value);
    if (index < 0) draft.push(value);
    else draft.splice(index, 1);
  }

  function _commitFilterDraft(type, draft) {
    if (type === 'date') {
      if (draft.dateFrom && draft.dateTo && draft.dateFrom > draft.dateTo) return false;
      _filters.dateFrom = draft.dateFrom;
      _filters.dateTo = draft.dateTo;
    } else if (_arrayFields[type]) {
      _filters[_arrayFields[type]] = [...draft];
      if (type === 'category') _filters.categoryExact = false;
    } else return false;
    return true;
  }

  /** 地点候选取完整历史；搜索只影响候选展示，不丢失已选项。 */
  function _filterOptions(type) {
    if (type === 'necessity') return [...ExpenseData.NECESSITY_OPTIONS, { value: '', label: '未评估' }];
    if (type === 'payment') return ExpenseData.PAYMENT_METHODS;
    if (type === 'category') return ExpenseDB.getParentCategories().map(cat => ({ value: cat.id, label: cat.name, icon: ExpenseCategories.getIconMarkup(cat) }));
    if (type === 'location') {
      const locations = new Set(_filters.locationIds);
      ExpenseDB.getExpenses().forEach(expense => { if (expense.location) locations.add(expense.location); });
      return [...locations].sort((a, b) => a.localeCompare(b, 'zh-CN')).map(value => ({ value, label: value }));
    }
    return [];
  }

  function _dateQuickRange(pick) {
    const today = new Date();
    const format = date => String(date.getFullYear()) + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
    const from = new Date(today);
    if (pick === 'week') from.setDate(today.getDate() - (today.getDay() || 7) + 1);
    if (pick === 'month') from.setDate(1);
    return { dateFrom: format(from), dateTo: format(today) };
  }

  function _closeFilterPanel(restoreFocus = true) {
    if (!_filterPanel) return;
    const panel = _filterPanel;
    _filterPanel = null;
    document.removeEventListener('keydown', panel.onKeyDown, true);
    window.removeEventListener('resize', panel.onViewportChange);
    if (window.visualViewport) {
      window.visualViewport.removeEventListener('resize', panel.onViewportChange);
      window.visualViewport.removeEventListener('scroll', panel.onViewportChange);
    }
    panel.root.remove();
    if (panel.background) panel.background.inert = panel.wasInert;
    ExpenseUi.unlockOverlayScroll();
    panel.trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && panel.trigger.isConnected) panel.trigger.focus({ preventScroll: true });
  }

  /** 用局部面板承载多选，不在每次勾选时关闭或改变结果。 */
  function _toggleFilterDropdown(type, trigger) {
    if (_filterPanel && _filterPanel.trigger === trigger) { _closeFilterPanel(); return; }
    _closeFilterPanel(false);
    const titles = { date: '日期范围', category: '选择分类', location: '选择地点', payment: '支付方式', necessity: '价值评定', sort: '账单排序' };
    if (!titles[type]) return;
    const esc = ExpenseData.escapeHtml;
    const draft = _makeFilterDraft(type);
    const options = _filterOptions(type);
    const root = document.createElement('div');
    root.id = 'list-filter-overlay';
    root.className = 'list-filter-overlay page-overlay--open';
    let body = '';
    if (type === 'date') {
      body = '<div class="list-filter-panel__quick">' + [['today', '今天'], ['week', '本周'], ['month', '本月']].map(([value, label]) => '<button type="button" class="list-dropdown__item" data-pick="' + value + '">' + label + '</button>').join('') + '</div>' +
        '<div class="list-filter-panel__dates"><label for="list-filter-date-from">开始日期<input id="list-filter-date-from" type="date" class="list-dropdown__date-from" value="' + esc(draft.dateFrom) + '" aria-describedby="list-filter-date-hint list-filter-date-error"></label>' +
        '<label for="list-filter-date-to">结束日期<input id="list-filter-date-to" type="date" class="list-dropdown__date-to" value="' + esc(draft.dateTo) + '" aria-describedby="list-filter-date-hint list-filter-date-error"></label></div>' +
        '<p id="list-filter-date-hint" class="list-filter-panel__hint">可只填写一个日期，另一端不限。</p><p id="list-filter-date-error" class="list-dropdown__date-error" role="alert" hidden></p>';
    } else if (type === 'sort') {
      body = '<div class="list-filter-panel__options" role="group" aria-label="排序方式">' + _sortOptions.map(option => '<button type="button" class="list-dropdown__item" data-sort="' + option.value + '" aria-pressed="' + (option.value === _filters.sortBy + '-' + _filters.sortOrder) + '"><span>' + option.label + '</span><span class="list-filter-panel__check" aria-hidden="true">✓</span></button>').join('') + '</div>';
    } else {
      if (type === 'location') body += '<label class="list-filter-panel__search" for="list-filter-location-search">搜索地点<input id="list-filter-location-search" type="search" placeholder="搜索全部历史地点" autocomplete="off"></label>';
      body += '<p class="list-filter-panel__selection" aria-live="polite"></p><div class="list-filter-panel__options" role="group" aria-label="' + titles[type] + '，可多选">' + options.map(option => '<button type="button" class="list-dropdown__item" data-val="' + esc(option.value) + '" aria-pressed="' + draft.includes(option.value) + '"><span class="list-filter-panel__option-label">' + (option.icon || '') + esc(option.label) + '</span><span class="list-filter-panel__check" aria-hidden="true">✓</span></button>').join('') + '</div>' +
        '<p class="list-filter-panel__empty"' + (options.length ? ' hidden' : '') + '>' + (type === 'location' ? '还没有记录过地点' : '暂无可选项') + '</p>';
    }
    root.innerHTML = '<div class="list-filter-panel__backdrop" aria-hidden="true"></div><section class="list-filter-panel" role="dialog" aria-modal="true" aria-labelledby="list-filter-panel-title" tabindex="-1"><header class="list-filter-panel__header"><h2 id="list-filter-panel-title">' + titles[type] + '</h2><button type="button" class="list-filter-panel__cancel">取消</button></header><div class="list-filter-panel__body">' + body + '</div>' +
      (type === 'sort' ? '<p class="list-filter-panel__sort-hint">选择后立即应用，并记住排序方式。</p>' : '<footer class="list-filter-panel__footer"><button type="button" class="list-filter-panel__reset">重置此项</button><button type="button" class="list-filter-panel__apply' + (type === 'date' ? ' list-dropdown__date-confirm' : '') + '">查看结果</button></footer>') + '</section>';
    const background = document.querySelector('.app-container');
    const panel = { root, trigger, type, draft, background, wasInert: background ? background.inert : false };
    _filterPanel = panel;
    document.body.appendChild(root);
    ExpenseUi.lockOverlayScroll();
    if (background) background.inert = true;
    trigger.setAttribute('aria-expanded', 'true');
    const dialog = root.querySelector('.list-filter-panel');
    panel.onViewportChange = () => {
      const viewport = window.visualViewport;
      const height = viewport ? viewport.height : window.innerHeight;
      root.style.top = (viewport ? viewport.offsetTop : 0) + 'px';
      root.style.height = height + 'px';
      root.style.bottom = 'auto';
      dialog.style.maxHeight = Math.max(0, height - 24) + 'px';
    };
    window.addEventListener('resize', panel.onViewportChange);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', panel.onViewportChange);
      window.visualViewport.addEventListener('scroll', panel.onViewportChange);
    }
    panel.onViewportChange();
    panel.onKeyDown = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); _closeFilterPanel(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), [tabindex="0"]')].filter(element => !element.hidden && element.getClientRects().length);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first) { event.preventDefault(); dialog.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', panel.onKeyDown, true);
    root.querySelector('.list-filter-panel__cancel').addEventListener('click', () => _closeFilterPanel());
    root.querySelector('.list-filter-panel__backdrop').addEventListener('click', () => _closeFilterPanel());
    root.querySelectorAll('[data-sort]').forEach(button => button.addEventListener('click', () => _applySort(button.dataset.sort)));
    const refreshSelection = () => {
      root.querySelectorAll('[data-val]').forEach(button => button.setAttribute('aria-pressed', String(panel.draft.includes(button.dataset.val))));
      const count = root.querySelector('.list-filter-panel__selection');
      if (count) count.textContent = panel.draft.length ? '已选 ' + panel.draft.length + ' 项 · 可继续多选' : '未限制 · 可多选';
    };
    root.querySelectorAll('[data-val]').forEach(button => button.addEventListener('click', () => { _toggleDraftValue(panel.draft, button.dataset.val); refreshSelection(); }));
    const fromInput = root.querySelector('.list-dropdown__date-from');
    const toInput = root.querySelector('.list-dropdown__date-to');
    const clearDateError = () => {
      if (!fromInput) return;
      root.querySelector('.list-dropdown__date-error').hidden = true;
      fromInput.removeAttribute('aria-invalid');
      toInput.removeAttribute('aria-invalid');
    };
    [fromInput, toInput].filter(Boolean).forEach(input => input.addEventListener('input', clearDateError));
    root.querySelectorAll('[data-pick]').forEach(button => button.addEventListener('click', () => {
      panel.draft = _dateQuickRange(button.dataset.pick);
      fromInput.value = panel.draft.dateFrom;
      toInput.value = panel.draft.dateTo;
      clearDateError();
    }));
    const reset = root.querySelector('.list-filter-panel__reset');
    if (reset) reset.addEventListener('click', () => {
      if (type === 'date') { fromInput.value = ''; toInput.value = ''; panel.draft = { dateFrom: '', dateTo: '' }; clearDateError(); }
      else { panel.draft = []; refreshSelection(); }
    });
    const apply = root.querySelector('.list-filter-panel__apply');
    if (apply) apply.addEventListener('click', () => {
      if (type === 'date') {
        panel.draft = { dateFrom: fromInput.value, dateTo: toInput.value };
        const invalid = !fromInput.validity.valid ? fromInput : (!toInput.validity.valid ? toInput : null);
        if (invalid) { const error = root.querySelector('.list-dropdown__date-error'); error.textContent = '请填写有效日期，或留空表示不限'; error.hidden = false; invalid.setAttribute('aria-invalid', 'true'); invalid.focus(); return; }
      }
      if (!_commitFilterDraft(type, panel.draft)) {
        const error = root.querySelector('.list-dropdown__date-error');
        error.textContent = '开始日期不能晚于结束日期';
        error.hidden = false;
        fromInput.setAttribute('aria-invalid', 'true');
        fromInput.focus();
        return;
      }
      _closeFilterPanel();
      render();
    });
    const locationSearch = root.querySelector('#list-filter-location-search');
    if (locationSearch) locationSearch.addEventListener('input', () => {
      const keyword = locationSearch.value.trim().toLocaleLowerCase();
      let matches = 0;
      root.querySelectorAll('[data-val]').forEach(button => { button.hidden = !button.dataset.val.toLocaleLowerCase().includes(keyword); if (!button.hidden) matches++; });
      const empty = root.querySelector('.list-filter-panel__empty');
      empty.hidden = matches > 0;
      empty.textContent = options.length ? '没有找到匹配地点，试试其他关键词' : '还没有记录过地点';
    });
    if (_arrayFields[type]) refreshSelection();
    dialog.focus({ preventScroll: true });
  }

  function _copyFilters(filters) {
    return { ...filters, categoryIds: [...filters.categoryIds], locationIds: [...filters.locationIds], paymentMethods: [...filters.paymentMethods], necessities: [...filters.necessities] };
  }

  function hasPendingFilters() {
    if (!_filterPanel || _filterPanel.type === 'sort') return false;
    const { type, root, draft } = _filterPanel;
    if (type === 'date') return root.querySelector('.list-dropdown__date-from').value !== _filters.dateFrom
      || root.querySelector('.list-dropdown__date-to').value !== _filters.dateTo;
    const current = _filters[_arrayFields[type]];
    return current.length !== draft.length || current.some(value => !draft.includes(value));
  }

  /** 统计明细是临时上下文，保存原查账条件和已加载批次数。 */
  function openFromStats({ dateFrom = '', dateTo = '', categoryIds = [], label = '统计明细', onBack } = {}) {
    clearContext();
    _drilldownContext = { filters: _copyFilters(_filters), visibleCount: _visibleCount, sortState: _sortState, onBack };
    Object.assign(_filters, { dateFrom, dateTo, categoryIds: [...categoryIds], categoryExact: true, locationIds: [], paymentMethods: [], necessities: [], noteKeyword: '' });
    _visibleCount = PAGE_SIZE;
    _lastFilterKey = '';
    const input = document.getElementById('list-search-input');
    if (input) input.value = '';
    const toolbar = document.querySelector('#view-list .list-toolbar');
    if (toolbar) {
      const bar = document.createElement('div');
      bar.id = 'list-context-bar';
      bar.className = 'list-context-bar';
      const back = document.createElement('button');
      back.id = 'list-context-back';
      back.type = 'button';
      back.textContent = '返回统计';
      back.addEventListener('click', () => { const callback = _drilldownContext && _drilldownContext.onBack; clearContext(); if (typeof callback === 'function') callback(); });
      const title = document.createElement('span');
      title.textContent = label;
      bar.append(back, title);
      toolbar.prepend(bar);
    }
    render();
  }

  /** 切页时也会关闭未确认的筛选面板，恢复普通列表但不触发导航。 */
  function clearContext() {
    _closeFilterPanel(false);
    if (!_drilldownContext) return;
    Object.assign(_filters, _copyFilters(_drilldownContext.filters));
    _visibleCount = _drilldownContext.visibleCount;
    _sortState = _drilldownContext.sortState;
    _lastFilterKey = JSON.stringify(_filters);
    _drilldownContext = null;
    const bar = document.getElementById('list-context-bar');
    if (bar) bar.remove();
    const input = document.getElementById('list-search-input');
    if (input) input.value = _filters.noteKeyword;
    _syncSearch();
  }

  /** 渲染已选筛选条件 chip + 清除全部按钮 */
  function _renderActiveFilters() {
    const container = document.getElementById('list-active-filters');
    if (!container) return;

    const chips = [];

    // 关键词与其他条件一起提供清除入口，始终可见的搜索框保留原输入。
    if (_filters.noteKeyword) chips.push({ label: _filters.noteKeyword, key: 'keyword' });
    if (_filters.dateFrom || _filters.dateTo) {
      const label = _filters.dateFrom && _filters.dateTo
        ? `${_filters.dateFrom} 至 ${_filters.dateTo}`
        : (_filters.dateFrom ? `自 ${_filters.dateFrom} 起` : `截至 ${_filters.dateTo}`);
      chips.push({ label, key: 'date' });
    }
    _filters.categoryIds.forEach(cid => {
      const cat = _getCategory(cid);
      chips.push({ label: cat ? cat.name : cid, iconMarkup: ExpenseCategories.getIconMarkup(cat), key: 'cat-' + cid });
    });
    _filters.locationIds.forEach(loc => {
      chips.push({ label: loc, key: 'loc-' + loc });
    });
    _filters.paymentMethods.forEach(pm => {
      const p = ExpenseData.PAYMENT_METHODS.find(x => x.value === pm);
      chips.push({ label: p ? p.label : pm, key: 'pm-' + pm });
    });

    _filters.necessities.forEach(value => {
      const opt = ExpenseData.NECESSITY_OPTIONS.find(o => o.value === value);
      chips.push({ label: opt ? opt.label : '未评估', key: 'necessity-' + value });
    });
    ['date', 'category', 'location', 'payment', 'necessity'].forEach(_showFilterChipHighlight);

    if (chips.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = chips.map(c => `
      <button type="button" class="filter-chip filter-chip__remove" data-clear="${ExpenseData.escapeHtml(c.key)}" aria-label="移除筛选：${ExpenseData.escapeHtml(c.label)}">
        ${c.iconMarkup || ''}<span>${ExpenseData.escapeHtml(c.label)}</span>
        <span class="filter-chip__close-icon" aria-hidden="true">×</span>
      </button>
    `).join('') + `
      <button type="button" class="filter-chip__clear-all" id="list-clear-all">清除筛选</button>
    `;

    // 绑定单个清除
    container.querySelectorAll('.filter-chip__remove').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.clear;
        if (key === 'keyword') {
          _filters.noteKeyword = '';
          const si = document.getElementById('list-search-input');
          if (si) si.value = '';
        }
        else if (key === 'date') { _filters.dateFrom = ''; _filters.dateTo = ''; }

        else if (key.startsWith('necessity-')) {
          _filters.necessities = _filters.necessities.filter(x => x !== key.slice(10));
        }
        else if (key.startsWith('cat-')) {
          const cid = key.replace('cat-', '');
          _filters.categoryIds = _filters.categoryIds.filter(x => x !== cid);
        }
        else if (key.startsWith('loc-')) {
          const loc = key.replace('loc-', '');
          _filters.locationIds = _filters.locationIds.filter(x => x !== loc);
        }
        else if (key.startsWith('pm-')) {
          const pm = key.replace('pm-', '');
          _filters.paymentMethods = _filters.paymentMethods.filter(x => x !== pm);
        }
        render();
      });
    });

    // 绑定「清除全部筛选」→ 一把回到初始状态
    const clearAllBtn = container.querySelector('.filter-chip__clear-all');
    if (clearAllBtn) {
      clearAllBtn.addEventListener('click', () => {
        _filters.dateFrom = '';
        _filters.dateTo = '';
        _filters.categoryIds = [];
        _filters.locationIds = [];
        _filters.paymentMethods = [];
        _filters.necessities = [];
        // 也清空搜索关键词
        _filters.noteKeyword = '';
        const searchInput = document.getElementById('list-search-input');
        if (searchInput) searchInput.value = '';
        // 清除筛选保留用户主动选择的排序。
        _showFilterChipHighlight('date');
        _showFilterChipHighlight('category');
        _showFilterChipHighlight('location');
        _showFilterChipHighlight('payment');
        render();
      });
    }
  }

  function _showFilterChipHighlight(filterType) {
    // 高亮已激活的筛选按钮
    document.querySelectorAll('#list-filter-bar .chip').forEach(btn => {
      const ft = btn.dataset.filter;
      if (ft === filterType) {
        const hasActive = (ft === 'date' && Boolean(_filters.dateFrom || _filters.dateTo))
          || (ft === 'category' && _filters.categoryIds.length > 0)
          || (ft === 'location' && _filters.locationIds.length > 0)
          || (ft === 'payment' && _filters.paymentMethods.length > 0)
          || (ft === 'necessity' && _filters.necessities.length > 0);
        btn.classList.toggle('chip--active', hasActive);
      }
    });
  }

  /* =================================================================
     公开 API
     ================================================================= */
  return { render, initFilters, openFromStats, clearContext, hasPendingFilters };
})();
