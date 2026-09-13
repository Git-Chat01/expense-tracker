const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
function source(name) {
  const file = [...html.matchAll(/<script src="([^"?]+)(?:\?[^"]*)?"/g)]
    .map(m => m[1]).find(p => p.startsWith('js/' + name + '-v'));
  return fs.readFileSync(path.join(root, file), 'utf8');
}
function dbContext() {
  const values = new Map();
  let writes = 0;
  const context = vm.createContext({ console, localStorage: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => { writes++; values.set(key, String(value)); },
    removeItem: key => { writes++; values.delete(key); },
  } });
  vm.runInContext(source('storage') + ';globalThis.db = ExpenseDB;', context);
  return { db: context.db, values, writes: () => writes };
}

test('排序偏好通过设置 API 保留，备份恢复后不丢失', () => {
  const r = dbContext();
  assert.equal(r.db.saveSettings({ listSort: 'amount-asc', theme: 'light' }), true);
  const backup = r.db.exportAll();
  assert.equal(backup.settings.listSort, 'amount-asc');
  assert.equal(r.db.importAll(backup).success, true);
  assert.equal(r.db.getSettings().listSort, 'amount-asc');
  r.db.saveSettings({ listSort: 'invalid' });
  assert.equal(r.db.getSettings().listSort, 'amount-asc');
});

test('恢复预检不写存储，坏结构被拒绝', () => {
  const r = dbContext();
  const backup = r.db.exportAll();
  const before = r.writes();
  assert.equal(r.db.validateImport(backup).success, true);
  for (const invalid of [null, [], {}, { expenses: [], categories: 'broken' }]) {
    assert.equal(r.db.validateImport(invalid).success, false);
  }
  assert.equal(r.writes(), before);
});

function listContext() {
  const categories = { food: { name: '餐饮' }, coffee: { name: '咖啡', parentId: 'food' } };
  const context = vm.createContext({ ExpenseDB: { getCategory: id => categories[id] } });
  let script = source('list');
  script = script.replace('return { render, initFilters };', 'return { render, initFilters, apply: _applyFilters, filters: _filters };');
  vm.runInContext(script + ';globalThis.list = ExpenseList;', context);
  return context.list;
}
const records = [
  { id: 'recent', date: '2026-09-13', amount: 12, categoryId: 'coffee', location: '星河Cafe', note: '下午茶', necessity: 'want' },
  { id: 'old', date: '2025-09-13', amount: 888, categoryId: 'unknown', location: '', note: '<img>', necessity: '' },
  { id: 'missing', date: '2026-08-01', amount: 3, categoryId: 'food', note: '早餐' },
];
test('搜索匹配地点、子分类和一级分类，忽略大小写并按字面搜索', () => {
  const r = listContext();
  for (const [keyword, expected] of [['CAFE', ['recent']], ['咖啡', ['recent']], ['餐饮', ['recent', 'missing']], ['<img>', ['old']], ['.*', []]]) {
    r.filters.noteKeyword = keyword;
    assert.deepEqual(Array.from(r.apply(records), e => e.id), expected);
  }
});
test('未评估筛选兼容无字段记录，与关键词叠加且不改写数据', () => {
  const r = listContext();
  const before = JSON.stringify(records);
  r.filters.necessities = [''];
  assert.deepEqual(Array.from(r.apply(records), e => e.id), ['missing', 'old']);
  r.filters.noteKeyword = '早餐';
  assert.deepEqual(Array.from(r.apply(records), e => e.id), ['missing']);
  assert.equal(JSON.stringify(records), before);
});
test('首次进入默认日期倒序，金额排序仍保留', () => {
  const r = listContext();
  assert.deepEqual(Array.from(r.apply(records), e => e.id), ['recent', 'missing', 'old']);
  r.filters.sortBy = 'amount';
  assert.deepEqual(Array.from(r.apply(records), e => e.id), ['old', 'recent', 'missing']);
});
