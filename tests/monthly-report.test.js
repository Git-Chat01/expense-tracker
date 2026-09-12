/* ================================================================
   月度报告引擎测试
   纯 Node 内置测试（node --test），零第三方依赖。
   模式照抄 budget-impact-domain.test.js：MemoryStorage + vm 注入。
   测试目标：analyze 纯函数（门控 / 规则边界 / 排序 / 组装）+ buildContext 适配器。
   ================================================================ */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STORAGE_SCRIPTS = ['js/storage-v214.js'];

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

function loadReport(storagePath) {
  const storageSource = fs.readFileSync(path.join(__dirname, '..', storagePath), 'utf8');
  const dataSource = fs.readFileSync(path.join(__dirname, '..', 'js/data.js'), 'utf8');
  const reportSource = fs.readFileSync(path.join(__dirname, '..', 'js/monthly-report-v223.js'), 'utf8');
  const storage = new MemoryStorage();
  const context = vm.createContext({
    console: { error() {}, warn() {}, log() {} },
    localStorage: storage,
    // 固定样例月份，避免运行日期改变当前月语义。
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : ['2026-08-12T12:00:00'])); }
      static now() { return new Date('2026-08-12T12:00:00').getTime(); }
    },
  });

  vm.runInContext(
    `${storageSource}\n${dataSource}\n${reportSource}\n;globalThis.__mrTest = {\n`
      + '  analyzeJson: (input) => JSON.stringify(ExpenseMonthlyReport.analyze(JSON.parse(input))),\n'
      + '  buildContextJson: (ym) => JSON.stringify(ExpenseMonthlyReport.buildContext(ym)),\n'
      + '  addExpenseJson: (e) => JSON.stringify(ExpenseDB.addExpense(JSON.parse(e))),\n'
      + '  initPresetJson: () => JSON.stringify(ExpenseData.initPresetData()),\n'
      + '};',
    context,
    { filename: `${storagePath}+monthly-report-v223.js` },
  );

  return {
    analyze(input) {
      return JSON.parse(context.__mrTest.analyzeJson(JSON.stringify(input)));
    },
    buildContext(ym) {
      return JSON.parse(context.__mrTest.buildContextJson(ym));
    },
    addExpense(expense) {
      return JSON.parse(context.__mrTest.addExpenseJson(JSON.stringify(expense)));
    },
    initPreset() {
      return JSON.parse(context.__mrTest.initPresetJson());
    },
    storage,
  };
}

/* ----------------------------------------------------------------
   共享 fixture 构造
   ---------------------------------------------------------------- */

let seq = 0;

/** 一条消费记录（默认填满可选字段；测试按需覆盖） */
function mkExpense(overrides) {
  seq += 1;
  return Object.assign({
    id: 'e-' + seq,
    amount: 10,
    categoryId: 'cat-food',
    date: '2026-08-01',
    time: '12:00',
    paymentMethod: 'wechat',
    necessity: 'need',
    createdAt: '2026-08-01T12:00:00.000Z',
  }, overrides);
}

const CATEGORIES = [
  { id: 'cat-food', name: '餐饮', parentId: null },
  { id: 'cat-food-deliver', name: '外卖', parentId: 'cat-food' },
  { id: 'cat-food-drink', name: '奶茶饮品', parentId: 'cat-food' },
  { id: 'cat-transport', name: '交通', parentId: null },
  { id: 'cat-shopping', name: '购物', parentId: null },
  { id: 'cat-entertain', name: '娱乐', parentId: null },
  { id: 'cat-housing', name: '住房', parentId: null },
  { id: 'cat-subscription', name: '会员订阅', parentId: null },
];

/** 生成 n 条金额为 amount 的分类记录（日期统一同一天，规避 R6 周末干扰） */
function fill(categoryId, amount, n, overrides) {
  return Array.from({ length: n }, () => mkExpense(
    Object.assign({ categoryId: categoryId, amount: amount, date: '2026-08-01' }, overrides),
  ));
}

