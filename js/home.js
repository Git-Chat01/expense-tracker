/* ================================================================
   消费轨迹系统 — home.js
   ExpenseHome 命名空间：首页渲染逻辑
   今日消费 / 昨日对比 / 本月消费 / 预算进度 / 预算提醒 / 智能提醒 / 最近记录
   ================================================================ */

const ExpenseHome = (() => {
  'use strict';

  /* -----------------------------------------------------------------
     DOM 引用缓存
     ----------------------------------------------------------------- */
  let _$date, _$todayAmount, _$todayCount, _$todayDiff, _$monthAmount, _$budgetLabel;
  let _$budgetBar, _$budgetFill, _$setBudgetBtn, _$alerts, _$recent, _$viewAllBtn;
  let _$budgetAlert, _$budgetAlertIcon, _$budgetAlertText, _$budgetAlertNums, _$budgetAlertBar, _$budgetAlertFill;

  /**
   * 初始化 DOM 引用（在 render 前调用一次）
   */
  function _cacheDom() {
    _$date           = document.getElementById('home-date');
    _$todayAmount    = document.getElementById('home-today-amount');
    _$todayCount     = document.getElementById('home-today-count');
    _$todayDiff      = document.getElementById('home-today-diff');
    _$monthAmount    = document.getElementById('home-month-amount');
    _$budgetLabel    = document.getElementById('home-budget-label');
    _$budgetBar      = document.getElementById('home-budget-bar');
    _$budgetFill     = document.getElementById('home-budget-fill');
    _$setBudgetBtn   = document.getElementById('home-set-budget');
    _$alerts         = document.getElementById('home-alerts');
    _$recent         = document.getElementById('home-recent');
    _$viewAllBtn     = document.getElementById('home-view-all');
    // 预算提醒
    _$budgetAlert    = document.getElementById('home-budget-alert');
    _$budgetAlertIcon= document.getElementById('home-budget-alert-icon');
    _$budgetAlertText= document.getElementById('home-budget-alert-text');
    _$budgetAlertNums= document.getElementById('home-budget-alert-nums');
    _$budgetAlertBar = document.getElementById('home-budget-alert-bar');
    _$budgetAlertFill= document.getElementById('home-budget-alert-fill');
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
     今日消费 + 较昨日对比
     ----------------------------------------------------------------- */
  function _renderToday() {
    const today = _todayStr();
    const yesterday = _yesterdayStr();
    const expenses = ExpenseDB.getExpenses();
    const todayExpenses = expenses.filter(e => e.date === today);
    const total = todayExpenses.reduce((sum, e) => sum + e.amount, 0);

    _$todayAmount.textContent = `¥${total.toFixed(2)}`;
    _$todayCount.textContent = `${todayExpenses.length} 笔`;

    // 较昨日对比（涨红跌蓝）
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
          _$todayDiff.textContent = '较昨日 持平';
        }
      } else if (total > 0) {
        // 昨天无消费、今天有 → 新增
        _$todayDiff.innerHTML = '较昨日 <span class="home-overview__diff--up">新增 ↑</span>';
      } else {
        _$todayDiff.textContent = '';
      }
    }
  }

  /* -----------------------------------------------------------------
     本月消费 + 预算进度（简化版：金额 + 进度条）
     ----------------------------------------------------------------- */
  function _renderMonth() {
    const budget = ExpenseDB.getBudget();
    const monthTotal = ExpenseDB.getMonthTotal();
    const monthlyBudget = budget.monthlyTotal || 0;

    _$monthAmount.textContent = `¥${monthTotal.toFixed(2)}`;

    if (monthlyBudget > 0) {
      const percent = Math.min((monthTotal / monthlyBudget) * 100, 100);

      _$budgetLabel.textContent = `预算 ¥${monthlyBudget.toLocaleString()}`;
      _$budgetBar.style.display = '';
      _$budgetFill.style.width = `${percent}%`;
      _$setBudgetBtn.style.display = 'none';

      // 颜色分级
      _$budgetFill.className = 'progress-bar__fill';
      if (percent > 95)       _$budgetFill.classList.add('progress-bar__fill--over');
      else if (percent > 90)  _$budgetFill.classList.add('progress-bar__fill--danger');
      else if (percent > 80)  _$budgetFill.classList.add('progress-bar__fill--warn');
      else if (percent > 60)  _$budgetFill.classList.add('progress-bar__fill--watch');
      else                    _$budgetFill.classList.add('progress-bar__fill--safe');
    } else {
      _$budgetLabel.textContent = '未设预算';
      _$budgetBar.style.display = 'none';
      _$setBudgetBtn.style.display = '';
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
    let closest = null; // { catName, icon, budget, spent, pct, isTotal }
    for (const [catId, catBudget] of Object.entries(catBudgets)) {
      if (!catBudget || catBudget <= 0) continue;
      const spent = ExpenseDB.getCategorySpent(catId);
      const pct = Math.round((spent / catBudget) * 100);
      if (!closest || pct > closest.pct) {
        const cat = ExpenseDB.getCategory(catId);
        closest = {
          catName: cat ? cat.name : catId,
          icon: cat ? cat.icon : '📌',
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
        return;
      }
      const monthTotal = ExpenseDB.getMonthTotal();
      const pct = Math.round((monthTotal / monthlyBudget) * 100);
      closest = {
        catName: '月度总预算',
        icon: '📊',
        budget: monthlyBudget,
        spent: monthTotal,
        pct: pct,
        isTotal: true,
      };
    }

    const remaining = Math.max(0, 100 - closest.pct);

    // 剩余百分比颜色：>50% 绿色（健康）· 30-50% 黄色（警告）· <30% 红色（危险）
    let pctClass;
    if (remaining > 50)        pctClass = 'pct-safe';
    else if (remaining > 30)   pctClass = 'pct-warn';
    else                       pctClass = 'pct-danger';

    _$budgetAlert.style.display = '';
    _$budgetAlertIcon.textContent = closest.icon;
    _$budgetAlertText.innerHTML = `${closest.catName}预算剩余 <span class="${pctClass}">${remaining}%</span>`;
    _$budgetAlertNums.textContent = `¥${closest.spent.toFixed(0)} / ¥${closest.budget.toLocaleString()}`;
    _$budgetAlertFill.style.width = `${Math.min(closest.pct, 100)}%`;

    // 进度条颜色
    _$budgetAlertFill.className = 'progress-bar__fill';
    if (closest.pct > 95)       _$budgetAlertFill.classList.add('progress-bar__fill--over');
    else if (closest.pct > 90)  _$budgetAlertFill.classList.add('progress-bar__fill--danger');
    else if (closest.pct > 80)  _$budgetAlertFill.classList.add('progress-bar__fill--warn');
    else if (closest.pct > 60)  _$budgetAlertFill.classList.add('progress-bar__fill--watch');
    else                         _$budgetAlertFill.classList.add('progress-bar__fill--safe');
  }

  /* -----------------------------------------------------------------
     智能提醒
     基础版仅含预算相关提醒（5 条规则）
     ----------------------------------------------------------------- */
  function _renderAlerts() {
    const alertsSection = document.getElementById('home-alerts-section');
    const alerts = _generateAlerts();

    // 只有存在 warning 或 danger 级别的提醒时才显示整个区块
    // 纯 success（如"比上月少花"）不会撑开区块——正向反馈不强制占空间
    const hasImportant = alerts.some(a => a.level === 'warning' || a.level === 'danger');

    if (!hasImportant) {
      _$alerts.innerHTML = '';
      if (alertsSection) alertsSection.style.display = 'none';
      return;
    }
    if (alertsSection) alertsSection.style.display = '';

    // 最多展示 4 条，按级别排序（danger > warning > success）
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

    // 当天已关闭提醒的索引（localStorage，每日自动重置）
    const dismissedKey = `dismissed-alerts-${_todayStr()}`;
    let dismissed = [];
    try {
      dismissed = JSON.parse(localStorage.getItem(dismissedKey) || '[]');
    } catch (_) { dismissed = []; }

    // 过滤掉今天已关闭的提醒
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

    // 点击 ✕ 关闭单条提醒（持久化到当天，明天自动恢复）
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
        // 如果所有提醒都被关掉了，隐藏整个区块
        if (_$alerts.children.length === 0) {
          const section = document.getElementById('home-alerts-section');
          if (section) section.style.display = 'none';
        }
      });
    });
  }

  /**
   * 生成提醒列表
   * 基础版规则：仅预算相关
   */
  function _generateAlerts() {
    const alerts = [];
    const budget = ExpenseDB.getBudget();
    const monthTotal = ExpenseDB.getMonthTotal();
    const monthlyBudget = budget.monthlyTotal || 0;

    // 规则 1：总预算 > 95%
    if (monthlyBudget > 0 && monthTotal > monthlyBudget * 0.95) {
      const pct = Math.round((monthTotal / monthlyBudget) * 100);
      const remaining = monthlyBudget - monthTotal;
      alerts.push({
        level: 'danger', icon: '🔴',
        text: `本月已花掉预算的 ${pct}%，仅剩 ¥${Math.max(0, remaining).toFixed(0)}，建议控制`,
      });
    }
    // 规则 2：总预算 > 80%
    else if (monthlyBudget > 0 && monthTotal > monthlyBudget * 0.8) {
      const pct = Math.round((monthTotal / monthlyBudget) * 100);
      const remaining = monthlyBudget - monthTotal;
      alerts.push({
        level: 'warning', icon: '🟡',
        text: `本月已花 ¥${monthTotal.toFixed(0)}，占预算的 ${pct}%，剩余 ¥${remaining.toFixed(0)}`,
      });
    }

    // 规则 3 & 4 & 5：分类预算
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

      // 规则 5：比上月同期低 > 20%（正向反馈）
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
     最近 5 条记录（逻辑不变）
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
      // 显示日期/时间（今天/昨天直接显示时间，否则显示日期）
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

  /* =================================================================
     公开 API
     ================================================================= */
  return { render };
})();
