/* ================================================================
   消费轨迹系统 — categories.js
   ExpenseCategories 命名空间：分类选择器 + 分类管理覆盖层
   ================================================================ */

const ExpenseCategories = (() => {
  'use strict';

  /* -----------------------------------------------------------------
     状态
     ----------------------------------------------------------------- */
  let _selectedCategoryId = null;     // 当前选中的分类 ID
  let _expandedParentId = null;       // 当前展开子分类的一级分类 ID
  let _collapsed = false;             // 选中后是否已收起为摘要
  let _allCategoriesVisible = false;  // 是否展开完整分类网格
  let _onSelectStored = null;         // 缓存的选中回调（摘要展开时恢复）

  // 新用户也能一键记账；有历史记录后会被真实使用习惯自动替换。
  const _FALLBACK_QUICK_IDS = [
    'cat-food-meal',
    'cat-food-deliver',
    'cat-transport',
    'cat-shopping-daily',
  ];
  const _MAX_PINNED_QUICK_CATEGORIES = 4;

  // 记账页采用统一的线性图形，避免系统 Emoji 在不同手机上出现风格和尺寸不一致。
  // 自定义分类没有预设图形时仍展示用户自己的 Emoji，保证原有数据可识别。
  const _CATEGORY_ICON_PATHS = {
    utensils: '<path d="M4 3v5M7 3v5M10 3v5M4 8a3 3 0 0 0 6 0M7 8v13"/><path d="M16 3c2 3 2 8-1 11l-1 1v6"/>',
    delivery: '<circle cx="7" cy="17" r="2"/><circle cx="17" cy="17" r="2"/><path d="M5 17h2l3-8h4l2 4h3"/><path d="M12 9h4M4 11h5"/>',
    cup: '<path d="M7 4h10l-1 16H8L7 4Z"/><path d="M10 4V2h4v2M8 9h8"/>',
    cookie: '<circle cx="12" cy="12" r="8"/><path d="M17.4 6.1a3.2 3.2 0 0 0-3.5 3.5 3.2 3.2 0 0 0 3.5 3.5"/><circle cx="9" cy="9" r=".7" fill="currentColor" stroke="none"/><circle cx="9" cy="15" r=".7" fill="currentColor" stroke="none"/>',
    moon: '<path d="M20 15.2A8.5 8.5 0 1 1 8.8 4 6.7 6.7 0 0 0 20 15.2Z"/><path d="m17 3 .5 1.5L19 5l-1.5.5L17 7l-.5-1.5L15 5l1.5-.5Z"/>',
    people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-1a6 6 0 0 1 12 0v1M16 5a3 3 0 0 1 0 6M19 20v-1a5.4 5.4 0 0 0-2.4-4.5"/>',
    train: '<rect x="5" y="3" width="14" height="15" rx="3"/><path d="M8 21h8M8 12h.01M16 12h.01M8 18l-2 3M16 18l2 3M8 7h8"/>',
    bag: '<path d="M6 8h12l1 12H5L6 8Z"/><path d="M9 8V6a3 3 0 0 1 6 0v2"/>',
    shirt: '<path d="m7 4 2-2h6l2 2 4 2-2 5-3-1v10H8V10l-3 1-2-5 4-2Z"/>',
    phone: '<rect x="7" y="2.5" width="10" height="19" rx="2"/><path d="M11 18h2"/>',
    box: '<path d="m4 8 8-4 8 4-8 4-8-4Z"/><path d="M4 8v8l8 4 8-4V8M12 12v8"/>',
    sparkle: '<path d="m12 3 1.2 4.8L18 9l-4.8 1.2L12 15l-1.2-4.8L6 9l4.8-1.2L12 3Z"/><path d="m19 15 .6 2.4L22 18l-2.4.6L19 21l-.6-2.4L16 18l2.4-.6L19 15Z"/>',
    house: '<path d="m4 10 8-6 8 6v10H4V10Z"/><path d="M9 20v-5h6v5"/>',
    bolt: '<path d="m13 2-8 12h6l-1 8 9-13h-6l1-7Z"/>',
    game: '<path d="M7 7h10a4 4 0 0 1 3.8 5.2l-1.1 3.5a2.3 2.3 0 0 1-4 1l-1.4-1.6h-4.6l-1.4 1.6a2.3 2.3 0 0 1-4-1l-1.1-3.5A4 4 0 0 1 7 7Z"/><path d="M8 11v4M6 13h4M16 12h.01M18 14h.01"/>',
    bulb: '<path d="M9 18h6M10 22h4M8.5 15.5C7.5 14.6 7 13.3 7 12a5 5 0 1 1 10 0c0 1.3-.5 2.6-1.5 3.5-.8.7-1.3 1.6-1.4 2.5h-4.2c-.1-.9-.6-1.8-1.4-2.5Z"/>',
    book: '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H12v16H6.5A2.5 2.5 0 0 0 4 21.5v-16Z"/><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H12v16h5.5a2.5 2.5 0 0 1 2.5 2.5v-16Z"/>',
    briefcase: '<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M3 12h18M10 12v2h4v-2"/>',
    heart: '<path d="M20 12h-4l-2 4-3-8-2 4H4"/><path d="M20.5 5.5a5 5 0 0 0-7.1 0L12 6.9l-1.4-1.4a5 5 0 1 0-7.1 7.1L12 21l8.5-8.4a5 5 0 0 0 0-7.1Z"/>',
    gift: '<rect x="4" y="9" width="16" height="11" rx="1"/><path d="M3 9h18v4H3zM12 9v11M12 9H8.5a2 2 0 1 1 2-2V9M12 9h3.5a2 2 0 1 0-2-2V9"/>',
    plane: '<path d="m21 3-7.5 18-3.5-8.5L3 9l18-6Z"/><path d="m10 12.5 4-3.5"/>',
    badge: '<path d="m12 3 2 1.6 2.6-.2 1 2.4 2.2 1.4-.6 2.5.6 2.5-2.2 1.4-1 2.4-2.6-.2L12 21l-2-1.6-2.6.2-1-2.4-2.2-1.4.6-2.5-.6-2.5 2.2-1.4 1-2.4 2.6.2L12 3Z"/><path d="m8.5 12 2.2 2.2 4.8-4.8"/>',
    more: '<circle cx="6" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none"/><circle cx="18" cy="12" r="1" fill="currentColor" stroke="none"/>',
  };
  const _CATEGORY_ICON_DATA = {
    'cat-food': ['utensils', 'food'], 'cat-food-meal': ['utensils', 'food'],
    'cat-food-deliver': ['delivery', 'food'], 'cat-food-drink': ['cup', 'food'],
    'cat-food-snack': ['cookie', 'food'], 'cat-food-night': ['moon', 'food'],
    'cat-food-party': ['people', 'food'], 'cat-transport': ['train', 'transport'],
    'cat-shopping': ['bag', 'shopping'], 'cat-shopping-cloth': ['shirt', 'shopping'],
    'cat-shopping-digi': ['phone', 'shopping'], 'cat-shopping-daily': ['box', 'shopping'],
    'cat-shopping-beaut': ['sparkle', 'shopping'], 'cat-shopping-home': ['house', 'shopping'],
    'cat-shopping-impul': ['bolt', 'shopping'], 'cat-entertain': ['game', 'entertain'],
    'cat-housing': ['house', 'housing'], 'cat-utilities': ['bulb', 'utilities'],
    'cat-phone': ['phone', 'phone'], 'cat-learning': ['book', 'learning'],
    'cat-work': ['briefcase', 'work'], 'cat-medical': ['heart', 'medical'],
    'cat-social': ['gift', 'social'], 'cat-travel': ['plane', 'travel'],
    'cat-subscription': ['badge', 'subscription'], 'cat-other': ['more', 'other'],
  };

  function _escapeHtml(value) {
    return String(value || '').replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
  }

  function _categoryIconMarkup(category) {
    const iconData = category && _CATEGORY_ICON_DATA[category.id];
    if (!iconData) {
      return `<span class="category-icon category-icon--emoji" aria-hidden="true">${_escapeHtml(category && category.icon ? category.icon : '•')}</span>`;
    }
    const [iconName, tone] = iconData;
    return `<span class="category-icon category-icon--${tone}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${_CATEGORY_ICON_PATHS[iconName]}</svg></span>`;
  }

  // 初始化「修改」按钮（只绑定一次）
  let _summaryBound = false;
  function _bindSummaryEdit() {
    if (_summaryBound) return;
    const editBtn = document.getElementById('add-category-summary-edit');
    const summary = document.getElementById('add-category-summary');
    if (!editBtn || !summary) return;
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      _collapsed = false;
      _allCategoriesVisible = true;
      // 如果选中的是子分类，展开父级以便看到选中态
      const cat = ExpenseDB.getCategory(_selectedCategoryId);
      if (cat && cat.parentId) _expandedParentId = cat.parentId;
      ExpenseCategories.renderGrid('add-category-grid', 'add-subcategories', _onSelectStored);
    });
    // 点击摘要整体也可展开
    summary.addEventListener('click', () => {
      _collapsed = false;
      _allCategoriesVisible = true;
      const cat = ExpenseDB.getCategory(_selectedCategoryId);
      if (cat && cat.parentId) _expandedParentId = cat.parentId;
      ExpenseCategories.renderGrid('add-category-grid', 'add-subcategories', _onSelectStored);
    });
    _summaryBound = true;
  }

  function _getQuickCategories() {
    const ids = [];
    const pinnedIds = _getPinnedQuickCategoryIds();
    const addCategory = (id) => {
      if (!id || ids.includes(id)) return;
      const category = ExpenseDB.getCategory(id);
      if (category) ids.push(id);
    };

    pinnedIds.forEach(addCategory);

    // 最近 60 笔按频率与新近程度综合排序；保留末级分类能让入口始终一键完成选择。
    const scores = new Map();
    ExpenseDB.getExpenses().slice(0, 60).forEach((expense, index) => {
      if (!ExpenseDB.getCategory(expense.categoryId)) return;
      const recencyWeight = Math.max(1, 8 - Math.floor(index / 8));
      scores.set(expense.categoryId, (scores.get(expense.categoryId) || 0) + recencyWeight);
    });
    [...scores.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([categoryId]) => addCategory(categoryId));
    _FALLBACK_QUICK_IDS.forEach(addCategory);

    return ids.slice(0, 4).map((id) => {
      const category = ExpenseDB.getCategory(id);
      return category ? { ...category, isQuickPinned: pinnedIds.includes(id) } : null;
    }).filter(Boolean);
  }

  function _getPinnedQuickCategoryIds() {
    const settings = ExpenseDB.getSettings();
    const ids = Array.isArray(settings.pinnedQuickCategoryIds) ? settings.pinnedQuickCategoryIds : [];
    return [...new Set(ids)]
      .filter(id => Boolean(ExpenseDB.getCategory(id)))
      .slice(0, _MAX_PINNED_QUICK_CATEGORIES);
  }

  function _toggleQuickCategoryPin(categoryId, containerId, subContainerId) {
    const pinnedIds = _getPinnedQuickCategoryIds();
    const existingIndex = pinnedIds.indexOf(categoryId);

    if (existingIndex >= 0) {
      pinnedIds.splice(existingIndex, 1);
    } else if (pinnedIds.length < _MAX_PINNED_QUICK_CATEGORIES) {
      pinnedIds.push(categoryId);
    } else {
      return;
    }

    ExpenseDB.saveSettings({ pinnedQuickCategoryIds: pinnedIds });
    renderGrid(containerId, subContainerId, _onSelectStored);
  }

  function _bindQuickCategoryGesture(button, containerId, subContainerId) {
    let holdTimer = null;
    let longPressed = false;
    let startX = 0;
    let startY = 0;
    const clearHoldTimer = () => {
      if (holdTimer) window.clearTimeout(holdTimer);
      holdTimer = null;
    };

    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      longPressed = false;
      startX = event.clientX;
      startY = event.clientY;
      clearHoldTimer();
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        longPressed = true;
        _toggleQuickCategoryPin(button.dataset.quickCatId, containerId, subContainerId);
      }, 500);
    });
    button.addEventListener('pointermove', (event) => {
      if (Math.abs(event.clientX - startX) > 10 || Math.abs(event.clientY - startY) > 10) clearHoldTimer();
    });
    button.addEventListener('pointerup', clearHoldTimer);
    button.addEventListener('pointercancel', () => {
      clearHoldTimer();
      longPressed = false;
    });
    button.addEventListener('click', (event) => {
      if (longPressed) {
        event.preventDefault();
        event.stopPropagation();
        longPressed = false;
        return;
      }
      _selectCategory(button.dataset.quickCatId, containerId, subContainerId);
    });
  }

  function _selectCategory(catId, containerId, subContainerId) {
    _selectedCategoryId = catId;
    _expandedParentId = null;
    _allCategoriesVisible = false;
    _collapsed = true;
    renderGrid(containerId, subContainerId, _onSelectStored);
    if (_onSelectStored) _onSelectStored(catId);
  }

  function _renderQuickCategories(containerId, subContainerId) {
    const quickGrid = document.getElementById('add-category-quick');
    if (!quickGrid) return;

    const categories = _getQuickCategories();
    quickGrid.innerHTML = categories.map(category => `
      <button class="add-quick-category${category.isQuickPinned ? ' add-quick-category--pinned' : ''}" data-quick-cat-id="${category.id}" type="button" aria-label="${category.name}${category.isQuickPinned ? '，已固定，长按取消固定' : '，长按固定'}">
        <span class="add-quick-category__icon">${_categoryIconMarkup(category)}</span>
        <span class="add-quick-category__name">${category.name}</span>
        ${category.isQuickPinned ? '<span class="add-quick-category__pin" aria-hidden="true">⌖</span>' : ''}
      </button>
    `).join('');

    quickGrid.querySelectorAll('[data-quick-cat-id]').forEach(button => {
      _bindQuickCategoryGesture(button, containerId, subContainerId);
    });
  }

  /* -----------------------------------------------------------------
     渲染分类网格（一级分类 + 子分类行）
     ----------------------------------------------------------------- */
  function renderGrid(containerId, subContainerId, onSelect) {
    const grid = document.getElementById(containerId);
    const subRow = document.getElementById(subContainerId);
    const quickGrid = document.getElementById('add-category-quick');
    const allToggle = document.getElementById('add-category-all');
    if (!grid) return;

    // 缓存回调，确保摘要展开后也能正常选中
    if (onSelect) _onSelectStored = onSelect;

    // 已选中 + 已收起 → 显示摘要行，隐藏网格
    const summary = document.getElementById('add-category-summary');
    if (_selectedCategoryId && _collapsed) {
      const cat = ExpenseDB.getCategory(_selectedCategoryId);
      if (cat && summary) {
        const iconEl = document.getElementById('add-category-summary-icon');
        const textEl = document.getElementById('add-category-summary-text');
        if (cat.parentId) {
          const parent = ExpenseDB.getCategory(cat.parentId);
          if (iconEl) iconEl.innerHTML = _categoryIconMarkup(cat);
          if (textEl) textEl.textContent = (parent ? parent.name + ' > ' : '') + cat.name;
        } else {
          if (iconEl) iconEl.innerHTML = _categoryIconMarkup(cat);
          if (textEl) textEl.textContent = cat.name;
        }
        summary.style.display = 'flex';
      }
      grid.style.display = 'none';
      if (subRow) subRow.style.display = 'none';
      if (quickGrid) quickGrid.style.display = 'none';
      if (allToggle) {
        allToggle.style.display = 'none';
        allToggle.setAttribute('aria-expanded', 'false');
      }
      _bindSummaryEdit();
      return;
    }

    // 未收起：先给出 4 个一键常用分类，完整分类仅在需要时展开。
    if (summary) summary.style.display = 'none';
    if (quickGrid) {
      quickGrid.style.display = _allCategoriesVisible ? 'none' : 'grid';
      if (!_allCategoriesVisible) _renderQuickCategories(containerId, subContainerId);
    }
    if (allToggle) {
      allToggle.style.display = 'inline-flex';
      allToggle.setAttribute('aria-expanded', String(_allCategoriesVisible));
      allToggle.innerHTML = _allCategoriesVisible
        ? '<span>收起分类</span><span class="add-category-all__chevron" aria-hidden="true">⌃</span>'
        : '<span>全部分类</span><span class="add-category-all__chevron" aria-hidden="true">⌄</span>';
      allToggle.onclick = () => {
        const isClosing = _allCategoriesVisible;
        _allCategoriesVisible = !_allCategoriesVisible;
        _expandedParentId = null;
        // 已有选择时收起应回到摘要，不能让用户看不见仍会被保存的旧分类。
        if (isClosing && _selectedCategoryId) _collapsed = true;
        renderGrid(containerId, subContainerId, _onSelectStored);
      };
    }
    grid.style.display = _allCategoriesVisible ? 'grid' : 'none';
    _bindSummaryEdit();

    const parents = ExpenseDB.getParentCategories();

    // 一级分类网格
    const selectedCat = ExpenseDB.getCategory(_selectedCategoryId);
    grid.innerHTML = parents.map(cat => {
      // 直接选中该分类，或其子分类被选中 → 父级高亮
      const isSelected = _selectedCategoryId === cat.id
        || (selectedCat && selectedCat.parentId === cat.id);
      const isExpanded = _expandedParentId === cat.id;
      return `
        <button class="cat-btn ${isSelected ? 'cat-btn--selected' : ''}"
                data-cat-id="${cat.id}"
                data-has-children="${ExpenseDB.getChildCategories(cat.id).length > 0}">
          <span class="cat-btn__icon">${_categoryIconMarkup(cat)}</span>
          <span class="cat-btn__name">${cat.name}</span>
          ${isExpanded ? '<span style="font-size:10px">▲</span>' : ''}
        </button>`;
    }).join('');

    // 子分类行（仅当完整分类与父分类均展开时显示）
    if (_allCategoriesVisible && _expandedParentId) {
      const children = ExpenseDB.getChildCategories(_expandedParentId);
      if (children.length > 0) {
        subRow.style.display = 'flex';
        subRow.innerHTML = children.map(cat => {
          const isSelected = _selectedCategoryId === cat.id;
          return `
            <button class="cat-chip ${isSelected ? 'cat-chip--selected' : ''}"
                    data-cat-id="${cat.id}">
              <span class="cat-chip__icon">${_categoryIconMarkup(cat)}</span>
              <span class="cat-chip__name">${cat.name}</span>
            </button>`;
        }).join('');
      } else {
        subRow.style.display = 'none';
      }
    } else {
      subRow.style.display = 'none';
    }

    // 未展开完整分类时，无需继续绑定隐藏网格的事件。
    if (!_allCategoriesVisible) return;

    // 绑定点击事件
    grid.querySelectorAll('.cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const catId = btn.dataset.catId;
        const hasChildren = btn.dataset.hasChildren === 'true';

        if (hasChildren && _expandedParentId !== catId) {
          // 点击一级分类 → 展开/切换子分类，不清除已选中的分类（浏览子类不代表要放弃选择）
          _expandedParentId = catId;
          renderGrid(containerId, subContainerId, _onSelectStored);
        } else if (hasChildren && _expandedParentId === catId) {
          // 再次点击同一个一级分类 → 收起
          _expandedParentId = null;
          renderGrid(containerId, subContainerId, _onSelectStored);
        } else {
          // 没有子分类 → 直接选中并收起
          _selectCategory(catId, containerId, subContainerId);
        }
      });
    });

    subRow.querySelectorAll('.cat-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        _selectCategory(chip.dataset.catId, containerId, subContainerId);
      });
    });
  }

  /* -----------------------------------------------------------------
     选中/清除选中
     ----------------------------------------------------------------- */
  function getSelectedId() {
    return _selectedCategoryId;
  }

  function getSelectedCategory() {
    if (!_selectedCategoryId) return null;
    return ExpenseDB.getCategory(_selectedCategoryId);
  }

  function setSelected(catId, options = {}) {
    _selectedCategoryId = catId;
    if (options.collapse) {
      _collapsed = true;
      _allCategoriesVisible = false;
      _expandedParentId = null;
      return;
    }
    // 如果选中的是子分类，自动展开父级
    const cat = ExpenseDB.getCategory(catId);
    if (cat && cat.parentId) {
      _expandedParentId = cat.parentId;
    }
  }

  function clearSelection() {
    _selectedCategoryId = null;
    _expandedParentId = null;
    _collapsed = false;
    _allCategoriesVisible = false;
  }

  /** 仅取消收起态，保留已选分类（用于保存后恢复网格） */
  function uncollapse() {
    _collapsed = false;
  }

  /* -----------------------------------------------------------------
     分类管理覆盖层
     ----------------------------------------------------------------- */
  function renderManager() {
    const body = document.getElementById('overlay-categories-body');
    const parents = ExpenseDB.getParentCategories();

    body.innerHTML = parents.map(p => {
      const children = ExpenseDB.getChildCategories(p.id);
      return `
        <div style="margin-bottom:16px">
          <div style="display:flex;align-items:center;gap:8px;padding:8px 0;font-weight:600">
            ${_categoryIconMarkup(p)}
            <span>${p.name}</span>
            <span style="font-size:11px;color:var(--color-text-tertiary)">${p.isPreset ? '预设' : '自定义'}</span>
          </div>
          <div style="padding-left:24px">
            ${children.map(c => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--color-divider)">
                <span style="display:flex;align-items:center;gap:6px">${_categoryIconMarkup(c)} ${c.name}</span>
                ${!c.isPreset ? `<button class="btn btn--ghost btn--small" data-del-cat="${c.id}" style="color:var(--color-danger)">删除</button>` : `<span style="font-size:11px;color:var(--color-text-tertiary)">预设</span>`}
              </div>
            `).join('')}
          </div>
        </div>`;
    }).join('');

    // 删除事件
    body.querySelectorAll('[data-del-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (confirm('确定删除此分类？')) {
          ExpenseDB.deleteCategory(btn.dataset.delCat);
          renderManager();
        }
      });
    });
  }

  /* =================================================================
     公开 API
     ================================================================= */
  return {
    renderGrid,
    getSelectedId,
    getSelectedCategory,
    getIconMarkup: _categoryIconMarkup,
    setSelected,
    clearSelection,
    uncollapse,
    renderManager,
  };
})();
