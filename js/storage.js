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
  /* 备份与逃生类 key：不参与核心数据读写，但清空数据时必须一并清除，
     避免"已清空"后仍有明文消费数据残留（隐私 + 语义完整性） */
  const BACKUP_KEYS = {
    preImport:   'expense_tracker_pre_import_backup',
    lastBackup:  'expense_tracker_last_backup',
    forceImport: 'expense_tracker_force_import_backup',
  };
  const MAX_MONEY_CENTS = 9_999_999_999;
  const _STRICT_EXPORT_VERSION = 4;
  const _LEGACY_MONEY_EXPORT_VERSION = 3;
  /** updateExpense 允许更新的字段白名单（其余键拒绝，防止 schema 外字段落库） */
  const _EXPENSE_UPDATE_FIELDS = ['amount', 'categoryId', 'date', 'time', 'location', 'paymentMethod', 'necessity', 'note'];
  let _writeBlockedByReadFailure = false;
  let _writeBlockedByCategoryGraphFailure = false;
  let _writeBlockedByDomainFailure = false;

  /* -----------------------------------------------------------------
     只读路径的已解析缓存：以 localStorage 原始字符串为 key，
     内容未变时跳过重复 JSON.parse（统计页按分类循环汇总时收益明显）。
     写路径全部走 _readForMutation（不缓存），写成功后主动清空缓存，
     因此不存在"写失败但缓存被污染"的失效缺口。
     ----------------------------------------------------------------- */
  const _readCache = new Map();
  function _invalidateReadCache() { _readCache.clear(); }

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
  function _isValidStoredExpense(expense) {
    return _isPlainObject(expense)
      && _isNonEmptyString(expense.id)
      && Number.isFinite(expense.amount)
      && expense.amount > 0
      && _isNonEmptyString(expense.categoryId)
      && _isValidDate(expense.date)
      && (expense.time == null || _isValidTime(expense.time))
      && (expense.location == null || typeof expense.location === 'string')
      && (expense.paymentMethod == null || typeof expense.paymentMethod === 'string')
      && (expense.necessity === undefined || _VALID_NECESSITY_VALUES.has(expense.necessity))
      && (expense.note == null || typeof expense.note === 'string')
      && (expense.createdAt == null || _isValidIsoTimestamp(expense.createdAt));
  }

  function _validationError(code, message, field) {
    return {
      ok: false,
      cents: null,
      value: null,
      error: {
        code,
        message,
        ...(field ? { field } : {}),
      },
    };
  }

  function _moneyMessage(code, label, allowZero) {
    if (code === 'MONEY_REQUIRED') return allowZero ? `${label}不能为空` : `请输入大于 ¥0.00 的${label}`;
    if (code === 'MONEY_NOT_FINITE' || code === 'MONEY_INVALID_FORMAT') return `${label}格式不正确，请输入普通数字`;
    if (code === 'MONEY_NEGATIVE') return `${label}不能为负数；不设置请留空或输入 0`;
    if (code === 'MONEY_NON_POSITIVE') return `请输入大于 ¥0.00 的${label}`;
    if (code === 'MONEY_PRECISION') return `${label}最多保留两位小数`;
    if (code === 'MONEY_LIMIT') return `${label}不能超过 ¥99,999,999.99`;
    return `${label}无效`;
  }

  /**
   * 将“元”严格解析为整数分。字符串不接受科学计数法或尾随字符；
   * number 只容忍 IEEE-754 带来的极小二进制误差，不会把三位小数四舍五入。
   */
  function validateMoney(raw, options = {}) {
    const allowEmpty = options.allowEmpty === true || options.allowBlank === true;
    const allowZero = options.allowZero === true;
    const label = options.label || '金额';
    const field = options.field || 'amount';

    if (typeof raw === 'string') {
      const text = raw.trim();
      if (text === '') {
        if (allowEmpty) return { ok: true, cents: 0, value: 0, error: null };
        return _validationError('MONEY_REQUIRED', _moneyMessage('MONEY_REQUIRED', label, allowZero), field);
      }
      if (text.startsWith('-')) {
        return _validationError('MONEY_NEGATIVE', _moneyMessage('MONEY_NEGATIVE', label, allowZero), field);
      }
      const decimalMatch = text.match(/^(?:\d+(?:\.(\d*))?|\.(\d+))$/);
      if (!decimalMatch) {
        return _validationError('MONEY_INVALID_FORMAT', _moneyMessage('MONEY_INVALID_FORMAT', label, allowZero), field);
      }
      const fraction = decimalMatch[1] ?? decimalMatch[2] ?? '';
      if (fraction.length > 2) {
        return _validationError('MONEY_PRECISION', _moneyMessage('MONEY_PRECISION', label, allowZero), field);
      }
      const normalizedText = text.startsWith('.') ? `0${text}` : text;
      const [wholeText, fractionText = ''] = normalizedText.split('.');
      const whole = Number(wholeText);
      if (!Number.isSafeInteger(whole)) {
        return _validationError('MONEY_LIMIT', _moneyMessage('MONEY_LIMIT', label, allowZero), field);
      }
      const cents = (whole * 100) + Number(fractionText.padEnd(2, '0') || 0);
      if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) {
        return _validationError('MONEY_LIMIT', _moneyMessage('MONEY_LIMIT', label, allowZero), field);
      }
      if (cents === 0 && !allowZero) {
        return _validationError('MONEY_NON_POSITIVE', _moneyMessage('MONEY_NON_POSITIVE', label, allowZero), field);
      }
      return { ok: true, cents, value: cents / 100, error: null };
    }

    if (typeof raw !== 'number') {
      return _validationError('MONEY_INVALID_FORMAT', _moneyMessage('MONEY_INVALID_FORMAT', label, allowZero), field);
    }
    if (!Number.isFinite(raw)) {
      return _validationError('MONEY_NOT_FINITE', _moneyMessage('MONEY_NOT_FINITE', label, allowZero), field);
    }
    if (raw < 0) {
      return _validationError('MONEY_NEGATIVE', _moneyMessage('MONEY_NEGATIVE', label, allowZero), field);
    }
    const scaled = raw * 100;
    const cents = Math.round(scaled);
    const tolerance = Math.max(1e-7, Math.abs(scaled) * Number.EPSILON * 8);
    if (Math.abs(scaled - cents) > tolerance) {
      return _validationError('MONEY_PRECISION', _moneyMessage('MONEY_PRECISION', label, allowZero), field);
    }
    if (!Number.isSafeInteger(cents) || cents > MAX_MONEY_CENTS) {
      return _validationError('MONEY_LIMIT', _moneyMessage('MONEY_LIMIT', label, allowZero), field);
    }
    if (cents === 0 && !allowZero) {
      return _validationError('MONEY_NON_POSITIVE', _moneyMessage('MONEY_NON_POSITIVE', label, allowZero), field);
    }
    return { ok: true, cents, value: cents / 100, error: null };
  }

  function _isLegacyMoneyPolicyValue(value, allowZero) {
    return typeof value === 'number'
      && Number.isFinite(value)
      && (allowZero ? value >= 0 : value > 0);
  }

  function _expenseValidationError(code, message, field) {
    return _validationError(code, message, field);
  }

  function _readCategoryIdsForValidation(options) {
    if (options && options.categoryIds) {
      return {
        ok: true,
        ids: new Set(Array.from(options.categoryIds, String)),
        activeIds: options.activeCategoryIds
          ? new Set(Array.from(options.activeCategoryIds, String))
          : null,
      };
    }
    const categoryResult = _readWithStatus(KEYS.categories);
    if (!categoryResult.ok) return { ok: false, ids: new Set(), activeIds: new Set() };
    const categories = categoryResult.exists ? categoryResult.value : [];
    return {
      ok: true,
      ids: new Set(categories.map(category => category.id)),
      activeIds: new Set(categories.filter(_isCategoryActive).map(category => category.id)),
    };
  }

  function validateExpenseDraft(input, options = {}) {
    if (!_isPlainObject(input)) {
      return _expenseValidationError('EXPENSE_INVALID_TYPE', '账单数据格式不正确', 'expense');
    }

    let money = validateMoney(input.amount, { label: '金额', field: 'amount' });
    let legacyMoney = false;
    if (!money.ok
        && options.allowLegacyMoney === true
        && _isLegacyMoneyPolicyValue(input.amount, false)
        && (money.error.code === 'MONEY_PRECISION' || money.error.code === 'MONEY_LIMIT')) {
      money = { ok: true, cents: null, value: input.amount, error: null };
      legacyMoney = true;
    }
    if (!money.ok) return money;

    if (!_isNonEmptyString(input.categoryId)) {
      return _expenseValidationError('EXPENSE_CATEGORY_INVALID', '请选择消费分类', 'categoryId');
    }
    if (options.skipCategoryValidation !== true) {
      const categoryLookup = _readCategoryIdsForValidation(options);
      if (!categoryLookup.ok) {
        return _expenseValidationError('EXPENSE_CATEGORY_INVALID', '无法安全读取分类数据', 'categoryId');
      }
      const allowHistoricalCategory = options.allowHistoricalCategoryId === input.categoryId;
      const categorySet = options.allowHistoricalCategories === true
        ? categoryLookup.ids
        : (categoryLookup.activeIds || categoryLookup.ids);
      if (!allowHistoricalCategory && !categorySet.has(input.categoryId)) {
        return _expenseValidationError('EXPENSE_CATEGORY_INVALID', '所选分类已被删除或失效，请重新选择', 'categoryId');
      }
    }

    if (input.date === '') {
      return _expenseValidationError('EXPENSE_DATE_INVALID', '请选择记账日期', 'date');
    }
    if (!_isValidDate(input.date)) {
      return _expenseValidationError('EXPENSE_DATE_INVALID', '记账日期无效，请重新选择', 'date');
    }

    const time = input.time == null ? '' : input.time;
    if (!_isValidTime(time)) {
      return _expenseValidationError('EXPENSE_TIME_INVALID', '记账时间无效，请重新选择', 'time');
    }
    const paymentMethod = input.paymentMethod === undefined ? '' : input.paymentMethod;
    if (typeof paymentMethod !== 'string' || !_VALID_PAYMENT_METHODS.has(paymentMethod)) {
      return _expenseValidationError('EXPENSE_PAYMENT_METHOD_INVALID', '支付方式无效，请重新选择', 'paymentMethod');
    }
    const necessity = input.necessity === undefined ? '' : input.necessity;
    if (typeof necessity !== 'string' || !_VALID_NECESSITY_VALUES.has(necessity)) {
      return _expenseValidationError('EXPENSE_NECESSITY_INVALID', '价值评定无效，请重新选择', 'necessity');
    }
    const location = input.location == null ? '' : input.location;
    const note = input.note == null ? '' : input.note;
    if (typeof location !== 'string' || typeof note !== 'string') {
      return _expenseValidationError('EXPENSE_TEXT_INVALID', '地点或备注格式不正确', 'note');
    }

    return {
      ok: true,
      cents: money.cents,
      value: {
        amount: money.value,
        categoryId: input.categoryId,
        date: input.date,
        time,
        location,
        paymentMethod,
        necessity,
        note,
      },
      error: null,
      legacyMoney,
    };
  }

  function validateBudgetDraft(input, options = {}) {
    if (!_isPlainObject(input)) {
      return _validationError('BUDGET_INVALID_TYPE', '预算数据格式不正确', 'budget');
    }
    const monthly = validateMoney(input.monthlyTotal ?? '', {
      allowEmpty: true,
      allowZero: true,
      label: '月度总预算',
      field: 'monthlyTotal',
    });
    let monthlyResult = monthly;
    let legacyMoney = false;
    if (!monthlyResult.ok
        && options.allowLegacyMoney === true
        && _isLegacyMoneyPolicyValue(input.monthlyTotal, true)
        && (monthlyResult.error.code === 'MONEY_PRECISION' || monthlyResult.error.code === 'MONEY_LIMIT')) {
      monthlyResult = { ok: true, cents: null, value: input.monthlyTotal, error: null };
      legacyMoney = true;
    }
    if (!monthlyResult.ok) return monthlyResult;

    const sourceCategories = input.categories == null ? {} : input.categories;
    if (!_isPlainObject(sourceCategories)) {
      return _validationError('BUDGET_INVALID_TYPE', '分类预算格式不正确', 'categories');
    }
    const categoryLookup = options.skipCategoryValidation === true
      ? { ok: true, ids: null, activeIds: null }
      : _readCategoryIdsForValidation(options);
    if (!categoryLookup.ok) return _validationError('BUDGET_CATEGORY_INVALID', '无法安全读取分类数据', 'categories');
    const allowedIds = options.skipCategoryValidation === true
      ? null
      : (options.allowHistoricalCategories === true
        ? categoryLookup.ids
        : (categoryLookup.activeIds || categoryLookup.ids));
    const normalizedCategories = {};
    const categoryCents = {};
    for (const [categoryId, rawAmount] of Object.entries(sourceCategories)) {
      if (_UNSAFE_OBJECT_KEYS.has(categoryId)) {
        return _validationError('BUDGET_CATEGORY_INVALID', '分类预算引用了不存在或已删除的分类', `categories.${categoryId}`);
      }
      const referencesMissingCategory = allowedIds && !allowedIds.has(categoryId);
      let result = validateMoney(rawAmount, {
        allowEmpty: true,
        allowZero: true,
        label: `「${categoryId}」预算`,
        field: `categories.${categoryId}`,
      });
      if (referencesMissingCategory && (!result.ok || result.cents !== 0)) {
        // 墓碑/历史分类只允许以 0 显式清除存量预算条目（走删除分支）；
        // 不允许为已删除分类设置新预算值。
        return _validationError('BUDGET_CATEGORY_INVALID', '分类预算引用了不存在或已删除的分类', `categories.${categoryId}`);
      }
      if (!result.ok
          && options.allowLegacyMoney === true
          && _isLegacyMoneyPolicyValue(rawAmount, true)
          && (result.error.code === 'MONEY_PRECISION' || result.error.code === 'MONEY_LIMIT')) {
        result = { ok: true, cents: null, value: rawAmount, error: null };
        legacyMoney = true;
      }
      if (!result.ok) return result;
      normalizedCategories[categoryId] = result.value;
      categoryCents[categoryId] = result.cents;
    }
    return {
      ok: true,
      cents: {
        monthlyTotal: monthlyResult.cents,
        categories: categoryCents,
      },
      value: {
        monthlyTotal: monthlyResult.value,
        categories: normalizedCategories,
      },
      error: null,
      legacyMoney,
    };
  }

  function _normalizeCategoryParentId(parentId) {
    return !parentId || parentId === 'null' ? null : parentId;
  }

  function _isValidStoredCategory(category) {
    return _isPlainObject(category)
      && _isNonEmptyString(category.id)
      && !_UNSAFE_OBJECT_KEYS.has(category.id)
      && _isNonEmptyString(category.name)
      && (category.icon == null || typeof category.icon === 'string')
      && (category.parentId == null || _isNonEmptyString(category.parentId))
      && (category.isPreset == null || typeof category.isPreset === 'boolean')
      && (category.order == null || Number.isFinite(category.order))
      && (category.deletedAt == null || _isValidIsoTimestamp(category.deletedAt));
  }

  function _isValidStoredCategoryGraph(categories) {
    if (!Array.isArray(categories) || !categories.every(_isValidStoredCategory)) return false;
    const categoryMap = new Map();
    for (const category of categories) {
      if (categoryMap.has(category.id)) return false;
      categoryMap.set(category.id, category);
    }
    for (const category of categories) {
      const parentId = _normalizeCategoryParentId(category.parentId);
      if (!parentId) continue;
      if (parentId === category.id) return false;
      const parent = categoryMap.get(parentId);
      if (!parent || _normalizeCategoryParentId(parent.parentId)) return false;
      if (_isCategoryActive(category) && !_isCategoryActive(parent)) return false;
    }
    return true;
  }

  function _isValidStoredStructure(key, value) {
    if (key === KEYS.expenses) return Array.isArray(value) && value.every(_isValidStoredExpense);
    if (key === KEYS.categories) return Array.isArray(value) && value.every(_isValidStoredCategory);
    if (key === KEYS.budget) {
      return _isPlainObject(value)
        && (value.categories === undefined || _isPlainObject(value.categories));
    }
    if (key === KEYS.settings) return _isPlainObject(value);
    return true;
  }

  function _readWithStatus(key) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return { ok: true, exists: false, value: null };
      if (raw.trim() === '') throw new SyntaxError('存储内容为空字符串');
      const value = JSON.parse(raw);
      if (!_isValidStoredStructure(key, value)) throw new TypeError('存储结构无效');
      return { ok: true, exists: true, value };
    } catch (e) {
      _writeBlockedByReadFailure = true;
      console.error(`[ExpenseDB] 读取 "${key}" 失败:`, e);
      return { ok: false, exists: false, value: null };
    }
  }

  function _read(key) {
    // 先取原始字符串做缓存比对；getItem 本身失败时退回 _readWithStatus 统一处理。
    let raw = null;
    try {
      raw = localStorage.getItem(key);
    } catch (e) {
      return _readWithStatus(key).value;
    }
    if (raw !== null) {
      const cached = _readCache.get(key);
      if (cached && cached.raw === raw) {
        // 浅拷贝返回：调用方 sort/filter/push 不会污染缓存
        // （元素对象仍共享引用；只读 API 约定不修改元素本身）。
        return Array.isArray(cached.value) ? cached.value.slice() : { ...cached.value };
      }
    }
    const result = _readWithStatus(key);
    if (result.ok && result.exists) {
      _readCache.set(key, { raw, value: result.value });
    }
    return result.value;
  }

  function _validateStoredDomainForKey(key, value) {
    if (key === KEYS.expenses) {
      for (const expense of value) {
        const result = validateExpenseDraft(expense, {
          allowLegacyMoney: true,
          skipCategoryValidation: true,
        });
        if (!result.ok) return result;
      }
    }
    if (key === KEYS.budget) {
      return validateBudgetDraft(value, {
        allowLegacyMoney: true,
        skipCategoryValidation: true,
      });
    }
    return { ok: true, value, error: null };
  }

  /** 写操作专用读取：只有键不存在时才使用默认值，读取异常必须显式失败。 */
  function _readForMutation(key, defaultValue) {
    const result = _readWithStatus(key);
    if (!result.ok) return result;
    if (key === KEYS.categories && result.exists && !_isValidStoredCategoryGraph(result.value)) {
      _writeBlockedByCategoryGraphFailure = true;
      console.error('[ExpenseDB] 分类关系图无效，已停止写入');
      return { ok: false, exists: true, value: null };
    }
    if (result.exists) {
      const domainResult = _validateStoredDomainForKey(key, result.value);
      if (!domainResult.ok) {
        _writeBlockedByDomainFailure = true;
        console.error(`[ExpenseDB] "${key}" 领域数据无效，已停止写入:`, domainResult.error);
        return { ok: false, exists: true, value: null };
      }
    }
    return {
      ok: true,
      exists: result.exists,
      value: result.exists ? result.value : defaultValue,
    };
  }

  function _write(key, data) {
    if (_writeBlockedByReadFailure || _writeBlockedByCategoryGraphFailure || _writeBlockedByDomainFailure) {
      console.error(`[ExpenseDB] 已因核心数据读取失败阻止写入 "${key}"`);
      return false;
    }
    try {
      localStorage.setItem(key, JSON.stringify(data));
      _invalidateReadCache();
      return true;
    } catch (e) {
      console.error(`[ExpenseDB] 写入 "${key}" 失败:`, e);
      return false;
    }
  }

  /* -----------------------------------------------------------------
     写锁逃生通道（2026-08-12 修复"锁死无出路"高危问题）

     fail-closed 写锁保护数据不被覆盖，但必须给用户留恢复路径：
     1. exportRawRecoveryCopy —— 读失败时按原始字符串导出，保全数据；
     2. importAll(data, { forceRecovery: true }) —— 二次确认后强制覆盖，
        写入前先把四个 key 的原始字符串备份到 forceImport 逃生 key；
     3. _resetWriteBlockFlags —— 仅在两处调用：强制恢复全部写成功后
        （数据已被校验过，健康）、clearAll 后（用户明确选择清空）。
     正常写入路径永不调用它，写锁的防线地位不变。
     ----------------------------------------------------------------- */

  /** 复位全部写锁。仅限数据已恢复健康（强制恢复成功 / clearAll）时调用。 */
  function _resetWriteBlockFlags() {
    _writeBlockedByReadFailure = false;
    _writeBlockedByCategoryGraphFailure = false;
    _writeBlockedByDomainFailure = false;
  }

  /**
   * 绕过写锁的恢复专用写入：仅强制恢复/回滚路径使用。
   * 与 _write 的区别是不做 JSON 序列化——回滚时要逐字节写回原始字符串。
   * 调用前提：目标原始数据已先备份到逃生 key（见 importAll forceRecovery 分支）。
   */
  function _writeForRecovery(key, rawValue) {
    try {
      localStorage.setItem(key, rawValue);
      _invalidateReadCache();
      return true;
    } catch (e) {
      console.error(`[ExpenseDB] 恢复写入 "${key}" 失败:`, e);
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
    const validation = validateExpenseDraft(expense);
    if (!validation.ok) return null;
    const normalized = validation.value;
    const categoryResult = _readForMutation(KEYS.categories, []);
    if (!categoryResult.ok
        || !categoryResult.value.some(category => category.id === normalized.categoryId && _isCategoryActive(category))) {
      return null;
    }
    const readResult = _readForMutation(KEYS.expenses, []);
    if (!readResult.ok) return null;
    const list = readResult.value;

    // 补全默认值，保证数据结构完整
    const record = {
      id:           _generateId(),
      ...normalized,
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
    if (!_isPlainObject(updates)) return null;
    const readResult = _readForMutation(KEYS.expenses, []);
    if (!readResult.ok) return null;
    const list = readResult.value;
    const idx = list.findIndex(e => e.id === id);
    if (idx === -1) return null;

    // 合并更新：只接受白名单字段。id/createdAt 天然被排除（保护不可覆盖），
    // 未知键也不再随 rest 解构混入落库（否则本地存储出现 schema 外字段）。
    const safeUpdates = {};
    for (const key of _EXPENSE_UPDATE_FIELDS) {
      if (key in updates) safeUpdates[key] = updates[key];
    }
    const original = list[idx];
    const candidate = { ...original, ...safeUpdates };
    const validation = validateExpenseDraft(candidate, {
      allowHistoricalCategoryId: original.categoryId,
      allowLegacyMoney: candidate.amount === original.amount,
    });
    if (!validation.ok) return null;

    const changesCategory = candidate.categoryId !== original.categoryId;
    if (changesCategory) {
      const categoryResult = _readForMutation(KEYS.categories, []);
      if (!categoryResult.ok
          || !categoryResult.value.some(category => category.id === candidate.categoryId && _isCategoryActive(category))) {
        return null;
      }
    }

    list[idx] = {
      ...candidate,
      ...validation.value,
      id: original.id,
      createdAt: original.createdAt,
    };
    return _write(KEYS.expenses, list) ? list[idx] : null;
  }

  /**
   * 删除消费记录
   * @param {string} id
   * @returns {boolean} 是否删除成功
   */
  function deleteExpense(id) {
    const readResult = _readForMutation(KEYS.expenses, []);
    if (!readResult.ok) return false;
    const list = readResult.value;
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

  function _isCategoryActive(category) {
    return Boolean(category) && !category.deletedAt;
  }

  function _isTopLevelCategory(category) {
    return _isCategoryActive(category) && !_normalizeCategoryParentId(category.parentId);
  }

  /**
   * 获取全部分类（平铺数组，parentId 建立父子关系）
   * @returns {Array}
   */
  function getCategories() {
    const list = _read(KEYS.categories) || [];
    return list
      .filter(_isCategoryActive)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
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
   * 根据 ID 获取仍可用于新记账/分类管理的活动分类。
   * getCategory() 刻意保留墓碑查询能力，供历史账单显示原分类名称。
   * @param {string} id
   * @returns {Object|null}
   */
  function getActiveCategory(id) {
    const category = getCategory(id);
    return _isCategoryActive(category) ? category : null;
  }

  /**
   * 获取一级分类（parentId 为 null）
   * @returns {Array}
   */
  function getParentCategories() {
    const list = _read(KEYS.categories) || [];
    return list
      .filter(_isTopLevelCategory)
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
      .filter(c => _isCategoryActive(c) && c.parentId === parentId)
      .sort((a, b) => (a.order || 0) - (b.order || 0));
  }

  function _validateCategoryParentInList(list, categoryId, parentId) {
    const normalizedParentId = _normalizeCategoryParentId(parentId);
    const hasChildren = Boolean(categoryId) && list.some(c => c.parentId === categoryId);
    if (!normalizedParentId) return { valid: true, code: null, hasChildren };
    if (categoryId && normalizedParentId === categoryId) {
      return { valid: false, code: 'SELF_PARENT', hasChildren };
    }
    if (hasChildren) {
      return { valid: false, code: 'CATEGORY_HAS_CHILDREN', hasChildren };
    }
    const parent = list.find(c => c.id === normalizedParentId);
    if (!_isCategoryActive(parent)) {
      return { valid: false, code: 'PARENT_UNAVAILABLE', hasChildren };
    }
    if (!_isTopLevelCategory(parent)) {
      return { valid: false, code: 'PARENT_NOT_TOP_LEVEL', hasChildren };
    }
    return { valid: true, code: null, hasChildren };
  }

  /** 保存前重新验证父级，避免跨标签页产生孤儿、三层或环。 */
  function validateCategoryParent(categoryId, parentId) {
    const readResult = _readWithStatus(KEYS.categories);
    if (!readResult.ok
        || (readResult.exists && !_isValidStoredCategoryGraph(readResult.value))) {
      if (readResult.ok) _writeBlockedByCategoryGraphFailure = true;
      return { valid: false, code: 'READ_FAILURE', hasChildren: false };
    }
    return _validateCategoryParentInList(
      readResult.exists ? readResult.value : [],
      categoryId || null,
      parentId || null,
    );
  }

  /**
   * 添加自定义分类
   * @param {Object} category
   * @returns {Object|null} 写入失败返回 null
   */
  function addCategory(category) {
    const readResult = _readForMutation(KEYS.categories, []);
    if (!readResult.ok) return null;
    const list = readResult.value;
    const id = category.id || _generateId();
    const parentId = category.parentId || null;
    if (list.some(item => item.id === id)) return null;
    if (!_validateCategoryParentInList(list, id, parentId).valid) return null;
    const record = {
      id,
      name:     category.name,
      icon:     category.icon || '📌',
      parentId,
      isPreset: false,
      order:    list.length,
    };
    list.push(record);
    if (!_isValidStoredCategoryGraph(list)) return null;
    return _write(KEYS.categories, list) ? record : null;
  }

  /**
   * 软删除自定义分类（预设分类不可删）。分类记录作为墓碑保留，
   * 让历史账单 categoryId 与应用自己导出的备份始终可恢复；UI getter 会隐藏墓碑。
   * 删除父分类时一并标记其直接子分类，但不改写任何历史账单。
   * @param {string} id
   * @returns {boolean}
   */
  function deleteCategory(id) {
    const readResult = _readForMutation(KEYS.categories, []);
    if (!readResult.ok) return false;
    const list = readResult.value;
    const target = list.find(c => c.id === id);
    if (!_isCategoryActive(target) || target.isPreset) return false;
    const children = list.filter(c => _isCategoryActive(c) && c.parentId === id);
    if (children.some(child => child.isPreset)) return false;
    const deletedAt = new Date().toISOString();
    target.deletedAt = deletedAt;
    children.forEach(child => { child.deletedAt = deletedAt; });
    if (!_isValidStoredCategoryGraph(list)) return false;
    return _write(KEYS.categories, list);
  }

  /**
   * 更新自定义分类（改名/改图标/换父级；预设分类不可编辑）
   * 只修改分类记录本身，不触碰任何账单数据——账单按 categoryId 引用分类，
   * 因此编辑名称/图标对历史账单零影响，这也是编辑优于"删除重建"的原因。
   * @param {string} id
   * @param {Object} patch 含 name / icon / parentId 中的若干字段，未提供的字段保持原值
   * @returns {boolean} 写入失败返回 false
   */
  function updateCategory(id, patch) {
    const readResult = _readForMutation(KEYS.categories, []);
    if (!readResult.ok) return false;
    const list = readResult.value;
    const target = list.find(c => c.id === id);
    if (!_isCategoryActive(target) || target.isPreset) return false;
    if (patch.parentId !== undefined) {
      const parentId = patch.parentId || null;
      if (!_validateCategoryParentInList(list, id, parentId).valid) return false;
    }
    // 显式提供的字段必须校验，非法直接拒绝——不能静默跳过再返回成功，
    // 否则 UI 弹"修改成功"而实际什么都没改（信任破坏）。
    if (patch.name !== undefined) {
      if (typeof patch.name !== 'string' || !patch.name.trim()) return false;
      target.name = patch.name.trim();
    }
    if (patch.icon !== undefined) {
      if (typeof patch.icon !== 'string') return false;
      // 空 icon 兜底 '📌'：与 addCategory 的产品约定一致（清空图标框 = 要默认图标）
      target.icon = patch.icon.trim() || '📌';
    }
    if (patch.parentId !== undefined) target.parentId = _normalizeCategoryParentId(patch.parentId);
    if (!_isValidStoredCategoryGraph(list)) return false;
    return _write(KEYS.categories, list);
  }

  /**
   * 初始化分类数据（仅在无数据时写入预设）
   */
  function initCategories(presets) {
    const readResult = _readForMutation(KEYS.categories, []);
    if (!readResult.ok) return false;
    const safePresets = Array.isArray(presets) ? presets.map(preset => ({ ...preset })) : null;
    if (!_isValidStoredCategoryGraph(safePresets)) return false;
    const existing = readResult.value;
    if (existing && existing.length > 0) return true;
    return _write(KEYS.categories, safePresets);
  }

  /**
   * 同步预设分类：更新已有预设的 icon/name/order，新增不存在的预设
   * 绝不删除任何分类，绝不修改用户自定义分类（isPreset=false）
   * 这样后续更新图标/名称时不会丢失用户的消费数据
   */
  function syncPresetCategories(presets) {
    const readResult = _readForMutation(KEYS.categories, []);
    if (!readResult.ok) return false;
    const safePresets = Array.isArray(presets) ? presets.map(preset => ({ ...preset })) : null;
    if (!_isValidStoredCategoryGraph(safePresets)) return false;
    const existing = readResult.value;
    if (existing.length === 0) {
      // 无数据 → 直接写入全部预设
      return _write(KEYS.categories, safePresets);
    }

    // 以预设数据为准，合并更新
    const existingMap = new Map(existing.map(c => [c.id, c]));
    let changed = false;

    safePresets.forEach(preset => {
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
      if (!_isValidStoredCategoryGraph(existing)) return false;
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

  function _remove(key) {
    try {
      localStorage.removeItem(key);
      return true;
    } catch (e) {
      console.error(`[ExpenseDB] 删除 "${key}" 失败:`, e);
      return false;
    }
  }

  /**
   * 一次性读取预算影响所需的数据，并区分“尚无数据”与“读取失败”。
   * 仅供记账页的只读预览使用；不迁移、不回填、不写入任何核心数据。
   */
  function getBudgetImpactSnapshot() {
    const expenseResult = _readWithStatus(KEYS.expenses);
    const categoryResult = _readWithStatus(KEYS.categories);
    const budgetResult = _readWithStatus(KEYS.budget);

    if (!expenseResult.ok || !categoryResult.ok || !budgetResult.ok) {
      return { ok: false, expenses: [], categories: [], budget: null };
    }

    const expenses = expenseResult.value === null ? [] : expenseResult.value;
    const categories = categoryResult.value === null ? [] : categoryResult.value;
    const budget = budgetResult.value === null
      ? { monthlyTotal: 0, categories: {} }
      : budgetResult.value;
    const valid = Array.isArray(expenses)
      && Array.isArray(categories)
      && budget
      && typeof budget === 'object'
      && !Array.isArray(budget);

    if (!valid) {
      console.error('[ExpenseDB] 预算影响快照结构无效，已停止计算');
      return { ok: false, expenses: [], categories: [], budget: null };
    }

    return {
      ok: true,
      expenses,
      categories,
      budget: {
        monthlyTotal: budget.monthlyTotal,
        categories: budget.categories && typeof budget.categories === 'object' && !Array.isArray(budget.categories)
          ? budget.categories
          : {},
      },
    };
  }

  /**
   * 保存预算配置
   * @param {Object} budget
   */
  function saveBudget(budget, options = {}) {
    const categoryResult = _readForMutation(KEYS.categories, []);
    if (!categoryResult.ok) return false;
    const activeCategoryIds = new Set(categoryResult.value.filter(_isCategoryActive).map(category => category.id));
    const allCategoryIds = new Set(categoryResult.value.map(category => category.id));
    const validation = validateBudgetDraft(budget, {
      categoryIds: allCategoryIds,
      activeCategoryIds,
    });
    if (!validation.ok) return false;

    const readResult = _readForMutation(KEYS.budget, { monthlyTotal: 0, categories: {} });
    if (!readResult.ok) return false;
    const replaceCategories = options.mode === 'reset' || options.replaceCategories === true;
    const nextCategories = replaceCategories
      ? {}
      : { ...(readResult.value.categories || {}) };
    for (const [categoryId, amount] of Object.entries(validation.value.categories)) {
      if (amount > 0) nextCategories[categoryId] = amount;
      else delete nextCategories[categoryId];
    }
    return _write(KEYS.budget, {
      monthlyTotal: validation.value.monthlyTotal,
      categories: nextCategories,
    });
  }

  function _sumExpenseAmounts(expenses) {
    let totalCents = 0;
    let legacyFloatTotal = 0;
    for (const expense of expenses) {
      const money = validateMoney(expense.amount);
      if (!money.ok) {
        // 旧版曾允许超精度/超上限的有限正数；只读展示仍保留旧行为，绝不取整或回填。
        // 混合求和：legacy 记录按原值浮点加，正常记录保持"分"精度——
        // 一条脏数据只影响其自身，不再拉低整月汇总精度。
        if (typeof expense.amount === 'number' && Number.isFinite(expense.amount)) {
          legacyFloatTotal += expense.amount;
        }
        continue;
      }
      totalCents += money.cents;
      if (!Number.isSafeInteger(totalCents)) {
        return expenses.reduce((sum, item) => sum + item.amount, 0);
      }
    }
    return legacyFloatTotal + (totalCents / 100);
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

    // 收集该分类 ID 及所有子分类 ID；Set 查找避免"子分类数 × 记录数"的 O(n²) includes
    const categories = _read(KEYS.categories) || [];
    const idSet = new Set([categoryId]);
    for (const c of categories) {
      if (c.parentId === categoryId) idSet.add(c.id);
    }

    return _sumExpenseAmounts(
      expenses.filter(e => idSet.has(e.categoryId) && e.date.startsWith(ym))
    );
  }

  /**
   * 计算当月总消费
   * @param {string} [yearMonth] - YYYY-MM
   * @returns {number}
   */
  function getMonthTotal(month) {
    const ym = month || yearMonth();
    const expenses = _read(KEYS.expenses) || [];
    return _sumExpenseAmounts(expenses.filter(e => e.date.startsWith(ym)));
  }

  /**
   * 计算当日总消费
   * @param {string} [date] - YYYY-MM-DD
   * @returns {number}
   */
  function getDayTotal(date) {
    const d = date || today();
    const expenses = _read(KEYS.expenses) || [];
    return _sumExpenseAmounts(expenses.filter(e => e.date === d));
  }

  /* =================================================================
     Settings — 应用设置
     ================================================================= */

  /**
   * 获取设置
   * @returns {Object}
   */
  function getSettings() {
    const stored = _read(KEYS.settings);
    // 合法但为空的存储对象（历史版本可能写过 {}）也要补默认值，
    // 否则下游读 currency/theme 拿到 undefined。
    return { currency: '¥', theme: 'light', ...(stored && typeof stored === 'object' ? stored : {}) };
  }

  /**
   * 保存设置
   * @param {Object} settings
   */
  function saveSettings(settings) {
    const readResult = _readForMutation(KEYS.settings, { currency: '¥', theme: 'light' });
    if (!readResult.ok) return false;
    const current = readResult.value;
    // 只接受白名单字段：拒绝 schema 外键混入本地存储，
    // 否则导出→导入往返会丢字段，本地与备份文件内容不一致。
    // 白名单 = currency/theme + 各模块已确认使用的三个扩展字段。
    const whitelisted = {};
    if (typeof settings.currency === 'string') whitelisted.currency = settings.currency;
    if (typeof settings.theme === 'string') whitelisted.theme = settings.theme;
    if (Array.isArray(settings.pinnedQuickCategoryIds)) whitelisted.pinnedQuickCategoryIds = settings.pinnedQuickCategoryIds;
    if (typeof settings.monthlyReportRead === 'string') whitelisted.monthlyReportRead = settings.monthlyReportRead;
    if (typeof settings.onboardingSeen === 'boolean') whitelisted.onboardingSeen = settings.onboardingSeen;
    return _write(KEYS.settings, { ...current, ...whitelisted });
  }

  /* =================================================================
     数据管理
     ================================================================= */

  /**
   * 导出全部数据（备份用）
   * @returns {Object}
   */
  function _readCoreSnapshot() {
    if (_writeBlockedByReadFailure || _writeBlockedByCategoryGraphFailure || _writeBlockedByDomainFailure) {
      return { ok: false, data: null, exists: null };
    }
    const expenseResult = _readForMutation(KEYS.expenses, []);
    const categoryResult = _readForMutation(KEYS.categories, []);
    const budgetResult = _readForMutation(KEYS.budget, { monthlyTotal: 0, categories: {} });
    const settingsResult = _readForMutation(KEYS.settings, {});
    if (!expenseResult.ok || !categoryResult.ok || !budgetResult.ok || !settingsResult.ok) {
      return { ok: false, data: null };
    }
    return {
      ok: true,
      data: {
        expenses: expenseResult.value,
        categories: categoryResult.value,
        budget: budgetResult.value,
        settings: settingsResult.value,
      },
      exists: {
        expenses: expenseResult.exists,
        categories: categoryResult.exists,
        budget: budgetResult.exists,
        settings: settingsResult.exists,
      },
    };
  }

  function _snapshotUsesLegacyMoneyPolicy(snapshot) {
    for (const expense of snapshot.expenses) {
      const result = validateMoney(expense.amount);
      if (!result.ok
          && _isLegacyMoneyPolicyValue(expense.amount, false)
          && (result.error.code === 'MONEY_PRECISION' || result.error.code === 'MONEY_LIMIT')) {
        return true;
      }
    }
    const budgetValues = [
      snapshot.budget && snapshot.budget.monthlyTotal != null ? snapshot.budget.monthlyTotal : 0,
      ...Object.values((snapshot.budget && snapshot.budget.categories) || {}),
    ];
    return budgetValues.some(value => {
      const result = validateMoney(value, { allowZero: true });
      return !result.ok
        && _isLegacyMoneyPolicyValue(value, true)
        && (result.error.code === 'MONEY_PRECISION' || result.error.code === 'MONEY_LIMIT');
    });
  }

  function _createExportData(snapshot) {
    return {
      version:    _snapshotUsesLegacyMoneyPolicy(snapshot)
        ? _LEGACY_MONEY_EXPORT_VERSION
        : _STRICT_EXPORT_VERSION,
      expenses:   snapshot.expenses,
      categories: snapshot.categories,
      budget:     snapshot.budget,
      settings:   snapshot.settings,
      exportedAt: new Date().toISOString(),
    };
  }

  function exportAll() {
    const snapshotResult = _readCoreSnapshot();
    return snapshotResult.ok ? _createExportData(snapshotResult.data) : null;
  }

  /**
   * 旧版分类关系异常时导出原样救援副本。它明确不可直接导入，
   * 只用于在人工修复前保全所有可解析的原始数据。
   */
  function exportRecoveryCopy() {
    if (_writeBlockedByReadFailure) return null;
    const expenseResult = _readWithStatus(KEYS.expenses);
    const categoryResult = _readWithStatus(KEYS.categories);
    const budgetResult = _readWithStatus(KEYS.budget);
    const settingsResult = _readWithStatus(KEYS.settings);
    if (!expenseResult.ok || !categoryResult.ok || !budgetResult.ok || !settingsResult.ok) return null;
    const snapshot = {
      expenses: expenseResult.exists ? expenseResult.value : [],
      categories: categoryResult.exists ? categoryResult.value : [],
      budget: budgetResult.exists ? budgetResult.value : { monthlyTotal: 0, categories: {} },
      settings: settingsResult.exists ? settingsResult.value : {},
    };
    const graphInvalid = !_isValidStoredCategoryGraph(snapshot.categories);
    const expenseDomain = _validateStoredDomainForKey(KEYS.expenses, snapshot.expenses);
    const budgetDomain = _validateStoredDomainForKey(KEYS.budget, snapshot.budget);
    const domainInvalid = !expenseDomain.ok || !budgetDomain.ok;
    if (!graphInvalid && !domainInvalid) return null;
    return {
      ..._createExportData(snapshot),
      version: _LEGACY_MONEY_EXPORT_VERSION,
      recoveryOnly: true,
      recoveryReason: graphInvalid ? 'CATEGORY_GRAPH_INVALID' : 'DOMAIN_DATA_INVALID',
    };
  }

  /**
   * 读失败场景的原始救援导出：不做 JSON 解析、不做结构校验，
   * 把四个核心 key 的原始字符串原样打包，供人工修复参考。
   * 该文件明确不可直接导入（缺少 expenses/categories 数组，importAll 会拒绝），
   * 只用于在核心数据损坏时保全所有原始字节。
   * @returns {Object|null} { rawOnly: true, raw: { 键名: 原始字符串|null } }
   */
  function exportRawRecoveryCopy() {
    try {
      const raw = {};
      for (const key of Object.values(KEYS)) {
        raw[key] = localStorage.getItem(key); // null 表示该键不存在
      }
      return {
        version: _STRICT_EXPORT_VERSION,
        rawOnly: true,
        recoveryOnly: true,
        recoveryReason: 'READ_FAILURE',
        raw,
        exportedAt: new Date().toISOString(),
      };
    } catch (e) {
      console.error('[ExpenseDB] 原始救援导出失败:', e);
      return null;
    }
  }

  function getCoreReadStatus() {
    const snapshotResult = _readCoreSnapshot();
    if (snapshotResult.ok) return { ok: true, code: null };
    if (_writeBlockedByCategoryGraphFailure && !_writeBlockedByReadFailure) {
      return {
        ok: false,
        code: 'CATEGORY_GRAPH_INVALID',
        message: '检测到旧版分类层级异常，写入已暂停',
      };
    }
    if (_writeBlockedByDomainFailure && !_writeBlockedByReadFailure) {
      return {
        ok: false,
        code: 'DOMAIN_DATA_INVALID',
        message: '检测到旧版账单或预算字段异常，写入已暂停',
      };
    }
    return { ok: false, code: 'READ_FAILURE', message: '无法安全读取本地账本，写入已暂停' };
  }

  // 可导入版本上限 = 当前严格导出版本（单一事实来源，改导出格式时只动 _STRICT_EXPORT_VERSION）
  const _IMPORT_VERSION = _STRICT_EXPORT_VERSION;
  const _UNSAFE_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
  const _VALID_PAYMENT_METHODS = new Set(['', 'wechat', 'alipay', 'bankcard', 'cash', 'other']);
  const _VALID_NECESSITY_VALUES = new Set(['', 'need', 'want', 'impulse']);

  function _importError(message, code = 'IMPORT_INVALID') {
    return {
      success: false,
      message: `无效的备份文件：${message}`,
      counts: null,
      error: { code, message },
    };
  }

  function _isPlainObject(value) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    // 同源 iframe / VM 传入的普通对象拥有不同 realm 的 Object.prototype；
    // 其原型本身仍直接继承 null。类实例则会多一层原型链，继续拒绝。
    return prototype === null || Object.getPrototypeOf(prototype) === null;
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

  function _cloneSafeJson(value, depth = 0) {
    // 递归深度上限：恶意/损坏备份若含数万层嵌套，无上限递归会栈溢出抛 RangeError。
    // 真实备份数据深度不超过 6（settings.theme 等叶子字段），32 层足够宽松。
    if (depth > 32) return undefined;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (Array.isArray(value)) {
      const items = [];
      for (const item of value) {
        const cloned = _cloneSafeJson(item, depth + 1);
        if (cloned === undefined) return undefined;
        items.push(cloned);
      }
      return items;
    }
    if (_isPlainObject(value)) {
      const result = {};
      for (const [key, item] of Object.entries(value)) {
        if (_UNSAFE_OBJECT_KEYS.has(key)) continue;
        const cloned = _cloneSafeJson(item, depth + 1);
        if (cloned === undefined) return undefined;
        result[key] = cloned;
      }
      return result;
    }
    return undefined;
  }

  function _validateImport(data) {
    if (!_isPlainObject(data)) return _importError('数据格式错误');
    if (data.recoveryOnly === true) {
      return _importError('这是只读救援副本，不能直接恢复；请保留文件并联系维护人员处理');
    }
    if (data.version != null
        && (!Number.isInteger(data.version) || data.version < 1 || data.version > _IMPORT_VERSION)) {
      return _importError(data.version > _IMPORT_VERSION ? '备份版本过新，请先更新应用' : '版本号错误');
    }
    if (data.exportedAt != null && !_isValidIsoTimestamp(data.exportedAt)) {
      return _importError('导出时间格式错误');
    }
    if (!Array.isArray(data.expenses)) return _importError('缺少消费记录');
    if (!Array.isArray(data.categories)) return _importError('缺少分类数据');

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
          || (category.order != null && !Number.isFinite(category.order))
          || (category.deletedAt != null && !_isValidIsoTimestamp(category.deletedAt))) {
        return _importError('分类数据格式错误');
      }
      if (categoryIds.has(category.id)) return _importError('存在重复的分类 ID');
      categoryIds.add(category.id);
      const normalizedCategory = {
        id: category.id,
        name: category.name,
        icon: category.icon || '📌',
        parentId: _normalizeCategoryParentId(category.parentId),
        isPreset: category.isPreset === true,
        order: Number.isFinite(category.order) ? category.order : categories.length,
      };
      if (category.deletedAt) normalizedCategory.deletedAt = category.deletedAt;
      categories.push(normalizedCategory);
    }

    const categoryMap = new Map(categories.map(category => [category.id, category]));
    for (const category of categories) {
      if (!category.parentId) continue;
      const parent = categoryMap.get(category.parentId);
      if (!parent || _normalizeCategoryParentId(parent.parentId)) return _importError('分类层级引用无效');
      if (!category.deletedAt && parent.deletedAt) return _importError('活动分类不能引用已删除的父分类');
    }

    const legacyFormat = data.version == null || data.version < _STRICT_EXPORT_VERSION;
    let legacyMoneyFound = false;
    const expenseIds = new Set();
    const expenses = [];
    for (let expenseIndex = 0; expenseIndex < data.expenses.length; expenseIndex += 1) {
      const expense = data.expenses[expenseIndex];
      if (!_isPlainObject(expense)
          || !_isNonEmptyString(expense.id)
          || _UNSAFE_OBJECT_KEYS.has(expense.id)
          || (expense.createdAt != null && !_isValidIsoTimestamp(expense.createdAt))) {
        return _importError(`第 ${expenseIndex + 1} 条消费记录格式错误`, 'EXPENSE_INVALID_TYPE');
      }
      if (typeof expense.amount !== 'number') {
        return _importError(`第 ${expenseIndex + 1} 条消费记录金额格式不正确`, 'MONEY_INVALID_FORMAT');
      }
      if (expenseIds.has(expense.id)) return _importError('存在重复的消费记录 ID');
      const validation = validateExpenseDraft({
        amount: expense.amount,
        categoryId: expense.categoryId,
        date: expense.date,
        time: expense.time == null ? '' : expense.time,
        location: expense.location == null ? '' : expense.location,
        paymentMethod: expense.paymentMethod == null ? '' : expense.paymentMethod,
        necessity: expense.necessity === undefined ? '' : expense.necessity,
        note: expense.note == null ? '' : expense.note,
      }, {
        categoryIds,
        activeCategoryIds: categoryIds,
        allowHistoricalCategories: true,
        allowLegacyMoney: legacyFormat,
      });
      if (!validation.ok) {
        return _importError(`第 ${expenseIndex + 1} 条消费记录：${validation.error.message}`, validation.error.code);
      }
      if (validation.legacyMoney) legacyMoneyFound = true;
      expenseIds.add(expense.id);
      expenses.push({
        id: expense.id,
        ...validation.value,
        createdAt: expense.createdAt || new Date().toISOString(),
      });
    }

    const sourceBudget = data.budget == null ? { monthlyTotal: 0, categories: {} } : data.budget;
    if (!_isPlainObject(sourceBudget) || (sourceBudget.categories != null && !_isPlainObject(sourceBudget.categories))) {
      return _importError('预算数据格式错误', 'BUDGET_INVALID_TYPE');
    }
    const monthlyTotal = sourceBudget.monthlyTotal == null ? 0 : sourceBudget.monthlyTotal;
    if (typeof monthlyTotal !== 'number') {
      return _importError('月度总预算格式不正确', 'MONEY_INVALID_FORMAT');
    }
    const rawCategoryBudgets = {};
    for (const [categoryId, amount] of Object.entries(sourceBudget.categories || {})) {
      if (typeof amount !== 'number') return _importError('分类预算格式不正确', 'MONEY_INVALID_FORMAT');
      rawCategoryBudgets[categoryId] = amount;
    }
    const budgetValidation = validateBudgetDraft({
      monthlyTotal,
      categories: rawCategoryBudgets,
    }, {
      categoryIds,
      activeCategoryIds: categoryIds,
      allowHistoricalCategories: true,
      allowLegacyMoney: legacyFormat,
    });
    if (!budgetValidation.ok) return _importError(budgetValidation.error.message, budgetValidation.error.code);
    if (budgetValidation.legacyMoney) legacyMoneyFound = true;

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
        budget: budgetValidation.value,
        settings,
      },
      warning: legacyMoneyFound
        ? '已按旧版规则原样保留部分超过两位小数或产品上限的历史金额，未做取整或迁移'
        : null,
    };
  }

  function _restoreImportSnapshot(snapshot, existingKeys, writtenKeys) {
    let restored = true;
    for (const key of writtenKeys) {
      const keyRestored = existingKeys[key]
        ? _write(KEYS[key], snapshot[key])
        : _remove(KEYS[key]);
      if (!keyRestored) restored = false;
    }
    return restored;
  }

  /**
   * 强制恢复模式的回滚：把写入过的 key 逐字节恢复为原始字符串。
   * rawSnapshot 中值为 null 表示该 key 原本不存在，回滚为删除。
   */
  function _restoreImportSnapshotRaw(rawSnapshot, writtenKeys) {
    let restored = true;
    for (const key of writtenKeys) {
      const rawValue = rawSnapshot[KEYS[key]];
      const keyRestored = rawValue === null
        ? _remove(KEYS[key])
        : _writeForRecovery(KEYS[key], rawValue);
      if (!keyRestored) restored = false;
    }
    return restored;
  }

  /**
   * 从备份文件导入数据
   * 执行前需确认：会完全替换当前数据，不可撤销
   * @param {Object} data - exportAll 产出的 JSON 对象
   * @param {Object} [options] - { forceRecovery: true } 时跳过当前数据读取，
   *   用于核心数据损坏无法读取的恢复场景（UI 必须二次确认）
   * @returns {{ success: boolean, message: string, counts: object, needsForceRecovery?: boolean }}
   */
  function importAll(data, options = {}) {
    const forceRecovery = options.forceRecovery === true;
    const validation = _validateImport(data);
    if (!validation.success) return validation;
    const normalized = validation.data;

    let snapshot = null;    // 正常模式：内存快照（含 exists 标记）
    let rawSnapshot = null; // 强制恢复模式：四个 key 的原始字符串快照

    if (!forceRecovery) {
      // 同时保留内存快照和持久备份：持久备份无法创建时不冒险覆盖原数据。
      const snapshotResult = _readCoreSnapshot();
      if (!snapshotResult.ok) {
        return {
          success: false,
          message: '导入失败：无法安全读取当前数据，操作已停止。请保留页面并检查已有备份',
          needsForceRecovery: true,
          counts: null,
        };
      }
      snapshot = snapshotResult;
      try {
        localStorage.setItem(BACKUP_KEYS.preImport, JSON.stringify(_createExportData(snapshot.data)));
      } catch (error) {
        console.error('[ExpenseDB] 创建导入前备份失败:', error);
        return { success: false, message: '导入失败：无法创建恢复前备份，请检查浏览器存储空间', counts: null };
      }
    } else {
      // 强制恢复：写入前把四个 key 的原始字符串备份到独立逃生 key。
      // 逃生备份必须成功，否则宁可中止也不覆盖（数据安全红线）。
      try {
        const raw = {};
        for (const key of Object.values(KEYS)) raw[key] = localStorage.getItem(key);
        localStorage.setItem(BACKUP_KEYS.forceImport, JSON.stringify({
          raw,
          exportedAt: new Date().toISOString(),
        }));
        rawSnapshot = raw;
      } catch (error) {
        console.error('[ExpenseDB] 创建强制恢复逃生备份失败:', error);
        return { success: false, message: '强制恢复已中止：无法创建逃生备份，请检查浏览器存储空间', counts: null };
      }
      // 逃生备份落盘后解锁写入。若写入中途失败，回滚写回的损坏数据
      // 会在下次读取时重新触发写锁——防线自恢复，无需手动重新置位。
      _resetWriteBlockFlags();
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
      const restored = forceRecovery
        ? _restoreImportSnapshotRaw(rawSnapshot, writtenKeys)
        : _restoreImportSnapshot(snapshot.data, snapshot.exists, writtenKeys);
      return {
        success: false,
        message: restored
          ? '导入失败：写入未完成，原数据已恢复'
          : '导入失败且自动恢复不完整，请保留页面并使用导入前备份恢复',
        counts: null,
      };
    }

    // 全部写入成功：数据已通过 _validateImport 校验、状态健康，复位写锁（幂等）。
    _resetWriteBlockFlags();

    // 核心数据已经恢复成功；元数据写入失败时保留成功结果，但必须向 UI 暴露警告。
    const backupTimeSaved = _recordBackup();
    const warnings = [];
    if (validation.warning) warnings.push(validation.warning);
    if (!backupTimeSaved) warnings.push('数据已恢复，但无法记录备份时间。请保留本次备份文件');

    return {
      success: true,
      message: `导入成功！${normalized.expenses.length} 条记录，${normalized.categories.length} 个分类`,
      warning: warnings.length ? warnings.join('；') : null,
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
      localStorage.setItem(BACKUP_KEYS.lastBackup, new Date().toISOString());
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
    try {
      return localStorage.getItem(BACKUP_KEYS.lastBackup) || null;
    } catch (e) {
      console.error('[ExpenseDB] 读取备份时间失败:', e);
      return null;
    }
  }

  /**
   * 记录最近一次备份时间（导出/导入成功时由调用方触发）
   */
  function recordBackupTime() {
    return _recordBackup();
  }

  /**
   * 清空全部数据（危险操作）。
   * 一并清除备份/逃生 key：否则"已清空"后消费数据仍以明文 JSON 残留，
   * 既违背清空语义，也是隐私泄漏点。清空后写锁复位——空数据是健康状态。
   */
  function clearAll() {
    Object.values(KEYS).forEach(k => _remove(k));
    Object.values(BACKUP_KEYS).forEach(k => _remove(k));
    _invalidateReadCache();
    _resetWriteBlockFlags();
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
    getActiveCategory,
    getParentCategories,
    getChildCategories,
    validateCategoryParent,
    addCategory,
    updateCategory,
    deleteCategory,
    initCategories,
    syncPresetCategories,

    // Budget
    getBudget,
    getBudgetImpactSnapshot,
    saveBudget,
    getCategorySpent,
    getMonthTotal,
    getDayTotal,

    // Settings
    getSettings,
    saveSettings,

    // Data management
    exportAll,
    exportRecoveryCopy,
    exportRawRecoveryCopy,
    importAll,
    getCoreReadStatus,
    getLastBackupTime,
    recordBackupTime,
    clearAll,

    // Shared domain validation
    validateMoney,
    validateExpenseDraft,
    validateBudgetDraft,
    MAX_MONEY_CENTS,

    // Date utilities
    today,
    now,
    yearMonth,
    dateToYMD,
  };
})();
