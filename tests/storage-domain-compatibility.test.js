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

const BASE_DATA = {
  expenses: [{
    id: 'base-expense',
    amount: 12.34,
    categoryId: 'cat-parent',
    date: '2026-08-11',
    time: '08:08',
    location: '',
    paymentMethod: 'cash',
    necessity: 'need',
    note: '原账单',
    createdAt: '2026-08-11T08:08:00.000Z',
  }],
  categories: [
    {
      id: 'cat-parent',
      name: '可见父分类',
      icon: '📌',
      parentId: null,
      isPreset: false,
      order: 0,
    },
    {
      id: 'cat-child',
      name: '隐藏子分类',
      icon: '📌',
      parentId: 'cat-parent',
      isPreset: false,
      order: 1,
    },
    {
      id: 'cat-tombstone',
      name: '隐藏墓碑分类',
      icon: '📌',
      parentId: null,
      isPreset: false,
      order: 2,
      deletedAt: '2026-08-10T12:00:00.000Z',
    },
  ],
  budget: {
    monthlyTotal: 1000,
    categories: { 'cat-parent': 300 },
  },
  settings: {
    currency: '¥',
    theme: 'light',
  },
};

class MemoryStorage {
  constructor(seed = {}) {
    this.values = new Map(Object.entries(seed));
    this.writeLog = [];
  }

  getItem(key) {
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    const normalizedKey = String(key);
    const normalizedValue = String(value);
    this.writeLog.push({ operation: 'setItem', key: normalizedKey, value: normalizedValue });
    this.values.set(normalizedKey, normalizedValue);
  }

  removeItem(key) {
    const normalizedKey = String(key);
    this.writeLog.push({ operation: 'removeItem', key: normalizedKey });
    this.values.delete(normalizedKey);
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
    `${source}\n;globalThis.__domainCompatibilityTest = {\n`
      + '  db: ExpenseDB,\n'
      + '  importJson: raw => ExpenseDB.importAll(JSON.parse(raw)),\n'
      + '};',
    context,
    { filename: absolutePath },
  );

  return {
    ...context.__domainCompatibilityTest,
    storage,
  };
}

function legacyExpenseData(amount) {
  const data = cloneJson(BASE_DATA);
  data.expenses[0].amount = amount;
  data.expenses[0].note = '旧版金额账单';
  return data;
}

const LEGACY_EXPENSE_CASES = [
  { label: '三位小数', amount: 1.001, replacement: 1.002 },
  { label: '超过产品上限', amount: 100000000, replacement: 100000000.01 },
];

const DOMAIN_INVALID_CASES = [
  {
    label: '未知 payment',
    create() {
      const data = cloneJson(BASE_DATA);
      data.expenses[0].paymentMethod = 'credit-card';
      return data;
    },
    assertReadable(db) {
      assert.equal(db.getExpense('base-expense').paymentMethod, 'credit-card');
    },
  },
  {
    label: '负预算',
    create() {
      const data = cloneJson(BASE_DATA);
      data.budget.monthlyTotal = -0.01;
      return data;
    },
    assertReadable(db) {
      assert.equal(db.getBudget().monthlyTotal, -0.01);
    },
  },
];