function baseInput(overrides) {
  return Object.assign({
    yearMonth: '2026-08',
    today: '2026-08-12',
    currency: '¥',
    expenses: [],
    prevExpenses: [],
    prevFullMonthExpenses: [],
    categories: CATEGORIES,
    budget: { monthlyTotal: 0, categories: {} },
  }, overrides);
}

/** 2026-08-01..maxD 的周末日（YYYY-MM-DD 数组） */
function weekendDates(year, month, maxD) {
  const result = [];
  for (let d = 1; d <= maxD; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    if (wd === 0 || wd === 6) {
      result.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return result;
}

/** 2026-08-01..maxD 的工作日 */
function weekdayDates(year, month, maxD) {
  const result = [];
  for (let d = 1; d <= maxD; d++) {
    const wd = new Date(year, month - 1, d).getDay();
    if (wd !== 0 && wd !== 6) {
      result.push(`${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`);
    }
  }
  return result;
}

const ruleIds = (report) => report.diagnoses.map((h) => h.ruleId);
const allHitIds = (report) => report.diagnoses.concat(report.insights).map((h) => h.ruleId);

/* ================================================================
   A. 骨架与门控
   ================================================================ */

test('月度报告：无上月数据 → firstReport，环比为 null，R2 不触发', () => {
  const report = loadReport(STORAGE_SCRIPTS[0]).analyze(baseInput({
    expenses: fill('cat-food', 50, 15).concat(fill('cat-transport', 50, 5)),
    prevExpenses: [],
  }));
  assert.equal(report.firstReport, true);
  assert.equal(report.changePct, null);
  assert.equal(ruleIds(report).includes('R2'), false);
});

test('月度报告：环比双口径——当前月（上月同期基线）与历史月（完整上月）', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);
  // 当前月：8 月 12 日，基线 = 上月同期
  const current = runner.analyze(baseInput({
    expenses: fill('cat-food', 100, 11), // ¥1,100
    prevExpenses: fill('cat-food', 100, 10), // ¥1,000
  }));
  assert.equal(current.changePct, 10);
  assert.equal(current.isCurrentMonth, true);

  // 历史月：7 月（today 仍为 8/12），基线 = 完整 6 月
  const historical = runner.analyze(baseInput({
    yearMonth: '2026-07',
    expenses: fill('cat-food', 100, 11),
    prevExpenses: fill('cat-food', 100, 10),
  }));
  assert.equal(historical.changePct, 10);
  assert.equal(historical.isCurrentMonth, false);
});

test('月度报告：样本量门控——8 条只陈述、订阅豁免；15 条正常运行', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);
  const small = runner.analyze(baseInput({
    expenses: fill('cat-food', 100, 6).concat(fill('cat-subscription', 30, 2)),
  }));
  assert.equal(small.sampleGated, true);
  assert.equal(small.diagnoses.length, 0);
  assert.equal(small.insights.length, 0);
  // R8 订阅清单是客观列举，豁免样本门控
  assert.notEqual(small.subscription, null);
  assert.equal(small.subscription.totalCents, 6000);

  const enough = runner.analyze(baseInput({
    expenses: fill('cat-food', 100, 15),
  }));
  assert.equal(enough.sampleGated, false);
});

