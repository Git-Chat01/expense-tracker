const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STORAGE_SCRIPTS = [
  'js/storage.js',
  'js/storage-v214.js',
];

const STORAGE_KEYS = {
  expenses: 'expense_tracker_expenses',
  categories: 'expense_tracker_categories',
  budget: 'expense_tracker_budget',
  settings: 'expense_tracker_settings',
};

const MAX_MONEY = 99999999.99;
const MAX_MONEY_CENTS = 9999999999;
const VALID_PAYMENT_METHODS = ['', 'wechat', 'alipay', 'bankcard', 'cash', 'other'];
const VALID_NECESSITY_VALUES = ['', 'need', 'want', 'impulse'];

const BASE_DATA = {
  expenses: [
    {
      id: 'expense-active',
      amount: 12.34,
      categoryId: 'cat-active',
      date: '2026-08-11',
      time: '08:08',
      location: '',
      paymentMethod: 'wechat',
      necessity: 'need',
      note: '活动分类账单',
      createdAt: '2026-08-11T08:08:00.000Z',
    },
    {
      id: 'expense-tombstone',
      amount: 5.67,
      categoryId: 'cat-tombstone',
      date: '2026-08-11',
      time: '09:09',
      location: '',
      paymentMethod: 'other',
      necessity: '',
      note: '墓碑分类历史账单',
      createdAt: '2026-08-11T09:09:00.000Z',
    },
  ],
  categories: [
    {
      id: 'cat-active',
      name: '活动父分类',
      icon: '📌',
      parentId: null,
      isPreset: false,
      order: 0,
    },
    {
      id: 'cat-child',
      name: '活动子分类',
      icon: '📌',
      parentId: 'cat-active',
      isPreset: false,
      order: 1,
    },
    {
      id: 'cat-tombstone',
      name: '已删除分类',
      icon: '📌',
      parentId: null,
      isPreset: false,
      order: 2,
      deletedAt: '2026-08-10T12:00:00.000Z',
    },
  ],
  budget: {
    monthlyTotal: 1000,
    categories: { 'cat-active': 300 },
  },
  settings: {
    currency: '¥',
    theme: 'light',
  },
};

