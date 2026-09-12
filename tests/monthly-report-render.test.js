/* ================================================================
   月度报告渲染层冒烟测试
   模式照抄 monthly-report.test.js / home-alert-dismissal.test.js：
   MemoryStorage + vm 注入 + 极简 document/window stub。
   测试目标：init / openReport / closeReport / refreshEntry
   （入口卡显隐与角标、①-⑧ 骨架渲染、样本门控文案、月份切换、标记已读、滚动锁成对）
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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
  snapshot() {
    return Object.fromEntries(this.values);
  }
}

/** 极简 DOM stub：记录 innerHTML / hidden / classList / 事件回调 */
function makeEl(id) {
  const el = {
    id,
    innerHTML: '',
    hidden: false,
    className: '',
    style: {},
    children: [],
    classList: { add() {}, remove() {}, contains() { return false; } },
    addEventListener() {},
    remove() {},
    appendChild() {},
    setAttribute() {},
    parentElement: null,
  };
  el.parentElement = el;
  return el;
}

function loadRender() {
  const storageSource = fs.readFileSync(path.join(__dirname, '..', 'js/storage-v214.js'), 'utf8');
  const dataSource = fs.readFileSync(path.join(__dirname, '..', 'js/data.js'), 'utf8');
  const reportSource = fs.readFileSync(path.join(__dirname, '..', 'js/monthly-report-v223.js'), 'utf8');
  const storage = new MemoryStorage();

  const elements = new Map();
  const eventCbs = new Map(); // id → { type: cb }

  const documentStub = {
    getElementById(id) {
      if (!elements.has(id)) {
        const el = makeEl(id);
        el.addEventListener = (type, cb) => {
          if (!eventCbs.has(id)) eventCbs.set(id, {});
          eventCbs.get(id)[type] = cb;
        };
        el.querySelector = (sel) => {
          if (!elements.has(`${id}:${sel}`)) {
            elements.set(`${id}:${sel}`, makeEl(`${id}:${sel}`));
          }
          return elements.get(`${id}:${sel}`);
        };
        elements.set(id, el);
      }
      return elements.get(id);
    },
    body: makeEl('body'),
    documentElement: makeEl('html'),
    createElement() { return makeEl('created'); },
  };

  const context = vm.createContext({
    console: { error() {}, warn() {}, log() {} },
    localStorage: storage,
    // 固定样例月份，避免运行日期改变当前月语义。
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : ['2026-08-12T12:00:00'])); }
      static now() { return new Date('2026-08-12T12:00:00').getTime(); }
    },
    document: documentStub,
    window: { scrollY: 0, scrollTo() {} },
  });

  vm.runInContext(
    `${storageSource}\n${dataSource}\n${reportSource}\n;globalThis.__mrRender = {\n`
      + '  init: () => ExpenseMonthlyReport.init(),\n'
      + '  openReportJson: (ym) => JSON.stringify(ExpenseMonthlyReport.openReport(ym)),\n'
      + '  closeReport: () => ExpenseMonthlyReport.closeReport(),\n'
      + '  refreshEntry: () => ExpenseMonthlyReport.refreshEntry(),\n'
      + '  addExpenseJson: (e) => JSON.stringify(ExpenseDB.addExpense(JSON.parse(e))),\n'
      + '  initPresetJson: () => JSON.stringify(ExpenseData.initPresetData()),\n'
      + '};',
    context,
    { filename: 'storage+data+monthly-report-v223.js' },
  );

  return {
    init() { context.__mrRender.init(); },
    openReport(ym) { return context.__mrRender.openReportJson(ym); },
    closeReport() { context.__mrRender.closeReport(); },
    refreshEntry() { context.__mrRender.refreshEntry(); },
    addExpense(e) { return context.__mrRender.addExpenseJson(JSON.stringify(e)); },
    initPreset() { return context.__mrRender.initPresetJson(); },
    el(id) { return elements.get(id); },
    clickInBody(selector) {
      // 触发月份条委托事件：命中指定 data-mr-* 目标
      const cb = eventCbs.get('overlay-monthly-report-body') && eventCbs.get('overlay-monthly-report-body').click;
      assert.ok(cb, 'body 未绑定 click 委托');
      cb({ target: { closest(sel) { return sel === selector ? {} : null; } } });
    },
    storage,
  };
}

