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
  let _editingSnapshot = null;
  let _baselineDraft = '';
  let _returnFocus = null;
  let _saving = false;
  let _closing = false;
  let _initialized = false;
  let _viewportFrame = 0;

  // 保存区独立于滚动表单；每次打开替换按钮，避免旧草稿闭包和重复监听残留。
  function _createFooter(sheet) {
    let footer = document.getElementById('overlay-edit-footer');
    if (!footer) {
      footer = document.createElement('footer');
      footer.id = 'overlay-edit-footer';
      footer.className = 'edit-sheet-footer';
      sheet.appendChild(footer);
    }
    footer.innerHTML = '<button type="button" class="btn btn--primary btn--block" id="edit-btn-save">保存修改</button>';
  }

  function _syncEditViewport() {
    _viewportFrame = 0;
    if (!_editingExpenseId) return;
    const sheet = document.getElementById('overlay-edit');
    if (!sheet) return;
    const viewport = window.visualViewport;
    const height = viewport ? viewport.height : window.innerHeight;
    const top = viewport ? viewport.offsetTop : 0;
    // 键盘只改变编辑面板可用空间，不改页面滚动根及背景位置。
    sheet.style.setProperty('--edit-viewport-height', `${height}px`);
    sheet.style.setProperty('--edit-viewport-bottom', `${Math.max(0, window.innerHeight - height - top)}px`);
    const body = document.getElementById('overlay-edit-body');
    const active = document.activeElement;
    if (body && active && body.contains(active) && active.matches('input, select')) {
      const field = active.getBoundingClientRect();
      const bounds = body.getBoundingClientRect();
      if (field.bottom > bounds.bottom - 8) body.scrollTop += field.bottom - bounds.bottom + 8;
      else if (field.top < bounds.top + 8) body.scrollTop -= bounds.top - field.top + 8;
    }
  }

  function _queueViewportSync() {
    if (_editingExpenseId && !_viewportFrame) _viewportFrame = requestAnimationFrame(_syncEditViewport);
  }

  function _renderEditChoices(items, dataAttr, activeValue) {
    return items.map(item => `<button type="button" class="chip edit-choice${item.value === activeValue ? ' chip--active' : ''}" ${dataAttr}="${ExpenseData.escapeHtml(item.value)}" aria-pressed="${item.value === activeValue}"><span class="edit-choice-check" aria-hidden="true">✓</span>${item.icon || ''}<span>${ExpenseData.escapeHtml(item.label)}</span></button>`).join('');
  }

  function _syncChoiceState(body, selector) {
    body.querySelectorAll(selector).forEach(button => {
      button.setAttribute('aria-pressed', String(button.classList.contains('chip--active')));
    });
  }

  function _focusWithoutScroll(element) {
    if (!element || !element.isConnected || typeof element.focus !== 'function') return;
    try { element.focus({ preventScroll: true }); } catch (_) { element.focus(); }
  }

  function hasUnsavedDraft() {
    if (_saving) return true;
    if (!_editingExpenseId || !_editingSnapshot) return false;
    const body = document.getElementById('overlay-edit-body');
    return Boolean(body && JSON.stringify(_readEditDraft(body, _editingSnapshot).draft) !== _baselineDraft);
  }

  function _announceDraftState() {
    window.dispatchEvent(new Event('expense-draft-change'));
  }

  /* -----------------------------------------------------------------
     底部编辑面板的打开 / 关闭（同时控制面板和遮罩）
     ----------------------------------------------------------------- */
  function _openEditSheet() {
    const sheet = document.getElementById('overlay-edit');
    const backdrop = document.getElementById('overlay-edit-backdrop');
    if (sheet) {
      sheet.classList.add('bottom-sheet--open');
      sheet.setAttribute('role', 'dialog');
      sheet.setAttribute('aria-modal', 'true');
      sheet.setAttribute('aria-label', '编辑消费记录');
    }
    if (backdrop) backdrop.classList.add('bottom-sheet-backdrop--open');
    ExpenseUi.lockOverlayScroll();
    _syncEditViewport();
    const body = document.getElementById('overlay-edit-body');
    if (body) body.scrollTop = 0;
    _focusWithoutScroll(document.getElementById('overlay-edit-back'));
  }

  function _closeEditSheet() {
    const sheet = document.getElementById('overlay-edit');
    const backdrop = document.getElementById('overlay-edit-backdrop');
    if (sheet) sheet.classList.remove('bottom-sheet--open');
    if (_viewportFrame) { cancelAnimationFrame(_viewportFrame); _viewportFrame = 0; }
    if (backdrop) backdrop.classList.remove('bottom-sheet-backdrop--open');
    ExpenseUi.unlockOverlayScroll();
    // 保存后的列表会重建 DOM，用稳定记录 ID 找回原焦点。
    if (_returnFocus && !_returnFocus.isConnected && _editingExpenseId) {
      _returnFocus = [...document.querySelectorAll('[data-id]')].find(element => element.dataset.id === _editingExpenseId && element.getClientRects().length);
    }
    _editingExpenseId = null;
    _editingSnapshot = null;
    _baselineDraft = '';
    _focusWithoutScroll(_returnFocus);
    _announceDraftState();
  }

  async function _requestClose() {
    if (_saving || _closing) return;
    if (!hasUnsavedDraft()) { _closeEditSheet(); return; }
    _closing = true;
    const previousFocus = document.activeElement;
    try {
      const discard = await ExpenseConfirm.open({
        title: '放弃尚未保存的修改？',
        message: '这笔记录的原内容仍然保留。',
        confirmText: '放弃修改',
        cancelText: '继续编辑',
      });
      if (discard) _closeEditSheet();
      else _focusWithoutScroll(previousFocus);
    } finally { _closing = false; }
  }

  function _showMutationFailure(result) {
    if (result.code === 'CONFLICT' || result.code === 'NOT_FOUND') {
      const status = document.getElementById('edit-conflict-status');
      const reload = document.getElementById('edit-reload-latest');
      if (status) {
        status.hidden = false;
        status.textContent = result.code === 'NOT_FOUND'
          ? '这笔记录已在另一页面删除。当前修改仍保留在此处，没有重新创建或覆盖记录。'
          : '这笔记录已在另一页面修改。当前草稿仍保留，未覆盖已保存内容；请核对后载入最新记录再编辑。';
        _focusWithoutScroll(status);
        const body = document.getElementById('overlay-edit-body');
        if (body) body.scrollTop = 0;
      }
      if (reload) reload.hidden = result.code === 'NOT_FOUND';
      ExpenseToast.show('记录已发生变化，本次操作未写入', 'warning', { duration: 6000 });
      return;
    }
    ExpenseUi.storageFailToast('操作未完成，原记录和当前草稿仍然保留');
  }

  async function _runMutation(action) {
    if (_saving) return null;
    _saving = true;
    _announceDraftState();
    const controls = [...document.querySelectorAll('#overlay-edit input, #overlay-edit select, #overlay-edit button')];
    const disabled = controls.map(control => control.disabled);
    controls.forEach(control => { control.disabled = true; });
    try { return await action(); }
    catch (error) {
      console.error('[Edit] 操作未完成:', error);
      return { ok: false, code: 'WRITE_FAILED' };
    } finally {
      _saving = false;
      controls.forEach((control, index) => { control.disabled = disabled[index]; });
      _announceDraftState();
    }
  }

  /** 绑定覆盖层静态按钮（返回/删除/遮罩，只绑一次；app init 时调用） */
  function init() {
    if (_initialized) return;
    _initialized = true;
    window.addEventListener('resize', _queueViewportSync);
    if (window.visualViewport) {
      window.visualViewport.addEventListener('resize', _queueViewportSync);
      window.visualViewport.addEventListener('scroll', _queueViewportSync);
    }
    // 三种关闭入口共用草稿保护；关闭覆盖层不再触发切页归零。
    ExpenseUi.bindOrWarn('overlay-edit-back', _requestClose);
    const back = document.getElementById('overlay-edit-back');
    if (back) back.setAttribute('aria-label', '关闭编辑');

    // 删除按钮（只绑定一次，通过 _editingExpenseId 获取当前记录）
    // 确认改用自绘弹窗：iOS 独立 PWA 下 window.confirm 被禁用、静默返回 false
    ExpenseUi.bindOrWarn('overlay-edit-delete', () => {
      if (!_editingExpenseId) return;
      ExpenseConfirm.confirmThen({
        title: '删除这条记录？',
        message: '此操作不可恢复。',
        confirmText: '删除',
        danger: true,
      }, async () => {
        const result = await _runMutation(() => ExpenseDB.deleteExpenseIfUnchanged(_editingExpenseId, _editingSnapshot));
        if (!result) return;
        if (!result.ok) {
          _showMutationFailure(result);
          return;
        }
        ExpenseHabitPredictor.invalidate();
        ExpenseToast.show('已删除', 'success');
        ExpenseUi.refreshAllDataViews();
        _closeEditSheet();
        _editingExpenseId = null;
      });
    });

    // 点击背景遮罩关闭
    const editBackdrop = document.getElementById('overlay-edit-backdrop');
    if (editBackdrop) {
      editBackdrop.addEventListener('click', _requestClose);
    }
    document.addEventListener('keydown', event => {
      if (!_editingExpenseId || document.querySelector('#confirm-dialog.confirm-dialog--open')) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        _requestClose();
      } else if (event.key === 'Tab') {
        const controls = [...document.querySelectorAll('#overlay-edit button, #overlay-edit input, #overlay-edit select, #overlay-edit [tabindex="0"]')]
          .filter(element => !element.disabled && !element.hidden && element.getClientRects().length > 0);
        const first = controls[0], last = controls[controls.length - 1];
        if (event.shiftKey && (document.activeElement === first || !document.getElementById('overlay-edit').contains(document.activeElement))) {
          event.preventDefault(); _focusWithoutScroll(last);
        } else if (!event.shiftKey && (document.activeElement === last || !document.getElementById('overlay-edit').contains(document.activeElement))) {
          event.preventDefault(); _focusWithoutScroll(first);
        }
      }
    });
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

  async function _persistEdit(body, expense, expenseId, expectedCents) {
    const validation = _validateEditDraft(body, expense);
    if (!validation.ok) {
      _showEditValidationError(validation);
      return;
    }
    if (expectedCents != null && validation.cents !== expectedCents) {
      ExpenseToast.show('金额已变更，请重新确认', 'warning');
      return;
    }
    const result = await _runMutation(() => ExpenseDB.updateExpenseIfUnchanged(expenseId, validation.value, expense));
    if (!result) return;
    if (!result.ok) {
      _showMutationFailure(result);
      return;
    }
    ExpenseHabitPredictor.invalidate();
    ExpenseToast.show('已更新', 'success');
    ExpenseUi.refreshAllDataViews();
    _closeEditSheet();
    _editingExpenseId = null;
  }

  function open(expenseId) {
    const overlay = document.getElementById('overlay-edit');
    const body = document.getElementById('overlay-edit-body');
    if (!overlay || !body) return;

    const stored = ExpenseDB.getExpense(expenseId);
    if (!stored) return;
    // 不持有存储只读缓存的共享对象，比较完整的打开时快照。
    const expense = JSON.parse(JSON.stringify(stored));
    _returnFocus = document.activeElement;
    _editingSnapshot = expense;

    // 存储当前编辑的记录 ID（供删除按钮使用，只绑定一次）
    _editingExpenseId = expenseId;

    body.innerHTML = `
      <div class="edit-sheet-fields">
        <p id="edit-conflict-status" role="status" tabindex="-1" hidden></p>
        <button id="edit-reload-latest" type="button" class="btn btn--ghost" hidden>载入最新记录</button>
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
          <div class="edit-choice-group" role="group" aria-label="支付方式">
            ${_renderEditChoices(ExpenseData.PAYMENT_METHODS, 'data-edit-pm', expense.paymentMethod)}
          </div>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M13.744 17.736a6 6 0 1 1-7.48-7.48M15 6h1v4"/><path d="m6.134 14.768l.866-.5l2 3.464"/><circle cx="16" cy="8" r="6"/></g></svg> 价值评定</label>
          <div class="edit-choice-group" role="group" aria-label="价值评定">
            ${_renderEditChoices(ExpenseData.NECESSITY_OPTIONS, 'data-edit-necessity', expense.necessity)}
          </div>
        </div>
        <div>
          <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8"/></g></svg> 备注</label>
          <input type="text" class="input" id="edit-note" value="${ExpenseData.escapeHtml(expense.note || '')}" maxlength="100">
        </div>
        <div class="edit-datetime-row">
          <div style="flex:1">
            <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M8 2v3m8-3v3"/><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M3 9h18"/></g></svg> 日期</label>
            <input type="date" class="input" id="edit-date" value="${ExpenseData.escapeHtml(expense.date || '')}">
          </div>
          <div style="flex:1">
            <label style="font-weight:600;display:block;margin-bottom:6px"><svg viewBox="0 0 24 24" class="field-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/></g></svg> 时间</label>
            <input type="time" class="input" id="edit-time" value="${ExpenseData.escapeHtml(expense.time || '')}">
          </div>
        </div>
      </div>
    `;
    _createFooter(overlay);

    // 保持现有视觉排版，同时补全读屏可读的字段名称。
    ['amount', 'category', 'location', 'note', 'date', 'time'].forEach(field => {
      const input = document.getElementById('edit-' + field);
      const label = input && input.previousElementSibling;
      if (label && label.tagName === 'LABEL') label.htmlFor = input.id;
    });
    body.querySelectorAll('button').forEach(button => { button.type = 'button'; });
    body.addEventListener('input', _announceDraftState);
    body.addEventListener('change', _announceDraftState);
    document.getElementById('edit-reload-latest').addEventListener('click', () => {
      ExpenseConfirm.confirmThen({
        title: '载入最新记录？',
        message: '当前尚未保存的修改将被放弃，换成另一页面已保存的内容。',
        confirmText: '载入最新记录',
        cancelText: '继续保留草稿',
      }, () => {
        const id = _editingExpenseId;
        if (!ExpenseDB.getExpense(id)) { _showMutationFailure({ code: 'NOT_FOUND' }); return; }
        const returnFocus = _returnFocus;
        _closeEditSheet();
        open(id);
        _returnFocus = returnFocus;
      });
    });

    // 支付方式切换
    body.querySelectorAll('[data-edit-pm]').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('chip--active')) {
          btn.classList.remove('chip--active');
        } else {
          body.querySelector('[data-edit-pm].chip--active')?.classList.remove('chip--active');
          btn.classList.add('chip--active');
        }
        _syncChoiceState(body, '[data-edit-pm]');
        _announceDraftState();
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
        _syncChoiceState(body, '[data-edit-necessity]');
        _announceDraftState();
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
          return _persistEdit(body, expense, expenseId, confirmedCents);
        });
        return;
      }
      return _persistEdit(body, expense, expenseId, validation.cents);
    });

    _baselineDraft = JSON.stringify(_readEditDraft(body, expense).draft);
    _openEditSheet();
  }

  return { init, open, hasUnsavedDraft };
})();
