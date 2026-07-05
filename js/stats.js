/* ================================================================
   消费轨迹系统 — stats.js
   ExpenseStats 命名空间：统计分析
   基础版 5 维度：概览 / 分类占比 / 月度趋势 / 地点排行 / 支付分布
   使用 Chart.js 渲染环形图+折线图，加载失败时降级为纯 CSS 柱状图
   ================================================================ */

const ExpenseStats = (() => {
  'use strict';

  /* -----------------------------------------------------------------
     状态
     ----------------------------------------------------------------- */
  let _period = 'month'; // 'month' | '3month' | '12month'

  // Chart.js 实例引用（用于销毁重绘）
  let _charts = {};

  // 环形图点击高亮：记录每个图表当前选中的扇区索引
  const _selectedArc = {}; // { canvasId: index | null }

  // 环形图扇区元数据（用于点击后在圆环中心显示详情）
  const _segmentMeta = {}; // { canvasId: [{ name, amount, pct, color, isHighest }, ...] }

  // 当前时段的汇总对比数据（用于环形图中心总支出显示）
  let _periodSummary = null; // { currentTotal, prevTotal, changePct, label, compareLabel }

  // 调色板
  const COLORS = [
    '#5470C6', '#91CC75', '#FAC858', '#EE6666', '#73C0DE',
    '#FC8452', '#9A60B4', '#EA7CCC', '#48B3A3', '#DD6B55',
  ];

  /* -----------------------------------------------------------------
     时段范围计算
     ----------------------------------------------------------------- */
  function _getPeriodRange() {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth() + 1;
    const d = today.getDate();
    const todayStr = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

    let from;
    if (_period === 'month') {
      from = `${y}-${String(m).padStart(2, '0')}-01`;
    } else if (_period === '3month') {
      // 近 3 个月：当前月 + 往前 2 个月 = 3 个完整月份
      // m 是 1-indexed（7=七月），new Date(y, m-3, 1) = 三个月前的 1 号
      const pm = new Date(y, m - 3, 1);
      from = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}-01`;
    } else {
      // 近 12 个月：当前月 + 往前 11 个月 = 12 个完整月份
      const pm = new Date(y, m - 12, 1);
      from = `${pm.getFullYear()}-${String(pm.getMonth() + 1).padStart(2, '0')}-01`;
    }
    return { from, to: todayStr };
  }

  function _periodLabel() {
    return { month: '本月', '3month': '近 3 个月', '12month': '近 12 个月' }[_period] || '本月';
  }

  /** 日期 → "YYYY-MM-DD" 字符串 */
  function _ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 计算当前时段与上一时段的支出对比 */
  function _calcPeriodSummary(currentExpenses, currentFrom, currentTo) {
    const currentTotal = currentExpenses.reduce((sum, e) => sum + e.amount, 0);
    const [fy, fm] = currentFrom.split('-').map(Number);
    let prevFrom, prevTo;

    if (_period === 'month') {
      // 上个月：1号 ~ 月末
      const prevLast = new Date(fy, fm - 1, 0);
      prevTo = _ymd(prevLast);
      prevFrom = `${prevLast.getFullYear()}-${String(prevLast.getMonth() + 1).padStart(2, '0')}-01`;
    } else if (_period === '3month') {
      // 上一个 3 个月周期
      const prevLast = new Date(fy, fm - 1, 0);
      prevTo = _ymd(prevLast);
      const prevFirst = new Date(prevLast.getFullYear(), prevLast.getMonth() - 2, 1);
      prevFrom = _ymd(prevFirst);
    } else {
      // 上一个 12 个月周期
      const prevLast = new Date(fy, fm - 1, 0);
      prevTo = _ymd(prevLast);
      const prevFirst = new Date(prevLast.getFullYear() - 1, prevLast.getMonth() + 1, 1);
      prevFrom = _ymd(prevFirst);
    }

    const prevExpenses = ExpenseDB.getExpensesByDateRange(prevFrom, prevTo);
    const prevTotal = prevExpenses.reduce((sum, e) => sum + e.amount, 0);
    let changePct;
    if (prevTotal > 0) {
      changePct = Math.round((currentTotal - prevTotal) / prevTotal * 100);
    } else {
      changePct = currentTotal > 0 ? 100 : 0;
    }

    return {
      currentTotal: Math.round(currentTotal),
      prevTotal: Math.round(prevTotal),
      changePct,
      label: _periodLabel(),
      compareLabel: { month: '上月', '3month': '上季度', '12month': '上年' }[_period],
    };
  }

  /* -----------------------------------------------------------------
     渲染入口
     ----------------------------------------------------------------- */
  function render() {
    // 先销毁所有旧图表（因为 canvas 可能被 innerHTML 替换后失效）
    _destroyAllCharts();

    const { from, to } = _getPeriodRange();
    const expenses = ExpenseDB.getExpensesByDateRange(from, to);

    // 始终更新概览卡片
    _renderOverview(expenses, from, to);

    // 计算时段对比（供环形图中心总支出显示）
    _periodSummary = _calcPeriodSummary(expenses, from, to);

    // 无数据时显示空状态（仅替换动态区域，保留时段选择器和概览卡片）
    if (expenses.length === 0) {
      _renderEmptyDynamic();
      return;
    }

    // 确保动态区域结构存在（如果之前被空状态替换了，需要重建）
    _ensureDynamicStructure();

    _renderCategoryChart(expenses);
    _renderTrendChart(from, to);
    _renderLocationRanking(expenses);
    _renderPaymentChart(expenses);
  }

  /* -----------------------------------------------------------------
     确保 #stats-dynamic 内包含所有图表区域的 DOM 结构
     （当从空状态恢复时，需要重建）
     ----------------------------------------------------------------- */
  function _ensureDynamicStructure() {
    let dyn = document.getElementById('stats-dynamic');
    if (!dyn) return;

    // 结构和包裹层都齐全才跳过重建（旧版 DOM 缺 .stats-chart-canvas-wrap，必须重建）
    if (document.getElementById('stats-category-chart') && document.querySelector('.stats-chart-canvas-wrap')) return;

    // 重建完整的图表区域结构
    dyn.innerHTML = `
      <section class="stats-chart-section">
        <h2 class="stats-chart-section__title">分类占比</h2>
        <div class="stats-chart-wrapper">
          <div class="stats-chart-canvas-wrap">
            <canvas id="stats-category-chart"></canvas>
          </div>
          <div id="stats-category-fallback" class="stats-fallback" style="display:none"></div>
        </div>
      </section>
      <section class="stats-chart-section">
        <h2 class="stats-chart-section__title">月度趋势</h2>
        <div class="stats-chart-wrapper">
          <canvas id="stats-trend-chart"></canvas>
          <div id="stats-trend-fallback" class="stats-fallback" style="display:none"></div>
        </div>
      </section>
      <section class="stats-chart-section">
        <h2 class="stats-chart-section__title">地点排行</h2>
        <div class="stats-ranking-list" id="stats-location-list"></div>
      </section>
      <section class="stats-chart-section">
        <h2 class="stats-chart-section__title">支付方式</h2>
        <div class="stats-chart-wrapper">
          <div class="stats-chart-canvas-wrap">
            <canvas id="stats-payment-chart"></canvas>
          </div>
          <div id="stats-payment-fallback" class="stats-fallback" style="display:none"></div>
        </div>
      </section>`;
  }

  /* -----------------------------------------------------------------
     空状态 — 只替换 #stats-dynamic，不影响时段选择器和概览卡片
     ----------------------------------------------------------------- */
  function _renderEmptyDynamic() {
    const dyn = document.getElementById('stats-dynamic');
    if (!dyn) return;
    dyn.innerHTML = `
      <div class="stats-empty">
        <div class="stats-empty__icon">📊</div>
        <p class="stats-empty__text">${_periodLabel()}暂无消费数据</p>
        <p class="stats-empty__hint">去「记账」Tab 记录第一笔吧</p>
      </div>`;
  }

  /* -----------------------------------------------------------------
     切换时段
     ----------------------------------------------------------------- */
  function setPeriod(p) {
    _period = p;
    document.querySelectorAll('.stats-period .chip').forEach(c => {
      c.classList.toggle('chip--active', c.dataset.period === p);
    });
    render();
  }

  function initPeriodSelector() {
    document.querySelectorAll('.stats-period .chip').forEach(chip => {
      chip.addEventListener('click', () => setPeriod(chip.dataset.period));
    });
  }

  /* -----------------------------------------------------------------
     1. 概览卡片
     ----------------------------------------------------------------- */
  function _renderOverview(expenses, from, to) {
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    const count = expenses.length;

    // 日均：按日期范围的天数计算
    // 手动解析日期避免跨浏览器时区差异
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const fromDate = new Date(fy, fm - 1, fd);
    const toDate = new Date(ty, tm - 1, td);
    const days = Math.max(1, Math.ceil((toDate - fromDate) / 86400000) + 1);
    const dailyAvg = total / days;

    const elTotal = document.getElementById('stats-card-total');
    const elDaily = document.getElementById('stats-card-daily');
    const elCount = document.getElementById('stats-card-count');
    if (elTotal) elTotal.textContent = `¥${total.toFixed(0)}`;
    if (elDaily) elDaily.textContent = `¥${dailyAvg.toFixed(0)}`;
    if (elCount) elCount.textContent = count;
  }

  /* -----------------------------------------------------------------
     2. 分类占比（环形图）
     ----------------------------------------------------------------- */
  function _renderCategoryChart(expenses) {
    // 按一级分类聚合
    const catMap = new Map();
    expenses.forEach(e => {
      let cat = ExpenseDB.getCategory(e.categoryId);
      // 找到一级分类（父级或自己）
      let parentId;
      if (cat && cat.parentId) {
        parentId = cat.parentId;
      } else if (cat) {
        parentId = cat.id;
      } else {
        parentId = 'unknown';
      }
      const parentCat = parentId !== 'unknown' ? ExpenseDB.getCategory(parentId) : null;
      const name = parentCat ? parentCat.name : '未分类';
      const icon = parentCat ? parentCat.icon : '📌';

      if (!catMap.has(parentId)) catMap.set(parentId, { name, icon, total: 0 });
      catMap.get(parentId).total += e.amount;
    });

    // 排序，top 8，其余合并为"其他"
    const sorted = Array.from(catMap.values()).sort((a, b) => b.total - a.total);
    const top8 = sorted.slice(0, 8);
    let otherTotal = 0;
    sorted.slice(8).forEach(c => { otherTotal += c.total; });
    if (otherTotal > 0) top8.push({ name: '其他', icon: '📦', total: otherTotal });

    const labels = top8.map(c => `${c.icon} ${c.name}`);
    const data = top8.map(c => Math.round(c.total * 100) / 100);

    // 构建扇区元数据（用于点击后在环形图中心显示详情）
    const total = data.reduce((s, v) => s + v, 0);
    const maxTotal = top8.length > 0 ? Math.max(...top8.map(c => c.total)) : 0;
    const meta = top8.map((c, i) => ({
      name: c.name,
      amount: Math.round(c.total),
      pct: total > 0 ? Math.round(c.total / total * 100) : 0,
      color: COLORS[i % COLORS.length],
      isHighest: c.total === maxTotal && c.total > 0,
    }));

    _drawOrFallback('stats-category-chart', 'stats-category-fallback', labels, data, 'doughnut', meta);
  }

  /* -----------------------------------------------------------------
     3. 月度趋势（折线图）
     ----------------------------------------------------------------- */
  function _renderTrendChart(from, to) {
    const monthMap = new Map();
    // 手动解析日期避免跨浏览器时区差异
    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const fromDate = new Date(fy, fm - 1, fd);
    const toDate = new Date(ty, tm - 1, td);

    // 生成所有月份 key
    const months = [];
    const cursor = new Date(fromDate.getFullYear(), fromDate.getMonth(), 1);
    while (cursor <= toDate) {
      const key = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, '0')}`;
      months.push(key);
      monthMap.set(key, 0);
      cursor.setMonth(cursor.getMonth() + 1);
    }

    // 聚合所有记录（不只是筛选范围内的，因为趋势图需要展示完整月份）
    const allExpenses = ExpenseDB.getExpenses();
    allExpenses.forEach(e => {
      const key = e.date.substring(0, 7); // YYYY-MM
      if (monthMap.has(key)) {
        monthMap.set(key, monthMap.get(key) + e.amount);
      }
    });

    const labels = months.map(m => {
      const mo = parseInt(m.split('-')[1]);
      return `${mo}月`;
    });
    const data = months.map(m => Math.round(monthMap.get(m) * 100) / 100);

    _drawOrFallback('stats-trend-chart', 'stats-trend-fallback', labels, data, 'line');
  }

  /* -----------------------------------------------------------------
     4. 地点排行（纯 CSS 横向进度条）
     ----------------------------------------------------------------- */
  function _renderLocationRanking(expenses) {
    const container = document.getElementById('stats-location-list');
    if (!container) return;

    // 按地点聚合
    const locMap = new Map();
    expenses.forEach(e => {
      const loc = e.location || '未标记地点';
      if (!locMap.has(loc)) locMap.set(loc, 0);
      locMap.set(loc, locMap.get(loc) + e.amount);
    });

    const sorted = Array.from(locMap.entries())
      .map(([name, total]) => ({ name, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 10);

    if (sorted.length === 0) {
      container.innerHTML = '<div style="text-align:center;padding:16px;color:var(--color-text-tertiary);font-size:var(--font-size-sm)">暂无地点数据</div>';
      return;
    }

    const maxAmount = sorted[0].total;
    const medals = ['🥇', '🥈', '🥉'];

    container.innerHTML = sorted.map((item, i) => {
      const pct = Math.round((item.total / maxAmount) * 100);
      const rankDisplay = i < 3 ? medals[i] : (i + 1);
      return `
        <div class="stats-ranking-item">
          <div class="stats-ranking-item__rank">${rankDisplay}</div>
          <div class="stats-ranking-item__body">
            <div class="stats-ranking-item__header">
              <span class="stats-ranking-item__name">${item.name}</span>
              <span class="stats-ranking-item__amount">¥${item.total.toFixed(0)}</span>
            </div>
            <div class="stats-ranking-item__bar-track">
              <div class="stats-ranking-item__bar-fill" style="width:${pct}%"></div>
            </div>
          </div>
        </div>`;
    }).join('');
  }

  /* -----------------------------------------------------------------
     5. 支付方式分布（环形图）
     ----------------------------------------------------------------- */
  function _renderPaymentChart(expenses) {
    const pmMap = new Map();
    expenses.forEach(e => {
      const pm = e.paymentMethod || '未填';
      if (!pmMap.has(pm)) pmMap.set(pm, 0);
      pmMap.set(pm, pmMap.get(pm) + e.amount);
    });

    const sorted = Array.from(pmMap.entries())
      .map(([key, total]) => {
        const info = ExpenseData.PAYMENT_METHODS.find(p => p.value === key);
        return { name: info ? info.label : '未填', total };
      })
      .sort((a, b) => b.total - a.total);

    const labels = sorted.map(c => c.name);
    const data = sorted.map(c => Math.round(c.total * 100) / 100);

    // 构建扇区元数据（用于点击后在环形图中心显示详情）
    const total = data.reduce((s, v) => s + v, 0);
    const maxTotal = sorted.length > 0 ? Math.max(...sorted.map(c => c.total)) : 0;
    const meta = sorted.map((c, i) => ({
      name: c.name,
      amount: Math.round(c.total),
      pct: total > 0 ? Math.round(c.total / total * 100) : 0,
      color: COLORS[i % COLORS.length],
      isHighest: c.total === maxTotal && c.total > 0,
    }));

    _drawOrFallback('stats-payment-chart', 'stats-payment-fallback', labels, data, 'doughnut', meta);
  }

  /* -----------------------------------------------------------------
     图表绘制（Chart.js 优先，失败时 CSS 降级）
     ----------------------------------------------------------------- */
  function _destroyAllCharts() {
    Object.keys(_charts).forEach(key => {
      if (_charts[key]) {
        try { _charts[key].destroy(); } catch (e) { /* ignore */ }
        _charts[key] = null;
      }
    });
    _charts = {};
    // 清空环形图选中状态和元数据
    Object.keys(_selectedArc).forEach(k => { _selectedArc[k] = null; });
    Object.keys(_segmentMeta).forEach(k => { delete _segmentMeta[k]; });
    // 移除所有中心浮层
    document.querySelectorAll('.stats-chart-center').forEach(function(el) { el.remove(); });
    // 同时清理 HTML 手绘图例
    document.querySelectorAll('.stats-chart-legend').forEach(function(el) { el.remove(); });
  }

  /** 环形图点击：选中/取消选中扇区，同时保持 tooltip 显示 */
  function _handleArcClick(canvasId, elements, dataLen) {
    const chart = _charts[canvasId];
    if (!chart) return;

    if (elements.length > 0) {
      const idx = elements[0].index;
      _selectedArc[canvasId] = (_selectedArc[canvasId] === idx) ? null : idx;
    } else {
      _selectedArc[canvasId] = null;
    }

    // 点击后保持 tooltip 显示（选中扇区），或隐藏（取消选中）
    const selIdx = _selectedArc[canvasId];
    if (selIdx !== null && selIdx !== undefined) {
      chart.setActiveElements([{ datasetIndex: 0, index: selIdx }]);
      // 不依赖 Chart.js 事件链触发 external 回调（update 不会触发 afterEvent），
      // 而是直接手动构建并显示 tooltip，确保定位使用当前 chart 的 canvas
      _showTooltipManually(canvasId, chart, selIdx);
    } else {
      chart.setActiveElements([]);
      var tip = document.getElementById('stats-tooltip');
      if (tip) tip.style.opacity = '0';
    }

    _applyArcSelection(chart, dataLen, canvasId);
  }

  /** 手动显示 tooltip（不依赖 Chart.js 事件链，直接 DOM 操作） */
  function _showTooltipManually(canvasId, chart, index) {
    var meta = _segmentMeta[canvasId];
    if (!meta || !meta[index]) return;

    var seg = meta[index];
    var el = document.getElementById('stats-tooltip');
    if (!el) {
      el = document.createElement('div');
      el.id = 'stats-tooltip';
      el.className = 'stats-tooltip';
      document.body.appendChild(el);
    }

    // 构建 HTML
    var isPayment = canvasId.indexOf('payment') >= 0;
    var diagBg = isPayment ? '#e8f5e9' : '#e3f2fd'; // 绿色=支付，蓝色=分类（诊断用）
    var html = '';
    html += '<div class="stats-tooltip__title" style="color:' + seg.color + '">' + seg.name + '</div>';
    html += '<div class="stats-tooltip__amount" style="color:' + seg.color + '"><span class="stats-tooltip__currency">¥</span>' + seg.amount.toLocaleString() + '</div>';
    html += '<div class="stats-tooltip__pct">占比 ' + seg.pct + '%</div>';
    if (seg.isHighest) {
      html += '<div class="stats-tooltip__divider"></div>';
      html += '<div class="stats-tooltip__badge">👑 最高支出</div>';
    }
    el.innerHTML = html;
    // DIAG: 临时背景色标记来源
    el.style.backgroundColor = diagBg;

    // 定位：基于当前 chart 的 canvas，获取选中 arc 的中心坐标
    var pos = chart.canvas.getBoundingClientRect();
    var arc = chart.getDatasetMeta(0).data[index];
    var cx = pos.left + window.scrollX + (arc.x || pos.width / 2);
    var cy = pos.top + window.scrollY + (arc.y || pos.height / 2);

    // 向外偏移（沿 arc 中点角度的方向）
    var midAngle = (arc.startAngle + arc.endAngle) / 2;
    var outerR = (arc.outerRadius || 0) + 16; // 稍微超出圆环外
    var offsetX = Math.cos(midAngle) * outerR;
    var offsetY = Math.sin(midAngle) * outerR;

    el.style.display = 'block';
    el.style.opacity = '1';
    // 先显示才能量尺寸
    var left = cx + offsetX;
    var top = cy + offsetY;
    // 根据 tooltip 在目标点哪一侧微调
    var tw = el.offsetWidth;
    var th = el.offsetHeight;
    if (offsetX < 0) left -= tw;      // 目标在左侧，tooltip 向右对齐
    if (offsetY < 0) top -= th;       // 目标在上方，tooltip 向下对齐

    // 不超出视口
    if (left < 8) left = 8;
    if (top < 8) top = 8;
    if (left + tw > window.innerWidth - 8) left = window.innerWidth - tw - 8;
    if (top + th > window.innerHeight - 8) top = window.innerHeight - th - 8;

    el.style.left = left + 'px';
    el.style.top = top + 'px';
  }

  /** hex 颜色转 rgba，用于控制透明度 */
  function _hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  /** 将选中/取消效果应用到环形图上（选中扇区外扩 + 其余微微变淡） */
  function _applyArcSelection(chart, dataLen, canvasId) {
    const ds = chart.data.datasets[0];
    const selIdx = _selectedArc[canvasId];
    const offsets = new Array(dataLen).fill(0);

    if (selIdx !== null && selIdx !== undefined) {
      offsets[selIdx] = 15;
      ds.backgroundColor = COLORS.slice(0, dataLen).map((c, i) =>
        i === selIdx ? c : _hexToRgba(c, 0.4)
      );
    } else {
      ds.backgroundColor = COLORS.slice(0, dataLen);
    }

    ds.borderColor = dataLen > 0 ? new Array(dataLen).fill('#fff') : [];
    ds.borderWidth = new Array(dataLen).fill(2);
    ds.offset = offsets;
    chart.update('none');

    // 中心始终显示总支出 + 对比（click 不会改变）
    _renderCenterTotal(canvasId);
  }

  /** 确保画布容器内存在中心浮层 + 详情条 DOM（预创建，默认隐藏） */
  function _ensureOverlays(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    let wrap = canvas.closest('.stats-chart-canvas-wrap');
    // 兼容旧 DOM：动态创建包裹层
    if (!wrap) {
      const wrapper = canvas.closest('.stats-chart-wrapper');
      if (!wrapper) return;
      wrap = document.createElement('div');
      wrap.className = 'stats-chart-canvas-wrap';
      canvas.parentNode.insertBefore(wrap, canvas);
      wrap.appendChild(canvas);
    }
    // 中心总支出浮层
    if (!wrap.querySelector('.stats-chart-center')) {
      const el = document.createElement('div');
      el.className = 'stats-chart-center';
      wrap.appendChild(el);
    }
  }

  /** 渲染环形图中心的时段总支出（始终显示，不随点击变化） */
  function _renderCenterTotal(canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const el = canvas.closest('.stats-chart-canvas-wrap')?.querySelector('.stats-chart-center');
    if (!el) return;

    const s = _periodSummary;
    if (!s) { el.style.display = 'none'; return; }

    const sign = s.changePct > 0 ? '+' : '';
    const arrow = s.changePct > 0 ? '↑' : (s.changePct < 0 ? '↓' : '→');
    // "较上月"固定文字保持中性色，后面的箭头/±/百分比走红涨绿跌
    const changeColor = s.changePct > 0 ? '#ee6666' : (s.changePct < 0 ? '#91cc75' : '');

    el.innerHTML = `
      <div class="stats-chart-center__label">${s.label}总支出</div>
      <div class="stats-chart-center__total"><span class="stats-chart-center__currency">¥</span>${s.currentTotal.toLocaleString()}</div>
      <div class="stats-chart-center__compare">
        较${s.compareLabel} <span style="color:${changeColor}">${arrow}${sign}${Math.abs(s.changePct)}%</span>
      </div>
    `;
    el.style.display = 'flex';
  }

  /** Chart.js external tooltip 回调 — 已弃用，tooltip 全部由 _showTooltipManually / _handleArcClick 手动管理。
   *  仅保留 tooltip DOM 的创建和取消选中时的隐藏逻辑，不做任何显示/定位操作。
   *  这样彻底杜绝 Chart.js 内部事件链对 tooltip 位置和内容的干扰（尤其是跨图错位）。 */
  function _externalTooltip(canvasId, context) {
    // 预创建 tooltip DOM（如果尚不存在）
    if (!document.getElementById('stats-tooltip')) {
      var el = document.createElement('div');
      el.id = 'stats-tooltip';
      el.className = 'stats-tooltip';
      document.body.appendChild(el);
    }

    // 取消选中时（_selectedArc 为空），如果 Chart.js 还在尝试显示 tooltip（hover/内部事件），强制隐藏
    if (_selectedArc[canvasId] === null || _selectedArc[canvasId] === undefined) {
      var tip = document.getElementById('stats-tooltip');
      if (tip) tip.style.opacity = '0';
    }
    // 选中状态下不做任何操作 — tooltip 内容/位置完全由 _showTooltipManually 控制
  }

  // HTML 手绘图例：绕过 Chart.js 内置图例的 pointStyle 宽高不一致问题，
  // 用 CSS border-radius:50% 渲染真正的正圆
  function _renderHtmlLegend(canvasId, labels, data) {
    var canvas = document.getElementById(canvasId);
    if (!canvas) return;
    // canvas 外层有 .stats-chart-canvas-wrap，图例要挂在 .stats-chart-wrapper 上
    var wrapper = canvas.closest('.stats-chart-wrapper');
    if (!wrapper) return;
    // 移除旧图例（重绘时）
    var oldLegend = wrapper.querySelector('.stats-chart-legend');
    if (oldLegend) oldLegend.remove();

    var total = data.reduce(function(s, v) { return s + v; }, 0);
    var legendEl = document.createElement('div');
    legendEl.className = 'stats-chart-legend';
    legendEl.innerHTML = labels.map(function(label, i) {
      var pct = total > 0 ? Math.round(data[i] / total * 100) : 0;
      var color = COLORS[i % COLORS.length];
      return '<div class="stats-chart-legend__item">'
        + '<span class="stats-chart-legend__dot" style="background:' + color + '"></span>'
        + '<span class="stats-chart-legend__text">' + label + ' ' + pct + '%</span>'
        + '</div>';
    }).join('');
    wrapper.appendChild(legendEl);
  }

  function _drawOrFallback(canvasId, fallbackId, labels, data, type, meta) {
    // 先销毁该 ID 的旧图表
    if (_charts[canvasId]) {
      try { _charts[canvasId].destroy(); } catch (e) { /* ignore */ }
      _charts[canvasId] = null;
    }

    const canvas = document.getElementById(canvasId);
    const fallback = document.getElementById(fallbackId);
    if (!canvas || !fallback) return;

    // 数据全为 0 或空
    const hasData = data.some(v => v > 0);
    if (!hasData) {
      canvas.style.display = 'none';
      fallback.style.display = 'block';
      fallback.innerHTML = '<div class="stats-fallback__track stats-fallback__track--empty">暂无数据</div>';
      return;
    }

    // Chart.js 不可用时降级
    if (typeof Chart === 'undefined') {
      _renderFallback(fallback, canvas, labels, data, type);
      return;
    }

    try {
      canvas.style.display = 'block';
      fallback.style.display = 'none';

      const ctx = canvas.getContext('2d');

      if (type === 'doughnut') {
        _charts[canvasId] = new Chart(ctx, {
          type: 'doughnut',
          data: {
            labels: labels,
            datasets: [{
              data: data,
              backgroundColor: COLORS.slice(0, data.length),
              borderWidth: data.map(() => 2),
              borderColor: data.map(() => '#fff'),
              offset: data.map(() => 0),
              hoverOffset: 10,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            // 悬停模式：鼠标离开后 tooltip 消失（避免卡住）
            hover: { mode: 'nearest', intersect: true },
            onClick: function(event, elements) {
              _handleArcClick(canvasId, elements, data.length);
            },
            plugins: {
              legend: { display: false },
              tooltip: {
                enabled: false,   // 关闭内置 tooltip，改用 external 自定义 HTML
                position: 'nearest',
                external: function(context) {
                  _externalTooltip(canvasId, context);
                }
              },
            },
            cutout: '60%',
          },
        });
        // Chart.js 内置图例对 doughnut 的 pointStyle 渲染有宽高不一致问题，
        // 改用纯 HTML 手绘图例，CSS border-radius:50% 保真正圆
        _renderHtmlLegend(canvasId, labels, data);
        // 存储扇区元数据（供点击中心浮层使用）
        if (meta) _segmentMeta[canvasId] = meta;
        // 预创建中心浮层 + 扇区详情条 DOM
        _ensureOverlays(canvasId);
        // 渲染中心总支出（始终显示）
        _renderCenterTotal(canvasId);
      } else if (type === 'line') {
        _charts[canvasId] = new Chart(ctx, {
          type: 'line',
          data: {
            labels: labels,
            datasets: [{
              label: '支出',
              data: data,
              borderColor: COLORS[0],
              backgroundColor: COLORS[0] + '20',
              fill: true,
              tension: 0.4,
              pointRadius: 3,
              pointBackgroundColor: COLORS[0],
              borderWidth: 2,
            }],
          },
          options: {
            responsive: true,
            maintainAspectRatio: true,
            plugins: {
              legend: { display: false },
            },
            scales: {
              y: {
                beginAtZero: true,
                ticks: {
                  callback: v => '¥' + v,
                  font: { size: 10 },
                },
                grid: { color: '#f0f0f0' },
              },
              x: {
                ticks: { font: { size: 10 } },
                grid: { display: false },
              },
            },
          },
        });
      }
    } catch (e) {
      console.warn('Chart.js 渲染失败，使用 CSS 降级:', e);
      delete _charts[canvasId];
      _renderFallback(fallback, canvas, labels, data, type);
    }
  }

  /** CSS 降级：环形图 → 横向进度条，折线图 → 柱状图 */
  function _renderFallback(fallbackEl, canvasEl, labels, data, type) {
    canvasEl.style.display = 'none';
    fallbackEl.style.display = 'block';

    if (type === 'doughnut') {
      const total = data.reduce((s, v) => s + v, 0);
      fallbackEl.innerHTML = data.map((v, i) => {
        const pct = total > 0 ? Math.round(v / total * 100) : 0;
        return `
          <div class="stats-fallback__bar">
            <span class="stats-fallback__label">${labels[i]}</span>
            <div class="stats-fallback__track">
              <div class="stats-fallback__fill stats-fallback__fill--c${i % 8}" style="width:${Math.max(pct, 2)}%">${pct}%</div>
            </div>
          </div>`;
      }).join('');
    } else if (type === 'line') {
      const max = Math.max(...data, 1);
      fallbackEl.innerHTML = data.map((v, i) => {
        const pct = Math.round(v / max * 100);
        return `
          <div class="stats-fallback__bar">
            <span class="stats-fallback__label">${labels[i]}</span>
            <div class="stats-fallback__track">
              <div class="stats-fallback__fill stats-fallback__fill--c0" style="width:${Math.max(pct, 2)}%">¥${v}</div>
            </div>
          </div>`;
      }).join('');
    }
  }

  /* =================================================================
     公开 API
     ================================================================= */
  return { render, setPeriod, initPeriodSelector };
})();
