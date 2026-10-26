/* v229 审计回归：隔离端口/上下文，所有账本写入只经 ExpenseDB。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.ARTIFACT_DIR || path.join(root, 'output/verification-v229/audit');
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(target, (error, data) => {
    if (error) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream');
    res.end(data);
  });
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  const results = {};
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const NativeDate = Date;
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-26T12:00:00'])); } };
    });
    const a = await context.newPage();
    const errors = [];
    a.on('pageerror', error => errors.push(error.message));
    const url = 'http://127.0.0.1:' + server.address().port;
    await a.goto(url);
    await a.locator('#onboarding-skip').click();
    const id = await a.evaluate(() => {
      const backup = ExpenseDB.exportAll();
      backup.expenses = Array.from({ length: 180 }, (_, i) => ({ id: 'synthetic-' + i, amount: 12, date: '2026-10-25', time: '12:00', categoryId: 'cat-food-meal', paymentMethod: 'cash', necessity: 'need', note: '合成记录 ' + i }));
      if (!ExpenseDB.importAll(backup).success) throw Error('合成导入失败');
      return backup.expenses[45].id;
    });
    await a.locator('[data-view="list"]').click();
    assert.equal(await a.locator('.list-item').count(), 100);
    assert.match(await a.locator('#list-summary-count').innerText(), /180/);
    await a.locator('.list-load-more__button').click();
    assert.equal(await a.locator('.list-item').count(), 180);
    assert.equal(await a.locator('.list-group-header').count(), 1, '跨批同一天只显示一个组头');
    await a.waitForTimeout(200);
    const row = a.locator(`.list-item[data-id="${id}"]`);
    await row.scrollIntoViewIfNeeded();
    const scrollBefore = await a.evaluate(() => scrollY);
    await row.focus();
    await a.keyboard.press('Enter');
    assert.equal(await a.locator('#edit-reload-latest').isVisible(), false, '没有冲突时不显示重载入口');
    const labels = await a.locator('#overlay-edit input, #overlay-edit select').evaluateAll(els => els.every(el => el.labels.length === 1));
    assert.equal(labels, true);
    await a.locator('#overlay-edit-back').click();
    assert.equal(await a.evaluate(() => scrollY), scrollBefore);
    assert.equal(await row.evaluate(el => document.activeElement === el), true);
    await row.click();
    await a.locator('#edit-note').fill('A尚未保存的备注');
    assert.equal(await a.evaluate(() => ExpenseApp.hasUnsavedDraft()), true);
    // 真实共享浏览器存储中的两个编辑页。
    const b = await context.newPage();
    b.on('pageerror', error => errors.push(error.message));
    await b.goto(url);
    await b.locator('[data-view="list"]').click();
    await b.locator(`.list-item[data-id="${id}"]`).click();
    await b.locator('#edit-amount').fill('22');
    await b.locator('#edit-btn-save').click();
    await b.waitForFunction(id => ExpenseDB.getExpense(id).amount === 22, id);
    await a.locator('#edit-btn-save').click();
    await a.locator('#edit-conflict-status').waitFor({ state: 'visible' });
    assert.equal(await a.evaluate(id => ExpenseDB.getExpense(id).amount, id), 22);
    assert.equal(await a.locator('#edit-note').inputValue(), 'A尚未保存的备注');
    await a.screenshot({ path: path.join(out, 'edit-conflict.png') });
    await a.locator('#overlay-edit-delete').click();
    await a.locator('[data-confirm-ok]').click();
    await a.waitForFunction(() => !document.querySelector('#overlay-edit-delete').disabled);
    assert.ok(await a.evaluate(id => ExpenseDB.getExpense(id), id), '陈旧删除不能删掉另一页新版记录');
    await a.locator('#edit-reload-latest').click();
    await a.locator('.confirm-dialog__cancel').click();
    assert.equal(await a.locator('#edit-note').inputValue(), 'A尚未保存的备注');
    await a.locator('#edit-reload-latest').click();
    await a.locator('[data-confirm-ok]').click();
    await a.waitForFunction(() => document.querySelector('#edit-amount').value === '22');
    await a.locator('#edit-note').fill('已核对最新版本');
    await a.locator('#edit-btn-save').click();
    await a.waitForFunction(() => !document.querySelector('#overlay-edit').classList.contains('bottom-sheet--open'));
    assert.equal(await a.evaluate(id => ExpenseDB.getExpense(id).amount, id), 22);
    assert.ok(Math.abs(await a.evaluate(() => scrollY) - scrollBefore) < 2, '保存后保留滚动位置');
    assert.equal(await row.evaluate(el => document.activeElement === el), true, '保存重绘后恢复行焦点');
    results.edit = { conflictProtected: true, draftRetained: true, staleDeleteRejected: true, scrollBefore, scrollAfter: await a.evaluate(() => scrollY) };
    await b.close();

    await a.locator('[data-filter="date"]').click();
    await a.locator('.list-dropdown__date-from').fill('');
    await a.locator('.list-dropdown__date-to').fill('2026-10-24');
    await a.locator('.list-dropdown__date-confirm').click();
    assert.equal(await a.locator('.list-item').count(), 0);
    assert.match(await a.locator('#list-active-filters').innerText(), /截至 2026-10-24/);
    assert.match(await a.locator('[data-filter="date"]').getAttribute('class'), /chip--active/);
    await a.locator('#list-clear-all').click();
    assert.equal(await a.locator('.list-item').count(), 100);

    // 导入失败不写账本，历史不安全字符串也只能作为文本显示。
    const currency = await a.evaluate(() => {
      const before = JSON.stringify(ExpenseDB.getExpenses());
      const backup = ExpenseDB.exportAll();
      backup.settings.currency = '<b data-injection="yes">演示</b><style>body{display:none}</style>';
      const imported = ExpenseDB.importAll(backup);
      const getSettings = ExpenseDB.getSettings;
      ExpenseDB.getSettings = () => ({ ...getSettings(), currency: backup.settings.currency });
      return { rejected: !imported.success, unchanged: before === JSON.stringify(ExpenseDB.getExpenses()) };
    });
    assert.deepEqual(currency, { rejected: true, unchanged: true });
    await a.locator('[data-view="stats"]').click();
    await a.locator('#mr-entry').click();
    assert.equal(await a.locator('#overlay-monthly-report-body [data-injection], #overlay-monthly-report-body style').count(), 0);
    assert.match(await a.locator('#overlay-monthly-report-body').innerText(), /<b data-injection/);
    await a.locator('#overlay-monthly-report-back').click();
    await a.reload();

    // 前日32元 + 明天100元：允许预记且明确预算占用。
    await a.evaluate(() => {
      const backup = ExpenseDB.exportAll();
      backup.expenses = [{ id: 'occurred', amount: 32, date: '2026-10-26', categoryId: 'cat-food', paymentMethod: 'cash' }, { id: 'future', amount: 100, date: '2026-10-27', categoryId: 'cat-food', paymentMethod: 'cash' }];
      backup.budget = { monthlyTotal: 300, categories: {} };
      if (!ExpenseDB.importAll(backup).success) throw Error('预记夹具失败');
      ExpenseApp.navigate('home');
    });
    assert.match(await a.locator('#home-month-amount').innerText(), /32.00/);
    assert.equal(await a.locator('#home-month-label').innerText(), '本月支出（截至今天）');
    assert.match(await a.locator('#home-budget-prebooked').innerText(), /预记 ¥100.00/);
    assert.equal(await a.locator('#home-budget-spent-label').innerText(), '本月已记');
    assert.match(await a.locator('#home-budget-summary-spent').innerText(), /132.00/);
    for (const width of [320, 390, 430]) {
      await a.setViewportSize({ width, height: 844 });
      assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await a.screenshot({ path: path.join(out, `prebooked-${width}.png`) });
    }
    await a.locator('.home-data-management__summary').click();
    const beforeDownload = await a.evaluate(() => JSON.stringify(ExpenseDB.exportAll().expenses));
    const downloadPromise = a.waitForEvent('download');
    await a.locator('#home-pre-import-backup').click();
    const download = await downloadPromise;
    const backupPath = path.join(out, 'before-restore-synthetic.json');
    await download.saveAs(backupPath);
    assert.equal(JSON.parse(fs.readFileSync(backupPath, 'utf8')).expenses.length, 180);
    assert.equal(await a.evaluate(() => JSON.stringify(ExpenseDB.exportAll().expenses)), beforeDownload);
    results.backup = { preImportDownloadCount: 180, currentCount: 2, unchangedAfterDownload: true, unsafeCurrencyRejected: true, legacyCurrencyEscaped: true };
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    await context.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
