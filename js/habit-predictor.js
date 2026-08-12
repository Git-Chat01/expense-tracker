/* ================================================================
   消费轨迹系统 — habit-predictor.js
   ExpenseHabitPredictor 命名空间：记账习惯条件概率统计（v187 起）
   从主控制器拆出（审计高危 No.2）：统计是纯数据计算，与表单 DOM 编排无关。
   按"所选分类 → 父分类（含其全部子分类）→ 全局"回退链统计
   用户行为习惯：P(支付方式|分类)。某一层样本 ≥5 笔且某项占比 ≥70% 时命中。
   纯读取历史账单，零写入，符合数据安全红线。
   ================================================================ */

const ExpenseHabitPredictor = (() => {
  'use strict';

  let _habitStatsCache = null;   // { direct: {catId→层}, parent: {父分类Id→层}, global: 层 }
                                 // 层 = { counts: {paymentMethod: 次数}, total: 总样本数 }

  /** 数据变更后使习惯统计缓存失效（下次选分类时自动重建） */
  function invalidate() {
    _habitStatsCache = null;
  }

  /** 一次遍历构建三层统计：direct=精确分类，parent=父分类（含其全部子分类账单），global=全局 */
  function buildStats() {
    // 分类关系：子分类 → 父分类映射 + 父分类集合（无 parentId 者视为父分类）
    const parentOf = {};
    const parentSet = new Set();
    ExpenseDB.getCategories().forEach(c => {
      if (c.parentId) parentOf[c.id] = c.parentId;
      else parentSet.add(c.id);
    });
    const stats = { direct: {}, parent: {}, global: { counts: {}, total: 0 } };

    ExpenseDB.getExpenses().forEach(e => {
      const v = e.paymentMethod;
      if (!v) return;
      // 全局层
      stats.global.counts[v] = (stats.global.counts[v] || 0) + 1;
      stats.global.total++;
      const catId = e.categoryId;
      if (!catId) return;
      // 精确分类层
      if (!stats.direct[catId]) stats.direct[catId] = { counts: {}, total: 0 };
      stats.direct[catId].counts[v] = (stats.direct[catId].counts[v] || 0) + 1;
      stats.direct[catId].total++;
      // 父级层：账单挂在父分类自己或任一子分类，都计入该父级
      const pid = parentOf[catId] || (parentSet.has(catId) ? catId : null);
      if (pid) {
        if (!stats.parent[pid]) stats.parent[pid] = { counts: {}, total: 0 };
        stats.parent[pid].counts[v] = (stats.parent[pid].counts[v] || 0) + 1;
        stats.parent[pid].total++;
      }
    });
    return stats;
  }

  /** 在某一层统计中找占比 ≥70% 且样本 ≥5 的项；没有则空串（与原 _guessHabit 判定完全一致） */
  function pickByThreshold(layer, values) {
    if (layer.total < 5) return '';
    for (const v of values) {
      if ((layer.counts[v] || 0) / layer.total >= 0.7) return v;
    }
    return '';
  }

  /** 按回退链逐层猜习惯：选中分类 → 父分类（含其所有子分类）→ 全局 → 空串（不猜） */
  function guessForCategory(categoryId, values, pick) {
    // 统计缓存：账单只在数据变更时重建，避免每次选分类都全量遍历
    if (!_habitStatsCache) _habitStatsCache = buildStats();
    const stats = _habitStatsCache;
    if (categoryId) {
      const cat = ExpenseDB.getActiveCategory(categoryId);
      // 第一层：选中的具体分类（如"外卖"）
      if (stats.direct[categoryId]) {
        const direct = pickByThreshold(stats.direct[categoryId], values);
        if (direct) return direct;
      }
      // 第二层：父分类及其全部子分类（如"餐饮"下所有账单，样本更足）
      if (cat && cat.parentId && stats.parent[cat.parentId]) {
        const parentHit = pickByThreshold(stats.parent[cat.parentId], values);
        if (parentHit) return parentHit;
      }
    }
    // 第三层：全局习惯
    return pickByThreshold(stats.global, values);
  }

  return { invalidate, buildStats, pickByThreshold, guessForCategory };
})();