class MemoryStorage {
  constructor(seed = {}) {
    this.values = new Map(Object.entries(seed));
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

  getRaw(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  snapshot() {
    return Object.fromEntries([...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRawSeed(data = BASE_DATA) {
  return {
    [STORAGE_KEYS.expenses]: JSON.stringify(data.expenses),
    [STORAGE_KEYS.categories]: JSON.stringify(data.categories),
    [STORAGE_KEYS.budget]: JSON.stringify(data.budget),
    [STORAGE_KEYS.settings]: JSON.stringify(data.settings),
  };
}

function loadExpenseDB(relativePath, storage = new MemoryStorage(createRawSeed())) {
  const absolutePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const context = vm.createContext({
    console: { error() {} },
    localStorage: storage,
  });

  vm.runInContext(
    `${source}\n;globalThis.__domainValidationTest = {\n`
      + '  db: ExpenseDB,\n'
      + '  importJson: raw => ExpenseDB.importAll(JSON.parse(raw)),\n'
      + '  validateExpenseJson: raw => ExpenseDB.validateExpenseDraft(JSON.parse(raw)),\n'
      + '  validateBudgetJson: raw => ExpenseDB.validateBudgetDraft(JSON.parse(raw)),\n'
      + '};',
    context,
    { filename: absolutePath },
  );

  return {
    ...context.__domainValidationTest,
    storage,
  };
}

function expenseDraft(overrides = {}) {
  return {
    amount: 12.34,
    categoryId: 'cat-active',
    date: '2026-08-11',
    time: '10:10',
    location: '',
    paymentMethod: 'cash',
    necessity: 'want',
    note: '领域校验测试',
    ...overrides,
  };
}

function budgetDraft(overrides = {}) {
  return {
    monthlyTotal: 1200,
    categories: { 'cat-active': 300 },
    ...overrides,
  };
}

function strictBackup(mutator = () => {}) {
  const backup = {
    version: 4,
    exportedAt: '2026-08-11T12:00:00.000Z',
    ...cloneJson(BASE_DATA),
  };
  mutator(backup);
  return backup;
}

function legacyMoneyBackup(version) {
  const backup = strictBackup();
  backup.version = version;
  backup.expenses[0].amount = 100000000.001;
  backup.budget.monthlyTotal = 100000000.001;
  backup.budget.categories['cat-active'] = 1.001;
  return backup;
}

function assertValidationError(result, code) {
  assert.equal(result.ok, false);
  assert.equal(result.value, null);
  assert.ok(result.error && typeof result.error === 'object');
  assert.equal(result.error.code, code);
}

function assertImportError(result, code) {
  assert.equal(result.success, false);
  assert.ok(result.error && typeof result.error === 'object');
  assert.equal(result.error.code, code);
}

const INVALID_MONEY_CASES = [
  { label: '空值', value: '', code: 'MONEY_REQUIRED' },
  { label: '零', value: 0, code: 'MONEY_NON_POSITIVE' },
  { label: '负数', value: -0.01, code: 'MONEY_NEGATIVE' },
  { label: 'NaN', value: Number.NaN, code: 'MONEY_NOT_FINITE' },
  { label: 'Infinity', value: Number.POSITIVE_INFINITY, code: 'MONEY_NOT_FINITE' },
  { label: '三位小数', value: 1.001, code: 'MONEY_PRECISION' },
  { label: '超过产品上限', value: 100000000, code: 'MONEY_LIMIT' },
  { label: '科学计数法字符串', value: '1e2', code: 'MONEY_INVALID_FORMAT' },
  { label: '尾随垃圾字符串', value: '12.34yuan', code: 'MONEY_INVALID_FORMAT' },
];

const INVALID_EXPENSE_FIELD_CASES = [
  { label: '非法日期', patch: { date: '2026-02-30' }, code: 'EXPENSE_DATE_INVALID' },
  { label: '非法时间', patch: { time: '24:00' }, code: 'EXPENSE_TIME_INVALID' },
  { label: '不存在分类', patch: { categoryId: 'missing-category' }, code: 'EXPENSE_CATEGORY_INVALID' },
  { label: '墓碑分类', patch: { categoryId: 'cat-tombstone' }, code: 'EXPENSE_CATEGORY_INVALID' },
  { label: '未知支付方式', patch: { paymentMethod: 'credit-card' }, code: 'EXPENSE_PAYMENT_METHOD_INVALID' },
  { label: '未知价值评定', patch: { necessity: 'maybe' }, code: 'EXPENSE_NECESSITY_INVALID' },
];

const INVALID_BUDGET_CASES = [
  {
    label: '月总额负数',
    code: 'MONEY_NEGATIVE',
    create: () => budgetDraft({ monthlyTotal: -0.01 }),
  },
  {
    label: '分类预算负数',
    code: 'MONEY_NEGATIVE',
    create: () => budgetDraft({ categories: { 'cat-active': -0.01 } }),
  },
  {
    label: '月总额 NaN',
    code: 'MONEY_NOT_FINITE',
    create: () => budgetDraft({ monthlyTotal: Number.NaN }),
  },
  {
    label: '分类预算 Infinity',
    code: 'MONEY_NOT_FINITE',
    create: () => budgetDraft({ categories: { 'cat-active': Number.POSITIVE_INFINITY } }),
  },
  {
    label: '月总额三位小数',
    code: 'MONEY_PRECISION',
    create: () => budgetDraft({ monthlyTotal: 1.001 }),
  },
  {
    label: '分类预算三位小数',
    code: 'MONEY_PRECISION',
    create: () => budgetDraft({ categories: { 'cat-active': 1.001 } }),
  },
  {
    label: '月总额超过产品上限',
    code: 'MONEY_LIMIT',
    create: () => budgetDraft({ monthlyTotal: 100000000 }),
  },
  {
    label: '未知分类预算',
    code: 'BUDGET_CATEGORY_INVALID',
    create: () => budgetDraft({ categories: { 'missing-category': 10 } }),
  },
  {
    label: '墓碑分类预算',
    code: 'BUDGET_CATEGORY_INVALID',
    create: () => budgetDraft({ categories: { 'cat-tombstone': 10 } }),
  },
  {
    label: '月总额科学计数法字符串',
    code: 'MONEY_INVALID_FORMAT',
    create: () => budgetDraft({ monthlyTotal: '1e2' }),
  },
  {
    label: '分类预算尾随垃圾字符串',
    code: 'MONEY_INVALID_FORMAT',
    create: () => budgetDraft({ categories: { 'cat-active': '12yuan' } }),
  },
];

const STRICT_IMPORT_FAILURES = [
  {
    label: '账单金额为零',
    code: 'MONEY_NON_POSITIVE',
    mutate: backup => { backup.expenses[0].amount = 0; },
  },
  {
    label: '账单金额三位小数',
    code: 'MONEY_PRECISION',
    mutate: backup => { backup.expenses[0].amount = 1.001; },
  },
  {
    label: '账单金额超过上限',
    code: 'MONEY_LIMIT',
    mutate: backup => { backup.expenses[0].amount = 100000000; },
  },
  {
    label: '账单日期非法',
    code: 'EXPENSE_DATE_INVALID',
    mutate: backup => { backup.expenses[0].date = '2026-02-30'; },
  },
  {
    label: '账单时间非法',
    code: 'EXPENSE_TIME_INVALID',
    mutate: backup => { backup.expenses[0].time = '24:00'; },
  },
  {
    label: '账单分类不存在',
    code: 'EXPENSE_CATEGORY_INVALID',
    mutate: backup => { backup.expenses[0].categoryId = 'missing-category'; },
  },
  {
    label: '支付方式未知',
    code: 'EXPENSE_PAYMENT_METHOD_INVALID',
    mutate: backup => { backup.expenses[0].paymentMethod = 'credit-card'; },
  },
  {
    label: '价值评定未知',
    code: 'EXPENSE_NECESSITY_INVALID',
    mutate: backup => { backup.expenses[0].necessity = 'maybe'; },
  },
  {
    label: '月预算负数',
    code: 'MONEY_NEGATIVE',
    mutate: backup => { backup.budget.monthlyTotal = -0.01; },
  },
  {
    label: '分类预算三位小数',
    code: 'MONEY_PRECISION',
    mutate: backup => { backup.budget.categories['cat-active'] = 1.001; },
  },
  {
    label: '月预算超过上限',
    code: 'MONEY_LIMIT',
    mutate: backup => { backup.budget.monthlyTotal = 100000000; },
  },
  {
    label: '预算分类不存在',
    code: 'BUDGET_CATEGORY_INVALID',
    mutate: backup => { backup.budget.categories['missing-category'] = 10; },
  },
];

const LEGACY_NON_MONEY_FAILURES = [
  {
    label: '非法日期',
    code: 'EXPENSE_DATE_INVALID',
    mutate: backup => { backup.expenses[0].date = '2026-02-30'; },
  },
  {
    label: '未知支付方式',
    code: 'EXPENSE_PAYMENT_METHOD_INVALID',
    mutate: backup => { backup.expenses[0].paymentMethod = 'credit-card'; },
  },
  {
    label: '未知价值评定',
    code: 'EXPENSE_NECESSITY_INVALID',
    mutate: backup => { backup.expenses[0].necessity = 'maybe'; },
  },
  {
    label: '负预算',
    code: 'MONEY_NEGATIVE',
    mutate: backup => { backup.budget.monthlyTotal = -0.01; },
  },
];

for (const scriptPath of STORAGE_SCRIPTS) {
  test(`${scriptPath}：符合新领域规则的普通导出使用 version 4`, () => {
    const api = loadExpenseDB(scriptPath);
    const before = api.storage.snapshot();
    const backup = cloneJson(api.db.exportAll());

    assert.equal(backup.version, 4);
    assert.deepEqual(api.storage.snapshot(), before, '导出不得写入或迁移合规数据');
  });

  for (const amount of [0.01, MAX_MONEY]) {
    test(`${scriptPath}：addExpense 接受金额边界 ${amount}`, () => {
      const api = loadExpenseDB(scriptPath);
      const result = api.db.addExpense(expenseDraft({ amount }));

      assert.ok(result);
      assert.equal(result.amount, amount);
      assert.equal(Number.isInteger(result.amount * 100), true, '持久金额必须规范到整数分精度');
      const stored = JSON.parse(api.storage.getRaw(STORAGE_KEYS.expenses));
      assert.equal(stored.at(-1).amount, amount);
    });
  }

  for (const invalid of INVALID_MONEY_CASES) {
    test(`${scriptPath}：addExpense 拒绝${invalid.label}金额且零写`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.getRaw(STORAGE_KEYS.expenses);

      assert.equal(api.db.addExpense(expenseDraft({ amount: invalid.value })), null);
      assert.equal(api.storage.getRaw(STORAGE_KEYS.expenses), before);
    });
  }

  test(`${scriptPath}：addExpense 接受完整 payment 与 necessity 枚举`, () => {
    const api = loadExpenseDB(scriptPath);
    VALID_PAYMENT_METHODS.forEach((paymentMethod, index) => {
      const necessity = VALID_NECESSITY_VALUES[index % VALID_NECESSITY_VALUES.length];
      const result = api.db.addExpense(expenseDraft({
        amount: index + 0.01,
        paymentMethod,
        necessity,
        time: index === 0 ? '' : '23:59',
      }));
      assert.ok(result, `${paymentMethod || 'empty'} / ${necessity || 'empty'} 应合法`);
      assert.equal(result.paymentMethod, paymentMethod);
      assert.equal(result.necessity, necessity);
    });
  });

  for (const invalid of INVALID_EXPENSE_FIELD_CASES) {
    test(`${scriptPath}：addExpense 拒绝${invalid.label}且零写`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.getRaw(STORAGE_KEYS.expenses);

      assert.equal(api.db.addExpense(expenseDraft(invalid.patch)), null);
      assert.equal(api.storage.getRaw(STORAGE_KEYS.expenses), before);
    });
  }

  test(`${scriptPath}：updateExpense 对合并后的完整账单校验并保留未修改字段`, () => {
    const api = loadExpenseDB(scriptPath);
    const before = cloneJson(api.db.getExpense('expense-active'));
    const result = api.db.updateExpense('expense-active', { note: '只改备注' });

    assert.ok(result);
    assert.equal(result.note, '只改备注');
    assert.equal(result.amount, before.amount);
    assert.equal(result.categoryId, before.categoryId);
    assert.equal(result.date, before.date);
    assert.equal(result.paymentMethod, before.paymentMethod);
    assert.equal(result.necessity, before.necessity);
  });

  test(`${scriptPath}：updateExpense 保持原墓碑分类和历史 other 并规范金额`, () => {
    const api = loadExpenseDB(scriptPath);
    const result = api.db.updateExpense('expense-tombstone', {
      amount: '6.70',
      categoryId: 'cat-tombstone',
      paymentMethod: 'other',
      note: '历史账单可编辑',
    });

    assert.ok(result);
    assert.equal(result.amount, 6.7);
    assert.equal(result.categoryId, 'cat-tombstone');
    assert.equal(result.paymentMethod, 'other');
  });

  for (const invalid of [
    { label: '三位小数金额', patch: { amount: 1.001 } },
    ...INVALID_EXPENSE_FIELD_CASES,
  ]) {
    test(`${scriptPath}：updateExpense 拒绝${invalid.label}且零写`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.getRaw(STORAGE_KEYS.expenses);

      assert.equal(api.db.updateExpense('expense-active', invalid.patch), null);
      assert.equal(api.storage.getRaw(STORAGE_KEYS.expenses), before);
    });
  }

  test(`${scriptPath}：saveBudget 接受空值和 0 并规范为元 number`, () => {
    const api = loadExpenseDB(scriptPath);
    const result = api.db.saveBudget({
      monthlyTotal: '',
      categories: { 'cat-active': '', 'cat-child': 0 },
    });

    assert.equal(result, true);
    const stored = JSON.parse(api.storage.getRaw(STORAGE_KEYS.budget));
    assert.equal(stored.monthlyTotal, 0);
    assert.equal(stored.categories['cat-active'] ?? 0, 0);
    assert.equal(stored.categories['cat-child'] ?? 0, 0);
  });

  test(`${scriptPath}：saveBudget 接受 0.01 与产品上限并规范为元 number`, () => {
    const api = loadExpenseDB(scriptPath);
    const result = api.db.saveBudget({
      monthlyTotal: '99999999.99',
      categories: { 'cat-active': '0.01' },
    });

    assert.equal(result, true);
    assert.deepEqual(JSON.parse(api.storage.getRaw(STORAGE_KEYS.budget)), {
      monthlyTotal: MAX_MONEY,
      categories: { 'cat-active': 0.01 },
    });
  });

  for (const invalid of INVALID_BUDGET_CASES) {
    test(`${scriptPath}：saveBudget 拒绝${invalid.label}且零写`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.getRaw(STORAGE_KEYS.budget);

      assert.equal(api.db.saveBudget(invalid.create()), false);
      assert.equal(api.storage.getRaw(STORAGE_KEYS.budget), before);
    });
  }

  test(`${scriptPath}：version 4 合规备份可导入且保持完整 payment enum`, () => {
    const api = loadExpenseDB(scriptPath);
    const backup = strictBackup();
    backup.expenses[0].paymentMethod = 'other';
    backup.expenses[0].amount = 0.01;
    backup.budget.monthlyTotal = MAX_MONEY;

    const result = api.importJson(JSON.stringify(backup));

    assert.equal(result.success, true);
    assert.equal(api.db.getExpense('expense-active').amount, 0.01);
    assert.equal(api.db.getExpense('expense-active').paymentMethod, 'other');
    assert.equal(api.db.getBudget().monthlyTotal, MAX_MONEY);
  });

  for (const invalid of STRICT_IMPORT_FAILURES) {
    test(`${scriptPath}：version 4 import 拒绝${invalid.label}且零覆盖`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.snapshot();
      const backup = strictBackup(invalid.mutate);

      const result = api.importJson(JSON.stringify(backup));

      assertImportError(result, invalid.code);
      assert.deepEqual(api.storage.snapshot(), before);
    });
  }

  for (const legacyVersion of [1, 2, 3]) {
    test(`${scriptPath}：version ${legacyVersion} 历史正数金额超精度/上限可原样导入并警告`, () => {
      const api = loadExpenseDB(scriptPath);
      const backup = legacyMoneyBackup(legacyVersion);

      const result = api.importJson(JSON.stringify(backup));

      assert.equal(result.success, true);
      assert.equal(typeof result.warning, 'string');
      assert.notEqual(result.warning.length, 0);
      assert.equal(api.db.getExpense('expense-active').amount, 100000000.001);
      assert.equal(api.db.getBudget().monthlyTotal, 100000000.001);
      assert.equal(api.db.getBudget().categories['cat-active'], 1.001);

      const reexported = cloneJson(api.db.exportAll());
      assert.equal(reexported.version, 3, '依赖 legacy money 例外的数据不得标记为严格 v4');
      assert.equal(reexported.expenses[0].amount, 100000000.001);
      assert.equal(reexported.budget.monthlyTotal, 100000000.001);
      assert.equal(reexported.budget.categories['cat-active'], 1.001);
    });
  }

  for (const invalid of LEGACY_NON_MONEY_FAILURES) {
    test(`${scriptPath}：version 3 import 仍拒绝${invalid.label}且零覆盖`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.snapshot();
      const backup = legacyMoneyBackup(3);
      invalid.mutate(backup);

      const result = api.importJson(JSON.stringify(backup));

      assertImportError(result, invalid.code);
      assert.deepEqual(api.storage.snapshot(), before);
    });
  }

