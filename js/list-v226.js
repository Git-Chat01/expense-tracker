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
    locationIds: [],
    paymentMethods: [],
    necessities: [],
    noteKeyword: '',
    sortBy: 'date',
    sortOrder: 'desc',
  };

  let _sortState = 2; // 0=金额↓, 1=金额↑, 2=日期↓, 3=日期↑
  let _openDropdownBtn = null; // 当前展开下拉的按钮（用于点击切换）

  /* -----------------------------------------------------------------
     渲染入口
     ----------------------------------------------------------------- */
  function render() {
    const allExpenses = ExpenseDB.getExpenses();
    const filtered = _applyFilters(allExpenses);
    _renderList(filtered);
    _renderSummary(filtered);
    // 每次渲染都同步刷新筛选条件 chip 行（包括"清除筛选"按钮的显隐）
    _renderActiveFilters();
    _syncSearch();
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
        if (!parentIdByCategory.has(expense.categoryId)) {
          const category = ExpenseDB.getCategory(expense.categoryId);
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
          const cat = ExpenseDB.getCategory(e.categoryId);
          const parent = cat && cat.parentId ? ExpenseDB.getCategory(cat.parentId) : null;
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

    // 金额排序不做日期分组：用户选「金额↓/↑」期望的是全局排行榜，
    // 分组会打乱金额顺序（跨日期时便宜记录会排在昂贵记录上方，与所选排序矛盾）。
    // 平铺模式下每条记录在 meta 里补上日期，弥补失去的组头信息。
    if (_filters.sortBy === 'amount') {
      container.innerHTML = expenses.map(e => _renderItem(e, { showDate: true })).join('');
      _bindItemClicks(container);
      return;
    }

    // 按日期分组（仅日期排序走分组视图）
    const groups = new Map();
    expenses.forEach(e => {
      if (!groups.has(e.date)) groups.set(e.date, []);
      groups.get(e.date).push(e);
    });

    let html = '';
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

    // 分组方向跟随所选排序：日期↑时组头也升序，与列表顺序保持一致
    const sortedDates = Array.from(groups.keys()).sort(
      _filters.sortOrder === 'asc'
        ? (a, b) => a.localeCompare(b)
        : (a, b) => b.localeCompare(a),
    );

    for (const date of sortedDates) {
      const items = groups.get(date);
      // 手动解析日期避免 new Date('YYYY-MM-DDT00:00:00') 的跨浏览器时区差异
      const [dy, dm, dd] = date.split('-').map(Number);
      const w = weekdays[new Date(dy, dm - 1, dd).getDay()];
      const total = items.reduce((sum, e) => sum + e.amount, 0);

      html += `
        <div class="list-group-header">
          <span class="list-group-header__date">${ExpenseSummary.dateLabel(date, ExpenseDB.today())} 周${w}</span>
          <span class="list-group-header__summary">共 ${items.length} 笔 · ¥${total.toFixed(2)}</span>
        </div>`;

      items.forEach(e => {
        html += _renderItem(e);
      });
    }

    container.innerHTML = html;
    _bindItemClicks(container);
  }

  /** 给渲染好的列表绑定点击（打开编辑面板）；分组与平铺两种视图共用 */
  function _bindItemClicks(container) {
    container.querySelectorAll('.list-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (id) ExpenseApp.openEditExpense(id);
      });
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
    const cat = ExpenseDB.getCategory(expense.categoryId);
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
      <div class="list-item" data-id="${ExpenseData.escapeHtml(expense.id)}">
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
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    document.getElementById('list-summary-count').textContent = `共 ${expenses.length} 笔`;
    document.getElementById('list-summary-total').textContent = `¥${total.toFixed(2)}`;
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
      searchInput.addEventListener('input', () => {
        _filters.noteKeyword = searchInput.value.trim();
        render();
      });
      searchInput.addEventListener('keydown', event => {
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
        if (filterType === 'sort') {
          _cycleSort(btn);
        } else {
          _toggleFilterDropdown(filterType, btn);
        }
      });
    });
  }

  /** 搜索始终可见；清空按钮只清关键词，保留其他筛选和排序。 */
  function _syncSearch() {
    const clear = document.getElementById('list-search-clear');
    const input = document.getElementById('list-search-input');
    if (clear) clear.hidden = !input || !input.value;
    const sort = document.querySelector('[data-filter="sort"]');
    if (sort) sort.setAttribute('aria-label', '切换排序，当前' +
      (_filters.sortBy === 'date'
        ? (_filters.sortOrder === 'desc' ? '日期从新到旧' : '日期从旧到新')
        : (_filters.sortOrder === 'desc' ? '金额从高到低' : '金额从低到高')));
  }

  /** 排序循环：金额↓ → 金额↑ → 日期↓ → 日期↑ */
  function _cycleSort(btn) {
    _sortState = (_sortState + 1) % 4;
    const configs = [
      { sortBy: 'amount', sortOrder: 'desc', label: '金额↓' },
      { sortBy: 'amount', sortOrder: 'asc',  label: '金额↑' },
      { sortBy: 'date',   sortOrder: 'desc', label: '日期↓' },
      { sortBy: 'date',   sortOrder: 'asc',  label: '日期↑' },
    ];
    const cfg = configs[_sortState];
    _filters.sortBy = cfg.sortBy;
    _filters.sortOrder = cfg.sortOrder;
    btn.textContent = cfg.label;
    if (!ExpenseDB.saveSettings({ listSort: cfg.sortBy + '-' + cfg.sortOrder })) {
      ExpenseToast.show('本次排序已切换，但未能记住，下次打开可能恢复原排序', 'warning');
    }
    render();
  }

  /** 简化筛选下拉：以内联 chip 选择为主。再次点击同一按钮关闭 */
  function _toggleFilterDropdown(filterType, btn) {
    // 再次点击同一按钮 → 关闭下拉
    if (_openDropdownBtn === btn) {
      document.querySelectorAll('.list-dropdown').forEach(d => d.remove());
      _openDropdownBtn = null;
      return;
    }

    // 移除已有下拉
    document.querySelectorAll('.list-dropdown').forEach(d => d.remove());
    _openDropdownBtn = btn;

    const dropdown = document.createElement('div');
    dropdown.className = 'list-dropdown';

    if (filterType === 'necessity') {
      dropdown.innerHTML = [...ExpenseData.NECESSITY_OPTIONS, { value: '', label: '未评估' }].map(opt =>
        '<div class="list-dropdown__item ' + (_filters.necessities.includes(opt.value) ? 'list-dropdown__item--active' : '') +
        '" data-val="' + opt.value + '">' + ExpenseData.escapeHtml(opt.label) + '</div>').join('');
    } else if (filterType === 'payment') {
      dropdown.innerHTML = ExpenseData.PAYMENT_METHODS.map(pm => `
        <div class="list-dropdown__item ${_filters.paymentMethods.includes(pm.value) ? 'list-dropdown__item--active' : ''}" data-val="${pm.value}">
          ${pm.label}
        </div>`).join('');
    } else if (filterType === 'location') {
      // 从历史记录提取所有不重复地点
      const locations = new Set();
      ExpenseDB.getExpenses().forEach(e => { if (e.location) locations.add(e.location); });
      dropdown.innerHTML = Array.from(locations).slice(0, 20).map(loc => `
        <div class="list-dropdown__item ${_filters.locationIds.includes(loc) ? 'list-dropdown__item--active' : ''}" data-val="${ExpenseData.escapeHtml(loc)}">
          ${ExpenseData.escapeHtml(loc)}
        </div>`).join('');
      if (locations.size === 0) {
        dropdown.innerHTML = '<div style="padding:12px;text-align:center;color:var(--color-text-tertiary)">暂无地点数据</div>';
      }
    } else if (filterType === 'category') {
      dropdown.innerHTML = ExpenseDB.getParentCategories().map(cat => `
        <div class="list-dropdown__item ${_filters.categoryIds.includes(cat.id) ? 'list-dropdown__item--active' : ''}" data-val="${ExpenseData.escapeHtml(cat.id)}">
          ${ExpenseCategories.getIconMarkup(cat)} ${ExpenseData.escapeHtml(cat.name)}
        </div>`).join('');
    } else if (filterType === 'date') {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      dropdown.innerHTML = `
        <div class="list-dropdown__item" data-pick="today">今天</div>
        <div class="list-dropdown__item" data-pick="week">本周</div>
        <div class="list-dropdown__item" data-pick="month">本月</div>
        <div style="border-top:1px solid var(--color-border);margin:6px 0 0;padding:8px 4px 0">
          <div style="font-size:11px;color:var(--color-text-tertiary);margin-bottom:6px;padding:0 8px">自定义日期</div>
          <div style="display:flex;gap:4px;align-items:center;padding:0 4px">
            <input type="date" class="list-dropdown__date-from" value="${ExpenseData.escapeHtml(_filters.dateFrom || todayStr)}" style="flex:1;font-size:11px;padding:4px 6px;border:1px solid var(--color-border);border-radius:4px;min-width:0">
            <span style="font-size:11px;color:var(--color-text-tertiary);flex-shrink:0">至</span>
            <input type="date" class="list-dropdown__date-to" value="${ExpenseData.escapeHtml(_filters.dateTo || todayStr)}" style="flex:1;font-size:11px;padding:4px 6px;border:1px solid var(--color-border);border-radius:4px;min-width:0">
            <button class="list-dropdown__date-confirm" style="flex-shrink:0;padding:4px 10px;font-size:11px;background:var(--color-primary);color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap">确定</button>
          </div>
          <p class="list-dropdown__date-error" role="alert" hidden></p>
        </div>`;
    }

    // 定位下拉：挂到 app-container 上，绕过父级 overflow 裁剪
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
      const btnRect = btn.getBoundingClientRect();
      const appRect = appContainer.getBoundingClientRect();
      dropdown.style.position = 'absolute';
      dropdown.style.top  = (btnRect.bottom - appRect.top + appContainer.scrollTop + 4) + 'px';
      dropdown.style.left = Math.max(8, Math.min(btnRect.left - appRect.left, appRect.width - (filterType === 'date' ? 290 : Math.max(160, btnRect.width)) - 8)) + 'px';
      dropdown.style.minWidth = (filterType === 'date' ? 290 : Math.max(160, btnRect.width)) + 'px';
      appContainer.appendChild(dropdown);
    }

    // 原生按钮让触屏与键盘使用同一条选择逻辑。
    dropdown.querySelectorAll('.list-dropdown__item').forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = item.className;
      button.innerHTML = item.innerHTML;
      Object.assign(button.dataset, item.dataset);
      item.replaceWith(button);
    });

    // 绑定快捷选项
    dropdown.querySelectorAll('.list-dropdown__item').forEach(item => {
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        const val = item.dataset.val;
        const pick = item.dataset.pick;

        if (filterType === 'date' && pick) {
          _applyDateQuick(pick);
        } else if (filterType === 'payment') {
          _toggleArrayFilter('paymentMethods', val);
        } else if (filterType === 'necessity') {
          _toggleArrayFilter('necessities', val);
        } else if (filterType === 'location') {
          _toggleArrayFilter('locationIds', val);
        } else if (filterType === 'category') {
          _toggleArrayFilter('categoryIds', val);
        }

        dropdown.remove();
        _openDropdownBtn = null;
        _showFilterChipHighlight(filterType);
        render();
      });
    });

    // 日期自定义：确定按钮
    var dateConfirm = dropdown.querySelector('.list-dropdown__date-confirm');
    if (dateConfirm) {
      dateConfirm.addEventListener('click', function(e) {
        e.stopPropagation();
        var fromInput = dropdown.querySelector('.list-dropdown__date-from');
        var toInput = dropdown.querySelector('.list-dropdown__date-to');
        const from = fromInput ? fromInput.value : '';
        const to = toInput ? toInput.value : '';
        if (from && to && from > to) {
          const error = dropdown.querySelector('.list-dropdown__date-error');
          error.textContent = '开始日期不能晚于结束日期';
          error.hidden = false;
          fromInput.setAttribute('aria-invalid', 'true');
          fromInput.focus();
          return;
        }
        _filters.dateFrom = from;
        _filters.dateTo = to;
        dropdown.remove();
        _openDropdownBtn = null;
        _showFilterChipHighlight(filterType);
        render();
      });
    }

    // 点击外部关闭（用具名函数引用，确保下拉被外部移除时也能清理监听器）
    function _closeOnOutsideClick(e) {
      if (!dropdown.isConnected) {
        // dropdown 已被其他操作移除（如切换下拉），清理监听器防止泄漏
        document.removeEventListener('click', _closeOnOutsideClick);
        return;
      }
      if (!dropdown.contains(e.target) && e.target !== btn) {
        dropdown.remove();
        _openDropdownBtn = null;
        document.removeEventListener('click', _closeOnOutsideClick);
      }
    }
    setTimeout(() => {
      document.addEventListener('click', _closeOnOutsideClick);
    }, 0);
  }

  function _applyDateQuick(pick) {
    const today = new Date();
    const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
    if (pick === 'today') {
      _filters.dateFrom = todayStr;
      _filters.dateTo = todayStr;
    } else if (pick === 'week') {
      const dayOfWeek = today.getDay() || 7;
      const monday = new Date(today);
      monday.setDate(today.getDate() - dayOfWeek + 1);
      _filters.dateFrom = `${monday.getFullYear()}-${String(monday.getMonth()+1).padStart(2,'0')}-${String(monday.getDate()).padStart(2,'0')}`;
      _filters.dateTo = todayStr;
    } else if (pick === 'month') {
      _filters.dateFrom = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-01`;
      _filters.dateTo = todayStr;
    }
  }

  function _toggleArrayFilter(arrName, val) {
    const arr = _filters[arrName];
    const idx = arr.indexOf(val);
    if (idx >= 0) arr.splice(idx, 1);
    else arr.push(val);
  }

  /** 渲染已选筛选条件 chip + 清除全部按钮 */
  function _renderActiveFilters() {
    const container = document.getElementById('list-active-filters');
    if (!container) return;

    const chips = [];

    // 关键词与其他条件一起提供清除入口，始终可见的搜索框保留原输入。
    if (_filters.noteKeyword) chips.push({ label: _filters.noteKeyword, key: 'keyword' });
    if (_filters.dateFrom) chips.push({ label: `${_filters.dateFrom}~${_filters.dateTo || '今天'}`, key: 'date' });
    _filters.categoryIds.forEach(cid => {
      const cat = ExpenseDB.getCategory(cid);
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
      <span class="filter-chip">
        ${c.iconMarkup || ''}${ExpenseData.escapeHtml(c.label)}
        <span class="filter-chip__remove" data-clear="${ExpenseData.escapeHtml(c.key)}">×</span>
      </span>
    `).join('') + `
      <button class="filter-chip__clear-all" id="list-clear-all">清除筛选</button>
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
        const hasActive = (ft === 'date' && _filters.dateFrom)
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
  return { render, initFilters };
})();