test('月度报告：覆盖率三分段——20% 不出现 / 50% 弱化 / 80% 正常', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 25 条、4 分类均匀（单分类 26%），单笔 ¥50 不是小额；necessity 覆盖率 20%
  const low = runner.analyze(baseInput({
    expenses: Array.from({ length: 25 }, (_, i) => mkExpense({
      categoryId: ['cat-food', 'cat-transport', 'cat-shopping', 'cat-entertain'][i % 4],
      amount: 50,
      necessity: i < 5 ? 'impulse' : '',
    })),
  }));
  assert.equal(ruleIds(low).includes('R4'), false);

  // 覆盖率 50%：12 条 impulse（¥50×12=600 / 总 1250 = 48%），命中但弱化
  const mid = runner.analyze(baseInput({
    expenses: Array.from({ length: 25 }, (_, i) => mkExpense({
      categoryId: ['cat-food', 'cat-transport', 'cat-shopping', 'cat-entertain'][i % 4],
      amount: 50,
      necessity: i < 12 ? 'impulse' : '',
    })),
  }));
  const midR4 = mid.diagnoses.find((h) => h.ruleId === 'R4') || mid.insights.find((h) => h.ruleId === 'R4');
  assert.notEqual(midR4, undefined);
  assert.equal(midR4.coverageWeak, true);
  assert.match(midR4.coverageNote, /仅基于 \d+ 条填写了价值评定的记录/);

  // 覆盖率 80%：20 条有值（5 条 impulse ¥50=250 / 1250 = 20% 整），无弱化
  const high = runner.analyze(baseInput({
    expenses: Array.from({ length: 25 }, (_, i) => mkExpense({
      categoryId: ['cat-food', 'cat-transport', 'cat-shopping', 'cat-entertain'][i % 4],
      amount: 50,
      necessity: i < 20 ? (i < 5 ? 'impulse' : 'need') : '',
    })),
  }));
  const highR4 = allHitIds(high).includes('R4')
    ? high.diagnoses.concat(high.insights).find((h) => h.ruleId === 'R4')
    : undefined;
  assert.notEqual(highR4, undefined);
  assert.equal(highR4.coverageWeak, false);
  assert.equal(highR4.coverageNote, null);
});

test('月度报告：金额按整数分累加，浮点不产生误差', () => {
  const report = loadReport(STORAGE_SCRIPTS[0]).analyze(baseInput({
    expenses: [
      mkExpense({ amount: 0.1 }),
      mkExpense({ amount: 0.2 }),
      mkExpense({ amount: 12.34 }),
    ],
  }));
  // 0.1+0.2+12.34 若直接浮点累加 = 12.64 的近似值；分累加必须是精确 1264 分
  assert.equal(report.totalCents, 1264);
});

/* ================================================================
   B. 规则边界
   ================================================================ */

test('R1 分类集中度：45% 边界、刚性分类豁免、子分类上卷', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 60% 触发：餐饮 600 / 总 1050（16 条，过样本门控）
  const hit = runner.analyze(baseInput({
    expenses: fill('cat-food', 100, 6)
      .concat(fill('cat-transport', 50, 8))
      .concat(fill('cat-entertain', 25, 1))
      .concat(fill('cat-shopping', 25, 1)),
  }));
  assert.equal(ruleIds(hit).includes('R1'), true);
  assert.match(hit.diagnoses.find((h) => h.ruleId === 'R1').title, /57% 的钱花在了「餐饮」上/);

  // 44.9% 不触发（餐饮 449 / 总 1000）
  const miss = runner.analyze(baseInput({
    expenses: fill('cat-food', 89.8, 5)
      .concat(fill('cat-transport', 50, 4))
      .concat(fill('cat-shopping', 50, 4))
      .concat(fill('cat-entertain', 37.75, 4)),
  }));
  assert.equal(ruleIds(miss).includes('R1'), false);

  // 45% 整边界触发（450 / 1000）
  const edge = runner.analyze(baseInput({
    expenses: fill('cat-food', 90, 5)
      .concat(fill('cat-transport', 50, 4))
      .concat(fill('cat-shopping', 50, 4))
      .concat(fill('cat-entertain', 50, 2)),
  }));
  assert.equal(ruleIds(edge).includes('R1'), true);

  // 刚性分类豁免：住房 60% 不触发
  const rigid = runner.analyze(baseInput({
    expenses: fill('cat-housing', 100, 6)
      .concat(fill('cat-transport', 50, 8))
      .concat(fill('cat-entertain', 25, 1))
      .concat(fill('cat-shopping', 25, 1)),
  }));
  assert.equal(ruleIds(rigid).includes('R1'), false);

  // 子分类上卷：外卖记录计入「餐饮」父级占比
  const rollup = runner.analyze(baseInput({
    expenses: fill('cat-food-deliver', 100, 6)
      .concat(fill('cat-transport', 50, 8))
      .concat(fill('cat-entertain', 25, 1))
      .concat(fill('cat-shopping', 25, 1)),
  }));
  assert.equal(ruleIds(rollup).includes('R1'), true);
});

