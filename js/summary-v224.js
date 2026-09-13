/* 消费摘要的只读工具：日历区间、按分求和、精确金额展示。
 * 不读取或写入存储；首页、统计和月报适配层共用同一比较口径。 */
const ExpenseSummary = (() => {
  'use strict';

  function ymd(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function shiftDays(value, offset) {
    const [year, month, day] = value.split('-').map(Number);
    return ymd(new Date(year, month - 1, day + offset));
  }

  // 先定位目标月份，再截断日号，避免 3 月 31 日减一月又溢出到 3 月。
  function shiftMonths(value, offset) {
    const [year, month, day] = value.split('-').map(Number);
    const lastDay = new Date(year, month + offset, 0).getDate();
    return ymd(new Date(year, month - 1 + offset, Math.min(day, lastDay)));
  }

  function periodRange(period, today) {
    if (period === 'day') return { from: today, to: today };
    if (period === 'week') return { from: shiftDays(today, -6), to: today };
    const months = period === '3month' ? 3 : period === '12month' ? 12 : 1;
    return { from: shiftMonths(today.slice(0, 7) + '-01', 1 - months), to: today };
  }

  function comparisonRange(period, from, to) {
    if (period === 'day' || period === 'week') {
      const days = period === 'day' ? -1 : -7;
      return { from: shiftDays(from, days), to: shiftDays(to, days) };
    }
    const months = period === '3month' ? 3 : period === '12month' ? 12 : 1;
    return { from: shiftMonths(from, -months), to: shiftMonths(to, -months) };
  }

  // UTC 只用于计算日历天数，避免夏令时切换把 7 天算成 8 天。
  function dayCount(from, to) {
    const stamp = value => { const [y, m, d] = value.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.max(1, Math.round((stamp(to) - stamp(from)) / 86400000) + 1);
  }

  function toCents(amount) { return Math.round(Number(amount) * 100); }
  function sumCents(expenses) { return expenses.reduce((sum, item) => sum + toCents(item.amount), 0); }
  function money(cents) {
    return (Math.round(cents) / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function changePct(currentCents, previousCents) {
    return previousCents > 0 ? (Math.round((currentCents - previousCents) / previousCents * 100) || 0) : null;
  }
  function dateLabel(value, today) {
    const [year, month, day] = value.split('-').map(Number);
    return `${String(year) === today.slice(0, 4) ? '' : year + '年'}${month}月${day}日`;
  }

  return { ymd, shiftDays, shiftMonths, periodRange, comparisonRange, dayCount, toCents, sumCents, money, changePct, dateLabel };
})();
