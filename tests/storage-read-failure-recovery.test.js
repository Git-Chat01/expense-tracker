/**
 * 写锁逃生通道回归测试（2026-08-12）
 *
 * 背景：fail-closed 写锁（读失败后拒绝一切写入）修复后曾出现"锁死无出路"——
 * 数据损坏时既无法导出救援副本，也无法用健康备份覆盖恢复。
 * 本组测试锁定逃生通道的三个承诺：
 *   1. exportRawRecoveryCopy 在 JSON 解析失败时仍能按原始字符串导出；
 *   2. importAll(data, { forceRecovery: true }) 在二次确认后可强制恢复，
 *      且覆盖前必须先把原始数据备份到逃生 key，写失败必须逐字节回滚；
 *   3. clearAll 必须清除全部备份 key 并复位写锁（清空后空数据是健康状态）。
 */
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

const BACKUP_KEYS = {
  preImport: 'expense_tracker_pre_import_backup',
  lastBackup: 'expense_tracker_last_backup',
  forceImport: 'expense_tracker_force_import_backup',
};

/** 损坏的 settings：无法通过 JSON.parse，触发 _writeBlockedByReadFailure */
const CORRUPTED_SETTINGS_RAW = 'not-json{{corrupted';

const VALID_CATEGORY = {
  id: 'cat-recovered',
  name: '恢复分类',
  icon: '📦',
  parentId: null,
  isPreset: false,
  order: 0,
};

const VALID_EXPENSE = {
  id: 'expense-recovered',
  amount: 66.6,
  categoryId: VALID_CATEGORY.id,
  date: '2026-08-12',
  time: '10:00',
  location: '恢复地点',
  paymentMethod: 'cash',
  necessity: 'need',
  note: '强制恢复后的记录',
  createdAt: '2026-08-12T02:00:00.000Z',
};

const VALID_BACKUP = {
  version: 4,
  exportedAt: '2026-08-12T03:00:00.000Z',
  expenses: [VALID_EXPENSE],
  categories: [VALID_CATEGORY],
  budget: { monthlyTotal: 800, categories: { [VALID_CATEGORY.id]: 300 } },
  settings: { currency: '¥', theme: 'dark' },
};

/** 核心数据损坏但可解析（settings 是合法 JSON、读失败只由损坏 key 触发） */
function seedWithCorruptedSettings() {
  return {
    [STORAGE_KEYS.expenses]: JSON.stringify([]),
    [STORAGE_KEYS.categories]: JSON.stringify([]),
    [STORAGE_KEYS.budget]: JSON.stringify({ monthlyTotal: 0, categories: {} }),
    [STORAGE_KEYS.settings]: CORRUPTED_SETTINGS_RAW,
  };
}

class FaultInjectionStorage {
  constructor(seed) {
    this.values = new Map(Object.entries(seed));
    this.getFailures = new Set();
    this.setFailures = new Map();
    this.writeLog = [];
  }

  get length() { return this.values.size; }

  key(index) { return [...this.values.keys()][index] ?? null; }

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
      this.writeLog.push({ operation: 'setItem', key: stringKey, value: stringValue, failed: true });
      if (remainingFailures === 1) this.setFailures.delete(stringKey);
      else this.setFailures.set(stringKey, remainingFailures - 1);
      throw new Error(`故障注入：写入 ${stringKey} 失败`);
    }
    this.writeLog.push({ operation: 'setItem', key: stringKey, value: stringValue, failed: false });
    this.values.set(stringKey, stringValue);
  }

  removeItem(key) {
    const stringKey = String(key);
    this.writeLog.push({ operation: 'removeItem', key: stringKey });
    this.values.delete(stringKey);
  }

  setRaw(key, value) { this.values.set(key, value); }
  deleteRaw(key) { this.values.delete(key); }
  hasRaw(key) { return this.values.has(key); }
  getRaw(key) { return this.values.has(key) ? this.values.get(key) : null; }
  failGet(key) { this.getFailures.add(key); }
  failSet(key, count = 1) { this.setFailures.set(key, count); }

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
      + '  importJsonForced: raw => ExpenseDB.importAll(JSON.parse(raw), { forceRecovery: true }),\n'
      + '};',
    context,
    { filename: absolutePath },
  );

  return context.__expenseDBTest;
}