  test(`${scriptPath}：金额汇总使用整数分并精确返回 0.3`, () => {
    const preciseData = cloneJson(BASE_DATA);
    preciseData.expenses = [
      {
        ...cloneJson(BASE_DATA.expenses[0]),
        id: 'decimal-one',
        amount: 0.1,
        categoryId: 'cat-active',
      },
      {
        ...cloneJson(BASE_DATA.expenses[0]),
        id: 'decimal-two',
        amount: 0.2,
        categoryId: 'cat-child',
      },
    ];
    const storage = new MemoryStorage(createRawSeed(preciseData));
    const api = loadExpenseDB(scriptPath, storage);
    const before = storage.snapshot();

    assert.equal(api.db.getMonthTotal('2026-08'), 0.3);
    assert.equal(api.db.getDayTotal('2026-08-11'), 0.3);
    assert.equal(api.db.getCategorySpent('cat-active', '2026-08'), 0.3);
    assert.deepEqual(storage.snapshot(), before, '汇总不得改写历史金额');
  });

  test(`${scriptPath}：公开共享领域校验 API`, () => {
    const api = loadExpenseDB(scriptPath);
    assert.equal(typeof api.db.validateMoney, 'function');
    assert.equal(typeof api.db.validateExpenseDraft, 'function');
    assert.equal(typeof api.db.validateBudgetDraft, 'function');
  });

