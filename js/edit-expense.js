/* ================================================================
   消费轨迹系统 — edit-expense.js
   ExpenseEditOverlay 命名空间：编辑消费记录覆盖层（供账单页/首页最近记录调用）
   从主控制器拆出（审计高危 No.2）：完整页面级功能，与记账表单编排无关。
   同时完成审计低危项：readEditDraft / validateEditDraft / showEditValidationError
   / persistEdit 从 open() 内嵌闭包提级为模块级函数，闭包捕获的
   body / expense / expenseId 改为显式参数，便于测试与复用。
   ================================================================ */

const ExpenseEditOverlay = (() => {
  'use strict';

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
    ExpenseUi.lockOverlayScroll();
  }

  function _closeEditSheet() {
    const sheet = document.getElementById('overlay-edit');
    const backdrop = document.getElementById('overlay-edit-backdrop');
    if (sheet) sheet.classList.remove('bottom-sheet--open');
    if (backdrop) backdrop.classList.remove('bottom-sheet-backdrop--open');
    ExpenseUi.unlockOverlayScroll();
  }

  /** 绑定覆盖层静态按钮（返回/删除/遮罩，只绑一次；app init 时调用） */
  function init() {
    // 返回按钮：关闭面板后回到进入前的页面
    ExpenseUi.bindOrWarn('overlay-edit-back', () => {
      _closeEditSheet();
      ExpenseApp.navigate(_preEditView);
    });

    // 删除按钮（只绑定一次，通过 _editingExpenseId 获取当前记录）
    // 确认改用自绘弹窗：iOS 独立 PWA 下 window.confirm 被禁用、静默返回 false
    ExpenseUi.bindOrWarn('overlay-edit-delete', () => {
      if (!_editingExpenseId) return;
      ExpenseConfirm.confirmThen({
        title: '删除这条记录？',
        message: '此操作不可恢复。',
        confirmText: '删除',
        danger: true,
      }, () => {
        if (!ExpenseDB.deleteExpense(_editingExpenseId)) {
          ExpenseUi.storageFailToast('删除失败，这笔记录仍然保留');
          return;
        }
        ExpenseHabitPredictor.invalidate();
        ExpenseToast.show('已删除', 'success');
        _closeEditSheet();
        _editingExpenseId = null;
        ExpenseUi.refreshAllDataViews();
      });
    });

    // 点击背景遮罩关闭
    const editBackdrop = document.getElementById('overlay-edit-backdrop');
    if (editBackdrop) {
      editBackdrop.addEventListener('click', () => _closeEditSheet());
    }
  }

  /** 构建分类 <select> 的 <option> 列表 */
  function _buildCategoryOptions(selectedId) {
    const parents = ExpenseDB.getParentCategories();
    let html = '<option value="">-- 请选择 --</option>';
    const historicalCategory = ExpenseDB.getCategory(selectedId);
    if (historicalCategory && !ExpenseDB.getActiveCategory(selectedId)) {
      html += `<option value="${ExpenseData.escapeHtml(historicalCategory.id)}" selected>${ExpenseData.escapeHtml(historicalCategory.icon)} ${ExpenseData.escapeHtml(historicalCategory.name)}（已删除，仅保留历史）</option>`;
    } else if (selectedId && !historicalCategory) {
      html += `<option value="${ExpenseData.escapeHtml(selectedId)}" selected>原分类已不存在（仅保留历史引用）</option>`;
    }
    parents.forEach(p => {
      html += `<option value="${ExpenseData.escapeHtml(p.id)}" ${p.id === selectedId ? 'selected' : ''}>${ExpenseData.escapeHtml(p.icon)} ${ExpenseData.escapeHtml(p.name)}</option>`;
      const children = ExpenseDB.getChildCategories(p.id);
      children.forEach(c => {
        html += `<option value="${ExpenseData.escapeHtml(c.id)}" ${c.id === selectedId ? 'selected' : ''}>&nbsp;&nbsp;└ ${ExpenseData.escapeHtml(c.icon)} ${ExpenseData.escapeHtml(c.name)}</option>`;
      });
    });
    return html;
  }

  /** 读取编辑表单当前草稿，返回 { draft, amountUnchanged } */
  function _readEditDraft(body, expense) {
    const amountRaw = document.getElementById('edit-amount').value;
    const pmBtn = body.querySelector('[data-edit-pm].chip--active');
    const necessityBtn = body.querySelector('[data-edit-necessity].chip--active');
    // 金额"未变更"优先按分值判定：字符串比较会被输入框规范化（尾随零、前导零等）
    // 误伤，导致未改金额也弹"确认修改为大额支出"。legacy 原值（超精度/超上限）
    // 无法解析为分，只能回退字符串比较（与历史行为一致）。
    const originalMoney = ExpenseDB.validateMoney(expense.amount);
    const amountUnchanged = originalMoney.ok
      ? (() => {
          const parsed = ExpenseDB.validateMoney(amountRaw, { allowEmpty: true });
          return parsed.ok && parsed.cents === originalMoney.cents;
        })()
      : amountRaw === String(expense.amount);
    return {
      draft: {
      amount:        amountUnchanged ? expense.amount : amountRaw,
      categoryId:    document.getElementById('edit-category').value,
      location:      document.getElementById('edit-location').value,
      paymentMethod: pmBtn ? pmBtn.dataset.editPm : '',
      necessity:     necessityBtn ? necessityBtn.dataset.editNecessity : '',
      note:          document.getElementById('edit-note').value,
      date:          document.getElementById('edit-date').value,
      time:          document.getElementById('edit-time').value,
      },
      amountUnchanged,
    };
  }

  function _validateEditDraft(body, expense) {
    const current = _readEditDraft(body, expense);
    return ExpenseDB.validateExpenseDraft(current.draft, {
      allowHistoricalCategoryId: expense.categoryId,
      allowLegacyMoney: current.amountUnchanged,
    });
  }

  function _showEditValidationError(validation) {
    const error = validation && validation.error;
    if (!error) return;
    const fieldMap = {
      amount: 'edit-amount',
      categoryId: 'edit-category',
      date: 'edit-date',
      time: 'edit-time',
    };
    const invalidElement = fieldMap[error.field] && document.getElementById(fieldMap[error.field]);
    if (invalidElement) invalidElement.focus();
    ExpenseToast.show(error.message, 'warning');
  }

  function _persistEdit(body, expense, expenseId, expectedCents) {
    const validation = _validateEditDraft(body, expense);
    if (!validation.ok) {
      _showEditValidationError(validation);
      return;
    }
    if (expectedCents != null && validation.cents !== expectedCents) {
      ExpenseToast.show('金额已变更，请重新确认', 'warning');
      return;
    }
    const updated = ExpenseDB.updateExpense(expenseId, validation.value);

    if (!updated) {
      ExpenseUi.storageFailToast('修改保存失败，操作已停止且原数据未覆盖');
      return;
    }
    ExpenseHabitPredictor.invalidate();
    ExpenseToast.show('已更新', 'success');
    _closeEditSheet();
    _editingExpenseId = null;
    ExpenseUi.refreshAllDataViews();
  }

  function open(expenseId) {
    const overlay = document.getElementById('overlay-edit');
    const body = document.getElementById('overlay-edit-body');
    if (!overlay || !body) return;

    const expense = ExpenseDB.getExpense(expenseId);
    if (!expense) return;

    // 记录进入编辑前的页面，关闭时回到该页面（而非总是跳首页）
    _preEditView = ExpenseApp.getCurrentView();

    // 存储当前编辑的记录 ID（供删除按钮使用，只绑定一次）
    _editingExpenseId = expenseId;

    body.innerHTML = `
      <div style="display:flex;flex-direction:column;gap:16px">
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px">金额 ¥</label>
          <input type="number" class="input" id="edit-amount" value="${ExpenseData.escapeHtml(expense.amount)}" step="0.01" min="0.01" max="99999999.99" inputmode="decimal">
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
            ${ExpenseUi.renderChipGroup(ExpenseData.PAYMENT_METHODS, {
              activeValue: expense.paymentMethod,
              dataAttr: 'data-edit-pm',
              extraClass: 'chip--payment',
            })}
          </div>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M13.744 17.736a6 6 0 1 1-7.48-7.48M15 6h1v4"/><path d="m6.134 14.768l.866-.5l2 3.464"/><circle cx="16" cy="8" r="6"/></g></svg> 价值评定</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap">
            ${ExpenseUi.renderChipGroup(ExpenseData.NECESSITY_OPTIONS, {
              activeValue: expense.necessity,
              dataAttr: 'data-edit-necessity',
              extraClass: 'chip--payment',  // 编辑层两种 chip 统一沿用旧 class，仅改样式文件再统一调整
            })}
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
      const validation = _validateEditDraft(body, expense);
      if (!validation.ok) {
        _showEditValidationError(validation);
        return;
      }
      // 金额变更判定与 _readEditDraft 的 amountUnchanged 口径一致（按分值比较），
      // 避免 Object.is 对输入框规范化后的值误判"已修改"。
      const amountChanged = !_readEditDraft(body, expense).amountUnchanged;
      if (amountChanged && validation.cents >= ExpenseData.LARGE_AMOUNT_THRESHOLD_CENTS) {
        const confirmedCents = validation.cents;
        const amountText = validation.value.amount.toLocaleString('zh-CN', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        });
        ExpenseConfirm.confirmThen({
          title: '确认修改为大额支出？',
          message: `将把这笔支出修改为 ¥${amountText}。`,
          confirmText: '确认修改',
        }, () => {
          const latest = _validateEditDraft(body, expense);
          if (!latest.ok) {
            _showEditValidationError(latest);
            return;
          }
          if (latest.cents !== confirmedCents) {
            ExpenseToast.show('金额已变更，请重新确认', 'warning');
            return;
          }
          _persistEdit(body, expense, expenseId, confirmedCents);
        });
        return;
      }
      _persistEdit(body, expense, expenseId, validation.cents);
    });

    _openEditSheet();
  }

  return { init, open };
})();
