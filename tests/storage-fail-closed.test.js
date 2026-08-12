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

const LAST_BACKUP_KEY = 'expense_tracker_last_backup';

const CORE_STORAGE_KEYS = new Set(Object.values(STORAGE_KEYS));

const EXISTING_CATEGORY = {
  id: 'cat-existing',
  name: '原有分类',
  icon: '📌',
  parentId: null,
  isPreset: false,
  order: 0,
};

const EXISTING_EXPENSE = {
  id: 'expense-existing',
  amount: 88.88,
  categoryId: EXISTING_CATEGORY.id,
  date: '2026-08-10',
  time: '08:08',
  location: '原有地点',
  paymentMethod: 'cash',
  necessity: 'need',
  note: '原始数据不得覆盖',
  createdAt: '2026-08-10T08:08:00.000Z',
};

const BASE_STORAGE = {
  [STORAGE_KEYS.expenses]: JSON.stringify([EXISTING_EXPENSE]),
  [STORAGE_KEYS.categories]: JSON.stringify([EXISTING_CATEGORY]),
  [STORAGE_KEYS.budget]: JSON.stringify({
    monthlyTotal: 500,
    categories: { [EXISTING_CATEGORY.id]: 100 },
  }),
  [STORAGE_KEYS.settings]: JSON.stringify({
    currency: '¥',
    theme: 'light',
  }),
};

const VALID_IMPORT_BACKUP_JSON = JSON.stringify({
  version: 2,
  exportedAt: '2026-08-11T12:00:00.000Z',
  expenses: [{
    id: 'expense-imported',
    amount: 12.34,
    categoryId: 'cat-imported',
    date: '2026-08-11',
    time: '12:00',
    location: '导入地点',
    paymentMethod: 'alipay',
    necessity: 'want',
    note: '这份数据不应覆盖读取失败的原数据',
    createdAt: '2026-08-11T12:00:00.000Z',
  }],
  categories: [{
    id: 'cat-imported',
    name: '导入分类',
    icon: '📦',
    parentId: null,
    isPreset: false,
    order: 0,
  }],
  budget: {
    monthlyTotal: 1000,
    categories: { 'cat-imported': 200 },
  },
  settings: {
    currency: '¥',
    theme: 'dark',
  },
});

class FaultInjectionStorage {
  constructor(seed) {
    this.values = new Map(Object.entries(seed));
    this.getFailures = new Set();
    this.setFailures = new Map();
    this.writeLog = [];
  }

  get length() {
    return this.values.size;
  }

  key(index) {
    return [...this.values.keys()][index] ?? null;
  }

  getItem(key) {
    if (this.getFailures.has(key)) {
      throw new Error(`故障注入：读取 ${key} 失败`);
    }
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    const stringKey = String(key);
    const stringValue = String(value);
    const remainingFailures = this.setFailures.get(stringKey) || 0;
    if (remainingFailures > 0) {
      this.writeLog.push({
        operation: 'setItem',
        key: stringKey,
        value: stringValue,
        failed: true,
      });
      if (remainingFailures === 1) this.setFailures.delete(stringKey);
      else this.setFailures.set(stringKey, remainingFailures - 1);
      throw new Error(`故障注入：写入 ${stringKey} 失败`);
    }

    this.writeLog.push({
      operation: 'setItem',
      key: stringKey,
      value: stringValue,
      failed: false,
    });
    this.values.set(stringKey, stringValue);
  }

  removeItem(key) {
    const stringKey = String(key);
    this.writeLog.push({ operation: 'removeItem', key: stringKey });
    this.values.delete(stringKey);
  }

  setRaw(key, value) {
    this.values.set(key, value);
  }

  deleteRaw(key) {
    this.values.delete(key);
  }

  hasRaw(key) {
    return this.values.has(key);
  }

