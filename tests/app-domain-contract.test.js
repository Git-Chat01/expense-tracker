const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SCRIPTS = [
  'js/app.js',
  'js/app-v217.js',
];

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

for (const appPath of APP_SCRIPTS) {
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
