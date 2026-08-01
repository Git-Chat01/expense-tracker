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
    // 降序排列：最新的在前（浅拷贝后排序，避免副作用）
    return [...list].sort((a, b) => {
      const dateCmp = b.date.localeCompare(a.date);
      if (dateCmp !== 0) return dateCmp;
      return (b.time || '').localeCompare(a.time || '');
    });
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
   * @returns {Object|null} 保存后的完整记录，写入失败返回 null
   */
  function addExpense(expense) {
    const list = _read(KEYS.expenses) || [];

    // 补全默认值，保证数据结构完整
    const record = {
      id:           _generateId(),
      amount:       Number(expense.amount) || 0,
      categoryId:   expense.categoryId || '',
      date:         expense.date || today(),
      time:         expense.time || now(),
      location:     expense.location || '',
      paymentMethod:expense.paymentMethod || '',
      note:         expense.note || '',
      createdAt:    new Date().toISOString(),
    };

    list.push(record);
    return _write(KEYS.expenses, list) ? record : null;
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
    return _write(KEYS.expenses, list) ? list[idx] : null;
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
    return _write(KEYS.expenses, filtered);
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
   * @returns {Object|null} 写入失败返回 null
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
    return _write(KEYS.categories, list) ? record : null;
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
    return _write(KEYS.categories, list.filter(c => c.id !== id));
  }

  /**
   * 初始化分类数据（仅在无数据时写入预设）
   */
  function initCategories(presets) {
    const existing = _read(KEYS.categories);
    if (existing && existing.length > 0) return true;
    return _write(KEYS.categories, presets);
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
      return _write(KEYS.categories, presets);
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
      return _write(KEYS.categories, existing);
    }
    return true;
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
    return _write(KEYS.budget, budget);
  }

  /**
   * 计算某分类当月已消费金额
   * @param {string} categoryId - 分类 ID（含子分类自动汇总）
   * @param {string} [yearMonth] - YYYY-MM，默认当月
   * @returns {number}
   */
  function getCategorySpent(categoryId, month) {
    const ym = month || yearMonth();
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
  function getMonthTotal(month) {
    const ym = month || yearMonth();
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
    const d = date || today();
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
    return _write(KEYS.settings, { ...current, ...settings });
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
      version:    2,                       // 数据格式版本，用于未来兼容
      expenses:   _read(KEYS.expenses) || [],
      categories: _read(KEYS.categories) || [],
      budget:     _read(KEYS.budget) || { monthlyTotal: 0, categories: {} },
      settings:   _read(KEYS.settings) || {},
      exportedAt: new Date().toISOString(),
    };
  }

  const _IMPORT_VERSION = 2;
  const _UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

  function _importError(message) {
    return { success: false, message: `无效的备份文件：${message}`, counts: null };
  }

  function _isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function _isNonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function _isValidDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    return parsed.getFullYear() === year
      && parsed.getMonth() === month - 1
      && parsed.getDate() === day;
  }

  function _isValidTime(value) {
    return value === '' || (typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value));
  }

  function _isValidIsoTimestamp(value) {
    if (typeof value !== 'string') return false;
    const timestamp = Date.parse(value);
    return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
  }

  function _cloneSafeJson(value) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) {
        const cloned = _cloneSafeJson(item);
        if (cloned === undefined) return undefined;
        items.push(cloned);
      }
      return items;
    }
    if (_isPlainObject(value)) {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (_UNSAFE_OBJECT_KEYS.has(key)) continue;
        const cloned = _cloneSafeJson(item);
        if (cloned === undefined) return undefined;
        result[key] = cloned;
      }
      return result;
    }
    return undefined;
  }

  function _validateImport(data) {
    if (!_isPlainObject(data)) return _importError('数据格式错误');
    if (data.version != null
        && (!Number.isInteger(data.version) || data.version < 1 || data.version > _IMPORT_VERSION)) {
      return _importError(data.version > _IMPORT_VERSION ? '备份版本过新，请先更新应用' : '版本号错误');
    }
    if (data.exportedAt != null && !_isValidIsoTimestamp(data.exportedAt)) {
      return _importError('导出时间格式错误');
    }
    if (!Array.isArray(data.expenses)) return _importError('缺少消费记录');
    if (!Array.isArray(data.categories) || data.categories.length === 0) return _importError('缺少分类数据');

    const categoryIds = new Set();
    const categories = [];
    for (const category of data.categories) {
      if (!_isPlainObject(category)
          || !_isNonEmptyString(category.id)
          || !_isNonEmptyString(category.name)
          || _UNSAFE_OBJECT_KEYS.has(category.id)
          || (category.icon != null && typeof category.icon !== 'string')
          || (category.parentId != null && !_isNonEmptyString(category.parentId))
          || (category.isPreset != null && typeof category.isPreset !== 'boolean')
          || (category.order != null && !Number.isFinite(category.order))) {
        return _importError('分类数据格式错误');
      }
      if (categoryIds.has(category.id)) return _importError('存在重复的分类 ID');
      categoryIds.add(category.id);
      categories.push({
        id: category.id,
        name: category.name,
        icon: category.icon || '📌',
        parentId: category.parentId || null,
        isPreset: category.isPreset === true,
        order: Number.isFinite(category.order) ? category.order : categories.length,
      });
    }

    const categoryMap = new Map(categories.map(category => [category.id, category]));
    for (const category of categories) {
      if (!category.parentId) continue;
      const parent = categoryMap.get(category.parentId);
      if (!parent || parent.parentId) return _importError('分类层级引用无效');
    }

    const expenseIds = new Set();
    const expenses = [];
    for (const expense of data.expenses) {
      if (!_isPlainObject(expense)
          || !_isNonEmptyString(expense.id)
          || _UNSAFE_OBJECT_KEYS.has(expense.id)
          || !Number.isFinite(expense.amount)
          || expense.amount <= 0
          || !_isNonEmptyString(expense.categoryId)
          || !categoryIds.has(expense.categoryId)
          || !_isValidDate(expense.date)
          || (expense.time != null && !_isValidTime(expense.time))
          || (expense.location != null && typeof expense.location !== 'string')
          || (expense.paymentMethod != null && typeof expense.paymentMethod !== 'string')
          || (expense.note != null && typeof expense.note !== 'string')
          || (expense.createdAt != null && !_isValidIsoTimestamp(expense.createdAt))) {
        return _importError('消费记录格式或分类引用错误');
      }
      if (expenseIds.has(expense.id)) return _importError('存在重复的消费记录 ID');
      expenseIds.add(expense.id);
      expenses.push({
        id: expense.id,
        amount: expense.amount,
        categoryId: expense.categoryId,
        date: expense.date,
        time: expense.time || '',
        location: expense.location || '',
        paymentMethod: expense.paymentMethod || '',
        note: expense.note || '',
        createdAt: expense.createdAt || new Date().toISOString(),
      });
    }

    const sourceBudget = data.budget == null ? { monthlyTotal: 0, categories: {} } : data.budget;
    if (!_isPlainObject(sourceBudget)
        || !Number.isFinite(Number(sourceBudget.monthlyTotal || 0))
        || Number(sourceBudget.monthlyTotal || 0) < 0
        || (sourceBudget.categories != null && !_isPlainObject(sourceBudget.categories))) {
      return _importError('预算数据格式错误');
    }
    const categoryBudgets = {};
    for (const [categoryId, amount] of Object.entries(sourceBudget.categories || {})) {
      if (_UNSAFE_OBJECT_KEYS.has(categoryId)
          || !categoryIds.has(categoryId)
          || !Number.isFinite(amount)
          || amount < 0) {
        return _importError('分类预算格式或引用错误');
      }
      categoryBudgets[categoryId] = amount;
    }

    const sourceSettings = data.settings == null ? {} : data.settings;
    if (!_isPlainObject(sourceSettings)) return _importError('设置数据格式错误');
    if ((sourceSettings.onboardingSeen != null && typeof sourceSettings.onboardingSeen !== 'boolean')
        || (sourceSettings.currency != null && typeof sourceSettings.currency !== 'string')
        || (sourceSettings.theme != null && typeof sourceSettings.theme !== 'string')
        || (sourceSettings.pinnedQuickCategoryIds != null
          && (!Array.isArray(sourceSettings.pinnedQuickCategoryIds)
            || sourceSettings.pinnedQuickCategoryIds.some(id => typeof id !== 'string')))) {
      return _importError('设置字段类型错误');
    }
    const settings = _cloneSafeJson(sourceSettings);
    if (settings === undefined) return _importError('设置数据包含不支持的值');
    if (Array.isArray(settings.pinnedQuickCategoryIds)) {
      settings.pinnedQuickCategoryIds = [...new Set(settings.pinnedQuickCategoryIds)]
        .filter(id => typeof id === 'string' && categoryIds.has(id))
        .slice(0, 4);
    }

    return {
      success: true,
      data: {
        expenses,
        categories,
        budget: { monthlyTotal: Number(sourceBudget.monthlyTotal || 0), categories: categoryBudgets },
        settings,
      },
    };
  }

  function _restoreImportSnapshot(snapshot, writtenKeys) {
    let restored = true;
    for (const key of writtenKeys) {
      if (!_write(KEYS[key], snapshot[key])) restored = false;
    }
    return restored;
  }

  /**
   * 从备份文件导入数据
   * 执行前需确认：会完全替换当前数据，不可撤销
   * @param {Object} data - exportAll 产出的 JSON 对象
   * @returns {{ success: boolean, message: string, counts: object }}
   */
  function importAll(data) {
    const validation = _validateImport(data);
    if (!validation.success) return validation;
    const normalized = validation.data;

    // 同时保留内存快照和持久备份：持久备份无法创建时不冒险覆盖原数据。
    const snapshot = {
      expenses: _read(KEYS.expenses) || [],
      categories: _read(KEYS.categories) || [],
      budget: _read(KEYS.budget) || { monthlyTotal: 0, categories: {} },
      settings: _read(KEYS.settings) || {},
    };
    try {
      localStorage.setItem('expense_tracker_pre_import_backup', JSON.stringify(exportAll()));
    } catch (error) {
      console.error('[ExpenseDB] 创建导入前备份失败:', error);
      return { success: false, message: '导入失败：无法创建恢复前备份，请检查浏览器存储空间', counts: null };
    }

    const writes = [
      ['expenses', normalized.expenses],
      ['categories', normalized.categories],
      ['budget', normalized.budget],
      ['settings', normalized.settings],
    ];
    const writtenKeys = [];
    for (const [key, value] of writes) {
      if (_write(KEYS[key], value)) {
        writtenKeys.push(key);
        continue;
      }
      const restored = _restoreImportSnapshot(snapshot, writtenKeys);
      return {
        success: false,
        message: restored
          ? '导入失败：写入未完成，原数据已恢复'
          : '导入失败且自动恢复不完整，请保留页面并使用导入前备份恢复',
        counts: null,
      };
    }

    // 记录备份时间
    _recordBackup();

    return {
      success: true,
      message: `导入成功！${normalized.expenses.length} 条记录，${normalized.categories.length} 个分类`,
      counts: {
        expenses: normalized.expenses.length,
        categories: normalized.categories.length,
      },
    };
  }

  /**
   * 记录最近一次备份时间（导出时调用）
   */
  function _recordBackup() {
    try {
      localStorage.setItem('expense_tracker_last_backup', new Date().toISOString());
      return true;
    } catch (_) {
      return false;
    }
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
    return _recordBackup();
  }

  /**
   * 清空全部数据（危险操作）
   */
  function clearAll() {
    Object.values(KEYS).forEach(k => localStorage.removeItem(k));
  }

  /* =================================================================
     日期工具函数（公开，供其他模块复用，避免重复定义）
     ================================================================= */

  /** 返回今天的日期字符串 YYYY-MM-DD */
  function today() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 返回当前时间字符串 HH:MM */
  function now() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** 返回当前月份字符串 YYYY-MM */
  function yearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  /** 将 Date 对象转为 YYYY-MM-DD 字符串 */
  function dateToYMD(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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

    // Date utilities
    today,
    now,
    yearMonth,
    dateToYMD,
  };
})();
