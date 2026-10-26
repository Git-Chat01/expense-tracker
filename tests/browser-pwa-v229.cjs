/* 隔离 SW 生命周期验收。页面夹具只模拟草稿接口，不读写真实账本。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = path.resolve(__dirname, '..');
const script = process.argv.includes('--old') ? 'js/update-flow-v216.js' : 'js/update-flow-v229.js';
const out = process.env.ARTIFACT_DIR || path.join(root, 'output', 'verification-v229', 'pwa');
fs.mkdirSync(out, { recursive: true });
let workerVersion = '229';
let pageVersion = '229';
let notesVersion = '229';
let releaseInstall;
const gate = new Promise(resolve => { releaseInstall = resolve; });
const html = () => `<!doctype html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>
body{margin:0;font:16px sans-serif}#view-home{padding:16px 16px 90px}#spacer{height:1100px}.tab-bar{position:fixed;bottom:0;height:60px;background:#eee;width:100%}#sw-update-bar{padding:16px;background:#dff}button{padding:12px}#sw-update-bar-head{display:block;width:100%}#sw-update-bar-detail{padding-top:12px}[hidden]{display:none!important}
</style></head><body><main id="view-home"><label for="draft">尚未保存的输入</label><input id="draft"><div id="spacer"></div><div id="app-version" data-version="${pageVersion}">v${pageVersion}</div><div id="sw-update-bar" hidden><button id="sw-update-bar-head" aria-expanded="false"><strong id="sw-update-bar-title"></strong><span class="sw-update-bar__sub"></span></button><div id="sw-update-bar-detail" hidden><ul id="sw-update-bar-list"></ul><button id="sw-update-btn-later">继续使用当前版本</button><button id="sw-update-btn-now">立即更新</button></div></div></main><nav class="tab-bar">主导航</nav><script src="/fixture-app.js"></script><script src="/update.js"></script></body></html>`;
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Cache-Control', 'no-store');
  if (pathname === '/' || pathname === '/index.html') { res.setHeader('Content-Type', 'text/html'); return res.end(html()); }
  if (pathname === '/fixture-app.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end("window.ExpenseApp={hasUnsavedDraft:function(){return Boolean(document.getElementById('draft').value)}};navigator.serviceWorker.register('/sw.js');"); }
  if (pathname === '/updates.json') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ latest: notesVersion, versions: [{ version: notesVersion, items: ['合成说明 v' + notesVersion] }] })); }
  if (pathname === '/install-gate') { if (workerVersion === '229') await gate; return res.end('synthetic'); }
  if (pathname === '/update.js') { res.setHeader('Content-Type', 'text/javascript'); return res.end(fs.readFileSync(path.join(root, script))); }
  if (pathname === '/sw.js') {
    const source = fs.readFileSync(path.join(root, 'sw.js'), 'utf8')
      .replace(/const APP_VERSION = '\d+';/, `const APP_VERSION = '${workerVersion}';`)
      .replace(/const CORE_PRE_CACHE = \[[\s\S]*?\];/, "const CORE_PRE_CACHE = ['/', '/index.html', '/fixture-app.js', '/update.js', '/updates.json', '/install-gate'];");
    res.setHeader('Content-Type', 'text/javascript'); return res.end(source);
  }
  res.writeHead(404).end();
});

async function ready(page) {
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
  await page.waitForLoadState('networkidle');
}
async function installUpdate(page, version) {
  workerVersion = version;
  await page.evaluate(async () => { const reg = await navigator.serviceWorker.ready; await reg.update(); });
  await page.waitForFunction(async () => Boolean((await navigator.serviceWorker.ready).waiting));
  await page.waitForFunction(version => !document.querySelector('#sw-update-bar').hidden && document.querySelector('.sw-update-bar__sub').textContent.includes('v' + version), version);
}
async function openDetails(page) {
  if (!(await page.locator('#sw-update-bar-detail').isVisible())) await page.locator('#sw-update-bar-head').click();
  await page.waitForTimeout(400);
}

(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_EXECUTABLE || undefined });
  const results = {};
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const a = await context.newPage();
    const errors = [];
    a.on('pageerror', error => errors.push(error.message));
    await a.goto(url);
    await a.locator('#draft').fill('35');
    let reloadsA = 0;
    a.on('framenavigated', frame => { if (frame === a.mainFrame()) reloadsA++; });
    releaseInstall();
    await ready(a);
    assert.equal(await a.locator('#draft').inputValue(), '35', '首次接管必须保留输入');
    assert.equal(reloadsA, 0, '首次接管不刷新');
    assert.equal(await a.locator('#sw-update-bar').isVisible(), false, '首次安装不误报更新完成');
    results.firstInstall = { draft: '35', reloads: reloadsA };
    await a.locator('#draft').fill('');
    const b = await context.newPage();
    b.on('pageerror', error => errors.push(error.message));
    await b.goto(url);
    await b.locator('#draft').fill('35');
    let reloadsB = 0;
    b.on('framenavigated', frame => { if (frame === b.mainFrame()) reloadsB++; });
    await b.evaluate(async () => { const cache = await caches.open('unrelated-feature-cache'); await cache.put('/sentinel', new Response('synthetic')); });
    await installUpdate(a, '230'); // updates.json 故意仍为229。
    await openDetails(a);
    assert.match(await a.locator('.sw-update-bar__sub').innerText(), /v230/);
    assert.doesNotMatch(await a.locator('#sw-update-bar-list').innerText(), /合成说明 v229/);
    await a.waitForFunction(() => document.querySelector('#sw-update-bar').getBoundingClientRect().bottom <= document.querySelector('.tab-bar').getBoundingClientRect().top);
    const cardPosition = await a.evaluate(() => ({ bottom: document.querySelector('#sw-update-bar').getBoundingClientRect().bottom, navTop: document.querySelector('.tab-bar').getBoundingClientRect().top }));
    assert.ok(cardPosition.bottom <= cardPosition.navTop, '更新按钮应在底栏上方');
    await a.locator('#sw-update-btn-later').click();
    assert.equal(await a.locator('#sw-update-bar-detail').isVisible(), false);
    await openDetails(a);
    pageVersion = '230';
    await a.locator('#sw-update-btn-now').click();
    await a.waitForFunction(() => document.querySelector('#app-version').dataset.version === '230');
    await ready(a);
    await b.waitForFunction(() => document.querySelector('#sw-update-bar').dataset.mode === 'reload');
    assert.equal(reloadsA, 1);
    assert.equal(await a.evaluate(() => scrollY), 0, '主动更新重载后回到顶部');
    assert.equal(await b.locator('#draft').inputValue(), '35');
    assert.equal(reloadsB, 0, '别的标签确认更新不重载当前页');
    assert.ok((await b.evaluate(() => caches.keys())).includes('unrelated-feature-cache'));
    await openDetails(b);
    await b.locator('#sw-update-btn-now').click();
    assert.equal(reloadsB, 0, '有草稿时本页也不得直接重载');
    assert.match(await b.locator('.sw-update-bar__sub').innerText(), /保存|未完成/);
    await b.locator('#draft').fill('');
    await b.locator('#sw-update-btn-now').click();
    await b.waitForFunction(() => document.querySelector('#app-version').dataset.version === '230');
    await ready(b);
    results.multiTab = { otherDraftRetained: true, reloadsBeforeHandlingDraft: 0, reloadsAfterHandlingDraft: reloadsB, unrelatedCacheRetained: true, waitingVersion: '230', staleChangelogNotUsed: true };
    await installUpdate(a, '231');
    await b.close();
    await a.close();
    pageVersion = '231';
    notesVersion = '231';
    await new Promise(resolve => setTimeout(resolve, 400));
    const c = await context.newPage();
    c.on('pageerror', error => errors.push(error.message));
    await c.goto(url);
    await ready(c);
    await c.waitForFunction(() => document.querySelector('#sw-update-bar').dataset.mode === 'applied');
    await openDetails(c);
    assert.match(await c.locator('#sw-update-bar-title').innerText(), /v231/);
    assert.equal(await c.locator('#sw-update-btn-later').isVisible(), false);
    await c.locator('#sw-update-btn-now').click();
    await c.waitForFunction(() => document.querySelector('#sw-update-bar').hidden);
    await c.reload();
    await ready(c);
    assert.equal(await c.locator('#sw-update-bar').isVisible(), false, '知道了应可靠记住且不重复出现');
    results.automaticActivation = { acknowledgedVersion: '231', reappearedAfterReload: false };
    // 同一局部对齐逻辑还必须适用于受限高度的首页内部滚动。
    const internal = await context.newPage();
    internal.on('pageerror', error => errors.push(error.message));
    await internal.goto(url);
    await ready(internal);
    await internal.addStyleTag({ content: 'html,body{height:100%;overflow:hidden}#view-home{height:100vh;overflow:auto;box-sizing:border-box}' });
    await installUpdate(internal, '232');
    await openDetails(internal);
    await internal.waitForFunction(() => document.querySelector('#sw-update-bar').getBoundingClientRect().bottom <= document.querySelector('.tab-bar').getBoundingClientRect().top);
    assert.ok(await internal.evaluate(() => document.querySelector('#view-home').scrollTop > 0));
    await internal.screenshot({ path: path.join(out, 'internal-scroll.png') });
    await internal.locator('#sw-update-btn-later').click();
    assert.equal(await internal.locator('#sw-update-bar-detail').isVisible(), false);
    await openDetails(internal);
    pageVersion = '232';
    await internal.locator('#sw-update-btn-now').click();
    await internal.waitForFunction(() => document.querySelector('#app-version').dataset.version === '232');
    assert.deepEqual(await internal.evaluate(() => [scrollY, document.querySelector('#view-home').scrollTop]), [0, 0]);
    results.internalScroll = { controlsAboveNav: true, reloadAtTop: true };
    assert.deepEqual(errors, []);
    results.pageErrors = errors;
    fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
    await c.screenshot({ path: path.join(out, 'completed.png') });
    console.log(JSON.stringify(results, null, 2));
    await context.close();
  } finally {
    releaseInstall();
    await browser.close();
    await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; server.close(); });