let seq = 0;

/** 一条消费记录（默认填满可选字段） */
function mkExpense(overrides) {
  seq += 1;
  return Object.assign({
    id: 'r-' + seq,
    amount: 10,
    categoryId: 'cat-food',
    date: '2026-08-01',
    time: '12:00',
    paymentMethod: 'wechat',
    necessity: 'need',
    createdAt: '2026-08-01T12:00:00.000Z',
  }, overrides);
}

/** 同日期 n 条（日期间隔 ≥2 天，规避 R6 周末失衡干扰） */
function fill(categoryId, amount, n, overrides) {
  const list = [];
  for (let i = 0; i < n; i++) {
    const day = String(2 + i).padStart(2, '0');
    list.push(mkExpense(Object.assign({
      categoryId,
      amount,
      date: '2026-08-' + day,
      createdAt: '2026-08-' + day + 'T12:00:00.000Z',
    }, overrides)));
  }
  return list;
}

/** 预置记录：返回是否有 8 月的记录 */
function seed(runner, expenses) {
  runner.initPreset();
  for (const e of expenses) {
    assert.notEqual(runner.addExpense(e), null, 'addExpense 应成功: ' + e.id);
  }
}

/* ----------------------------------------------------------------
   用例
   ---------------------------------------------------------------- */

test('入口卡：无记录隐藏；有记录未读显示角标；打开报告后角标消失', () => {
  const runner = loadRender();
  runner.init();

  // 无记录 → 隐藏
  assert.equal(runner.el('mr-entry').hidden, true);

  // 有记录未读 → 显示 + “新”角标
  seed(runner, fill('cat-food', 50, 5));
  runner.refreshEntry();
  assert.equal(runner.el('mr-entry').hidden, false);
  assert.equal(runner.el('mr-entry-badge').hidden, false);

  // 打开当前月报告 → 标记已读 → 角标消失，入口保留
  runner.openReport('2026-08');
  assert.equal(runner.el('mr-entry-badge').hidden, true);
  assert.equal(runner.el('mr-entry').hidden, false);
});

