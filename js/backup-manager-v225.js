/* ================================================================
   消费轨迹系统 — backup-manager.js
   ExpenseBackupManager 命名空间：数据备份（导出/导入）+ 备份时间徽章
   从主控制器拆出（审计高危 No.2）：完整页面级功能，与记账表单编排无关。
   数据安全红线相关：导入前 ExpenseDB.importAll 自带备份+回滚+严格校验，
   本模块只做 UI 流程编排（确认 → 调存储层 → 刷新视图），不触碰存储内部。
   与主控制器的耦合点通过 init(deps) 显式注入：
     deps.getCurrentView           — 时钟判断当前是否在首页
     deps.refreshFormAfterImport   — 导入成功后刷新记账表单（分类入口/商家建议/保存状态）
   ================================================================ */

const ExpenseBackupManager = (() => {
  'use strict';

  let _deps = null;

  /** 绑定首页备份按钮 + 启动备份徽章时钟（app init 时调用一次） */
  function init(deps) {
    _deps = deps || {};
    _bindExport();
    _bindImport();

    // 更新备份时间徽章
    _updateBackupBadge();

    // 时钟更新（每分钟刷新首页日期）
    setInterval(() => {
      if (_deps.getCurrentView && _deps.getCurrentView() === 'home') {
        const now = new Date();
        const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
        const el = document.getElementById('home-date');
        if (el) el.textContent = `${now.getMonth() + 1}月${now.getDate()}日 周${weekdays[now.getDay()]}`;
        _updateBackupBadge();
      }
    }, 60000);
  }

  /** 数据备份：导出（优先用系统分享面板，不支持时下载文件） */
  function _bindExport() {
    const exportBtn = document.getElementById('home-export-btn');
    if (!exportBtn) return;
    exportBtn.addEventListener('click', async () => {
      let data = ExpenseDB.exportAll();
      let recoveryOnly = false;
      let rawOnly = false;
      if (!data) {
        data = ExpenseDB.exportRecoveryCopy();
        if (data) {
          recoveryOnly = true;
        } else {
          // 核心数据连 JSON 解析都过不去：按原始字符串导出，保全所有字节
          data = ExpenseDB.exportRawRecoveryCopy();
          if (!data) {
            ExpenseUi.storageFailToast('无法完整读取本地账本，未生成备份且原数据未改动');
            return;
          }
          rawOnly = true;
        }
      }
      const json = JSON.stringify(data, null, 2);
      const now = new Date();
      const ts = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}`;
      const filename = rawOnly
        ? `expense-tracker-raw-${ts}.json`
        : recoveryOnly
          ? `expense-tracker-recovery-${ts}.json`
          : `expense-tracker-backup-${ts}.json`;

      // 手机端：使用系统分享面板（可分享到微信/邮件/备忘录等）
      if (navigator.share && navigator.canShare) {
        const blob = new Blob([json], { type: 'application/json' });
        const file = new File([blob], filename, { type: 'application/json' });
        const shareData = {
          title: rawOnly ? '消费轨迹原始数据副本' : (recoveryOnly ? '消费轨迹只读救援副本' : '消费轨迹备份'),
          files: [file],
        };
        if (navigator.canShare(shareData)) {
          try {
            await navigator.share(shareData);
            if (rawOnly) {
              ExpenseToast.show('已分享原始数据副本（未解析 JSON）。此文件仅用于人工修复参考，不能直接恢复', 'warning', { duration: 7000 });
              return;
            }
            if (recoveryOnly) {
              ExpenseToast.show(`已分享只读救援副本（${data.expenses.length} 条记录）。此文件不能直接恢复，请妥善保存`, 'warning', { duration: 7000 });
              return;
            }
            const backupTimeSaved = ExpenseDB.recordBackupTime();
            _updateBackupBadge();
            ExpenseToast.show(
              backupTimeSaved
                ? `已分享 ${data.expenses.length} 条记录`
                : `已分享 ${data.expenses.length} 条记录，但无法记录备份时间`,
              backupTimeSaved ? 'success' : 'warning',
              backupTimeSaved ? {} : { duration: 5000 },
            );
            return;
          } catch (e) {
            // 用户取消分享，不提示错误，降级到下载
            if (e.name === 'AbortError') return;
          }
        }
      }

      // 降级方案：桌面端下载文件
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      // 延迟回收 blob URL：立即 revoke 时部分浏览器（旧 Safari）下载任务尚未建立，会导致下载失败
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      if (rawOnly) {
        ExpenseToast.show('已导出原始数据副本（未解析 JSON）。此文件仅用于人工修复参考，不能直接恢复', 'warning', { duration: 7000 });
        return;
      }
      if (recoveryOnly) {
        ExpenseToast.show(`已导出只读救援副本（${data.expenses.length} 条记录）。此文件不能直接恢复，请妥善保存`, 'warning', { duration: 7000 });
        return;
      }
      const backupTimeSaved = ExpenseDB.recordBackupTime();
      _updateBackupBadge();
      ExpenseToast.show(
        backupTimeSaved
          ? `已导出 ${data.expenses.length} 条记录`
          : `已导出 ${data.expenses.length} 条记录，但无法记录备份时间`,
        backupTimeSaved ? 'success' : 'warning',
        backupTimeSaved ? {} : { duration: 5000 },
      );
    });
  }

  /** 文件和粘贴共用校验、确认与恢复链路。读取文件绝不提前写入。 */
  function _bindImport() {
    const importBtn = document.getElementById('home-import-btn');
    const area = document.getElementById('home-import-area');
    const textarea = document.getElementById('home-import-textarea');
    const confirm = document.getElementById('home-import-confirm');
    const cancel = document.getElementById('home-import-cancel');
    const fileBtn = document.getElementById('home-import-file-btn');
    const input = document.getElementById('home-import-file');
    const status = document.getElementById('home-import-status');
    if (!(importBtn && area && textarea && confirm && cancel && fileBtn && input && status)) return;
    let readId = 0;
    function resetRead() {
      readId++;
      fileBtn.disabled = false;
      confirm.disabled = false;
      input.value = '';
      status.textContent = '';
    }
    importBtn.addEventListener('click', () => {
      area.style.display = 'block';
      fileBtn.focus();
    });
    cancel.addEventListener('click', () => {
      resetRead();
      area.style.display = 'none';
      textarea.value = '';
      importBtn.focus();
    });
    fileBtn.addEventListener('click', () => {
      input.value = '';
      input.click();
    });
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return;
      const currentRead = ++readId;
      fileBtn.disabled = true;
      confirm.disabled = true;
      status.textContent = '正在读取 ' + file.name + '…';
      try {
        const raw = await file.text();
        if (currentRead !== readId) return;
        status.textContent = '已读取：' + file.name;
        _confirmImport(raw, status);
      } catch (_) {
        if (currentRead === readId) status.textContent = '文件读取失败，请重新选择，或使用粘贴内容恢复。';
      } finally {
        if (currentRead === readId) {
          fileBtn.disabled = false;
          confirm.disabled = false;
        }
      }
    });
    confirm.addEventListener('click', () => _confirmImport(textarea.value, status));
  }

  function _confirmImport(raw, status) {
    raw = raw.replace(/^\uFEFF/, '').trim();
    if (!raw) { status.textContent = '备份内容为空，请选择文件或粘贴内容。'; return; }
    let data;
    try { data = JSON.parse(raw); }
    catch (_) { status.textContent = '内容格式错误，不是有效的 JSON 备份。'; return; }
    const validation = ExpenseDB.validateImport(data);
    if (!validation.success) { status.textContent = validation.message; return; }
    const msg = '即将恢复备份（' + data.expenses.length + ' 条记录，' + data.categories.length +
      ' 个分类）。当前数据将被覆盖，恢复前会先自动保存一份当前数据备份。';
    ExpenseConfirm.confirmThen({
      title: '恢复备份？', message: msg, confirmText: '恢复', danger: true,
    }, () => _performImport(data));
  }

  /**
   * 执行导入（可选 forceRecovery），成功后统一刷新全部数据视图。
   * 抽自导入按钮事件：正常导入与强制恢复共用同一条成功后的刷新链路。
   */
  function _performImport(data, options) {
    const result = ExpenseDB.importAll(data, options);
    if (!result.success && result.needsForceRecovery && !(options && options.forceRecovery)) {
      ExpenseConfirm.confirmThen({
        title: '当前数据无法读取',
        message: '本地账本无法安全读取（可能已损坏）。是否强制用这份备份覆盖恢复？覆盖前系统会把当前原始数据保存到浏览器逃生区。',
        confirmText: '强制恢复', danger: true,
      }, () => _performImport(data, { forceRecovery: true }));
      return;
    }
    if (!result.success) {
      ExpenseToast.show(result.message, 'warning', { duration: 6000 });
      return;
    }
    ExpenseHabitPredictor.invalidate();  // 数据整体被替换，缓存作废
    // 记账表单可能引用已消失的分类/商家建议：由主控制器统一刷新
    if (_deps.refreshFormAfterImport) _deps.refreshFormAfterImport();
    ExpenseToast.show(result.warning || result.message, result.warning ? 'warning' : 'success', result.warning ? { duration: 6000 } : {});
    _updateBackupBadge();
    const importArea = document.getElementById('home-import-area');
    const importTextarea = document.getElementById('home-import-textarea');
    if (importArea) importArea.style.display = 'none';
    if (importTextarea) importTextarea.value = '';
    const status = document.getElementById('home-import-status');
    if (status) status.textContent = '';
    const input = document.getElementById('home-import-file');
    if (input) input.value = '';
    ExpenseUi.refreshAllDataViews();
  }

  /** 更新首页备份时间徽章（未备份 / 上次备份日期 / 超过7天提醒） */
  function _updateBackupBadge() {
    const badge = document.getElementById('home-backup-badge');
    if (!badge) return;
    const last = ExpenseDB.getLastBackupTime();
    if (!last) {
      badge.innerHTML = '<svg viewBox="0 0 24 24" class="inline-icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg> 尚未备份';
      badge.style.color = 'var(--color-warning)';
      return;
    }
    // 防御：lastBackupTime 损坏为非法值时会算出 NaN（NaN > 7 为 false，会误入"已备份"分支）
    if (!Number.isFinite(new Date(last).getTime())) {
      badge.innerHTML = '<svg viewBox="0 0 24 24" class="inline-icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg> 尚未备份';
      badge.style.color = 'var(--color-warning)';
      return;
    }
    const days = Math.floor((Date.now() - new Date(last).getTime()) / 86400000);
    if (days > 7) {
      badge.innerHTML = '<svg viewBox="0 0 24 24" class="inline-icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg> ' + days + ' 天前备份';
      badge.style.color = 'var(--color-warning)';
    } else {
      const d = new Date(last);
      badge.textContent = `✓ ${d.getMonth()+1}月${d.getDate()}日已备份`;
      badge.style.color = 'var(--color-success)';
    }
  }

  return { init };
})();
