const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function load(values = new Map(), overrides = {}) {
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  const context = vm.createContext({ console, localStorage: storage, ...overrides });
  vm.runInContext(read('js/storage-v229.js') + '\n' + read('js/habit-predictor-v229.js') + '\n;globalThis.db = ExpenseDB; globalThis.habit = ExpenseHabitPredictor;', context);
  return { db: context.db, habit: context.habit, values, context };
}

function seed(db) {
  const cat = db.addCategory({ name: '合成分类', icon: '🍜' });
  assert.ok(cat);
  const expense = db.addExpense({ amount: 12, date: '2026-10-25', categoryId: cat.id, paymentMethod: 'cash', necessity: 'need', note: '原备注' });
  assert.ok(expense);
  return expense;
}

test('原值冲突拒绝陈旧修改与删除，保留另一页面已保存金额', async () => {
  const a = load();
  const original = plain(seed(a.db));
  const b = load(a.values);
  assert.equal((await b.db.updateExpenseIfUnchanged(original.id, { amount: 22 }, original)).ok, true);
  const staleEdit = await a.db.updateExpenseIfUnchanged(original.id, { ...original, note: 'A仅改备注' }, original);
  assert.equal(staleEdit.ok, false);
  assert.equal(staleEdit.code, 'CONFLICT');
  assert.equal(a.db.getExpense(original.id).amount, 22);
  assert.equal(a.db.getExpense(original.id).note, '原备注');
  assert.equal((await a.db.deleteExpenseIfUnchanged(original.id, original)).code, 'CONFLICT');
  assert.equal(a.db.getExpenseCount(), 1);
});

test('无冲突修改保留所有账单字段，删除必须匹配最新快照', async () => {
  const { db } = load();
  const original = plain(seed(db));
  const updated = await db.updateExpenseIfUnchanged(original.id, { note: '新备注' }, original);
  assert.equal(updated.ok, true);
  assert.deepEqual(plain(updated.expense), { ...original, note: '新备注' });
  assert.equal((await db.deleteExpenseIfUnchanged(original.id, plain(updated.expense))).ok, true);
  assert.equal(db.getExpenseCount(), 0);
});

test('冲突检测读取失败必须中止，不被误判为已删除或成功', async () => {
  const state = load();
  const original = plain(seed(state.db));
  const originalBytes = state.values.get('expense_tracker_expenses');
  const broken = load(state.values, { localStorage: { getItem() { throw Error('合成读取故障'); }, setItem() { throw Error('不应写入'); } } });
  assert.equal((await broken.db.updateExpenseIfUnchanged(original.id, { amount: 20 }, original)).code, 'STORAGE_READ_FAILED');
  assert.equal(state.values.get('expense_tracker_expenses'), originalBytes);
});

test('旧记录中的结构化扩展字段按值比较，编辑后保持原样', async () => {
  const { db, values } = load();
  const expense = plain(seed(db));
  // 只在内存 Storage 夹具模拟旧数据，浏览器测试仍全部通过 ExpenseDB 写入。
  expense.tags = ['合成标签'];
  expense.extra = { nested: { first: 1, second: 2 } };
  values.set('expense_tracker_expenses', JSON.stringify([expense]));
  const snapshot = plain(db.getExpense(expense.id));
  const updated = await db.updateExpenseIfUnchanged(expense.id, { note: '新备注' }, snapshot);
  assert.equal(updated.ok, true);
  assert.deepEqual(plain(updated.expense.tags), expense.tags);
  assert.deepEqual(plain(updated.expense.extra), expense.extra);
  const stale = plain(updated.expense);
  stale.extra.nested.first = 3;
  assert.equal((await db.deleteExpenseIfUnchanged(expense.id, stale)).code, 'CONFLICT');
});

test('有 Web Locks 时同类写入串行，两个相同原值只允许一个修改成功', async () => {
  let tail = Promise.resolve();
  const locks = { request(name, callback) { assert.equal(name, 'expense-tracker-expense-write'); const task = tail.then(callback); tail = task.catch(() => {}); return task; } };
  const a = load(new Map(), { navigator: { locks } });
  const original = plain(seed(a.db));
  const b = load(a.values, { navigator: { locks } });
  const results = await Promise.all([
    a.db.updateExpenseIfUnchanged(original.id, { amount: 20 }, original),
    b.db.updateExpenseIfUnchanged(original.id, { amount: 30 }, original),
  ]);
  assert.equal(results.filter(r => r.ok).length, 1);
  assert.equal(results.filter(r => r.code === 'CONFLICT').length, 1);
});

test('恢复前备份可只读取出，不替换当前账本或备份内容', () => {
  const { db, values } = load();
  seed(db);
  const old = plain(db.exportAll());
  const replacement = plain(old);
  replacement.expenses = [];
  assert.equal(db.importAll(replacement).success, true);
  const before = JSON.stringify([...values]);
  const result = db.getPreImportBackup();
  assert.equal(result.ok, true);
  assert.equal(result.exists, true);
  assert.deepEqual(plain(result.data.expenses), old.expenses);
  assert.equal(db.getExpenseCount(), 0);
  assert.equal(JSON.stringify([...values]), before);
});

test('恢复前副本缺失、损坏和读取失败有不同状态，绝不伪装成功', () => {
  const { db, values } = load();
  assert.deepEqual(plain(db.getPreImportBackup()), { ok: true, exists: false, data: null });
  values.set('expense_tracker_pre_import_backup', '{broken');
  assert.equal(db.getPreImportBackup().code, 'BACKUP_INVALID');
  const inaccessible = load(new Map(), { localStorage: { getItem() { throw Error('无权限'); } } });
  assert.equal(inaccessible.db.getPreImportBackup().code, 'BACKUP_READ_FAILED');
});

test('导入 toString 分类后习惯统计可用且不改写分类 ID', () => {
  const { db, habit } = load();
  const result = db.importAll({ version: 4, categories: [{ id: 'toString', name: '合成分类' }], expenses: Array.from({ length: 5 }, (_, i) => ({ id: 'synthetic-' + i, amount: 1, date: '2026-10-25', categoryId: 'toString', paymentMethod: 'cash' })), budget: { monthlyTotal: 0, categories: {} }, settings: {} });
  assert.equal(result.success, true);
  assert.equal(habit.guessForCategory('toString', ['cash']), 'cash');
  assert.equal(db.getExpenses()[0].categoryId, 'toString');
});

test('新写入拒绝 HTML 货币字段，安全货币字段导出导入保持一致', () => {
  const { db } = load();
  assert.equal(db.saveSettings({ currency: '<b>伪造</b>' }), false);
  assert.equal(db.saveSettings({ currency: 'HK$' }), true);
  const backup = plain(db.exportAll());
  assert.equal(db.importAll(backup).success, true);
  assert.equal(db.getSettings().currency, 'HK$');
  backup.settings.currency = '<style>body{display:none}</style>';
  assert.equal(db.importAll(backup).success, false);
  assert.equal(db.getSettings().currency, 'HK$');
});
