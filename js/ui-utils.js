/* ================================================================
   消费轨迹系统 — ui-utils.js
   ExpenseUi 命名空间：共享 UI 工具
   从主控制器拆出（审计高危 No.2）：存储失败文案、芯片组模板、全量数据
   刷新、覆盖层滚动锁、安全事件绑定——都是被多个模块复用的模板，
   集中于此避免"改样式要改 N 遍"的重复定义。
   ================================================================ */

const ExpenseUi = (() => {
  'use strict';

  /** 存储读写失败的统一警告文案：head 描述具体操作，尾句统一提醒不要清理浏览器数据 */
  function storageFailText(head) {
    return `${head}，请勿清理浏览器数据，重新打开后重试`;
  }

  /** 存储读写失败的统一警告 toast（6 秒长驻，给用户留出备份时间） */
  function storageFailToast(head) {
    ExpenseToast.show(storageFailText(head), 'warning', { duration: 6000 });
  }

  /** 渲染一组单选 chip 按钮模板。
   *  items: [{ value, label, icon?, color }]；options: { activeValue, dataAttr, extraClass }
   *  新增页与编辑覆盖层共用，差异仅在 data 属性名（data-pm / data-edit-pm 等）。 */
  function renderChipGroup(items, options) {
    return items.map(item => {
      const isActive = options.activeValue === item.value;
      const rgb = ExpenseData.hexToRgb(item.color) || '150,150,150';  // 非法色值兜底中性灰
      // 未选中：淡品牌色底 + 品牌色字；选中：实心品牌色 + 白字
      const bg   = isActive ? item.color : `rgba(${rgb},0.1)`;
      const bd   = isActive ? item.color : `rgba(${rgb},0.3)`;
      const text = isActive ? '#fff' : item.color;
      return `<button class="chip ${options.extraClass} ${isActive ? 'chip--active' : ''}" ${options.dataAttr}="${item.value}" type="button" style="background:${bg};border-color:${bd};color:${text}">${item.icon ? item.icon + ' ' : ''}${item.label}</button>`;
    }).join('');
  }

  /** 数据变更后统一刷新首页/账单/统计三个视图（导入、删除、编辑、撤销共用） */
  function refreshAllDataViews() {
    ExpenseHome.render();
    if (typeof ExpenseList !== 'undefined') ExpenseList.render();
    if (typeof ExpenseStats !== 'undefined') ExpenseStats.render();
  }

  /* -----------------------------------------------------------------
     覆盖层滚动锁（预算/分类管理/编辑覆盖层共用）
     ----------------------------------------------------------------- */
  let _overlayScrollYBefore = 0;

  /** 打开全屏覆盖层：锁住背景滚动并记录原位置（防移动端滚动穿透） */
  function lockOverlayScroll() {
    _overlayScrollYBefore = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.style.top = `-${_overlayScrollYBefore}px`;
    document.body.classList.add('page-overlay-open');
    document.documentElement.classList.add('page-overlay-open');
  }

  /** 关闭全屏覆盖层：解锁滚动，精确回到打开前的位置 */
  function unlockOverlayScroll() {
    document.body.style.top = '';
    document.body.classList.remove('page-overlay-open');
    document.documentElement.classList.remove('page-overlay-open');
    window.scrollTo(0, _overlayScrollYBefore);
  }

  /** 绑定事件前判空：HTML 模板漂移导致 id 缺失时告警而非抛 TypeError 中断后续初始化 */
  function bindOrWarn(id, handler) {
    const el = document.getElementById(id);
    if (!el) {
      console.error(`[ExpenseUi] 绑定事件失败：找不到 #${id}，请检查 HTML 模板`);
      return;
    }
    el.addEventListener('click', handler);
  }

  return {
    storageFailText,
    storageFailToast,
    renderChipGroup,
    refreshAllDataViews,
    lockOverlayScroll,
    unlockOverlayScroll,
    bindOrWarn,
  };
})();