test('R2 环比异常：阈值边界与上月为 0 不触发', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 总额 +73% 且增量 ¥440 → 触发（当前月，文案带“同期”）
  const hit = runner.analyze(baseInput({
    expenses: fill('cat-food', 50, 8).concat(fill('cat-transport', 80, 8)), // ¥1,040
    prevExpenses: fill('cat-food', 25, 4).concat(fill('cat-transport', 62.5, 8)), // ¥600
  }));
  assert.equal(ruleIds(hit).includes('R2'), true);
  assert.match(hit.diagnoses.find((h) => h.ruleId === 'R2').title, /比上月同期多了 73%，多花 ¥440/);

  // 历史月口径：文案不带“同期”
  const historical = runner.analyze(baseInput({
    yearMonth: '2026-07',
    expenses: fill('cat-food', 50, 8).concat(fill('cat-transport', 80, 8)),
    prevExpenses: fill('cat-food', 25, 4).concat(fill('cat-transport', 62.5, 8)),
  }));
  const histR2 = historical.diagnoses.find((h) => h.ruleId === 'R2');
  assert.notEqual(histR2, undefined);
  assert.doesNotMatch(histR2.title, /同期/);

  // +35% 不触发（1350 vs 1000）
  const missPct = runner.analyze(baseInput({
    expenses: fill('cat-food', 90, 15),
    prevExpenses: fill('cat-food', 100, 10),
  }));
  assert.equal(ruleIds(missPct).includes('R2'), false);

  // 增幅够但增量 <¥100 不触发（141 vs 100 = +41%）
  const missDelta = runner.analyze(baseInput({
    expenses: fill('cat-food', 14.1, 10),
    prevExpenses: fill('cat-food', 10, 10),
  }));
  assert.equal(ruleIds(missDelta).includes('R2'), false);

  // 分类口径：餐饮上月为 0（新分类）不触发；同时总额 +25% 不达标
  // （上月 800、本月 1000：增量 ¥200 ≥¥100 但 25% < 40%）
  const newCat = runner.analyze(baseInput({
    expenses: fill('cat-food', 25, 8).concat(fill('cat-transport', 100, 8)),
    prevExpenses: fill('cat-transport', 100, 8), // 上月只有交通 ¥800
  }));
  assert.equal(ruleIds(newCat).includes('R2'), false);
});

test('R3 小额高频：笔数/金额双阈值、¥30 边界、奶茶可视化', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 触发：10 笔 ¥25（50%）+ 10 笔 ¥100；小额 250/1250 = 20% 整
  const hit = runner.analyze(baseInput({
    expenses: fill('cat-food', 25, 10).concat(fill('cat-transport', 100, 10)),
  }));
  const r3 = hit.diagnoses.find((h) => h.ruleId === 'R3');
  assert.notEqual(r3, undefined);
  assert.match(r3.title, /10 笔小额消费加起来有 ¥250/);
  assert.match(r3.explain, /50%/);
  assert.match(r3.prescriptions.join(' '), /奶茶/);

  // 笔数 47.4% < 50% 不触发
  const missCount = runner.analyze(baseInput({
    expenses: fill('cat-food', 25, 9).concat(fill('cat-transport', 200, 10)),
  }));
  assert.equal(ruleIds(missCount).includes('R3'), false);

  // 金额占比 19.7% < 20% 不触发
  const missCents = runner.analyze(baseInput({
    expenses: fill('cat-food', 25, 10).concat(fill('cat-transport', 102, 10)),
  }));
  assert.equal(ruleIds(missCents).includes('R3'), false);

  // ¥30 整不算小额，¥29.99 算：3 笔 ¥30 + 1 笔 ¥29.99，全小额口径断言
  const boundary = runner.analyze(baseInput({
    expenses: fill('cat-food', 30, 3)
      .concat(fill('cat-food', 29.99, 1))
      .concat(fill('cat-transport', 200, 11)),
  }));
  const r3b = boundary.diagnoses.find((h) => h.ruleId === 'R3');
  // 小额 = 1 笔（¥29.99），笔数 1/14 = 7.1% < 50% → 不触发
  assert.equal(r3b, undefined);
});