  test(`${scriptPath}：validateMoney 返回整数分与规范化元 value`, () => {
    const api = loadExpenseDB(scriptPath);
    const cases = [
      { input: 0.01, cents: 1, value: 0.01 },
      { input: '99999999.99', cents: MAX_MONEY_CENTS, value: MAX_MONEY },
      { input: 0.1 + 0.2, cents: 30, value: 0.3 },
    ];

    for (const item of cases) {
      const result = api.db.validateMoney(item.input);
      assert.equal(result.ok, true);
      assert.equal(result.cents, item.cents);
      assert.equal(result.value, item.value);
      assert.equal(result.error, null);
    }
  });

  for (const invalid of INVALID_MONEY_CASES) {
    test(`${scriptPath}：validateMoney 为${invalid.label}返回 ${invalid.code}`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.snapshot();
      const result = api.db.validateMoney(invalid.value);

      assertValidationError(result, invalid.code);
      assert.equal(result.cents, null);
      assert.deepEqual(api.storage.snapshot(), before);
    });
  }

  test(`${scriptPath}：validateMoney 的预算模式允许空值和 0`, () => {
    const api = loadExpenseDB(scriptPath);
    for (const input of ['', 0]) {
      const result = api.db.validateMoney(input, { allowEmpty: true, allowZero: true });
      assert.equal(result.ok, true);
      assert.equal(result.cents, 0);
      assert.equal(result.value, 0);
      assert.equal(result.error, null);
    }
  });

  test(`${scriptPath}：validateExpenseDraft 返回规范化元结构`, () => {
    const api = loadExpenseDB(scriptPath);
    const result = api.validateExpenseJson(JSON.stringify(expenseDraft({
      amount: '12.30',
      paymentMethod: 'other',
      necessity: '',
    })));

    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.value.amount, 12.3);
    assert.equal(result.value.categoryId, 'cat-active');
    assert.equal(result.value.paymentMethod, 'other');
    assert.equal(result.value.necessity, '');
  });

  for (const invalid of INVALID_EXPENSE_FIELD_CASES) {
    test(`${scriptPath}：validateExpenseDraft 为${invalid.label}返回 ${invalid.code}`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.snapshot();
      const result = api.validateExpenseJson(JSON.stringify(expenseDraft(invalid.patch)));

      assertValidationError(result, invalid.code);
      assert.deepEqual(api.storage.snapshot(), before);
    });
  }

  test(`${scriptPath}：validateBudgetDraft 返回规范化元结构`, () => {
    const api = loadExpenseDB(scriptPath);
    const result = api.validateBudgetJson(JSON.stringify({
      monthlyTotal: '99999999.99',
      categories: { 'cat-active': '0.01', 'cat-child': '' },
    }));

    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.equal(result.value.monthlyTotal, MAX_MONEY);
    assert.equal(result.value.categories['cat-active'], 0.01);
    assert.equal(result.value.categories['cat-child'] ?? 0, 0);
  });

  for (const invalid of [INVALID_BUDGET_CASES[4], INVALID_BUDGET_CASES[7]]) {
    test(`${scriptPath}：validateBudgetDraft 为${invalid.label}返回 ${invalid.code}`, () => {
      const api = loadExpenseDB(scriptPath);
      const before = api.storage.snapshot();
      const result = api.validateBudgetJson(JSON.stringify(invalid.create()));

      assertValidationError(result, invalid.code);
      assert.deepEqual(api.storage.snapshot(), before);
    });
  }
}
