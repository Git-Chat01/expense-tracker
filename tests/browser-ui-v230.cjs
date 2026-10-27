/* v230 体验回归：只在全新本地浏览器上下文中使用合成数据。 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const out = process.env.ARTIFACT_DIR || path.join(root,'output/verification-v230/ui');
fs.mkdirSync(out,{recursive:true});
const server = http.createServer((req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  const target = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!target.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(target, (err, data) => {
    if (err) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(target)] || 'application/octet-stream');
    res.end(data);
  });
});
async function measure(page, selectors) {
  return page.evaluate(selectors => Object.fromEntries(selectors.map(selector => {
    const el = document.querySelector(selector);
    if (!el) return [selector, null];
    const rect = el.getBoundingClientRect(), style = getComputedStyle(el);
    return [selector, { top: rect.top + scrollY, bottom: rect.bottom + scrollY, width: rect.width, height: rect.height, font: style.fontSize, color: style.color, background: style.backgroundColor, position: style.position, text: el.innerText?.slice(0, 120) }];
  })), selectors);
}
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  const results = { sample: '合成账单，Chromium 手机视口，不是 iPhone 真机', sizes: {} };
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'America/New_York', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const NativeDate = Date;
      window.Date = class extends NativeDate { constructor(...args) { super(...(args.length ? args : ['2026-10-27T12:00:00'])); } };
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    results.errors = [];
    page.on('pageerror', error => results.errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.locator('#onboarding-skip').click();
    for (const size of [{ width: 390, height: 844 }, { width: 320, height: 740 }]) {
      await page.setViewportSize(size);
      await page.locator('[data-view="add"]').click();
      await page.waitForTimeout(350);
      results.sizes[size.width] = { freshAdd: await measure(page, ['.add-header', '.add-amount-display', '.add-category-area', '.add-payment-section', '.add-necessity-section', '#add-more-fields', '#add-numpad', '[data-key="0"]', '[data-key="submit"]', '.tab-bar']) };
      await page.screenshot({ path: path.join(out, `add-empty-${size.width}.png`) });
      await page.locator('[data-view="home"]').click();
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => {
      const backup = ExpenseDB.exportAll();
      const cats = ['cat-food', 'cat-transport', 'cat-shopping', 'cat-entertain'];
      const labels = ['午餐', '通勤', '日用品', '电影'];
      backup.expenses = Array.from({ length: 96 }, (_, i) => {
        const d = new Date('2026-10-27T12:00:00');
        d.setDate(d.getDate() - Math.floor(i / 3));
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return { id: 'ui-review-' + i, amount: [32, 8.5, 76, 45][i % 4], date, time: ['12:00', '09:10', '18:30'][i % 3], categoryId: cats[i % 4], note: labels[i % 4], location: '示例地点' + (i % 24 + 1), paymentMethod: ['wechat', 'alipay', 'bankcard', 'cash'][i % 4], necessity: ['need', 'need', 'want', 'want'][i % 4] };
      });
      backup.budget = { monthlyTotal: 4000, categories: {} };
      const r = ExpenseDB.importAll(backup); if (!r.success) throw Error(JSON.stringify(r));
      window.uiReviewSnapshot = JSON.stringify(ExpenseDB.getExpenses());
      Chart.defaults.animation = false;
    });
    for (const width of [320, 390, 430, 1280]) {
      await page.setViewportSize({ width, height: 844 });
      for (const view of ['home', 'add', 'list', 'stats']) {
        await page.locator(`[data-view="${view}"]`).click();
        await page.waitForTimeout(250);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, view + ' 横向溢出');
        await page.screenshot({ path: path.join(out, `${view}-${width}.png`) });
        if (view === 'home' && width === 390) {
          results.home = await measure(page, ['.home-summary', '#home-budget-summary', '#home-recent', '.tab-bar']);
          const second = await page.locator('.home-recent__item').nth(1).boundingBox();
          const nav = await page.locator('.tab-bar').boundingBox();
          assert.ok(second.y + second.height <= nav.y, '首页首屏可完整查看至少两笔最近记录');
        }
        if (view === 'add') {
          const initial = (await measure(page, ['#add-numpad']))['#add-numpad'].top;
          await page.locator('[data-pm="wechat"]').click();
          const payment = (await measure(page, ['#add-numpad']))['#add-numpad'].top;
          await page.locator('[data-necessity="need"]').click();
          const necessity = (await measure(page, ['#add-numpad']))['#add-numpad'].top;
          assert.ok(Math.abs(payment - initial) < 1 && Math.abs(necessity - initial) < 1, '选择不改变键盘位置');
          assert.equal(await page.locator('[data-pm="wechat"]').evaluate(el => getComputedStyle(el).height), '38px');
          results.sizes[width] = { ...results.sizes[width], keypad: { initial, payment, necessity } };
          await page.locator('[data-pm="wechat"]').click();
          await page.locator('[data-necessity="need"]').click();
        }
        if (view === 'list') {
          const summary = await page.locator('#list-summary').boundingBox();
          const first = await page.locator('.list-item').first().boundingBox();
          assert.ok(summary.y < first.y && summary.y < 400, '汇总在首条记录之前');
        }
      }
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-view="list"]').click();
    const allCount = await page.locator('.list-item').count();
    await page.locator('[data-filter="payment"]').click();
    for (const value of ['wechat','alipay']) await page.locator(`[data-val="${value}"]`).click();
    assert.equal(await page.evaluate(() => ExpenseList.hasPendingFilters()), true);
    assert.equal(await page.locator('#list-filter-overlay').count(), 1);
    assert.equal(await page.locator('.list-item').count(), allCount, '未应用时列表不变化');
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => ExpenseList.hasPendingFilters()), false);
    assert.equal(await page.locator('.list-item').count(), allCount);
    assert.equal(await page.locator('[data-filter="payment"]').evaluate(el => document.activeElement === el), true);
    await page.locator('[data-filter="payment"]').click();
    assert.equal(await page.locator('#list-filter-overlay [aria-pressed="true"]').count(), 0, '取消不带入下次');
    for (const value of ['wechat','alipay']) await page.locator(`[data-val="${value}"]`).click();
    await page.locator('.list-filter-panel__apply').click();
    assert.equal(await page.locator('.list-item').count(), 48);
    for (const chip of await page.locator('.filter-chip__remove').all()) {
      assert.ok((await chip.boundingBox()).height >= 44);
    }
    await page.locator('[data-filter="payment"]').click();
    await page.waitForTimeout(250);
    const filterLayout = await page.evaluate(() => {
      const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { top:r.top,bottom:r.bottom,height:r.height }; };
      const overlay = document.querySelector('#list-filter-overlay').getBoundingClientRect();
      return { overlay:rect('#list-filter-overlay'), panel:rect('.list-filter-panel'), footer:rect('.list-filter-panel__footer'), left:overlay.left, right:overlay.right, width:innerWidth };
    });
    assert.equal(filterLayout.left,0); assert.equal(filterLayout.right,filterLayout.width);
    await page.screenshot({ path:path.join(out,'filter-reopen.png') });
    await page.locator('.list-filter-panel__reset').click();
    await page.locator('.list-filter-panel__cancel').click();
    assert.equal(await page.locator('.list-item').count(), 48, '重置后取消不改已应用条件');
    await page.locator('#list-clear-all').click();
    await page.locator('[data-filter="location"]').click();
    await page.evaluate(() => {
      Object.defineProperty(visualViewport,'height',{ configurable:true,value:420 });
      visualViewport.dispatchEvent(new Event('resize'));
    });
    const applyRect = await page.locator('.list-filter-panel__apply').boundingBox();
    assert.ok(applyRect.y + applyRect.height <= 420, '搜索键盘缩短视口时仍可应用');
    await page.evaluate(() => { delete visualViewport.height; visualViewport.dispatchEvent(new Event('resize')); });
    assert.equal(await page.locator('#list-filter-overlay [data-val]').count(), 24, '全部地点都可选择');
    await page.locator('#list-filter-location-search').fill('示例地点24');
    assert.equal(await page.locator('#list-filter-overlay [data-val]:visible').count(), 1);
    await page.locator('[data-val="示例地点24"]').click();
    await page.locator('#list-filter-location-search').fill('');
    assert.equal(await page.locator('[data-val="示例地点24"]').getAttribute('aria-pressed'), 'true');
    await page.locator('.list-filter-panel__apply').click();
    assert.equal(await page.locator('.list-item').count(), 4);
    await page.locator('#list-clear-all').click();
    await page.evaluate(() => window.scrollTo(0, 1600));
    await page.waitForTimeout(200);
    const topButton = await page.locator('#list-back-top').boundingBox();
    const bottomNav = await page.locator('.tab-bar').boundingBox();
    assert.ok(topButton && topButton.y + topButton.height <= bottomNav.y - 20);
    await page.locator('#list-back-top').click();
    await page.waitForFunction(() => scrollY === 0);
    for (const [value, text] of [['amount-desc','金额↓'],['amount-asc','金额↑'],['date-asc','日期↑'],['date-desc','日期↓']]) {
      await page.locator('[data-filter="sort"]').click();
      assert.equal(await page.locator('[data-sort]').count(), 4);
      await page.locator(`[data-sort="${value}"]`).click();
      assert.equal(await page.locator('[data-filter="sort"]').innerText(), text);
    }
    await page.locator('[data-filter="date"]').click();
    const date = await page.locator('.list-dropdown__date-from').evaluate(el => ({ font: getComputedStyle(el).fontSize, height: el.getBoundingClientRect().height }));
    assert.equal(date.font,'16px'); assert.ok(date.height >= 44);
    await page.screenshot({ path: path.join(out,'date-filter-390.png') });
    await page.locator('.list-filter-panel__cancel').click();
    await page.locator('#list-search-input').fill('示例地点24');
    await page.locator('[data-view="stats"]').click();
    await page.locator('#stats-month-prev').click();
    assert.equal(await page.locator('#stats-month-input').inputValue(), '2026-09');
    assert.match(await page.locator('#stats-range-label').innerText(), /2026\/09\/01.*2026\/09\/30.*完整月份/);
    const expectedSeptember = await page.evaluate(() => ExpenseSummary.money(ExpenseSummary.sumCents(ExpenseDB.getExpenses().filter(e => e.date.startsWith('2026-09')))));
    assert.equal(await page.locator('#stats-card-total').innerText(),'¥'+expectedSeptember);
    await page.locator('#stats-month-next').click();
    assert.equal(await page.locator('#stats-month-next').isDisabled(), true);
    await page.locator('#stats-month-input').fill('2026-08');
    assert.equal(await page.locator('.stats-empty').count(), 1);
    await page.locator('[data-period="month"]').click();
    const category = page.locator('[data-stats-category]').first();
    await category.scrollIntoViewIfNeeded();
    const source = await category.getAttribute('data-stats-category');
    const amount = await category.locator('.stats-chart-legend__amount').innerText();
    const before = await page.evaluate(() => scrollY);
    await category.click();
    assert.equal(await page.locator('#list-context-back').isVisible(), true);
    assert.equal(await page.locator('#list-search-input').inputValue(), '');
    assert.equal(await page.locator('#list-summary-total').innerText(), amount);
    await page.locator('#list-context-back').click();
    await page.waitForTimeout(300);
    assert.ok(Math.abs(await page.evaluate(() => scrollY) - before) < 2);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.statsCategory), source);
    await page.locator('[data-view="list"]').click();
    assert.equal(await page.locator('#list-search-input').inputValue(), '示例地点24');
    assert.equal(await page.locator('.list-item').count(), 4);
    await page.locator('[data-view="stats"]').click();
    await page.evaluate(() => { window.Chart = undefined; ExpenseStats.render(); });
    assert.ok(await page.locator('[data-stats-category]').count() > 0, '图表不可用时分类入口仍可用');
    await page.locator('[data-stats-category]').first().click();
    assert.equal(await page.locator('#list-context-back').isVisible(), true);
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses()) === window.uiReviewSnapshot), true);
    assert.deepEqual(results.errors, []);
    results.flows = { filterDraft: true, allLocations: 24, sorting: 4, historicalMonth: true, drilldown: true, returnScrollFocus: true, fallback: true, ledgerUnchanged: true };
    fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify({ home:results.home, keypad:Object.fromEntries(Object.entries(results.sizes).map(([width,value])=>[width,value.keypad])), flows:results.flows },null,2));
    await context.close();
  } finally { await browser.close(); server.close(); }
})().catch(error => { console.error(error); server.close(); process.exitCode = 1; });
