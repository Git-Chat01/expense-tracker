/* ================================================================
   消费轨迹系统 — data.js
   ExpenseData 命名空间：预设分类、预设标签、默认预算、初始化逻辑
   ================================================================ */

const ExpenseData = (() => {
  'use strict';

  /* =================================================================
     预设消费分类（14 个一级分类，餐饮和购物有子分类）
     结构：{ id, name, icon, parentId, isPreset, order }
     ================================================================= */
  const PRESET_CATEGORIES = [
    // ── 餐饮（6 个子分类） ──
    { id: 'cat-food',         name: '餐饮',   icon: '🍜', parentId: null,        isPreset: true, order: 0 },
    { id: 'cat-food-meal',    name: '正餐',   icon: '🍚', parentId: 'cat-food',  isPreset: true, order: 1 },
    { id: 'cat-food-deliver', name: '外卖',   icon: '🛵', parentId: 'cat-food',  isPreset: true, order: 2 },
    { id: 'cat-food-drink',   name: '奶茶饮品',icon: '🍵', parentId: 'cat-food', isPreset: true, order: 3 },
    { id: 'cat-food-snack',   name: '零食',   icon: '🍪', parentId: 'cat-food',  isPreset: true, order: 4 },
    { id: 'cat-food-night',   name: '夜宵',   icon: '🌙', parentId: 'cat-food',  isPreset: true, order: 5 },
    { id: 'cat-food-party',   name: '聚餐',   icon: '🥂', parentId: 'cat-food',  isPreset: true, order: 6 },

    // ── 交通 ──
    { id: 'cat-transport',    name: '交通',   icon: '🚇', parentId: null, isPreset: true, order: 10 },

    // ── 购物（6 个子分类） ──
    { id: 'cat-shopping',       name: '购物',       icon: '🛒', parentId: null,           isPreset: true, order: 20 },
    { id: 'cat-shopping-cloth', name: '衣服',       icon: '👔', parentId: 'cat-shopping', isPreset: true, order: 21 },
    { id: 'cat-shopping-digi',  name: '数码',       icon: '📱', parentId: 'cat-shopping', isPreset: true, order: 22 },
    { id: 'cat-shopping-daily', name: '日用品',     icon: '🧻', parentId: 'cat-shopping', isPreset: true, order: 23 },
    { id: 'cat-shopping-beaut', name: '化妆护肤品', icon: '💄', parentId: 'cat-shopping', isPreset: true, order: 24 },
    { id: 'cat-shopping-home',  name: '家居',       icon: '🛋️', parentId: 'cat-shopping',isPreset: true, order: 25 },
    { id: 'cat-shopping-impul', name: '冲动下单',   icon: '⚡', parentId: 'cat-shopping', isPreset: true, order: 26 },

    // ── 娱乐 ──
    { id: 'cat-entertain',    name: '娱乐',   icon: '🎮', parentId: null, isPreset: true, order: 30 },

    // ── 住房 ──
    { id: 'cat-housing',      name: '住房',   icon: '🏠', parentId: null, isPreset: true, order: 40 },

    // ── 水电网费 ──
    { id: 'cat-utilities',    name: '水电网费',icon: '💡', parentId: null, isPreset: true, order: 50 },

    // ── 电话费 ──
    { id: 'cat-phone',        name: '话费',   icon: '📱', parentId: null, isPreset: true, order: 60 },

    // ── 学习 ──
    { id: 'cat-learning',     name: '学习',   icon: '📚', parentId: null, isPreset: true, order: 70 },

    // ── 工作 ──
    { id: 'cat-work',         name: '工作',   icon: '💼', parentId: null, isPreset: true, order: 80 },

    // ── 医疗 ──
    { id: 'cat-medical',      name: '医疗',   icon: '💊', parentId: null, isPreset: true, order: 90 },

    // ── 人情 ──
    { id: 'cat-social',       name: '人情',   icon: '🎁', parentId: null, isPreset: true, order: 100 },

    // ── 旅行 ──
    { id: 'cat-travel',       name: '旅行',   icon: '✈️', parentId: null, isPreset: true, order: 110 },

    // ── 会员订阅 ──
    { id: 'cat-subscription', name: '会员订阅',icon: '💎', parentId: null, isPreset: true, order: 120 },

    // ── 其它 ──
    { id: 'cat-other',        name: '其它',   icon: '🔧', parentId: null, isPreset: true, order: 130 },
  ];

  /* =================================================================
     预设标签（增强版使用，基础版预置数据结构但不初始化）
     ================================================================= */
  const PRESET_TAGS = [
    { id: 'tag-friend',    name: '朋友聚餐', icon: '👥', isPreset: true },
    { id: 'tag-commute',   name: '通勤',     icon: '🚇', isPreset: true },
    { id: 'tag-emotion',   name: '情绪消费', icon: '😤', isPreset: true },
    { id: 'tag-online',    name: '网购',     icon: '🛒', isPreset: true },
    { id: 'tag-game',      name: '游戏',     icon: '🎮', isPreset: true },
    { id: 'tag-member',    name: '会员订阅', icon: '💎', isPreset: true },
    { id: 'tag-deliver',   name: '外卖',     icon: '📦', isPreset: true },
    { id: 'tag-promo',     name: '促销囤货', icon: '🏷️', isPreset: true },
    { id: 'tag-gift',      name: '礼物',     icon: '🎁', isPreset: true },
    { id: 'tag-daily',     name: '日用消耗', icon: '📦', isPreset: true },
    { id: 'tag-learn',     name: '学习投资', icon: '📚', isPreset: true },
    { id: 'tag-work-social',name: '工作应酬',icon: '💼', isPreset: true },
    { id: 'tag-weekend',   name: '周末消遣', icon: '🍿', isPreset: true },
    { id: 'tag-health',    name: '健康投入', icon: '🏃', isPreset: true },
  ];

  /* =================================================================
     默认预算
     ================================================================= */
  const DEFAULT_BUDGET = {
    monthlyTotal: 0,     // 0 = 未设置月度总预算
    categories: {},      // { "cat-food": 1500, "cat-entertain": 500 }
  };

  /* =================================================================
     支付方式选项（品牌色标识）
     ================================================================= */
  const PAYMENT_METHODS = [
    { value: 'wechat',   label: '微信支付', color: '#07C160' },
    { value: 'alipay',   label: '支付宝',   color: '#1677FF' },
    { value: 'bankcard', label: '银行卡',   color: '#FF6B35' },
    { value: 'cash',     label: '现金',     color: '#D4A017' },
    { value: 'other',    label: '其他',     color: '#7B61FF' },
  ];


  /* =================================================================
     必要性选项（增强版）
     ================================================================= */
  const NECESSITY_OPTIONS = [
    { value: 'need',    label: '必需', icon: '🟢' },
    { value: 'want',    label: '可选', icon: '🟡' },
    { value: 'impulse', label: '冲动', icon: '🔴' },
  ];

  /* =================================================================
     价值评定选项（增强版）
     ================================================================= */
  const VALUE_RATINGS = [
    { value: 'worth',     label: '值',   icon: '💚' },
    { value: 'neutral',   label: '一般', icon: '💛' },
    { value: 'not-worth', label: '不值', icon: '🧡' },
    { value: 'regret',    label: '后悔', icon: '💔' },
  ];

  /* =================================================================
     情绪选项（增强版）
     ================================================================= */
  const EMOTIONS = [
    { value: 'normal',   label: '正常消费', icon: '😊' },
    { value: 'happy',    label: '开心奖励', icon: '🎉' },
    { value: 'stressed', label: '压力大',   icon: '😫' },
    { value: 'bored',    label: '无聊',     icon: '🥱' },
    { value: 'fomo',     label: '跟风',     icon: '🐑' },
    { value: 'face',     label: '面子消费', icon: '🎭' },
    { value: 'impulse',  label: '冲动下单', icon: '⚡' },
  ];

  /* =================================================================
     初始化：写入预设分类 + 默认预算
     仅在首次使用时执行（检测 categories 是否为空）
     ================================================================= */
  function initPresetData() {
    // syncPresetCategories：已有数据时只更新预设的 icon/name，不删不改用户自定义
    // 保证后续更新图标/名称后，老用户刷新即可生效，数据毫发无损
    ExpenseDB.syncPresetCategories(PRESET_CATEGORIES);

    // 预算：仅在不存在时写入默认值
    const budget = ExpenseDB.getBudget();
    if (!budget || (budget.monthlyTotal === undefined)) {
      ExpenseDB.saveBudget(DEFAULT_BUDGET);
    }
  }

  /* =================================================================
     公开 API
     ================================================================= */
  return {
    PRESET_CATEGORIES,
    PRESET_TAGS,
    DEFAULT_BUDGET,
    PAYMENT_METHODS,
    NECESSITY_OPTIONS,
    VALUE_RATINGS,
    EMOTIONS,
    initPresetData,
  };
})();