for (const scriptPath of STORAGE_SCRIPTS) {
  test(`${scriptPath}：读失败时 exportRawRecoveryCopy 按原始字符串导出`, () => {
    const storage = new FaultInjectionStorage(seedWithCorruptedSettings());
    const t = loadExpenseDB(scriptPath, storage);

    assert.equal(t.db.exportAll(), null, '读失败时 exportAll 必须失败');
    assert.equal(t.db.exportRecoveryCopy(), null, '读失败时 exportRecoveryCopy 必须失败');

    const rawCopy = t.db.exportRawRecoveryCopy();
    assert.notEqual(rawCopy, null, '读失败时 raw 救援导出必须可用');
    assert.equal(rawCopy.rawOnly, true);
    assert.equal(rawCopy.recoveryReason, 'READ_FAILURE');
    assert.equal(
      rawCopy.raw[STORAGE_KEYS.settings],
      CORRUPTED_SETTINGS_RAW,
      '损坏的原始字符串必须逐字节保全在导出中',
    );
    assert.equal(
      rawCopy.raw[STORAGE_KEYS.expenses],
      '[]',
      '健康 key 的原始字符串同样要保全',
    );
  });

  test(`${scriptPath}：读失败时 importAll 拒绝并提示 needsForceRecovery，核心数据零改动`, () => {
    const storage = new FaultInjectionStorage(seedWithCorruptedSettings());
    const t = loadExpenseDB(scriptPath, storage);
    const before = storage.snapshotCore();

    const result = t.importJson(JSON.stringify(VALID_BACKUP));
    assert.equal(result.success, false, '读失败时普通导入必须失败');
    assert.equal(result.needsForceRecovery, true, '必须告知 UI 可以走强制恢复');

    const after = storage.snapshotCore();
    assert.deepEqual(after, before, '普通导入被锁时不得改动任何核心数据');
    assert.equal(
      storage.getRaw(BACKUP_KEYS.forceImport),
      null,
      '普通导入不得提前写逃生备份（只有真正覆盖前才写）',
    );
  });

  test(`${scriptPath}：raw 救援副本不可被 importAll 误用为备份`, () => {
    const storage = new FaultInjectionStorage(seedWithCorruptedSettings());
    const t = loadExpenseDB(scriptPath, storage);

    const rawCopy = t.db.exportRawRecoveryCopy();
    const result = t.db.importAll(rawCopy, { forceRecovery: true });
    assert.equal(result.success, false, 'raw 副本必须被导入校验拒绝（即使 force 模式）');
  });

  test(`${scriptPath}：forceRecovery 成功后数据正确、写锁复位、逃生备份留存`, () => {
    const storage = new FaultInjectionStorage(seedWithCorruptedSettings());
    const t = loadExpenseDB(scriptPath, storage);

    const result = t.importJsonForced(JSON.stringify(VALID_BACKUP));
    assert.equal(result.success, true, `强制恢复应成功，实际：${result.message}`);

    // 1. 数据正确
    const expenses = t.db.getExpenses();
    assert.equal(expenses.length, 1);
    assert.equal(expenses[0].id, VALID_EXPENSE.id);
    assert.equal(expenses[0].necessity, 'need', 'necessity 必须保留');
    assert.equal(t.db.getSettings().theme, 'dark');

    // 2. 写锁已复位：后续新增可以写入
    const added = t.db.addExpense({
      amount: 1.5,
      categoryId: VALID_CATEGORY.id,
      date: '2026-08-12',
      time: '11:00',
    });
    assert.notEqual(added, null, '强制恢复后写锁必须复位，addExpense 必须可用');

    // 3. 逃生备份留存且包含覆盖前的损坏原始数据
    const forceBackupRaw = storage.getRaw(BACKUP_KEYS.forceImport);
    assert.notEqual(forceBackupRaw, null, '逃生备份必须留存');
    const forceBackup = JSON.parse(forceBackupRaw);
    assert.equal(
      forceBackup.raw[STORAGE_KEYS.settings],
      CORRUPTED_SETTINGS_RAW,
      '逃生备份必须保全覆盖前的损坏原始字符串',
    );

    // 4. 覆盖后新数据不再是损坏 JSON
    assert.equal(
      JSON.parse(storage.getRaw(STORAGE_KEYS.settings)).theme,
      'dark',
      'settings 键已被健康数据覆盖',
    );
  });

  test(`${scriptPath}：forceRecovery 逃生备份创建失败时中止且零改动`, () => {
    const storage = new FaultInjectionStorage(seedWithCorruptedSettings());
    const t = loadExpenseDB(scriptPath, storage);
    const before = storage.snapshotCore();

    // 注入：逃生 key 的写入失败（模拟配额超限）
    storage.failSet(BACKUP_KEYS.forceImport, 1);

    const result = t.importJsonForced(JSON.stringify(VALID_BACKUP));
    assert.equal(result.success, false, '逃生备份写不进去时必须中止');
    assert.deepEqual(storage.snapshotCore(), before, '中止时核心数据必须零改动');
  });

  test(`${scriptPath}：forceRecovery 部分写失败时逐字节回滚`, () => {
    const storage = new FaultInjectionStorage(seedWithCorruptedSettings());
    const t = loadExpenseDB(scriptPath, storage);
    const before = storage.snapshotCore();

    // 注入：settings key 写入失败（expenses/categories/budget 已写成功后触发回滚）
    storage.failSet(STORAGE_KEYS.settings, 1);

    const result = t.importJsonForced(JSON.stringify(VALID_BACKUP));
    assert.equal(result.success, false, '部分写失败时导入必须失败');

    const after = storage.snapshotCore();
    assert.deepEqual(after, before, '回滚后四个核心 key 必须与覆盖前逐字节相同');
  });

  test(`${scriptPath}：clearAll 清除全部备份 key 并复位写锁`, () => {
    const storage = new FaultInjectionStorage({
      ...seedWithCorruptedSettings(),
      [BACKUP_KEYS.preImport]: JSON.stringify({ version: 4, expenses: [], categories: [], budget: {}, settings: {} }),
      [BACKUP_KEYS.lastBackup]: '2026-08-01T00:00:00.000Z',
      [BACKUP_KEYS.forceImport]: JSON.stringify({ raw: {} }),
    });
    const t = loadExpenseDB(scriptPath, storage);

    // 先触发读失败锁：读取损坏的 settings 键（返回值是默认对象而非 null，不断言它）
    t.db.getSettings();
    const status = t.db.getCoreReadStatus();
    assert.equal(status.ok, false, '前置条件：clearAll 前核心读取应失败');
    assert.equal(status.code, 'READ_FAILURE', '前置条件：clearAll 前写锁应处于读失败状态');

    t.db.clearAll();

    // 1. 全部核心与备份 key 已清除
    for (const key of [...Object.values(STORAGE_KEYS), ...Object.values(BACKUP_KEYS)]) {
      assert.equal(storage.getRaw(key), null, `清空后 ${key} 必须不存在`);
    }

    // 2. 写锁已复位：清空后可以正常初始化分类并记账
    const PRESETS = [
      { id: 'cat-food', name: '餐饮', icon: '🍜', parentId: null, isPreset: true, order: 0 },
    ];
    const syncResult = t.db.syncPresetCategories(PRESETS);
    assert.notEqual(syncResult, false, '清空后 syncPresetCategories 必须可用');

    const added = t.db.addExpense({
      amount: 9.9,
      categoryId: 'cat-food',
      date: '2026-08-12',
      time: '12:00',
    });
    assert.notEqual(added, null, '清空后 addExpense 必须可用（写锁已复位）');
  });
}
