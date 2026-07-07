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
    noteKeyword: '',
    sortBy: 'amount',
    sortOrder: 'desc',
  };

  let _sortState = 0; // 0=金额↓, 1=金额↑, 2=日期↓, 3=日期↑
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
      const allCatIds = new Set();
      _filters.categoryIds.forEach(cid => {
        allCatIds.add(cid);
        ExpenseDB.getChildCategories(cid).forEach(c => allCatIds.add(c.id));
      });
      result = result.filter(e => allCatIds.has(e.categoryId));
    }

    // 地点
    if (_filters.locationIds.length > 0) {
      result = result.filter(e => _filters.locationIds.includes(e.location));
    }


    // 支付方式
    if (_filters.paymentMethods.length > 0) {
      result = result.filter(e => _filters.paymentMethods.includes(e.paymentMethod));
    }

    // 备注关键词搜索（模糊匹配）
    if (_filters.noteKeyword) {
      const kw = _filters.noteKeyword.toLowerCase();
      result = result.filter(e => (e.note || '').toLowerCase().includes(kw));
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
          <div class="empty-state__icon">🔍</div>
          <p class="empty-state__text">${hasAnyData ? '没有找到匹配的记录' : '还没有消费记录'}</p>
          <p class="empty-state__hint">${hasAnyData ? '试试换个筛选条件' : '去「记账」Tab 添加第一笔吧'}</p>
        </div>`;
      return;
    }

    // 按日期分组
    const groups = new Map();
    expenses.forEach(e => {
      if (!groups.has(e.date)) groups.set(e.date, []);
      groups.get(e.date).push(e);
    });

    let html = '';
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];

    // 按日期降序排列分组（最新的日期在前）
    const sortedDates = Array.from(groups.keys()).sort((a, b) => b.localeCompare(a));

    for (const date of sortedDates) {
      const items = groups.get(date);
      // 手动解析日期避免 new Date('YYYY-MM-DDT00:00:00') 的跨浏览器时区差异
      const [dy, dm, dd] = date.split('-').map(Number);
      const m = dm;
      const day = dd;
      const w = weekdays[new Date(dy, dm - 1, dd).getDay()];
      const total = items.reduce((sum, e) => sum + e.amount, 0);

      html += `
        <div class="list-group-header">
          <span class="list-group-header__date">${m}月${day}日 周${w}</span>
          <span class="list-group-header__summary">共 ${items.length} 笔 · ¥${total.toFixed(2)}</span>
        </div>`;

      items.forEach(e => {
        html += _renderItem(e);
      });
    }

    container.innerHTML = html;

    // 绑定点击事件
    container.querySelectorAll('.list-item').forEach(el => {
      el.addEventListener('click', () => {
        const id = el.dataset.id;
        if (id) ExpenseApp.openEditExpense(id);
      });
    });
  }

  /** 渲染单条记录 */
  function _renderItem(expense) {
    const cat = ExpenseDB.getCategory(expense.categoryId);
    const icon = cat ? cat.icon : '📌';
    const name = cat ? cat.name : '未分类';

    // 备注关键词高亮
    let noteHtml = '';
    if (expense.note && _filters.noteKeyword) {
      const kw = _filters.noteKeyword;
      const re = new RegExp(kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      noteHtml = `<span class="list-item__note">📝 ${expense.note.replace(re, m => `<mark>${m}</mark>`)}</span>`;
    } else if (expense.note) {
      noteHtml = `<span class="list-item__note">📝 ${expense.note}</span>`;
    }

    // 元数据行
    const metaParts = [];
    if (expense.time) metaParts.push(`⏰${expense.time}`);
    if (expense.location) metaParts.push(`📍${expense.location}`);
    if (expense.paymentMethod) {
      const pm = ExpenseData.PAYMENT_METHODS.find(p => p.value === expense.paymentMethod);
      metaParts.push(pm ? pm.label : expense.paymentMethod);
    }

    const isLarge = expense.amount >= 500;
    const amountClass = isLarge ? 'list-item__amount list-item__amount--large' : 'list-item__amount';

    return `
      <div class="list-item" data-id="${expense.id}">
        <div class="list-item__icon">${icon}</div>
        <div class="list-item__body">
          <div class="list-item__header">
            <span class="list-item__name">${name}</span>
          </div>
          ${metaParts.length ? `<div class="list-item__meta">${metaParts.join(' · ')}</div>` : ''}
          ${noteHtml}
        </div>
        <span class="${amountClass}">-¥${expense.amount.toFixed(2)}</span>
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
    const searchInput = document.getElementById('list-search-input');
    const searchBar = document.getElementById('list-search');
    const searchToggle = document.getElementById('list-search-toggle');
    const searchClose = document.getElementById('list-search-close');

    // 搜索输入
    if (searchInput) {
      searchInput.addEventListener('input', () => {
        _filters.noteKeyword = searchInput.value.trim();
        render();
      });
    }

    // 搜索栏折叠/展开
    if (searchToggle && searchBar) {
      searchToggle.addEventListener('click', () => {
        searchBar.classList.add('list-search--open');
        searchClose.style.display = 'flex';
        searchToggle.style.display = 'none';
        if (searchInput) {
          searchInput.focus();
          // 清除默认占位文字的 input 事件需要触发一次搜索
          // 但这里只是展开，不改变关键词，不用重搜
        }
      });
    }

    // 关闭搜索
    if (searchClose && searchBar) {
      searchClose.addEventListener('click', () => {
        _closeSearch();
      });
    }

    // 点击搜索栏外部关闭（但不关闭下拉）
    if (searchInput) {
      searchInput.addEventListener('blur', () => {
        // 延迟检查：如果输入为空且失去焦点，自动收起
        setTimeout(() => {
          if (!searchInput.value.trim() && searchBar.classList.contains('list-search--open')) {
            _closeSearch();
          }
        }, 200);
      });
    }

    // 筛选栏按钮
    document.querySelectorAll('#list-filter-bar .chip').forEach(btn => {
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

  /** 收起搜索栏（仅折叠 UI，不自动清除关键词） */
  function _closeSearch() {
    const searchBar = document.getElementById('list-search');
    const searchToggle = document.getElementById('list-search-toggle');
    const searchClose = document.getElementById('list-search-close');
    if (!searchBar) return;
    searchBar.classList.remove('list-search--open');
    if (searchToggle) searchToggle.style.display = 'flex';
    if (searchClose) searchClose.style.display = 'none';
    // 不清空关键词 — 用户可能手误关闭搜索栏，下次展开时应保留
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
    btn.textContent = '🔤 ' + cfg.label;
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

    if (filterType === 'payment') {
      dropdown.innerHTML = ExpenseData.PAYMENT_METHODS.map(pm => `
        <div class="list-dropdown__item ${_filters.paymentMethods.includes(pm.value) ? 'list-dropdown__item--active' : ''}" data-val="${pm.value}">
          ${pm.label}
        </div>`).join('');
    } else if (filterType === 'location') {
      // 从历史记录提取所有不重复地点
      const locations = new Set();
      ExpenseDB.getExpenses().forEach(e => { if (e.location) locations.add(e.location); });
      dropdown.innerHTML = Array.from(locations).slice(0, 20).map(loc => `
        <div class="list-dropdown__item ${_filters.locationIds.includes(loc) ? 'list-dropdown__item--active' : ''}" data-val="${loc}">
          📍 ${loc}
        </div>`).join('');
      if (locations.size === 0) {
        dropdown.innerHTML = '<div style="padding:12px;text-align:center;color:var(--color-text-tertiary)">暂无地点数据</div>';
      }
    } else if (filterType === 'category') {
      dropdown.innerHTML = ExpenseDB.getParentCategories().map(cat => `
        <div class="list-dropdown__item ${_filters.categoryIds.includes(cat.id) ? 'list-dropdown__item--active' : ''}" data-val="${cat.id}">
          ${cat.icon} ${cat.name}
        </div>`).join('');
    } else if (filterType === 'date') {
      const today = new Date();
      const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;
      dropdown.innerHTML = `
        <div class="list-dropdown__item" data-pick="today">📅 今天</div>
        <div class="list-dropdown__item" data-pick="week">📅 本周</div>
        <div class="list-dropdown__item" data-pick="month">📅 本月</div>
        <div style="border-top:1px solid var(--color-border);margin:6px 0 0;padding:8px 4px 0">
          <div style="font-size:11px;color:var(--color-text-tertiary);margin-bottom:6px;padding:0 8px">📆 自定义日期</div>
          <div style="display:flex;gap:4px;align-items:center;padding:0 4px">
            <input type="date" class="list-dropdown__date-from" value="${_filters.dateFrom || todayStr}" style="flex:1;font-size:11px;padding:4px 6px;border:1px solid var(--color-border);border-radius:4px;min-width:0">
            <span style="font-size:11px;color:var(--color-text-tertiary);flex-shrink:0">至</span>
            <input type="date" class="list-dropdown__date-to" value="${_filters.dateTo || todayStr}" style="flex:1;font-size:11px;padding:4px 6px;border:1px solid var(--color-border);border-radius:4px;min-width:0">
            <button class="list-dropdown__date-confirm" style="flex-shrink:0;padding:4px 10px;font-size:11px;background:var(--color-primary);color:#fff;border:none;border-radius:4px;cursor:pointer;white-space:nowrap">确定</button>
          </div>
        </div>`;
    }

    // 定位下拉：挂到 app-container 上，绕过父级 overflow 裁剪
    const appContainer = document.querySelector('.app-container');
    if (appContainer) {
      const btnRect = btn.getBoundingClientRect();
      const appRect = appContainer.getBoundingClientRect();
      dropdown.style.position = 'absolute';
      dropdown.style.top  = (btnRect.bottom - appRect.top + appContainer.scrollTop + 4) + 'px';
      dropdown.style.left = (btnRect.left - appRect.left) + 'px';
      dropdown.style.minWidth = (filterType === 'date' ? 290 : Math.max(160, btnRect.width)) + 'px';
      appContainer.appendChild(dropdown);
    }

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
        _filters.dateFrom = fromInput ? fromInput.value : '';
        _filters.dateTo = toInput ? toInput.value : '';
        dropdown.remove();
        _openDropdownBtn = null;
        _showFilterChipHighlight(filterType);
        render();
      });
    }

    // 点击外部关闭
    setTimeout(() => {
      document.addEventListener('click', function closeDropdown(e) {
        if (!dropdown.contains(e.target) && e.target !== btn) {
          dropdown.remove();
          _openDropdownBtn = null;
          document.removeEventListener('click', closeDropdown);
        }
      });
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

    // 关键词搜索也展示为 chip，用户关闭搜索栏后仍能看到筛选生效
    if (_filters.noteKeyword) chips.push({ label: `🔍 ${_filters.noteKeyword}`, key: 'keyword' });
    if (_filters.dateFrom) chips.push({ label: `📅 ${_filters.dateFrom}~${_filters.dateTo || '今天'}`, key: 'date' });
    _filters.categoryIds.forEach(cid => {
      const cat = ExpenseDB.getCategory(cid);
      chips.push({ label: `${cat ? cat.icon : ''} ${cat ? cat.name : cid}`, key: 'cat-' + cid });
    });
    _filters.locationIds.forEach(loc => {
      chips.push({ label: `📍 ${loc}`, key: 'loc-' + loc });
    });
    _filters.paymentMethods.forEach(pm => {
      const p = ExpenseData.PAYMENT_METHODS.find(x => x.value === pm);
      chips.push({ label: p ? p.label : pm, key: 'pm-' + pm });
    });

    if (chips.length === 0) {
      container.innerHTML = '';
      return;
    }

    container.innerHTML = chips.map(c => `
      <span class="filter-chip">
        ${c.label}
        <span class="filter-chip__remove" data-clear="${c.key}">×</span>
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
        // 也清空搜索关键词
        _filters.noteKeyword = '';
        const searchInput = document.getElementById('list-search-input');
        if (searchInput) searchInput.value = '';
        // 重置排序为默认「金额↓」
        _sortState = 0;
        _filters.sortBy = 'amount';
        _filters.sortOrder = 'desc';
        const sortBtn = document.querySelector('#list-filter-bar .chip[data-filter="sort"]');
        if (sortBtn) sortBtn.textContent = '🔤 金额↓';
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
          || (ft === 'payment' && _filters.paymentMethods.length > 0);
        btn.classList.toggle('chip--active', hasActive);
      }
    });
  }

  /* =================================================================
     公开 API
     ================================================================= */
  return { render, initFilters };
})();
