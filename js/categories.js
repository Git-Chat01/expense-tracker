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
  let _collapsed = false;             // 保留给连续记账的摘要状态
  let _drawerOpen = false;             // 完整分类是否在底部抽屉内展开
  let _onSelectStored = null;         // 缓存的选中回调（摘要展开时恢复）
  let _gridContainerId = 'add-category-picker-grid';
  let _subContainerId = 'add-category-picker-subcategories';

  // 新用户也能一键记账；有历史记录后会被真实使用习惯自动替换。
  const _FALLBACK_QUICK_IDS = [
    'cat-food-meal',
    'cat-food-deliver',
    'cat-transport',
    'cat-shopping-daily',
    'cat-entertain',
    'cat-housing',
    'cat-utilities',
    'cat-phone',
    'cat-medical',
    'cat-other',
  ];
  const _MAX_PINNED_QUICK_CATEGORIES = 4;

  // 记账页采用统一的线性图形，避免系统 Emoji 在不同手机上出现风格和尺寸不一致。
  // 自定义分类没有预设图形时仍展示用户自己的 Emoji，保证原有数据可识别。
  const _CATEGORY_ICON_PATHS = {
    utensils: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2M7 2v20m14-7V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2zm0 0v7"/>',
    delivery: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2m10 0H9m10 0h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></g>',
    cup: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M10 2v2m4-2v2m2 4a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1M6 2v2"/>',
    cookie: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 2a10 10 0 1 0 10 10a4 4 0 0 1-5-5a4 4 0 0 1-5-5M8.5 8.5v.01M16 15.5v.01M12 12v.01M11 17v.01M7 14v.01"/>',
    moon: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.985 12.486a9 9 0 1 1-9.473-9.472c.405-.022.617.46.402.803a6 6 0 0 0 8.268 8.268c.344-.215.825-.004.803.401"/>',
    people: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3.128a4 4 0 0 1 0 7.744M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/></g>',
    train: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><rect width="16" height="16" x="4" y="3" rx="2"/><path d="M4 11h16m-8-8v8m-4 8l-2 3m12 0l-2-3m-8-4h.01M16 15h.01"/></g>',
    bag: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M16 10a4 4 0 0 1-8 0M3.103 6.034h17.794"/><path d="M3.4 5.467a2 2 0 0 0-.4 1.2V20a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6.667a2 2 0 0 0-.4-1.2l-2-2.667A2 2 0 0 0 17 2H7a2 2 0 0 0-1.6.8z"/></g>',
    shirt: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.38 3.46L16 2a4 4 0 0 1-8 0L3.62 3.46a2 2 0 0 0-1.34 2.23l.58 3.47a1 1 0 0 0 .99.84H6v10c0 1.1.9 2 2 2h8a2 2 0 0 0 2-2V10h2.15a1 1 0 0 0 .99-.84l.58-3.47a2 2 0 0 0-1.34-2.23"/>',
    phone: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.832 16.568a1 1 0 0 0 1.213-.303l.355-.465A2 2 0 0 1 17 15h3a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2A18 18 0 0 1 2 4a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2v3a2 2 0 0 1-.8 1.6l-.468.351a1 1 0 0 0-.292 1.233a14 14 0 0 0 6.392 6.384"/>',
    box: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73zm1 .27V12"/><path d="M3.29 7L12 12l8.71-5M7.5 4.27l9 5.15"/></g>',
    sparkle: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M11.017 2.814a1 1 0 0 1 1.966 0l1.051 5.558a2 2 0 0 0 1.594 1.594l5.558 1.051a1 1 0 0 1 0 1.966l-5.558 1.051a2 2 0 0 0-1.594 1.594l-1.051 5.558a1 1 0 0 1-1.966 0l-1.051-5.558a2 2 0 0 0-1.594-1.594l-5.558-1.051a1 1 0 0 1 0-1.966l5.558-1.051a2 2 0 0 0 1.594-1.594zM20 2v4m2-2h-4"/><circle cx="4" cy="20" r="2"/></g>',
    house: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/><path d="M3 10a2 2 0 0 1 .709-1.528l7-6a2 2 0 0 1 2.582 0l7 6A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></g>',
    bolt: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.914 4a1.5 1.5 0 0 0-2.474-1.561l-9 9A1.5 1.5 0 0 0 5.5 14h4.002a.5.5 0 0 1 .471.666L8.086 20a1.5 1.5 0 0 0 2.475 1.56l9-9A1.5 1.5 0 0 0 18.5 10h-3.997a.5.5 0 0 1-.472-.667z"/>',
    game: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 11h4M8 9v4m7-1h.01M18 10h.01m-.69-5H6.68a4 4 0 0 0-3.978 3.59l-.017.152C2.604 9.416 2 14.456 2 16a3 3 0 0 0 3 3c1 0 1.5-.5 2-1l1.414-1.414A2 2 0 0 1 9.828 16h4.344a2 2 0 0 1 1.414.586L17 18c.5.5 1 1 2 1a3 3 0 0 0 3-3c0-1.545-.604-6.584-.685-7.258q-.01-.075-.017-.151A4 4 0 0 0 17.32 5"/>',
    bulb: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 14c.2-1 .7-1.7 1.5-2.5c1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5c.7.7 1.3 1.5 1.5 2.5m0 4h6m-5 4h4"/>',
    book: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 5v16m8.001-2A2 2 0 0 0 22 17V5a2 2 0 0 0-1.999-2L16 3.002A5 5 0 0 0 12 5a5 5 0 0 0-4-2H4a2 2 0 0 0-2 2v12a2 2 0 0 0 1.999 2H8a5 5 0 0 1 4 2a5 5 0 0 1 4-2z"/>',
    briefcase: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/></g>',
    heart: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2 9.5a5.5 5.5 0 0 1 9.591-3.676a.56.56 0 0 0 .818 0A5.49 5.49 0 0 1 22 9.5c0 2.29-1.5 4-3 5.5l-5.492 5.313a2 2 0 0 1-3 .019L5 15c-1.5-1.5-3-3.2-3-5.5"/>',
    gift: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M12 7v14m8-10v8a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-8m3.5-4a1 1 0 0 1 0-5A4.8 8 0 0 1 12 7a4.8 8 0 0 1 4.5-5a1 1 0 0 1 0 5"/><rect width="18" height="4" x="3" y="7" rx="1"/></g>',
    plane: '<path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17.8 19.2L16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8L4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1l3 2l2 3l1-1v-3l3-2l3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2"/>',
    badge: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M3.85 8.62a4 4 0 0 1 4.78-4.77a4 4 0 0 1 6.74 0a4 4 0 0 1 4.78 4.78a4 4 0 0 1 0 6.74a4 4 0 0 1-4.77 4.78a4 4 0 0 1-6.75 0a4 4 0 0 1-4.78-4.77a4 4 0 0 1 0-6.76"/><path d="m9 12l2 2l4-4"/></g>',
    more: '<g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/></g>',
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
    return ExpenseData.escapeHtml(value);
  }

  function _categoryIconMarkup(category) {
    const iconData = category && Object.prototype.hasOwnProperty.call(_CATEGORY_ICON_DATA, category.id)
      ? _CATEGORY_ICON_DATA[category.id]
      : null;
    if (!iconData) {
      // 自定义分类：icon 字段是线条图标名 → SVG；否则按 emoji 渲染（兼容老数据与手输 emoji）
      const customBody = category && category.icon && ExpenseIcons.CATEGORY_ICON_PATHS[category.icon];
      if (customBody) {
        return `<span class="category-icon category-icon--custom" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${customBody}</svg></span>`;
      }
      return `<span class="category-icon category-icon--emoji" aria-hidden="true">${_escapeHtml(category && category.icon ? category.icon : '•')}</span>`;
    }
    const [iconName, tone] = iconData;
    return `<span class="category-icon category-icon--${tone}" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${_CATEGORY_ICON_PATHS[iconName]}</svg></span>`;
  }

  // 分类入口只绑定一次：完整网格放进抽屉，主页面高度始终稳定。
  let _pickerControlsBound = false;
  let _pageScrollYBeforePicker = 0;

  function _setPickerOpen(isOpen) {
    const wasOpen = _drawerOpen;
    _drawerOpen = Boolean(isOpen);
    const picker = document.getElementById('add-category-picker');
    if (picker) picker.setAttribute('aria-hidden', String(!_drawerOpen));

    // 抽屉打开时锁住文档滚动；关闭后精确回到用户原本浏览的位置。
    // 仅限制 main-view 不足以阻止移动端的滚动穿透，因为页面本身仍可滚动。
    if (_drawerOpen && !wasOpen) {
      _pageScrollYBeforePicker = window.scrollY || document.documentElement.scrollTop || 0;
      document.body.style.top = `-${_pageScrollYBeforePicker}px`;
    }

    document.body.classList.toggle('category-picker-open', _drawerOpen);
    document.documentElement.classList.toggle('category-picker-open', _drawerOpen);

    if (!_drawerOpen && wasOpen) {
      document.body.style.top = '';
      window.scrollTo(0, _pageScrollYBeforePicker);
    }

    if (!_drawerOpen) _expandedParentId = null;
  }

  function openPicker() {
    if (_selectedCategoryId) {
      const selected = ExpenseDB.getCategory(_selectedCategoryId);
      _expandedParentId = selected && selected.parentId ? selected.parentId : null;
    }
    _setPickerOpen(true);
    renderGrid(_gridContainerId, _subContainerId, _onSelectStored);
  }

  function closePicker() {
    _setPickerOpen(false);
    renderGrid(_gridContainerId, _subContainerId, _onSelectStored);
  }

  function _bindPickerControls() {
    if (_pickerControlsBound) return;

    const summary = document.getElementById('add-category-summary');
    const allButton = document.getElementById('add-category-all');
    const closeButton = document.getElementById('add-category-picker-close');
    const backdrop = document.getElementById('add-category-picker-backdrop');

    if (summary) summary.addEventListener('click', openPicker);
    if (allButton) allButton.addEventListener('click', openPicker);
    if (closeButton) closeButton.addEventListener('click', closePicker);
    if (backdrop) backdrop.addEventListener('click', closePicker);

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !_drawerOpen) return;
      event.preventDefault();
      closePicker();
    });

    _pickerControlsBound = true;
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

    // 横向快捷带可展示更多常用分类，首屏仍只露出约四项，向左滑动即可继续查看。
    return ids.slice(0, 10).map((id) => {
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

    if (!ExpenseDB.saveSettings({ pinnedQuickCategoryIds: pinnedIds })) {
      if (typeof ExpenseApp !== 'undefined') ExpenseApp.showToast('固定分类失败，请检查浏览器存储空间', 'warning');
      return;
    }
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
    _collapsed = true;
    _setPickerOpen(false);
    renderGrid(containerId, subContainerId, _onSelectStored);
    if (_onSelectStored) _onSelectStored(catId);
  }

  function _renderQuickCategories(containerId, subContainerId) {
    const quickGrid = document.getElementById('add-category-quick');
    if (!quickGrid) return;

    const categories = _getQuickCategories();
    quickGrid.innerHTML = categories.map(category => `
      <button class="add-quick-category${category.isQuickPinned ? ' add-quick-category--pinned' : ''}" data-quick-cat-id="${_escapeHtml(category.id)}" type="button" aria-label="${_escapeHtml(category.name)}${category.isQuickPinned ? '，已固定，长按取消固定' : '，长按固定'}">
        <span class="add-quick-category__icon">${_categoryIconMarkup(category)}</span>
        <span class="add-quick-category__name">${_escapeHtml(category.name)}</span>
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

    if (onSelect) _onSelectStored = onSelect;
    _gridContainerId = containerId;
    _subContainerId = subContainerId;
    _bindPickerControls();

    const summary = document.getElementById('add-category-summary');
    if (_selectedCategoryId) {
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
      if (quickGrid) quickGrid.style.display = 'none';
    } else {
      if (summary) summary.style.display = 'none';
      if (quickGrid) {
        quickGrid.style.display = 'flex';
        _renderQuickCategories(containerId, subContainerId);
      }
    }

    // 已选分类时，摘要行本身就是“更换分类”入口，隐藏重复按钮以保持主流程紧凑。
    if (allToggle) {
      allToggle.style.display = _selectedCategoryId ? 'none' : 'inline-flex';
      allToggle.innerHTML = '<span>全部分类</span><span class="add-category-all__chevron" aria-hidden="true">⌄</span>';
    }

    if (!_drawerOpen) {
      grid.style.display = 'none';
      if (subRow) subRow.style.display = 'none';
      return;
    }

    const parents = ExpenseDB.getParentCategories();
    const selectedCat = ExpenseDB.getCategory(_selectedCategoryId);

    // 有子分类时进入二级选择态：隐藏冗长的大类网格，把下一步直接放到抽屉可视区。
    if (_expandedParentId) {
      const parent = ExpenseDB.getCategory(_expandedParentId);
      const children = ExpenseDB.getChildCategories(_expandedParentId);
      if (parent && children.length > 0) {
        grid.style.display = 'none';
        subRow.style.display = 'grid';
        subRow.innerHTML = `
          <div class="category-subcategory-panel">
            <div class="category-subcategory-panel__heading">
              <button class="category-subcategory-panel__back" type="button" data-category-back aria-label="返回大类选择">
                <span aria-hidden="true">‹</span><span>大类</span>
              </button>
              <div class="category-subcategory-panel__context">
                ${_categoryIconMarkup(parent)}
                <span><strong>${_escapeHtml(parent.name)}</strong><small>选择细分分类</small></span>
              </div>
            </div>
            <div class="category-subcategory-grid" role="group" aria-label="${_escapeHtml(parent.name)}的子分类">
              ${children.map(cat => {
                const isSelected = _selectedCategoryId === cat.id;
                return `
                  <button class="cat-chip ${isSelected ? 'cat-chip--selected' : ''}" data-cat-id="${_escapeHtml(cat.id)}" type="button">
                    <span class="cat-chip__icon">${_categoryIconMarkup(cat)}</span>
                    <span class="cat-chip__name">${_escapeHtml(cat.name)}</span>
                  </button>`;
              }).join('')}
            </div>
          </div>`;

        const backButton = subRow.querySelector('[data-category-back]');
        if (backButton) backButton.addEventListener('click', () => {
          _expandedParentId = null;
          renderGrid(containerId, subContainerId, _onSelectStored);
        });
        subRow.querySelectorAll('.cat-chip').forEach(chip => {
          chip.addEventListener('click', () => {
            _selectCategory(chip.dataset.catId, containerId, subContainerId);
          });
        });
        return;
      }
      _expandedParentId = null;
    }

    grid.style.display = 'grid';
    subRow.style.display = 'none';
    grid.innerHTML = parents.map(cat => {
      const isSelected = _selectedCategoryId === cat.id
        || (selectedCat && selectedCat.parentId === cat.id);
      return `
        <button class="cat-btn ${isSelected ? 'cat-btn--selected' : ''}"
                data-cat-id="${_escapeHtml(cat.id)}"
                data-has-children="${ExpenseDB.getChildCategories(cat.id).length > 0}">
          <span class="cat-btn__icon">${_categoryIconMarkup(cat)}</span>
          <span class="cat-btn__name">${_escapeHtml(cat.name)}</span>
        </button>`;
    }).join('');

    grid.querySelectorAll('.cat-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const catId = btn.dataset.catId;
        const hasChildren = btn.dataset.hasChildren === 'true';

        if (hasChildren) {
          _expandedParentId = catId;
          renderGrid(containerId, subContainerId, _onSelectStored);
        } else {
          _selectCategory(catId, containerId, subContainerId);
        }
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
      _setPickerOpen(false);
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
    _setPickerOpen(false);
  }

  /** 保留兼容 API：新的分类选择器没有主页面内展开态。 */
  function uncollapse() {
    _collapsed = false;
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
    closePicker,
  };
})();
