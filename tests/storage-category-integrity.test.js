const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STORAGE_SCRIPTS = [
  'js/storage.js',
  'js/storage-v214.js',
];

const CATEGORY_STORAGE_KEY = 'expense_tracker_categories';
const EXPENSE_STORAGE_KEY = 'expense_tracker_expenses';

class MemoryStorage {
  constructor(seed = {}) {
    this.values = new Map(Object.entries(seed));
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
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

function loadExpenseDB(relativePath, storage = new MemoryStorage()) {
  const absolutePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const context = vm.createContext({
    console: { error() {} },
    localStorage: storage,
  });

  vm.runInContext(
    `${source}\n;globalThis.__categoryIntegrityTest = {\n`
      + '  db: ExpenseDB,\n'
      + '  exportJson: () => JSON.stringify(ExpenseDB.exportAll()),\n'
      + '  importJson: raw => ExpenseDB.importAll(JSON.parse(raw)),\n'
      + '};',
    context,
    { filename: absolutePath },
  );

  return {
    ...context.__categoryIntegrityTest,
    storage,
  };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function sortedIds(categories) {
  return cloneJson(categories).map(category => category.id).sort();
}

function assertIds(categories, expectedIds, message) {
  assert.deepEqual(sortedIds(categories), [...expectedIds].sort(), message);
}

function createCategory(db, id, parentId = null) {
  const category = db.addCategory({
    id,
    name: id,
    icon: '📌',
    parentId,
  });
  assert.ok(category, `分类 ${id} 应成功创建`);
  assert.equal(category.id, id);
  assert.equal(category.parentId, parentId);
  return category;
}

function createExpense(db, categoryId, note, necessity) {
  const expense = db.addExpense({
    amount: necessity === 'need' ? 18.88 : 9.99,
    categoryId,
    date: '2026-08-11',
    time: necessity === 'need' ? '08:08' : '09:09',
    location: '',
    paymentMethod: 'cash',
    necessity,
    note,
  });
  assert.ok(expense, `引用分类 ${categoryId} 的账单应成功创建`);
  return expense;
}

function createParentChildFixture(db, prefix) {
  const parent = createCategory(db, `${prefix}-parent`);
  const child = createCategory(db, `${prefix}-child`, parent.id);
  return { parent, child };
}

function createBackup({ version = 3, categories = [], expenses = [] } = {}) {
  return {
    version,
    expenses,
    categories,
    budget: { monthlyTotal: 0, categories: {} },
    settings: {},
    exportedAt: '2026-08-11T12:00:00.000Z',
  };
}

function expenseReferencesByNote(db) {
  return new Map(cloneJson(db.getExpenses()).map(expense => [expense.note, expense.categoryId]));
}

function assertParentAndChildHidden(db, parentId, childId) {
  assertIds(db.getCategories(), [], '删除父级后平铺 UI getter 应隐藏父子分类');
  assertIds(db.getParentCategories(), [], '删除父级后一级分类 UI getter 应隐藏父级');
  assertIds(db.getChildCategories(parentId), [], '删除父级后子分类 UI getter 应隐藏其子级');
  assert.ok(db.getCategory(parentId), '删除后的父级仍应可按 ID 解析');
  assert.ok(db.getCategory(childId), '随父级删除的子级仍应可按 ID 解析');
}

function assertChildHidden(db, parentId, childId) {
  assertIds(db.getCategories(), [parentId], '删除子级后平铺 UI getter 只显示父级');
  assertIds(db.getParentCategories(), [parentId], '删除子级后父级仍应显示');
  assertIds(db.getChildCategories(parentId), [], '删除的子级不应继续显示');
  assert.ok(db.getCategory(parentId), '父级仍应可解析');
  assert.ok(db.getCategory(childId), '删除后的子级仍应可按 ID 解析');
}

function assertRejectedAdd(db, storage, input, message) {
  const before = storage.getRaw(CATEGORY_STORAGE_KEY);
  const result = db.addCategory(input);
  assert.equal(result, null, message);
  assert.equal(storage.getRaw(CATEGORY_STORAGE_KEY), before, '拒绝新增不得改写分类原值');
}

function assertRejectedUpdate(db, storage, id, patch, message) {
  const before = storage.getRaw(CATEGORY_STORAGE_KEY);
  const result = db.updateCategory(id, patch);
  assert.equal(result, false, message);
  assert.equal(storage.getRaw(CATEGORY_STORAGE_KEY), before, '拒绝编辑不得改写分类原值');
}

for (const scriptPath of STORAGE_SCRIPTS) {
  test(`${scriptPath}：删除父分类后父子墓碑与账单引用可完整备份恢复`, () => {
    const source = loadExpenseDB(scriptPath);
    const { parent, child } = createParentChildFixture(source.db, 'delete-parent');
    createExpense(source.db, parent.id, '引用父级', 'need');
    createExpense(source.db, child.id, '引用子级', 'want');

    assert.equal(source.db.deleteCategory(parent.id), true);
    assertParentAndChildHidden(source.db, parent.id, child.id);
    const sourceReferences = expenseReferencesByNote(source.db);
    assert.equal(sourceReferences.get('引用父级'), parent.id);
    assert.equal(sourceReferences.get('引用子级'), child.id);

    const backupJson = source.exportJson();
    const backup = JSON.parse(backupJson);
    assertIds(backup.categories, [parent.id, child.id], '导出必须保留父子分类墓碑');
    assert.equal(
      backup.categories.find(category => category.id === child.id).parentId,
      parent.id,
      '导出不得改写子分类的历史父级引用',
    );
    assert.deepEqual(
      new Map(backup.expenses.map(expense => [expense.note, expense.categoryId])),
      new Map([
        ['引用父级', parent.id],
        ['引用子级', child.id],
      ]),
    );

    const restored = loadExpenseDB(scriptPath);
    const result = restored.importJson(backupJson);
    assert.equal(result.success, true, result.message);
    assertParentAndChildHidden(restored.db, parent.id, child.id);
    assert.equal(restored.db.getCategory(child.id).parentId, parent.id);
    assert.deepEqual(expenseReferencesByNote(restored.db), sourceReferences);
    const restoredBackup = JSON.parse(restored.exportJson());
    assertIds(restoredBackup.categories, [parent.id, child.id]);
  });

  test(`${scriptPath}：删除单个子分类后墓碑与账单引用可完整备份恢复`, () => {
    const source = loadExpenseDB(scriptPath);
    const { parent, child } = createParentChildFixture(source.db, 'delete-child');
    createExpense(source.db, child.id, '仅引用已删子级', 'impulse');

    assert.equal(source.db.deleteCategory(child.id), true);
    assertChildHidden(source.db, parent.id, child.id);
    assert.equal(expenseReferencesByNote(source.db).get('仅引用已删子级'), child.id);

    const backupJson = source.exportJson();
    const backup = JSON.parse(backupJson);
    assertIds(backup.categories, [parent.id, child.id], '导出必须保留已删除子级');
    assert.equal(backup.expenses[0].categoryId, child.id);

    const restored = loadExpenseDB(scriptPath);
    const result = restored.importJson(backupJson);
    assert.equal(result.success, true, result.message);
    assertChildHidden(restored.db, parent.id, child.id);
    assert.equal(expenseReferencesByNote(restored.db).get('仅引用已删子级'), child.id);
  });

  test(`${scriptPath}：addCategory 拒绝不存在的父级`, () => {
    const api = loadExpenseDB(scriptPath);
    assertRejectedAdd(api.db, api.storage, {
      id: 'orphan',
      name: '孤儿分类',
      icon: '📌',
      parentId: 'missing-parent',
    }, '不存在的父级不得创建孤儿分类');
  });

  test(`${scriptPath}：addCategory 拒绝把子级作为父级`, () => {
    const api = loadExpenseDB(scriptPath);
    const { child } = createParentChildFixture(api.db, 'add-third-level');
    assertRejectedAdd(api.db, api.storage, {
      id: 'third-level',
      name: '第三级',
      icon: '📌',
      parentId: child.id,
    }, '子级不得继续拥有子分类');
  });

  test(`${scriptPath}：addCategory 拒绝 self parent`, () => {
    const api = loadExpenseDB(scriptPath);
    assertRejectedAdd(api.db, api.storage, {
      id: 'self-parent',
      name: '自指分类',
      icon: '📌',
      parentId: 'self-parent',
    }, '新增分类不得引用自身为父级');
  });

  test(`${scriptPath}：updateCategory 拒绝 self parent`, () => {
    const api = loadExpenseDB(scriptPath);
    const category = createCategory(api.db, 'update-self');
    assertRejectedUpdate(
      api.db,
      api.storage,
      category.id,
      { parentId: category.id },
      '编辑分类不得引用自身为父级',
    );
  });

  test(`${scriptPath}：updateCategory 拒绝把有子级的父级挂到另一父级`, () => {
    const api = loadExpenseDB(scriptPath);
    const { parent } = createParentChildFixture(api.db, 'parent-with-child');
    const otherParent = createCategory(api.db, 'other-parent');
    assertRejectedUpdate(
      api.db,
      api.storage,
      parent.id,
      { parentId: otherParent.id },
      '有子级的父分类不得降为二级分类',
    );
  });

  test(`${scriptPath}：updateCategory 拒绝挂到已有子级`, () => {
    const api = loadExpenseDB(scriptPath);
    const { child } = createParentChildFixture(api.db, 'unrelated-hierarchy');
    const movable = createCategory(api.db, 'move-under-child');
    assertRejectedUpdate(
      api.db,
      api.storage,
      movable.id,
      { parentId: child.id },
      '任何分类都不得挂到现有二级分类下',
    );
  });

  test(`${scriptPath}：updateCategory 拒绝把父级挂到自己的子级形成环`, () => {
    const api = loadExpenseDB(scriptPath);
    const { parent, child } = createParentChildFixture(api.db, 'cycle');
    assertRejectedUpdate(
      api.db,
      api.storage,
      parent.id,
      { parentId: child.id },
      '父级不得挂到自己的子级形成环',
    );
  });

  test(`${scriptPath}：无子级分类可在顶级与二级之间合法调整`, () => {
    const api = loadExpenseDB(scriptPath);
    const parent = createCategory(api.db, 'legal-parent');
    const movable = createCategory(api.db, 'legal-movable');

    assert.equal(api.db.updateCategory(movable.id, { parentId: parent.id }), true);
    assert.equal(api.db.getCategory(movable.id).parentId, parent.id);
    assertIds(api.db.getParentCategories(), [parent.id]);
    assertIds(api.db.getChildCategories(parent.id), [movable.id]);

    assert.equal(api.db.updateCategory(movable.id, { parentId: null }), true);
    assert.equal(api.db.getCategory(movable.id).parentId, null);
    assertIds(api.db.getParentCategories(), [parent.id, movable.id]);
    assertIds(api.db.getChildCategories(parent.id), []);
  });

  test(`${scriptPath}：符合新领域规则的墓碑备份使用 version 4`, () => {
    const api = loadExpenseDB(scriptPath);
    const category = createCategory(api.db, 'version-3-tombstone');

    assert.equal(api.db.deleteCategory(category.id), true);
    const backup = JSON.parse(api.exportJson());
    const exportedCategory = backup.categories.find(item => item.id === category.id);

    assert.equal(backup.version, 4, '符合新领域规则的当前备份必须声明 version 4');
    assert.ok(exportedCategory, '墓碑分类必须保留在导出中');
    assert.equal(typeof exportedCategory.deletedAt, 'string');
  });

  test(`${scriptPath}：version 2 旧备份缺少 deletedAt 时仍按活动分类导入`, () => {
    const api = loadExpenseDB(scriptPath);
    const legacyCategory = {
      id: 'version-2-active',
      name: '旧版活动分类',
      icon: '📌',
      parentId: null,
      isPreset: false,
      order: 0,
    };
    const backup = createBackup({ version: 2, categories: [legacyCategory] });

    assert.equal(Object.hasOwn(legacyCategory, 'deletedAt'), false);
    const result = api.importJson(JSON.stringify(backup));

    assert.equal(result.success, true, result.message);
    const activeCategory = api.db.getActiveCategory(legacyCategory.id);
    assert.ok(activeCategory, '缺少 deletedAt 的 v2 分类必须保持活动');
    assert.equal(activeCategory.id, legacyCategory.id);
    assert.equal(Object.hasOwn(cloneJson(activeCategory), 'deletedAt'), false);
  });

  test(`${scriptPath}：import 拒绝活动子分类挂在已删除父分类`, () => {
    const api = loadExpenseDB(scriptPath);
    createCategory(api.db, 'pre-existing-category');
    const before = api.storage.snapshot();
    const backup = createBackup({
      categories: [
        {
          id: 'deleted-import-parent',
          name: '已删除父分类',
          icon: '📌',
          parentId: null,
          isPreset: false,
          order: 0,
          deletedAt: '2026-08-11T10:00:00.000Z',
        },
        {
          id: 'active-import-child',
          name: '活动子分类',
          icon: '📌',
          parentId: 'deleted-import-parent',
          isPreset: false,
          order: 1,
        },
      ],
    });

    const result = api.importJson(JSON.stringify(backup));

    assert.equal(result.success, false, '活动子分类不得引用已删除父分类');
    assert.match(result.message, /活动分类不能引用已删除的父分类/);
    assert.deepEqual(api.storage.snapshot(), before, '结构校验失败不得写入或创建导入前备份');
  });

  test(`${scriptPath}：legacy parentId 字符串 null 的顶级分类可导出再导入`, () => {
    const legacyCategory = {
      id: 'legacy-null-parent',
      name: '旧版顶级分类',
      icon: '📌',
      parentId: 'null',
      isPreset: false,
      order: 0,
    };
    const source = loadExpenseDB(scriptPath, new MemoryStorage({
      [CATEGORY_STORAGE_KEY]: JSON.stringify([legacyCategory]),
    }));

    assertIds(source.db.getParentCategories(), [legacyCategory.id]);
    const backupJson = source.exportJson();
    const backup = JSON.parse(backupJson);
    assert.equal(backup.categories[0].parentId, 'null', '导出不得覆盖式迁移旧 parentId');

    const restored = loadExpenseDB(scriptPath);
    const result = restored.importJson(backupJson);

    assert.equal(result.success, true, result.message);
    assert.ok(restored.db.getActiveCategory(legacyCategory.id));
    assertIds(restored.db.getParentCategories(), [legacyCategory.id]);
  });

  test(`${scriptPath}：getActiveCategory 隐藏墓碑但 getCategory 仍可解析`, () => {
    const api = loadExpenseDB(scriptPath);
    const category = createCategory(api.db, 'active-vs-tombstone');
    assert.equal(api.db.deleteCategory(category.id), true);
    const before = api.storage.getRaw(CATEGORY_STORAGE_KEY);

    const tombstone = api.db.getCategory(category.id);
    assert.ok(tombstone, '历史引用必须仍能解析墓碑分类');
    assert.equal(tombstone.id, category.id);
    assert.equal(typeof tombstone.deletedAt, 'string');
    assert.equal(api.db.getActiveCategory(category.id), null, '活动分类查询必须隐藏墓碑');
    assert.equal(api.storage.getRaw(CATEGORY_STORAGE_KEY), before, '只读查询不得改写分类');
  });

  test(`${scriptPath}：validateCategoryParent 拒绝墓碑父级、二级父级及带墓碑子级的分类且零写`, () => {
    const api = loadExpenseDB(scriptPath);
    const movable = createCategory(api.db, 'validation-movable');
    const deletedParent = createCategory(api.db, 'validation-deleted-parent');
    assert.equal(api.db.deleteCategory(deletedParent.id), true);
    const { child: secondLevel } = createParentChildFixture(api.db, 'validation-depth');
    const tombstoneOwner = createCategory(api.db, 'validation-tombstone-owner');
    const tombstoneChild = createCategory(api.db, 'validation-tombstone-child', tombstoneOwner.id);
    assert.equal(api.db.deleteCategory(tombstoneChild.id), true);
    const otherParent = createCategory(api.db, 'validation-other-parent');
    const before = api.storage.snapshot();

    const deletedParentResult = api.db.validateCategoryParent(movable.id, deletedParent.id);
    assert.equal(deletedParentResult.valid, false);
    assert.equal(deletedParentResult.code, 'PARENT_UNAVAILABLE');
    assert.equal(deletedParentResult.hasChildren, false);
    assert.deepEqual(api.storage.snapshot(), before, '校验墓碑父级不得产生写入');

    const secondLevelResult = api.db.validateCategoryParent(movable.id, secondLevel.id);
    assert.equal(secondLevelResult.valid, false);
    assert.equal(secondLevelResult.code, 'PARENT_NOT_TOP_LEVEL');
    assert.equal(secondLevelResult.hasChildren, false);
    assert.deepEqual(api.storage.snapshot(), before, '校验二级父级不得产生写入');

    const tombstoneChildResult = api.db.validateCategoryParent(tombstoneOwner.id, otherParent.id);
    assert.equal(tombstoneChildResult.valid, false);
    assert.equal(tombstoneChildResult.code, 'CATEGORY_HAS_CHILDREN');
    assert.equal(tombstoneChildResult.hasChildren, true);
    assert.deepEqual(api.storage.snapshot(), before, '校验墓碑子级不得产生写入');
  });

  test(`${scriptPath}：addExpense 拒绝墓碑分类且账单零写`, () => {
    const api = loadExpenseDB(scriptPath);
    const category = createCategory(api.db, 'expense-add-tombstone');
    assert.equal(api.db.deleteCategory(category.id), true);
    assert.equal(api.db.getActiveCategory(category.id), null);
    const before = api.storage.getRaw(EXPENSE_STORAGE_KEY);

    const result = api.db.addExpense({
      amount: 12.34,
      categoryId: category.id,
      date: '2026-08-11',
      time: '10:10',
      location: '',
      paymentMethod: 'cash',
      necessity: 'need',
      note: '不得写入墓碑分类',
    });

    assert.equal(result, null, '新账单不得引用墓碑分类');
    assert.equal(api.storage.getRaw(EXPENSE_STORAGE_KEY), before, '拒绝新增不得创建或覆盖账单键');
  });

  test(`${scriptPath}：updateExpense 可保持原墓碑分类但拒绝切换到墓碑且零写`, () => {
    const api = loadExpenseDB(scriptPath);
    const tombstoneCategory = createCategory(api.db, 'expense-update-tombstone');
    const activeCategory = createCategory(api.db, 'expense-update-active');
    const historicalExpense = createExpense(
      api.db,
      tombstoneCategory.id,
      '墓碑分类历史账单',
      'need',
    );
    const activeExpense = createExpense(
      api.db,
      activeCategory.id,
      '活动分类账单',
      'want',
    );
    assert.equal(api.db.deleteCategory(tombstoneCategory.id), true);
    assert.equal(api.db.getActiveCategory(tombstoneCategory.id), null);

    const retained = api.db.updateExpense(historicalExpense.id, {
      categoryId: tombstoneCategory.id,
      note: '墓碑分类历史账单已编辑',
    });
    assert.ok(retained, '编辑历史账单时应允许保持原墓碑分类 ID');
    assert.equal(retained.categoryId, tombstoneCategory.id);
    assert.equal(retained.note, '墓碑分类历史账单已编辑');

    const beforeRejectedSwitch = api.storage.getRaw(EXPENSE_STORAGE_KEY);
    const rejected = api.db.updateExpense(activeExpense.id, {
      categoryId: tombstoneCategory.id,
      note: '不得切换到墓碑分类',
    });

    assert.equal(rejected, null, '活动账单不得切换到墓碑分类');
    assert.equal(
      api.storage.getRaw(EXPENSE_STORAGE_KEY),
      beforeRejectedSwitch,
      '拒绝切换分类不得改写任何账单',
    );
    const unchangedExpense = api.db.getExpense(activeExpense.id);
    assert.equal(unchangedExpense.categoryId, activeCategory.id);
    assert.equal(unchangedExpense.note, '活动分类账单');
  });

  test(`${scriptPath}：活动父分类消费汇总保留已删子分类的历史账单`, () => {
    const api = loadExpenseDB(scriptPath);
    const { parent, child } = createParentChildFixture(api.db, 'spent-tombstone-child');
    const parentExpense = createExpense(api.db, parent.id, '父分类账单', 'need');
    const childExpense = createExpense(api.db, child.id, '子分类历史账单', 'want');
    assert.equal(api.db.deleteCategory(child.id), true);
    assert.ok(api.db.getActiveCategory(parent.id));
    assert.equal(api.db.getActiveCategory(child.id), null);
    const before = api.storage.snapshot();

    assert.equal(
      api.db.getCategorySpent(parent.id, '2026-08'),
      28.87,
      '父分类汇总应按整数分精确计算，且不得因子分类软删除而丢失历史消费',
    );
    assert.deepEqual(api.storage.snapshot(), before, '历史消费汇总必须保持只读');
  });
}