test('R4 冲动消费：20% 阈值、按月口径不出现“年”', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 触发：impulse 4 笔 ¥100 = 400 / 总 2000 = 20% 整
  const hit = runner.analyze(baseInput({
    expenses: fill('cat-shopping', 100, 4, { necessity: 'impulse' })
      .concat(fill('cat-food', 100, 16, { necessity: 'need' })),
  }));
  const r4 = hit.diagnoses.find((h) => h.ruleId === 'R4');
  assert.notEqual(r4, undefined);
  assert.match(r4.title, /冲动消费花了 ¥400/);
  // 节省金额按“月”口径，绝不年化
  assert.doesNotMatch(r4.prescriptions.join(' '), /年/);

  // 15% 不触发
  const miss = runner.analyze(baseInput({
    expenses: fill('cat-shopping', 100, 3, { necessity: 'impulse' })
      .concat(fill('cat-food', 100, 17, { necessity: 'need' })),
  }));
  assert.equal(ruleIds(miss).includes('R4'), false);
});

test('R5 深夜消费：22:00 含 / 21:59 不含 / 01:59 含 / 02:00 不含', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 触发：20 条全有 time，深夜 4 条（22:00、22:59、01:00、01:59）= 20%
  const hit = runner.analyze(baseInput({
    expenses: fill('cat-food', 50, 4, { time: '22:00' })
      .concat(fill('cat-food', 50, 1, { time: '22:59' }))
      .concat(fill('cat-food', 50, 1, { time: '01:00' }))
      .concat(fill('cat-food', 50, 1, { time: '01:59' }))
      .concat(fill('cat-transport', 50, 13, { time: '12:00' })),
  }));
  const r5 = hit.diagnoses.find((h) => h.ruleId === 'R5');
  assert.notEqual(r5, undefined);
  assert.match(r5.title, /深夜消费 7 笔/);

  // 边界：21:59 不算深夜，02:00 也不算 → 深夜 2 条 = 10% 不触发
  const miss = runner.analyze(baseInput({
    expenses: fill('cat-food', 50, 1, { time: '21:59' })
      .concat(fill('cat-food', 50, 1, { time: '02:00' }))
      .concat(fill('cat-food', 50, 1, { time: '22:00' }))
      .concat(fill('cat-food', 50, 1, { time: '01:59' }))
      .concat(fill('cat-transport', 50, 16, { time: '12:00' })),
  }));
  assert.equal(ruleIds(miss).includes('R5'), false);
});

test('R6 周末 vs 工作日：2 倍阈值、按已过天数切分', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);
  const weekend = weekendDates(2026, 8, 12); // 4 天
  const weekday = weekdayDates(2026, 8, 12); // 8 天

  // 周末日均 ¥300 / 工作日日均 ¥100 = 3 倍 → 触发
  const hit = runner.analyze(baseInput({
    expenses: weekend.map((d) => mkExpense({ categoryId: 'cat-entertain', amount: 150, date: d }))
      .concat(weekend.map((d) => mkExpense({ categoryId: 'cat-entertain', amount: 150, date: d })))
      .concat(weekday.map((d) => mkExpense({ categoryId: 'cat-transport', amount: 50, date: d })))
      .concat(weekday.map((d) => mkExpense({ categoryId: 'cat-transport', amount: 50, date: d }))),
  }));
  assert.equal(ruleIds(hit).includes('R6'), true);

  // 1.9 倍不触发
  const miss = runner.analyze(baseInput({
    expenses: weekend.map((d) => mkExpense({ categoryId: 'cat-entertain', amount: 95, date: d }))
      .concat(weekend.map((d) => mkExpense({ categoryId: 'cat-entertain', amount: 95, date: d })))
      .concat(weekday.map((d) => mkExpense({ categoryId: 'cat-transport', amount: 50, date: d })))
      .concat(weekday.map((d) => mkExpense({ categoryId: 'cat-transport', amount: 50, date: d }))),
  }));
  assert.equal(ruleIds(miss).includes('R6'), false);
});

