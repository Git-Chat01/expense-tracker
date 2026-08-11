const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/** 内存版 localStorage（与其它域测试一致） */
class MemoryStorage {
  constructor() {
    this.values = new Map();
  }
  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }
  setItem(key, value) {
    this.values.set(String(key), String(value));
  }
  removeItem(key) {
    this.values.delete(String(key));
  }
}

/**
 * 在 vm 沙箱中加载 home.js 并跑完整 render()：
 * - stub 最小 DOM / ExpenseDB / ExpenseData / ExpenseCategories
 * - 用可变状态（today / yearMonth / monthTotal / budget）模拟跨天、跨月、状态升级
 * - 预警忽略按钮通过 stub 的 addEventListener 捕获回调后手动触发
 */
function loadHome(initial) {
  const storage = new MemoryStorage();
  const elements = new Map();

  // 可变状态（闭包），测试中通过返回对象的方法改写
  let today = initial.today || '2026-08-11';
  let yearMonth = initial.yearMonth || '2026-08';
  let monthTotal = initial.monthTotal || 0;
  let budget = initial.budget || { monthlyTotal: 0, categories: {} };
  const categorySpent = new Map(Object.entries(initial.categorySpent || {}));

  function makeEl() {
    const el = {
      innerHTML: '',
      textContent: '',
      className: '',
      style: {},
      dataset: {},
      children: [],
      classList: { add() {}, remove() {}, contains() { return false; } },
      querySelectorAll() { return []; },
      addEventListener() {},
      remove() {},
      appendChild() {},
      setAttribute() {},
      // 进度条等会取父级设置 aria 属性；stub 自引用即可
      parentElement: null,
    };
    el.parentElement = el;
    return el;
  }

  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeEl());
      return elements.get(id);
    },
  };

  const expenseDB = {
    today: () => today,
    yearMonth: () => yearMonth,
    dateToYMD: (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`,
    getBudget: () => budget,
    getMonthTotal: () => monthTotal,
    getCategorySpent: (catId) => categorySpent.get(catId) || 0,
    getCategory: (id) => ({ id, name: '餐饮', parentId: 'food' }),
    getExpenses: () => [],
  };
  const expenseData = {
    escapeHtml: (s) => String(s),
    PAYMENT_METHODS: [],
  };
  const expenseCategories = { getIconMarkup: () => '' };

  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    localStorage: storage,
    document: documentStub,
    ExpenseDB: expenseDB,
    ExpenseData: expenseData,
    ExpenseCategories: expenseCategories,
  });

  const homeSource = fs.readFileSync(path.join(__dirname, '..', 'js/home.js'), 'utf8');
  // 钩子代码与模块源码拼接在同一脚本作用域，才能访问顶层 const ExpenseHome
  // （vm 上下文中顶层 const 不会挂到 context 全局对象上）
  vm.runInContext(
    `${homeSource}\n;globalThis.__homeAlertTest = { render: ExpenseHome.render };`,
    context,
    { filename: 'js/home.js' },
  );

  const render = context.__homeAlertTest.render;

  return {
    render,
    setToday: (v) => { today = v; },
    setYearMonth: (v) => { yearMonth = v; },
    setMonthTotal: (v) => { monthTotal = v; },
    setBudget: (b) => { budget = b; },
    setCategorySpent: (catId, v) => categorySpent.set(catId, v),
    getAlertsEl: () => elements.get('home-alerts'),
    getAlertsSection: () => elements.get('home-alerts-section'),
    getStorage: () => storage,
    /** 模拟用户点击第 idx 个忽略按钮（需先经 replaceCloseButtons 注入按钮） */
    clickDismiss(idx) {
      const btn = this._buttons[idx];
      assert.ok(btn, `忽略按钮 #${idx} 不存在（先调用 replaceCloseButtons）`);
      btn.cb();
    },
    /** 替换 home-alerts 的 querySelectorAll，注入可捕获回调的忽略按钮 */
    replaceCloseButtons(keys) {
      const buttons = keys.map(([alertKey, alertLevel]) => {
        const btn = {
          dataset: { alertKey, alertLevel },
          closest: () => ({ remove() {} }),
          addEventListener(type, cb) { btn.cb = cb; },
        };
        return btn;
      });
      this.getAlertsEl().querySelectorAll = () => buttons;
      this._buttons = buttons;
    },
  };
}

/** 预警区当前渲染出的文本（无按钮时也返回，便于断言内容） */
function alertText(home) {
  return home.getAlertsEl().innerHTML;
}

