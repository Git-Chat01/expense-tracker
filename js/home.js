/* ================================================================
   消费轨迹系统 — home.js
   ExpenseHome 命名空间：首页渲染逻辑
   今日消费 / 昨日对比 / 本月消费 / 上月对比 / 预算提醒 / 智能提醒 / 最近记录
   ================================================================ */

const ExpenseHome = (() => {
  'use strict';

  /* -----------------------------------------------------------------
     DOM 引用缓存
     ----------------------------------------------------------------- */
  let _$date, _$todayAmount, _$todayCount, _$todayDiff;
  let _$monthAmount, _$monthCount, _$monthDiff;
  let _$alerts, _$recent, _$viewAllBtn;
  let _$budgetAlert, _$budgetAlertStatus, _$budgetAlertPct, _$budgetAlertBar, _$budgetAlertFill;
  let _$budgetAlertSpent, _$budgetAlertDaily, _$budgetAlertRemaining, _$budgetAlertSummaryTotal;

  /**
   * 初始化 DOM 引用（在 render 前调用一次）
   */
  function _cacheDom() {
    _$date           = document.getElementById('home-date');
    _$todayAmount    = document.getElementById('home-today-amount');
    _$todayCount     = document.getElementById('home-today-count');
    _$todayDiff      = document.getElementById('home-today-diff');
    _$monthAmount    = document.getElementById('home-month-amount');
    _$monthCount     = document.getElementById('home-month-count');
    _$monthDiff      = document.getElementById('home-month-diff');
    _$alerts         = document.getElementById('home-alerts');
    _$recent         = document.getElementById('home-recent');
    _$viewAllBtn     = document.getElementById('home-view-all');
    // 预算提醒
    _$budgetAlert    = document.getElementById('home-budget-alert');
    _$budgetAlertStatus=document.getElementById('home-budget-alert-status');
    _$budgetAlertPct = document.getElementById('home-budget-alert-pct');
    _$budgetAlertBar = document.getElementById('home-budget-alert-bar');
    _$budgetAlertFill= document.getElementById('home-budget-alert-fill');
    _$budgetAlertSpent=document.getElementById('home-budget-alert-spent');
    _$budgetAlertDaily=document.getElementById('home-budget-alert-daily');
    _$budgetAlertRemaining=document.getElementById('home-budget-alert-remaining');
    _$budgetAlertSummaryTotal=document.getElementById('home-budget-alert-summary-total');
  }

  /* -----------------------------------------------------------------
     渲染入口：切换到首页时由 app.js 调用
     ----------------------------------------------------------------- */
  function render() {
    if (!_$date) _cacheDom();

    _renderHeader();
    _renderToday();
    _renderMonth();
    _renderBudgetAlert();
    _renderAlerts();
    _renderRecent();
  }

  /* -----------------------------------------------------------------
     标题栏日期
     ----------------------------------------------------------------- */
  function _renderHeader() {
    const now = new Date();
    const weekdays = ['日', '一', '二', '三', '四', '五', '六'];
    const m = now.getMonth() + 1;
    const d = now.getDate();
    const w = weekdays[now.getDay()];
    _$date.textContent = `${m}月${d}日 周${w}`;
  }

  /* -----------------------------------------------------------------
     今日消费 + 较昨日对比（涨红跌蓝）
     ----------------------------------------------------------------- */
  function _renderToday() {
    const today = _todayStr();
    const yesterday = _yesterdayStr();
    const expenses = ExpenseDB.getExpenses();
    const todayExpenses = expenses.filter(e => e.date === today);
    const total = todayExpenses.reduce((sum, e) => sum + e.amount, 0);

    _$todayAmount.innerHTML = '<span class="home-overview__currency">¥</span>' + total.toFixed(2);
    _$todayCount.textContent = `${todayExpenses.length} 笔`;

    // 较昨日对比
    if (_$todayDiff) {
      const yesterdayExpenses = expenses.filter(e => e.date === yesterday);
      const yesterdayTotal = yesterdayExpenses.reduce((sum, e) => sum + e.amount, 0);

      const MIN_DAILY_BASE = 1; // 昨日 < ¥1 视为无效基准，不计算百分比
      if (yesterdayTotal >= MIN_DAILY_BASE) {
        const diff = ((total - yesterdayTotal) / yesterdayTotal) * 100;
        const abs = Math.abs(diff).toFixed(1);
        if (diff > 0.5) {
          _$todayDiff.innerHTML = '较昨日 <span class="home-overview__diff--up">+' + abs + '% ↑</span>';
        } else if (diff < -0.5) {
          _$todayDiff.innerHTML = '较昨日 <span class="home-overview__diff--down">-' + abs + '% ↓</span>';
        } else {
          _$todayDiff.innerHTML = '较昨日 <span style="font-weight:400">-</span>';
        }
      } else if (total > 0) {
        _$todayDiff.innerHTML = '较昨日 <span style="font-weight:400">-</span>';
      } else {
        _$todayDiff.innerHTML = '较昨日 <span style="font-weight:400">-</span>';
      }
    }
  }

  /* -----------------------------------------------------------------
     本月消费 + 较上月对比（涨红跌蓝）
     ----------------------------------------------------------------- */
  function _renderMonth() {
    const currentYM = _yearMonthStr();
    const expenses = ExpenseDB.getExpenses();
    const monthExpenses = expenses.filter(e => e.date.startsWith(currentYM));
    const monthTotal = monthExpenses.reduce((sum, e) => sum + e.amount, 0);

    _$monthAmount.innerHTML = '<span class="home-overview__currency">¥</span>' + monthTotal.toFixed(2);
    _$monthCount.textContent = `${monthExpenses.length} 笔`;

    // 较上月对比
    if (_$monthDiff) {
      const lastMonthTotal = _lastMonthTotal();
      const MIN_BASE = 10; // 上月 < ¥10 视为无效基准，不计算百分比
      if (lastMonthTotal >= MIN_BASE) {
        const diff = ((monthTotal - lastMonthTotal) / lastMonthTotal) * 100;
        const abs = Math.abs(diff).toFixed(1);
        if (diff > 0.5) {
          _$monthDiff.innerHTML = '较上月 <span class="home-overview__diff--up">+' + abs + '% ↑</span>';
        } else if (diff < -0.5) {
          _$monthDiff.innerHTML = '较上月 <span class="home-overview__diff--down">-' + abs + '% ↓</span>';
        } else {
          _$monthDiff.textContent = '较上月 持平';
        }
      } else {
        _$monthDiff.innerHTML = '较上月 <span style="font-weight:400">-</span>';
      }
    }
  }

  /* -----------------------------------------------------------------
     预算提醒：自动选最接近超支的分类 → 时间感知状态判定
     核心逻辑：花钱速度 vs 时间进度 = 节奏比
       节奏比 = 已用% / 时间进度%
       节奏比 ≤ 1.2  → 正常（花钱跟时间差不多或更慢）
       节奏比 > 1.2  → 偏快（花钱比时间跑得快）
       已用 > 100%  → 超支（不管时间，已经爆了）
     特殊情况：月初前几天（时间进度 < 5%）不判偏快，避免分母太小导致误报
     ----------------------------------------------------------------- */
  function _renderBudgetAlert() {
    if (!_$budgetAlert) return;

    var budget = ExpenseDB.getBudget();
    var catBudgets = budget.categories || {};

    // 遍历所有分类预算，找已用比例最高的（最接近超支的那个分类）
    var closest = null; // { budget, spent, pct }
    for (var catId in catBudgets) {
      if (!Object.prototype.hasOwnProperty.call(catBudgets, catId)) continue;
      var catBudget = catBudgets[catId];
      if (!catBudget || catBudget <= 0) continue;
      var spent = ExpenseDB.getCategorySpent(catId);
      var pct = Math.round((spent / catBudget) * 100);
      if (!closest || pct > closest.pct) {
        closest = { budget: catBudget, spent: spent, pct: pct };
      }
    }

    // 没有分类预算 → 回退到月度总预算
    if (!closest) {
      var monthlyBudget = budget.monthlyTotal || 0;
      if (monthlyBudget <= 0) {
        _$budgetAlert.style.display = 'none';
        var setBtn = document.getElementById('home-set-budget');
        if (setBtn) setBtn.style.display = '';
        return;
      }
      var currentYM = _yearMonthStr();
      var expenses = ExpenseDB.getExpenses();
      var monthTotal = expenses
        .filter(function(e) { return e.date.startsWith(currentYM); })
        .reduce(function(sum, e) { return sum + e.amount; }, 0);
      closest = {
        budget: monthlyBudget,
        spent: monthTotal,
        pct: Math.round((monthTotal / monthlyBudget) * 100),
      };
    }

    var remainingAmount = closest.budget - closest.spent;

    // ---- 时间感知状态判定 ----
    var now = new Date();
    var dayOfMonth = now.getDate();
    var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var timeProgress = dayOfMonth / daysInMonth; // 本月时间进度 0~1

    var statusText, statusClass, barClass, barColor;
    // spentPct 可能超过 100，用 Math.max(1, ...) 避免进度条为 0 时除法异常
    var spentPct = closest.pct;

    if (spentPct > 100) {
      // 已超支 — 不管时间进度
      statusText = '超 支';
      statusClass = 'home-budget-alert__status-badge--over';
      barClass = 'progress-bar__fill--over';
      barColor = 'var(--color-budget-over)';
    } else {
      // 节奏比 = 花钱速度 / 时间进度
      // 月初前几天（时间进度 < 5%）节奏比容易虚高，加保护：时间进度至少按 5% 算
      var effectiveTime = Math.max(timeProgress, 0.05);
      var paceRatio = (spentPct / 100) / effectiveTime;

      if (paceRatio > 1.2) {
        statusText = '偏 快';
        statusClass = 'home-budget-alert__status-badge--fast';
        barClass = 'progress-bar__fill--warn';
        barColor = 'var(--color-budget-warn)';
      } else {
        statusText = '正 常';
        statusClass = 'home-budget-alert__status-badge--normal';
        barClass = 'progress-bar__fill--safe';
        barColor = 'var(--color-budget-safe)';
      }
    }

    _$budgetAlert.style.display = '';
    var setBtn2 = document.getElementById('home-set-budget');
    if (setBtn2) setBtn2.style.display = 'none';

    // 状态标签
    _$budgetAlertStatus.innerHTML = '<span class="home-budget-alert__status-badge ' + statusClass + '">' + statusText + '</span>';

    // 已使用百分比（大字，与状态同色）
    _$budgetAlertPct.textContent = spentPct + '%';
    _$budgetAlertPct.style.color = barColor;

    // 进度条
    _$budgetAlertFill.style.width = Math.min(spentPct, 100) + '%';
    _$budgetAlertFill.className = 'progress-bar__fill ' + barClass;

    // 已花金额（进度条右侧）
    _$budgetAlertSpent.textContent = '¥' + closest.spent.toFixed(0);

    // 底部三列：还可用 / 日均可花 / 总预算
    var daysLeft = _daysLeftInMonth();
    var dailyAvg = (daysLeft > 0 && remainingAmount > 0)
      ? Math.floor(remainingAmount / daysLeft)
      : Math.max(0, remainingAmount);

    _$budgetAlertRemaining.textContent = '¥' + Math.max(0, remainingAmount).toLocaleString();
    _$budgetAlertDaily.textContent = '¥' + dailyAvg.toLocaleString();
    _$budgetAlertSummaryTotal.textContent = '¥' + closest.budget.toLocaleString();
  }

  /** 本月剩余天数（含今天） */
  function _daysLeftInMonth() {
    var now = new Date();
    var lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    return lastDay - now.getDate() + 1;
  }

  /* -----------------------------------------------------------------
     智能提醒
     基础版仅含预算相关提醒（5 条规则）
     ----------------------------------------------------------------- */
  function _renderAlerts() {
    const alertsSection = document.getElementById('home-alerts-section');
    const alerts = _generateAlerts();

    const hasImportant = alerts.some(a => a.level === 'warning' || a.level === 'danger');

    if (!hasImportant) {
      _$alerts.innerHTML = '';
      if (alertsSection) alertsSection.style.display = 'none';
      return;
    }
    if (alertsSection) alertsSection.style.display = '';

    const sorted = alerts.sort((a, b) => {
      const order = { danger: 0, warning: 1, info: 2, success: 3 };
      return (order[a.level] || 0) - (order[b.level] || 0);
    }).slice(0, 4);

    _$alerts.innerHTML = sorted.map((a, i) => `
      <div class="home-alert home-alert--${a.level}">
        <span class="home-alert__icon">${a.icon}</span>
        <span class="home-alert__text">${a.text}</span>
        <button class="home-alert__close" data-alert-idx="${i}" title="忽略">✕</button>
      </div>
    `).join('');

    const dismissedKey = `dismissed-alerts-${_todayStr()}`;
    let dismissed = [];
    try {
      dismissed = JSON.parse(localStorage.getItem(dismissedKey) || '[]');
    } catch (_) { dismissed = []; }

    const activeAlerts = sorted.filter((_, i) => !dismissed.includes(i));
    if (activeAlerts.length === 0) {
      _$alerts.innerHTML = '';
      if (alertsSection) alertsSection.style.display = 'none';
      return;
    }

    _$alerts.innerHTML = activeAlerts.map((a, idx) => `
      <div class="home-alert home-alert--${a.level}" data-alert-idx="${idx}">
        <span class="home-alert__icon">${a.icon}</span>
        <span class="home-alert__text">${a.text}</span>
        <button class="home-alert__close" data-alert-idx="${idx}" title="忽略">✕</button>
      </div>
    `).join('');

    _$alerts.querySelectorAll('.home-alert__close').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = parseInt(btn.dataset.alertIdx);
        if (!isNaN(idx)) {
          dismissed.push(idx);
          try {
            localStorage.setItem(dismissedKey, JSON.stringify(dismissed));
          } catch (_) { /* localStorage 满时静默忽略 */ }
        }
        btn.closest('.home-alert').remove();
        if (_$alerts.children.length === 0) {
          const section = document.getElementById('home-alerts-section');
          if (section) section.style.display = 'none';
        }
      });
    });
  }

  /**
   * 生成提醒列表
   */
  function _generateAlerts() {
    const alerts = [];
    const budget = ExpenseDB.getBudget();
    const monthTotal = ExpenseDB.getMonthTotal();
    const monthlyBudget = budget.monthlyTotal || 0;

    if (monthlyBudget > 0 && monthTotal > monthlyBudget * 0.95) {
      const pct = Math.round((monthTotal / monthlyBudget) * 100);
      const remaining = monthlyBudget - monthTotal;
      alerts.push({
        level: 'danger', icon: '🔴',
        text: `本月已花掉预算的 ${pct}%，仅剩 ¥${Math.max(0, remaining).toFixed(0)}，建议控制`,
      });
    } else if (monthlyBudget > 0 && monthTotal > monthlyBudget * 0.8) {
      const pct = Math.round((monthTotal / monthlyBudget) * 100);
      const remaining = monthlyBudget - monthTotal;
      alerts.push({
        level: 'warning', icon: '🟡',
        text: `本月已花 ¥${monthTotal.toFixed(0)}，占预算的 ${pct}%，剩余 ¥${remaining.toFixed(0)}`,
      });
    }

    const catBudgets = budget.categories || {};
    const currentYM = _yearMonthStr();
    for (const [catId, catBudget] of Object.entries(catBudgets)) {
      if (!catBudget || catBudget <= 0) continue;
      const spent = ExpenseDB.getCategorySpent(catId, currentYM);
      const cat = ExpenseDB.getCategory(catId);
      const catName = cat ? cat.name : catId;

      if (spent > catBudget * 0.9) {
        const pct = Math.round((spent / catBudget) * 100);
        alerts.push({
          level: 'danger', icon: '🔴',
          text: `「${catName}」预算已使用 ${pct}%（¥${spent.toFixed(0)}/¥${catBudget}），注意控制`,
        });
      } else if (spent > catBudget * 0.8) {
        const pct = Math.round((spent / catBudget) * 100);
        alerts.push({
          level: 'warning', icon: '🟡',
          text: `「${catName}」已花 ¥${spent.toFixed(0)}，占预算的 ${pct}%`,
        });
      }

      const prevYM = _prevYearMonth();
      const prevSpent = ExpenseDB.getCategorySpent(catId, prevYM);
      if (prevSpent > 0 && spent < prevSpent * 0.8) {
        const dropPct = Math.round((1 - spent / prevSpent) * 100);
        alerts.push({
          level: 'success', icon: '🟢',
          text: `「${catName}」比上月同期低 ${dropPct}%，继续保持`,
        });
      }
    }

    return alerts;
  }

  /* -----------------------------------------------------------------
     最近 5 条记录
     ----------------------------------------------------------------- */
  function _renderRecent() {
    const expenses = ExpenseDB.getExpenses();
    const recent = expenses.slice(0, 3);

    if (recent.length === 0) {
      _$recent.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">📝</div>
          <p class="empty-state__text">还没有消费记录</p>
          <p class="empty-state__hint">去「记账」Tab 添加第一笔吧</p>
        </div>`;
      _$viewAllBtn.style.display = 'none';
      return;
    }

    _$recent.innerHTML = recent.map(e => {
      const cat = ExpenseDB.getCategory(e.categoryId);
      const icon = cat ? cat.icon : '📌';
      const name = cat ? cat.name : '未分类';
      const metaParts = [];
      const today = _todayStr();
      if (e.date === today) {
        if (e.time) metaParts.push(`⏰${e.time}`);
      } else {
        const parts = e.date.split('-');
        if (parts.length === 3) metaParts.push(`${parseInt(parts[1])}月${parseInt(parts[2])}日`);
      }
      if (e.location) metaParts.push(`📍${e.location}`);
      if (e.paymentMethod) {
        const pm = ExpenseData.PAYMENT_METHODS.find(p => p.value === e.paymentMethod);
        metaParts.push(pm ? pm.label : e.paymentMethod);
      }
      if (e.note) metaParts.push(`📝${e.note}`);

      return `
        <div class="home-recent__item" data-id="${e.id}">
          <div class="home-recent__icon">${icon}</div>
          <div class="home-recent__info">
            <div class="home-recent__name">${name}</div>
            ${metaParts.length ? `<div class="home-recent__meta">${metaParts.join(' · ')}</div>` : ''}
          </div>
          <span class="home-recent__amount">-¥${e.amount.toFixed(2)}</span>
        </div>`;
    }).join('')
      // 末尾追加"记一笔"入口
      + `<div class="home-recent__add" id="home-recent-add">
           <span class="home-recent__add-icon">+</span>
           <span class="home-recent__add-text">记一笔</span>
         </div>`;

    _$viewAllBtn.style.display = '';
  }

  /* -----------------------------------------------------------------
     工具函数
     ----------------------------------------------------------------- */
  function _todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function _yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function _yearMonthStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function _prevYearMonth() {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** 上月总消费 */
  function _lastMonthTotal() {
    const lastYM = _prevYearMonth();
    const expenses = ExpenseDB.getExpenses();
    return expenses
      .filter(e => e.date.startsWith(lastYM))
      .reduce((sum, e) => sum + e.amount, 0);
  }

  /* =================================================================
     公开 API
     ================================================================= */
  return { render };
})();
