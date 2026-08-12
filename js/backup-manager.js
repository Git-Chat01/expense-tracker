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

  /** 数据备份：导入（粘贴 JSON 文本） */
  function _bindImport() {
    const importBtn = document.getElementById('home-import-btn');
    const importArea = document.getElementById('home-import-area');
    const importTextarea = document.getElementById('home-import-textarea');
    const importConfirm = document.getElementById('home-import-confirm');
    const importCancel = document.getElementById('home-import-cancel');
    if (!(importBtn && importArea && importTextarea && importConfirm && importCancel)) return;

    importBtn.addEventListener('click', () => {
      importArea.style.display = 'block';
      importTextarea.focus();
    });
    importCancel.addEventListener('click', () => {
      importArea.style.display = 'none';
      importTextarea.value = '';
    });
    importConfirm.addEventListener('click', () => {
      const raw = importTextarea.value.trim();
      if (!raw) { ExpenseToast.show('请粘贴备份内容', 'warning'); return; }
      let data;
      try {
        data = JSON.parse(raw);
      } catch (e) {
        ExpenseToast.show('内容格式错误，不是有效的 JSON', 'warning');
        return;
      }
      if (!Array.isArray(data.expenses) || !Array.isArray(data.categories)) {
        ExpenseToast.show('无效的备份文件：缺少数据字段', 'warning');
        return;
      }
      const msg = `即将恢复备份（${data.expenses.length} 条记录，${data.categories.length} 个分类）。当前数据将被覆盖，系统已自动留一份恢复前备份。`;
      ExpenseConfirm.confirmThen({
        title: '恢复备份？',
        message: msg,
        confirmText: '恢复',
        danger: true,
      }, () => {
        const result = ExpenseDB.importAll(data);
        if (!result.success && result.needsForceRecovery) {
          // 核心数据损坏无法读取：提供强制恢复通道（二次确认，覆盖前自动逃生备份）
          ExpenseConfirm.confirmThen({
            title: '当前数据无法读取',
            message: '本地账本无法安全读取（可能已损坏）。是否强制用这份备份覆盖恢复？覆盖前系统会把当前原始数据保存到浏览器逃生区。',
            confirmText: '强制恢复',
            danger: true,
          }, () => {
            _performImport(data, { forceRecovery: true });
          });
          return;
        }
        _performImport(data);
      });
    });
  }

  /**
   * 执行导入（可选 forceRecovery），成功后统一刷新全部数据视图。
   * 抽自导入按钮事件：正常导入与强制恢复共用同一条成功后的刷新链路。
   */
  function _performImport(data, options) {
    const result = ExpenseDB.importAll(data, options);
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
