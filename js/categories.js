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
    const addCategory = (id) => {
      if (!id || ids.includes(id)) return;
      const category = ExpenseDB.getCategory(id);
      if (category) ids.push(id);
    };

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

    return ids.slice(0, 4).map(id => ExpenseDB.getCategory(id)).filter(Boolean);
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
      <button class="add-quick-category" data-quick-cat-id="${category.id}" type="button">
        <span class="add-quick-category__icon">${category.icon}</span>
        <span class="add-quick-category__name">${category.name}</span>
      </button>
    `).join('');

    quickGrid.querySelectorAll('[data-quick-cat-id]').forEach(button => {
      button.addEventListener('click', () => {
        _selectCategory(button.dataset.quickCatId, containerId, subContainerId);
      });
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
          if (iconEl) iconEl.textContent = (parent ? parent.icon : '') + ' ' + cat.icon;
          if (textEl) textEl.textContent = (parent ? parent.name + ' > ' : '') + cat.name;
        } else {
          if (iconEl) iconEl.textContent = cat.icon;
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
          <span class="cat-btn__icon">${cat.icon}</span>
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
              <span class="cat-chip__icon">${cat.icon}</span>
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
            <span>${p.icon}</span>
            <span>${p.name}</span>
            <span style="font-size:11px;color:var(--color-text-tertiary)">${p.isPreset ? '预设' : '自定义'}</span>
          </div>
          <div style="padding-left:24px">
            ${children.map(c => `
              <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--color-divider)">
                <span>${c.icon} ${c.name}</span>
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
    setSelected,
    clearSelection,
    uncollapse,
    renderManager,
  };
})();
