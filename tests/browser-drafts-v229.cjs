/* 草稿/跨日/键盘隔离回归。只通过 ExpenseDB 使用合成数据。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(target, (error, data) => {
    if (error) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream');
    res.end(data);
  });
});
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const NativeDate = Date;
      window.testNow = '2026-10-25T23:59:00';
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [window.testNow])); }
        static now() { return new NativeDate(window.testNow).getTime(); }
      };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('#onboarding-skip').click();
    await page.locator('[data-view="add"]').click();
    await page.locator('[data-quick-cat-id]').first().click();
    for (const key of ['2', '5']) await page.locator(`[data-key="${key}"]`).click();
    await page.locator('#add-more-fields').evaluate(el => { el.open = true; });
    await page.locator('#add-note').fill('核对历史账单时保留的草稿');
    await page.locator('[data-view="list"]').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => ExpenseDB.getExpenseCount()), 0, '导航 Enter 不得保存草稿');
    assert.equal(await page.evaluate(() => ExpenseApp.getCurrentView()), 'list');
    await page.locator('[data-view="add"]').click();
    assert.equal(await page.locator('#add-amount-display').innerText(), '25');
    assert.equal(await page.locator('#add-note').inputValue(), '核对历史账单时保留的草稿');
    assert.equal(await page.evaluate(() => ExpenseApp.hasUnsavedDraft()), true);
    await page.evaluate(() => {
      window.testNow = '2026-10-26T12:00:00';
      window.dispatchEvent(new Event('pageshow'));
    });
    assert.equal(await page.locator('#add-date').inputValue(), '2026-10-25', '已有草稿不自动改日期');
    assert.equal(await page.locator('#add-date-label').innerText(), '昨天');
    await page.locator('[data-key="submit"]').click();
    assert.equal(await page.evaluate(() => ExpenseDB.getExpenses()[0].date), '2026-10-25');
    assert.equal(await page.evaluate(() => ExpenseApp.hasUnsavedDraft()), false, '保存后不残留脏标记');
    await page.evaluate(() => {
      window.testNow = '2026-10-27T09:00:00';
      window.dispatchEvent(new Event('pageshow'));
    });
    assert.equal(await page.locator('#add-date').inputValue(), '2026-10-27', '空表单恢复时同步今天');
    assert.equal(await page.locator('#add-time').inputValue(), '09:00');
    await page.locator('[data-key="1"]').click();
    await page.locator('[data-key="2"]').click();
    await page.locator('[data-key="submit"]').click();
    assert.ok(await page.evaluate(() => ExpenseDB.getExpenses().some(e => e.amount === 12 && e.date === '2026-10-27' && e.time === '09:00')));
    // 不依赖恢复事件：空表单停留跨日，第一次操作也同步默认时间。
    await page.evaluate(() => { window.testNow = '2026-10-28T08:05:00'; });
    await page.locator('[data-key="3"]').click();
    assert.equal(await page.locator('#add-date').inputValue(), '2026-10-28');
    await page.locator('#add-discard-draft').click();
    assert.equal(await page.locator('.confirm-dialog__cancel').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('[data-confirm-ok]').evaluate(el => document.activeElement === el), true);
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('.confirm-dialog__cancel').evaluate(el => document.activeElement === el), true);
    await page.locator('.confirm-dialog__cancel').click();
    assert.equal(await page.locator('#add-amount-display').innerText(), '3', '取消清空应保留草稿');
    await page.locator('#add-discard-draft').click();
    await page.locator('[data-confirm-ok]').click();
    assert.equal(await page.locator('#add-amount-display').innerText(), '0');
    assert.equal(await page.evaluate(() => ExpenseApp.hasUnsavedDraft()), false);
    await page.locator('#add-date-quick').click();
    await page.locator('#add-date').fill('2025-12-31');
    await page.locator('#add-time').fill('13:20');
    await page.locator('[data-key="5"]').click();
    await page.evaluate(() => {
      window.testNow = '2026-10-29T08:00:00';
      window.dispatchEvent(new Event('pageshow'));
    });
    assert.equal(await page.locator('#add-date').inputValue(), '2025-12-31', '手动日期绝不自动覆盖');
    await page.locator('[data-quick-cat-id]').first().click();
    await page.locator('[data-key="submit"]').click();
    assert.ok(await page.evaluate(() => ExpenseDB.getExpenses().some(e => e.amount === 5 && e.date === '2025-12-31')));
    assert.equal(await page.evaluate(() => ExpenseApp.hasUnsavedDraft()), false);
    // 覆盖层拥有自己的键盘输入；不能修改背后的金额。
    await page.locator('#add-category-summary').click();
    await page.locator('#add-manage-categories').click();
    await page.locator('#overlay-categories-add').focus();
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#new-cat-name').isVisible(), true);
    await page.locator('#new-cat-name').fill('未保存分类');
    assert.equal(await page.evaluate(() => ExpenseApp.hasUnsavedDraft()), true);
    await page.locator('#new-cat-cancel').click();
    await page.locator('#overlay-categories-back').click();
    assert.equal(await page.locator('#add-amount-display').innerText(), '0');
    await page.locator('[data-view="home"]').click();
    await page.locator('#home-set-budget').click();
    assert.equal(await page.evaluate(() => ExpenseApp.hasUnsavedDraft()), false);
    await page.locator('#budget-input-total').fill('300');
    assert.equal(await page.evaluate(() => ExpenseApp.hasUnsavedDraft()), true);
    await page.locator('#budget-btn-save').click();
    assert.equal(await page.evaluate(() => ExpenseApp.hasUnsavedDraft()), false);
    await page.evaluate(() => {
      ExpenseConfirm.open({ title: '合成旧确认' }).then(value => { window.firstConfirmation = value; });
      ExpenseConfirm.open({ title: '合成新确认' }).then(value => { window.secondConfirmation = value; });
    });
    assert.equal(await page.locator('#confirm-dialog').isVisible(), true);
    assert.equal(await page.locator('#confirm-dialog-title').innerText(), '合成新确认');
    assert.equal(await page.evaluate(() => window.firstConfirmation), false);
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => window.secondConfirmation), false);
    assert.deepEqual(errors, []);
    console.log('草稿切页、跨日/手动日期、清空确认、导航/覆盖层键盘、未保存状态回归通过');
    await context.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
