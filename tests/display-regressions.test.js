const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// 从页面加载链取当前模块，避免回归测试只覆盖已退役版本。
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function sourceFor(name) {
  const src = [...html.matchAll(/<script src="([^"?]+)(?:\?[^"]*)?"/g)]
    .map(match => match[1]).find(src => new RegExp(`/` + name + `(?:-v\\d+)?\\.js$`).test(src));
  return src ? fs.readFileSync(path.join(root, src), 'utf8') : '';
}

function load(name, today = '2026-09-02') {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) {
      const el = {
        innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
        classList: { add() {}, remove() {}, contains() { return false; } },
        querySelectorAll: () => [], setAttribute() {}, addEventListener() {},
      };
      el.parentElement = el;
      elements.set(id, el);
    }
    return elements.get(id);
  };
  const requests = [];
  const db = {
    today: () => today, yearMonth: () => today.slice(0, 7),
    dateToYMD: d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    getExpenses: () => [], getBudget: () => ({ monthlyTotal: 100, categories: {} }),
    getMonthTotal: () => 100.01, getCategory: () => ({ name: '餐饮' }),
    getCategorySpent: () => 0,
    getExpensesByDateRange: (from, to) => { requests.push({ from, to }); return []; },
  };
  const context = vm.createContext({
    console, Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [today + 'T12:00:00'])); }
    },
    document: { getElementById: getElement }, ExpenseDB: db,
    ExpenseCategories: { getIconMarkup: () => '' },
    localStorage: { getItem: () => null },
  });
  vm.runInContext(sourceFor('data') + '\n' + sourceFor('summary'), context);
  let source = sourceFor(name);
  const marker = source.lastIndexOf('return {');
  const hooks = name === 'stats'
    ? '_getPeriodRange, _calcPeriodSummary, _renderOverview, auditPeriod: p => _period = p,'
    : name === 'home' ? '_prevYearMonth,' : '_renderItem,';
  source = source.slice(0, marker) + source.slice(marker).replace('return {', 'return { ' + hooks);
  const ns = { home: 'ExpenseHome', stats: 'ExpenseStats', list: 'ExpenseList' }[name];
  vm.runInContext(source + `;globalThis.subject = ${ns};`, context);
  return { api: context.subject, db, requests, el: getElement };
}

test('周对比跨月时取紧邻的前 7 天，而不是更早月份', () => {
  const r = load('stats');
  r.api.auditPeriod('week');
  const range = r.api._getPeriodRange();
  r.api._calcPeriodSummary([], range.from, range.to);
  assert.deepEqual(r.requests, [{ from: '2026-08-20', to: '2026-08-26' }]);
});

test('当前月比较上月同期，月末自动截到上月末', () => {
  for (const [today, from, to] of [
    ['2026-09-13', '2026-08-01', '2026-08-13'],
    ['2026-03-31', '2026-02-01', '2026-02-28'],
    ['2024-03-31', '2024-02-01', '2024-02-29'],
    ['2026-01-02', '2025-12-01', '2025-12-02'],
  ]) {
    const r = load('stats', today);
    const range = r.api._getPeriodRange();
    r.api._calcPeriodSummary([], range.from, range.to);
    assert.deepEqual(r.requests, [{ from, to }]);
  }
});

test('31 日获取上月不溢出回本月', () => {
  for (const [date, expected] of [['2026-03-31', '2026-02'], ['2026-05-31', '2026-04'], ['2026-10-31', '2026-09']]) {
    assert.equal(load('home', date).api._prevYearMonth(), expected);
  }
});

test('首页和统计精确保留分，超出一分钱不显示已超零元', () => {
  const home = load('home');
  home.api.render();
  assert.match(home.el('home-budget-summary-remaining').innerHTML, /0\.01/);
  const stats = load('stats');
  stats.api._renderOverview([{ amount: 35.5 }, { amount: 0.01 }], '2026-09-01', '2026-09-02');
  assert.equal(stats.el('stats-card-total').textContent, '¥35.51');
  assert.equal(stats.el('stats-card-daily').textContent, '¥17.76');
});

test('首页本月比较与统计一样只使用上月同期', () => {
  const home = load('home', '2026-09-13');
  home.db.getExpenses = () => [
    { id: '1', date: '2026-09-02', amount: 20 },
    { id: '2', date: '2026-08-02', amount: 10 },
    { id: '3', date: '2026-08-31', amount: 100 },
  ];
  home.api.render();
  assert.match(home.el('home-month-diff').innerHTML, /100%/);
});

test('缺少上期记录时不伪造增长 100%', () => {
  const r = load('stats');
  const summary = r.api._calcPeriodSummary([{ amount: 10 }], '2026-09-01', '2026-09-02');
  assert.equal(summary.changePct, null);
});

test('跨年账单金额排序模式显示年份', () => {
  const r = load('list', '2026-09-13');
  const item = r.api._renderItem({ id: 'old', date: '2025-09-13', amount: 12, categoryId: 'food' }, { showDate: true });
  assert.match(item, /2025年9月13日/);
});

test('近3月和近12月比较同样进度的前周期，不再标成自然季度或整年', () => {
  for (const [period, from, to] of [
    ['3month', '2026-04-01', '2026-06-13'],
    ['12month', '2024-10-01', '2025-09-13'],
  ]) {
    const r = load('stats', '2026-09-13');
    r.api.auditPeriod(period);
    const range = r.api._getPeriodRange();
    const summary = r.api._calcPeriodSummary([], range.from, range.to);
    assert.deepEqual(r.requests, [{ from, to }]);
    assert.match(summary.compareLabel, /同期/);
  }
});

test('日均按日历天数计算，不受夏令时多出的一小时影响', () => {
  const r = load('stats', '2026-11-02');
  r.api._renderOverview([{ amount: 3 }], '2026-10-31', '2026-11-02');
  assert.equal(r.el('stats-card-daily').textContent, '¥1.00');
});

test('统计概览按分累加，0.1 + 0.2 精确为 0.30', () => {
  const r = load('stats');
  r.api._renderOverview([{ amount: 0.1 }, { amount: 0.2 }], '2026-09-02', '2026-09-02');
  assert.equal(r.el('stats-card-total').textContent, '¥0.30');
});

test('账单当年日期保持简洁，不额外显示年份', () => {
  const r = load('list', '2026-09-13');
  const item = r.api._renderItem({ id: 'new', date: '2026-09-13', amount: 12, categoryId: 'food' }, { showDate: true });
  assert.match(item, /9月13日/);
  assert.doesNotMatch(item, /2026年/);
});

test('0.1 + 0.2 刚好用完 0.3 元预算，首页卡片和提醒均不误报超支', () => {
  const r = load('home');
  r.db.getBudget = () => ({ monthlyTotal: 0.3, categories: {} });
  r.db.getMonthTotal = () => 0.1 + 0.2;
  r.api.render();
  assert.doesNotMatch(r.el('home-budget-summary-remaining').innerHTML, /已超/);
  assert.doesNotMatch(r.el('home-alerts').innerHTML, /已超/);
});
