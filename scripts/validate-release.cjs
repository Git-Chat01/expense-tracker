/* 无第三方依赖的发布门禁：语法、JSON 结构、版本链、资源完整性和全部单元回归。 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

for (const directory of ['js', 'scripts', 'tests']) {
  for (const file of fs.readdirSync(path.join(root, directory))) {
    if (/\.(?:js|cjs)$/.test(file)) new vm.Script(read(`${directory}/${file}`), { filename: `${directory}/${file}` });
  }
}
new vm.Script(read('sw.js'), { filename: 'sw.js' });

const updates = JSON.parse(read('updates.json'));
const manifest = JSON.parse(read('manifest.json'));
assert.ok(manifest.name && manifest.start_url && Array.isArray(manifest.icons), 'manifest 必须有名称、启动地址和图标');
assert.ok(/^\d+$/.test(updates.latest) && Array.isArray(updates.versions));
assert.equal(updates.versions[0].version, updates.latest);
const seen = new Set();
for (const entry of updates.versions) {
  assert.ok(entry.version && entry.title && /^\d{4}-\d{2}-\d{2}$/.test(entry.date));
  assert.ok(Array.isArray(entry.items) && entry.items.length && entry.items.every(item => typeof item === 'string' && item.trim()));
  assert.ok(!seen.has(entry.version), `版本重复：${entry.version}`);
  seen.add(entry.version);
}
const html = read('index.html');
const sw = read('sw.js');
assert.equal(html.match(/id="app-version"[^>]*data-version="(\d+)"/)[1], updates.latest);
assert.ok(html.includes(`v${updates.versions[0].date.replaceAll('-', '')}-${updates.latest}</div>`));
assert.equal(sw.match(/const APP_VERSION = '(\d+)'/)[1], updates.latest);
assert.ok(sw.includes("const CACHE_NAME = 'expense-tracker-v' + APP_VERSION"));
const cached = [...sw.match(/const CORE_PRE_CACHE = \[([\s\S]*?)\];/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
const assets = [...html.matchAll(/(?:src|href)="([^"#]+)"/g)]
  .map(match => match[1].split('?')[0]).filter(value => !/^(https?:|data:)/.test(value));
for (const asset of [...cached, ...assets, ...manifest.icons.map(icon => icon.src.split('?')[0])]) {
  if (asset === './') continue;
  assert.ok(fs.existsSync(path.join(root, asset)), `资源缺失：${asset}`);
}
for (const asset of assets) assert.ok(cached.includes(asset), `页面资源未预缓存：${asset}`);
console.log('语法、JSON、版本链和页面/SW 资源检查通过');

const tests = fs.readdirSync(path.join(root, 'tests')).filter(file => file.endsWith('.test.js')).map(file => `tests/${file}`);
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...tests], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status === null ? 1 : result.status;
