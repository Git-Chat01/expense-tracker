const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));

function load({ today = '2026-10-27', expenses = [], categories = {} } = {}) {
  const nodes = new Map();
  function element(tag = 'div') {
    const classes = new Set();
    const el = {
      tagName: tag.toUpperCase(), id: '', className: '', dataset: {}, style: {}, children: [], listeners: {},
      textContent: '', value: '', disabled: false,
      classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); }, contains: name => classes.has(name) },
      setAttribute(name, value) { this[name] = value; },
      addEventListener(name, fn) { this.listeners[name] = fn; },
      appendChild(child) { child.parentElement = this; this.children.push(child); if (child.id) nodes.set(child.id, child); },
      insertBefore(child) { this.appendChild(child); },
      remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); },
      closest(selector) { return selector === '.stats-chart-wrapper' ? this.wrapper : null; },
      querySelector(selector) { return this.children.find(x => '.' + x.className === selector) || null; },
      querySelectorAll(selector) { return selector === '[data-stats-category]' ? this.buttons || [] : []; },
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this.html || ''; },
      set(html) {
        this.html = html;
        for (const match of html.matchAll(/<(\w+)[^>]*\bid="([^"]+)"/g)) {
          const node = element(match[1]); node.id = match[2]; nodes.set(node.id, node);
        }
        this.buttons = [...html.matchAll(/<button\b[^>]*data-idx="(\d+)"[^>]*data-stats-category="([^"]+)"[^>]*>/g)].map(match => {
          const button = element('button'); button.dataset = { idx: match[1], statsCategory: match[2] }; return button;
        });
      },
    });
    return el;
  }
  for (const id of ['stats-container', 'stats-dynamic', 'stats-card-total', 'stats-card-daily', 'stats-card-count', 'stats-category-chart', 'stats-category-fallback']) {
    const el = element(); el.id = id; nodes.set(id, el);
  }
  const wrapper = element();
  nodes.get('stats-category-chart').wrapper = wrapper;
  const chips = ['day', 'week', 'month', '3month', '12month'].map(period => {
    const chip = element('button'); chip.dataset.period = period; return chip;
  });
  const queries = [], opened = [];
  const db = {
    today: () => today,
    getCategory: id => categories[id] || null,
    getExpensesByDateRange(from, to) { queries.push({ from, to }); return expenses.filter(e => e.date >= from && e.date <= to); },
  };
  const context = vm.createContext({
    console, Date, setTimeout, clearTimeout,
    document: {
      createElement: element,
      getElementById: id => nodes.get(id) || null,
      querySelector: selector => selector === '.stats-container' ? nodes.get('stats-container') : null,
      querySelectorAll: selector => selector === '.stats-period .chip' ? chips : [],
    },
    window: { addEventListener() {} }, ExpenseDB: db,
    ExpenseApp: { openStatsExpenses: payload => opened.push(payload) },
  });
  vm.runInContext(fs.readFileSync(path.join(root, 'js/data.js'), 'utf8') + '\n'
    + fs.readFileSync(path.join(root, 'js/summary-v224.js'), 'utf8'), context);
  let source = fs.readFileSync(path.join(root, 'js/stats-v230.js'), 'utf8');
  const marker = source.lastIndexOf('return {');
  source = source.slice(0, marker) + source.slice(marker).replace('return {', `return {
    _monthRange, _getPeriodRange, _calcPeriodSummary, _renderOverview, _categoryGroups, _renderCategoryChart,
    _selectMonth, _moveMonth, _renderPeriodHeading,
    auditState: (month, period = 'month') => { _selectedMonth = month; _period = period; },
  `);
  vm.runInContext(source + ';globalThis.subject = ExpenseStats;', context);
  return { api: context.subject, el: id => nodes.get(id), wrapper, chips, queries, opened };
}

test('历史月份包含完整月末和闰日，当前月止于今天', () => {
  const r = load();
  for (const [month, from, to] of [
    ['2026-09', '2026-09-01', '2026-09-30'], ['2026-02', '2026-02-01', '2026-02-28'],
    ['2024-02', '2024-02-01', '2024-02-29'], ['2025-12', '2025-12-01', '2025-12-31'],
    ['2026-10', '2026-10-01', '2026-10-27'],
  ]) assert.deepEqual(plain(r.api._monthRange(month, '2026-10-27')), { from, to });
  for (const month of ['', '2026-11', '2027-01', '2026-00', '2026-13', '2026-1', '0000-01', '<img>']) {
    assert.equal(r.api._monthRange(month, '2026-10-27'), null);
  }
});

test('历史二月与完整一月比较，跨年与闰年口径一致', () => {
  for (const [month, from, to] of [
    ['2026-02', '2026-01-01', '2026-01-31'], ['2024-02', '2024-01-01', '2024-01-31'],
    ['2026-03', '2026-02-01', '2026-02-28'], ['2026-01', '2025-12-01', '2025-12-31'],
  ]) {
    const r = load(); r.api.auditState(month);
    const range = r.api._getPeriodRange();
    const summary = r.api._calcPeriodSummary([], range.from, range.to);
    assert.deepEqual(r.queries, [{ from, to }]);
    assert.equal(summary.compareLabel, '上月');
  }
});