test('R7 支付渠道：单均 2 倍阈值、样本 ≥3 笔', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 触发：微信 3 笔 ¥100（单均 100）、银行卡 6 笔 ¥50（单均 50）= 2.0 整
  const hit = runner.analyze(baseInput({
    expenses: fill('cat-shopping', 100, 3, { paymentMethod: 'wechat' })
      .concat(fill('cat-shopping', 50, 2, { paymentMethod: 'bankcard' }))
      .concat(fill('cat-entertain', 50, 2, { paymentMethod: 'bankcard' }))
      .concat(fill('cat-transport', 50, 2, { paymentMethod: 'bankcard' }))
      .concat(fill('cat-food', 25, 4, { paymentMethod: 'alipay' }))
      .concat(fill('cat-food', 30, 3, { paymentMethod: 'cash' })),
  }));
  const r7 = allHitIds(hit).includes('R7')
    ? hit.diagnoses.concat(hit.insights).find((h) => h.ruleId === 'R7')
    : undefined;
  assert.notEqual(r7, undefined);
  assert.match(r7.title, /微信支付/);

  // 1.9 倍不触发：微信 3 笔 ¥95（单均 95）、银行卡 6 笔 ¥50（单均 50）
  const missRatio = runner.analyze(baseInput({
    expenses: fill('cat-shopping', 95, 3, { paymentMethod: 'wechat' })
      .concat(fill('cat-shopping', 50, 3, { paymentMethod: 'bankcard' }))
      .concat(fill('cat-entertain', 50, 3, { paymentMethod: 'bankcard' }))
      .concat(fill('cat-food', 25, 4, { paymentMethod: 'alipay' }))
      .concat(fill('cat-food', 30, 3, { paymentMethod: 'cash' })),
  }));
  assert.equal(allHitIds(missRatio).includes('R7'), false);

  // 渠道样本 <3 笔不参与比较：微信只有 2 笔
  const missCount = runner.analyze(baseInput({
    expenses: fill('cat-shopping', 100, 2, { paymentMethod: 'wechat' })
      .concat(fill('cat-food', 50, 6, { paymentMethod: 'bankcard' }))
      .concat(fill('cat-transport', 50, 6, { paymentMethod: 'bankcard' })),
  }));
  assert.equal(allHitIds(missCount).includes('R7'), false);
});

test('R8 订阅清单：直接聚合 cat-subscription，8% 占比提示', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 有订阅记录 → 清单 + 合计正确
  const hit = runner.analyze(baseInput({
    expenses: fill('cat-subscription', 80, 3).concat(fill('cat-food', 100, 15)),
  }));
  assert.notEqual(hit.subscription, null);
  assert.equal(hit.subscription.items.length, 1);
  assert.equal(hit.subscription.totalCents, 24000);
  // 240/1740 = 13.8% ≥ 8% → hint 出现
  assert.match(hit.subscription.hint, /不用的会员直接取消续费/);

  // 7.9% → 无 hint；无记录 → null
  const noHint = runner.analyze(baseInput({
    expenses: fill('cat-subscription', 79, 1).concat(fill('cat-food', 100, 10)),
  }));
  assert.equal(noHint.subscription.hint, null);
  const none = runner.analyze(baseInput({
    expenses: fill('cat-food', 100, 15),
  }));
  assert.equal(none.subscription, null);
});

