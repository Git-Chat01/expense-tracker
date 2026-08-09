/* ================================================================
   消费轨迹系统 — 记账当下的预算影响
   只读取现有账单与预算，在内存中计算“记下这笔后”的结果。
   不写临时账单、不修改历史记录，也不进入保存校验链路。
   ================================================================ */

const ExpenseBudgetImpact = (() => {
  'use strict';

  var _baseline = null;
  var _bound = false;
  var _amountObserver = null;
  var _categoryObserver = null;
  var _announcementTimer = null;
  var _lastAnnouncedSignature = '';
  var _pendingAnnouncementSignature = '';
  var _elements = {};

  function _toCents(value) {
    var number = Number(value);
    if (!Number.isFinite(number)) return null;
    var cents = Math.round((number + Number.EPSILON) * 100);
    return Number.isSafeInteger(cents) ? cents : null;
  }

  function _isValidDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    var parts = value.split('-').map(Number);
    var date = new Date(parts[0], parts[1] - 1, parts[2]);
    return date.getFullYear() === parts[0]
      && date.getMonth() === parts[1] - 1
      && date.getDate() === parts[2];
  }

  function _localToday() {
    if (typeof ExpenseDB !== 'undefined' && typeof ExpenseDB.today === 'function') {
      return ExpenseDB.today();
    }
    var now = new Date();
    return now.getFullYear()
      + '-' + String(now.getMonth() + 1).padStart(2, '0')
      + '-' + String(now.getDate()).padStart(2, '0');
  }

  function _formatMoney(cents) {
    var absolute = Math.abs(Math.trunc(cents));
    var hasDecimal = absolute % 100 !== 0;
    return '¥' + (absolute / 100).toLocaleString('zh-CN', {
      minimumFractionDigits: hasDecimal ? 2 : 0,
      maximumFractionDigits: 2,
    });
  }

  function _monthLabel(yearMonth, today) {
    var parts = yearMonth.split('-');
    var todayParts = today.split('-');
    if (parts[0] === todayParts[0]) return Number(parts[1]) + '月';
    return Number(parts[0]) + '年' + Number(parts[1]) + '月';
  }

  function _stateFor(afterCents, limitCents) {
    var remaining = limitCents - afterCents;
    if (remaining < 0) return 'over';
    if (remaining === 0) return 'exhausted';
    var usage = afterCents / limitCents;
    if (usage >= 0.95) return 'danger';
    if (usage >= 0.8) return 'watch';
    return 'safe';
  }

  function _buildBaseline(snapshot) {
    if (!snapshot || snapshot.ok !== true) return { ok: false };

    var categories = Array.isArray(snapshot.categories) ? snapshot.categories : [];
    var expenses = Array.isArray(snapshot.expenses) ? snapshot.expenses : [];
    var categoryById = Object.create(null);
    var monthTotals = Object.create(null);
    var categoryTotals = Object.create(null);
    var budgetCategories = Object.create(null);

    categories.forEach(function (category) {
      if (!category || category.id === undefined || category.id === null) return;
      categoryById[String(category.id)] = category;
    });

    expenses.forEach(function (expense) {
      if (!expense || !/^\d{4}-\d{2}-\d{2}$/.test(String(expense.date || ''))) return;
      var cents = _toCents(expense.amount);
      if (cents === null || cents <= 0) return;

      var yearMonth = String(expense.date).slice(0, 7);
      monthTotals[yearMonth] = (monthTotals[yearMonth] || 0) + cents;

      var cursor = expense.categoryId === undefined || expense.categoryId === null
        ? ''
        : String(expense.categoryId);
      var visited = Object.create(null);
      var safety = 0;
      while (cursor && !visited[cursor] && safety <= categories.length) {
        visited[cursor] = true;
        var key = yearMonth + '\u0000' + cursor;
        categoryTotals[key] = (categoryTotals[key] || 0) + cents;
        var current = categoryById[cursor];
        cursor = current && current.parentId ? String(current.parentId) : '';
        safety += 1;
      }
    });

    var budget = snapshot.budget && typeof snapshot.budget === 'object'
      ? snapshot.budget
      : { monthlyTotal: 0, categories: {} };
    var monthlyBudgetCents = _toCents(budget.monthlyTotal);
    if (monthlyBudgetCents === null || monthlyBudgetCents <= 0) monthlyBudgetCents = 0;

    var rawCategoryBudgets = budget.categories && typeof budget.categories === 'object'
      ? budget.categories
      : {};
    Object.keys(rawCategoryBudgets).forEach(function (categoryId) {
      var cents = _toCents(rawCategoryBudgets[categoryId]);
      if (cents !== null && cents > 0) budgetCategories[String(categoryId)] = cents;
    });

    return {
      ok: true,
      categoryById: categoryById,
      monthTotals: monthTotals,
      categoryTotals: categoryTotals,
      monthlyBudgetCents: monthlyBudgetCents,
      categoryBudgets: budgetCategories,
    };
  }

  function _findBudgetScope(categoryId, baseline) {
    if (!categoryId || !baseline.categoryById[categoryId]) return null;

    var cursor = categoryId;
    var visited = Object.create(null);
    var safety = 0;
    var categoryCount = Object.keys(baseline.categoryById).length;
    while (cursor && !visited[cursor] && safety <= categoryCount) {
      visited[cursor] = true;
      if (baseline.categoryBudgets[cursor] > 0) {
        var category = baseline.categoryById[cursor];
        return {
          id: cursor,
          name: String(category.name || '该分类'),
          limitCents: baseline.categoryBudgets[cursor],
        };
      }
      var current = baseline.categoryById[cursor];
      cursor = current && current.parentId ? String(current.parentId) : '';
      safety += 1;
    }
    return null;
  }

  function _budgetResult(kind, scopeId, label, beforeCents, amountCents, limitCents) {
    var afterCents = beforeCents + amountCents;
    if (!Number.isSafeInteger(afterCents)) return null;
    var remainingCents = limitCents - afterCents;
    return {
      kind: kind,
      scopeId: scopeId,
      label: label,
      afterCents: afterCents,
      remainingCents: remainingCents,
      usage: afterCents / limitCents,
      state: _stateFor(afterCents, limitCents),
    };
  }

  function _choosePrimary(categoryResult, totalResult) {
    if (!categoryResult) return totalResult;
    if (!totalResult) return categoryResult;

    // 使用率本身已连续覆盖安全、临界、用完和超支，直接比较比五档粗排更准确。
    // 使用率完全相同时，超支金额更大的风险优先；仍相同则分类更便于当下决策。
    var usageDelta = categoryResult.usage - totalResult.usage;
    if (Math.abs(usageDelta) > 1e-9) return usageDelta > 0 ? categoryResult : totalResult;

    var categoryOver = Math.max(0, -categoryResult.remainingCents);
    var totalOver = Math.max(0, -totalResult.remainingCents);
    if (categoryOver !== totalOver) return categoryOver > totalOver ? categoryResult : totalResult;
    return categoryResult;
  }

  function _presentBudget(result) {
    var prefix = result.kind === 'total' ? '本月' : result.label;
    if (result.state === 'over') {
      return {
        visible: true,
        state: 'over',
        copy: '记下后，' + prefix + '将超预算',
        value: _formatMoney(-result.remainingCents),
        announcementKey: result.kind + ':' + result.scopeId + ':over',
      };
    }
    if (result.state === 'exhausted') {
      return {
        visible: true,
        state: 'exhausted',
        copy: '记下后，' + prefix + '预算刚好用完',
        value: '',
        announcementKey: result.kind + ':' + result.scopeId + ':exhausted',
      };
    }
    return {
      visible: true,
      state: result.state,
      copy: '记下后，' + prefix + '预算还剩',
      value: _formatMoney(result.remainingCents),
      announcementKey: result.kind + ':' + result.scopeId + ':' + result.state,
    };
  }

  /**
   * 纯计算入口，供浏览器行为测试直接验证，不读取或写入任何存储。
   */
  function calculate(formState, snapshot, todayOverride) {
    var baseline = _buildBaseline(snapshot);
    return _calculateWithBaseline(formState, baseline, todayOverride);
  }

  function _calculateWithBaseline(formState, baseline, todayOverride) {
    var amount = parseFloat(formState && formState.amountRaw);
    var amountCents = _toCents(amount);
    if (amountCents === null || amountCents <= 0) {
      return { visible: false, reason: 'invalid-amount' };
    }
    if (!baseline || baseline.ok !== true) {
      return { visible: false, reason: 'snapshot-unavailable' };
    }

    var today = _isValidDate(todayOverride) ? todayOverride : _localToday();
    var requestedDate = formState && formState.date ? String(formState.date) : '';
    var effectiveDate = _isValidDate(requestedDate) ? requestedDate : today;
    var selectedMonth = effectiveDate.slice(0, 7);
    var currentMonth = today.slice(0, 7);
    var monthAfterCents = (baseline.monthTotals[selectedMonth] || 0) + amountCents;

    if (!Number.isSafeInteger(monthAfterCents)) {
      return { visible: false, reason: 'amount-overflow' };
    }

    // 项目没有按月保存预算历史，跨月补记只陈述累计事实，不套当前预算。
    if (selectedMonth !== currentMonth) {
      return {
        visible: true,
        state: 'neutral',
        copy: '记下后，' + _monthLabel(selectedMonth, today) + '累计',
        value: _formatMoney(monthAfterCents),
        announcementKey: 'cumulative:' + selectedMonth,
      };
    }

    var totalResult = null;
    if (baseline.monthlyBudgetCents > 0) {
      totalResult = _budgetResult(
        'total',
        currentMonth,
        '本月',
        baseline.monthTotals[currentMonth] || 0,
        amountCents,
        baseline.monthlyBudgetCents
      );
    }

    var categoryId = formState && formState.categoryId
      ? String(formState.categoryId)
      : '';
    var scope = _findBudgetScope(categoryId, baseline);
    var categoryResult = null;
    if (scope) {
      categoryResult = _budgetResult(
        'category',
        scope.id,
        scope.name,
        baseline.categoryTotals[currentMonth + '\u0000' + scope.id] || 0,
        amountCents,
        scope.limitCents
      );
    }

    var primary = _choosePrimary(categoryResult, totalResult);
    if (primary) return _presentBudget(primary);

    // 未设置预算也不增加操作成本：只显示准确的本月累计。
    return {
      visible: true,
      state: 'neutral',
      copy: '记下后，本月累计',
      value: _formatMoney(monthAfterCents),
      announcementKey: 'cumulative:' + currentMonth,
    };
  }

  function invalidate() {
    _baseline = null;
  }

  function _readFormState() {
    var amountWhole = document.getElementById('add-amount-display');
    var amountDecimal = document.getElementById('add-amount-decimal');
    var dateInput = document.getElementById('add-date');
    var categoryId = '';
    if (typeof ExpenseCategories !== 'undefined' && typeof ExpenseCategories.getSelectedId === 'function') {
      categoryId = ExpenseCategories.getSelectedId() || '';
    }
    return {
      amountRaw: (amountWhole ? amountWhole.textContent.trim() : '0')
        + (amountDecimal ? amountDecimal.textContent.trim() : '.00'),
      categoryId: categoryId,
      date: dateInput ? dateInput.value : '',
    };
  }

  function _ensureBaseline() {
    if (_baseline) return _baseline;
    if (typeof ExpenseDB === 'undefined' || typeof ExpenseDB.getBudgetImpactSnapshot !== 'function') {
      _baseline = { ok: false };
      return _baseline;
    }
    _baseline = _buildBaseline(ExpenseDB.getBudgetImpactSnapshot());
    return _baseline;
  }

  function _render(result) {
    var root = _elements.root;
    if (!root) return;

    if (!result || result.visible !== true) {
      root.classList.add('add-budget-impact--empty');
      root.setAttribute('aria-hidden', 'true');
      root.removeAttribute('data-state');
      _elements.copy.textContent = '';
      _elements.value.textContent = '';
      _lastAnnouncedSignature = '';
      _pendingAnnouncementSignature = '';
      if (_announcementTimer) clearTimeout(_announcementTimer);
      _announcementTimer = null;
      _elements.live.textContent = '';
      return;
    }

    root.classList.remove('add-budget-impact--empty');
    root.setAttribute('aria-hidden', 'false');
    root.setAttribute('data-state', result.state || 'neutral');
    _elements.copy.textContent = result.copy || '';
    _elements.value.textContent = result.value || '';

    // 数字每次变化都即时展示；读屏只在状态等级/作用域变化时播报，避免逐键打断。
    var announcementSignature = [result.announcementKey, result.copy, result.value].join('|');
    if (_announcementTimer) clearTimeout(_announcementTimer);
    _announcementTimer = null;
    _pendingAnnouncementSignature = announcementSignature;
    if (announcementSignature !== _lastAnnouncedSignature) {
      _elements.live.textContent = '';
      _announcementTimer = setTimeout(function () {
        _announcementTimer = null;
        if (_pendingAnnouncementSignature !== announcementSignature) return;
        if (root.classList.contains('add-budget-impact--empty')) return;
        _lastAnnouncedSignature = announcementSignature;
        _elements.live.textContent = [result.copy, result.value].filter(Boolean).join(' ');
      }, 450);
    } else if (!_elements.live.textContent) {
      // 从未播报完成的新状态退回当前状态时，恢复准确文案，不让旧定时器留下空或过时内容。
      _elements.live.textContent = [result.copy, result.value].filter(Boolean).join(' ');
    }
  }

  function refreshFromDom(options) {
    options = options || {};
    if (options.invalidate) invalidate();
    if (!_elements.root) return;

    var formState = _readFormState();
    var amount = parseFloat(formState.amountRaw);
    if (!Number.isFinite(amount) || amount <= 0) {
      // 保存、清空或切页都会回到空金额；下次输入时重建，确保包含最新账单。
      invalidate();
      _render({ visible: false, reason: 'invalid-amount' });
      return;
    }

    _render(_calculateWithBaseline(formState, _ensureBaseline()));
  }

  function _refreshAfterCurrentEvent(invalidateFirst) {
    setTimeout(function () {
      refreshFromDom({ invalidate: invalidateFirst });
    }, 0);
  }

  function _bindEvents() {
    if (_bound) return;
    _bound = true;

    var amountWhole = document.getElementById('add-amount-display');
    var amountDecimal = document.getElementById('add-amount-decimal');
    var categorySummary = document.getElementById('add-category-summary');

    if (typeof MutationObserver !== 'undefined') {
      _amountObserver = new MutationObserver(function () { refreshFromDom(); });
      [amountWhole, amountDecimal].forEach(function (element) {
        if (element) _amountObserver.observe(element, { childList: true, characterData: true, subtree: true });
      });

      if (categorySummary) {
        _categoryObserver = new MutationObserver(function () { refreshFromDom(); });
        _categoryObserver.observe(categorySummary, {
          attributes: true,
          childList: true,
          characterData: true,
          subtree: true,
        });
      }
    }

    document.addEventListener('change', function (event) {
      if (event.target && event.target.id === 'add-date') refreshFromDom();
    });

    document.addEventListener('click', function (event) {
      var target = event.target && event.target.closest ? event.target.closest('button') : null;
      if (!target) return;

      if (target.matches('[data-view="add"]')) {
        _refreshAfterCurrentEvent(true);
        return;
      }
      if (target.matches('[data-date-shortcut], [data-quick-cat-id], [data-cat-id], .add-merchant-suggestion')) {
        _refreshAfterCurrentEvent(false);
        return;
      }
      if (target.matches('#new-cat-save, #edit-cat-save, #budget-btn-save, #budget-btn-reset')) {
        _refreshAfterCurrentEvent(true);
        return;
      }
      if (target.matches('.toast__action, .confirm-dialog__ok')) {
        _refreshAfterCurrentEvent(true);
      }
    });

    window.addEventListener('storage', function (event) {
      if (!event.key || event.key.indexOf('expense_tracker_') === 0) {
        refreshFromDom({ invalidate: true });
      }
    });

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') refreshFromDom({ invalidate: true });
    });

    window.addEventListener('pageshow', function () {
      refreshFromDom({ invalidate: true });
    });
  }

  function init() {
    _elements = {
      root: document.getElementById('add-budget-impact'),
      copy: document.getElementById('add-budget-impact-copy'),
      value: document.getElementById('add-budget-impact-value'),
      live: document.getElementById('add-budget-impact-live'),
    };
    if (!_elements.root || !_elements.copy || !_elements.value || !_elements.live) return;
    _bindEvents();
    refreshFromDom({ invalidate: true });
  }

  return {
    init: init,
    invalidate: invalidate,
    refreshFromDom: refreshFromDom,
    calculate: calculate,
  };
})();

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ExpenseBudgetImpact.init);
  } else {
    ExpenseBudgetImpact.init();
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ExpenseBudgetImpact;
}
