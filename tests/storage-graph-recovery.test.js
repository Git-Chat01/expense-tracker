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

const INVALID_GRAPH_DATA = {
  expenses: [{
    id: 'graph-expense',
    amount: 23.45,
    categoryId: 'graph-grandchild',
    date: '2026-08-11',
    time: '10:15',
    location: '隔离测试',
    paymentMethod: 'cash',
    necessity: 'need',
    note: '三层分类历史账单',
    createdAt: '2026-08-11T10:15:00.000Z',
  }],
  categories: [
    {
      id: 'graph-root',
      name: '一级分类',
      icon: '📌',
      parentId: null,
      isPreset: false,
      order: 0,
    },
    {
      id: 'graph-child',
      name: '二级分类',
      icon: '📌',
      parentId: 'graph-root',
      isPreset: false,
      order: 1,
    },
    {
      id: 'graph-grandchild',
      name: '非法三级分类',
      icon: '📌',
      parentId: 'graph-child',
      isPreset: false,
      order: 2,
    },
    {
      id: 'graph-orphan',
      name: '非法孤儿分类',
      icon: '📌',
      parentId: 'missing-parent',
      isPreset: false,
      order: 3,
    },
  ],
  budget: {
    monthlyTotal: 1000,
    categories: { 'graph-root': 300 },
  },
  settings: {
    currency: '¥',
    theme: 'light',
  },
};

const VALID_DATA = {
  expenses: [{
    id: 'valid-expense',
    amount: 8.88,
    categoryId: 'valid-root',
    date: '2026-08-10',
    time: '09:30',
    location: '',
    paymentMethod: 'cash',
    necessity: 'want',
    note: '有效账单',
    createdAt: '2026-08-10T09:30:00.000Z',
  }],
  categories: [{
    id: 'valid-root',
    name: '有效分类',
    icon: '📌',
    parentId: null,
    isPreset: false,
    order: 0,
  }],
  budget: {
    monthlyTotal: 500,
    categories: { 'valid-root': 100 },
  },
  settings: {
    currency: '¥',
    theme: 'dark',
  },
};

