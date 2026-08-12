/**
 * 分类编辑校验与墓碑预算清理回归测试（2026-08-12）
 *
 * 1. updateCategory 对显式提供的非法 name 必须返回 false，不得"假成功"；
 *    空 icon 保持与 addCategory 一致的 '📌' 兜底约定。
 * 2. saveBudget 合并模式必须自动剔除已墓碑化（软删除）分类的预算条目，
 *    否则幽灵预算永远无法清除。
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

const ACTIVE_CATEGORY = {
  id: 'cat-active',
  name: '活跃分类',
  icon: '🍜',
  parentId: null,
  isPreset: false,
  order: 0,
};

const TOMBSTONE_CATEGORY = {
  id: 'cat-tombstone',
  name: '已删除分类',
  icon: '☕',
  parentId: null,
  isPreset: false,
  order: 1,
  deletedAt: '2026-08-01T00:00:00.000Z',
};

function seedStorage() {
  return {
    [STORAGE_KEYS.expenses]: JSON.stringify([]),
    [STORAGE_KEYS.categories]: JSON.stringify([ACTIVE_CATEGORY, TOMBSTONE_CATEGORY]),
    [STORAGE_KEYS.budget]: JSON.stringify({
      monthlyTotal: 1000,
      categories: {
        [ACTIVE_CATEGORY.id]: 400,
        [TOMBSTONE_CATEGORY.id]: 200,
      },
    }),
    [STORAGE_KEYS.settings]: JSON.stringify({ currency: '¥', theme: 'light' }),
  };
}

class FaultInjectionStorage {
  constructor(seed) {
    this.values = new Map(Object.entries(seed));
    this.getFailures = new Set();
    this.setFailures = new Map();
  }
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) {
    if (this.getFailures.has(key)) throw new Error(`故障注入：读取 ${key} 失败`);
    return this.values.has(key) ? this.values.get(key) : null;
  }
  setItem(key, value) {
    const remainingFailures = this.setFailures.get(String(key)) || 0;
    if (remainingFailures > 0) {
      if (remainingFailures === 1) this.setFailures.delete(String(key));
      else this.setFailures.set(String(key), remainingFailures - 1);
      throw new Error(`故障注入：写入 ${key} 失败`);
    }
    this.values.set(String(key), String(value));
  }
  removeItem(key) { this.values.delete(String(key)); }
  setRaw(key, value) { this.values.set(key, value); }
  getRaw(key) { return this.values.has(key) ? this.values.get(key) : null; }
  failSet(key, count = 1) { this.setFailures.set(key, count); }
}

function loadExpenseDB(relativePath, storage) {
  const absolutePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const context = vm.createContext({
    console: { error() {} },
    localStorage: storage,
  });
  vm.runInContext(`${source}\n;globalThis.__t = { db: ExpenseDB };`, context, { filename: absolutePath });
  return context.__t;
}

for (const scriptPath of STORAGE_SCRIPTS) {
  test(`${scriptPath}：updateCategory 拒绝空/空白/非字符串 name，且数据零改动`, () => {
    const storage = new FaultInjectionStorage(seedStorage());
    const t = loadExpenseDB(scriptPath, storage);
    const before = storage.getRaw(STORAGE_KEYS.categories);

    for (const badName of ['', '   ', 123, null, {}, []]) {
      const result = t.db.updateCategory(ACTIVE_CATEGORY.id, { name: badName });
      assert.equal(result, false, `name=${JSON.stringify(badName)} 必须被拒绝`);
      assert.equal(
        storage.getRaw(STORAGE_KEYS.categories),
        before,
        `name=${JSON.stringify(badName)} 被拒绝后分类数据不得改动`,
      );
    }
  });

  test(`${scriptPath}：updateCategory 空 icon 兜底 '📌'（与 addCategory 约定一致）`, () => {
    const storage = new FaultInjectionStorage(seedStorage());
    const t = loadExpenseDB(scriptPath, storage);

    assert.equal(t.db.updateCategory(ACTIVE_CATEGORY.id, { icon: '' }), true);
    assert.equal(t.db.getCategory(ACTIVE_CATEGORY.id).icon, '📌');
  });

  test(`${scriptPath}：updateCategory 拒绝非字符串 icon 且数据零改动`, () => {
    const storage = new FaultInjectionStorage(seedStorage());
    const t = loadExpenseDB(scriptPath, storage);
    const before = storage.getRaw(STORAGE_KEYS.categories);

    for (const badIcon of [123, null, {}, []]) {
      assert.equal(t.db.updateCategory(ACTIVE_CATEGORY.id, { icon: badIcon }), false);
      assert.equal(storage.getRaw(STORAGE_KEYS.categories), before);
    }
  });

  test(`${scriptPath}：updateCategory 合法 patch 正常生效`, () => {
    const storage = new FaultInjectionStorage(seedStorage());
    const t = loadExpenseDB(scriptPath, storage);

    assert.equal(t.db.updateCategory(ACTIVE_CATEGORY.id, { name: '  新名称  ', icon: '🍰' }), true);
    const updated = t.db.getCategory(ACTIVE_CATEGORY.id);
    assert.equal(updated.name, '新名称', 'name 应 trim 后落库');
    assert.equal(updated.icon, '🍰');
  });

  test(`${scriptPath}：saveBudget 显式以 0 清除墓碑分类的幽灵预算`, () => {
    const storage = new FaultInjectionStorage(seedStorage());
    const t = loadExpenseDB(scriptPath, storage);

    // draft 显式带墓碑 ID + 0 → 走删除分支清除该条目
    const result = t.db.saveBudget({
      monthlyTotal: 1200,
      categories: { [ACTIVE_CATEGORY.id]: 450, [TOMBSTONE_CATEGORY.id]: 0 },
    });
    assert.equal(result, true);

    const budget = t.db.getBudget();
    assert.equal(budget.monthlyTotal, 1200);
    assert.equal(budget.categories[ACTIVE_CATEGORY.id], 450, '活跃分类的预算更新应生效');
    assert.equal(
      budget.categories[TOMBSTONE_CATEGORY.id],
      undefined,
      '显式清除的墓碑预算条目必须被删除',
    );
  });

  test(`${scriptPath}：saveBudget 拒绝为墓碑分类设置非零预算`, () => {
    const storage = new FaultInjectionStorage(seedStorage());
    const t = loadExpenseDB(scriptPath, storage);
    const before = storage.getRaw(STORAGE_KEYS.budget);

    const result = t.db.saveBudget({
      monthlyTotal: 1200,
      categories: { [TOMBSTONE_CATEGORY.id]: 300 },
    });
    assert.equal(result, false, '不允许为已删除分类设置新预算值');
    assert.equal(storage.getRaw(STORAGE_KEYS.budget), before, '拒绝后预算数据零改动');
  });

  test(`${scriptPath}：saveBudget 合并模式未提及墓碑条目时保留（可恢复语义）`, () => {
    const storage = new FaultInjectionStorage(seedStorage());
    const t = loadExpenseDB(scriptPath, storage);

    // 数据安全设计：普通编辑不静默丢失任何条目（含隐藏键），
    // 用户未来恢复分类时预算配置仍在；想彻底清空走显式清除或 reset 模式。
    const result = t.db.saveBudget({
      monthlyTotal: 1200,
      categories: { [ACTIVE_CATEGORY.id]: 450 },
    });
    assert.equal(result, true);

    const budget = t.db.getBudget();
    assert.equal(budget.categories[ACTIVE_CATEGORY.id], 450);
    assert.equal(
      budget.categories[TOMBSTONE_CATEGORY.id],
      200,
      'draft 未提及的墓碑条目应继承保留',
    );
  });
}
