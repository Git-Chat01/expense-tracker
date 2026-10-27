/* v230 编辑面板：随机本地端口、隔离浏览器、仅经 ExpenseDB 写入合成账本。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const out = process.env.ARTIFACT_DIR || path.join(root, 'output/verification-v230/edit');
fs.mkdirSync(out, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(target, (error, data) => {
    if (error) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream');
    if (target === path.join(root, 'index.html')) {
      let html = data.toString().replace(/js\/edit-expense-v\d+\.js/g, 'js/edit-expense-v230.js');
      if (!html.includes('css/edit-experience-v230.css')) html = html.replace('</head>', '<link rel="stylesheet" href="css/edit-experience-v230.css"></head>');
      data = html;
    }
    res.end(data);
  });
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  const results = { sizes: [] };
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN', timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const NativeDate = Date;
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-26T12:00:00'])); } };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = 'http://127.0.0.1:' + server.address().port;
    await page.goto(url);
    await page.locator('#onboarding-skip').click();
    const id = await page.evaluate(() => {
      const backup = ExpenseDB.exportAll();
      backup.expenses = Array.from({ length: 80 }, (_, i) => ({ id: 'synthetic-edit-' + i, amount: 12, date: '2026-10-25', time: '12:00', categoryId: 'cat-food-meal', paymentMethod: 'other', necessity: 'need', note: '合成编辑记录 ' + i }));
      if (!ExpenseDB.importAll(backup).success) throw Error('合成导入失败');
      window.editTestOriginal = JSON.stringify(ExpenseDB.getExpenses().filter(e => e.id !== 'synthetic-edit-45'));
      return 'synthetic-edit-45';
    });
    await page.locator('[data-view="list"]').click();
    await page.waitForTimeout(250);
    const row = page.locator(`.list-item[data-id="${id}"]`);
    await row.scrollIntoViewIfNeeded();
    await row.focus();
    const scrollBefore = await page.evaluate(() => scrollY);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(400);
    assert.equal(await page.locator('#overlay-edit > #overlay-edit-footer #edit-btn-save').count(), 1);
    assert.equal(await page.locator('#overlay-edit-body').evaluate(el => el.scrollTop), 0);
    assert.equal(await page.locator('#edit-btn-save').isVisible(), true);
    assert.equal(await page.locator('[data-edit-pm="other"]').getAttribute('aria-pressed'), 'true', '历史其他支付方式继续可编辑');
    await page.locator('#edit-btn-save').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#overlay-edit-back').evaluate(el => document.activeElement === el), true, '焦点循环包含独立保存区');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await page.locator('#edit-btn-save').evaluate(el => document.activeElement === el), true);
    await page.locator('#overlay-edit-back').click();
    assert.equal(await page.evaluate(() => scrollY), scrollBefore);
    assert.equal(await row.evaluate(el => document.activeElement === el), true);

    // 写入期间所有编辑入口包含保存 footer 都禁用，Escape 不能丢掉正在提交的草稿。
    await row.click();
    await page.locator('#edit-amount').fill('13.25');
    await page.locator('[data-edit-pm="cash"]').click();
    assert.equal(await page.locator('[data-edit-pm="cash"]').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.locator('[data-edit-pm="other"]').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.locator('[data-edit-pm="cash"] .edit-choice-check').evaluate(el => getComputedStyle(el).visibility), 'visible');
    await page.evaluate(() => {
      const save = ExpenseDB.updateExpenseIfUnchanged;
      ExpenseDB.updateExpenseIfUnchanged = (...args) => new Promise(resolve => {
        window.releaseEditSave = () => {
          ExpenseDB.updateExpenseIfUnchanged = save;
          window.pendingEditSave = save(...args);
          window.pendingEditSave.then(resolve);
        };
      });
    });
    await page.locator('#edit-btn-save').click();
    assert.equal(await page.locator('#overlay-edit input, #overlay-edit select, #overlay-edit button').evaluateAll(els => els.every(el => el.disabled)), true);
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#overlay-edit').evaluate(el => el.classList.contains('bottom-sheet--open')), true);
    await page.evaluate(() => { window.releaseEditSave(); });
    await page.waitForFunction(() => !document.querySelector('#overlay-edit').classList.contains('bottom-sheet--open'));
    assert.equal(await page.evaluate(id => ExpenseDB.getExpense(id).amount, id), 13.25);
    assert.equal(await page.evaluate(id => ExpenseDB.getExpense(id).paymentMethod, id), 'cash');
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) < 2);
    assert.equal(await row.evaluate(el => document.activeElement === el), true);
    results.save = { amount: 13.25, paymentMethod: 'cash', mutationGuard: true, scrollBefore, scrollAfter: await page.evaluate(() => scrollY), focusRestored: true };

    await row.click();
    await page.locator('#edit-note').fill('不能自动丢弃的草稿');
    await page.keyboard.press('Escape');
    await page.locator('.confirm-dialog__cancel').click();
    assert.equal(await page.locator('#edit-note').inputValue(), '不能自动丢弃的草稿');
    await page.locator('#overlay-edit-backdrop').click({ position: { x: 5, y: 5 } });
    await page.locator('[data-confirm-ok]').click();
    assert.equal(await page.evaluate(id => ExpenseDB.getExpense(id).note, id), '合成编辑记录 45');

    // 两页真实共享合成存储：拒绝陈旧保存和删除，再载入最新版本后仍可保存。
    await row.click();
    await page.locator('#edit-note').fill('第一页未保存的修改');
    const otherPage = await context.newPage();
    otherPage.on('pageerror', error => errors.push(error.message));
    await otherPage.goto(url);
    await otherPage.evaluate(id => ExpenseEditOverlay.open(id), id);
    await otherPage.locator('#edit-amount').fill('22');
    await otherPage.locator('#edit-btn-save').click();
    await otherPage.waitForFunction(id => ExpenseDB.getExpense(id).amount === 22, id);
    await page.locator('#edit-btn-save').click();
    await page.locator('#edit-conflict-status').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#edit-note').inputValue(), '第一页未保存的修改');
    assert.equal(await page.evaluate(id => ExpenseDB.getExpense(id).amount, id), 22);
    await page.locator('#overlay-edit-delete').click();
    await page.locator('[data-confirm-ok]').click();
    await page.waitForFunction(() => !document.querySelector('#overlay-edit-delete').disabled);
    assert.ok(await page.evaluate(id => ExpenseDB.getExpense(id), id));
    await page.locator('#edit-reload-latest').click();
    await page.locator('[data-confirm-ok]').click();
    await page.waitForFunction(() => document.querySelector('#edit-amount').value === '22');
    await page.locator('#edit-note').fill('核对最新版本后保存');
    await page.locator('#edit-btn-save').click();
    await page.waitForFunction(() => !document.querySelector('#overlay-edit').classList.contains('bottom-sheet--open'));
    assert.equal(await page.evaluate(id => ExpenseDB.getExpense(id).note, id), '核对最新版本后保存');
    assert.equal(await page.evaluate(id => ExpenseDB.getExpense(id).amount, id), 22);
    assert.equal(await page.locator('#edit-btn-save').count(), 1, '载入最新记录不叠加 footer');
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - scrollBefore) < 2);
    assert.equal(await row.evaluate(el => document.activeElement === el), true);
    results.conflict = { staleSaveRejected: true, staleDeleteRejected: true, latestReloadSaved: true, draftCancelProtected: true };
    await otherPage.close();

    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await row.click();
      await page.waitForTimeout(400);
      const initial = await page.evaluate(() => {
        const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
        return { save: rect('#edit-btn-save'), footer: rect('#overlay-edit-footer'), body: rect('#overlay-edit-body'), close: rect('#overlay-edit-back'), delete: rect('#overlay-edit-delete'), scrollTop: document.querySelector('#overlay-edit-body').scrollTop, overflow: document.documentElement.scrollWidth > innerWidth };
      });
      assert.equal(initial.scrollTop, 0);
      assert.equal(initial.overflow, false);
      assert.ok(initial.save.top >= 0 && initial.save.bottom <= 844);
      assert.ok(initial.close.height >= 44 && initial.close.width >= 44 && initial.delete.height >= 44);
      assert.ok(initial.body.bottom <= initial.footer.top + 1, '表单和保存区不能重叠');
      await page.locator('#overlay-edit-body').evaluate(el => { el.scrollTop = el.scrollHeight; });
      const bottom = await page.evaluate(() => ({ date: document.querySelector('#edit-date').getBoundingClientRect().bottom, time: document.querySelector('#edit-time').getBoundingClientRect().bottom, body: document.querySelector('#overlay-edit-body').getBoundingClientRect().bottom }));
      assert.ok(bottom.date <= bottom.body && bottom.time <= bottom.body, '表单最末字段不被保存区遮挡');
      await page.screenshot({ path: path.join(out, `edit-bottom-${width}.png`) });
      await page.locator('#overlay-edit-body').evaluate(el => { el.scrollTop = 0; });
      await page.screenshot({ path: path.join(out, `edit-open-${width}.png`) });
      results.sizes.push({ width, saveTop: initial.save.top, saveBottom: initial.save.bottom, closeSize: [initial.close.width, initial.close.height], bottomFieldsAccessible: true });
      await page.locator('#overlay-edit-back').click();
    }

    // 模拟键盘使 visualViewport 收缩且向下平移；不改页面或其他视图的滚动结构。
    await row.click();
    await page.locator('#edit-note').focus();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport, 'height', { configurable: true, value: 320 });
      Object.defineProperty(visualViewport, 'offsetTop', { configurable: true, value: 40 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    await page.waitForTimeout(450);
    const keyboard = await page.evaluate(() => {
      const save = document.querySelector('#edit-btn-save').getBoundingClientRect();
      const body = document.querySelector('#overlay-edit-body').getBoundingClientRect();
      const note = document.querySelector('#edit-note').getBoundingClientRect();
      return { saveTop: save.top, saveBottom: save.bottom, bodyTop: body.top, bodyBottom: body.bottom, noteTop: note.top, noteBottom: note.bottom };
    });
    assert.ok(keyboard.saveTop >= 40 && keyboard.saveBottom <= 360, '键盘出现时保存按钮在可视区');
    assert.ok(keyboard.noteTop >= keyboard.bodyTop && keyboard.noteBottom <= keyboard.bodyBottom, '聚焦字段随可视区变化保持可见');
    await page.screenshot({ path: path.join(out, 'edit-keyboard-simulation.png') });
    await page.locator('#edit-note').fill('键盘缩短视口后保存');
    await page.locator('#edit-btn-save').click();
    await page.waitForFunction(() => !document.querySelector('#overlay-edit').classList.contains('bottom-sheet--open'));
    assert.equal(await page.evaluate(id => ExpenseDB.getExpense(id).note, id), '键盘缩短视口后保存');
    await page.evaluate(() => { delete visualViewport.height; delete visualViewport.offsetTop; visualViewport.dispatchEvent(new Event('resize')); });
    results.keyboard = { ...keyboard, actualSave: true, realDevice: false };
    assert.equal(await page.evaluate(() => ExpenseDB.getExpenseCount()), 80);
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses().filter(e => e.id !== 'synthetic-edit-45')) === window.editTestOriginal), true);
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    console.log(JSON.stringify(results, null, 2));
    await context.close();
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
