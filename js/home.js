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
  let _$budgetAlert, _$budgetAlertUsed, _$budgetAlertTotal, _$budgetAlertPct, _$budgetAlertBar, _$budgetAlertFill;
  let _$budgetAlertDaily, _$budgetAlertRemaining, _$budgetAlertSummaryTotal, _$budgetAlertSummaryPct;

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
    _$budgetAlertUsed= document.getElementById('home-budget-alert-used');
    _$budgetAlertTotal=document.getElementById('home-budget-alert-total');
    _$budgetAlertPct = document.getElementById('home-budget-alert-pct');
    _$budgetAlertBar = document.getElementById('home-budget-alert-bar');
    _$budgetAlertFill= document.getElementById('home-budget-alert-fill');
    _$budgetAlertDaily=document.getElementById('home-budget-alert-daily');
    _$budgetAlertRemaining=document.getElementById('home-budget-alert-remaining');
    _$budgetAlertSummaryTotal=document.getElementById('home-budget-alert-summary-total');
    _$budgetAlertSummaryPct=document.getElementById('home-budget-alert-summary-pct');
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

      if (yesterdayTotal > 0) {
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
      if (lastMonthTotal > 0) {
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
     预算提醒：自动选最接近超支的分类，否则用月度总预算
     剩余 >50% 绿 · 30-50% 黄 · <30% 红
     ----------------------------------------------------------------- */
  function _renderBudgetAlert() {
    if (!_$budgetAlert) return;

    const budget = ExpenseDB.getBudget();
    const catBudgets = budget.categories || {};

    // 遍历所有分类预算，找已用比例最高的（最接近超支）
    let closest = null; // { catName, budget, spent, pct, isTotal }
    for (const [catId, catBudget] of Object.entries(catBudgets)) {
      if (!catBudget || catBudget <= 0) continue;
      const spent = ExpenseDB.getCategorySpent(catId);
      const pct = Math.round((spent / catBudget) * 100);
      if (!closest || pct > closest.pct) {
        const cat = ExpenseDB.getCategory(catId);
        closest = {
          catName: cat ? cat.name : catId,
          budget: catBudget,
          spent: spent,
          pct: pct,
          isTotal: false,
        };
      }
    }

    // 没有分类预算 → 回退到月度总预算
    if (!closest) {
      const monthlyBudget = budget.monthlyTotal || 0;
      if (monthlyBudget <= 0) {
        _$budgetAlert.style.display = 'none';
        var setBtn = document.getElementById('home-set-budget');
        if (setBtn) setBtn.style.display = '';
        return;
      }
      const currentYM = _yearMonthStr();
      const expenses = ExpenseDB.getExpenses();
      const monthTotal = expenses
        .filter(e => e.date.startsWith(currentYM))
        .reduce((sum, e) => sum + e.amount, 0);
      const pct = Math.round((monthTotal / monthlyBudget) * 100);
      closest = {
        catName: '月度总预算',
        budget: monthlyBudget,
        spent: monthTotal,
        pct: pct,
        isTotal: true,
      };
    }

    const remainingAmount = closest.budget - closest.spent;

    // 进度条颜色等级（按已用比例）：safe ≤60% < watch ≤80% < warn ≤90% < danger ≤95% < over
    var barClass = 'progress-bar__fill--safe';
    var barColor = 'var(--color-budget-safe)';
    if (closest.pct > 95)       { barClass = 'progress-bar__fill--over';   barColor = 'var(--color-budget-over)'; }
    else if (closest.pct > 90)  { barClass = 'progress-bar__fill--danger'; barColor = 'var(--color-budget-danger)'; }
    else if (closest.pct > 80)  { barClass = 'progress-bar__fill--warn';   barColor = 'var(--color-budget-warn)'; }
    else if (closest.pct > 60)  { barClass = 'progress-bar__fill--watch';  barColor = 'var(--color-budget-watch)'; }

    _$budgetAlert.style.display = '';
    var setBtn2 = document.getElementById('home-set-budget');
    if (setBtn2) setBtn2.style.display = 'none';

    // 已使用金额（大号 + 与进度条同色，用 style.color 避免套进度条 background）
    var cur = '<span class="home-budget-alert__currency">¥</span>';
    _$budgetAlertUsed.innerHTML = cur + closest.spent.toFixed(0);
    _$budgetAlertUsed.style.color = barColor;
    _$budgetAlertTotal.innerHTML = ' / ' + cur + closest.budget.toLocaleString();

    // 进度条
    _$budgetAlertFill.style.width = Math.min(closest.pct, 100) + '%';
    _$budgetAlertFill.className = 'progress-bar__fill ' + barClass;

    // 百分比（与进度条同色，用 style.color 避免套进度条 background）
    _$budgetAlertPct.textContent = closest.pct + '%';
    _$budgetAlertPct.style.color = barColor;

    // 日均提示
    var daysLeft = _daysLeftInMonth();
    if (daysLeft > 0 && remainingAmount > 0) {
      var dailyAvg = Math.round(remainingAmount / daysLeft);
      _$budgetAlertDaily.innerHTML = '📅 日均<span style="font-family:var(--font-mono);font-weight:600">' + cur + dailyAvg.toLocaleString() + '</span> · 建议控制在' + cur + dailyAvg.toLocaleString() + '/天不超预算';
    } else if (remainingAmount <= 0) {
      _$budgetAlertDaily.textContent = '⚠️ 预算已超支，请注意控制';
    } else {
      _$budgetAlertDaily.textContent = '';
    }

    // 底部三列统计
    _$budgetAlertRemaining.innerHTML = cur + Math.max(0, remainingAmount).toLocaleString();
    _$budgetAlertSummaryTotal.innerHTML = cur + closest.budget.toLocaleString();
    _$budgetAlertSummaryPct.textContent = closest.pct + '%';
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
    const recent = expenses.slice(0, 5);

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
    }).join('');

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
