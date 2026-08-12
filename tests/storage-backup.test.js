const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const STORAGE_SCRIPTS = [
  'js/storage.js',
  'js/storage-v214.js',
];

class MemoryStorage {
  constructor() {
    this.values = new Map();
  }

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

function loadExpenseDB(relativePath) {
  const absolutePath = path.join(__dirname, '..', relativePath);
  const source = fs.readFileSync(absolutePath, 'utf8');
  const context = vm.createContext({
    console,
    localStorage: new MemoryStorage(),
  });

  vm.runInContext(`${source}\n;globalThis.__expenseDB = ExpenseDB;`, context, {
    filename: absolutePath,
  });

  return context.__expenseDB;
}

function createRoundTripFixture(db) {
  const category = db.addCategory({
    id: 'category-food',
    name: '餐饮',
    icon: '🍜',
  });
  assert.ok(category, '测试分类应成功写入隔离内存存储');

  for (const necessity of ['', 'need', 'want', 'impulse']) {
    const saved = db.addExpense({
      amount: 12.34,
      categoryId: category.id,
      date: '2026-08-10',
      time: '12:34',
      location: '测试地点',
      paymentMethod: 'cash',
      necessity,
      note: necessity || '未评估',
    });
    assert.ok(saved, `necessity=${necessity || '(empty)'} 的测试账单应成功写入`);
  }
}

for (const scriptPath of STORAGE_SCRIPTS) {
  test(`${scriptPath}：备份导入保留全部 necessity 合法值`, () => {
    const db = loadExpenseDB(scriptPath);
    createRoundTripFixture(db);

    const backup = db.exportAll();
    const expectedExpenses = JSON.parse(JSON.stringify(backup.expenses));
    const result = db.importAll(backup);

    assert.equal(result.success, true, result.message);
    assert.deepEqual(
      JSON.parse(JSON.stringify(db.exportAll().expenses)),
      expectedExpenses,
      '账单的全部导出字段应在导入后保持相等',
    );
    const restoredByNote = new Map(db.getExpenses().map(expense => [expense.note, expense]));
    assert.equal(restoredByNote.get('未评估').necessity, '');
    assert.equal(restoredByNote.get('need').necessity, 'need');
    assert.equal(restoredByNote.get('want').necessity, 'want');
    assert.equal(restoredByNote.get('impulse').necessity, 'impulse');
  });

  test(`${scriptPath}：拒绝未知 necessity 且不覆盖现有数据`, () => {
    const db = loadExpenseDB(scriptPath);
    createRoundTripFixture(db);

    const before = JSON.stringify(db.exportAll().expenses);
    const invalidBackup = db.exportAll();
    invalidBackup.expenses[0].necessity = 'unexpected';

    const result = db.importAll(invalidBackup);

    assert.equal(result.success, false);
    assert.match(result.message, /消费记录/);
    assert.equal(JSON.stringify(db.exportAll().expenses), before);
  });

  test(`${scriptPath}：旧备份缺少 necessity 时按未评估读取`, () => {
    const db = loadExpenseDB(scriptPath);
    createRoundTripFixture(db);

    const legacyBackup = db.exportAll();
    for (const expense of legacyBackup.expenses) delete expense.necessity;

    const result = db.importAll(legacyBackup);

    assert.equal(result.success, true, result.message);
    for (const expense of db.getExpenses()) {
      assert.equal(expense.necessity, '');
    }
  });
}
