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
    return this.values.has(String(key)) ? this.values.get(String(key)) : null;
  }

  setItem(key, value) {
    this.values.set(String(key), String(value));
  }

  removeItem(key) {
    this.values.delete(String(key));
  }

  snapshot() {
    return Object.fromEntries(this.values);
  }
}

function loadCalculator(storagePath) {
  const storageSource = fs.readFileSync(path.join(__dirname, '..', storagePath), 'utf8');
  const impactSource = fs.readFileSync(path.join(__dirname, '..', 'js/budget-impact-v214.js'), 'utf8');
  const storage = new MemoryStorage();
  const context = vm.createContext({
    console: { error() {} },
    localStorage: storage,
  });

  vm.runInContext(
    `${storageSource}\n${impactSource}\n;globalThis.__budgetImpactDomainTest = {\n`
      + '  calculateJson: (formRaw, snapshotRaw, today) => JSON.stringify(\n'
      + '    ExpenseBudgetImpact.calculate(JSON.parse(formRaw), JSON.parse(snapshotRaw), today)\n'
      + '  ),\n'
      + '};',
    context,
    { filename: `${storagePath}+budget-impact-v214.js` },
  );

  return {
    calculate(formState, snapshot, today) {
      return JSON.parse(context.__budgetImpactDomainTest.calculateJson(
        JSON.stringify(formState),
        JSON.stringify(snapshot),
        today,
      ));
    },
    storage,
  };
}

function validSnapshot() {
  return {
    ok: true,
    expenses: [{
      id: 'existing-expense',
      amount: 10,
      categoryId: 'cat-parent',
      date: '2026-08-11',
    }],
    categories: [{ id: 'cat-parent', name: '餐饮', parentId: null }],
    budget: {
      monthlyTotal: 100,
      categories: { 'cat-parent': 50 },
    },
  };
}

const INVALID_SNAPSHOT_MONEY_CASES = [
  {
    label: '历史账单 1.001',
    mutate(snapshot) {
      snapshot.expenses[0].amount = 1.001;
    },
  },
  {
    label: '月预算 1.001',
    mutate(snapshot) {
      snapshot.budget.monthlyTotal = 1.001;
    },
  },
  {
    label: '分类预算 1.001',
    mutate(snapshot) {
      snapshot.budget.categories['cat-parent'] = 1.001;
    },
  },
];

for (const storagePath of STORAGE_SCRIPTS) {
  for (const invalid of INVALID_SNAPSHOT_MONEY_CASES) {
    test(`${storagePath} + budget-impact：${invalid.label}时提示 fail-closed`, () => {
      const calculator = loadCalculator(storagePath);
      const snapshot = validSnapshot();
      invalid.mutate(snapshot);
      const before = calculator.storage.snapshot();

      const result = calculator.calculate({
        amountRaw: '1.00',
        categoryId: 'cat-parent',
        date: '2026-08-11',
      }, snapshot, '2026-08-11');

      assert.equal(result.visible, false);
      assert.equal(result.reason, 'snapshot-unavailable');
      assert.deepEqual(calculator.storage.snapshot(), before, '预算影响纯计算不得触发存储写入');
    });
  }
}
