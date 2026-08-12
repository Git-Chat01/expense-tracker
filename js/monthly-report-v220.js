/* ================================================================
   消费轨迹系统 — 月度报告
   ================================================================
   定位：不是“数据复读机”，而是“诊断书”——诊断 → 归因 → 处方三段式。

   结构（按依赖方向自下而上）：
   - 纯计算层 analyze(input)：零 DOM、零 localStorage、零全局依赖，
     输入普通对象数组，输出报告对象。node 测试直接覆盖这一层。
   - 适配层 buildContext(yearMonth)：用 ExpenseDB 取数，组装 analyze 的输入。
   - 渲染层：统计页入口卡 + 全屏报告页 + 月份切换。

   数据安全：引擎只读；唯一写入是 settings.monthlyReportRead（已读标记），
   且必须检查 saveSettings 返回值。
   ================================================================ */

const ExpenseMonthlyReport = (() => {
  'use strict';

  /* =================================================================
     阈值常量（集中定义，便于上线后按命中率调整）
     ================================================================= */
  const THRESHOLDS = {
    sampleMin: 15,           // 样本量门控：当月记录数低于此值不做诊断结论
    coverageMin: 0.30,       // 覆盖率门控：T2 字段覆盖率低于此值 → 模块不出现
    coverageSoft: 0.70,      // 覆盖率低于此值 → 结论加“仅基于 X 条”弱化说明
    r1Share: 0.45,           // R1 分类占比阈值
    r2Pct: 0.40,             // R2 环比增幅阈值
    r2DeltaTotalCents: 10000,  // R2 总额绝对增量阈值（¥100）
    r2DeltaCategoryCents: 5000, // R2 分类绝对增量阈值（¥50）
    r3AmountCents: 3000,     // R3 小额阈值（¥30 以下）
    r3CountShare: 0.50,      // R3 小额笔数占比阈值
    r3CentsShare: 0.20,      // R3 小额金额占比阈值
    r4Share: 0.20,           // R4 冲动金额占比阈值
    r5Share: 0.20,           // R5 深夜笔数占比阈值
    r6Ratio: 2,              // R6 周末/工作日日均倍数阈值
    r7Ratio: 2,              // R7 渠道单均倍数阈值
    r7MinCount: 3,           // R7 渠道最小样本数
    r8Share: 0.08,           // R8 订阅占比提示阈值
    diagnosisLimit: 3,       // ③ 区最多展示的诊断条数（用户偏好：只选最重要的）
  };

  // 刚性大额分类：集中度诊断对此类分类豁免（用户往往无力控制）
  const RIGID_CATEGORY_IDS = {
    'cat-housing': true,     // 住房
    'cat-utilities': true,   // 水电网费
    'cat-phone': true,       // 话费
  };

  // T2 字段中文名（覆盖率弱化说明用）
  const T2_FIELD_LABELS = {
    time: '时间',
    necessity: '价值评定',
    paymentMethod: '支付方式',
  };

  // 支付方式 value → 中文名（文案内嵌用）
  const PAYMENT_LABELS = {
    wechat: '微信支付',
    alipay: '支付宝',
    bankcard: '银行卡',
    cash: '现金',
    other: '其他',
  };

  /* =================================================================
     金额与日期工具（纯函数）
     ================================================================= */

  /** 金额 → 整数分。浮点直接取整，避免累加误差。无效值按 0 处理（防御）。 */
  function _toCents(value) {
    if (value === undefined || value === null || value === '') return 0;
    var num = typeof value === 'number' ? value : Number(String(value).replace(/[^\d.-]/g, ''));
    if (!isFinite(num)) return 0;
    var cents = Math.round(num * 100);
    return cents > 0 ? cents : 0; // 金额模型为正数（storage 层已校验），非正按 0 防御
  }

  /** 分 → “1,860” 格式（不带货币符号，符号由渲染层按 settings 提供） */
  function _fmtCents(cents) {
    var absolute = Math.abs(Math.trunc(cents));
    var hasDecimal = absolute % 100 !== 0;
    return (absolute / 100).toLocaleString('zh-CN', {
      minimumFractionDigits: hasDecimal ? 2 : 0,
      maximumFractionDigits: 2,
    });
  }

  /** “YYYY-MM-DD” 日期字符串 */
  function _ymd(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      + '-' + String(d.getDate()).padStart(2, '0');
  }

  /** 月份 → 该月最后一天 “YYYY-MM-DD”（new Date(y, m, 0) 第 0 天技巧） */
  function _monthLastDate(ym) {
    var parts = ym.split('-');
    var last = new Date(Number(parts[0]), Number(parts[1]), 0);
    return _ymd(last);
  }

  /** 上个月份 “YYYY-MM” */
  function _prevMonth(ym) {
    var parts = ym.split('-');
    var prev = new Date(Number(parts[0]), Number(parts[1]) - 2, 1);
    return prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0');
  }

  /** 上个月的“同日”（YYYY-MM 当月，today 所在日）——本月对比用“上月同期”口径，
   *  避免“半月 vs 整月”的假阳性。上月没有该日（如 3/31）时取上月月末。 */
  function _prevSameDay(ym, todayStr) {
    var parts = ym.split('-');
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    var prevLastDay = new Date(y, m - 1, 0).getDate();
    var d = Math.min(Number(todayStr.split('-')[2]), prevLastDay);
    return _ymd(new Date(y, m - 2, d));
  }

  /** 是否深夜时段：22:00（含）~ 次日 2:00（不含） */
  function _isLateNight(time) {
    var m = /^(\d{1,2}):/.exec(String(time || ''));
    if (!m) return false;
    var h = Number(m[1]);
    return h >= 22 || h < 2;
  }

  /* =================================================================
     分类解析（纯函数）
     ================================================================= */

  /** 分类数组 → { id: category } 对象（含墓碑，墓碑 id 也在里面，由调用方传入） */
  function _catById(categories) {
    var map = Object.create(null);
    (categories || []).forEach(function (c) {
      if (c && c.id !== undefined && c.id !== null) map[String(c.id)] = c;
    });
    return map;
  }

  /** 沿 parentId 上卷到一级分类 id（自身即一级则返回自身）。
   *  找不到的分类返回原 id（孤儿根，渲染时显示“未命名分类”）。带环保护。 */
  function _rootCategoryId(catId, categoryById) {
    var cursor = String(catId);
    var visited = Object.create(null);
    var limit = Object.keys(categoryById).length + 2;
    var safety = 0;
    while (cursor && !visited[cursor] && safety <= limit) {
      visited[cursor] = true;
      var cat = categoryById[cursor];
      if (!cat || !cat.parentId) return cursor;
      cursor = String(cat.parentId);
      safety += 1;
    }
    return cursor;
  }

  /** catId 是否在 ancestorId 的子树内（含自身）——预算按“分类及其子孙”比较用 */
  function _isWithin(catId, ancestorId, categoryById) {
    var cursor = String(catId);
    var visited = Object.create(null);
    var safety = 0;
    while (cursor && !visited[cursor] && safety <= 64) {
      visited[cursor] = true;
      if (cursor === String(ancestorId)) return true;
      var cat = categoryById[cursor];
      cursor = cat && cat.parentId ? String(cat.parentId) : '';
      safety += 1;
    }
    return false;
  }

  /* =================================================================
     预聚合（ctx 构建）
     所有规则共享一次遍历的结果，规则触发器里零聚合、零浮点
     ================================================================= */

  function _buildContext(input) {
    var expenses = Array.isArray(input.expenses) ? input.expenses : [];
    var prevExpenses = Array.isArray(input.prevExpenses) ? input.prevExpenses : [];
    var prevFullExpenses = Array.isArray(input.prevFullMonthExpenses) ? input.prevFullMonthExpenses : [];
    var categoryById = _catById(input.categories);
    var today = /^\d{4}-\d{2}-\d{2}$/.test(input.today || '') ? input.today : '';
    var ym = /^\d{4}-\d{2}$/.test(input.yearMonth || '') ? input.yearMonth : (today.slice(0, 7) || '');
    var isCurrentMonth = ym === today.slice(0, 7);

    var ctx = {
      ym: ym,
      today: today,
      isCurrentMonth: isCurrentMonth,
      currency: input.currency || '¥',
      expenses: expenses,
      prevExpenses: prevExpenses,
      prevFullExpenses: prevFullExpenses,
      categoryById: categoryById,
      count: expenses.length,
      prevCount: prevExpenses.length,
      firstReport: prevExpenses.length === 0,
    };

    // —— 总额与分类聚合（子分类金额上卷到一级分类；直接分类金额单独留一份给预算用）——
    var totalCents = 0;
    var prevTotalCents = 0;
    var prevFullTotalCents = 0;
    var parentTotals = Object.create(null);
    var prevParentTotals = Object.create(null);
    var byCategory = Object.create(null);
    var prevFullByCategory = Object.create(null);

    expenses.forEach(function (e) {
      var cents = _toCents(e.amount);
      totalCents += cents;
      var cid = e.categoryId === undefined || e.categoryId === null ? '' : String(e.categoryId);
      byCategory[cid] = (byCategory[cid] || 0) + cents;
      if (cid) {
        var rootId = _rootCategoryId(cid, categoryById);
        parentTotals[rootId] = (parentTotals[rootId] || 0) + cents;
      }
    });
    prevExpenses.forEach(function (e) {
      var cents = _toCents(e.amount);
      prevTotalCents += cents;
      var cid = e.categoryId === undefined || e.categoryId === null ? '' : String(e.categoryId);
      if (cid) {
        var rootId = _rootCategoryId(cid, categoryById);
        prevParentTotals[rootId] = (prevParentTotals[rootId] || 0) + cents;
      }
    });
    prevFullExpenses.forEach(function (e) {
      var cents = _toCents(e.amount);
      prevFullTotalCents += cents;
      var cid = e.categoryId === undefined || e.categoryId === null ? '' : String(e.categoryId);
      prevFullByCategory[cid] = (prevFullByCategory[cid] || 0) + cents;
    });

    ctx.totalCents = totalCents;
    ctx.prevTotalCents = prevTotalCents;
    ctx.prevFullTotalCents = prevFullTotalCents;
    ctx.parentTotals = parentTotals;
    ctx.prevParentTotals = prevParentTotals;
    ctx.byCategory = byCategory;
    ctx.prevFullByCategory = prevFullByCategory;

    /** 某分类及其所有子孙的直接记录金额合计（预算比较用） */
    ctx.descendantTotal = function (catId) {
      var total = 0;
      Object.keys(byCategory).forEach(function (cid) {
        if (_isWithin(cid, catId, categoryById)) total += byCategory[cid];
      });
      return total;
    };

    /** 上月整月：某分类及其子孙的直接记录金额合计 */
    ctx.prevFullDescendantTotal = function (catId) {
      var total = 0;
      Object.keys(prevFullByCategory).forEach(function (cid) {
        if (_isWithin(cid, catId, categoryById)) total += prevFullByCategory[cid];
      });
      return total;
    };

    // —— 覆盖率（T2 字段非空占比，分母 = 当月全部记录）——
    ctx.coverage = _calcCoverage(expenses);

    // —— R3 小额（<¥30）——
    var smallCount = 0;
    var smallCents = 0;
    var smallByParent = Object.create(null);
    expenses.forEach(function (e) {
      var cents = _toCents(e.amount);
      if (cents < THRESHOLDS.r3AmountCents) {
        smallCount += 1;
        smallCents += cents;
        var cid = e.categoryId === undefined || e.categoryId === null ? '' : String(e.categoryId);
        if (cid) {
          var rootId = _rootCategoryId(cid, categoryById);
          smallByParent[rootId] = (smallByParent[rootId] || 0) + cents;
        }
      }
    });
    ctx.small = {
      count: smallCount,
      cents: smallCents,
      countShare: ctx.count > 0 ? smallCount / ctx.count : 0,
      centsShare: totalCents > 0 ? smallCents / totalCents : 0,
      byParent: smallByParent,
    };

    // —— R4 冲动（necessity = impulse）——
    var impulseCents = 0;
    var impulseByParent = Object.create(null);
    var impulseWithTime = 0;
    var impulseLateNight = 0;
    expenses.forEach(function (e) {
      if (e.necessity !== 'impulse') return;
      var cents = _toCents(e.amount);
      impulseCents += cents;
      var cid = e.categoryId === undefined || e.categoryId === null ? '' : String(e.categoryId);
      if (cid) {
        var rootId = _rootCategoryId(cid, categoryById);
        impulseByParent[rootId] = (impulseByParent[rootId] || 0) + cents;
      }
      if (e.time && String(e.time).trim() !== '') {
        impulseWithTime += 1;
        if (_isLateNight(e.time)) impulseLateNight += 1;
      }
    });
    ctx.impulse = {
      cents: impulseCents,
      sharePct: totalCents > 0 ? impulseCents / totalCents : 0,
      byParent: impulseByParent,
      lateNightShare: impulseWithTime > 0 ? impulseLateNight / impulseWithTime : 0,
    };

    // —— R5 深夜（22:00~2:00，分母 = 有 time 的记录）——
    var withTimeCount = 0;
    var lateNightCount = 0;
    var lateNightCents = 0;
    var lateNightByParent = Object.create(null);
    expenses.forEach(function (e) {
      if (!e.time || String(e.time).trim() === '') return;
      withTimeCount += 1;
      if (_isLateNight(e.time)) {
        lateNightCount += 1;
        var cents = _toCents(e.amount);
        lateNightCents += cents;
        var cid = e.categoryId === undefined || e.categoryId === null ? '' : String(e.categoryId);
        if (cid) {
          var rootId = _rootCategoryId(cid, categoryById);
          lateNightByParent[rootId] = (lateNightByParent[rootId] || 0) + cents;
        }
      }
    });
    ctx.lateNight = {
      count: lateNightCount,
      cents: lateNightCents,
      sharePct: withTimeCount > 0 ? lateNightCount / withTimeCount : 0,
      byParent: lateNightByParent,
    };

    // —— R6 周末 vs 工作日（本月按已过天数切分，历史月按整月）——
    var daysElapsed = 0;
    if (isCurrentMonth) {
      daysElapsed = Number(today.split('-')[2]) || 0;
    } else if (ym) {
      daysElapsed = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0).getDate();
    }
    var byDay = Object.create(null);
    expenses.forEach(function (e) {
      var d = Number(String(e.date || '').split('-')[2]);
      if (d >= 1 && d <= daysElapsed) byDay[d] = (byDay[d] || 0) + _toCents(e.amount);
    });
    var weekendDays = 0;
    var weekdayDays = 0;
    var weekendCents = 0;
    var weekdayCents = 0;
    for (var d = 1; d <= daysElapsed; d++) {
      var wd = new Date(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1, d).getDay();
      if (wd === 0 || wd === 6) {
        weekendDays += 1;
        weekendCents += byDay[d] || 0;
      } else {
        weekdayDays += 1;
        weekdayCents += byDay[d] || 0;
      }
    }
    var weekendDaily = weekendDays > 0 ? weekendCents / weekendDays : 0;
    var weekdayDaily = weekdayDays > 0 ? weekdayCents / weekdayDays : 0;
    ctx.weekend = {
      weekendDays: weekendDays,
      weekdayDays: weekdayDays,
      weekendCents: weekendCents,
      weekdayCents: weekdayCents,
      weekendDaily: weekendDaily,
      weekdayDaily: weekdayDaily,
      ratio: weekdayDaily > 0 ? weekendDaily / weekdayDaily : 0,
    };

    // —— R7 支付渠道（按 paymentMethod 分组，样本 ≥3 的渠道参与比较）——
    var channelByMethod = Object.create(null);
    expenses.forEach(function (e) {
      var method = e.paymentMethod ? String(e.paymentMethod) : '';
      if (!method) return;
      var cents = _toCents(e.amount);
      if (!channelByMethod[method]) channelByMethod[method] = { count: 0, cents: 0 };
      channelByMethod[method].count += 1;
      channelByMethod[method].cents += cents;
    });
    ctx.channels = channelByMethod;

    // —— R8 订阅（cat-subscription 及其子孙，零误报：只认分类，不猜金额）——
    ctx.subscription = _buildSubscription(expenses, categoryById);

    // —— R9 预算 ——
    var budget = input.budget && typeof input.budget === 'object' ? input.budget : null;
    ctx.budget = budget;
    ctx.hasBudget = !!(budget
      && (_toCents(budget.monthlyTotal) > 0
        || (budget.categories && Object.keys(budget.categories).length > 0)));

    return ctx;
  }

  /** T2 字段非空覆盖率（0~1）。分母 = 当月全部记录；无记录时为 0。 */
  function _calcCoverage(expenses) {
    var total = expenses.length;
    if (total === 0) return { time: 0, necessity: 0, paymentMethod: 0 };
    var counts = { time: 0, necessity: 0, paymentMethod: 0 };
    expenses.forEach(function (e) {
      if (e.time && String(e.time).trim() !== '') counts.time += 1;
      if (e.necessity === 'need' || e.necessity === 'want' || e.necessity === 'impulse') counts.necessity += 1;
      if (e.paymentMethod && String(e.paymentMethod).trim() !== '') counts.paymentMethod += 1;
    });
    return {
      time: counts.time / total,
      necessity: counts.necessity / total,
      paymentMethod: counts.paymentMethod / total,
    };
  }

  /** 订阅清单：cat-subscription 自身 + 所有子孙分类的直接记录明细 */
  function _buildSubscription(expenses, categoryById) {
    var subIds = [];
    Object.keys(categoryById).forEach(function (id) {
      if (_rootCategoryId(id, categoryById) === 'cat-subscription') subIds.push(id);
    });
    var items = [];
    var totalCents = 0;
    subIds.forEach(function (subId) {
      var cents = 0;
      var count = 0;
      expenses.forEach(function (e) {
        if (e.categoryId === undefined || e.categoryId === null) return;
        if (String(e.categoryId) !== subId) return;
        cents += _toCents(e.amount);
        count += 1;
      });
      if (count > 0) {
        totalCents += cents;
        items.push({
          categoryId: subId,
          name: (categoryById[subId] && categoryById[subId].name) || '未命名分类',
          count: count,
          cents: cents,
        });
      }
    });
    if (items.length === 0) return null;
    return { items: items, totalCents: totalCents };
  }

  /* =================================================================
     覆盖率门控
     ================================================================= */

  /** 返回 { pass, weak, note }。依赖 T2 字段的规则：覆盖率不足直接不出现。 */
  function _coverageGate(deps, ctx) {
    if (!deps || deps.length === 0) return { pass: true, weak: false, note: null };
    var weakest = 1;
    var weakestField = null;
    deps.forEach(function (field) {
      var v = (ctx.coverage && ctx.coverage[field]) || 0;
      if (v < weakest) {
        weakest = v;
        weakestField = field;
      }
    });
    if (weakest < THRESHOLDS.coverageMin) return { pass: false, weak: false, note: null };
    if (weakest < THRESHOLDS.coverageSoft) {
      var label = T2_FIELD_LABELS[weakestField] || weakestField;
      var filled = Math.round(ctx.count * weakest);
      return {
        pass: true,
        weak: true,
        note: '仅基于 ' + filled + ' 条填写了' + label + '的记录得出',
      };
    }
    return { pass: true, weak: false, note: null };
  }

  /* =================================================================
     公共文案工具（金额格式化 + 货币符号）
     ================================================================= */

  function _money(cents, ctx) {
    return ctx.currency + _fmtCents(cents);
  }

  /** 找金额最大的分类（对象 → { id, cents } 数组），返回 [id, cents] 对 */
  function _topParentEntry(totals, categoryById) {
    var bestId = null;
    var bestCents = 0;
    Object.keys(totals).forEach(function (id) {
      var cents = totals[id];
      if (cents > bestCents) {
        bestCents = cents;
        bestId = id;
      }
    });
    return bestId;
  }

  function _catName(id, categoryById) {
    var cat = categoryById[String(id)];
    return (cat && cat.name) || '未命名分类';
  }

  /* =================================================================
     规则库
     每条规则 = { id, deps, order, controllability, trigger(ctx) → hit|null }
     deps 为空数组 = 纯 T1，不受覆盖率门控（未来 emotion/tags 规则声明
     deps: ['emotion'] 即可接入，门控逻辑自动生效——T3 预留接口）。
     ================================================================= */

  const RULES = [

    /* ── R1 分类集中度过高 ─────────────────────────────── */
    {
      id: 'R1',
      deps: [],
      order: 1,
      controllability: 0.8,
      trigger: function (ctx) {
        var totals = ctx.parentTotals;
        if (ctx.totalCents <= 0) return null;
        var topId = _topParentEntry(totals, ctx.categoryById);
        if (!topId) return null;
        var topCents = totals[topId];
        var share = topCents / ctx.totalCents;
        if (share < THRESHOLDS.r1Share) return null;
        if (RIGID_CATEGORY_IDS[String(topId)]) return null; // 刚性分类豁免

        // 找第二名（不含刚性分类，但保持简单：直接找金额第二大的）
        var secondId = null;
        var secondCents = 0;
        Object.keys(totals).forEach(function (id) {
          if (id === topId) return;
          if (totals[id] > secondCents) {
            secondCents = totals[id];
            secondId = id;
          }
        });

        var pct = Math.round(share * 100);
        var title = pct + '% 的钱花在了「' + _catName(topId, ctx.categoryById) + '」上';

        var explain;
        if (secondId && secondCents > 0) {
          var ratio = (topCents / secondCents).toFixed(1);
          explain = '「' + _catName(topId, ctx.categoryById) + '」这个月花了 '
            + _money(topCents, ctx) + '，是第二名「' + _catName(secondId, ctx.categoryById)
            + '」（' + _money(secondCents, ctx) + '）的 ' + ratio + ' 倍。';
        } else {
          explain = '这个月几乎所有的钱（' + pct + '%）都花在了「'
            + _catName(topId, ctx.categoryById) + '」上。';
        }

        // 处方：有子分类先拆子分类，指出具体是哪个子行为在吃钱
        var prescriptions = [];
        var childTotals = Object.create(null);
        Object.keys(ctx.categoryById).forEach(function (id) {
          var cat = ctx.categoryById[id];
          if (!cat || !cat.parentId) return;
          if (String(cat.parentId) === String(topId)) childTotals[id] = totals[id] || 0;
        });
        var topChildId = _topParentEntry(childTotals, ctx.categoryById);
        if (topChildId) {
          prescriptions.push('「' + _catName(topId, ctx.categoryById) + '」下「'
            + _catName(topChildId, ctx.categoryById) + '」花得最多（'
            + _money(childTotals[topChildId], ctx) + '）。给它单独设个预算上限，超了会有提醒。');
        } else {
          prescriptions.push('给「' + _catName(topId, ctx.categoryById) + '」设个预算上限，超了会有提醒，花钱心里有数。');
        }

        return {
          ruleId: 'R1',
          title: title,
          explain: explain,
          prescriptions: prescriptions,
          impactCents: topCents,
          controllability: 0.8,
          order: 1,
          deps: [],
        };
      },
    },

    /* ── R2 环比异常增长 ───────────────────────────────── */
    {
      id: 'R2',
      deps: [],
      order: 2,
      controllability: 0.3,
      trigger: function (ctx) {
        if (ctx.firstReport) return null; // 无上月数据无法对比
        if (ctx.prevTotalCents <= 0) return null; // 上月基数为 0 不触发

        // 1) 总额口径
        var totalDelta = ctx.totalCents - ctx.prevTotalCents;
        if (totalDelta >= THRESHOLDS.r2DeltaTotalCents
          && ctx.prevTotalCents > 0
          && totalDelta / ctx.prevTotalCents >= THRESHOLDS.r2Pct) {
          return _r2Hit(ctx, {
            kind: 'total',
            catId: null,
            catName: null,
            curCents: ctx.totalCents,
            prevCents: ctx.prevTotalCents,
            delta: totalDelta,
          });
        }

        // 2) 分类口径：增量最大且达标的分类
        var bestCatId = null;
        var bestDelta = 0;
        var bestPrev = 0;
        var bestCur = 0;
        Object.keys(ctx.parentTotals).forEach(function (id) {
          var cur = ctx.parentTotals[id];
          var prev = ctx.prevParentTotals[id] || 0;
          if (prev <= 0) return; // 上月为 0 不触发
          var delta = cur - prev;
          if (delta >= THRESHOLDS.r2DeltaCategoryCents
            && delta / prev >= THRESHOLDS.r2Pct
            && delta > bestDelta) {
            bestDelta = delta;
            bestCatId = id;
            bestPrev = prev;
            bestCur = cur;
          }
        });
        if (bestCatId) {
          return _r2Hit(ctx, {
            kind: 'category',
            catId: bestCatId,
            catName: _catName(bestCatId, ctx.categoryById),
            curCents: bestCur,
            prevCents: bestPrev,
            delta: bestDelta,
          });
        }
        return null;
      },
    },

    /* ── R3 小额高频 ───────────────────────────────────── */
    {
      id: 'R3',
      deps: [],
      order: 3,
      controllability: 0.9,
      trigger: function (ctx) {
        var s = ctx.small;
        if (ctx.count === 0 || ctx.totalCents === 0) return null;
        if (s.countShare < THRESHOLDS.r3CountShare) return null;
        if (s.centsShare < THRESHOLDS.r3CentsShare) return null;

        var title = s.count + ' 笔小额消费加起来有 ' + _money(s.cents, ctx);
        var explain = s.count + ' 笔 ' + (THRESHOLDS.r3AmountCents / 100)
          + ' 元以下的消费占了总笔数的 ' + Math.round(s.countShare * 100)
          + '%，合计 ' + _money(s.cents, ctx) + '，占总支出 ' + Math.round(s.centsShare * 100) + '%。';

        // 处方：设置类建议 + 奶茶可视化冲击（两条并存——既给动作又给冲击力）
        var topId = _topParentEntry(s.byParent, ctx.categoryById);
        var prescriptions = [];
        if (topId) {
          var weekly = Math.max(1, Math.round(s.cents / 4 / 100));
          prescriptions.push('「' + _catName(topId, ctx.categoryById)
            + '」是小额消费最多的分类。给它设一个每周 ' + weekly
            + ' 元的分类预算，小额高频的支出最容易被预算提醒拦住。');
        }
        var milkshake = Math.floor(s.cents / 1500); // ¥15 一杯奶茶
        prescriptions.push('这 ' + s.count + ' 笔加起来 ' + _money(s.cents, ctx)
          + (milkshake > 0 ? '，相当于 ' + milkshake + ' 杯奶茶' : '')
          + '——看着不起眼，加起来不是小数目。');

        return {
          ruleId: 'R3',
          title: title,
          explain: explain,
          prescriptions: prescriptions,
          impactCents: s.cents,
          controllability: 0.9,
          order: 3,
          deps: [],
        };
      },
    },

    /* ── R4 冲动消费占比高（依赖 necessity）────────────── */
    {
      id: 'R4',
      deps: ['necessity'],
      order: 4,
      controllability: 0.85,
      trigger: function (ctx) {
        var imp = ctx.impulse;
        if (ctx.totalCents <= 0) return null;
        if (imp.sharePct < THRESHOLDS.r4Share) return null;

        var pct = Math.round(imp.sharePct * 100);
        var title = '冲动消费花了 ' + _money(imp.cents, ctx) + '，占总支出 ' + pct + '%';

        var topId = _topParentEntry(imp.byParent, ctx.categoryById);
        var explain;
        var prescriptions = [];
        if (topId && imp.cents > 0) {
          var topPct = Math.round((imp.byParent[topId] / imp.cents) * 100);
          explain = '冲动消费里 ' + topPct + '% 花在了「' + _catName(topId, ctx.categoryById) + '」。';
          // 节省金额按“月/季度”口径，绝不年化——用户短时间能做到的才有意义
          var half = Math.round(imp.cents / 2);
          prescriptions.push('把「' + _catName(topId, ctx.categoryById)
            + '」的冲动单挑出来放购物车过夜：如果冲动消费减半，一个月能省 ' + _money(half, ctx) + '。');
        } else {
          explain = '这个月的冲动消费合计 ' + _money(imp.cents, ctx) + '。';
          var half2 = Math.round(imp.cents / 2);
          prescriptions.push('下单前先放购物车过夜：如果冲动消费减半，一个月能省 ' + _money(half2, ctx) + '。');
        }
        if (imp.lateNightShare >= 0.4) {
          prescriptions.push('你的冲动消费有 ' + Math.round(imp.lateNightShare * 100)
            + '% 发生在深夜时段（22 点后）。试着把购物类 App 移出主屏，减少顺手打开的机会。');
        }

        return {
          ruleId: 'R4',
          title: title,
          explain: explain,
          prescriptions: prescriptions,
          impactCents: imp.cents,
          controllability: 0.85,
          order: 4,
          deps: ['necessity'],
        };
      },
    },

    /* ── R5 深夜消费规律（依赖 time）────────────────────── */
    {
      id: 'R5',
      deps: ['time'],
      order: 5,
      controllability: 0.7,
      trigger: function (ctx) {
        var ln = ctx.lateNight;
        if (ctx.count === 0) return null;
        if (ln.sharePct < THRESHOLDS.r5Share) return null;

        var pct = Math.round(ln.sharePct * 100);
        var title = '深夜消费 ' + ln.count + ' 笔，占了有记录的 ' + pct + '%';

        var topId = _topParentEntry(ln.byParent, ctx.categoryById);
        var explain;
        var prescriptions = [];
        if (topId && ln.cents > 0) {
          explain = '深夜消费主要花在「' + _catName(topId, ctx.categoryById) + '」（'
            + _money(ln.byParent[topId], ctx) + '）。';
          if (String(topId) === 'cat-food') {
            prescriptions.push('深夜大多是点外卖。提前囤点夜宵零食，晚上饿的时候有得选，外卖单能少一些。');
          } else {
            prescriptions.push('深夜的「' + _catName(topId, ctx.categoryById)
              + '」消费，试着把相关 App 移到非主屏位置，22 点后不顺手打开。');
          }
        } else {
          explain = '深夜（22 点后）消费 ' + ln.count + ' 笔、合计 ' + _money(ln.cents, ctx) + '。';
        }

        return {
          ruleId: 'R5',
          title: title,
          explain: explain,
          prescriptions: prescriptions,
          impactCents: ln.cents,
          controllability: 0.7,
          order: 5,
          deps: ['time'],
        };
      },
    },

    /* ── R6 周末 vs 工作日失衡（中性描述，不给“建议”）────── */
    {
      id: 'R6',
      deps: [],
      order: 6,
      controllability: 0.4,
      trigger: function (ctx) {
        var w = ctx.weekend;
        // 任一侧日均金额为 0（该时段没有消费记录）时，倍数无意义，不触发——
        // 注意是看日均金额而非天数：用户可能某个时段整段没有消费
        if (w.weekendDaily === 0 || w.weekdayDaily === 0) return null;
        if (w.weekendDaily < w.weekdayDaily) {
          // 工作日远高于周末（通勤/工作餐主导型）也提示，但同样中性
          var inverseRatio = w.weekdayDaily / w.weekendDaily;
          if (inverseRatio < THRESHOLDS.r6Ratio) return null;
          return {
            ruleId: 'R6',
            title: '工作日日均 ' + _money(Math.round(w.weekdayDaily), ctx)
              + '，是周末日均（' + _money(Math.round(w.weekendDaily), ctx) + '）的 ' + inverseRatio.toFixed(1) + ' 倍',
            explain: '工作日 ' + w.weekdayDays + ' 天花 ' + _money(w.weekdayCents, ctx)
              + '，周末 ' + w.weekendDays + ' 天花 ' + _money(w.weekendCents, ctx)
              + '。工作日开销占主导，可能是通勤和工作餐——这种结构本身没有好坏。',
            prescriptions: [],
            impactCents: w.weekdayCents,
            controllability: 0.4,
            order: 6,
            deps: [],
          };
        }
        if (w.weekendDaily / w.weekdayDaily < THRESHOLDS.r6Ratio) return null;
        return {
          ruleId: 'R6',
          title: '周末日均 ' + _money(Math.round(w.weekendDaily), ctx)
            + '，是工作日日均（' + _money(Math.round(w.weekdayDaily), ctx) + '）的 '
            + (w.weekendDaily / w.weekdayDaily).toFixed(1) + ' 倍',
          explain: '周末 ' + w.weekendDays + ' 天花 ' + _money(w.weekendCents, ctx)
            + '，工作日 ' + w.weekdayDays + ' 天花 ' + _money(w.weekdayCents, ctx)
            + '。看起来周末是主要的消费时段——娱乐、聚餐这类开销本身不是问题，心里有数即可。',
          prescriptions: [],
          impactCents: w.weekendCents,
          controllability: 0.4,
          order: 6,
          deps: [],
        };
      },
    },

    /* ── R7 支付渠道单均失衡（依赖 paymentMethod）────────── */
    {
      id: 'R7',
      deps: ['paymentMethod'],
      order: 7,
      controllability: 0.6,
      trigger: function (ctx) {
        // 只比较样本数足够的渠道
        var qualified = [];
        Object.keys(ctx.channels).forEach(function (method) {
          var ch = ctx.channels[method];
          if (ch.count >= THRESHOLDS.r7MinCount) {
            qualified.push({ method: method, count: ch.count, cents: ch.cents, avg: ch.cents / ch.count });
          }
        });
        if (qualified.length < 2) return null;
        qualified.sort(function (a, b) { return b.avg - a.avg; });
        var top = qualified[0];
        var second = qualified[1];
        if (second.avg <= 0) return null;
        var ratio = top.avg / second.avg;
        if (ratio < THRESHOLDS.r7Ratio) return null;

        var label1 = PAYMENT_LABELS[top.method] || top.method;
        var label2 = PAYMENT_LABELS[second.method] || second.method;
        var diff = top.avg - second.avg;
        return {
          ruleId: 'R7',
          title: '用' + label1 + '支付时，平均每笔 ' + _money(Math.round(top.avg), ctx)
            + '，比' + label2 + '高 ' + Math.round((ratio - 1) * 100) + '%',
          explain: label1 + ' ' + top.count + ' 笔、合计 ' + _money(top.cents, ctx)
            + '；' + label2 + ' ' + second.count + ' 笔、单均 ' + _money(Math.round(second.avg), ctx) + '。',
          prescriptions: ['大额消费比较集中在一个支付渠道时，结账前多确认一次金额，看看是不是冲动消费。'],
          impactCents: top.cents,
          controllability: 0.6,
          order: 7,
          deps: ['paymentMethod'],
        };
      },
    },

    /* ── R9 预算超支（依赖用户是否设置预算）────────────────── */
    {
      id: 'R9',
      deps: [],
      order: 9,
      controllability: 0.5,
      trigger: function (ctx) {
        if (!ctx.hasBudget || !ctx.budget) return null;
        var budget = ctx.budget;
        var totalBudgetCents = _toCents(budget.monthlyTotal);
        var impactCents = 0;
        var title = null;
        var explain = null;
        var prescriptions = [];

        // 1) 总额超支
        if (totalBudgetCents > 0 && ctx.totalCents > totalBudgetCents) {
          var over = ctx.totalCents - totalBudgetCents;
          impactCents = over;
          title = '总预算超了 ' + _money(over, ctx);
          explain = '本月总支出 ' + _money(ctx.totalCents, ctx) + '，月度总预算 '
            + _money(totalBudgetCents, ctx) + '，超出 ' + _money(over, ctx) + '。';
          // 连续超支检测：上月整月支出也超过本月总预算 → 建议调预算而不是继续超支
          if (ctx.prevFullTotalCents > totalBudgetCents) {
            prescriptions.push('连续两个月的支出都超过了总预算。与其每个月都超，不如把预算调到实际水平，超支提醒才有意义。');
          } else {
            var topId = _topParentEntry(ctx.parentTotals, ctx.categoryById);
            if (topId) {
              prescriptions.push('下个月先盯住「' + _catName(topId, ctx.categoryById)
                + '」——它是最大的支出项，把它控制在预算内，总账就不会超了。');
            } else {
              prescriptions.push('下个月在最大支出项上先收紧，把总账拉回预算内。');
            }
          }
        }

        // 2) 分类超支（预算 key 可能是任一级分类：按“自身 + 子孙”求和比较）
        var catOverBest = null;
        var catOverBestId = null;
        if (budget.categories) {
          Object.keys(budget.categories).forEach(function (catId) {
            var limitCents = _toCents(budget.categories[catId]);
            if (limitCents <= 0) return;
            var spent = ctx.descendantTotal(catId);
            if (spent > limitCents) {
              var overCents = spent - limitCents;
              if (!catOverBest || overCents > catOverBest) {
                catOverBest = overCents;
                catOverBestId = catId;
              }
            }
          });
        }
        if (catOverBestId) {
          var catName = _catName(catOverBestId, ctx.categoryById);
          var catOver = ctx.descendantTotal(catOverBestId) - _toCents(budget.categories[catOverBestId]);
          if (catOver > impactCents) impactCents = catOver;
          if (title === null) {
            title = '「' + catName + '」超了预算 ' + _money(catOver, ctx);
            explain = '「' + catName + '」本月花了 ' + _money(ctx.descendantTotal(catOverBestId), ctx)
              + '，预算 ' + _money(_toCents(budget.categories[catOverBestId]), ctx)
              + '，超出 ' + _money(catOver, ctx) + '。';
          } else {
            explain += '另外「' + catName + '」也超支 ' + _money(catOver, ctx) + '。';
          }
          var prevFullCatOver = ctx.prevFullDescendantTotal(catOverBestId) > _toCents(budget.categories[catOverBestId]);
          if (prevFullCatOver) {
            prescriptions.push('「' + catName + '」连续超支。这个预算数字可能一直定得不现实，建议把预算调整到最近几个月的实际水平。');
          } else if (prescriptions.length < 2) {
            prescriptions.push('下个月在「' + catName + '」上留意每笔金额，先定一个小目标：比这个月少花 ' + _money(catOver, ctx) + '。');
          }
        }

        if (title === null) return null;
        return {
          ruleId: 'R9',
          title: title,
          explain: explain,
          prescriptions: prescriptions,
          impactCents: impactCents,
          controllability: 0.5,
          order: 9,
          deps: [],
        };
      },
    },
  ];

  /** R2 命中共用组装 */
  function _r2Hit(ctx, info) {
    var periodNote = ctx.isCurrentMonth ? '同期' : '';
    var pct = Math.round((info.delta / info.prevCents) * 100);
    var title = info.kind === 'total'
      ? '比上月' + periodNote + '多了 ' + pct + '%，多花 ' + _money(info.delta, ctx)
      : '「' + info.catName + '」比上月' + periodNote + '多了 ' + pct + '%，多花 ' + _money(info.delta, ctx);

    // 归因：本月大额 Top3 明细（贡献了增量的“那几笔”）
    var topRecords = ctx.expenses.slice()
      .sort(function (a, b) { return _toCents(b.amount) - _toCents(a.amount); })
      .slice(0, 3);
    var listParts = [];
    topRecords.forEach(function (e) {
      var date = String(e.date || '').slice(5); // MM-DD
      var cid = e.categoryId === undefined || e.categoryId === null ? '' : String(e.categoryId);
      listParts.push(date + ' ' + _catName(cid, ctx.categoryById) + ' ' + _money(_toCents(e.amount), ctx));
    });
    var explain = '增量的主要来源' + (topRecords.length > 0 ? '：' + listParts.join('、') : '') + '。';

    var prescriptions = [
      '给这次增长记一笔备注（比如“换了新手机”），下个月对比时能分清是一次性消费还是常态开销，别被单次大额误导做决定。',
    ];

    return {
      ruleId: 'R2',
      title: title,
      explain: explain,
      prescriptions: prescriptions,
      impactCents: info.delta,
      controllability: 0.3,
      order: 2,
      deps: [],
    };
  }

  /* =================================================================
     报告组装（runner）
     ================================================================= */

  /**
   * 纯计算入口：输入普通对象，输出报告对象。不读不写任何存储。
   *
   * input = {
   *   yearMonth: 'YYYY-MM',            // 报告月份
   *   today: 'YYYY-MM-DD',             // 今天（测试可注入）
   *   currency: '¥',                   // 货币符号（settings.currency）
   *   expenses: [...],                 // 当月记录
   *   prevExpenses: [...],             // 基线：当前月=上月同期；历史月=完整上月
   *   prevFullMonthExpenses: [...],    // 上月整月（仅 R9 连续超支检测）
   *   categories: [...],               // 分类（含当月涉及的墓碑分类）
   *   budget: { monthlyTotal, categories } | null,
   * }
   */
  function analyze(input) {
    var ctx = _buildContext(input);
    var sampleGated = ctx.count < THRESHOLDS.sampleMin;

    // 样本量门控：诊断规则全部跳过（R8 订阅清单是客观列举，豁免）
    var hits = [];
    if (!sampleGated && ctx.count > 0) {
      RULES.forEach(function (rule) {
        var gate = _coverageGate(rule.deps, ctx);
        if (!gate.pass) return;
        var hit = rule.trigger(ctx);
        if (!hit) return;
        hit.coverageWeak = gate.weak;
        hit.coverageNote = gate.note;
        hits.push(hit);
      });
    }

    // 排序：金额影响降序 → 可控性降序 → 注册序（测试稳定）
    hits.sort(function (a, b) {
      if (b.impactCents !== a.impactCents) return b.impactCents - a.impactCents;
      if (b.controllability !== a.controllability) return b.controllability - a.controllability;
      return a.order - b.order;
    });

    var diagnoses = hits.slice(0, THRESHOLDS.diagnosisLimit);
    // ③ 区之外，只有依赖 T2 字段的命中进 ⑤ 可选洞察区（T1 的 4 名以后直接丢弃）
    var insights = hits.slice(THRESHOLDS.diagnosisLimit).filter(function (h) {
      return h.deps && h.deps.length > 0;
    });

    // ⑧ 行动建议：从每条诊断取第一条处方，最多 3 条（与 ③ 有因果、措辞不同）
    var actions = [];
    diagnoses.forEach(function (hit) {
      if (hit.prescriptions && hit.prescriptions.length > 0 && actions.length < THRESHOLDS.diagnosisLimit) {
        actions.push({ text: hit.prescriptions[0], ruleId: hit.ruleId });
      }
    });

    // ① 开场结论：命中优先级最高的一条（标题即总结句）
    var opening = null;
    if (diagnoses.length > 0) {
      opening = { title: diagnoses[0].title };
    }

    // ② 核心骨架数据
    var elapsedDays = ctx.weekend.weekendDays + ctx.weekend.weekdayDays;
    var dailyAvg = elapsedDays > 0 ? ctx.totalCents / elapsedDays : 0;
    var changePct = null;
    if (!ctx.firstReport && ctx.prevTotalCents > 0) {
      changePct = Math.round(((ctx.totalCents - ctx.prevTotalCents) / ctx.prevTotalCents) * 100);
    }

    // ④ 分类结构：Top5 + 环比增量最大分类
    var topCategories = Object.keys(ctx.parentTotals)
      .map(function (id) {
        var cat = ctx.categoryById[String(id)];
        return {
          id: id,
          name: (cat && cat.name) || '未命名分类',
          cents: ctx.parentTotals[id],
          sharePct: ctx.totalCents > 0 ? ctx.parentTotals[id] / ctx.totalCents : 0,
        };
      })
      .sort(function (a, b) { return b.cents - a.cents; })
      .slice(0, 5);

    var deltaCategory = null;
    if (!ctx.firstReport) {
      var bestDeltaId = null;
      var bestDeltaCents = 0;
      var bestPrevCents = 0;
      Object.keys(ctx.parentTotals).forEach(function (id) {
        var cur = ctx.parentTotals[id];
        var prev = ctx.prevParentTotals[id] || 0;
        if (prev <= 0) return;
        var delta = cur - prev;
        if (delta > bestDeltaCents) {
          bestDeltaCents = delta;
          bestDeltaId = id;
          bestPrevCents = prev;
        }
      });
      if (bestDeltaId) {
        var cat = ctx.categoryById[String(bestDeltaId)];
        deltaCategory = {
          id: bestDeltaId,
          name: (cat && cat.name) || '未命名分类',
          cents: ctx.parentTotals[bestDeltaId],
          prevCents: bestPrevCents,
          deltaCents: bestDeltaCents,
          pct: Math.round((bestDeltaCents / bestPrevCents) * 100),
        };
      }
    }

    // ⑥ 订阅清单（R8，豁免样本门控；不进诊断池）
    var subscription = null;
    if (ctx.subscription) {
      var share = ctx.totalCents > 0 ? ctx.subscription.totalCents / ctx.totalCents : 0;
      var hint = null;
      if (share >= THRESHOLDS.r8Share) {
        hint = '订阅每月固定扣款合计 ' + _money(ctx.subscription.totalCents, ctx)
          + '（占总支出 ' + Math.round(share * 100)
          + '%）。挨个回想一下，不用的会员直接取消续费，下个月起每月少花一笔。';
      }
      subscription = {
        items: ctx.subscription.items,
        totalCents: ctx.subscription.totalCents,
        sharePct: share,
        hint: hint,
      };
    }

    // ⑦ 预算健康度（R9 命中与否都会展示结构；内容不同）
    var budgetReport = null;
    if (ctx.hasBudget) {
      var totalBudgetCents = ctx.budget ? _toCents(ctx.budget.monthlyTotal) : 0;
      var overTotal = totalBudgetCents > 0 ? Math.max(0, ctx.totalCents - totalBudgetCents) : 0;
      budgetReport = {
        monthlyTotalCents: totalBudgetCents,
        totalCents: ctx.totalCents,
        overTotalCents: overTotal,
        usage: totalBudgetCents > 0 ? ctx.totalCents / totalBudgetCents : 0,
      };
    }

    return {
      yearMonth: ctx.ym,
      isCurrentMonth: ctx.isCurrentMonth,
      today: ctx.today,
      currency: ctx.currency,
      firstReport: ctx.firstReport,
      sampleGated: sampleGated,
      count: ctx.count,
      totalCents: ctx.totalCents,
      prevTotalCents: ctx.prevTotalCents,
      dailyAvgCents: Math.round(dailyAvg),
      changePct: changePct,
      opening: opening,
      diagnoses: diagnoses,
      insights: insights,
      actions: actions,
      topCategories: topCategories,
      deltaCategory: deltaCategory,
      subscription: subscription,
      budgetReport: budgetReport,
      budgetNudge: !ctx.hasBudget,
      hasBudget: ctx.hasBudget,
    };
  }

  /* =================================================================
     适配层：用 ExpenseDB 取数，组装 analyze 的输入
     ================================================================= */

  /** 月份 → 当月记录 / 基线记录 / 上月整月 / 分类 / 预算，一次取齐 */
  function buildContext(yearMonth) {
    if (typeof ExpenseDB === 'undefined') return null;
    var today = ExpenseDB.today();
    var ym = /^\d{4}-\d{2}$/.test(yearMonth || '') ? yearMonth : today.slice(0, 7);

    var from = ym + '-01';
    var to = ym === today.slice(0, 7) ? today : _monthLastDate(ym);
    var expenses = ExpenseDB.getExpensesByDateRange(from, to);

    var prevYm = _prevMonth(ym);
    var prevFrom = prevYm + '-01';
    var prevTo = ym === today.slice(0, 7) ? _prevSameDay(ym, today) : _monthLastDate(prevYm);
    var prevExpenses = ExpenseDB.getExpensesByDateRange(prevFrom, prevTo);

    // 上月整月：仅用于 R9“连续超支”检测
    var prevFullExpenses = ExpenseDB.getExpensesByDateRange(prevYm + '-01', _monthLastDate(prevYm));

    // 分类：活动分类 + 当月记录涉及到的墓碑分类（历史账单按原分类名显示）
    var categories = ExpenseDB.getCategories().slice();
    expenses.forEach(function (e) {
      if (!e.categoryId) return;
      var cid = String(e.categoryId);
      var exists = categories.some(function (c) { return String(c.id) === cid; });
      if (!exists) {
        var tomb = ExpenseDB.getCategory(cid);
        if (tomb) categories.push(tomb);
      }
    });

    var settings = ExpenseDB.getSettings();
    return {
      yearMonth: ym,
      today: today,
      currency: (settings && settings.currency) || '¥',
      expenses: expenses,
      prevExpenses: prevExpenses,
      prevFullMonthExpenses: prevFullExpenses,
      categories: categories,
      budget: ExpenseDB.getBudget(),
    };
  }

  /* =================================================================
     渲染层（浏览器）：入口卡状态 + 全屏月报覆盖层
     不 DOMContentLoaded 自启——由 app 显式调用 init()，
     保证 vm 测试环境顶层零副作用（无 document/localStorage 引用）
     ================================================================= */

  var _overlayEl = null;   // #overlay-monthly-report
  var _bodyEl = null;      // #overlay-monthly-report-body
  var _scrollYBefore = 0;  // 滚动锁：记录打开前位置
  var _viewMonth = null;   // 正在查看的报告月份 YYYY-MM
  var _initialized = false;

  /** 最小 toast：与 app 的 .toast 结构兼容，渲染层自包含、不依赖 app 内部函数 */
  function _toast(message, type) {
    var container = document.getElementById('toast-container');
    if (!container) return;
    var el = document.createElement('div');
    el.className = 'toast toast--' + (type || '');
    var copy = document.createElement('span');
    copy.className = 'toast__copy';
    copy.textContent = message;
    el.appendChild(copy);
    container.appendChild(el);
    var removeEl = function () { if (el.parentNode) el.parentNode.removeChild(el); };
    setTimeout(function () {
      el.classList.add('toast--removing');
      el.addEventListener('animationend', removeEl, { once: true });
      setTimeout(removeEl, 350); // 兜底：animationend 不触发也不残留
    }, 2600);
  }

  /** 用户文本转义（XSS 红线：分类名/备注等一律过 escapeHtml，不重蹈 stats.js:536 裸拼教训） */
  function _esc(str) {
    if (typeof ExpenseData !== 'undefined' && ExpenseData.escapeHtml) {
      return ExpenseData.escapeHtml(String(str));
    }
    return String(str)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 'YYYY-MM' → '2026年8月' */
  function _ymLabel(ym) {
    var parts = String(ym).split('-');
    return Number(parts[0]) + '年' + Number(parts[1]) + '月';
  }

  /** 下个月份 'YYYY-MM' */
  function _nextMonth(ym) {
    var parts = String(ym).split('-');
    var y = Number(parts[0]);
    var m = Number(parts[1]);
    return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
  }

  /** 最早有记录月份（‹ 按钮下界）；无记录返回 null */
  function _earliestYm() {
    var all = ExpenseDB.getExpensesByDateRange('0001-01-01', '9999-12-31');
    var min = null;
    for (var i = 0; i < all.length; i++) {
      var d = all[i] && all[i].date;
      if (!d) continue;
      var ym = String(d).slice(0, 7);
      if (!min || ym < min) min = ym;
    }
    return min;
  }

  /** 金额：千分位 + 货币符号（渲染层收尾，引擎只出纯数字） */
  function _moneyStr(cents, currency) {
    return (currency || '¥') + _fmtCents(cents || 0);
  }

  /** 入口卡：空数据隐藏；未读角标“新”（monthlyReportRead !== 当前月） */
  function _renderEntry() {
    var entry = document.getElementById('mr-entry');
    if (!entry) return;
    if (!ExpenseDB.getExpenseCount()) { entry.hidden = true; return; }
    entry.hidden = false;
    var badge = document.getElementById('mr-entry-badge');
    if (!badge) return;
    var settings = ExpenseDB.getSettings() || {};
    var ym = ExpenseDB.today().slice(0, 7);
    badge.hidden = (settings.monthlyReportRead || '') === ym;
  }

  /** 区块骨架：标题 + 内容（无数据模块直接不渲染，不留空占位） */
  function _sectionHtml(title, inner) {
    return '<section class="mr-section"><h2 class="mr-section__title">'
      + _esc(title) + '</h2>' + inner + '</section>';
  }

  /** ① 开场结论卡：1 句话总结（top1 标题）；无命中给中性客观陈述 */
  function _openingHtml(report) {
    var text = null;
    var cls = '';
    if (report.opening) {
      text = report.opening.title;
    } else if (report.count === 0) {
      text = _ymLabel(report.yearMonth) + '还没有记录，先去记几笔吧。';
      cls = ' mr-opening--calm';
    } else if (report.sampleGated) {
      text = '这个月记了 ' + report.count + ' 笔，数据还比较少，多记几个月能看出更准的规律。';
      cls = ' mr-opening--calm';
    } else if (report.firstReport) {
      text = '这是你的第一份月报，从下个月开始能看到变化趋势。';
      cls = ' mr-opening--calm';
    } else {
      text = '本月没有发现明显的异常，按自己的节奏来就行。';
      cls = ' mr-opening--calm';
    }
    return '<div class="mr-opening' + cls + '"><p class="mr-opening__text">' + _esc(text) + '</p></div>';
  }

  /** ② 核心数据骨架：总额 / 日均 / 笔数 / 环比（纯 T1，永远展示） */
  function _skeletonHtml(report) {
    var currency = report.currency || '¥';
    var changeHtml;
    if (report.firstReport) {
      changeHtml = '<span class="mr-skeleton__change">首份月报</span>';
    } else if (report.changePct === null) {
      changeHtml = '<span class="mr-skeleton__change">—</span>';
    } else {
      var up = report.changePct >= 0;
      var label = report.isCurrentMonth ? '比上月同期' : '比上月';
      changeHtml = '<span class="mr-skeleton__change mr-skeleton__change--' + (up ? 'up' : 'down') + '">'
        + (up ? '↑' : '↓') + Math.abs(report.changePct) + '%（' + label + '）</span>';
    }
    return '<div class="mr-skeleton">'
      + '<div class="mr-skeleton__cell mr-skeleton__cell--total">'
      + '<p class="mr-skeleton__label">总支出</p>'
      + '<p class="mr-skeleton__value">' + _moneyStr(report.totalCents, currency) + '</p></div>'
      + '<div class="mr-skeleton__cell">'
      + '<p class="mr-skeleton__label">日均</p>'
      + '<p class="mr-skeleton__value">' + _moneyStr(report.dailyAvgCents, currency) + '</p></div>'
      + '<div class="mr-skeleton__cell">'
      + '<p class="mr-skeleton__label">笔数</p>'
      + '<p class="mr-skeleton__value">' + report.count + '</p></div>'
      + '<div class="mr-skeleton__cell">'
      + '<p class="mr-skeleton__label">环比</p>'
      + '<p class="mr-skeleton__value">' + changeHtml + '</p></div>'
      + '</div>';
  }

  /** 诊断/洞察共用卡片：标题 + 归因 + 弱化说明 + 处方（R6 处方为空时自动省略列表） */
  function _hitCardHtml(hit, cls) {
    var html = '<article class="' + cls + '">'
      + '<h3 class="' + cls + '__title">' + _esc(hit.title) + '</h3>'
      + '<p class="' + cls + '__explain">' + _esc(hit.explain) + '</p>';
    if (hit.coverageWeak && hit.coverageNote) {
      html += '<p class="' + cls + '__note">' + _esc(hit.coverageNote) + '</p>';
    }
    if (hit.prescriptions && hit.prescriptions.length) {
      html += '<ul class="' + cls + '__prescriptions">'
        + hit.prescriptions.map(function (p) { return '<li>' + _esc(p) + '</li>'; }).join('')
        + '</ul>';
    }
    html += '</article>';
    return html;
  }

  /** ③ 问题诊断区：命中规则最多 3 条；样本不足/无命中给中性句 */
  function _diagnosesHtml(report) {
    if (report.sampleGated) {
      return _sectionHtml('这个月哪里不对劲',
        '<p class="mr-empty">记录还不到 15 笔，先不急着下结论。多记几个月，月报才能看出规律。</p>');
    }
    if (!report.diagnoses.length) {
      return _sectionHtml('这个月哪里不对劲', '<p class="mr-empty">本月没有发现明显的异常。</p>');
    }
    return _sectionHtml('这个月哪里不对劲',
      report.diagnoses.map(function (hit) { return _hitCardHtml(hit, 'mr-diagnosis'); }).join(''));
  }

  /** ④ 分类结构：占比 Top5 排行 + 环比增量最大的分类 */
  function _categoriesHtml(report) {
    if (!report.topCategories.length) return '';
    var rows = report.topCategories.map(function (cat, i) {
      return '<li class="mr-ranking__item">'
        + '<span class="mr-ranking__rank">' + (i + 1) + '</span>'
        + '<span class="mr-ranking__name">' + _esc(cat.name) + '</span>'
        + '<span class="mr-ranking__bar"><span class="mr-ranking__fill" style="width:'
        + Math.max(2, Math.round(cat.sharePct * 100)) + '%"></span></span>'
        + '<span class="mr-ranking__pct">' + Math.round(cat.sharePct * 100) + '%</span>'
        + '<span class="mr-ranking__amount">' + _moneyStr(cat.cents, report.currency) + '</span>'
        + '</li>';
    }).join('');
    var delta = '';
    if (report.deltaCategory && report.deltaCategory.deltaCents > 0) {
      delta = '<div class="mr-delta"><strong>' + _esc(report.deltaCategory.name) + '</strong>比'
        + (report.isCurrentMonth ? '上月同期' : '上月') + '多花 '
        + _moneyStr(report.deltaCategory.deltaCents, report.currency)
        + '（+' + report.deltaCategory.pct + '%）</div>';
    }
    return _sectionHtml('钱都花在哪了', '<ul class="mr-ranking">' + rows + '</ul>' + delta);
  }

  /** ⑤ 可选洞察区：仅 T2 命中的第 4 名起条目（覆盖率弱化说明随卡展示） */
  function _insightsHtml(report) {
    if (!report.insights.length) return '';
    return _sectionHtml('更细的观察',
      report.insights.map(function (hit) { return _hitCardHtml(hit, 'mr-insight'); }).join(''));
  }

  /** ⑥ 订阅与固定支出清单：零误报（只聚合 cat-subscription 子树） */
  function _subscriptionHtml(report) {
    if (!report.subscription) return '';
    var rows = report.subscription.items.map(function (item) {
      return '<li class="mr-sub__item"><span class="mr-sub__name">' + _esc(item.name) + '</span>'
        + '<span class="mr-sub__amount">' + _moneyStr(item.cents, report.currency) + '<em>/月</em></span></li>';
    }).join('');
    var hint = report.subscription.hint
      ? '<p class="mr-sub__hint">' + _esc(report.subscription.hint) + '</p>' : '';
    return _sectionHtml('订阅与固定支出',
      '<ul class="mr-sub">' + rows + '</ul>'
      + '<p class="mr-sub__total">合计 ' + _moneyStr(report.subscription.totalCents, report.currency)
      + '（占总支出 ' + Math.round(report.subscription.sharePct * 100) + '%）</p>' + hint);
  }

  /** ⑦ 预算健康度：进度条 + 超支红字/剩余绿字；未设总预算时只给一句说明 */
  function _budgetHtml(report) {
    if (!report.budgetReport) return '';
    var b = report.budgetReport;
    var inner;
    if (b.monthlyTotalCents > 0) {
      var pct = Math.min(100, Math.round(b.usage * 100));
      inner = '<div class="mr-budget__bar"><div class="mr-budget__fill'
        + (b.overTotalCents > 0 ? ' mr-budget__fill--over' : '') + '" style="width:' + pct + '%"></div></div>';
      inner += b.overTotalCents > 0
        ? '<p class="mr-budget__status mr-budget__status--over">已超支 '
          + _moneyStr(b.overTotalCents, report.currency) + '——超支原因见上方诊断。</p>'
        : '<p class="mr-budget__status mr-budget__status--ok">还剩 '
          + _moneyStr(Math.max(0, b.monthlyTotalCents - b.totalCents), report.currency)
          + '，在预算内，控制得不错。</p>';
    } else {
      inner = '<p class="mr-empty">未设置月度总预算，目前只按分类预算对比（见上方诊断）。</p>';
    }
    return _sectionHtml('预算健康度', inner);
  }

  /** ⑧ 下月行动建议：从诊断提炼的编号动作（1-3 条）+ 预算轻推 */
  function _actionsHtml(report) {
    var items = report.actions.map(function (a, i) {
      return '<li class="mr-action"><span class="mr-action__index">' + (i + 1) + '</span>'
        + '<p class="mr-action__text">' + _esc(a.text) + '</p></li>';
    }).join('');
    var nudge = report.budgetNudge
      ? '<p class="mr-nudge">设置个预算，下个月的月报能多告诉你一件事。</p>' : '';
    if (!items && !nudge) return '';
    return _sectionHtml('下个月可以这样做', (items ? '<ol class="mr-actions">' + items + '</ol>' : '') + nudge);
  }

  /** 月份条：‹ 2026年8月 › + 数据截止日；历史月附加“回到本月” */
  function _periodHtml(report, today) {
    var curYm = today.slice(0, 7);
    var isCur = report.yearMonth === curYm;
    var earliest = _earliestYm();
    var html = '<div class="mr-period">'
      + '<button type="button" class="mr-period__nav" data-mr-prev'
      + (earliest && report.yearMonth <= earliest ? ' disabled' : '') + ' aria-label="上个月">‹</button>'
      + '<div class="mr-period__center"><span class="mr-period__label">' + _ymLabel(report.yearMonth) + '</span>'
      + (isCur ? '<span class="mr-period__until">数据截至 ' + report.today.slice(5) + '</span>' : '')
      + '</div>'
      + '<button type="button" class="mr-period__nav" data-mr-next'
      + (isCur ? ' disabled' : '') + ' aria-label="下个月">›</button>'
      + '</div>'
      + (isCur ? '' : '<div class="mr-period__now"><button type="button" class="mr-chip" data-mr-now>回到本月</button></div>');
    return html;
  }

  /** 组装 ①-⑧ 全部区块并写入覆盖层 body */
  function _renderReport(month) {
    var today = ExpenseDB.today();
    var ym = /^\d{4}-\d{2}$/.test(month || '') ? month : today.slice(0, 7);
    var input = buildContext(ym);
    if (!input) return;
    var report = analyze(input);
    _viewMonth = ym;

    _bodyEl.innerHTML = _periodHtml(report, today)
      + _openingHtml(report)
      + _skeletonHtml(report)
      + _diagnosesHtml(report)
      + _categoriesHtml(report)
      + _insightsHtml(report)
      + _subscriptionHtml(report)
      + _budgetHtml(report)
      + _actionsHtml(report);
  }

  /** 锁背景滚动：记录原位置（与预算/分类覆盖层同一模式，防移动端穿透） */
  function _lockScroll() {
    _scrollYBefore = window.scrollY || document.documentElement.scrollTop || 0;
    document.body.style.top = '-' + _scrollYBefore + 'px';
    document.body.classList.add('page-overlay-open');
    document.documentElement.classList.add('page-overlay-open');
  }

  /** 解锁滚动：精确回到打开前的位置（与 _lockScroll 严格成对，防 body 卡死） */
  function _unlockScroll() {
    document.body.style.top = '';
    document.body.classList.remove('page-overlay-open');
    document.documentElement.classList.remove('page-overlay-open');
    window.scrollTo(0, _scrollYBefore);
  }

  /** 打开月报（默认当前月）：渲染 → 打开 → 当前月标记已读（历史月不改已读） */
  function openReport(month) {
    if (!_overlayEl || !_bodyEl) return;
    var today = ExpenseDB.today();
    var ym = /^\d{4}-\d{2}$/.test(month || '') ? month : today.slice(0, 7);
    _renderReport(ym);
    _overlayEl.classList.add('page-overlay--open');
    _lockScroll();
    if (ym === today.slice(0, 7)) {
      var settings = ExpenseDB.getSettings() || {};
      if ((settings.monthlyReportRead || '') !== ym) {
        // saveSettings 返回值必须查：写入失败不静默，角标保留下次再试
        if (!ExpenseDB.saveSettings({ monthlyReportRead: ym })) {
          _toast('已读状态保存失败，角标会保留。请勿清理浏览器数据，下次打开再试', 'warning');
        }
      }
    }
    _renderEntry();
  }

  /** 关闭月报：解锁滚动 + 收起覆盖层 */
  function closeReport() {
    if (!_overlayEl) return;
    _unlockScroll();
    _overlayEl.classList.remove('page-overlay--open');
  }

  /** 刷新入口卡状态（app 切回统计页时调用，刷新未读角标） */
  function refreshEntry() {
    _renderEntry();
  }

  /** 挂载入口：绑定入口卡/关闭/月份切换事件 + 首次渲染入口卡（由 app 显式调用） */
  function init() {
    if (_initialized) return;
    _initialized = true;
    _overlayEl = document.getElementById('overlay-monthly-report');
    _bodyEl = document.getElementById('overlay-monthly-report-body');

    var entry = document.getElementById('mr-entry');
    if (entry) {
      entry.addEventListener('click', function () {
        openReport(ExpenseDB.today().slice(0, 7));
      });
    }
    if (_overlayEl) {
      var back = _overlayEl.querySelector('.page-overlay__back');
      if (back) back.addEventListener('click', closeReport);
    }
    // 月份切换用事件委托：月份条每次渲染重建，委托一次即可
    if (_bodyEl) {
      _bodyEl.addEventListener('click', function (ev) {
        var t = ev.target;
        if (!t || !t.closest) return;
        if (t.closest('[data-mr-prev]')) {
          openReport(_prevMonth(_viewMonth || ExpenseDB.today().slice(0, 7)));
        } else if (t.closest('[data-mr-next]')) {
          openReport(_nextMonth(_viewMonth || ExpenseDB.today().slice(0, 7)));
        } else if (t.closest('[data-mr-now]')) {
          openReport(ExpenseDB.today().slice(0, 7));
        }
      });
    }
    _renderEntry();
  }

  /* =================================================================
     公开 API
     ================================================================= */
  return {
    analyze: analyze,
    buildContext: buildContext,
    THRESHOLDS: THRESHOLDS,
    init: init,
    openReport: openReport,
    closeReport: closeReport,
    refreshEntry: refreshEntry,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = ExpenseMonthlyReport;
}
