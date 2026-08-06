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
  let _$date, _$today, _$todayAmount, _$todayCount, _$todayDiff;
  let _$monthAmount, _$monthCount, _$monthDiff, _$monthComparison, _$monthContextDot;
  let _$alerts, _$recent, _$viewAllBtn;
  let _$budgetSummary, _$budgetSummaryLabel;
  let _$budgetSummaryProgress, _$budgetSummaryPercentage, _$budgetActionLabel;
  let _$budgetSummarySpent, _$budgetSummaryLimit, _$budgetSummaryStatus;
  let _$budgetSummaryDecisionLabel, _$budgetSummaryDecisionValue;
  let _$budgetSummaryRemaining, _$budgetSummaryDays, _$budgetSummaryForecast;

  /* -----------------------------------------------------------------
     内联 Lucide 线条图标（v185 起替代 UI emoji）
     尺寸由 common.css 的 .alert-icon / .meta-icon 控制（1em 随字号）
     ----------------------------------------------------------------- */
  const _ICONS = {
    danger:   '<svg viewBox="0 0 24 24" class="alert-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></g></svg>',
    warning:  '<svg viewBox="0 0 24 24" class="alert-icon" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="m21.73 18l-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3M12 9v4m0 4h.01"/></svg>',
    success:  '<svg viewBox="0 0 24 24" class="alert-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m9 12l2 2l4-4"/></g></svg>',
    mapPin:   '<svg viewBox="0 0 24 24" class="meta-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M20 10c0 4.993-5.539 10.193-7.399 11.799a1 1 0 0 1-1.202 0C9.539 20.193 4 14.993 4 10a8 8 0 0 1 16 0"/><circle cx="12" cy="10" r="3"/></g></svg>',
    fileText: '<svg viewBox="0 0 24 24" class="meta-icon" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5M10 9H8m8 4H8m8 4H8"/></g></svg>',
  };

  /**
   * 初始化 DOM 引用（在 render 前调用一次）
   */
  function _cacheDom() {
    _$date           = document.getElementById('home-date');
    _$today          = document.getElementById('home-today');
    _$todayAmount    = document.getElementById('home-today-amount');
    _$todayCount     = document.getElementById('home-today-count');
    _$todayDiff      = document.getElementById('home-today-diff');
    _$monthAmount    = document.getElementById('home-month-amount');
    _$monthCount     = document.getElementById('home-month-count');
    _$monthDiff      = document.getElementById('home-month-diff');
    _$monthComparison= document.getElementById('home-month-comparison');
    _$monthContextDot= document.getElementById('home-month-context-dot');
    _$alerts         = document.getElementById('home-alerts');
    _$recent         = document.getElementById('home-recent');
    _$viewAllBtn     = document.getElementById('home-view-all');
    // 预算进度
    _$budgetSummary = document.getElementById('home-budget-summary');
    _$budgetSummaryLabel = document.getElementById('home-budget-summary-label');
    _$budgetSummaryProgress = document.getElementById('home-budget-summary-progress');
    _$budgetSummaryPercentage = document.getElementById('home-budget-summary-percentage');
    _$budgetActionLabel = document.getElementById('home-budget-action-label');
    _$budgetSummarySpent = document.getElementById('home-budget-summary-spent');
    _$budgetSummaryLimit = document.getElementById('home-budget-summary-limit');
    _$budgetSummaryStatus = document.getElementById('home-budget-summary-status');
    _$budgetSummaryDecisionLabel = document.getElementById('home-budget-summary-decision-label');
    _$budgetSummaryDecisionValue = document.getElementById('home-budget-summary-decision-value');
    _$budgetSummaryRemaining = document.getElementById('home-budget-summary-remaining');
    _$budgetSummaryDays = document.getElementById('home-budget-summary-days');
    _$budgetSummaryForecast = document.getElementById('home-budget-summary-forecast');
  }

  /* -----------------------------------------------------------------
     渲染入口：切换到首页时由 app.js 调用
     ----------------------------------------------------------------- */
  function render() {
    if (!_$date) _cacheDom();

    _renderHeader();
    _renderToday();
    _renderMonth();
    _renderBudgetSummary();
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
    const today = ExpenseDB.today();
    const yesterday = _yesterdayStr();
    const expenses = ExpenseDB.getExpenses();
    const todayExpenses = expenses.filter(e => e.date === today);
    const total = todayExpenses.reduce((sum, e) => sum + e.amount, 0);

    if (_$today) _$today.hidden = todayExpenses.length === 0;
    if (todayExpenses.length === 0) return;

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
     本月消费 + 上月对比（归入辅助信息带）
     ----------------------------------------------------------------- */
  function _renderMonth() {
    const currentYM = ExpenseDB.yearMonth();
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
        if (_$monthComparison) _$monthComparison.hidden = false;
        if (_$monthContextDot) _$monthContextDot.hidden = false;
        const diff = ((monthTotal - lastMonthTotal) / lastMonthTotal) * 100;
        const abs = Math.abs(diff).toFixed(1);
        if (diff > 0.5) {
          _$monthDiff.innerHTML = '<span class="home-overview__diff--up">+' + abs + '% ↑</span>';
        } else if (diff < -0.5) {
          _$monthDiff.innerHTML = '<span class="home-overview__diff--down">-' + abs + '% ↓</span>';
        } else {
          _$monthDiff.textContent = '基本持平';
        }
      } else {
        if (_$monthComparison) _$monthComparison.hidden = true;
        if (_$monthContextDot) _$monthContextDot.hidden = true;
      }
    }
  }

  /* -----------------------------------------------------------------
     预算进度卡片：圆环 + 信息区 + 预测
     时间感知状态：节奏比 = 已用% / 时间进度%
     ----------------------------------------------------------------- */
  function _renderBudgetSummary() {
    if (!_$budgetSummary || !_$budgetSummaryLabel || !_$budgetSummaryProgress) return;

    var budget = ExpenseDB.getBudget() || {};
    var monthlyBudget = Number(budget.monthlyTotal) || 0;

    if (monthlyBudget <= 0) {
      _$budgetSummary.className = 'home-budget-brief card home-budget-brief--setup';
      _$budgetSummaryLabel.textContent = '还没有设置本月预算';
      _$budgetSummaryProgress.style.width = '0%';
      if (_$budgetSummaryPercentage) _$budgetSummaryPercentage.textContent = '0%';
      _$budgetSummaryProgress.parentElement.setAttribute('aria-valuenow', '0');
      _$budgetSummaryProgress.parentElement.setAttribute('aria-valuetext', '尚未设置预算');
      if (_$budgetActionLabel) _$budgetActionLabel.textContent = '去设置';
      if (_$budgetSummaryForecast) _$budgetSummaryForecast.hidden = true;
      return;
    }

    var monthSpent = Math.max(0, Number(ExpenseDB.getMonthTotal()) || 0);
    var now = new Date();
    var dayOfMonth = now.getDate();
    var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var daysLeft = _daysLeftInMonth();
    var remainingAmount = monthlyBudget - monthSpent;
    var remaining = Math.max(0, remainingAmount);
    var spentPct = Math.round((monthSpent / monthlyBudget) * 100);
    var paceRatio = (monthSpent / monthlyBudget) / Math.max(dayOfMonth / daysInMonth, 0.05);
    var state = remainingAmount < 0 ? 'over' : (paceRatio > 1.2 ? 'watch' : 'safe');
    var roundedSpent = Math.round(monthSpent).toLocaleString();
    var roundedBudget = Math.round(monthlyBudget).toLocaleString();
    var roundedRemaining = Math.round(remaining).toLocaleString();

    _$budgetSummary.className = 'home-budget-brief card home-budget-brief--' + state;
    _$budgetSummaryLabel.textContent = '已设置本月预算';
    var visualPct = Math.max(0, Math.min(100, spentPct));
    _$budgetSummaryProgress.style.width = visualPct + '%';
    if (_$budgetSummaryPercentage) _$budgetSummaryPercentage.textContent = Math.max(0, spentPct) + '%';
    _$budgetSummaryProgress.parentElement.setAttribute('aria-valuenow', String(visualPct));
    _$budgetSummaryProgress.parentElement.setAttribute('aria-valuetext', '预算已使用 ' + spentPct + '%');
    if (_$budgetActionLabel) _$budgetActionLabel.textContent = '调整';
    if (_$budgetSummarySpent) _$budgetSummarySpent.innerHTML = _moneyMarkup(roundedSpent);
    if (_$budgetSummaryLimit) _$budgetSummaryLimit.innerHTML = '/ ' + _moneyMarkup(roundedBudget);
    if (_$budgetSummaryStatus) {
      _$budgetSummaryStatus.textContent = state === 'over' ? '超出预算' : (state === 'watch' ? '花得偏快' : '节奏正常');
    }

    var dailyAllowance = (daysLeft > 0 && remaining > 0) ? Math.floor(remaining / daysLeft) : 0;
    if (_$budgetSummaryDecisionLabel) {
      _$budgetSummaryDecisionLabel.textContent = state === 'over'
        ? '本月已超支'
        : (state === 'watch' ? '今天建议不超过' : '今天可安心花');
    }
    if (_$budgetSummaryDecisionValue) {
      _$budgetSummaryDecisionValue.innerHTML = state === 'over'
        ? _moneyMarkup(Math.round(-remainingAmount).toLocaleString())
        : _moneyMarkup(dailyAllowance.toLocaleString());
    }
    if (_$budgetSummaryRemaining) {
      _$budgetSummaryRemaining.innerHTML = state === 'over'
        ? '已超 ' + _moneyMarkup(Math.round(-remainingAmount).toLocaleString())
        : '还剩 ' + _moneyMarkup(roundedRemaining);
    }
    if (_$budgetSummaryDays) _$budgetSummaryDays.textContent = '本月剩 ' + daysLeft + ' 天';

    if (!_$budgetSummaryForecast) return;
    if (state === 'safe') {
      _$budgetSummaryForecast.hidden = true;
      return;
    }

    _$budgetSummaryForecast.hidden = false;
    if (state === 'over') {
      _$budgetSummaryForecast.textContent = '建议暂停非必要消费，或调整本月预算。';
      return;
    }

    if (dayOfMonth < 3) {
      _$budgetSummaryForecast.textContent = '月初数据较少，先按今天的建议控制即可。';
      return;
    }

    var projectedTotal = (monthSpent / dayOfMonth) * daysInMonth;
    var projectedOver = Math.max(0, Math.round(projectedTotal - monthlyBudget));
    _$budgetSummaryForecast.textContent = '按当前节奏，月末预计超出 ¥' + projectedOver.toLocaleString() + '。';
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
        <span class="home-alert__text">${ExpenseData.escapeHtml(a.text)}</span>
        <button class="home-alert__close" data-alert-idx="${i}" title="忽略">✕</button>
      </div>
    `).join('');

    const dismissedKey = `dismissed-alerts-${ExpenseDB.today()}`;
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
        <span class="home-alert__text">${ExpenseData.escapeHtml(a.text)}</span>
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
        level: 'danger', icon: _ICONS.danger,
        text: `本月已花掉预算的 ${pct}%，仅剩 ¥${Math.max(0, remaining).toFixed(0)}，建议控制`,
      });
    } else if (monthlyBudget > 0 && monthTotal > monthlyBudget * 0.8) {
      const pct = Math.round((monthTotal / monthlyBudget) * 100);
      const remaining = monthlyBudget - monthTotal;
      alerts.push({
        level: 'warning', icon: _ICONS.warning,
        text: `本月已花 ¥${monthTotal.toFixed(0)}，占预算的 ${pct}%，剩余 ¥${remaining.toFixed(0)}`,
      });
    }

    const catBudgets = budget.categories || {};
    const currentYM = ExpenseDB.yearMonth();
    for (const [catId, catBudget] of Object.entries(catBudgets)) {
      if (!catBudget || catBudget <= 0) continue;
      const spent = ExpenseDB.getCategorySpent(catId, currentYM);
      const cat = ExpenseDB.getCategory(catId);
      const catName = cat ? cat.name : catId;

      if (spent > catBudget * 0.9) {
        const pct = Math.round((spent / catBudget) * 100);
        alerts.push({
          level: 'danger', icon: _ICONS.danger,
          text: `「${catName}」预算已使用 ${pct}%（¥${spent.toFixed(0)}/¥${catBudget}），注意控制`,
        });
      } else if (spent > catBudget * 0.8) {
        const pct = Math.round((spent / catBudget) * 100);
        alerts.push({
          level: 'warning', icon: _ICONS.warning,
          text: `「${catName}」已花 ¥${spent.toFixed(0)}，占预算的 ${pct}%`,
        });
      }

      const prevYM = _prevYearMonth();
      const prevSpent = ExpenseDB.getCategorySpent(catId, prevYM);
      if (prevSpent > 0 && spent < prevSpent * 0.8) {
        const dropPct = Math.round((1 - spent / prevSpent) * 100);
        alerts.push({
          level: 'success', icon: _ICONS.success,
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
        <div class="home-recent__empty-line">
          <span class="home-recent__empty-icon" aria-hidden="true">✦</span>
          <div>
            <p class="home-recent__empty-title">还没有消费记录</p>
            <p class="home-recent__empty-copy">第一笔会出现在这里</p>
          </div>
        </div>`;
      _$recent.classList.add('home-recent--empty');
      _$viewAllBtn.style.display = 'none';
      return;
    }

    _$recent.classList.remove('home-recent--empty');

    _$recent.innerHTML = recent.map(e => {
      const cat = ExpenseDB.getCategory(e.categoryId);
      const icon = ExpenseCategories.getIconMarkup(cat);
      const name = cat ? cat.name : '未分类';
      const metaParts = [];
      const today = ExpenseDB.today();
      if (e.date === today) {
        if (e.time) metaParts.push(ExpenseData.escapeHtml(e.time));
      } else {
        const parts = e.date.split('-');
        if (parts.length === 3) metaParts.push(`${parseInt(parts[1])}月${parseInt(parts[2])}日`);
      }
      if (e.location) metaParts.push(`${_ICONS.mapPin}${ExpenseData.escapeHtml(e.location)}`);
      if (e.paymentMethod) {
        const pm = ExpenseData.PAYMENT_METHODS.find(p => p.value === e.paymentMethod);
        metaParts.push(ExpenseData.escapeHtml(pm ? pm.label : e.paymentMethod));
      }
      if (e.note) metaParts.push(`${_ICONS.fileText}${ExpenseData.escapeHtml(e.note)}`);

      return `
        <div class="home-recent__item" data-id="${ExpenseData.escapeHtml(e.id)}">
          <div class="home-recent__icon">${icon}</div>
          <div class="home-recent__info">
            <div class="home-recent__name">${ExpenseData.escapeHtml(name)}</div>
            ${metaParts.length ? `<div class="home-recent__meta">${metaParts.join(' · ')}</div>` : ''}
          </div>
          <span class="home-recent__amount">-${_moneyMarkup(e.amount.toFixed(2))}</span>
        </div>`;
    }).join('');

    _$viewAllBtn.style.display = '';
  }

  /* -----------------------------------------------------------------
     工具函数
     ----------------------------------------------------------------- */
  /** 昨天日期 YYYY-MM-DD（仅 home.js 使用） */
  function _yesterdayStr() {
    const d = new Date();
    d.setDate(d.getDate() - 1);
    return ExpenseDB.dateToYMD(d);
  }

  /** 上个月 YYYY-MM */
  function _prevYearMonth() {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function _moneyMarkup(amount) {
    return '<span class="home-overview__currency">¥</span>' + amount;
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