const VALID_IMPORT_BACKUP = {
  version: 3,
  exportedAt: '2026-08-11T12:00:00.000Z',
  ...VALID_DATA,
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

  snapshot() {
    return Object.fromEntries([...this.values.entries()].sort(([a], [b]) => a.localeCompare(b)));
  }

  snapshotCore() {
    return Object.fromEntries(
      Object.values(STORAGE_KEYS).map(key => [key, this.values.has(key) ? this.values.get(key) : null]),
    );
  }
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function createRawSeed(data) {
  return {
    [STORAGE_KEYS.expenses]: JSON.stringify(data.expenses),
    [STORAGE_KEYS.categories]: JSON.stringify(data.categories),
    [STORAGE_KEYS.budget]: JSON.stringify(data.budget),
    [STORAGE_KEYS.settings]: JSON.stringify(data.settings),
  };
}

function loadExpenseDB(relativePath, storage = new MemoryStorage()) {
  const absolutePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const context = vm.createContext({
    console: { error() {} },
    localStorage: storage,
  });

  vm.runInContext(
    `${source}\n;globalThis.__graphRecoveryTest = {\n`
      + '  db: ExpenseDB,\n'
      + '  importJson: raw => ExpenseDB.importAll(JSON.parse(raw)),\n'
      + '};',
    context,
    { filename: absolutePath },
  );

  return {
    ...context.__graphRecoveryTest,
    storage,
  };
}

function loadInvalidGraph(relativePath) {
  return loadExpenseDB(relativePath, new MemoryStorage(createRawSeed(INVALID_GRAPH_DATA)));
}

const CORE_MUTATION_CASES = [
  {
    name: 'addExpense',
    expected: null,
    invoke(db) {
      return db.addExpense({
        amount: 12.34,
        categoryId: 'graph-root',
        date: '2026-08-11',
        time: '11:11',
        paymentMethod: 'cash',
        necessity: 'need',
        note: '不得新增',
      });
    },
  },
  {
    name: 'updateExpense',
    expected: null,
    invoke(db) {
      return db.updateExpense('graph-expense', { note: '不得编辑' });
    },
  },
  {
    name: 'deleteExpense',
    expected: false,
    invoke(db) {
      return db.deleteExpense('graph-expense');
    },
  },
  {
    name: 'addCategory',
    expected: null,
    invoke(db) {
      return db.addCategory({ id: 'new-root', name: '不得新增', parentId: null });
    },
  },
  {
    name: 'updateCategory',
    expected: false,
    invoke(db) {
      return db.updateCategory('graph-root', { name: '不得编辑' });
    },
  },
  {
    name: 'deleteCategory',
    expected: false,
    invoke(db) {
      return db.deleteCategory('graph-root');
    },
  },
  {
    name: 'initCategories',
    expected: false,
    invoke(db) {
      return db.initCategories([{
        id: 'preset-root',
        name: '预设分类',
        icon: '📌',
        parentId: null,
        isPreset: true,
        order: 0,
      }]);
    },
  },
  {
    name: 'syncPresetCategories',
    expected: false,
    invoke(db) {
      return db.syncPresetCategories([{
        id: 'preset-root',
        name: '预设分类',
        icon: '📌',
        parentId: null,
        isPreset: true,
        order: 0,
      }]);
    },
  },
  {
    name: 'saveBudget',
    expected: false,
    invoke(db) {
      return db.saveBudget({ monthlyTotal: 2000, categories: {} });
    },
  },
  {
    name: 'saveSettings',
    expected: false,
    invoke(db) {
      return db.saveSettings({ theme: 'dark' });
    },
  },
];

for (const scriptPath of STORAGE_SCRIPTS) {
  test(`${scriptPath}：字段合法但关系非法的分类图进入可读不可写状态`, () => {
    const api = loadInvalidGraph(scriptPath);
    const before = api.storage.snapshotCore();

    const status = api.db.getCoreReadStatus();
    assert.equal(status.ok, false);
    assert.equal(status.code, 'CATEGORY_GRAPH_INVALID');

    assert.deepEqual(cloneJson(api.db.getCategory('graph-grandchild')), INVALID_GRAPH_DATA.categories[2]);
    assert.deepEqual(cloneJson(api.db.getCategory('graph-orphan')), INVALID_GRAPH_DATA.categories[3]);
    assert.deepEqual(cloneJson(api.db.getExpenses()), INVALID_GRAPH_DATA.expenses);
    assert.deepEqual(api.storage.snapshotCore(), before, '只读查询不得改写非法关系图或账单');
    assert.deepEqual(api.storage.writeLog, []);
  });

  for (const mutation of CORE_MUTATION_CASES) {
    test(`${scriptPath}：分类图非法时 ${mutation.name} fail-closed 且核心零写`, () => {
      const api = loadInvalidGraph(scriptPath);
      const status = api.db.getCoreReadStatus();
      assert.equal(status.code, 'CATEGORY_GRAPH_INVALID');
      const before = api.storage.snapshotCore();

      const result = mutation.invoke(api.db);

      assert.equal(result, mutation.expected);
      assert.deepEqual(api.storage.snapshotCore(), before);
      assert.deepEqual(api.storage.writeLog, [], `${mutation.name} 不得尝试任何持久化写入`);
    });
  }

  test(`${scriptPath}：分类图非法时普通 exportAll fail-closed 且核心零写`, () => {
    const api = loadInvalidGraph(scriptPath);
    const before = api.storage.snapshotCore();

    assert.equal(api.db.exportAll(), null);
    assert.equal(api.db.getCoreReadStatus().code, 'CATEGORY_GRAPH_INVALID');
    assert.deepEqual(api.storage.snapshotCore(), before);
    assert.deepEqual(api.storage.writeLog, []);
  });

  test(`${scriptPath}：分类图非法时普通 importAll fail-closed 且核心零写`, () => {
    const api = loadInvalidGraph(scriptPath);
    const before = api.storage.snapshot();

    const result = api.importJson(JSON.stringify(VALID_IMPORT_BACKUP));

    assert.equal(result.success, false);
    assert.match(result.message, /无法安全读取当前数据|操作已停止/);
    assert.deepEqual(api.storage.snapshot(), before, '导入不得覆盖核心数据或创建导入前备份');
    assert.deepEqual(api.storage.writeLog, []);
  });

  test(`${scriptPath}：非法分类图可导出原样只读救援副本`, () => {
    const api = loadInvalidGraph(scriptPath);
    assert.equal(api.db.getCoreReadStatus().code, 'CATEGORY_GRAPH_INVALID');
    const before = api.storage.snapshotCore();

    const recoveryCopy = cloneJson(api.db.exportRecoveryCopy());

    assert.equal(recoveryCopy.version, 3);
    assert.equal(recoveryCopy.recoveryOnly, true);
    assert.equal(recoveryCopy.recoveryReason, 'CATEGORY_GRAPH_INVALID');
    assert.equal(new Date(recoveryCopy.exportedAt).toISOString(), recoveryCopy.exportedAt);
    assert.deepEqual(recoveryCopy.expenses, INVALID_GRAPH_DATA.expenses);
    assert.deepEqual(recoveryCopy.categories, INVALID_GRAPH_DATA.categories);
    assert.deepEqual(recoveryCopy.budget, INVALID_GRAPH_DATA.budget);
    assert.deepEqual(recoveryCopy.settings, INVALID_GRAPH_DATA.settings);
    assert.deepEqual(api.storage.snapshotCore(), before, '救援导出不得迁移或改写任何原数据');
    assert.deepEqual(api.storage.writeLog, []);
  });

  test(`${scriptPath}：importAll 明确拒绝 recoveryOnly 救援副本且零写`, () => {
    const source = loadInvalidGraph(scriptPath);
    const recoveryCopy = cloneJson(source.db.exportRecoveryCopy());
    assert.equal(recoveryCopy.recoveryOnly, true);

    const targetStorage = new MemoryStorage(createRawSeed(VALID_DATA));
    const target = loadExpenseDB(scriptPath, targetStorage);
    const before = targetStorage.snapshot();
    const result = target.importJson(JSON.stringify(recoveryCopy));

    assert.equal(result.success, false);
    assert.equal(result.counts, null);
    assert.match(result.message, /只读救援副本.*不能直接恢复/);
    assert.deepEqual(targetStorage.snapshot(), before, '拒绝救援副本不得覆盖有效账本');
    assert.deepEqual(targetStorage.writeLog, []);
  });

  test(`${scriptPath}：损坏 JSON 时 exportRecoveryCopy 返回 null 且零写`, () => {
    const corruptedSeed = createRawSeed(INVALID_GRAPH_DATA);
    corruptedSeed[STORAGE_KEYS.categories] = '{bad-json';
    const storage = new MemoryStorage(corruptedSeed);
    const api = loadExpenseDB(scriptPath, storage);
    const before = storage.snapshot();

    assert.equal(api.db.exportRecoveryCopy(), null);
    assert.deepEqual(storage.snapshot(), before);
    assert.deepEqual(storage.writeLog, []);
  });
}
