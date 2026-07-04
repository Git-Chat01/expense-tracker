/* ================================================================
   消费轨迹系统 — storage.js
   ExpenseDB 命名空间：localStorage CRUD 操作
   管理 expenses / categories / budget / settings 四类数据
   ================================================================ */

const ExpenseDB = (() => {
  'use strict';

  /* -----------------------------------------------------------------
     localStorage 键名前缀，统一命名空间避免冲突
     ----------------------------------------------------------------- */
  const KEYS = {
    expenses:   'expense_tracker_expenses',
    categories: 'expense_tracker_categories',
    budget:     'expense_tracker_budget',
    settings:   'expense_tracker_settings',
  };

  /* -----------------------------------------------------------------
     通用工具：生成唯一 ID
     crypto.randomUUID() 在现代浏览器中可用，回退方案用时间戳 + 随机数
     ----------------------------------------------------------------- */
  function _generateId() {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return crypto.randomUUID();
    }
    // 回退方案：时间戳(36进制) + 8位随机字符串
    const time = Date.now().toString(36);
    const rand = Math.random().toString(36).substring(2, 10);
    return `${time}-${rand}`;
  }

  /* -----------------------------------------------------------------
     通用工具：读/写 localStorage，带 JSON 序列化
     ----------------------------------------------------------------- */
  function _read(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.error(`[ExpenseDB] 读取 "${key}" 失败:`, e);
      return null;
    }
  }

  function _write(key, data) {
    try {
      localStorage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error(`[ExpenseDB] 写入 "${key}" 失败:`, e);
      return false;
    }
  }

  /* =================================================================
     Expenses — 消费记录 CRUD
     ================================================================= */

  /**
   * 获取全部消费记录
   * @returns {Array} 按 date+time 降序排列
   */
  function getExpenses() {
    const list = _read(KEYS.expenses) || [];
    // 降序排列：最新的在前
    list.sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date);
      if (dateCmp !== 0) return dateCmp;
      return (b.time || '').localeCompare(a.time || '');
    });
    return list;
  }

  /**
   * 根据 ID 获取单条记录
   * @param {string} id
   * @returns {Object|null}
   */
  function getExpense(id) {
    const list = _read(KEYS.expenses) || [];
    return list.find(e => e.id === id) || null;
  }

  /**
   * 按日期范围筛选消费记录
   * @param {string} from - YYYY-MM-DD（含）
   * @param {string} to   - YYYY-MM-DD（含）
   * @returns {Array}
   */
  function getExpensesByDateRange(from, to) {
    const list = _read(KEYS.expenses) || [];
    return list.filter(e => e.date >= from && e.date <= to)
      .sort((a, b) => {
        const dateCmp = b.date.localeCompare(a.date);
        if (dateCmp !== 0) return dateCmp;
        return (b.time || '').localeCompare(a.time || '');
      });
  }

  /**
   * 添加消费记录
   * 自动生成 id 和 createdAt，对缺失字段补默认值
   * @param {Object} expense - 消费数据（不含 id 和 createdAt）
   * @returns {Object} 保存后的完整记录
   */
  function addExpense(expense) {
    const list = _read(KEYS.expenses) || [];

    // 补全默认值，保证数据结构完整
    const record = {
      id:           _generateId(),
      amount:       Number(expense.amount) || 0,
      categoryId:   expense.categoryId || '',
      date:         expense.date || _today(),
      time:         expense.time || _now(),
      location:     expense.location || '',
      locationType: expense.locationType || '',
      paymentMethod:expense.paymentMethod || '',
      note:         expense.note || '',
      createdAt:    new Date().toISOString(),
    };

    list.push(record);
    _write(KEYS.expenses, list);
    return record;
  }

  /**
   * 更新消费记录
   * @param {string} id
   * @param {Object} updates - 要更新的字段
   * @returns {Object|null} 更新后的记录，找不到返回 null
   */
  function updateExpense(id, updates) {
    const list = _read(KEYS.expenses) || [];
    const idx = list.findIndex(e => e.id === id);
    if (idx === -1) return null;

    // 合并更新，但保护 id 和 createdAt 不被覆盖
    const { id: _id, createdAt: _createdAt, ...safeUpdates } = updates;
    list[idx] = { ...list[idx], ...safeUpdates };
    _write(KEYS.expenses, list);
    return list[idx];
  }

  /**
   * 删除消费记录
   * @param {string} id
   * @returns {boolean} 是否删除成功
   */
  function deleteExpense(id) {
    const list = _read(KEYS.expenses) || [];
    const filtered = list.filter(e => e.id !== id);
    if (filtered.length === list.length) return false;
    _write(KEYS.expenses, filtered);
    return true;
  }

  /**
   * 获取总记录数
   * @returns {number}
   */
  function getExpenseCount() {
    const list = _read(KEYS.expenses) || [];
    return list.length;
  }

  /* =================================================================
     Categories — 消费分类 CRUD
     ================================================================= */

  /**
   * 获取全部分类（平铺数组，parentId 建立父子关系）
   * @returns {Array}
   */
  function getCategories() {
    const list = _read(KEYS.categories) || [];
    list.sort((a, b) => (a.order || 0) - (b.order || 0));
    return list;
  }

  /**
   * 根据 ID 获取单个分类
   * @param {string} id
   * @returns {Object|null}
   */
  function getCategory(id) {
    const list = _read(KEYS.categories) || [];
    return list.find(c => c.id === id) || null;
  }

  /**
   * 获取一级分类（parentId 为 null）
   * @returns {Array}
   */
  function getParentCategories() {
    const list = _read(KEYS.categories) || [];
    return list
      .filter(c => !c.parentId || c.parentId === 'null')
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /**
   * 获取某个分类的子分类
   * @param {string} parentId
   * @returns {Array}
   */
  function getChildCategories(parentId) {
    const list = _read(KEYS.categories) || [];
    return list
      .filter(c => c.parentId === parentId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  /**
   * 添加自定义分类
   * @param {Object} category
   * @returns {Object}
   */
  function addCategory(category) {
    const list = _read(KEYS.categories) || [];
    const record = {
      id:       category.id || _generateId(),
      name:     category.name,
      icon:     category.icon || '📌',
      parentId: category.parentId || null,
      isPreset: false,
      order:    list.length,
    };
    list.push(record);
    _write(KEYS.categories, list);
    return record;
  }

  /**
   * 删除自定义分类（预设分类不可删）
   * @param {string} id
   * @returns {boolean}
   */
  function deleteCategory(id) {
    const list = _read(KEYS.categories) || [];
    const target = list.find(c => c.id === id);
    if (!target || target.isPreset) return false;
    _write(KEYS.categories, list.filter(c => c.id !== id));
    return true;
  }

  /**
   * 初始化分类数据（仅在无数据时写入预设）
   */
  function initCategories(presets) {
    const existing = _read(KEYS.categories);
    if (existing && existing.length > 0) return;
    _write(KEYS.categories, presets);
  }

  /**
   * 同步预设分类：更新已有预设的 icon/name/order，新增不存在的预设
   * 绝不删除任何分类，绝不修改用户自定义分类（isPreset=false）
   * 这样后续更新图标/名称时不会丢失用户的消费数据
   */
  function syncPresetCategories(presets) {
    const existing = _read(KEYS.categories) || [];
    if (existing.length === 0) {
      // 无数据 → 直接写入全部预设
      _write(KEYS.categories, presets);
      return;
    }

    // 以预设数据为准，合并更新
    const existingMap = new Map(existing.map(c => [c.id, c]));
    let changed = false;

    presets.forEach(preset => {
      const curr = existingMap.get(preset.id);
      if (!curr) {
        // 新预设分类 → 追加
        existing.push({ ...preset });
        changed = true;
      } else if (curr.isPreset) {
        // 已存在的预设 → 更新 icon/name/order（保留用户的 isPreset 标记）
        if (curr.icon !== preset.icon || curr.name !== preset.name || curr.order !== preset.order) {
          curr.icon = preset.icon;
          curr.name = preset.name;
          curr.order = preset.order;
          changed = true;
        }
      }
      // curr.isPreset === false → 用户自定义，不修改
    });

    if (changed) {
      existing.sort((a, b) => (a.order || 0) - (b.order || 0));
      _write(KEYS.categories, existing);
    }
  }

  /* =================================================================
     Budget — 预算管理
     ================================================================= */

  /**
   * 获取预算配置
   * @returns {Object} { monthlyTotal, categories }
   */
  function getBudget() {
    return _read(KEYS.budget) || { monthlyTotal: 0, categories: {} };
  }

  /**
   * 保存预算配置
   * @param {Object} budget
   */
  function saveBudget(budget) {
    _write(KEYS.budget, budget);
  }

  /**
   * 计算某分类当月已消费金额
   * @param {string} categoryId - 分类 ID（含子分类自动汇总）
   * @param {string} [yearMonth] - YYYY-MM，默认当月
   * @returns {number}
   */
  function getCategorySpent(categoryId, yearMonth) {
    const ym = yearMonth || _yearMonth();
    const expenses = _read(KEYS.expenses) || [];

    // 收集该分类 ID 及所有子分类 ID
    const childIds = getChildCategories(categoryId).map(c => c.id);
    const allIds = [categoryId, ...childIds];

    return expenses
      .filter(e => allIds.includes(e.categoryId) && e.date.startsWith(ym))
      .reduce((sum, e) => sum + e.amount, 0);
  }

  /**
   * 计算当月总消费
   * @param {string} [yearMonth] - YYYY-MM
   * @returns {number}
   */
  function getMonthTotal(yearMonth) {
    const ym = yearMonth || _yearMonth();
    const expenses = _read(KEYS.expenses) || [];
    return expenses
      .filter(e => e.date.startsWith(ym))
      .reduce((sum, e) => sum + e.amount, 0);
  }

  /**
   * 计算当日总消费
   * @param {string} [date] - YYYY-MM-DD
   * @returns {number}
   */
  function getDayTotal(date) {
    const d = date || _today();
    const expenses = _read(KEYS.expenses) || [];
    return expenses
      .filter(e => e.date === d)
      .reduce((sum, e) => sum + e.amount, 0);
  }

  /* =================================================================
     Settings — 应用设置
     ================================================================= */

  /**
   * 获取设置
   * @returns {Object}
   */
  function getSettings() {
    return _read(KEYS.settings) || { currency: '¥', theme: 'light' };
  }

  /**
   * 保存设置
   * @param {Object} settings
   */
  function saveSettings(settings) {
    const current = getSettings();
    _write(KEYS.settings, { ...current, ...settings });
  }

  /* =================================================================
     数据管理
     ================================================================= */

  /**
   * 导出全部数据（备份用）
   * @returns {Object}
   */
  function exportAll() {
    return {
      version:    1,                       // 数据格式版本，用于未来兼容
      expenses:   _read(KEYS.expenses) || [],
      categories: _read(KEYS.categories) || [],
      budget:     _read(KEYS.budget) || { monthlyTotal: 0, categories: {} },
      settings:   _read(KEYS.settings) || {},
      exportedAt: new Date().toISOString(),
    };
  }

  /**
   * 从备份文件导入数据
   * 执行前需确认：会完全替换当前数据，不可撤销
   * @param {Object} data - exportAll 产出的 JSON 对象
   * @returns {{ success: boolean, message: string, counts: object }}
   */
  function importAll(data) {
    // 校验数据结构完整性
    if (!data || typeof data !== 'object') {
      return { success: false, message: '无效的备份文件：数据格式错误', counts: null };
    }
    if (!Array.isArray(data.expenses)) {
      return { success: false, message: '无效的备份文件：缺少消费记录', counts: null };
    }
    if (!Array.isArray(data.categories) || data.categories.length === 0) {
      return { success: false, message: '无效的备份文件：缺少分类数据', counts: null };
    }

    // 校验每条 expense 必填字段
    for (const e of data.expenses) {
      if (!e.id || !e.amount || !e.categoryId || !e.date) {
        return { success: false, message: '无效的备份文件：消费记录字段缺失', counts: null };
      }
    }

    // 写入前先备份当前数据（防止误操作，可手动恢复）
    const currentBackup = exportAll();
    try {
      localStorage.setItem('expense_tracker_pre_import_backup', JSON.stringify(currentBackup));
    } catch (_) { /* 兜底备份写入失败不阻塞导入 */ }

    // 执行导入
    _write(KEYS.expenses, data.expenses);
    _write(KEYS.categories, data.categories);
    _write(KEYS.budget, data.budget || { monthlyTotal: 0, categories: {} });
    _write(KEYS.settings, data.settings || {});

    // 记录备份时间
    _recordBackup();

    return {
      success: true,
      message: `导入成功！${data.expenses.length} 条记录，${data.categories.length} 个分类`,
      counts: {
        expenses: data.expenses.length,
        categories: data.categories.length,
      },
    };
  }

  /**
   * 记录最近一次备份时间（导出时调用）
   */
  function _recordBackup() {
    try {
      localStorage.setItem('expense_tracker_last_backup', new Date().toISOString());
    } catch (_) { /* 静默 */ }
  }

  /**
   * 获取最近一次备份时间，返回 null 表示从未备份
   * @returns {string|null} ISO 时间字符串
   */
  function getLastBackupTime() {
    return localStorage.getItem('expense_tracker_last_backup') || null;
  }

  /**
   * 记录最近一次备份时间（导出/导入成功时由调用方触发）
   */
  function recordBackupTime() {
    _recordBackup();
  }

  /**
   * 清空全部数据（危险操作）
   */
  function clearAll() {
    Object.values(KEYS).forEach(k => localStorage.removeItem(k));
  }

  /* =================================================================
     内部工具函数
     ================================================================= */

  /** 返回今天的日期字符串 YYYY-MM-DD */
  function _today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 返回当前时间字符串 HH:MM */
  function _now() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** 返回当前月份字符串 YYYY-MM */
  function _yearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /* =================================================================
     公开 API
     ================================================================= */
  return {
    // Expenses
    getExpenses,
    getExpense,
    getExpensesByDateRange,
    addExpense,
    updateExpense,
    deleteExpense,
    getExpenseCount,

    // Categories
    getCategories,
    getCategory,
    getParentCategories,
    getChildCategories,
    addCategory,
    deleteCategory,
    initCategories,
    syncPresetCategories,

    // Budget
    getBudget,
    saveBudget,
    getCategorySpent,
    getMonthTotal,
    getDayTotal,

    // Settings
    getSettings,
    saveSettings,

    // Data management
    exportAll,
    importAll,
    getLastBackupTime,
    recordBackupTime,
    clearAll,
  };
})();
