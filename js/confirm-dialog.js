/* ================================================================
   消费轨迹系统 — confirm-dialog.js
   ExpenseConfirm 命名空间：应用内确认弹窗（替代 window.confirm）
   从主控制器拆出（审计高危 No.2）：弹窗属通用 UI 能力，与业务无关。
   背景：iOS 独立 PWA（添加到主屏幕）下 alert/confirm/prompt 被系统
   禁用并静默返回 false——删除记录与大金额确认在这些设备上点击无反应。
   自绘弹窗跨环境行为一致；单例 DOM 只创建一次，事件只绑定一次。
   ================================================================ */

const ExpenseConfirm = (() => {
  'use strict';

  let _confirmResolver = null;  // 当前弹窗的 resolve（同一时刻只允许一个确认弹窗）

  function open(options) {
    const {
      title = '请确认',
      message = '',
      confirmText = '确定',
      cancelText = '取消',
      danger = false,
      notice = false,
    } = options || {};

    // 单例：首次调用创建 DOM 并绑定事件，后续只更新文案
    let overlay = document.getElementById('confirm-dialog');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirm-dialog';
      overlay.className = 'confirm-dialog';
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.innerHTML = `
        <div class="confirm-dialog__backdrop" data-confirm-cancel></div>
        <div class="confirm-dialog__card">
          <p class="confirm-dialog__title"></p>
          <p class="confirm-dialog__message"></p>
          <div class="confirm-dialog__actions">
            <button type="button" class="btn confirm-dialog__cancel" data-confirm-cancel>取消</button>
            <button type="button" class="btn confirm-dialog__ok" data-confirm-ok>确定</button>
          </div>
        </div>
      `;
      overlay.querySelector('[data-confirm-ok]').addEventListener('click', () => _resolveConfirm(true));
      overlay.querySelectorAll('[data-confirm-cancel]').forEach(el => el.addEventListener('click', () => _resolveConfirm(false)));
      document.body.appendChild(overlay);
    }

    overlay.querySelector('.confirm-dialog__title').textContent = title;
    overlay.querySelector('.confirm-dialog__message').textContent = message;
    const cancelBtn = overlay.querySelector('.confirm-dialog__cancel');
    cancelBtn.textContent = cancelText;
    cancelBtn.hidden = notice;
    cancelBtn.style.display = notice ? 'none' : '';
    const okBtn = overlay.querySelector('.confirm-dialog__ok');
    okBtn.textContent = confirmText;
    // 危险操作（如删除）用红色按钮，普通确认用主色按钮
    okBtn.classList.toggle('btn--danger', danger);
    okBtn.classList.toggle('btn--primary', !danger);

    overlay.classList.add('confirm-dialog--open');
    try { okBtn.focus({ preventScroll: true }); } catch (_) { okBtn.focus(); }
    // 单例守卫：若上一个弹窗尚未 resolve（正常 UI 流程难以触发，属潜伏陷阱），
    // 先以 false 关闭旧 Promise，避免其永久悬挂、调用方 then/catch 永不执行。
    if (_confirmResolver) _resolveConfirm(false);
    return new Promise(resolve => { _confirmResolver = resolve; });
  }

  /** 关闭确认弹窗并返回用户选择（true=确认，false=取消/点遮罩） */
  function _resolveConfirm(result) {
    const overlay = document.getElementById('confirm-dialog');
    if (overlay) overlay.classList.remove('confirm-dialog--open');
    if (_confirmResolver) {
      const resolve = _confirmResolver;
      _confirmResolver = null;
      resolve(result);
    }
  }

  /**
   * 统一确认流程包装：弹出确认框 → 用户确认后执行 handler。
   * 统一兜住 handler 抛出的异常（此前各调用点裸 .then() 没有 .catch，
   * 一旦 ExpenseDB 写入抛错会变成未处理的 Promise rejection，用户无感知）。
   */
  function confirmThen(options, handler) {
    return open(options).then(ok => {
      if (!ok) return;
      return handler();
    }).catch(err => {
      console.error('[Confirm] 确认操作执行失败:', err);
      ExpenseToast.show('操作未完成，请重试', 'warning');
    });
  }

  return { open, confirmThen };
})();