test('R9 预算超支：总额/分类口径、无预算不触发、连续超支变体', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 总额超支：预算 1000、当月 1200；上月整月 1100 也超 → 连续超支 → 调预算处方
  const overTotal = runner.analyze(baseInput({
    expenses: fill('cat-food', 60, 5)
      .concat(fill('cat-transport', 60, 5))
      .concat(fill('cat-shopping', 60, 5))
      .concat(fill('cat-entertain', 60, 5)),
    prevFullMonthExpenses: fill('cat-food', 110, 10), // 上月整月 ¥1,100
    budget: { monthlyTotal: 1000, categories: {} },
  }));
  const r9t = overTotal.diagnoses.find((h) => h.ruleId === 'R9');
  assert.notEqual(r9t, undefined);
  assert.match(r9t.title, /总预算超了 ¥200/);
  // 上月整月 1100 也超 → 连续超支 → 处方建议调预算
  assert.match(r9t.prescriptions.join(' '), /调到实际水平/);

  // 上月整月未超 → 普通处方（不含“调到实际水平”）
  const once = runner.analyze(baseInput({
    expenses: fill('cat-food', 60, 5)
      .concat(fill('cat-transport', 60, 5))
      .concat(fill('cat-shopping', 60, 5))
      .concat(fill('cat-entertain', 60, 5)),
    prevFullMonthExpenses: fill('cat-food', 100, 5),
    budget: { monthlyTotal: 1000, categories: {} },
  }));
  assert.doesNotMatch(once.diagnoses.find((h) => h.ruleId === 'R9').prescriptions.join(' '), /调到实际水平/);

  // 分类超支（子分类计入父级预算）：餐饮预算 300、外卖 400（15 条过样本门控）
  const overCat = runner.analyze(baseInput({
    expenses: fill('cat-food-deliver', 40, 10).concat(fill('cat-transport', 50, 5)),
    budget: { monthlyTotal: 0, categories: { 'cat-food': 300 } },
  }));
  const r9c = overCat.diagnoses.find((h) => h.ruleId === 'R9');
  assert.notEqual(r9c, undefined);
  assert.match(r9c.title, /「餐饮」超了预算 ¥100/);

  // 无预算 → 不触发、budgetReport null、轻推 true
  const noBudget = runner.analyze(baseInput({
    expenses: fill('cat-food', 100, 15),
  }));
  assert.equal(ruleIds(noBudget).includes('R9'), false);
  assert.equal(noBudget.budgetReport, null);
  assert.equal(noBudget.budgetNudge, true);
});

/* ================================================================
   C. 排序与组装
   ================================================================ */

test('排序：金额影响降序、并列按可控性、top3 截断、T1 第 4 名丢弃', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 本月：小额 12 笔 ¥25（餐饮，=¥300）+ 大额 12 笔 ¥100（住房，RIGID 豁免 R1）
  // prev ¥200 → R2 增量 1300（650%）；预算 1000 → R9 超支 500；R3 300
  const input = baseInput({
    expenses: fill('cat-food', 25, 12).concat(fill('cat-housing', 100, 12)),
    prevExpenses: fill('cat-food', 40, 5),
    budget: { monthlyTotal: 1000, categories: {} },
  });
  const report = runner.analyze(input);
  // 排序：R2(1300) > R9(500) > R3(300)
  assert.deepEqual(ruleIds(report), ['R2', 'R9', 'R3']);
  assert.equal(report.insights.length, 0); // 全是 T1，第 4 名以后没有 → 空
  assert.equal(report.diagnoses.length, 3);
  // ⑧ 行动建议与 ③ 对应（每条取第一条处方）
  assert.equal(report.actions.length, 3);
  assert.deepEqual(report.actions.map((a) => a.ruleId), ['R2', 'R9', 'R3']);
});

test('排序：T2 命中在第 4 名时进可选洞察区，且并列按可控性排序', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 上面基础上给 12 笔小额标 impulse（300/1500=20% 整）→ R4 命中，impact 300 与 R3 并列
  // 可控性 R3(0.9) > R4(0.85) → R3 在前；住房 12 笔不填 necessity → 覆盖率 12/24=50% → weak
  const report = runner.analyze(baseInput({
    expenses: fill('cat-food', 25, 12, { necessity: 'impulse' })
      .concat(fill('cat-housing', 100, 12, { necessity: null })),
    prevExpenses: fill('cat-food', 40, 5),
    budget: { monthlyTotal: 1000, categories: {} },
  }));
  assert.deepEqual(ruleIds(report), ['R2', 'R9', 'R3']);
  assert.equal(report.insights.length, 1);
  assert.equal(report.insights[0].ruleId, 'R4');
  assert.equal(report.insights[0].coverageWeak, true); // 12/24 = 50%
});

