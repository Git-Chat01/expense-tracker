/* ================================================================
   消费轨迹系统 — category-manager.js
   ExpenseCategoryManager 命名空间：分类管理全屏覆盖层（列表/新增/编辑/删除/图标选择）
   从主控制器拆出（审计高危 No.2）：完整页面级功能，与记账表单编排无关。

   与主控制器的耦合点通过 init(deps) 显式注入（避免反向引用私有状态）：
     deps.renderAddCategories      — 重渲染记账页分类入口
     deps.updateSaveState          — 重算记账页保存按钮文案
     deps.syncFormCategoryState    — 分类被删除后清理表单中失效的选中分类
   ================================================================ */

const ExpenseCategoryManager = (() => {
  'use strict';

  let _deps = null;

  /** 绑定覆盖层静态按钮并接收主控制器注入的回调（app init 时调用一次） */
  function init(deps) {
    _deps = deps || {};

    // 右上角 ✕ 返回按钮：关闭覆盖层，切回记账页
    ExpenseUi.bindOrWarn('overlay-categories-back', () => {
      ExpenseUi.unlockOverlayScroll();
      document.getElementById('overlay-categories').classList.remove('page-overlay--open');
      ExpenseApp.navigate('add');
      // 刷新记账页的分类入口
      if (_deps.renderAddCategories) _deps.renderAddCategories();
    });

    // "+ 新增"按钮
    ExpenseUi.bindOrWarn('overlay-categories-add', () => {
      _showAddCategoryForm();
    });
  }

  /** 打开分类管理覆盖层，渲染分类列表 */
  function open() {
    const overlay = document.getElementById('overlay-categories');
    if (!overlay) return;
    _renderCategoryManagerOverlay();
    overlay.classList.add('page-overlay--open');
    ExpenseUi.lockOverlayScroll();
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

    // 绑定删除事件（软删除：从新记账入口隐藏，历史引用与名称原样保留）
    body.querySelectorAll('[data-del-cat]').forEach(btn => {
      btn.addEventListener('click', () => {
        const catId = btn.dataset.delCat;
        const cat = ExpenseDB.getActiveCategory(catId);
        if (!cat) {
          const readStatus = ExpenseDB.getCoreReadStatus();
          ExpenseToast.show(
            readStatus.ok ? '该分类已在其他页面删除，分类列表已刷新' : ExpenseUi.storageFailText('无法安全读取分类数据'),
            'warning',
            readStatus.ok ? {} : { duration: 6000 },
          );
          if (readStatus.ok) _renderCategoryManagerOverlay();
          return;
        }
        const children = ExpenseDB.getChildCategories(catId);
        const message = children.length > 0
          ? `该分类及其 ${children.length} 个子分类（${children.map(c => c.name).join('、')}）将从新记账可选项中移除。历史账单和原分类名称会保留。`
          : '该分类将从新记账可选项中移除。历史账单和原分类名称会保留。';
        ExpenseConfirm.confirmThen({
          title: `删除分类「${cat.name}」？`,
          message,
          confirmText: '删除',
          danger: true,
        }, () => {
          if (!ExpenseDB.deleteCategory(catId)) {
            const readStatus = ExpenseDB.getCoreReadStatus();
            if (readStatus.ok && !ExpenseDB.getActiveCategory(catId)) {
              ExpenseToast.show('该分类已在其他页面删除，分类列表已刷新', 'warning');
              _renderCategoryManagerOverlay();
              if (_deps.renderAddCategories) _deps.renderAddCategories();
              return;
            }
            ExpenseUi.storageFailToast('分类删除失败，操作已停止且原数据未覆盖');
            return;
          }
          ExpenseHabitPredictor.invalidate();  // 分类关系变了，父级统计可能受影响
          // 当前选中分类被移除（含子分类）→ 同步清理表单与分类组件内部状态。
          if (_deps.syncFormCategoryState) _deps.syncFormCategoryState();
          _renderCategoryManagerOverlay();
          if (_deps.renderAddCategories) _deps.renderAddCategories();
          if (_deps.updateSaveState) _deps.updateSaveState();
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

  function _showCategoryParentValidationError(validation) {
    const messages = {
      SELF_PARENT: '分类不能设为自己的子分类',
      CATEGORY_HAS_CHILDREN: '该分类仍关联子分类（可能包含历史分类），不能再设为二级分类',
      PARENT_UNAVAILABLE: '所选父分类已不存在，请重新选择',
      PARENT_NOT_TOP_LEVEL: '只能选择一级分类作为父级',
    };
    if (validation.code === 'READ_FAILURE') {
      ExpenseUi.storageFailToast('无法安全读取分类数据，操作已停止且原数据未覆盖');
      return;
    }
    ExpenseToast.show(messages[validation.code] || '分类层级无效，请重新选择', 'warning');
  }

  function _categoryParentOptionsHtml(parents, selectedId, emptyLabel) {
    return `<option value="">${emptyLabel}</option>` + parents.map(parent =>
      `<option value="${ExpenseData.escapeHtml(parent.id)}" ${parent.id === selectedId ? 'selected' : ''}>${ExpenseData.escapeHtml(parent.icon)} ${ExpenseData.escapeHtml(parent.name)}</option>`
    ).join('');
  }

  function _refreshEditCategoryParentControl(select, hint, categoryId, preferredParentId) {
    const validation = ExpenseDB.validateCategoryParent(categoryId, null);
    if (!validation.valid) {
      _showCategoryParentValidationError(validation);
      return false;
    }
    const parents = ExpenseDB.getParentCategories().filter(parent => parent.id !== categoryId);
    const selectedId = parents.some(parent => parent.id === preferredParentId) ? preferredParentId : null;
    select.innerHTML = _categoryParentOptionsHtml(parents, selectedId, '-- 设为一级分类 --');
    select.disabled = validation.hasChildren;
    if (validation.hasChildren) select.value = '';
    hint.hidden = !validation.hasChildren;
    const activeChildCount = ExpenseDB.getChildCategories(categoryId).length;
    hint.textContent = validation.hasChildren
      ? (activeChildCount > 0
        ? '该分类下已有子分类，只能保留为一级分类。'
        : '该分类仍关联已删除的历史子分类，为保持历史层级只能保留为一级分类。')
      : '';
    return true;
  }

  /** 在覆盖层 body 中渲染编辑分类表单（仅自定义分类；改名/改图标不影响历史账单） */
  function _showEditCategoryForm(catId) {
    const body = document.getElementById('overlay-categories-body');
    const cat = ExpenseDB.getActiveCategory(catId);
    if (!body) return;
    if (!cat || cat.isPreset) {
      const readStatus = ExpenseDB.getCoreReadStatus();
      ExpenseToast.show(
        readStatus.ok ? '该分类已在其他页面删除，分类列表已刷新' : ExpenseUi.storageFailText('无法安全读取分类数据'),
        'warning',
        readStatus.ok ? {} : { duration: 6000 },
      );
      if (readStatus.ok) _renderCategoryManagerOverlay();
      return;
    }

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">所属一级分类</label>
          <select class="input" id="edit-cat-parent"></select>
          <div id="edit-cat-parent-hint" hidden style="margin-top:6px;font-size:12px;color:var(--color-text-tertiary)"></div>
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

    const parentSelect = document.getElementById('edit-cat-parent');
    const parentHint = document.getElementById('edit-cat-parent-hint');
    if (!_refreshEditCategoryParentControl(parentSelect, parentHint, catId, cat.parentId)) {
      // 父分类控件校验失败（READ_FAILURE 等）发生在按钮绑定之前：此时表单 HTML 已写入
      // 但按钮无事件。必须回退渲染分类列表，不能留下"点取消/保存都没反应"的死表单。
      _renderCategoryManagerOverlay();
      ExpenseUi.storageFailToast('无法安全读取分类数据，编辑已取消');
      return;
    }

    document.getElementById('edit-cat-save').addEventListener('click', () => {
      if (!ExpenseDB.getActiveCategory(catId)) {
        ExpenseToast.show('该分类已在其他页面删除，无法继续编辑，分类列表已刷新', 'warning');
        _renderCategoryManagerOverlay();
        return;
      }
      const name = document.getElementById('edit-cat-name').value.trim();
      if (!name) { ExpenseToast.show('请输入分类名称', 'warning'); return; }
      const icon = document.getElementById('edit-cat-icon').value.trim() || '📌';
      const parentId = parentSelect.value || null;
      const parentValidation = ExpenseDB.validateCategoryParent(catId, parentId);
      if (!parentValidation.valid) {
        _showCategoryParentValidationError(parentValidation);
        if (parentValidation.code !== 'READ_FAILURE') {
          _refreshEditCategoryParentControl(parentSelect, parentHint, catId, parentId);
        }
        return;
      }
      if (_isCategoryNameTaken(name, parentId, catId)) {
        ExpenseToast.show('同层已存在同名分类，请换一个名称', 'warning');
        return;
      }
      if (!ExpenseDB.updateCategory(catId, { name, icon, parentId })) {
        const readStatus = ExpenseDB.getCoreReadStatus();
        if (readStatus.ok && !ExpenseDB.getActiveCategory(catId)) {
          ExpenseToast.show('该分类已在其他页面删除，无法继续编辑，分类列表已刷新', 'warning');
          _renderCategoryManagerOverlay();
          return;
        }
        const latestValidation = ExpenseDB.validateCategoryParent(catId, parentId);
        if (!latestValidation.valid && latestValidation.code !== 'READ_FAILURE') {
          _showCategoryParentValidationError(latestValidation);
          _refreshEditCategoryParentControl(parentSelect, parentHint, catId, parentId);
          return;
        }
        ExpenseUi.storageFailToast('分类修改失败，操作已停止且原数据未覆盖');
        return;
      }
      ExpenseToast.show(`已保存分类「${name}」`, 'success');
      ExpenseHabitPredictor.invalidate();  // 换父级会让父分类聚合统计过期
      _renderCategoryManagerOverlay();
      // 名称/图标/父级变化会同步到记账页分类入口与已选分类摘要（renderGrid 内刷新）
      if (_deps.renderAddCategories) _deps.renderAddCategories();
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
            ${_categoryParentOptionsHtml(parents, null, '-- 新建一级分类 --')}
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

    const parentSelect = document.getElementById('new-cat-parent');
    document.getElementById('new-cat-save').addEventListener('click', () => {
      const name = document.getElementById('new-cat-name').value.trim();
      if (!name) { ExpenseToast.show('请输入分类名称', 'warning'); return; }
      const icon = document.getElementById('new-cat-icon').value.trim() || '📌';
      const parentId = parentSelect.value || null;
      const parentValidation = ExpenseDB.validateCategoryParent(null, parentId);
      if (!parentValidation.valid) {
        _showCategoryParentValidationError(parentValidation);
        if (parentValidation.code !== 'READ_FAILURE') {
          const latestParents = ExpenseDB.getParentCategories();
          parentSelect.innerHTML = _categoryParentOptionsHtml(latestParents, parentId, '-- 新建一级分类 --');
          if (!latestParents.some(parent => parent.id === parentId)) parentSelect.value = '';
        }
        return;
      }
      if (_isCategoryNameTaken(name, parentId)) {
        ExpenseToast.show('同层已存在同名分类，请换一个名称', 'warning');
        return;
      }

      if (!ExpenseDB.addCategory({ name, icon, parentId })) {
        const latestValidation = ExpenseDB.validateCategoryParent(null, parentId);
        if (!latestValidation.valid && latestValidation.code !== 'READ_FAILURE') {
          _showCategoryParentValidationError(latestValidation);
          const latestParents = ExpenseDB.getParentCategories();
          parentSelect.innerHTML = _categoryParentOptionsHtml(latestParents, parentId, '-- 新建一级分类 --');
          if (!latestParents.some(parent => parent.id === parentId)) parentSelect.value = '';
          return;
        }
        ExpenseUi.storageFailToast('分类添加失败，操作已停止且原数据未覆盖');
        return;
      }
      ExpenseToast.show(`已添加分类「${name}」`, 'success');
      _renderCategoryManagerOverlay();
      if (_deps.renderAddCategories) _deps.renderAddCategories();
    });

    document.getElementById('new-cat-cancel').addEventListener('click', () => {
      _renderCategoryManagerOverlay();
    });

    _renderCategoryIconPicker('new-cat-icon', 'new-cat-icon-picker');
  }

  return { init, open };
})();
