/* ================================================================
   消费轨迹系统 — budget-overlay.js
   ExpenseBudgetOverlay 命名空间：预算设置覆盖层（月度总预算 + 分类预算）
   从主控制器拆出（审计高危 No.2）：完整的页面级功能，与记账表单编排无关。
   数据依赖：ExpenseDB / ExpenseData / ExpenseCategories / ExpenseHome
   UI 依赖：ExpenseToast / ExpenseConfirm / ExpenseUi（滚动锁、存储失败文案）
   ================================================================ */

const ExpenseBudgetOverlay = (() => {
  'use strict';

  /** 绑定覆盖层静态按钮（返回键在 HTML 模板中，只绑一次） */
  function init() {
    ExpenseUi.bindOrWarn('overlay-budget-back', () => {
      ExpenseUi.unlockOverlayScroll();
      document.getElementById('overlay-budget').classList.remove('page-overlay--open');
    });
  }

  function open() {
    const overlay = document.getElementById('overlay-budget');
    const body = document.getElementById('overlay-budget-body');
    if (!overlay || !body) return;

    const budget = ExpenseDB.getBudget();
    const monthTotal = ExpenseDB.getMonthTotal();
    const monthlyBudget = budget.monthlyTotal || 0;

    body.innerHTML = `
      <div style="margin-bottom:24px">
        <label style="font-weight:600;display:block;margin-bottom:8px">月度总预算</label>
        <input type="number" class="input" id="budget-input-total" value="${ExpenseData.escapeHtml(monthlyBudget || '')}"
               placeholder="0 = 不限制" min="0" max="99999999.99" step="0.01" inputmode="decimal"
               style="font-size:var(--font-size-xl);text-align:center">
        ${monthlyBudget > 0 ? `<p style="margin-top:8px;font-size:13px;color:var(--color-text-secondary);text-align:center">已用 ¥${monthTotal.toFixed(0)} · 剩余 ${Math.max(0, monthlyBudget - monthTotal).toFixed(0)}</p>` : ''}
      </div>

      <div style="margin-bottom:24px">
        <label style="font-weight:600;display:block;margin-bottom:8px">分类预算（一级分类，空白 = 不限）</label>
        <div style="display:flex;flex-direction:column;gap:12px">
          ${ExpenseDB.getParentCategories().map(cat => {
            const catBudget = (budget.categories && budget.categories[cat.id]) || '';
            const spent = ExpenseDB.getCategorySpent(cat.id);
            return `
              <div style="display:flex;align-items:center;gap:8px">
                <span style="width:32px;display:inline-flex;align-items:center;justify-content:center">${ExpenseCategories.getIconMarkup(cat)}</span>
                <span style="flex:1;font-size:14px">${ExpenseData.escapeHtml(cat.name)}</span>
                <div style="display:flex;align-items:center;gap:4px">
                  <span style="font-size:14px">¥</span>
                  <input type="number" class="input cat-budget-input" data-cat-id="${ExpenseData.escapeHtml(cat.id)}"
                         value="${ExpenseData.escapeHtml(catBudget)}" placeholder="不限" min="0" max="99999999.99" step="0.01" inputmode="decimal"
                         style="width:100px;text-align:right">
                </div>
                ${catBudget > 0 ? `<span style="font-size:11px;color:var(--color-text-tertiary);width:60px;text-align:right">${spent > catBudget ? '<svg viewBox="0 0 24 24" class="inline-icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg>超支' : Math.round(spent/catBudget*100)+'%'}</span>` : '<span style="width:60px"></span>'}
              </div>`;
          }).join('')}
        </div>
      </div>

      <button class="btn btn--primary btn--block" id="budget-btn-save">保存</button>
      <button class="btn btn--ghost btn--block" id="budget-btn-reset" style="margin-top:8px;color:var(--color-danger)">重置全部预算</button>
    `;

    // 绑定保存
    document.getElementById('budget-btn-save').addEventListener('click', () => {
      const totalInput = document.getElementById('budget-input-total');
      const draft = { monthlyTotal: totalInput.value, categories: {} };
      body.querySelectorAll('.cat-budget-input').forEach(input => {
        draft.categories[input.dataset.catId] = input.value;
      });
      const validation = ExpenseDB.validateBudgetDraft(draft);
      if (!validation.ok) {
        const field = validation.error && validation.error.field;
        const categoryMatch = field && field.match(/^categories\.(.+)$/);
        const invalidInput = categoryMatch
          ? [...body.querySelectorAll('.cat-budget-input')].find(input => input.dataset.catId === categoryMatch[1])
          : totalInput;
        if (invalidInput) invalidInput.focus();
        let message = validation.error.message;
        if (categoryMatch) {
          const category = ExpenseDB.getCategory(categoryMatch[1]);
          if (category) message = message.replace(`「${category.id}」`, `「${category.name}」`);
        }
        ExpenseToast.show(message, 'warning', { duration: 5000 });
        return;
      }
      if (!ExpenseDB.saveBudget(validation.value)) {
        ExpenseUi.storageFailToast('预算保存失败，操作已停止且原数据未覆盖');
        return;
      }
      ExpenseToast.show('预算已保存', 'success');
      ExpenseUi.unlockOverlayScroll();
      overlay.classList.remove('page-overlay--open');
      ExpenseHome.render();
    });

    // 重置
    document.getElementById('budget-btn-reset').addEventListener('click', () => {
      ExpenseConfirm.confirmThen({
        title: '清空全部预算设置？',
        message: '各分类预算将恢复为默认值。',
        confirmText: '清空',
        danger: true,
      }, () => {
        if (!ExpenseDB.saveBudget(ExpenseData.DEFAULT_BUDGET, { mode: 'reset' })) {
          ExpenseUi.storageFailToast('预算重置失败，操作已停止且原数据未覆盖');
          return;
        }
        ExpenseToast.show('预算已重置', 'success');
        ExpenseUi.unlockOverlayScroll();
        overlay.classList.remove('page-overlay--open');
        ExpenseHome.render();
      });
    });

    overlay.classList.add('page-overlay--open');
    ExpenseUi.lockOverlayScroll();
  }

  return { init, open };
})();
