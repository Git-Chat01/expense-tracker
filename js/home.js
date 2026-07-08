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
  let _$budgetAlert, _$budgetAlertRing, _$budgetAlertStatus, _$budgetAlertPct;
  let _$budgetAlertDaily, _$budgetAlertRemaining, _$budgetAlertPrediction;

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
    // 预算进度
    _$budgetAlert    = document.getElementById('home-budget-alert');
    _$budgetAlertRing= document.getElementById('home-budget-alert-ring');
    _$budgetAlertStatus=document.getElementById('home-budget-alert-status');
    _$budgetAlertPct = document.getElementById('home-budget-alert-pct');
    _$budgetAlertDaily=document.getElementById('home-budget-alert-daily');
    _$budgetAlertRemaining=document.getElementById('home-budget-alert-remaining');
    _$budgetAlertPrediction=document.getElementById('home-budget-alert-prediction');
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
     预算进度卡片：圆环 + 信息区 + 预测
     时间感知状态：节奏比 = 已用% / 时间进度%
     ----------------------------------------------------------------- */
  function _renderBudgetAlert() {
    if (!_$budgetAlert) return;

    var budget = ExpenseDB.getBudget();
    var catBudgets = budget.categories || {};

    // 找已用比例最高的分类预算
    var closest = null;
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

    // 无分类预算 → 月度总预算
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

    // ---- 时间感知状态判定 ----
    var now = new Date();
    var dayOfMonth = now.getDate();
    var daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
    var timeProgress = dayOfMonth / daysInMonth;
    var spentPct = closest.pct;
    var remainingAmount = closest.budget - closest.spent;

    // 颜色值（SVG 需要 hex，CSS 用 var）
    var statusText, statusClass, ringHex, amountColor;
    if (spentPct > 100) {
      statusText = '超支';
      statusClass = 'home-budget-alert__status--over';
      ringHex = '#CC0000';
      amountColor = 'var(--color-budget-over)';
    } else {
      var effectiveTime = Math.max(timeProgress, 0.05);
      var paceRatio = (spentPct / 100) / effectiveTime;
      if (paceRatio > 1.2) {
        statusText = '偏快';
        statusClass = 'home-budget-alert__status--fast';
        ringHex = '#FF6B35';
        amountColor = 'var(--color-budget-warn)';
      } else {
        statusText = '正常';
        statusClass = 'home-budget-alert__status--normal';
        ringHex = '#34C759';
        amountColor = 'var(--color-budget-safe)';
      }
    }

    _$budgetAlert.style.display = '';
    var setBtn2 = document.getElementById('home-set-budget');
    if (setBtn2) setBtn2.style.display = 'none';

    // ---- SVG 圆环 ----
    var ringR = 36;
    var ringCircum = 2 * Math.PI * ringR;
    var ringPct = spentPct > 100 ? 100 : spentPct; // 超支时圆环满格
    var dashOffset = ringCircum * (1 - ringPct / 100);

    _$budgetAlertRing.innerHTML =
      '<svg width="88" height="88" viewBox="0 0 88 88" xmlns="http://www.w3.org/2000/svg">'
      + '<circle cx="44" cy="44" r="' + ringR + '" fill="none" stroke="#E5E5EA" stroke-width="6"/>'
      + '<circle cx="44" cy="44" r="' + ringR + '" fill="none" stroke="' + ringHex + '" stroke-width="6"'
      + ' stroke-dasharray="' + ringCircum.toFixed(1) + ' ' + ringCircum.toFixed(1) + '"'
      + ' stroke-dashoffset="' + dashOffset.toFixed(1) + '"'
      + ' stroke-linecap="round" transform="rotate(-90 44 44)"/>'
      + '<text x="44" y="46" text-anchor="middle" dominant-baseline="middle"'
      + ' font-size="16" font-weight="700" font-family="Menlo,Consolas,monospace"'
      + ' fill="' + ringHex + '">' + spentPct + '%</text>'
      + '</svg>';

    // ---- 状态标签（右上角） ----
    _$budgetAlertStatus.textContent = statusText;
    _$budgetAlertStatus.className = 'home-budget-alert__status ' + statusClass;

    // ---- 本月已用百分比 ----
    _$budgetAlertPct.innerHTML = '本月已用 <span class="home-budget-alert__pct-value">' + spentPct + '%</span>';

    // ---- 日均可花 ----
    var daysLeft = _daysLeftInMonth();
    var dailyAvg = (daysLeft > 0 && remainingAmount > 0)
      ? Math.floor(remainingAmount / daysLeft)
      : Math.max(0, remainingAmount);

    _$budgetAlertDaily.textContent = '¥' + dailyAvg.toLocaleString();

    // ---- 还可用（按健康度着色） ----
    var remaining = Math.max(0, remainingAmount);
    _$budgetAlertRemaining.textContent = '¥' + remaining.toLocaleString();
    _$budgetAlertRemaining.style.color = amountColor;

    // ---- 预测信息 ----
    if (dayOfMonth >= 3 && spentPct <= 100) {
      // 日均花费 = 已用金额 / 已过天数
      var avgDailySpent = closest.spent / dayOfMonth;
      var projectedTotal = closest.spent + avgDailySpent * daysLeft;
      var projectedRemaining = closest.budget - projectedTotal;
      var totalText = '总预算 ¥' + closest.budget.toLocaleString();
      if (projectedRemaining >= 0) {
        _$budgetAlertPrediction.innerHTML = totalText + ' · 按当前速度，预计月底剩余 <b>¥' + Math.round(projectedRemaining).toLocaleString() + '</b>';
      } else {
        _$budgetAlertPrediction.innerHTML = totalText + ' · 按当前速度，预计月底超支 <b style="color:#CC0000">¥' + Math.round(-projectedRemaining).toLocaleString() + '</b>';
      }
    } else if (spentPct > 100) {
      _$budgetAlertPrediction.innerHTML = '总预算 ¥' + closest.budget.toLocaleString() + ' · 已超支 <b style="color:#CC0000">¥' + Math.round(-remainingAmount).toLocaleString() + '</b>';
    } else {
      // 月初前几天，数据不稳定，不显示预测
      _$budgetAlertPrediction.innerHTML = '总预算 ¥' + closest.budget.toLocaleString() + ' · 月初数据较少，预测稍后更新';
    }
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