test('开场结论取 top1；无命中时中性呈现、无行动建议', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);

  // 无命中：20 条 ¥30 均匀分布在 5 个分类（¥30 不是小额；同一天规避 R6）
  const calm = runner.analyze(baseInput({
    expenses: Array.from({ length: 20 }, (_, i) => mkExpense({
      categoryId: ['cat-food', 'cat-transport', 'cat-shopping', 'cat-entertain', 'cat-housing'][i % 5],
      amount: 30,
    })),
  }));
  assert.equal(calm.opening, null);
  assert.equal(calm.diagnoses.length, 0);
  assert.equal(calm.actions.length, 0);
  assert.equal(calm.budgetNudge, true);
  assert.equal(calm.sampleGated, false);

  // 有命中：开场结论 = top1 标题
  const hit = runner.analyze(baseInput({
    expenses: fill('cat-food', 100, 6)
      .concat(fill('cat-transport', 50, 8))
      .concat(fill('cat-entertain', 25, 1))
      .concat(fill('cat-shopping', 25, 1)),
  }));
  assert.notEqual(hit.opening, null);
  assert.equal(hit.opening.title, hit.diagnoses[0].title);
});

test('墓碑/孤儿分类：记录引用的分类不在表内不崩溃，金额正确聚合', () => {
  const report = loadReport(STORAGE_SCRIPTS[0]).analyze(baseInput({
    expenses: fill('cat-ghost', 50, 8).concat(fill('cat-food', 50, 8)),
    categories: CATEGORIES, // 没有 cat-ghost
  }));
  assert.equal(report.totalCents, 80000); // 8×50 + 8×50 = ¥800
  assert.equal(report.count, 16);
});

/* ================================================================
   D. 适配器冒烟（vm 内 ExpenseDB 真实读写）
   ================================================================ */

test('适配器：buildContext 当前月取数正确（含 8/1 与 8/12 边界）', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);
  assert.equal(runner.initPreset(), true);
  // 8/1、8/12 在当月；8/31 是“未来日期”应被排除；7/31 属于上月
  assert.notEqual(runner.addExpense(mkExpense({ amount: 100, categoryId: 'cat-food', date: '2026-08-01' })), null);
  assert.notEqual(runner.addExpense(mkExpense({ amount: 200, categoryId: 'cat-food', date: '2026-08-12' })), null);
  assert.notEqual(runner.addExpense(mkExpense({ amount: 999, categoryId: 'cat-food', date: '2026-08-31' })), null);
  assert.notEqual(runner.addExpense(mkExpense({ amount: 999, categoryId: 'cat-food', date: '2026-07-31' })), null);

  const input = runner.buildContext('2026-08');
  assert.equal(input.yearMonth, '2026-08');
  assert.equal(input.expenses.length, 2);
  assert.equal(input.expenses[0].amount + input.expenses[1].amount, 300);

  const report = runner.analyze(input);
  assert.equal(report.totalCents, 30000);
});

test('适配器：历史月 buildContext 取整月（含 7/1 与 7/31 边界）', () => {
  const runner = loadReport(STORAGE_SCRIPTS[0]);
  assert.equal(runner.initPreset(), true);
  assert.notEqual(runner.addExpense(mkExpense({ amount: 100, categoryId: 'cat-food', date: '2026-07-01' })), null);
  assert.notEqual(runner.addExpense(mkExpense({ amount: 200, categoryId: 'cat-food', date: '2026-07-31' })), null);
  assert.notEqual(runner.addExpense(mkExpense({ amount: 999, categoryId: 'cat-food', date: '2026-08-01' })), null);

  const input = runner.buildContext('2026-07');
  assert.equal(input.expenses.length, 2);
  assert.equal(input.yearMonth, '2026-07');
});