  getRaw(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  failGet(key) {
    this.getFailures.add(key);
  }

  failSet(key, count = 1) {
    this.setFailures.set(key, count);
  }

  snapshotCore() {
    return Object.fromEntries(
      Object.values(STORAGE_KEYS).map(key => [
        key,
        this.values.has(key) ? this.values.get(key) : null,
      ]),
    );
  }
}

function loadExpenseDB(relativePath, storage) {
  const absolutePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const context = vm.createContext({
    console: { error() {} },
    localStorage: storage,
  });

  vm.runInContext(
    `${source}\n;globalThis.__expenseDBTest = {\n`
      + '  db: ExpenseDB,\n'
      + '  importJson: raw => ExpenseDB.importAll(JSON.parse(raw)),\n'
      + '};',
    context,
    { filename: absolutePath },
  );

  return context.__expenseDBTest;
}

function capture(operation) {
  try {
    return { result: operation(), error: null };
  } catch (error) {
    return { result: undefined, error };
  }
}

function assertExplicitFailure(operationName, result) {
  const isFailure = result === null
    || result === false
    || (result !== null
      && typeof result === 'object'
      && (result.success === false || result.ok === false));

  assert.equal(
    isFailure,
    true,
    `${operationName} 不得在核心读取失败后返回成功或可用数据`,
  );
}

function assertNoCoreMutation(storage, before, operationName) {
  const coreWrites = storage.writeLog.filter(entry => CORE_STORAGE_KEYS.has(entry.key));
  assert.deepEqual(
    coreWrites,
    [],
    `${operationName} 必须在第一次核心写入前中止`,
  );
  assert.deepEqual(
    storage.snapshotCore(),
    before,
    `${operationName} 不得覆盖任何原始核心值`,
  );
}

const OPERATIONS = [
  {
    name: 'addExpense',
    faultKey: STORAGE_KEYS.expenses,
    invalidShape: {},
    invoke({ db }) {
      return db.addExpense({
        amount: 9.99,
        categoryId: EXISTING_CATEGORY.id,
        date: '2026-08-11',
        time: '09:09',
        location: '',
        paymentMethod: 'cash',
        necessity: 'need',
        note: '读取失败时不得写入',
      });
    },
  },
  {
    name: 'addCategory',
    faultKey: STORAGE_KEYS.categories,
    invalidShape: {},
    invoke({ db }) {
      return db.addCategory({
        id: 'cat-added-after-read-failure',
        name: '读取失败时不得新增',
        icon: '🛑',
      });
    },
  },
  {
    name: 'syncPresetCategories',
    faultKey: STORAGE_KEYS.categories,
    invalidShape: {},
    invoke({ db }) {
      return db.syncPresetCategories([{
        id: 'cat-preset-new',
        name: '新增预设',
        icon: '🧪',
        parentId: null,
        isPreset: true,
        order: 1,
      }]);
    },
  },
  {
    name: 'saveBudget',
    faultKey: STORAGE_KEYS.budget,
    invalidShape: [],
    invoke({ db }) {
      return db.saveBudget({
        monthlyTotal: 888,
        categories: { [EXISTING_CATEGORY.id]: 66 },
      });
    },
  },
  {
    name: 'saveSettings',
    faultKey: STORAGE_KEYS.settings,
    invalidShape: [],
    invoke({ db }) {
      return db.saveSettings({ theme: 'dark' });
    },
  },
  {
    name: 'exportAll',
    faultKey: STORAGE_KEYS.budget,
    invalidShape: [],
    invoke({ db }) {
      return db.exportAll();
    },
  },
  {
    name: 'importAll',
    faultKey: STORAGE_KEYS.settings,
    invalidShape: [],
    invoke({ importJson }) {
      return importJson(VALID_IMPORT_BACKUP_JSON);
    },
  },
];

const FAULTS = [
  {
    name: '损坏 JSON',
    apply(storage, operation) {
      storage.setRaw(operation.faultKey, '{"broken":');
    },
  },
  {
    name: '错误结构',
    apply(storage, operation) {
      storage.setRaw(operation.faultKey, JSON.stringify(operation.invalidShape));
    },
  },
  {
    name: 'Storage.getItem 抛错',
    apply(storage, operation) {
      storage.failGet(operation.faultKey);
    },
  },
];

for (const scriptPath of STORAGE_SCRIPTS) {
  for (const operation of OPERATIONS) {
    for (const fault of FAULTS) {
      test(`${scriptPath}：${operation.name} 遇到${fault.name}时 fail-closed`, () => {
        const storage = new FaultInjectionStorage(BASE_STORAGE);
        fault.apply(storage, operation);
        const before = storage.snapshotCore();
        const api = loadExpenseDB(scriptPath, storage);

        const outcome = capture(() => operation.invoke(api));

        assertNoCoreMutation(storage, before, operation.name);
        assert.equal(
          outcome.error,
          null,
          `${operation.name} 应返回可处理的失败信号，而不是抛出未捕获异常`,
        );
        assertExplicitFailure(operation.name, outcome.result);
      });
    }
  }
}

const INVALID_ARRAY_ELEMENT_OPERATION_NAMES = [
  'addExpense',
  'addCategory',
  'syncPresetCategories',
];

for (const scriptPath of STORAGE_SCRIPTS) {
  for (const operationName of INVALID_ARRAY_ELEMENT_OPERATION_NAMES) {
    test(`${scriptPath}：${operationName} 拒绝顶层数组中的损坏元素`, () => {
      const operation = OPERATIONS.find(candidate => candidate.name === operationName);
      assert.ok(operation, `${operationName} 测试操作必须存在`);

      const storage = new FaultInjectionStorage(BASE_STORAGE);
      storage.setRaw(operation.faultKey, JSON.stringify([null]));
      const before = storage.snapshotCore();
      const api = loadExpenseDB(scriptPath, storage);

      const outcome = capture(() => operation.invoke(api));

      assertNoCoreMutation(storage, before, operation.name);
      assert.equal(
        outcome.error,
        null,
        `${operation.name} 遇到损坏数组元素时应返回显式失败，而不是抛出异常`,
      );
      assertExplicitFailure(operation.name, outcome.result);
    });
  }
}

for (const scriptPath of STORAGE_SCRIPTS) {
  for (const operationName of INVALID_ARRAY_ELEMENT_OPERATION_NAMES) {
    test(`${scriptPath}：${operationName} 拒绝数组中缺少必需字段的对象`, () => {
      const operation = OPERATIONS.find(candidate => candidate.name === operationName);
      assert.ok(operation, `${operationName} 测试操作必须存在`);

      const storage = new FaultInjectionStorage(BASE_STORAGE);
      storage.setRaw(operation.faultKey, JSON.stringify([{}]));
      const before = storage.snapshotCore();
      const api = loadExpenseDB(scriptPath, storage);

      const outcome = capture(() => operation.invoke(api));

      assertNoCoreMutation(storage, before, operation.name);
      assert.equal(
        outcome.error,
        null,
        `${operation.name} 遇到字段残缺的数组元素时应返回显式失败，而不是抛出异常`,
      );
      assertExplicitFailure(operation.name, outcome.result);
    });
  }
}

function createStorageWithout(...keys) {
  const storage = new FaultInjectionStorage(BASE_STORAGE);
  for (const key of keys) storage.deleteRaw(key);
  return storage;
}

function parseStoredJson(storage, key) {
  const raw = storage.getRaw(key);
  assert.notEqual(raw, null, `${key} 应已写入隔离内存存储`);
  return JSON.parse(raw);
}

function assertOriginalNecessityPreserved(storage) {
  const expenses = parseStoredJson(storage, STORAGE_KEYS.expenses);
  const original = expenses.find(expense => expense.id === EXISTING_EXPENSE.id);
  assert.ok(original, '回滚后应恢复原始账单');
  assert.equal(original.necessity, 'need', '回滚不得丢失原始账单 necessity');
}

function importWithSetFailure(scriptPath, { missingKeys = [], failureKey }) {
  const storage = createStorageWithout(...missingKeys);
  const before = storage.snapshotCore();
  storage.failSet(failureKey);
  const api = loadExpenseDB(scriptPath, storage);

  const result = api.importJson(VALID_IMPORT_BACKUP_JSON);

  assert.equal(result.success, false, '部分写入失败时导入必须报告失败');
  assert.match(result.message, /恢复/, '导入失败信息应明确说明恢复结果');
  assert.deepEqual(storage.snapshotCore(), before, '部分写入失败后应逐字恢复全部核心值和缺键状态');
  assertOriginalNecessityPreserved(storage);

  const failedWriteIndex = storage.writeLog.findIndex(entry => (
    entry.operation === 'setItem'
      && entry.key === failureKey
      && entry.failed === true
  ));
  assert.ok(failedWriteIndex > 0, '故障应发生在至少一个核心键成功写入之后');
  assert.ok(
    storage.writeLog.slice(0, failedWriteIndex).some(entry => (
      entry.operation === 'setItem'
        && CORE_STORAGE_KEYS.has(entry.key)
        && entry.failed === false
    )),
    '测试必须实际进入部分写入状态，不能在第一步提前失败',
  );

  return storage;
}

for (const scriptPath of STORAGE_SCRIPTS) {
  test(`${scriptPath}：账单键确实不存在时 addExpense 可以创建首条记录`, () => {
    const storage = createStorageWithout(STORAGE_KEYS.expenses);
    const { db } = loadExpenseDB(scriptPath, storage);

    const result = db.addExpense({
      amount: 6.66,
      categoryId: EXISTING_CATEGORY.id,
      date: '2026-08-11',
      time: '06:06',
      location: '',
      paymentMethod: 'cash',
      necessity: 'impulse',
      note: '缺键正向用例',
    });

    assert.ok(result, '缺少账单键不是读取失败，应允许保存');
    const expenses = parseStoredJson(storage, STORAGE_KEYS.expenses);
    assert.equal(expenses.length, 1);
    assert.equal(expenses[0].necessity, 'impulse');
    assert.equal(expenses[0].note, '缺键正向用例');
  });

  test(`${scriptPath}：分类键确实不存在时 syncPresetCategories 可以初始化`, () => {
    const storage = createStorageWithout(STORAGE_KEYS.categories);
    const { db } = loadExpenseDB(scriptPath, storage);
    const presets = [{
      id: 'cat-first-preset',
      name: '首个预设',
      icon: '🧪',
      parentId: null,
      isPreset: true,
      order: 0,
    }];

    const result = db.syncPresetCategories(presets);

    assert.equal(result, true, '缺少分类键时应允许初始化预设');
    assert.deepEqual(parseStoredJson(storage, STORAGE_KEYS.categories), presets);
  });

  test(`${scriptPath}：预算键确实不存在时 saveBudget 可以保存`, () => {
    const storage = createStorageWithout(STORAGE_KEYS.budget);
    const { db } = loadExpenseDB(scriptPath, storage);
    const budget = {
      monthlyTotal: 900,
      categories: { [EXISTING_CATEGORY.id]: 90 },
    };

    const result = db.saveBudget(budget);

    assert.equal(result, true, '缺少预算键时应允许首次保存');
    assert.deepEqual(parseStoredJson(storage, STORAGE_KEYS.budget), budget);
  });

  test(`${scriptPath}：设置键确实不存在时 saveSettings 使用默认值合并保存`, () => {
    const storage = createStorageWithout(STORAGE_KEYS.settings);
    const { db } = loadExpenseDB(scriptPath, storage);

    const result = db.saveSettings({ theme: 'dark' });

    assert.equal(result, true, '缺少设置键时应允许首次保存');
    assert.deepEqual(
      parseStoredJson(storage, STORAGE_KEYS.settings),
      { currency: '¥', theme: 'dark' },
    );
  });

  test(`${scriptPath}：全部核心键确实不存在时 exportAll 返回空备份`, () => {
    const storage = new FaultInjectionStorage({});
    const { db } = loadExpenseDB(scriptPath, storage);

    const result = db.exportAll();
    const serialized = JSON.parse(JSON.stringify(result));
    const { exportedAt, ...backup } = serialized;

    assert.deepEqual(backup, {
      version: 4,
      expenses: [],
      categories: [],
      budget: { monthlyTotal: 0, categories: {} },
      settings: {},
    });
    assert.equal(new Date(exportedAt).toISOString(), exportedAt);
    assert.deepEqual(
      storage.writeLog.filter(entry => CORE_STORAGE_KEYS.has(entry.key)),
      [],
      '导出空备份不得创建或回填任何核心键',
    );
  });

  test(`${scriptPath}：全部核心键缺失时导出的空备份可以成功恢复`, () => {
    const sourceStorage = new FaultInjectionStorage({});
    const sourceApi = loadExpenseDB(scriptPath, sourceStorage);
    const emptyBackup = sourceApi.db.exportAll();
    assert.ok(emptyBackup, '全部核心键缺失时仍应生成合法空备份');

    const targetStorage = new FaultInjectionStorage(BASE_STORAGE);
    const targetApi = loadExpenseDB(scriptPath, targetStorage);
    const importResult = targetApi.importJson(JSON.stringify(emptyBackup));

    assert.equal(importResult.success, true, importResult.message);
    assert.equal(targetApi.db.getExpenses().length, 0, '恢复空备份后账单必须为空');

    const restoredBackup = JSON.parse(JSON.stringify(targetApi.db.exportAll()));
    const { exportedAt, ...restoredCore } = restoredBackup;
    assert.deepEqual(restoredCore, {
      version: 4,
      expenses: [],
      categories: [],
      budget: { monthlyTotal: 0, categories: {} },
      settings: {},
    });
    assert.equal(new Date(exportedAt).toISOString(), exportedAt);

    const repeatResult = targetApi.importJson(JSON.stringify(restoredBackup));
    assert.equal(repeatResult.success, true, '恢复后的空状态应仍是可再次导入的合法备份');
  });

  test(`${scriptPath}：核心导入成功但备份时间写入失败时返回警告`, () => {
    const storage = new FaultInjectionStorage(BASE_STORAGE);
    storage.failSet(LAST_BACKUP_KEY);
    const api = loadExpenseDB(scriptPath, storage);
    const expected = JSON.parse(VALID_IMPORT_BACKUP_JSON);

    const result = api.importJson(VALID_IMPORT_BACKUP_JSON);

    assert.equal(result.success, true, '辅助备份时间写入失败不得伪装成核心导入失败');
    assert.equal(typeof result.warning, 'string');
    assert.ok(result.warning.trim(), '辅助写入失败必须返回非空警告');
    assert.deepEqual(parseStoredJson(storage, STORAGE_KEYS.expenses), expected.expenses);
    assert.deepEqual(parseStoredJson(storage, STORAGE_KEYS.categories), expected.categories);
    assert.deepEqual(parseStoredJson(storage, STORAGE_KEYS.budget), expected.budget);
    assert.deepEqual(parseStoredJson(storage, STORAGE_KEYS.settings), expected.settings);
    assert.equal(storage.hasRaw(LAST_BACKUP_KEY), false, '失败的备份时间写入不得伪造成功值');
    assert.ok(
      storage.writeLog.some(entry => (
        entry.operation === 'setItem'
          && entry.key === LAST_BACKUP_KEY
          && entry.failed === true
      )),
      '测试必须实际注入最近备份时间写入故障',
    );
  });

  test(`${scriptPath}：importAll 部分写失败后恢复全部既有核心值`, () => {
    importWithSetFailure(scriptPath, {
      failureKey: STORAGE_KEYS.settings,
    });
  });

  test(`${scriptPath}：importAll 回滚会把原本缺失的预算键恢复为不存在`, () => {
    const storage = importWithSetFailure(scriptPath, {
      missingKeys: [STORAGE_KEYS.budget],
      failureKey: STORAGE_KEYS.settings,
    });

    assert.equal(storage.hasRaw(STORAGE_KEYS.budget), false);
    assert.ok(
      storage.writeLog.some(entry => (
        entry.operation === 'removeItem'
          && entry.key === STORAGE_KEYS.budget
      )),
      '已在导入中写入的缺失键必须通过删除恢复其原始不存在状态',
    );
  });

  test(`${scriptPath}：原 settings 键不存在且 settings 写入失败时回滚后仍不存在`, () => {
    const storage = importWithSetFailure(scriptPath, {
      missingKeys: [STORAGE_KEYS.settings],
      failureKey: STORAGE_KEYS.settings,
    });

    assert.equal(storage.hasRaw(STORAGE_KEYS.settings), false);
  });
}