test('当前月只比较上月同期并排除未来预记，未改变滚动周期', () => {
  const r = load({ expenses: [
    { date: '2026-09-27', amount: 10 }, { date: '2026-09-30', amount: 990 },
    { date: '2026-10-27', amount: 20 }, { date: '2026-10-31', amount: 980 },
  ] });
  const range = r.api._getPeriodRange();
  assert.deepEqual(plain(range), { from: '2026-10-01', to: '2026-10-27' });
  const summary = r.api._calcPeriodSummary([{ amount: 20 }], range.from, range.to);
  assert.equal(summary.prevTotal, 10);
  assert.equal(summary.changePct, 100);
  assert.equal(summary.compareLabel, '上月同期');
  for (const [period, from] of [['day', '2026-10-27'], ['week', '2026-10-21'], ['3month', '2026-08-01'], ['12month', '2025-11-01']]) {
    r.api.auditState('', period);
    assert.deepEqual(plain(r.api._getPeriodRange()), { from, to: '2026-10-27' });
  }
});

test('日均使用所选月全部天数，当前月使用已经过天数', () => {
  const r = load();
  r.api._renderOverview([{ amount: 280 }], '2026-02-01', '2026-02-28');
  assert.equal(r.el('stats-card-daily').textContent, '¥10.00');
  r.api._renderOverview([{ amount: 270 }], '2026-10-01', '2026-10-27');
  assert.equal(r.el('stats-card-daily').textContent, '¥10.00');
});

test('空月份仍可上一月/下一月/直接跳月，本月快捷钮恢复当前区间', () => {
  const r = load();
  r.api.initPeriodSelector();
  assert.equal(r.el('stats-month-next').disabled, true);
  r.el('stats-month-prev').listeners.click();
  assert.equal(r.el('stats-month-input').value, '2026-09');
  assert.match(r.el('stats-dynamic').innerHTML, /2026年9月暂无消费数据/);
  assert.match(r.el('stats-range-label').textContent, /2026\/09\/30.*完整月份/);
  r.el('stats-month-input').listeners.change({ target: { value: '2026-02' } });
  assert.equal(r.api._getPeriodRange().to, '2026-02-28');
  assert.equal(r.api._selectMonth('2026-11'), false);
  assert.equal(r.el('stats-month-input').value, '2026-02');
  r.chips.find(chip => chip.dataset.period === 'month').listeners.click();
  assert.equal(r.el('stats-month-input').value, '2026-10');
  assert.equal(r.el('stats-month-next').disabled, true);
  assert.equal(r.api._getPeriodRange().to, '2026-10-27');
});

test('父级、自身、子分类与未知历史分类的明细集合逐组金额一致，不改原账单', () => {
  const categories = {
    food: { id: 'food', name: '餐饮' }, coffee: { id: 'coffee', name: '咖啡', parentId: 'food' },
    lunch: { id: 'lunch', name: '午餐', parentId: 'food' },
    retired: { id: 'retired', name: '历史分类', deleted: true },
  };
  const expenses = Object.freeze([
    { categoryId: 'food', amount: 0.1 }, { categoryId: 'coffee', amount: 0.2 },
    { categoryId: 'lunch', amount: 12.34 }, { categoryId: 'retired', amount: 1.01 },
    { categoryId: 'missing-a', amount: 3.21 }, { categoryId: 'missing-b', amount: 4.56 },
  ].map(Object.freeze));
  const before = JSON.stringify(expenses), r = load({ categories });
  const groups = r.api._categoryGroups(expenses);
  assert.deepEqual(Array.from(groups.find(g => g.sourceCategoryId === 'category:food').categoryIds), ['food', 'coffee', 'lunch']);
  assert.deepEqual(Array.from(groups.find(g => g.sourceCategoryId === 'uncategorized').categoryIds), ['missing-a', 'missing-b']);
  for (const group of groups) {
    const cents = expenses.filter(e => group.categoryIds.includes(e.categoryId)).reduce((sum, e) => sum + Math.round(e.amount * 100), 0);
    assert.equal(Math.round(group.amount * 100), cents);
  }
  assert.equal(JSON.stringify(expenses), before);
});

test('超过八组的其他项保留全部实际分类 ID，金额与明细完全相等', () => {
  const categories = {}, expenses = [];
  for (let i = 0; i < 12; i++) {
    categories['c' + i] = { id: 'c' + i, name: '分类' + i };
    expenses.push({ categoryId: 'c' + i, amount: i + .01 });
  }
  const groups = load({ categories }).api._categoryGroups(expenses);
  assert.equal(groups.length, 9);
  const other = groups.find(g => g.sourceCategoryId === 'other');
  assert.equal(other.categoryIds.length, 4);
  assert.equal(Math.round(other.amount * 100), expenses.filter(e => other.categoryIds.includes(e.categoryId)).reduce((sum, e) => sum + Math.round(e.amount * 100), 0));
  assert.equal(new Set(groups.flatMap(g => Array.from(g.categoryIds))).size, 12);
});

test('Chart.js 不可用时分类按钮仍带正确月份与精确分类集合打开明细，名称安全转义', () => {
  const label = '<img src=x onerror="evil()">';
  const r = load({ categories: { food: { id: 'food', name: label }, coffee: { id: 'coffee', parentId: 'food', name: '咖啡' } } });
  r.api.auditState('2026-02');
  r.api._renderCategoryChart([{ categoryId: 'coffee', amount: 0.1 }, { categoryId: 'food', amount: 0.2 }]);
  assert.equal(r.wrapper.classList.contains('stats-category-panel--fallback'), true);
  const legend = r.wrapper.querySelector('.stats-chart-legend');
  assert.match(legend.innerHTML, /&lt;img/);
  assert.doesNotMatch(legend.innerHTML, /<img/);
  assert.equal(legend.buttons.length, 1);
  legend.buttons[0].listeners.click();
  assert.deepEqual(plain(r.opened[0]), {
    dateFrom: '2026-02-01', dateTo: '2026-02-28', categoryIds: ['coffee', 'food'],
    label: '2026年2月 · ' + label, sourceCategoryId: 'category:food',
  });
});
