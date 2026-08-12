/* ================================================================
   消费轨迹系统 — toast.js
   ExpenseToast 命名空间：轻提示条
   从主控制器拆出（审计高危 No.2）：Toast 与业务无关，任何模块均可直接调用，
   避免"改个提示样式还要在 2000 行控制器里定位"
   ================================================================ */

const ExpenseToast = (() => {
  'use strict';

  /**
   * 展示一条轻提示。
   * options: { duration(毫秒，默认 1500), actionLabel, onAction }
   * 带 actionLabel + onAction 时渲染操作按钮（如"撤销"），点击执行并移除提示。
   */
  function show(message, type, options = {}) {
    const container = document.getElementById('toast-container');
    if (!container) return;

    const el = document.createElement('div');
    el.className = `toast toast--${type || ''}`;
    if (options.actionLabel && typeof options.onAction === 'function') el.classList.add('toast--actionable');
    const copy = document.createElement('span');
    copy.className = 'toast__copy';
    copy.textContent = message;
    el.appendChild(copy);

    if (options.actionLabel && typeof options.onAction === 'function') {
      const action = document.createElement('button');
      action.className = 'toast__action';
      action.type = 'button';
      action.textContent = options.actionLabel;
      el.appendChild(action);
      action.addEventListener('click', () => {
        removeEl();
        options.onAction();
      }, { once: true });
    }

    container.appendChild(el);

    const removeEl = () => {
      if (el.parentNode) el.parentNode.removeChild(el);
    };

    // 默认 1.5 秒；带撤销的成功反馈延长，给用户稳定的纠错窗口。
    setTimeout(() => {
      if (!el.parentNode) return;
      el.classList.add('toast--removing');

      // 动画结束后从 DOM 移除
      el.addEventListener('animationend', removeEl, { once: true });

      // 兜底：0.35s 后强制移除（防止 animationend 不触发导致残留）
      setTimeout(removeEl, 350);
    }, options.duration || 1500);
  }

  return { show };
})();
