const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/* =================================================================
   领域契约测试：防止后续重构无意改变关键业务规则。
   主控制器拆分（审计高危 No.2）后，规则随代码迁到各自模块文件，
   本文件按模块分布断言：
   - app.js         拆分前 legacy 快照（保留全量 4 条断言）
   - app-v217.js    新增记账流程（parseFloat 禁令 / 日期原值 / 大额整数分）
   - edit-expense.js 编辑流程（同上三条）
   - budget-overlay.js 预算流程（parseFloat 禁令 / 保存与重置模式区分）
   ================================================================= */

function readSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function sliceBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `缺少源码入口：${startMarker}`);
  assert.notEqual(end, -1, `缺少源码边界：${endMarker}`);
  return source.slice(start, end);
}

/* ---------------- app.js（legacy 快照，未拆分） ---------------- */
for (const appPath of ['js/app.js']) {
  test(`${appPath}：新增、编辑与预算保存不再用 parseFloat 宽松解析`, () => {
    const source = readSource(appPath);
    const addFlow = sliceBetween(source, 'function _buildAddExpenseDraft()', 'function _toast(message');
    const budgetFlow = sliceBetween(
      source,
      "document.getElementById('budget-btn-save').addEventListener",
      "document.getElementById('budget-btn-reset').addEventListener",
    );
    const editFlow = sliceBetween(source, 'function readEditDraft()', 'function showEditValidationError');

    assert.doesNotMatch(addFlow, /\bparseFloat\s*\(/);
    assert.doesNotMatch(editFlow, /\bparseFloat\s*\(/);
    assert.doesNotMatch(budgetFlow, /\bparseFloat\s*\(/);
    assert.match(addFlow, /ExpenseDB\.validateExpenseDraft\(_buildAddExpenseDraft\(\)\)/);
    assert.match(editFlow, /ExpenseDB\.validateExpenseDraft\(current\.draft/);
    assert.match(budgetFlow, /ExpenseDB\.validateBudgetDraft\(draft\)/);
    assert.match(budgetFlow, /ExpenseDB\.saveBudget\(validation\.value\)/);
  });

  test(`${appPath}：新增与编辑日期原值进入校验器且无 now fallback`, () => {
    const source = readSource(appPath);
    const addDraft = sliceBetween(source, 'function _buildAddExpenseDraft()', 'function _showExpenseValidationError');
    const editDraft = sliceBetween(source, 'function readEditDraft()', 'function validateEditDraft');

    assert.match(addDraft, /date:\s*_formState\.date/);
    assert.doesNotMatch(addDraft, /date:[^,\n]*(?:\|\||\?\?)[^,\n]*(?:today|now|Date)/i);
    assert.match(editDraft, /date:\s*document\.getElementById\('edit-date'\)\.value/);
    assert.doesNotMatch(editDraft, /date:[^,\n]*(?:\|\||\?\?)[^,\n]*(?:today|now|Date)/i);
  });

  test(`${appPath}：新增与编辑大额确认均比较捕获的整数分`, () => {
    const source = readSource(appPath);
    const addFlow = sliceBetween(source, 'function _handleSave()', 'function _toast(message');
    const editFlow = sliceBetween(
      source,
      "document.getElementById('edit-btn-save').addEventListener",
      'function _buildCategoryOptions(selectedId)',
    );

    assert.match(addFlow, /const confirmedCents = validation\.cents/);
    assert.match(addFlow, /latest\.cents !== confirmedCents/);
    assert.match(addFlow, /_commitSave\(confirmedCents\)/);
    assert.match(addFlow, /function _commitSave\(expectedCents\)/);
    assert.match(addFlow, /validation\.cents !== expectedCents/);

    assert.match(editFlow, /const confirmedCents = validation\.cents/);
    assert.match(editFlow, /latest\.cents !== confirmedCents/);
    assert.match(editFlow, /persistEdit\(confirmedCents\)/);
  });

  test(`${appPath}：预算普通保存与重置使用不同持久化模式`, () => {
    const source = readSource(appPath);
    const budgetSection = sliceBetween(
      source,
      "document.getElementById('budget-btn-save').addEventListener",
      'let _overlayScrollYBefore = 0;',
    );

    assert.match(budgetSection, /ExpenseDB\.saveBudget\(validation\.value\)/);
    assert.match(budgetSection, /ExpenseDB\.saveBudget\(ExpenseData\.DEFAULT_BUDGET,\s*\{\s*mode:\s*'reset'\s*\}\)/);
  });
}

/* ---------------- app-v217.js：新增记账流程 ---------------- */
// 拆分后 Toast 已迁至 toast.js，新增流程切片边界改为 _bindOverlays（紧随 _commitSave 之后）
const ADD_FLOW_END = 'function _bindOverlays()';

test('js/app-v217.js：新增保存不用 parseFloat 宽松解析', () => {
  const source = readSource('js/app-v217.js');
  const addFlow = sliceBetween(source, 'function _buildAddExpenseDraft()', ADD_FLOW_END);

  assert.doesNotMatch(addFlow, /\bparseFloat\s*\(/);
  assert.match(addFlow, /ExpenseDB\.validateExpenseDraft\(_buildAddExpenseDraft\(\)\)/);
});

test('js/app-v217.js：新增日期原值进入校验器且无 now fallback', () => {
  const source = readSource('js/app-v217.js');
  const addDraft = sliceBetween(source, 'function _buildAddExpenseDraft()', 'function _showExpenseValidationError');

  assert.match(addDraft, /date:\s*_formState\.date/);
  assert.doesNotMatch(addDraft, /date:[^,\n]*(?:\|\||\?\?)[^,\n]*(?:today|now|Date)/i);
});

test('js/app-v217.js：新增大额确认比较捕获的整数分', () => {
  const source = readSource('js/app-v217.js');
  const addFlow = sliceBetween(source, 'function _handleSave()', ADD_FLOW_END);

  assert.match(addFlow, /const confirmedCents = validation\.cents/);
  assert.match(addFlow, /latest\.cents !== confirmedCents/);
  assert.match(addFlow, /_commitSave\(confirmedCents\)/);
  assert.match(addFlow, /function _commitSave\(expectedCents\)/);
  assert.match(addFlow, /validation\.cents !== expectedCents/);
});

/* ---------------- edit-expense.js：编辑流程 ---------------- */
// 低危项 A10 将 readEditDraft 等提级为模块级函数（显式参数），断言边界同步更新
test('js/edit-expense.js：编辑保存不用 parseFloat 宽松解析', () => {
  const source = readSource('js/edit-expense.js');
  const editFlow = sliceBetween(
    source,
    'function _readEditDraft(body, expense)',
    'function _showEditValidationError',
  );

  assert.doesNotMatch(editFlow, /\bparseFloat\s*\(/);
  assert.match(editFlow, /ExpenseDB\.validateExpenseDraft\(current\.draft/);
});

test('js/edit-expense.js：编辑日期原值进入校验器且无 now fallback', () => {
  const source = readSource('js/edit-expense.js');
  const editDraft = sliceBetween(
    source,
    'function _readEditDraft(body, expense)',
    'function _validateEditDraft',
  );

  assert.match(editDraft, /date:\s*document\.getElementById\('edit-date'\)\.value/);
  assert.doesNotMatch(editDraft, /date:[^,\n]*(?:\|\||\?\?)[^,\n]*(?:today|now|Date)/i);
});

test('js/edit-expense.js：编辑大额确认比较捕获的整数分', () => {
  const source = readSource('js/edit-expense.js');
  const editFlow = sliceBetween(
    source,
    "document.getElementById('edit-btn-save').addEventListener",
    '  return { init, open };',
  );

  assert.match(editFlow, /const confirmedCents = validation\.cents/);
  assert.match(editFlow, /latest\.cents !== confirmedCents/);
  assert.match(editFlow, /_persistEdit\(body, expense, expenseId, confirmedCents\)/);
});

/* ---------------- budget-overlay.js：预算流程 ---------------- */
test('js/budget-overlay.js：预算保存不用 parseFloat 宽松解析', () => {
  const source = readSource('js/budget-overlay.js');
  const budgetFlow = sliceBetween(
    source,
    "document.getElementById('budget-btn-save').addEventListener",
    "document.getElementById('budget-btn-reset').addEventListener",
  );

  assert.doesNotMatch(budgetFlow, /\bparseFloat\s*\(/);
  assert.match(budgetFlow, /ExpenseDB\.validateBudgetDraft\(draft\)/);
  assert.match(budgetFlow, /ExpenseDB\.saveBudget\(validation\.value\)/);
});

test('js/budget-overlay.js：预算普通保存与重置使用不同持久化模式', () => {
  const source = readSource('js/budget-overlay.js');
  const budgetSection = sliceBetween(
    source,
    "document.getElementById('budget-btn-save').addEventListener",
    "overlay.classList.add('page-overlay--open');",
  );

  assert.match(budgetSection, /ExpenseDB\.saveBudget\(validation\.value\)/);
  assert.match(budgetSection, /ExpenseDB\.saveBudget\(ExpenseData\.DEFAULT_BUDGET,\s*\{\s*mode:\s*'reset'\s*\}\)/);
});