for (const scriptPath of STORAGE_SCRIPTS) {
  for (const legacy of LEGACY_EXPENSE_CASES) {
    test(`${scriptPath}：现存${legacy.label}旧金额可 v3 原样导出并安全编辑`, () => {
      const storage = new MemoryStorage(createRawSeed(legacyExpenseData(legacy.amount)));
      const api = loadExpenseDB(scriptPath, storage);

      assert.equal(api.db.getCoreReadStatus().ok, true);
      const exported = cloneJson(api.db.exportAll());
      assert.equal(exported.version, 3);
      assert.equal(exported.expenses[0].amount, legacy.amount, '普通导出不得取整或迁移旧金额');

      const updated = api.db.updateExpense('base-expense', { note: '只改备注' });
      assert.ok(updated);
      assert.equal(updated.amount, legacy.amount, '无关编辑必须保持旧金额原值');
      assert.equal(updated.note, '只改备注');
      const storedAfterNote = JSON.parse(storage.getRaw(STORAGE_KEYS.expenses));
      assert.equal(storedAfterNote[0].amount, legacy.amount);

      const beforeRejectedAmount = storage.getRaw(STORAGE_KEYS.expenses);
      assert.equal(api.db.updateExpense('base-expense', { amount: legacy.replacement }), null);
      assert.equal(
        storage.getRaw(STORAGE_KEYS.expenses),
        beforeRejectedAmount,
        '把旧金额改成另一非法值必须零写',
      );
    });
  }

  test(`${scriptPath}：普通预算编辑保留未提交的墓碑与子分类隐藏键`, () => {
    const data = cloneJson(BASE_DATA);
    data.budget = {
      monthlyTotal: 1000,
      categories: {
        'cat-parent': 300,
        'cat-child': 1.001,
        'cat-tombstone': 100000000,
      },
    };
    const storage = new MemoryStorage(createRawSeed(data));
    const api = loadExpenseDB(scriptPath, storage);

    assert.equal(api.db.getCoreReadStatus().ok, true);
    assert.equal(api.db.saveBudget({
      monthlyTotal: '2000.00',
      categories: { 'cat-parent': '450.25' },
    }), true);

    assert.deepEqual(JSON.parse(storage.getRaw(STORAGE_KEYS.budget)), {
      monthlyTotal: 2000,
      categories: {
        'cat-parent': 450.25,
        'cat-child': 1.001,
        'cat-tombstone': 100000000,
      },
    });
  });

  test(`${scriptPath}：明确 reset 模式才清空全部隐藏预算键`, () => {
    const data = cloneJson(BASE_DATA);
    data.budget.categories = {
      'cat-parent': 300,
      'cat-child': 50,
      'cat-tombstone': 75,
    };
    const storage = new MemoryStorage(createRawSeed(data));
    const api = loadExpenseDB(scriptPath, storage);

    assert.equal(api.db.saveBudget({ monthlyTotal: 0, categories: {} }, { mode: 'reset' }), true);
    assert.deepEqual(JSON.parse(storage.getRaw(STORAGE_KEYS.budget)), {
      monthlyTotal: 0,
      categories: {},
    });
  });

  for (const invalid of DOMAIN_INVALID_CASES) {
    test(`${scriptPath}：现存${invalid.label}进入 DOMAIN_DATA_INVALID 并可原样救援`, () => {
      const originalData = invalid.create();
      const storage = new MemoryStorage(createRawSeed(originalData));
      const api = loadExpenseDB(scriptPath, storage);
      const before = storage.snapshot();

      const status = api.db.getCoreReadStatus();
      assert.equal(status.ok, false);
      assert.equal(status.code, 'DOMAIN_DATA_INVALID');
      invalid.assertReadable(api.db);
      assert.equal(api.db.exportAll(), null, '领域损坏不得伪装成普通可恢复备份');
      assert.equal(api.db.saveSettings({ theme: 'dark' }), false, '发现领域损坏后所有核心写入必须暂停');
      assert.deepEqual(storage.snapshot(), before);

      const recovery = cloneJson(api.db.exportRecoveryCopy());
      assert.equal(recovery.version, 3);
      assert.equal(recovery.recoveryOnly, true);
      assert.equal(recovery.recoveryReason, 'DOMAIN_DATA_INVALID');
      assert.deepEqual(recovery.expenses, originalData.expenses);
      assert.deepEqual(recovery.categories, originalData.categories);
      assert.deepEqual(recovery.budget, originalData.budget);
      assert.deepEqual(recovery.settings, originalData.settings);
      assert.deepEqual(storage.snapshot(), before, '救援导出必须保持完全只读');

      const targetStorage = new MemoryStorage(createRawSeed(BASE_DATA));
      const target = loadExpenseDB(scriptPath, targetStorage);
      const targetBefore = targetStorage.snapshot();
      const importResult = target.importJson(JSON.stringify(recovery));
      assert.equal(importResult.success, false);
      assert.deepEqual(targetStorage.snapshot(), targetBefore, '救援副本不得直接覆盖有效账本');
    });
  }
}