test('home.js：80% 提示档忽略后当月不再重复出现', () => {
  const home = loadHome({
    budget: { monthlyTotal: 5000, categories: {} },
    monthTotal: 4200, // 84%
  });

  home.render();
  assert.match(alertText(home), /占预算的 84%/);

  // 用户点击「忽略」→ 忽略记录按 key 落库
  home.replaceCloseButtons([['total-80', 'warning']]);
  home.render();
  home.clickDismiss(0);
  assert.deepEqual(
    JSON.parse(home.getStorage().getItem('alert-dismissed-2026-08')),
    { 'total-80': true },
  );

  // 同月再次 render → 不再出现（没有「占预算的」文案，也没有 section）
  home.replaceCloseButtons([]);
  home.render();
  assert.doesNotMatch(alertText(home), /占预算的/);
  assert.equal(home.getAlertsSection().style.display, 'none');
});

test('home.js：80% 档忽略后，消费升级到 95% 出新提醒', () => {
  const home = loadHome({
    budget: { monthlyTotal: 5000, categories: {} },
    monthTotal: 4200, // 84% → warning
  });

  home.render();
  home.replaceCloseButtons([['total-80', 'warning']]);
  home.render();
  home.clickDismiss(0);

  // 继续花到 98% → 状态升级，95% 档是新 key，不受忽略影响
  home.setMonthTotal(4900);
  home.replaceCloseButtons([]);
  home.render();
  assert.match(alertText(home), /已花掉预算的 98%/);
});

test('home.js：95% 警告档忽略后当月不再重复，次日也不出现', () => {
  const home = loadHome({
    budget: { monthlyTotal: 5000, categories: {} },
    monthTotal: 4800, // 96% → danger
  });

  home.render();
  assert.match(alertText(home), /已花掉预算的 96%/);

  // 今天忽略 → 记录存 true，同月当天再 render 不出现
  home.replaceCloseButtons([['total-95', 'danger']]);
  home.render();
  home.clickDismiss(0);
  assert.deepEqual(
    JSON.parse(home.getStorage().getItem('alert-dismissed-2026-08')),
    { 'total-95': true },
  );

  home.replaceCloseButtons([]);
  home.render();
  assert.equal(home.getAlertsSection().style.display, 'none');

  // 次日也不再提醒（与 80% 档一致，不再每天面对一次）
  home.setToday('2026-08-12');
  home.render();
  assert.equal(home.getAlertsSection().style.display, 'none');

  // 下月 → 提醒规则重新生效
  home.setYearMonth('2026-09');
  home.render();
  assert.match(alertText(home), /已花掉预算的 96%/);
});

test('home.js：分类 80% 档忽略后当月不再重复，90% 档为独立提醒', () => {
  const home = loadHome({
    budget: { monthlyTotal: 0, categories: { food: 2000 } },
    categorySpent: { food: 1700 }, // 85% → cat warning
  });

  home.render();
  assert.match(alertText(home), /「餐饮」已花 ¥1700/);

  home.replaceCloseButtons([['cat-food-80', 'warning']]);
  home.render();
  home.clickDismiss(0);

  home.replaceCloseButtons([]);
  home.render();
  assert.doesNotMatch(alertText(home), /「餐饮」已花 ¥1700/);

  // 升级到 92% → cat-90 是新 key，照常提醒
  home.setCategorySpent('food', 1840);
  home.render();
  assert.match(alertText(home), /「餐饮」预算已使用 92%/);
});

test('home.js：忽略记录按月隔离，跨月后提醒规则重新生效', () => {
  const home = loadHome({
    budget: { monthlyTotal: 5000, categories: {} },
    monthTotal: 4200, // 84%
  });

  home.render();
  home.replaceCloseButtons([['total-80', 'warning']]);
  home.render();
  home.clickDismiss(0);

  // 下月：月度消费归零，仍花到 84% → 上月忽略记录不生效，提醒重新出现
  home.setYearMonth('2026-09');
  home.setMonthTotal(4200);
  home.replaceCloseButtons([]);
  home.render();
  assert.match(alertText(home), /占预算的 84%/);
  // 忽略记录按新月份 key 隔离，未继承上月数据
  assert.equal(home.getStorage().getItem('alert-dismissed-2026-09'), null);
});

test('home.js：旧版按天索引忽略数据不影响新逻辑', () => {
  const home = loadHome({
    budget: { monthlyTotal: 5000, categories: {} },
    monthTotal: 4200,
  });
  // 模拟旧版本残留的按天索引数组（新逻辑不再读取）
  home.getStorage().setItem('dismissed-alerts-2026-08-11', '[0]');

  home.render();
  assert.match(alertText(home), /占预算的 84%/, '旧索引数据不应误屏蔽新提醒');
});
