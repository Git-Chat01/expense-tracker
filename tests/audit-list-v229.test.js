const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

function loadList(records = []) {
  const elements = new Map();
  const makeElement = () => ({ innerHTML: '', textContent: '', hidden: false, style: {}, dataset: {},
    addEventListener() {}, setAttribute() {}, querySelectorAll: () => [], querySelector: () => null,
    classList: { add() {}, remove() {}, toggle() {} } });
  const get = id => {
    if (!elements.has(id)) elements.set(id, makeElement());
    return elements.get(id);
  };
  const dateButton = makeElement();
  dateButton.dataset.filter = 'date';
  let dateActive = false;
  dateButton.classList.toggle = (_, value) => { dateActive = Boolean(value); };
  let categoryReads = 0;
  const categories = new Map([['food', { id: 'food', name: '餐饮' }], ['coffee', { id: 'coffee', name: '咖啡', parentId: 'food' }]]);
  const db = {
    getExpenses: () => records, getExpenseCount: () => records.length,
    getCategory: id => { categoryReads++; return categories.get(id) || null; },
    getCategories: () => [...categories.values()], today: () => '2026-10-26',
  };
  const context = vm.createContext({ console, ExpenseDB: db,
    document: { getElementById: get, querySelector: () => null, querySelectorAll: selector => selector === '#list-filter-bar .chip' ? [dateButton] : [] },
    ExpenseCategories: { getIconMarkup: () => '' },
  });
  vm.runInContext(read('js/data.js') + '\n' + read('js/summary-v224.js'), context);
  const source = read(process.env.AUDIT_LIST_SOURCE || 'js/list-v229.js').replace(
    'return { render, initFilters };',
    'return { render, initFilters, filters: _filters, apply: _applyFilters, active: _renderActiveFilters, item: _renderItem };');
  vm.runInContext(source + ';globalThis.subject=ExpenseList;', context);
  return { api: context.subject, get, db, dateActive: () => dateActive, categoryReads: () => categoryReads };
}

test('只设截止日期既限制结果，也显示条件、高亮和清除入口', () => {
  const r = loadList([{ date: '2026-10-25', id: 'old', amount: 1 }, { date: '2026-10-26', id: 'new', amount: 2 }]);
  r.api.filters.dateTo = '2026-10-25';
  r.api.active();
  assert.match(r.get('list-active-filters').innerHTML, /截至 2026-10-25/);
  assert.match(r.get('list-active-filters').innerHTML, /list-clear-all/);
  assert.equal(r.dateActive(), true);
  assert.deepEqual(Array.from(r.api.apply(r.db.getExpenses()), row => row.id), ['old']);
});

test('只设开始日期明确为开放区间，未来记录与文案一致', () => {
  const r = loadList();
  r.api.filters.dateFrom = '2026-10-25';
  r.api.active();
  assert.match(r.get('list-active-filters').innerHTML, /自 2026-10-25 起/);
  assert.doesNotMatch(r.get('list-active-filters').innerHTML, /今天/);
});

test('长账本仅渲染首批，但汇总与搜索覆盖全部历史', () => {
  const records = Array.from({ length: 3000 }, (_, i) => ({ id: 'test-' + i, date: '2026-10-26', time: '12:00', amount: 0.1, categoryId: 'coffee', note: i === 2999 ? '末尾目标' : '普通记录' }));
  const before = JSON.stringify(records);
  const r = loadList(records);
  r.api.render();
  assert.equal((r.get('list-content').innerHTML.match(/class="list-item"/g) || []).length, 100);
  assert.match(r.get('list-content').innerHTML, /list-load-more/);
  assert.equal(r.get('list-summary-count').textContent, '共 3000 笔');
  assert.equal(r.get('list-summary-total').textContent, '¥300.00');
  assert.ok(r.categoryReads() < 10, '同一分类按本次渲染快照复用');
  r.api.filters.noteKeyword = '末尾目标';
  r.api.render();
  assert.match(r.get('list-content').innerHTML, /test-2999/);
  assert.equal(r.get('list-summary-count').textContent, '共 1 笔');
  assert.equal(JSON.stringify(records), before, '仅改变显示，不截断或重写账本');
});

test('账单行有键盘可达语义，并安全处理读屏标题中的特殊字符', () => {
  const r = loadList();
  const html = r.api.item({ id: 'a', date: '2026-10-26', amount: 12, categoryId: 'coffee', note: '<危险"文字>' });
  assert.match(html, /role="button"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /aria-label="编辑/);
  assert.doesNotMatch(html, /<危险/);
});
