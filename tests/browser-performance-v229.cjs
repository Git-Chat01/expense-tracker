const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname));
  if (!file.startsWith(root + path.sep)) return res.writeHead(403).end();
  fs.readFile(file, (err, body) => {
    if (err) return res.writeHead(404).end();
    res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' })[path.extname(file)] || 'application/octet-stream');
    res.end(body);
  });
});
async function measure(page, action) {
  return page.evaluate(async action => {
    window.auditLongTasks = [];
    const start = performance.now();
    if (action.view) document.querySelector(`[data-view="${action.view}"]`).click();
    if (action.keyword != null) {
      const input = document.querySelector('#list-search-input');
      input.value = action.keyword;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const handlerMs = performance.now() - start;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const twoFramesMs = performance.now() - start;
    await new Promise(resolve => setTimeout(resolve, 70));
    return {
      action,
      handlerMs: Number(handlerMs.toFixed(1)),
      twoFramesMs: Number(twoFramesMs.toFixed(1)),
      longTasks: window.auditLongTasks.filter(item => item.startTime >= start - 5),
      billDomRows: document.querySelectorAll('#list-content .list-item').length,
      billDomElements: document.querySelectorAll('#list-content *').length,
      pageDomElements: document.querySelectorAll('*').length,
    };
  }, action);
}
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', timezoneId: 'America/New_York', serviceWorkers: 'block' });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.locator('#onboarding-skip').click();
    const fixture = await page.evaluate(() => {
      const data = ExpenseDB.exportAll();
      if (!data) throw Error('初始导出失败');
      const anchor = new Date(ExpenseDB.today() + 'T12:00:00');
      const cats = ['cat-food', 'cat-transport', 'cat-shopping'];
      const notes = ['日常咖啡早餐', '日常午餐通勤', '日常晚餐采购'];
      data.expenses = Array.from({ length: 3000 }, (_, i) => {
        const d = new Date(anchor);
        d.setDate(d.getDate() - Math.floor(i / 3));
        const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        return { id: `audit-perf-${i}`, amount: 10 + i % 100, categoryId: cats[i % 3], date, time: ['08:00', '12:00', '18:00'][i % 3], paymentMethod: 'wechat', necessity: 'need', location: '合成商店', note: notes[i % 3], createdAt: d.toISOString() };
      });
      const start = performance.now();
      const imported = ExpenseDB.importAll(data);
      if (!imported.success) throw Error(JSON.stringify(imported));
      window.auditExpenseSnapshot = JSON.stringify(ExpenseDB.getExpenses());
      Chart.defaults.animation = false;
      window.auditLongTasks = [];
      window.auditObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) window.auditLongTasks.push({ startTime: entry.startTime, durationMs: Number(entry.duration.toFixed(1)), name: entry.name });
      });
      window.auditObserver.observe({ type: 'longtask' });
      return { records: ExpenseDB.getExpenses().length, importMs: Number((performance.now() - start).toFixed(1)), serializedBytes: new Blob([JSON.stringify(data)]).size, latestDate: data.expenses[0].date, earliestDate: data.expenses[2999].date };
    });
    await page.waitForTimeout(100);
    const firstList = await measure(page, { view: 'list' });
    assert.equal(firstList.billDomRows, 100, '首屏仅渲染100笔');
    assert.match(await page.locator('#list-summary-count').innerText(), /3000/);
    const typing = [];
    for (const keyword of ['日', '日常', '日常咖', '日常咖啡']) typing.push(await measure(page, { keyword }));
    assert.ok(typing.every(sample => sample.billDomRows === 100));
    assert.match(await page.locator('#list-summary-count').innerText(), /1000/);
    // 拼音尚在组合时不替换列表；确认汉字后才应用筛选。
    await page.evaluate(() => {
      const input = document.querySelector('#list-search-input');
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      input.value = '不存在的合成商店';
      input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    });
    assert.equal(await page.locator('.list-item').count(), 100);
    await page.locator('#list-search-input').dispatchEvent('compositionend');
    assert.equal(await page.locator('.list-item').count(), 0);
    await page.locator('#list-search-input').fill('');
    await page.locator('.list-load-more__button').click();
    assert.equal(await page.locator('.list-item').count(), 200);
    assert.match(await page.locator('#list-summary-count').innerText(), /3000/);
    assert.equal(await page.evaluate(() => JSON.stringify(ExpenseDB.getExpenses()) === window.auditExpenseSnapshot), true);
    const firstStats = await measure(page, { view: 'stats' });
    const result = {
      environment: { browser: await browser.version(), viewport: '390x844', cpuThrottle: 'none', runs: 1, syntheticRecords: 3000, chartAnimation: 'disabled to measure rendering work', note: '本机桌面 Chromium 手机视口；不是手机硬件或 iPhone 真机性能。各操作测同步事件处理与随后两帧；不含 Playwright 点击等待。' },
      fixture, firstList, typing, firstStats,
    };
    const out = process.env.ARTIFACT_DIR || path.join(root, 'output/verification-v229/performance');
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    await context.close();
  } finally { await browser.close(); server.close(); }
}
main().catch(err => { console.error(err); process.exitCode = 1; server.close(); });
