/* 隔离浏览器验收；仅通过 ExpenseDB 写入合成数据。
 * PLAYWRIGHT_MODULE / CHROMIUM_EXECUTABLE 可指向现有运行时，不安装依赖。
 * 示例：node tests/browser-display.cjs */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const artifacts = process.env.ARTIFACT_DIR || fs.mkdtempSync(path.join(os.tmpdir(), 'expense-v224-'));
fs.mkdirSync(artifacts, { recursive: true });
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(root + path.sep)) { res.writeHead(403).end(); return; }
  fs.readFile(target, (err, content) => {
    if (err) { res.writeHead(404).end(); return; }
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream');
    res.end(content);
  });
});

async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const NativeDate = Date;
      window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : ['2026-09-13T12:00:00'])); }
      };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const url = 'http://127.0.0.1:' + server.address().port;
    await page.goto(url);
    await page.locator('#onboarding-skip').click();
    assert.equal(await page.locator('#home-today').isVisible(), false);
    assert.equal(await page.locator('#home-month-comparison').isVisible(), false);
    await page.screenshot({ path: path.join(artifacts, 'empty-home.png') });

    const fixture = await page.evaluate(() => {
      const amounts = [35.5, 18, 128, 300, 86, 500, 23, 888];
      const dates = ['2026-09-13', '2026-09-12', '2026-09-08', '2026-09-02', '2026-08-31', '2026-08-20', '2026-08-10', '2025-09-13'];
      const cats = ['cat-food', 'cat-transport', 'cat-shopping', 'cat-entertain'];
      for (let i = 0; i < dates.length; i++) {
        if (!ExpenseDB.addExpense({ amount: amounts[i], date: dates[i], categoryId: cats[i % cats.length], time: '12:30', paymentMethod: 'wechat', necessity: i % 2 ? 'need' : 'impulse', location: i === 0 ? '星河咖啡' : '', note: '回归测试' })) throw Error('测试记录写入失败');
      }
      if (!ExpenseDB.saveBudget({ monthlyTotal: 481.49, categories: {} })) throw Error('测试预算写入失败');
      return JSON.stringify(ExpenseDB.getExpenses());
    });
    await page.reload();
    await page.evaluate(() => { Chart.defaults.animation = false; });
    assert.match(await page.locator('#home-budget-summary-remaining').innerText(), /0\.01/);
    assert.match(await page.locator('#home-month-amount').innerText(), /481\.50/);
    const homeChange = await page.locator('#home-month-diff').innerText();
    assert.match(homeChange, /1993%/);
    await page.locator('#home-set-budget').click();
    assert.match(await page.locator('#overlay-budget-body').innerText(), /已超 ¥0\.01/);
    await page.locator('#overlay-budget-back').click();

    for (const width of [320, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of ['home', 'add', 'list', 'stats']) {
        await page.locator(`[data-view="${view}"]`).click();
        await page.waitForTimeout(300);
        const sizes = await page.evaluate(() => ({ viewport: innerWidth, content: document.documentElement.scrollWidth }));
        assert.ok(sizes.content <= sizes.viewport, `${width}px ${view} 水平溢出：${JSON.stringify(sizes)}`);
        if (view === 'list' || view === 'stats') {
          const targets = await page.locator(view === 'list' ? '#list-filter-bar .chip' : '.stats-period .chip')
            .evaluateAll(els => els.map(el => el.getBoundingClientRect().height));
          assert.ok(targets.every(height => height >= 44), '筛选/周期按钮至少44px');
        }
        if (view === 'stats') {
          assert.equal(await page.locator('.stats-period').evaluate(el => el.scrollWidth <= el.clientWidth), true, '周期按钮应完整显示');
          assert.ok(await page.evaluate(() => Chart.getChart('stats-category-chart').data.datasets[0].data.length > 0));
        }
        await page.screenshot({ path: path.join(artifacts, `${view}-${width}.png`) });
      }
      await page.locator('[data-view="add"]').click();
      await page.waitForTimeout(300); // 等切页的滚动恢复完成后再测吸顶。
      await page.locator('#add-more-fields').evaluate(el => { el.open = true; });
      await page.evaluate(() => window.scrollTo(0, scrollY + document.querySelector('.add-amount-display').getBoundingClientRect().top + 20));
      const a = await page.evaluate(() => ({ y: scrollY, amount: document.querySelector('.add-amount-display').getBoundingClientRect().top, pad: document.querySelector('#add-numpad').getBoundingClientRect().top }));
      await page.evaluate(() => window.scrollTo(0, 10000));
      const b = await page.evaluate(() => ({ y: scrollY, amount: document.querySelector('.add-amount-display').getBoundingClientRect().top, pad: document.querySelector('#add-numpad').getBoundingClientRect().top, position: getComputedStyle(document.querySelector('#add-numpad')).position, bottom: document.querySelector('#add-numpad').getBoundingClientRect().bottom, nav: document.querySelector('.tab-bar').getBoundingClientRect().top }));
      console.log('记账滚动', width, JSON.stringify({ a, b }));
      assert.equal(b.position, 'static');
      assert.ok(Math.abs(a.amount - b.amount) < 1);
      assert.ok(Math.abs((a.pad - b.pad) - (b.y - a.y)) < 1);
      assert.ok(b.bottom <= b.nav);
      await page.locator('#add-more-fields').evaluate(el => { el.open = false; });
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-view="list"]').click();
    assert.match(await page.locator('#list-content').innerText(), /2025年9月13日/);
    // 默认日期分组保留跨年年份；金额排序仍可切换。
    assert.equal(await page.locator('[data-filter="sort"]').innerText(), '日期↓');
    assert.match(await page.locator('.list-group-header').allInnerTexts().then(v => v.join('\n')), /2025年9月13日/);


    await page.locator('#list-search-toggle').click();
    await page.locator('#list-search-input').fill(' 星河咖啡 ');
    assert.equal(await page.locator('.list-item').count(), 1);
    assert.equal(await page.locator('.list-item mark').innerText(), '星河咖啡');
    await page.locator('#list-search-input').fill('餐饮');
    assert.equal(await page.locator('.list-item').count(), 2);
    await page.locator('[data-filter="necessity"]').click();
    await page.locator('.list-dropdown__item[data-val="impulse"]').click();
    assert.equal(await page.locator('.list-item').count(), 2);
    await page.locator('#list-clear-all').click();
    await page.locator('[data-filter="necessity"]').click();
    await page.locator('.list-dropdown__item[data-val=""]').click();
    assert.equal(await page.locator('.list-item').count(), 0);
    await page.locator('.filter-chip__remove[data-clear="necessity-"]').click();
    assert.equal(await page.locator('.list-item').count(), 8);
    assert.equal(await page.locator('[data-filter="necessity"]').evaluate(el => el.classList.contains('chip--active')), false);
    await page.locator('[data-filter="sort"]').click();
    await page.locator('[data-filter="sort"]').click();
    assert.equal(await page.locator('[data-filter="sort"]').innerText(), '金额↓');
    assert.match(await page.locator('.list-item').first().innerText(), /888.00/);
    await page.reload();
    await page.locator('[data-view="list"]').click();
    assert.equal(await page.locator('[data-filter="sort"]').innerText(), '金额↓');
    await page.locator('[data-filter="sort"]').click();
    await page.locator('[data-filter="sort"]').click();
    assert.equal(await page.locator('[data-filter="sort"]').innerText(), '日期↓');

    await page.locator('[data-filter="date"]').click();
    await page.locator('.list-dropdown__date-from').fill('2026-09-20');
    await page.locator('.list-dropdown__date-to').fill('2026-09-01');
    await page.locator('.list-dropdown__date-confirm').click();
    assert.equal(await page.locator('.list-dropdown').isVisible(), true);
    assert.match(await page.locator('.list-dropdown__date-error').innerText(), /不能晚于/);
    assert.equal(await page.locator('.list-item').count(), 8);
    await page.screenshot({ path: path.join(artifacts, 'date-error.png') });
    await page.locator('.list-dropdown__date-from').fill('2026-09-01');
    await page.locator('.list-dropdown__date-to').fill('2026-09-13');
    await page.locator('.list-dropdown__date-confirm').click();
    assert.equal(await page.locator('.list-item').count(), 4);
    await page.locator('#list-clear-all').click();

    await page.locator('[data-view="stats"]').click();
    await page.waitForTimeout(300);
    assert.equal(await page.locator('#stats-card-total').innerText(), '¥481.50');
    assert.equal(await page.locator('#stats-payment-details').evaluate(el => el.open), false);
    assert.match(await page.locator('#stats-payment-summary').innerText(), /全部使用微信/);
    await page.locator('#stats-payment-details summary').click();
    await page.waitForFunction(() => Chart.getChart('stats-payment-chart')?.width > 0);
    await page.locator('[data-period="week"]').click();
    assert.equal(await page.locator('#stats-payment-details').evaluate(el => el.open), true);
    assert.equal(await page.evaluate(() => Chart.getChart('stats-payment-chart').data.datasets[0].data[0]), 181.5);
    await page.locator('[data-period="month"]').click();
    await page.locator('#stats-payment-details summary').click();

    assert.match(await page.locator('.stats-chart-center').first().innerText(), /上月同期.*1993%/s);
    await page.locator('[data-period="week"]').click();
    assert.match(await page.locator('#stats-trend-title').innerText(), /近7天/);
    await page.locator('[data-period="month"]').click();
    await page.evaluate(() => window.scrollTo(0, 130));
    const before = await page.evaluate(() => scrollY);
    await page.locator('#mr-entry').click();
    assert.match(await page.locator('.mr-skeleton__trend').innerText(), /1993%/);
    assert.match(await page.locator('.mr-skeleton__cell--total .mr-skeleton__value').innerText(), /481\.50/);
    await page.locator('[data-mr-prev]').click();
    // 已结束月份按整月比较/统计，8 月 609 元，不能沿用 13 日截止。
    assert.match(await page.locator('.mr-skeleton__cell--total .mr-skeleton__value').innerText(), /609\.00/);
    await page.locator('[data-mr-next]').click();
    await page.screenshot({ path: path.join(artifacts, 'monthly-report.png') });
    await page.locator('#overlay-monthly-report-back').click();
    assert.equal(await page.evaluate(() => scrollY), before);
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses())), fixture);

    await page.locator('[data-view="add"]').click();
    await page.locator('#add-category-quick button').first().click();
    for (const key of ['1', '2', '.', '3', '4']) await page.locator(`[data-key="${key}"]`).click();
    await page.locator('[data-key="submit"]').click();
    const newId = await page.evaluate(() => ExpenseDB.getExpenses().find(e => e.amount === 12.34)?.id);
    assert.ok(newId, '保存必须实际写入');
    await page.locator('[data-view="list"]').click();
    await page.locator(`.list-item[data-id="${newId}"]`).click();
    await page.locator('#edit-amount').fill('13.45');
    await page.locator('#edit-btn-save').click();
    assert.equal(await page.evaluate(id => ExpenseDB.getExpenses().find(e => e.id === id).amount, newId), 13.45);
    await page.locator('[data-view="home"]').click();
    await page.locator('.home-data-management__summary').click();
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#home-export-btn').click();
    const download = await downloadPromise;
    const backupPath = path.join(artifacts, 'synthetic-backup.json');
    await download.saveAs(backupPath);
    const backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
    assert.equal(backup.expenses.length, 9);
    await page.locator('#home-import-btn').click();
    await page.locator('#home-import-paste summary').click();
    await page.locator('#home-import-textarea').fill(JSON.stringify(backup));
    await page.locator('#home-import-confirm').click();
    assert.equal(await page.locator('#confirm-dialog').isVisible(), true);
    await page.locator('[data-confirm-ok]').click();
    await page.waitForFunction(() => !document.querySelector('#confirm-dialog').classList.contains('confirm-dialog--open'));
    const restored = await page.evaluate(() => ExpenseDB.getExpenses());
    const byId = values => values.sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(restored), byId(backup.expenses));
    assert.deepEqual(errors, []);

    await page.locator('[data-view="home"]').click();
    await page.locator('#home-import-btn').click();
    await page.locator('.home-data-management__body').screenshot({ path: path.join(artifacts, 'file-restore.png') });
    const beforeFile = await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses()));
    await page.locator('#home-import-file').setInputFiles({ name: 'broken.json', mimeType: 'application/json', buffer: Buffer.from('{broken') });
    await page.waitForFunction(() => document.querySelector('#home-import-status').textContent.includes('格式错误'));
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses())), beforeFile);
    await page.locator('#home-import-file').setInputFiles({ name: 'null.json', mimeType: 'application/json', buffer: Buffer.from('null') });
    await page.waitForFunction(() => !document.querySelector('#home-import-file-btn').disabled);
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses())), beforeFile);

    await page.evaluate(() => {
      window.realFileText = File.prototype.text;
      File.prototype.text = () => Promise.reject(new Error('模拟读取失败'));
    });
    await page.locator('#home-import-file').setInputFiles({ name: 'unreadable.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    await page.waitForFunction(() => document.querySelector('#home-import-status').textContent.includes('读取失败'));
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses())), beforeFile);
    await page.evaluate(() => {
      File.prototype.text = () => new Promise(resolve => { window.finishFileRead = resolve; });
    });
    await page.locator('#home-import-file').setInputFiles({ name: 'slow.json', mimeType: 'application/json', buffer: Buffer.from('{}') });
    await page.waitForFunction(() => document.querySelector('#home-import-file-btn').disabled);
    await page.locator('#home-import-cancel').click();
    await page.evaluate(raw => {
      window.finishFileRead(raw);
      File.prototype.text = window.realFileText;
    }, JSON.stringify(backup));
    assert.equal(await page.locator('.confirm-dialog--open').count(), 0);
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses())), beforeFile);
    await page.locator('#home-import-btn').click();
    const backupFile = { name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) };
    await page.locator('#home-import-file').setInputFiles(backupFile);
    await page.locator('.confirm-dialog--open .confirm-dialog__cancel').click();
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses())), beforeFile);
    await page.evaluate(() => {
      window.importCalls = 0;
      const original = ExpenseDB.importAll;
      ExpenseDB.importAll = (...args) => { window.importCalls++; return original(...args); };
    });
    await page.locator('#home-import-file').setInputFiles(backupFile);
    await page.locator('.confirm-dialog--open [data-confirm-ok]').click();
    await page.waitForFunction(() => document.querySelector('#home-import-area').style.display === 'none');
    assert.equal(await page.evaluate(() => window.importCalls), 1, '一次确认只能导入一次');
    assert.deepEqual(byId(await page.evaluate(() => ExpenseDB.getExpenses())), byId(backup.expenses));
    assert.deepEqual(errors, []);

    await context.close();

    // 独立新上下文验证真实 SW 预缓存；与上述 UI 用例和用户账本完全隔离。
    const offlineContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const offlinePage = await offlineContext.newPage();
    const offlineErrors = [];
    offlinePage.on('pageerror', error => offlineErrors.push(error.message));
    await offlinePage.goto(url);
    await offlinePage.evaluate(() => navigator.serviceWorker.ready);
    await offlinePage.waitForFunction(() => navigator.serviceWorker.controller !== null);
    // 应用在 controllerchange 后自动刷新；等它完成，避免和手动 reload 竞争。
    await offlinePage.waitForLoadState('networkidle');
    assert.equal(await offlinePage.locator('#sw-update-bar').isVisible(), false, '首次安装不误报更新');
    const offlineId = await offlinePage.evaluate(() => {
      if (!ExpenseDB.saveSettings({ onboardingSeen: true })) throw Error('隔离设置写入失败');
      return ExpenseDB.addExpense({ amount: 0.01, categoryId: 'cat-food', date: ExpenseDB.today(), time: '12:00' }).id;
    });
    await offlineContext.setOffline(true);
    await offlinePage.reload();
    assert.equal(await offlinePage.evaluate(id => ExpenseDB.getExpenses().find(e => e.id === id).amount, offlineId), 0.01);
    for (const view of ['home', 'add', 'list', 'stats']) await offlinePage.locator(`[data-view="${view}"]`).click();
    await offlinePage.locator('#stats-payment-details summary').click();
    await offlinePage.waitForFunction(() => Chart.getChart('stats-payment-chart')?.width > 0);
    await offlinePage.locator('#mr-entry').click();
    assert.match(await offlinePage.locator('.mr-skeleton__cell--total').innerText(), /0\.01/);
    assert.deepEqual(offlineErrors, []);
    await offlineContext.close();
    console.log('SW 首次安装和离线四视图/月报通过，离线账单保持完整');
    console.log('浏览器回归全部通过；截图目录：' + artifacts);
  } finally {
    await browser.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => server.close());