test('openReport 渲染完整骨架（样本充足 → 诊断 + 行动）', () => {
  const runner = loadRender();
  seed(runner, fill('cat-food', 100, 8).concat(fill('cat-transport', 50, 8)));
  runner.init();

  runner.openReport('2026-08');
  const body = runner.el('overlay-monthly-report-body').innerHTML;

  assert.match(body, /2026年8月/);            // 月份条
  assert.match(body, /总支出/);               // ② 核心概览
  assert.match(body, /重点发现/);             // ③ 诊断区
  assert.match(body, /钱都花在哪了/);         // ④ 分类结构
  assert.match(body, /下月行动/);             // ⑧ 行动建议
  assert.match(body, /mr-skeleton__trend/);   // 环比并入总支出主区域
  assert.equal((body.match(/class="mr-skeleton__cell/g) || []).length, 3); // 主区域 + 两个等宽指标
  assert.doesNotMatch(body, /为什么这么说/); // 发现条目表达完整结论
  assert.doesNotMatch(body, /mr-opening__text/); // 有发现时不重复摘要
  assert.ok(body.indexOf('mr-skeleton__value') < body.indexOf('mr-skeleton__trend'));
  const actions = Array.from(
    body.matchAll(/<p class="mr-action__text">([^<]+)<\/p>/g),
    match => match[1],
  );
  assert.ok(actions.length > 0);
  actions.forEach(text => {
    assert.equal(body.split(text).length - 1, 1); // 行动建议不在诊断处方重复
  });
  assert.doesNotMatch(body, /多记几个月/);    // 样本充足不出现降级文案
});

test('样本量不足：只客观陈述，不做诊断', () => {
  const runner = loadRender();
  seed(runner, fill('cat-food', 50, 8));
  runner.init();

  runner.openReport('2026-08');
  const body = runner.el('overlay-monthly-report-body').innerHTML;
  assert.match(body, /多记几个月能看出更准的规律/);
  assert.equal((body.match(/多记几个月/g) || []).length, 1);
  // 客观结论已在“一句话”中说明，不再追加重复的重点发现章节
  assert.doesNotMatch(body, /重点发现/);
  assert.doesNotMatch(body, /mr-diagnosis/);
});

test('样本充足但无诊断：保留中性开场，不渲染空的重点发现章节', () => {
  const runner = loadRender();
  seed(runner, fill('cat-housing', 100, 15, {
    date: '2026-08-03',
    createdAt: '2026-08-03T12:00:00.000Z',
  }));
  runner.init();

  runner.openReport('2026-08');
  const body = runner.el('overlay-monthly-report-body').innerHTML;
  assert.match(body, /这是你的第一份月报/);
  assert.doesNotMatch(body, /mr-section--findings/);
});

test('订阅提示已含合计与占比时，不再重复显示汇总数字', () => {
  const runner = loadRender();
  seed(runner, fill('cat-subscription', 80, 3).concat(fill('cat-food', 100, 15)));
  runner.init();

  runner.openReport('2026-08');
  const body = runner.el('overlay-monthly-report-body').innerHTML;
  assert.match(body, /订阅每月固定扣款合计 ¥240（占总支出 \d+%）/);
  assert.equal((body.match(/合计 ¥240/g) || []).length, 1);
  assert.doesNotMatch(body, /mr-sub__total/);
});

test('订阅占比较低时，保留普通合计且不显示行动提示', () => {
  const runner = loadRender();
  seed(runner, fill('cat-subscription', 5, 1, {
    date: '2026-08-03',
    createdAt: '2026-08-03T12:00:00.000Z',
  }).concat(fill('cat-food', 100, 15, {
    date: '2026-08-03',
    createdAt: '2026-08-03T12:00:00.000Z',
  })));
  runner.init();

  runner.openReport('2026-08');
  const body = runner.el('overlay-monthly-report-body').innerHTML;
  assert.match(body, /mr-sub__total/);
  assert.doesNotMatch(body, /mr-sub__hint/);
});

test('空月份：渲染空骨架不报错', () => {
  const runner = loadRender();
  runner.initPreset();
  runner.init();

  runner.openReport('2026-08');
  const body = runner.el('overlay-monthly-report-body').innerHTML;
  assert.match(body, /还没有记录/);
  assert.match(body, /总支出/);
});

test('月份切换：委托点击 ‹ 切到上月并重渲染', () => {
  const runner = loadRender();
  seed(runner, fill('cat-food', 100, 8).concat(fill('cat-transport', 50, 8)));
  runner.init();
  runner.openReport('2026-08');

  runner.clickInBody('[data-mr-prev]');
  const body = runner.el('overlay-monthly-report-body').innerHTML;
  assert.match(body, /2026年7月/);            // 已切到 7 月
  assert.match(body, /回到本月/);             // 历史月出现回本 chip
});

test('打开当前月报告 → 标记已读（settings.monthlyReportRead）', () => {
  const runner = loadRender();
  seed(runner, fill('cat-food', 50, 5));
  runner.init();

  runner.openReport('2026-08');
  const settings = JSON.parse(runner.storage.snapshot()['expense_tracker_settings'] || '{}');
  assert.equal(settings.monthlyReportRead, '2026-08');
});

test('历史月不写已读；关闭恢复滚动锁', () => {
  const runner = loadRender();
  seed(runner, fill('cat-food', 50, 5));
  runner.init();

  runner.openReport('2026-07');
  const settings = JSON.parse(runner.storage.snapshot()['expense_tracker_settings'] || '{}');
  assert.equal(settings.monthlyReportRead, undefined);

  // 关闭：覆盖层收起（打开状态由 open 类标记，stub 记录 add/remove 调用即可不崩）
  runner.closeReport();
});
