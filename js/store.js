/*
 * store.js —— 全局共享数据层 v3（高性能 + 安全加固）
 * ------------------------------------------------------------------
 * v3 改进：
 *   - 精准 watch：只监听需要持久化的顶层 key，抛弃 deep watch
 *   - _sfCache 加 LRU 淘汰（最多 10 个店铺缓存）
 *   - openMerchant 请求去重（同一店铺并发只发一次）
 *   - sync_ 加防抖队列（300ms 合并窗口）
 *   - Toast 通知系统（store.toast 全局可用）
 *   - 输入校验工具（validateName/Phone/Required）
 *   - localStorage 序列化前剥离 base64 大字段，大幅减小写入量
 *   - 跨标签同步防回声：加 300ms 静默期
 *   - 商家轮询频率自适应（后台返回 pollIntervalMs）
 */
(function () {
  const { reactive, watch } = Vue;

  const STORAGE_KEY = 'canteen_platform_v5';
  const PROFILE_KEY = 'canteen_profile_v4';
  const AUTH_KEY = 'canteen_auth_v4';

  // ---------- 工具 ----------
  const utils = {
    rm(n) { return 'RM ' + Number(n || 0).toFixed(2); },
    genOrderId() {
      const d = new Date(); const p = (x) => String(x).padStart(2, '0');
      return '#' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) + Math.floor(Math.random() * 90 + 10);
    },
    genId(prefix) { return (prefix || 'id') + '_' + Date.now().toString(36) + Math.floor(Math.random() * 1000); },
    nowTime() { const d = new Date(); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); },
    todayYMD() { const d = new Date(); const p = (x) => String(x).padStart(2, '0'); return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()); },
    relTime(ms) { const t = Number(ms); if (!t) return ''; const d = Date.now() - t; if (d < 60000) return '刚刚'; if (d < 3600000) return Math.floor(d / 60000) + ' 分钟前'; if (d < 86400000) return Math.floor(d / 3600000) + ' 小时前'; return Math.floor(d / 86400000) + ' 天前'; },
    playAlert() {
      try { if (navigator.vibrate) navigator.vibrate([120, 60, 120]); } catch (e) {}
      try {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        const ctx = this._actx || (this._actx = new AC()); if (ctx.state === 'suspended') ctx.resume();
        [0, 0.18].forEach((delay, i) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.connect(g); g.connect(ctx.destination); o.frequency.value = i ? 1175 : 880; const t = ctx.currentTime + delay; g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15); o.start(t); o.stop(t + 0.16); });
      } catch (e) {}
    },
    isImg(v) { return typeof v === 'string' && v.indexOf('data:') === 0; },
    // Drive 图片提速：lh3.googleusercontent.com/d/<id> 这种地址加载很慢，
    // 统一改成 drive.google.com/thumbnail（更快更稳，可指定尺寸）。data: URL 与非 Drive 链接原样返回。
    fastDriveImg(u) {
      if (typeof u !== 'string' || !u || u.indexOf('data:') === 0) return u || '';
      if (u.indexOf('drive.google.com/thumbnail') >= 0) return u; // 已是快地址
      var m = u.match(/lh3\.googleusercontent\.com\/d\/([\w-]+)/) || u.match(/\/file\/d\/([\w-]+)/) || u.match(/[?&]id=([\w-]+)/);
      return m ? 'https://drive.google.com/thumbnail?id=' + m[1] + '&sz=w1000' : u;
    },
    compressImage(file, opts) {
      const maxWidth = (opts && opts.maxWidth) || 800;
      const quality = (opts && opts.quality) || 0.65;
      return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
          let w = img.naturalWidth, h = img.naturalHeight;
          if (w > maxWidth) { const s = maxWidth / w; w = maxWidth; h = Math.round(h * s); }
          const cv = document.createElement('canvas');
          cv.width = w; cv.height = h;
          cv.getContext('2d').drawImage(img, 0, 0, w, h);
          URL.revokeObjectURL(url);
          let out = cv.toDataURL('image/webp', quality);
          if (out.indexOf('data:image/webp') !== 0) out = cv.toDataURL('image/jpeg', quality);
          resolve(out);
        };
        img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
        img.src = url;
      });
    },
    emojiList: [
      { e: '🍚', k: '饭 rice 米饭 盖饭 鸡饭 海南鸡饭 白饭' }, { e: '🍗', k: '鸡 chicken 鸡扒 炸鸡 鸡腿 鸡翼' },
      { e: '🍖', k: '肉 meat 排骨 烧肉 叉烧' }, { e: '🥩', k: '牛 beef 牛肉 牛排 黑椒' },
      { e: '🥓', k: '培根 bacon 猪 pork' }, { e: '🍜', k: '面 noodle 汤面 叻沙 laksa 拉面 云吞面 板面' },
      { e: '🍲', k: '汤 soup 火锅 砂煲 煲' }, { e: '🍛', k: '咖喱 curry 套餐' },
      { e: '🍝', k: '意面 pasta spaghetti' }, { e: '🍱', k: '便当 bento 盒饭 套餐 lunch' },
      { e: '🍣', k: '寿司 sushi 刺身' }, { e: '🍤', k: '虾 prawn shrimp 天妇罗' },
      { e: '🐟', k: '鱼 fish 海鲜' }, { e: '🦀', k: '螃蟹 crab 海鲜' }, { e: '🥟', k: '饺 dumpling 云吞 烧卖 锅贴' },
      { e: '🍞', k: '面包 bread 吐司 toast' }, { e: '🥪', k: '三明治 sandwich' }, { e: '🍔', k: '汉堡 burger' },
      { e: '🍟', k: '薯条 fries 薯' }, { e: '🌭', k: '热狗 hotdog 香肠 sausage' }, { e: '🍕', k: '披萨 pizza' },
      { e: '🌮', k: 'taco 塔可 卷饼' }, { e: '🥗', k: '沙拉 salad 蔬菜 沙律' }, { e: '🥦', k: '菜 vegetable 西兰花' },
      { e: '🍳', k: '蛋 egg 煎蛋 鸡蛋' }, { e: '🥞', k: '松饼 pancake' }, { e: '🫓', k: '煎饼 印度煎饼 roti capati' },
      { e: '🍢', k: '关东煮 串 沙爹 satay' }, { e: '🌶️', k: '辣 spicy 辣椒 参巴 sambal 亚参' },
      { e: '🫛', k: '豆 豆腐 tofu' }, { e: '🥤', k: '饮料 drink 汽水 可乐 coke soda 美禄 milo' },
      { e: '🧋', k: '奶茶 珍珠 boba bubble 波霸' }, { e: '☕', k: '咖啡 coffee 拿铁 美式' },
      { e: '🍵', k: '茶 tea 绿茶 抹茶' }, { e: '🥛', k: '奶 milk 牛奶 薏米水 豆奶' }, { e: '🧃', k: '果汁 juice 盒装' },
      { e: '🍹', k: '特调 鸡尾 mocktail 冰沙' }, { e: '🍺', k: '啤酒 beer' }, { e: '💧', k: '水 water 矿泉水' },
      { e: '🍰', k: '蛋糕 cake 甜品 dessert' }, { e: '🍦', k: '冰淇淋 雪糕 icecream' }, { e: '🍧', k: '刨冰 cendol 煎蕊 甜品' },
      { e: '🍩', k: '甜甜圈 donut' }, { e: '🍪', k: '饼干 cookie biscuit' }, { e: '🍫', k: '巧克力 chocolate' },
      { e: '🍮', k: '布丁 pudding 焦糖' }, { e: '🥮', k: '月饼 糕点 pastry' }, { e: '🍎', k: '苹果 apple 水果 fruit' },
      { e: '🍌', k: '香蕉 banana' }, { e: '🍉', k: '西瓜 watermelon' }, { e: '🥭', k: '芒果 mango' },
      { e: '🌽', k: '玉米 corn' }, { e: '🍿', k: '爆米花 popcorn 零食 snack' }, { e: '🥜', k: '花生 nut 坚果' },
      { e: '🧀', k: '芝士 cheese 奶酪' }, { e: '📦', k: '包裹 其他 杂货' }, { e: '🛍️', k: '商品 购物 杂货 goods' },
      { e: '🍽️', k: '其他 默认 餐 food' },
    ],
    guessEmoji(name) {
      const n = (name || '').toLowerCase();
      if (!n) return '';
      for (const it of this.emojiList) { const ks = it.k.split(' '); for (const k of ks) { if (k && n.indexOf(k.toLowerCase()) >= 0) return it.e; } }
      return '';
    },
    dishEmoji(item) {
      if (!item) return '🍽️';
      if (item.emoji && item.emoji !== '🍽️') return item.emoji;
      return this.guessEmoji(item.name) || '🍽️';
    },
    effPrice(item) {
      let p = Number(item && item.price) || 0; const d = item && item.discount;
      if (d && d.enabled && Number(d.value) > 0) { p = d.type === 'percent' ? p * (1 - Math.min(100, Number(d.value)) / 100) : Math.max(0, p - Number(d.value)); }
      return Math.round(p * 100) / 100;
    },
    hasDiscount(item) { const d = item && item.discount; return !!(d && d.enabled && Number(d.value) > 0 && this.effPrice(item) < (Number(item.price) || 0)); },
    discountLabel(item) { const d = item && item.discount; if (!this.hasDiscount(item)) return ''; return d.type === 'percent' ? ('-' + Number(d.value) + '%') : ('-RM' + Number(d.value)); },

    // ---- v3: 输入校验 ----
    validateName(name) { if (!name || String(name).trim().length === 0) return '姓名不能为空'; if (String(name).length > 60) return '姓名不能超过60个字符'; return null; },
    validatePhone(phone) { var s = String(phone || '').replace(/\D/g, ''); if (s.length < 7 || s.length > 15) return '手机号格式不正确（7-15位）'; return null; },
    validateRequired(val, label) { if (!val || String(val).trim().length === 0) return (label || '字段') + '不能为空'; return null; },
    sanitize(val, maxLen) { if (val === null || val === undefined) return ''; var s = String(val).replace(/[<>"']/g, ''); if (maxLen && s.length > maxLen) s = s.slice(0, maxLen); return s; },

    fakeQrSvg(seed) {
      const size = 21; let s = 0; const key = seed || 'TNG';
      for (let i = 0; i < key.length; i++) s += key.charCodeAt(i);
      let rects = '';
      for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
        s = (s * 1103515245 + 12345) & 0x7fffffff;
        if ((x < 7 && y < 7) || (x >= size - 7 && y < 7) || (x < 7 && y >= size - 7)) continue;
        if ((s >> 16) % 2 === 0) rects += '<rect x="' + x + '" y="' + y + '" width="1" height="1"/>';
      }
      const finder = (ox, oy) => '<rect x="' + ox + '" y="' + oy + '" width="7" height="7" fill="none" stroke="#000"/><rect x="' + (ox + 2) + '" y="' + (oy + 2) + '" width="3" height="3"/>';
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="-1 -1 ' + (size + 2) + ' ' + (size + 2) + '" shape-rendering="crispEdges"><rect x="-1" y="-1" width="' + (size + 2) + '" height="' + (size + 2) + '" fill="#fff"/><g fill="#000">' + rects + '</g>' + finder(0, 0) + finder(size - 7, 0) + finder(0, size - 7) + '</svg>';
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    },
    sampleScreenshot(o) {
      const total = (o && o.total) || 0;
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="560"><rect width="320" height="560" fill="#eef7f1"/><rect x="20" y="50" width="280" height="460" rx="18" fill="#fff"/><circle cx="160" cy="160" r="42" fill="#04a65a"/><path d="M140 162 l14 14 l28 -30" stroke="#fff" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/><text x="160" y="240" font-size="22" font-family="sans-serif" font-weight="bold" fill="#111" text-anchor="middle">Payment Successful</text><text x="160" y="290" font-size="34" font-family="sans-serif" font-weight="bold" fill="#04a65a" text-anchor="middle">RM ' + total.toFixed(2) + '</text><text x="160" y="340" font-size="14" font-family="sans-serif" fill="#888" text-anchor="middle">Touch \'n Go eWallet</text></svg>';
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    },
    sampleDelivery() {
      const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#f1f4f2"/><rect x="92" y="74" width="136" height="104" rx="8" fill="#cfa46b"/><rect x="92" y="74" width="136" height="34" rx="8" fill="#b98c4f"/><text x="160" y="210" font-size="15" font-family="sans-serif" fill="#7a6a4a" text-anchor="middle">已放在门口</text></svg>';
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg);
    },
  };

  // ---------- 默认 Mock 数据 ----------
  function defaultSettings(mode) {
    return {
      deliveryMode: mode || 'fixed', fixedSlots: ['12:30', '13:30'], flexibleMin: 20, flexibleMax: 30,
      deliveryOffered: true,
      cutoffMins: 20,
      preorder: false,
      waNotify: false,
      soundOn: true,
      allowRemark: true,
      coverage: [],
      flexCloseTime: '20:00',
      fees: { packaging: { enabled: false, amount: 0.50 }, delivery: { enabled: false, amount: 1.00 } },
      hours: { auto: false, openTime: '08:00', closeTime: '20:00', openDays: [true, true, true, true, true, true, true] },
      // 新单响铃：默认开，可在设置面板调整（详见 js/merchant-ringer.js）
      ring: { enabled: true, volume: 0.7, intervalSec: 1.2, maxDurationSec: 30, escalateAfterMin: 5, quietStart: '', quietEnd: '' },
      // 客户联系号码（仅 WhatsApp 链接用，留空 = 不展示「联系商家」按钮）
      waNumber: '',
    };
  }

  function seedState() {
    var now = Date.now();
    var s = utils.sampleScreenshot;

    // 把 defaultSettings.fixedSlots 复制一份，避免 seedState 的 shops 共享同一引用
    function ds(mode) { return JSON.parse(JSON.stringify(defaultSettings(mode))); }

    return {
      hubs: [
        { id: 'utm', name: 'UTM 团团', buildings: ['A 栋', 'B 栋', 'C 栋', 'D 栋', 'E 栋'] },
        { id: 'ukm', name: 'UKM 团团', buildings: ['宿舍 1 座', '宿舍 2 座', '宿舍 3 座'] },
      ],
      merchants: [
        // ===== shop1：PRO 专业版（有效期内）— 功能最全 =====
        { id: 'shop1', name: '阿强快餐', desc: '中式快餐 · 米饭面食', logo: '🍛', open: true, hubId: 'utm', tngLabel: 'Ah Keong Food', plan: 'pro', planUntil: '2026-12-31', settings: (function () { var s = ds('fixed'); s.coverage = ['A 栋', 'B 栋', 'C 栋']; s.fixedSlots = ['12:00', '12:30', '13:00', '18:00', '18:30']; s.fees.packaging = { enabled: true, amount: 0.50 }; s.membership = { enabled: true, ptsPerRM: 1, redeemPts: 10, redeemRM: 2, points: { "0123456701": 5, "0123456704": 12 } }; return s; })(),
          payQRs: [
            { id: 'q1a', label: "Touch 'n Go", image: utils.fakeQrSvg('Ah Keong TNG') },
            { id: 'q1b', label: '支付宝 Alipay', image: utils.fakeQrSvg('Ah Keong Alipay') },
          ],
          categories: ['食物', '小吃', '饮料'],
          menu: [
            { id: 'a1', name: '招牌鸡扒饭', price: 9.5, available: true, emoji: '🍗', image: '', desc: '香煎鸡扒 + 白饭 + 时蔬', category: '食物', optionGroups: [{ id: 'g1', name: '份量', type: 'single', required: true, max: 1, options: [{ id: 'o1', name: '标准', price: 0 }, { id: 'o2', name: '大份 (+饭)', price: 2 }] }, { id: 'g2', name: '加料', type: 'multi', required: false, max: 3, options: [{ id: 'o3', name: '加煎蛋', price: 1.5 }, { id: 'o4', name: '加香肠', price: 2 }, { id: 'o5', name: '加菜', price: 1 }] }] },
            { id: 'a2', name: '黑椒牛肉饭', price: 11.0, available: true, emoji: '🥩', image: '', desc: '黑椒滑牛肉，微辣', category: '食物', stock: 5 },
            { id: 'a3', name: '海南鸡饭', price: 8.0, available: true, emoji: '🍚', image: '', desc: '油鸡 + 鸡油饭', category: '食物', discount: { enabled: true, type: 'percent', value: 20 } },
            { id: 'a4', name: '美禄冰', price: 3.0, available: true, emoji: '🥤', image: '', desc: '冰镇美禄加炼奶', category: '饮料' },
            { id: 'a5', name: '香辣鸡翅(4只)', price: 7.0, available: true, emoji: '🍖', image: '', desc: '辣味脆皮鸡翅', category: '小吃', stock: 8 },
          ] },

        // ===== shop2：基础版 — 无 PRO 功能，但正常营业 =====
        { id: 'shop2', name: '叻沙小馆', desc: '娘惹风味 · 汤面', logo: '🍜', open: true, hubId: 'utm', tngLabel: 'Laksa House', plan: 'basic', planUntil: '', settings: (function () { var s = ds('flexible'); s.coverage = ['A 栋', 'B 栋']; s.flexibleMin = 25; s.flexibleMax = 35; return s; })(),
          payQRs: [{ id: 'q2a', label: "Touch 'n Go", image: utils.fakeQrSvg('Laksa TNG') }],
          categories: ['食物', '小吃', '饮料'],
          menu: [
            { id: 'b1', name: '咖喱叻沙', price: 7.5, available: true, emoji: '🍜', image: '', desc: '浓郁椰香咖喱汤底', category: '食物' },
            { id: 'b2', name: '亚参叻沙', price: 7.5, available: true, emoji: '🌶️', image: '', desc: '酸辣开胃', category: '食物' },
            { id: 'b3', name: '云吞面', price: 6.5, available: false, emoji: '🥟', image: '', desc: '今日售罄', category: '食物' },
            { id: 'b4', name: '薏米水', price: 2.5, available: true, emoji: '🥛', image: '', desc: '清热解腻', category: '饮料' },
          ] },

        // ===== shop3：已过期 PRO — planUntil 已过，功能降级为基础版 =====
        { id: 'shop3', name: '炸鸡工坊', desc: '炸物 · 西式快餐', logo: '🍗', open: false, hubId: 'ukm', tngLabel: 'Crispy Chicken', plan: 'pro', planUntil: '2025-01-01', settings: (function () { var s = ds('fixed'); s.coverage = ['宿舍 1 座']; s.fixedSlots = ['12:00', '13:00']; s.fees.packaging = { enabled: true, amount: 0.30 }; return s; })(),
          payQRs: [{ id: 'q3a', label: "Touch 'n Go", image: utils.fakeQrSvg('Crispy TNG') }],
          categories: ['食物', '小吃', '饮料'],
          menu: [
            { id: 'c1', name: '炸鸡翼(3只)', price: 6.0, available: true, emoji: '🍖', image: '', desc: '现炸脆皮', category: '小吃' },
            { id: 'c2', name: '薯条', price: 4.0, available: true, emoji: '🍟', image: '', desc: '黄金薯条', category: '小吃' },
            { id: 'c3', name: '可乐', price: 2.5, available: true, emoji: '🥤', image: '', desc: '冰镇', category: '饮料' },
          ] },

        // ===== shop4：新入驻基础版 — 商品少、无历史订单 =====
        { id: 'shop4', name: '深夜食堂', desc: '日式简餐 · 新店开业', logo: '🏮', open: true, hubId: 'utm', tngLabel: 'Midnight Kitchen', plan: 'basic', planUntil: '', settings: (function () { var s = ds('flexible'); s.coverage = ['C 栋', 'D 栋']; s.flexibleMin = 30; s.flexibleMax = 45; return s; })(),
          payQRs: [{ id: 'q4a', label: "Touch 'n Go", image: utils.fakeQrSvg('Midnight Kitchen TNG') }],
          categories: ['食物', '饮料'],
          menu: [
            { id: 'd1', name: '日式咖喱饭', price: 10.0, available: true, emoji: '🍛', image: '', desc: '浓郁咖喱 + 米饭', category: '食物' },
            { id: 'd2', name: '味噌拉面', price: 8.5, available: true, emoji: '🍜', image: '', desc: '豚骨味噌汤底', category: '食物' },
            { id: 'd3', name: '抹茶拿铁', price: 5.0, available: true, emoji: '🍵', image: '', desc: '冰镇抹茶', category: '饮料' },
          ] },
      ],
      accounts: [
        { username: 'admin', role: 'admin', merchantId: null },
        { username: 'shop1', role: 'merchant', merchantId: 'shop1' },
        { username: 'shop2', role: 'merchant', merchantId: 'shop2' },
        { username: 'shop3', role: 'merchant', merchantId: 'shop3' },
        { username: 'shop4', role: 'merchant', merchantId: 'shop4' },
      ],
      orders: [
        // ---- shop1 订单（覆盖全部 6 种状态）----
        { id: '#S1-01', merchantId: 'shop1', hubId: 'utm',
          createdAt: now - 180000, createdAtText: '3 分钟前',
          customer: { name: '小明', phone: '0123456701', building: 'A 栋', room: '301' },
          items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1, options: '大份 (+饭)' }, { id: 'a4', name: '美禄冰', price: 3.0, qty: 1 }],
          subtotal: 14.5, packagingFee: 0.50, deliveryFee: 0, total: 15.0, deliveryMode: 'fixed', deliveryTime: '12:30',
          membershipJson: '{"earned":1,"redeemed":true,"discount":2}',
          screenshot: s({ total: 10.0 }), status: 'pending', rejectReason: '', deliveryPhoto: '', remark: '少辣谢谢' },

        { id: '#S1-02', merchantId: 'shop1', hubId: 'utm',
          createdAt: now - 600000, createdAtText: '10 分钟前',
          customer: { name: '阿丽', phone: '0123456702', building: 'B 栋', room: '208' },
          items: [{ id: 'a2', name: '黑椒牛肉饭', price: 11.0, qty: 1 }],
          subtotal: 11.0, packagingFee: 0.50, deliveryFee: 0, total: 11.5, deliveryMode: 'fixed', deliveryTime: '12:00',
          membershipJson: '',
          screenshot: s({ total: 11.5 }), status: 'cooking', rejectReason: '', deliveryPhoto: '' },

        { id: '#S1-03', merchantId: 'shop1', hubId: 'utm',
          createdAt: now - 2400000, createdAtText: '40 分钟前',
          customer: { name: '大华', phone: '0123456703', building: 'A 栋', room: '512' },
          items: [{ id: 'a5', name: '香辣鸡翅(4只)', price: 7.0, qty: 2 }, { id: 'a4', name: '美禄冰', price: 3.0, qty: 2 }],
          subtotal: 20.0, packagingFee: 0.50, deliveryFee: 0, total: 17.5, deliveryMode: 'fixed', deliveryTime: '12:00',
          membershipJson: '{"earned":2,"redeemed":false,"discount":0}',
          screenshot: s({ total: 17.5 }), status: 'delivering', rejectReason: '', deliveryPhoto: '' },

        { id: '#S1-04', merchantId: 'shop1', hubId: 'utm',
          createdAt: now - 86400000, createdAtText: '昨天',
          customer: { name: '小芳', phone: '0123456704', building: 'C 栋', room: '102' },
          items: [{ id: 'a3', name: '海南鸡饭', price: 8.0, qty: 1 }, { id: 'a4', name: '美禄冰', price: 3.0, qty: 1 }],
          subtotal: 9.4, packagingFee: 0.50, deliveryFee: 0, total: 9.9, deliveryMode: 'fixed', deliveryTime: '18:00',
          membershipJson: '',
          screenshot: s({ total: 9.9 }), status: 'delivered', rejectReason: '', deliveryPhoto: utils.sampleDelivery() },

        { id: '#S1-05', merchantId: 'shop1', hubId: 'utm',
          createdAt: now - 7200000, createdAtText: '2 小时前',
          customer: { name: '志伟', phone: '0123456705', building: 'B 栋', room: '715' },
          items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }, { id: 'a5', name: '香辣鸡翅(4只)', price: 7.0, qty: 1 }],
          subtotal: 16.5, packagingFee: 0.50, deliveryFee: 0, total: 17.0, deliveryMode: 'fixed', deliveryTime: '13:00',
          membershipJson: '',
          screenshot: s({ total: 17.0 }), status: 'rejected', rejectReason: '今日鸡翅已售罄，请改天再来', deliveryPhoto: '' },

        { id: '#S1-06', merchantId: 'shop1', hubId: 'utm',
          createdAt: now - 10800000, createdAtText: '3 小时前',
          customer: { name: '俊杰', phone: '0123456706', building: 'A 栋', room: '420' },
          items: [{ id: 'a2', name: '黑椒牛肉饭', price: 11.0, qty: 1 }],
          subtotal: 11.0, packagingFee: 0.50, deliveryFee: 0, total: 11.5, deliveryMode: 'fixed', deliveryTime: '12:30',
          membershipJson: '',
          screenshot: s({ total: 11.5 }), status: 'cancelled', rejectReason: '', deliveryPhoto: '' },

        // ---- shop2 订单（3 种状态）----
        { id: '#S2-01', merchantId: 'shop2', hubId: 'utm',
          createdAt: now - 120000, createdAtText: '2 分钟前',
          customer: { name: '慧敏', phone: '0123456707', building: 'A 栋', room: '305' },
          items: [{ id: 'b1', name: '咖喱叻沙', price: 7.5, qty: 1 }],
          subtotal: 7.5, packagingFee: 0, deliveryFee: 0, total: 7.5, deliveryMode: 'flexible', deliveryTime: '约 30 分钟',
          membershipJson: '',
          screenshot: s({ total: 7.5 }), status: 'pending', rejectReason: '', deliveryPhoto: '' },

        { id: '#S2-02', merchantId: 'shop2', hubId: 'utm',
          createdAt: now - 480000, createdAtText: '8 分钟前',
          customer: { name: '伟豪', phone: '0123456708', building: 'B 栋', room: '601' },
          items: [{ id: 'b1', name: '咖喱叻沙', price: 7.5, qty: 1 }, { id: 'b4', name: '薏米水', price: 2.5, qty: 2 }],
          subtotal: 12.5, packagingFee: 0, deliveryFee: 0, total: 12.5, deliveryMode: 'flexible', deliveryTime: '约 30 分钟',
          membershipJson: '',
          screenshot: s({ total: 12.5 }), status: 'cooking', rejectReason: '', deliveryPhoto: '' },

        { id: '#S2-03', merchantId: 'shop2', hubId: 'utm',
          createdAt: now - 172800000, createdAtText: '2 天前',
          customer: { name: '淑婷', phone: '0123456709', building: 'A 栋', room: '208' },
          items: [{ id: 'b2', name: '亚参叻沙', price: 7.5, qty: 1 }],
          subtotal: 7.5, packagingFee: 0, deliveryFee: 0, total: 7.5, deliveryMode: 'flexible', deliveryTime: '约 25 分钟',
          membershipJson: '',
          screenshot: s({ total: 7.5 }), status: 'delivered', rejectReason: '', deliveryPhoto: utils.sampleDelivery() },

        // ---- shop3 订单（关店商家，仅 1 条历史）----
        { id: '#S3-01', merchantId: 'shop3', hubId: 'ukm',
          createdAt: now - 259200000, createdAtText: '3 天前',
          customer: { name: '嘉豪', phone: '0123456710', building: '宿舍 1 座', room: '12' },
          items: [{ id: 'c1', name: '炸鸡翼(3只)', price: 6.0, qty: 2 }, { id: 'c2', name: '薯条', price: 4.0, qty: 1 }, { id: 'c3', name: '可乐', price: 2.5, qty: 1 }],
          subtotal: 18.5, packagingFee: 0.30, deliveryFee: 0, total: 18.8, deliveryMode: 'fixed', deliveryTime: '12:00',
          membershipJson: '',
          screenshot: s({ total: 18.8 }), status: 'delivered', rejectReason: '', deliveryPhoto: utils.sampleDelivery() },
      ],
      payments: [],
      activeOrderId: null,
    };
  }

  // 把后端 Sheet 行映射成前端订单对象
  function normalizeRemoteOrder(r) {
    if (!r) return null;
    const items = Array.isArray(r.items) ? r.items.map((it) => ({ id: it.id || '', name: it.name || '', price: Number(it.price) || 0, qty: Number(it.qty) || 1 })) : [];
    const subtotal = Number(r.subtotal) || items.reduce((s, it) => s + it.price * it.qty, 0);
    return {
      id: r.orderId || r.id || utils.genOrderId(), merchantId: r.vendorId,
      hubId: r.hubId || r.HubID || r.hub_id || '',
      createdAt: r.createdAt ? (Date.parse(r.createdAt) || Date.now()) : Date.now(), createdAtText: String(r.createdAt || ''),
      customer: { name: r.customerName || '', phone: r.phone || '', building: r.building || '', room: r.room || '' }, remark: r.remark || '',
      items, subtotal, packagingFee: Number(r.packagingFee) || 0, deliveryFee: Number(r.deliveryFee) || 0,
      total: Number(r.total) || subtotal, deliveryMode: r.deliveryMode || 'fixed', deliveryTime: r.deliveryTime || '',
      screenshot: utils.fastDriveImg(r.screenshotUrl || r.screenshot || ''), status: r.status || 'pending', rejectReason: r.rejectReason || '', deliveryPhoto: utils.fastDriveImg(r.deliveryPhotoUrl || ''),
      membershipJson: r.membershipJson || '',
    };
  }

  function mapRemoteItem(it) {
    const avail = it.available === true || String(it.available).toUpperCase() === 'TRUE';
    const n = Number(it.stock);
    const stock = (it.stock === '' || it.stock === null || it.stock === undefined || isNaN(n)) ? null : n;
    let optionGroups = []; try { optionGroups = it.optionsJson ? JSON.parse(it.optionsJson) : []; } catch (e) {}
    let discount = null; try { discount = it.discountJson ? JSON.parse(it.discountJson) : null; } catch (e) {}
    return { id: it.itemId, name: it.name, price: Number(it.price) || 0, available: avail, emoji: it.emoji || '🍽️', image: it.image || '', desc: it.desc || '', category: it.category || '食物', stock: stock, optionGroups: Array.isArray(optionGroups) ? optionGroups : [], discount: discount };
  }

  // C18 fix: 为 sync 队列生成稳定的去重键。每种 action 显式取它真正的"实体 ID"，
  // 而不是用顶层 vendorId/itemId/orderId（嵌套对象里的 ID 顶层永远 undefined）。
  // 同键 → 同实体的连续操作合并；不同键 → 即使同 action 也分别入队。
  function syncKey(p) {
    var a = p.action;
    switch (a) {
      case 'saveProduct':       return a + ':' + (p.product && p.product.itemId);
      case 'addPayment':        return a + ':' + (p.payment && p.payment.payId);
      case 'upsertVendor':      return a + ':' + (p.vendor && p.vendor.vendorId);
      case 'removeProduct':     return a + ':' + p.itemId;
      case 'updateOrderStatus':
      case 'cancelOrder':
      case 'attachScreenshot':  return a + ':' + p.orderId;
      case 'saveVendorConfig':
      case 'saveVendorPlan':    return a + ':' + p.vendorId;
      case 'addHubBuilding':
      case 'removeHubBuilding': return a + ':' + p.hubId + ':' + p.name; // 同 hub 不同 name 不合并
      case 'saveHub':
      case 'removeHub':
      case 'saveHubBuildings':  return a + ':' + p.hubId;
      case 'saveSubscription':  return a + ':' + (p.subscription && p.subscription.endpoint);
      case 'placeOrder':        return a + ':' + (p.order && p.order.orderId);
      default:                  return a + ':' + JSON.stringify(p).slice(0, 200); // 兜底，永不误合并不同 payload
    }
  }

  // ---- v3: 序列化前剥离 base64 大字段 ----
  function stripForStorage(s) {
    // 深拷贝并移除所有 data:image 字段（它们走 Drive 链接，不需要持久化在 state）
    try {
      var d = JSON.parse(s);
      if (d.merchants) d.merchants.forEach(function (m) {
        if (m.menu) m.menu.forEach(function (it) { if (utils.isImg(it.image)) it.image = ''; });
      });
      if (d.orders) d.orders.forEach(function (o) {
        // C20 fix: only strip already-uploaded shots (Drive URLs), keep pending base64
        if (utils.isImg(o.screenshot) && o.imgStatus === 'ok') o.screenshot = '';
        if (utils.isImg(o.deliveryPhoto) && o.imgStatus === 'ok') o.deliveryPhoto = '';
      });
      return JSON.stringify(d);
    } catch (e) { return s; }
  }

  function loadState() { try { const r = localStorage.getItem(STORAGE_KEY); return r ? JSON.parse(r) : seedState(); } catch (e) { return seedState(); } }
  function loadProfile() {
    try {
      const r = localStorage.getItem(PROFILE_KEY); if (!r) return null;
      const p = JSON.parse(r); if (!p) return null;
      // 兼容旧格式：{name,phone,building,room} → {name,phone,addresses:[{id,label,building,room,isDefault}]}
      if (!Array.isArray(p.addresses)) {
        const id = 'a' + Date.now();
        p.addresses = [{ id, label: '默认地址', building: p.building || '', room: p.room || '', isDefault: true }];
        delete p.building; delete p.room;
      }
      // 保证至少一个默认
      if (p.addresses.length && !p.addresses.some((a) => a.isDefault)) p.addresses[0].isDefault = true;
      return p;
    } catch (e) { return null; }
  }
  // 客户选的社区：优先 URL ?hub= → 其次 localStorage → 否则空（首次访问 → 弹选择器）
  var HUB_KEY = 'canteen_hub_v1';
  function readHub() {
    try {
      var u = (new URLSearchParams(location.search).get('hub') || '').trim().toLowerCase();
      if (u) { try { localStorage.setItem(HUB_KEY, u); } catch (e) {} return u; }
      var s = localStorage.getItem(HUB_KEY); return s ? s.trim().toLowerCase() : '';
    } catch (e) { return ''; }
  }
  function writeHub(hubId) {
    try { localStorage.setItem(HUB_KEY, String(hubId || '').toLowerCase()); } catch (e) {}
  }
  function loadAuth() {
    try {
      const r = localStorage.getItem(AUTH_KEY); if (!r) return null;
      const a = JSON.parse(r);
      // token 与后端一样 7 天有效；过期则视为未登录，需重新登录
      if (a && a.ts && (Date.now() - a.ts) > 7 * 24 * 60 * 60 * 1000) { localStorage.removeItem(AUTH_KEY); return null; }
      return a;
    } catch (e) { return null; }
  }

  const state = reactive(loadState());
  // 乐观下单：上次会话被打断的中间态，重载后归一——"上传中"图视为失败(可补传)，"同步中"文字回退到 pending(待续传)
  if (Array.isArray(state.orders)) state.orders.forEach(function (o) {
    if (o.imgStatus === 'uploading') o.imgStatus = 'failed';
    if (o.syncStatus === 'syncing') o.syncStatus = 'pending';
  });
  const ui = reactive({
    studentTab: 'home',
    studentStep: 'merchants',
    studentMerchantId: null,
    merchantId: null,
    preview: false,
    menuLoading: false,
    menuError: false,
    merchantMenuLoading: false,
    merchantOrdersLoading: false,
    myOrdersRefreshing: false,
    myOrdersError: false,
    selectedAddrId: null, // 地址簿当前选中的地址 id（不持久化；空 → 走默认地址）
  });
  const _auth = loadAuth() || {};
  // 在线模式下：localStorage 里没 token = 上次「假登入」残留 → 视为未登录
  // （避免改密码后/前端 bug 导致空 token 还能进 admin 页面）
  var _online = !!(window.APP_CONFIG && window.APP_CONFIG.apiBase);
  var _hasValidAuth = _auth.user && (!_online || _auth.token);
  if (!_hasValidAuth && _auth.user) { try { localStorage.removeItem(AUTH_KEY); } catch (e) {} }
  const auth = reactive({ user: _hasValidAuth ? (_auth.user || (_auth.username ? _auth : null)) : null, token: _hasValidAuth ? (_auth.token || '') : '' });
  if (auth.user && auth.user.merchantId) ui.merchantId = auth.user.merchantId;

  // ---- v3: Toast 通知系统 ----
  const toast = reactive({ visible: false, message: '', type: 'info' }); // info | error | success
  var _toastTimer = null;
  function showToast(message, type) {
    if (_toastTimer) clearTimeout(_toastTimer);
    toast.message = message; toast.type = type || 'info'; toast.visible = true;
    _toastTimer = setTimeout(function () { toast.visible = false; }, 3500);
  }

  // ---- v3: 在线状态检测 ----
  const online = reactive({ value: navigator.onLine !== false });
  window.addEventListener('online', function () { online.value = true; showToast('网络已恢复', 'success'); });
  window.addEventListener('offline', function () { online.value = false; showToast('当前处于离线状态，数据保存在本地', 'error'); });

  // ---- v3: 请求去重 ----
  var _pendingFetches = {};

  const store = reactive({
    state, ui, auth, utils, toast, online,
    profile: loadProfile(),
    currentHub: readHub(),
    pollIntervalMs: 15000, // 后端可动态调整

    // ---- Toast helpers ----
    showToast: showToast,
    toastError: function (msg) { showToast(msg, 'error'); },
    toastSuccess: function (msg) { showToast(msg, 'success'); },

    // ===== 社区/地区 =====
    get visibleMerchants() { return this.currentHub ? state.merchants.filter((m) => (m.hubId || '') === this.currentHub) : state.merchants; },
    hubLabel(id) { const h = state.hubs.find((x) => x.id === id); return h ? h.name : (id ? id.toUpperCase() + ' 团团' : ''); },
    currentHubLabel() { return this.currentHub ? this.hubLabel(this.currentHub) : ''; },
    setCurrentHub(hubId) {
      var id = String(hubId || '').toLowerCase().trim();
      this.currentHub = id;
      writeHub(id);
    },
    addHub(id, name) { id = (id || '').trim().toLowerCase(); if (!id) return false; if (state.hubs.some((h) => h.id === id)) return false; const nm = (name || '').trim() || id.toUpperCase() + ' 团团'; state.hubs.push({ id, name: nm }); this.sync_({ action: 'saveHub', hubId: id, name: nm }); return true; },
    updateHub(id, name) { const h = state.hubs.find((x) => x.id === id); if (h) { h.name = (name || '').trim() || h.name; this.sync_({ action: 'saveHub', hubId: id, name: h.name }); } },
    removeHub(id) { state.hubs = state.hubs.filter((h) => h.id !== id); this.sync_({ action: 'removeHub', hubId: id }); },
    // ---- 社区共享楼栋池 + 商家配送覆盖 ----
    async loadHubs() {
      if (!(window.api && window.api.enabled())) return;
      try {
        var r = await window.api.listHubs();
        if (r && r.ok && Array.isArray(r.hubs)) {
          state.hubs = r.hubs.map(function (h) { var b = []; try { b = h.buildingsJson ? JSON.parse(h.buildingsJson) : []; } catch (e) {} return { id: h.hubId, name: h.name, buildings: Array.isArray(b) ? b : [] }; });
        }
      } catch (e) {}
    },
    // 在线模式下：从后端拉真实商家列表（已过滤 TEST + 停业），清掉本地硬编码 demo
    async loadPublicVendors() {
      if (!(window.api && window.api.enabled())) return;
      try {
        var r = await window.api.listPublicVendors();
        if (r && r.ok && Array.isArray(r.vendors)) {
          // 重置 state.merchants 为真后端数据；保留 admin 已登入的本店设置（如有）
          var keepIds = (auth.user && auth.user.role === 'merchant' && auth.user.merchantId) ? [auth.user.merchantId] : [];
          var kept = state.merchants.filter(function (m) { return keepIds.indexOf(m.id) >= 0; });
          var fresh = r.vendors.map(function (v) {
            var existing = state.merchants.find(function (m) { return m.id === v.vendorId; });
            return existing ? Object.assign(existing, {
              name: v.shopName || existing.name,
              logo: v.logo || existing.logo,
              tngLabel: v.tngLabel || existing.tngLabel,
              plan: v.plan || 'basic',
              planUntil: v.planUntil || '',
              hubId: v.hubId || existing.hubId,
              open: typeof v.open === 'boolean' ? v.open : existing.open,
              settings: v.settings ? Object.assign(defaultSettings('fixed'), v.settings) : existing.settings,
              payQRs: Array.isArray(v.payQRs) ? v.payQRs : existing.payQRs,
              categories: Array.isArray(v.categories) && v.categories.length ? v.categories : existing.categories,
            }) : {
              id: v.vendorId, name: v.shopName, desc: '', logo: v.logo || '🏪',
              open: typeof v.open === 'boolean' ? v.open : true,
              tngLabel: v.tngLabel || '', plan: v.plan || 'basic', planUntil: v.planUntil || '',
              hubId: v.hubId || '',
              settings: v.settings ? Object.assign(defaultSettings('fixed'), v.settings) : defaultSettings('fixed'),
              payQRs: Array.isArray(v.payQRs) ? v.payQRs : [],
              categories: Array.isArray(v.categories) && v.categories.length ? v.categories : ['食物', '小吃', '饮料'],
              menu: [],
            };
          });
          // 合并：fresh + 商家自己的本店（如果不在 fresh 里）
          var merged = fresh.slice();
          kept.forEach(function (m) { if (!merged.find(function (x) { return x.id === m.id; })) merged.push(m); });
          state.merchants = merged;
        }
      } catch (e) {}
    },
    hubBuildings(hubId) { var h = state.hubs.find(function (x) { return x.id === hubId; }); return (h && h.buildings) || []; },
    toggleCoverage(mid, name) { var m = this.getMerchant(mid); if (!m) return; if (!m.settings.coverage) m.settings.coverage = []; var i = m.settings.coverage.indexOf(name); if (i >= 0) m.settings.coverage.splice(i, 1); else m.settings.coverage.push(name); this._syncMerchantConfig(mid); },
    async addBuildingToHub(mid, name) {
      var m = this.getMerchant(mid); if (!m) return; name = (name || '').trim(); if (!name) return;
      var added = false;
      if (window.api && window.api.enabled()) {
        try {
          var r = await window.api.addHubBuilding(m.hubId, name, auth.token);
          if (r && r.ok && Array.isArray(r.buildings)) {
            var h = state.hubs.find(function (x) { return x.id === m.hubId; });
            if (h) h.buildings = r.buildings; else state.hubs.push({ id: m.hubId, name: m.hubId, buildings: r.buildings });
            added = true;
          }
        } catch (e) {}
        // 在线添加失败（断网/后端拒绝）：不写入覆盖列表，避免出现「池里没有、却出现在客户下拉」的脏数据
        if (!added) { this.toastError('网络有点慢，请刷新页面再试'); return; }
      } else {
        var h2 = state.hubs.find(function (x) { return x.id === m.hubId; });
        if (h2) { if (!h2.buildings) h2.buildings = []; if (h2.buildings.indexOf(name) < 0) h2.buildings.push(name); }
        else { state.hubs.push({ id: m.hubId, name: m.hubId, buildings: [name] }); }
        added = true;
      }
      if (!added) return;
      if (!m.settings.coverage) m.settings.coverage = []; if (m.settings.coverage.indexOf(name) < 0) m.settings.coverage.push(name); this._syncMerchantConfig(mid);
    },

    // ===== Admin 楼栋管理 =====
    // 之前的版本：失败/超时静默吞掉，UI 还像加成功了；并发请求乱序到达时整列覆盖把已加的覆盖没了；
    //            demo 模式没后端时也走在线分支 → 永远失败、还无 toast。
    // 现在：① 返回 boolean 给调用方做串行控制（后端 LockService + 前端 await，双保险）
    //      ② 离线/demo 直接写本地，与 merchant 端 addBuildingToHub 一致
    //      ③ 失败大声 toast，不再静默吞
    async adminAddBuilding(hubId, name) {
      name = (name || '').trim(); if (!name) return false;
      if (!(window.api && window.api.enabled())) {
        // 离线/demo：本地直接 push，去重
        var hL = state.hubs.find(function (x) { return x.id === hubId; });
        if (hL) { if (!hL.buildings) hL.buildings = []; if (hL.buildings.indexOf(name) < 0) hL.buildings.push(name); }
        else state.hubs.push({ id: hubId, name: hubId, buildings: [name] });
        return true;
      }
      try {
        var r = await window.api.addHubBuilding(hubId, name, auth.token);
        if (r && r.ok && Array.isArray(r.buildings)) {
          var h = state.hubs.find(function (x) { return x.id === hubId; });
          if (h) h.buildings = r.buildings; else state.hubs.push({ id: hubId, name: hubId, buildings: r.buildings });
          return true;
        }
        this.toastError('添加楼栋失败：' + ((r && r.error) || '后端没回应（检查登录态/网络）'));
        return false;
      } catch (e) {
        this.toastError('添加楼栋失败：' + (e.message || e));
        return false;
      }
    },
    async adminRemoveBuilding(hubId, name) {
      if (!(window.api && window.api.enabled())) {
        var hL = state.hubs.find(function (x) { return x.id === hubId; });
        if (hL && hL.buildings) { var i = hL.buildings.indexOf(name); if (i >= 0) hL.buildings.splice(i, 1); }
        return true;
      }
      try {
        var r = await window.api.removeHubBuilding(hubId, name, auth.token);
        if (r && r.ok && Array.isArray(r.buildings)) {
          var h = state.hubs.find(function (x) { return x.id === hubId; });
          if (h) h.buildings = r.buildings;
          return true;
        }
        this.toastError('删除楼栋失败：' + ((r && r.error) || '后端没回应'));
        return false;
      } catch (e) {
        this.toastError('删除楼栋失败：' + (e.message || e));
        return false;
      }
    },
    async adminSaveBuildings(hubId, buildings) {
      if (!(window.api && window.api.enabled())) {
        var hL = state.hubs.find(function (x) { return x.id === hubId; });
        if (hL) hL.buildings = (buildings || []).slice();
        else state.hubs.push({ id: hubId, name: hubId, buildings: (buildings || []).slice() });
        return true;
      }
      try {
        var r = await window.api.saveHubBuildings(hubId, buildings, auth.token);
        if (r && r.ok && Array.isArray(r.buildings)) {
          var h = state.hubs.find(function (x) { return x.id === hubId; });
          if (h) h.buildings = r.buildings; else state.hubs.push({ id: hubId, name: hubId, buildings: r.buildings });
          return true;
        }
        this.toastError('保存楼栋失败：' + ((r && r.error) || '后端没回应'));
        return false;
      } catch (e) {
        this.toastError('保存楼栋失败：' + (e.message || e));
        return false;
      }
    },

    // ===== 查询 =====
    getMerchant(id) { return state.merchants.find((m) => m.id === id) || null; },
    getOrder(id) { return state.orders.find((o) => o.id === id) || null; },
    get activeOrder() { return state.activeOrderId ? this.getOrder(state.activeOrderId) : null; },
    get studentMerchant() { return ui.studentMerchantId ? this.getMerchant(ui.studentMerchantId) : null; },
    get merchant() { return ui.merchantId ? this.getMerchant(ui.merchantId) : null; },
    ordersOf(merchantId) { return state.orders.filter((o) => o.merchantId === merchantId); },

    // ===== 账号 / 登录 =====
    _persistAuth() { try { localStorage.setItem(AUTH_KEY, JSON.stringify({ user: auth.user, token: auth.token, ts: Date.now() })); } catch (e) {} },

    // v3: 本地登录仅用于后端不可用时的降级——从 accounts 数组中找（不含密码校验，密码由后端验证）
    login(username, password) {
      // 纯离线模式才会走到这里（后端不可用时的 fallback）
      var acc = state.accounts.find(function (a) { return a.username === (username || '').trim(); });
      if (acc) {
        // v3: 离线模式下默认密码匹配（仅演示用途）
        var demoPwds = { admin: 'admin123', shop1: '1234', shop2: '1234', shop3: '1234', shop4: '1234' };
        if (demoPwds[acc.username] === password) {
          this.setAuthUser({ username: acc.username, role: acc.role, merchantId: acc.merchantId }, '');
          return true;
        }
      }
      return false;
    },
    logout() { auth.user = null; auth.token = ''; ui.preview = false; localStorage.removeItem(AUTH_KEY); },
    usernameTaken(u) { return state.accounts.some((a) => a.username === (u || '').trim()); },
    setAuthUser(user, token) {
      auth.user = user; auth.token = token || ''; this._persistAuth();
      if (user && user.merchantId) ui.merchantId = user.merchantId;
      // 商家登录后 → 软引导开通新单推送（避免漏单）
      try {
        if (window.notify && user && user.role === 'merchant' && user.merchantId) {
          setTimeout(function () { window.notify.promptMerchantAfterLogin(user.merchantId); }, 800);
        }
        // Admin 登录后 → 引导开通系统告警推送（Worker Cron 异常会推这里）
        if (window.notify && user && user.role === 'admin') {
          setTimeout(async function () {
            try {
              if (window.notify.permission() === 'granted') {
                await window.notify.enable('admin', user.username || 'admin');
              } else {
                window.notify.maybePrompt('admin', user.username || 'admin');
              }
            } catch (_) {}
          }, 800);
        }
      } catch (_) {}
    },
    _applyVendor(vendor, menu) {
      let m = this.getMerchant(vendor.vendorId);
      if (!m) { m = { id: vendor.vendorId, name: '', desc: '', logo: '🏪', open: true, tngLabel: '', plan: 'basic', planUntil: '', settings: defaultSettings('fixed'), payQRs: [], categories: ['食物', '小吃', '饮料'], menu: [] }; state.merchants.push(m); }
      m.name = vendor.shopName || m.name; m.logo = vendor.logo || m.logo; m.tngLabel = vendor.tngLabel || m.tngLabel;
      if (vendor.plan !== undefined) m.plan = vendor.plan || 'basic';
      if (vendor.planUntil !== undefined) m.planUntil = vendor.planUntil || '';
      if (vendor.hubId !== undefined) m.hubId = vendor.hubId;
      if (typeof vendor.open === 'boolean') m.open = vendor.open;
      if (vendor.settings) m.settings = Object.assign(defaultSettings('fixed'), vendor.settings);
      if (Array.isArray(vendor.payQRs)) m.payQRs = vendor.payQRs;
      if (Array.isArray(vendor.categories) && vendor.categories.length) m.categories = vendor.categories;
      if (Array.isArray(menu)) m.menu = menu.map(mapRemoteItem);
      return m;
    },
    hydrateVendor(vendor, menu, orders) {
      if (!vendor) return;
      this._applyVendor(vendor, menu);
      if (Array.isArray(orders)) {
        var mapped = orders.map(normalizeRemoteOrder).filter(Boolean);
        state.orders = state.orders.filter(function (o) { return o.merchantId !== vendor.vendorId; }).concat(mapped);
      }
    },
    hydrateStorefront(vendor, menu) { if (vendor) this._applyVendor(vendor, menu); },

    // ---- v3: 商家登录后懒加载（带去重） ----
    _merchantDataLoaded: {},
    loadMerchantData(id) {
      if (!(window.api && window.api.enabled()) || this._merchantDataLoaded[id]) return;
      this._merchantDataLoaded[id] = true;
      this.loadHubs(); // 拉社区共享楼栋池（商家配送覆盖用）
      var self = this, m = this.getMerchant(id);
      // 仅当本地还没数据时才显示骨架；已有缓存就静默后台刷新（秒开、不闪）
      ui.merchantMenuLoading = !(m && m.menu && m.menu.length);
      ui.merchantOrdersLoading = !this.ordersOf(id).length;
      // 菜单/配置 与 订单 各自独立加载：谁先回来谁先渲染，不互相等待
      window.api.getStorefront(id)
        .then(function (r) { if (r && r.ok) self._applyVendor(r.vendor, r.menu); })
        .catch(function () {})
        .then(function () { ui.merchantMenuLoading = false; });
      window.api.getVendorOrders(id, auth.token)
        .then(function (r) { if (r && r.ok) { self.applyVendorOrders(id, r.orders); if (r.pollIntervalMs) self.pollIntervalMs = r.pollIntervalMs; } })
        .catch(function () { self._merchantDataLoaded[id] = false; })
        .then(function () { ui.merchantOrdersLoading = false; });
    },

    // ---- v3: 下拉刷新（带去重） ----
    refreshStorefront(id) {
      if (!id || !(window.api && window.api.enabled())) return;
      var key = 'sf_' + id;
      if (_pendingFetches[key]) return; // 去重：同一个店铺不并发请求
      ui.menuLoading = true;
      var self = this;
      _pendingFetches[key] = window.api.getStorefront(id).then(function (r) {
        if (r && r.ok) { self._sfCache[id] = { vendor: r.vendor, menu: r.menu };
        self.hydrateStorefront(r.vendor, r.menu); }
      }).catch(function () {}).then(function () { ui.menuLoading = false; delete _pendingFetches[key]; });
    },

    // ===== Admin 经营数据 =====
    adminData: { orders: [], vendors: [], loaded: false },
    async refreshAdminData() {
      if (!(window.api && window.api.enabled())) return;
      // 没拿到 admin token 直接 bail（避免「假登入」状态下乱报错）
      // 真 admin 登录成功 → auth.token 有值 → 才查后端
      if (!auth.token) return;
      try {
        var results = await Promise.all([this._send({ action: 'listAllOrders' }), this._send({ action: 'listVendors' })]);
        if (results[0] && results[0].ok) this.adminData.orders = results[0].orders || [];
        if (results[1] && results[1].ok) this.adminData.vendors = results[1].vendors || [];
        this.adminData.loaded = true;
      } catch (e) {
        // admin 端不掩饰技术错误，方便排查
        this.toastError('加载经营数据失败：' + ((e && e.message) || e));
      }
    },
    analytics() {
      if (window.api && window.api.enabled()) {
        return {
          orders: this.adminData.orders.map((r) => ({ vendorId: String(r.vendorId), total: Number(r.total) || 0, status: r.status, items: Array.isArray(r.items) ? r.items : [], at: Date.parse(r.createdAt) || 0, hubId: r.HubID || '' })),
          vendors: this.adminData.vendors.map((v) => ({ id: v.vendorId, name: v.shopName, hubId: v.HubID || '', open: !(v.active === false || String(v.active).toUpperCase() === 'FALSE') })),
        };
      }
      return {
        orders: state.orders.map((o) => ({ vendorId: o.merchantId, total: Number(o.total) || 0, status: o.status, items: o.items || [], at: o.createdAt || 0, hubId: o.hubId || '' })),
        vendors: state.merchants.map((m) => ({ id: m.id, name: m.name, hubId: m.hubId || '', open: !!m.open })),
      };
    },

    // ===== 后端同步（v3: 防抖队列） =====
    failedSyncs: [], syncError: '', syncBusy: false,
    _syncQueue: [], _syncTimer: null,
    async _send(payload) {
      var p = Object.assign({}, payload, { token: auth.token });
      var r = await window.api.post(p);
      if (r && r.ok === false) throw new Error(r.error || '同步失败');
      return r;
    },
    // v3: 300ms 防抖合并窗口
    // C18 fix: 去重键之前用顶层 vendorId/itemId/orderId，但 addPayment/saveProduct/upsertVendor
    // 的 ID 都在嵌套对象里 → 顶层三字段全 undefined → 同 action 不同 ID 的两个调用被错合并 →
    // 第二笔 payment 把第一笔覆盖 → 财务数据丢失。改用 syncKey() 为每种 action 显式取真实 ID。
    sync_(payload) {
      if (!(window.api && window.api.enabled())) return;
      var self = this;
      var newKey = syncKey(payload);
      var dupIdx = -1;
      for (var i = 0; i < self._syncQueue.length; i++) {
        if (syncKey(self._syncQueue[i]) === newKey) { dupIdx = i; break; }
      }
      if (dupIdx >= 0) self._syncQueue[dupIdx] = payload;
      else self._syncQueue.push(payload);

      if (self._syncTimer) clearTimeout(self._syncTimer);
      self._syncTimer = setTimeout(function () { self._flushSync(); }, 300);
    },
    async _flushSync() {
      var self = this;
      if (!self._syncQueue.length || self.syncBusy) return;
      self.syncBusy = true;
      var batch = self._syncQueue.slice(); self._syncQueue = [];
      for (var i = 0; i < batch.length; i++) {
        try { await self._send(batch[i]); }
        catch (e) { self.failedSyncs.push(batch[i]); self.syncError = String((e && e.message) || e); }
      }
      self.syncBusy = false;
      if (self.failedSyncs.length) self.toastError('网络有点慢，请刷新页面再试');
      else self.syncError = '';
      // C19 fix: if more items queued during flush, process them
      if (self._syncQueue.length) setTimeout(function () { self._flushSync(); }, 50);
    },
    async retrySync() {
      if (!this.failedSyncs.length || this.syncBusy) return;
      this.syncBusy = true;
      var queue = this.failedSyncs.slice(); this.failedSyncs = [];
      for (var i = 0; i < queue.length; i++) { try { await this._send(queue[i]); } catch (e) { this.failedSyncs.push(queue[i]); this.syncError = String((e && e.message) || e); } }
      this.syncBusy = false;
      if (!this.failedSyncs.length) { this.syncError = ''; this.toastSuccess('同步成功'); }
    },

    applyRemoteOrder(remote) {
      if (!remote) return;
      var o = this.getOrder(remote.orderId); if (!o) return;
      // 保护客户端刚点的"取消"：8s 内别让 stale poll 把 'cancelled' 冲回 'pending'
      var protect = o._localMutAt && (Date.now() - o._localMutAt) < 8000 && remote.status !== o.status;
      if (protect) {
        // 仅同步非冲突字段
        if (remote.deliveryPhotoUrl && !o.deliveryPhoto) o.deliveryPhoto = utils.fastDriveImg(remote.deliveryPhotoUrl);
        if (remote.deliveryTime) o.deliveryTime = remote.deliveryTime;
        return;
      }
      if (o._localMutAt && remote.status === o.status) o._localMutAt = 0; // 远端追上→清保护戳
      var _wasDel = o.status === 'delivered';
      o.status = remote.status;
      if (remote.rejectReason) o.rejectReason = remote.rejectReason;
      if (remote.deliveryPhotoUrl) o.deliveryPhoto = utils.fastDriveImg(remote.deliveryPhotoUrl);
      if (remote.deliveryTime) o.deliveryTime = remote.deliveryTime;
      if (!_wasDel && remote.status === 'delivered') this._notifyDelivered(o.id);
    },
    // 客户端提示音（本机偏好）+ 送达提示去重：同一单只在「变为已送达」时响一次
    _deliveredNotified: {},
    soundOn() { try { return localStorage.getItem('tt_sound_off') !== '1'; } catch (e) { return true; } },
    setSoundOn(on) { try { if (on) localStorage.removeItem('tt_sound_off'); else localStorage.setItem('tt_sound_off', '1'); } catch (e) {} },
    _notifyDelivered(id) { if (!id || this._deliveredNotified[id]) return; this._deliveredNotified[id] = true; if (this.soundOn()) utils.playAlert(); },
    applyVendorOrders(vendorId, remoteOrders) {
      if (!Array.isArray(remoteOrders)) return;
      var mapped = remoteOrders.map(normalizeRemoteOrder).filter(Boolean);
      // 智能合并：避免在途旧 poll 把刚改的状态冲回去（_localMutAt 8s 保护窗）
      // 原本 filter+concat 整组替换 → 乐观改完 status='cooking' 后，stale poll 返回 'pending' 会把本地覆盖回去 → 状态闪回
      var FRESH = 8000, NOW = Date.now();
      var byId = {}; mapped.forEach(function (m) { byId[m.id] = m; });
      var newList = [], seen = {};
      for (var i = 0; i < state.orders.length; i++) {
        var lo = state.orders[i];
        if (lo.merchantId !== vendorId) { newList.push(lo); continue; }
        var ro = byId[lo.id];
        if (!ro) {
          // 远端没这单：syncing/pending 的乐观未上行单保留；synced 但远端已无 → 远端真的清掉了，丢弃
          if (lo.syncStatus !== 'synced') newList.push(lo);
          continue;
        }
        seen[lo.id] = true;
        if (lo._localMutAt && (NOW - lo._localMutAt) < FRESH && ro.status !== lo.status) {
          // 保护期内、远端还没追上本地 → 用远端打底但保留本地的 status/rejectReason/deliveryPhoto/_localMutAt
          newList.push(Object.assign({}, ro, {
            status: lo.status, rejectReason: lo.rejectReason,
            deliveryPhoto: lo.deliveryPhoto || ro.deliveryPhoto,
            _localMutAt: lo._localMutAt
          }));
        } else {
          // 远端已追上(或保护期已过) → 用远端覆盖，保护戳自然脱落
          newList.push(ro);
        }
      }
      mapped.forEach(function (m) { if (!seen[m.id]) newList.push(m); });
      state.orders = newList;

      // 商家持续响铃：diff pending 集合
      //   新增 pending → ring.start（首次到达的新单）
      //   消失 pending → ring.stop（接单/拒单/取消/超时）
      // 只对登录商家本人（auth.user.role==='merchant'）的本店触发；admin god-view 时不响（避免误扰）
      try {
        if (window.merchantRinger
            && auth.user && auth.user.role === 'merchant'
            && auth.user.merchantId === vendorId) {
          if (!this._lastPending) this._lastPending = {};
          var prev = this._lastPending[vendorId] || {};
          var curr = {};
          newList.forEach(function (o) {
            if (o.merchantId === vendorId && o.status === 'pending' && o.syncStatus !== 'pending') curr[o.id] = true;
          });
          // 新出现的 pending → 响
          Object.keys(curr).forEach(function (id) { if (!prev[id]) window.merchantRinger.start(id); });
          // 离开 pending → 停
          Object.keys(prev).forEach(function (id) { if (!curr[id]) window.merchantRinger.stop(id); });
          this._lastPending[vendorId] = curr;
        }
      } catch (_) {}
    },
    // 客户「我的订单」：订单归属手机号——按本机 profile.phone 从后端拉，换设备同号也能看到、
    // 商家改的状态(接单/拒绝/取消/送达)也会同步过来。本地乐观未同步的单保留不动。
    async loadMyOrders() {
      if (!(window.api && window.api.enabled())) return;
      var ph = this.profile && this.profile.phone; if (!ph) return;
      var self = this;
      ui.myOrdersRefreshing = true; ui.myOrdersError = false;
      try {
        var r = await window.api.getOrdersByPhone(ph);
        if (r && r.ok && Array.isArray(r.orders)) {
          var NOW = Date.now();
          r.orders.map(normalizeRemoteOrder).filter(Boolean).forEach(function (so) {
            var lo = state.orders.find(function (x) { return x.id === so.id; });
            if (lo) {
              var _wd = lo.status === 'delivered';
              // 保护本地 8s 内的乐观突变(如刚点取消)：远端还没追上时别覆盖 status
              var protect = lo._localMutAt && (NOW - lo._localMutAt) < 8000 && so.status !== lo.status;
              if (!protect) {
                lo.status = so.status; lo.rejectReason = so.rejectReason;
                if (lo._localMutAt && so.status === lo.status) lo._localMutAt = 0; // 远端追上→清保护
              }
              if (so.deliveryPhoto) lo.deliveryPhoto = so.deliveryPhoto;
              if (so.total) lo.total = so.total;
              if (!_wd && !protect && so.status === 'delivered') self._notifyDelivered(lo.id);
            }
            else {
              so.syncStatus = 'synced'; so.imgStatus = so.screenshot ? 'ok' : 'none';
              if (self.profile) {
                // 地址簿：补本机 profile 信息时取 currentAddress 作为送达地址
                var a = self.currentAddress();
                so.customer = { name: self.profile.name || '', phone: self.profile.phone || '', building: (a && a.building) || '', room: (a && a.room) || '' };
              }
              state.orders.unshift(so);
            }
          });
        } else { ui.myOrdersError = true; }
      } catch (e) { ui.myOrdersError = true; }
      finally { ui.myOrdersRefreshing = false; }
    },
    cancelOrder(id) {
      var o = this.getOrder(id);
      if (o && o.status === 'pending') { o.status = 'cancelled'; o._localMutAt = Date.now(); this.sync_({ action: 'cancelOrder', orderId: id }); }
    },

    // 客户资料（v4：地址簿，支持多地址 + 默认 + 切换）
    saveProfile(p) {
      var name = utils.sanitize(p.name, 60);
      var phone = String(p.phone || '').replace(/\D/g, '');
      var prev = this.profile;
      if (Array.isArray(p.addresses) && p.addresses.length) {
        // 完整地址簿写入（管理页用）
        this.profile = { name: name, phone: phone, addresses: p.addresses.map(function (a) {
          return { id: a.id || ('a' + Date.now() + Math.floor(Math.random() * 1000)), label: utils.sanitize(a.label, 20) || '其他', building: utils.sanitize(a.building, 60), room: utils.sanitize(a.room, 30), isDefault: !!a.isDefault };
        }) };
        if (!this.profile.addresses.some(function (a) { return a.isDefault; })) this.profile.addresses[0].isDefault = true;
      } else if (prev && Array.isArray(prev.addresses) && prev.addresses.length) {
        // 已存在地址簿 + 更新 name/phone + building/room（更新默认地址）
        var addrs = prev.addresses.map(function (a) {
          var updated = Object.assign({}, a);
          if (p.building !== undefined) updated.building = utils.sanitize(p.building, 60);
          if (p.room !== undefined) updated.room = utils.sanitize(p.room, 30);
          return updated;
        });
        this.profile = { name: name, phone: phone, addresses: addrs };
      } else {
        // 首次填号或老数据：把 building/room 作为第一条默认地址
        this.profile = { name: name, phone: phone, addresses: [{ id: 'a' + Date.now(), label: '默认地址', building: utils.sanitize(p.building, 60), room: utils.sanitize(p.room, 30), isDefault: true }] };
      }
      this._persistProfile();
      this.loadMyOrders(); // 换号/首次填号后，拉该手机名下的订单
    },
    clearProfile() { this.profile = null; ui.selectedAddrId = null; localStorage.removeItem(PROFILE_KEY); },
    _persistProfile() { if (this.profile) localStorage.setItem(PROFILE_KEY, JSON.stringify(this.profile)); },
    // 当前送达地址：用户选过的 > 默认 > 第一条
    currentAddress() {
      if (!this.profile || !Array.isArray(this.profile.addresses) || !this.profile.addresses.length) return null;
      var list = this.profile.addresses;
      var sel = ui.selectedAddrId ? list.find(function (a) { return a.id === ui.selectedAddrId; }) : null;
      return sel || list.find(function (a) { return a.isDefault; }) || list[0];
    },
    selectAddress(id) { ui.selectedAddrId = id; },
    addAddress(label, building, room) {
      if (!this.profile) return null;
      if (this.profile.addresses.length >= 10) { this.toastError && this.toastError('最多保存 10 个地址'); return null; }
      var a = { id: 'a' + Date.now() + Math.floor(Math.random() * 1000), label: utils.sanitize(label, 20) || '其他', building: utils.sanitize(building, 60), room: utils.sanitize(room, 30), isDefault: false };
      this.profile.addresses.push(a); this._persistProfile(); return a.id;
    },
    updateAddress(id, patch) {
      if (!this.profile) return;
      var a = this.profile.addresses.find(function (x) { return x.id === id; }); if (!a) return;
      if (patch.label != null) a.label = utils.sanitize(patch.label, 20);
      if (patch.building != null) a.building = utils.sanitize(patch.building, 60);
      if (patch.room != null) a.room = utils.sanitize(patch.room, 30);
      this._persistProfile();
    },
    removeAddress(id) {
      if (!this.profile) return;
      var list = this.profile.addresses.filter(function (a) { return a.id !== id; });
      if (list.length === 0) { this.toastError && this.toastError('至少保留 1 个地址'); return; } // 不允许删空
      if (!list.some(function (a) { return a.isDefault; })) list[0].isDefault = true; // 删的是默认 → 升级第一个
      this.profile.addresses = list;
      if (ui.selectedAddrId === id) ui.selectedAddrId = null;
      this._persistProfile();
    },
    setDefaultAddress(id) {
      if (!this.profile) return;
      this.profile.addresses.forEach(function (a) { a.isDefault = a.id === id; });
      this._persistProfile();
    },

    // ===== 导航 =====
    _sfCache: {}, // v3: LRU 淘汰（最多 10 个）
    _sfCacheOrder: [], // 访问顺序

    openMerchant(id) {
      ui.studentMerchantId = id; ui.studentStep = 'menu';
      // LRU：命中则移到队尾（最近使用）
      if (this._sfCache[id]) {
        this._sfCacheOrder = this._sfCacheOrder.filter(function (x) { return x !== id; });
        this._sfCacheOrder.push(id);
      }
      // 超过容量：淘汰最旧的
      while (this._sfCacheOrder.length > 10) { delete this._sfCache[this._sfCacheOrder.shift()]; }

      // 内存缓存命中先渲染一次
      if (this._sfCache[id]) this.hydrateStorefront(this._sfCache[id].vendor, this._sfCache[id].menu);
      if (!(window.api && window.api.enabled())) return;

      var self = this, m = this.getMerchant(id);
      // 暖缓存：内存缓存命中，或 localStorage 持久化的 state 里已有该店菜单 → 用旧数据先撑住，
      // 不显骨架，只后台静默刷新(SWR)；只有完全没数据时才显骨架。冷启动后重开看过的店也能秒显。
      var hasLocal = !!this._sfCache[id] || !!(m && m.menu && m.menu.length);
      var key = 'sf_' + id;
      if (_pendingFetches[key]) return; // 去重：同店不并发
      ui.menuLoading = !hasLocal; ui.menuError = false;
      _pendingFetches[key] = window.api.getStorefront(id).then(function (r) {
        if (r && r.ok) {
          self._sfCache[id] = { vendor: r.vendor, menu: r.menu };
          if (self._sfCacheOrder.indexOf(id) < 0) self._sfCacheOrder.push(id);
          self.hydrateStorefront(r.vendor, r.menu);
        } else if (!hasLocal) { ui.menuError = true; } // 有旧数据时刷新失败就继续用旧的，不报错
      }).catch(function () { if (!hasLocal) ui.menuError = true; }).then(function () { ui.menuLoading = false; delete _pendingFetches[key]; });
    },

    // 商家配置/商品 → 后端
    _syncMerchantConfig(mid) {
      var m = this.getMerchant(mid); if (!m) return;
      this.sync_({ action: 'saveVendorConfig', vendorId: mid, settings: m.settings, payQRs: m.payQRs, categories: m.categories, open: !!m.open });
    },
    _syncProduct(mid, item) {
      var m = this.getMerchant(mid); if (!m || !item) return;
      this.sync_({ action: 'saveProduct', product: { itemId: item.id, vendorId: mid, HubID: m.hubId || '', name: item.name, price: item.price, available: item.available, image: item.image || '', emoji: item.emoji || '', desc: item.desc || '', category: item.category || '', stock: item.stock == null ? '' : item.stock, optionsJson: item.optionGroups || [], discountJson: item.discount || null } });
    },
    backToMerchants() { ui.studentStep = 'merchants'; ui.studentMerchantId = null; },
    previewAsStudent(merchantId) { ui.preview = true; ui.studentMerchantId = merchantId; ui.studentStep = 'menu'; },
    previewStorefront() { ui.preview = true; ui.studentMerchantId = null; ui.studentStep = 'merchants'; },
    exitPreview() { ui.preview = false; ui.studentStep = 'merchants'; ui.studentMerchantId = null; },

    feeBreakdown(merchant, subtotal) {
      var f = (merchant && merchant.settings.fees) || {};
      var packaging = f.packaging && f.packaging.enabled ? Number(f.packaging.amount) || 0 : 0;
      var delivery = f.delivery && f.delivery.enabled ? Number(f.delivery.amount) || 0 : 0;
      return { subtotal, packaging, delivery, total: subtotal + packaging + delivery };
    },

    // 下单（乐观先行）：本地立即建单、秒跳详情、0 阻塞；同步与传图全在后台跑
    placeOrder({ merchantId, items, deliveryTime, deliveryMode, screenshot, remark, redeemMembership, customer, isTest }) {
      var merchant = this.getMerchant(merchantId);
      var subtotal = items.reduce(function (s, it) { return s + it.price * it.qty; }, 0);
      var b = this.feeBreakdown(merchant, subtotal);
      var membershipDiscount = redeemMembership ? (this.membershipRedeemValue(merchant) || 0) : 0;
      var cleanRemark = utils.sanitize(remark || '', 120);
      var online = window.api && window.api.enabled();
      var order = { id: utils.genOrderId(), merchantId, hubId: (merchant && merchant.hubId) || '', createdAt: Date.now(), createdAtText: utils.nowTime(),
        customer: (function () {
          if (customer) return Object.assign({}, customer);
          // 地址簿：profile = {name, phone, addresses[]} → 取 currentAddress 拼成订单需要的 {name, phone, building, room}
          var p = this.profile || {}; var a = this.currentAddress ? this.currentAddress() : null;
          return { name: p.name || '', phone: p.phone || '', building: (a && a.building) || '', room: (a && a.room) || '' };
        }).call(this),
        remark: cleanRemark,
        items: items.map(function (it) { return { id: it.id, name: it.name, price: it.price, qty: it.qty, options: it.options || '' }; }),
        subtotal: b.subtotal, packagingFee: b.packaging, deliveryFee: b.delivery, total: Math.max(0, Math.round((b.total - membershipDiscount) * 100) / 100),
        membershipJson: '', redeemMembership: !!redeemMembership, isTest: !!isTest,
        deliveryMode, deliveryTime, screenshot: screenshot || '', status: 'pending', rejectReason: '', deliveryPhoto: '',
        syncStatus: online ? 'syncing' : 'synced', syncError: '', imgStatus: screenshot ? 'pending' : 'none' };
      // 乐观：立即入本地（localStorage 持久化）+ 设为当前单 → UI 秒跳详情
      state.orders.unshift(order); state.activeOrderId = order.id;
      // 后台同步（断网/冷启动自动重试；后端拒绝则停并提示）
      this.syncOrder(order.id);
      return { ok: true, order: order };
    },
    // 后台同步引擎：成功→synced（再后台传图）；后端拒绝(ok:false)→rejected 停重试；断网/超时/5xx→每8s 无限重试
    _orderRetry: {},
    _clearOrderRetry(orderId) { if (this._orderRetry[orderId]) { clearTimeout(this._orderRetry[orderId]); delete this._orderRetry[orderId]; } },
    _scheduleOrderRetry(orderId) { var self = this; this._clearOrderRetry(orderId); this._orderRetry[orderId] = setTimeout(function () { self.syncOrder(orderId); }, 8000); },
    syncOrder(orderId) {
      if (!(window.api && window.api.enabled())) return;
      var self = this; var o = this.getOrder(orderId);
      if (!o || o.syncStatus === 'synced' || o.syncStatus === 'rejected') return;
      o.syncStatus = 'syncing';
      var remote = { orderId: o.id, vendorId: o.merchantId, HubID: o.hubId, createdAt: new Date(o.createdAt).toISOString(),
        customerName: o.customer.name, phone: o.customer.phone, building: o.customer.building, room: o.customer.room, remark: o.remark,
        items: o.items, subtotal: o.subtotal, packagingFee: o.packagingFee, deliveryFee: o.deliveryFee, total: o.total,
        redeemMembership: !!o.redeemMembership, isTest: !!o.isTest,
        deliveryTime: o.deliveryTime, screenshotUrl: '', status: 'pending' };
      window.api.placeOrder(remote).then(function (r) {
        var x = self.getOrder(orderId); if (!x) return;
        if (r && r.ok) {
          x.syncStatus = 'synced'; self._clearOrderRetry(orderId);
          if (x.screenshot && x.imgStatus !== 'ok') self.uploadOrderShot(x.id, x.screenshot); // 文字同步成功后才传图
          // 下单成功 → 软引导客户开通通知（仅在 default 状态时弹一次，dismiss 后 7 天不再问）
          try { if (window.notify && o.customer && o.customer.phone) window.notify.promptCustomerAfterOrder(o.customer.phone); } catch (_) {}
        } else {
          x.syncStatus = 'rejected'; x.syncError = (r && r.error) || '网络有点慢，请刷新页面再试'; self._clearOrderRetry(orderId); // 库存/截止/券等：重试无用
        }
      }).catch(function () {
        var x = self.getOrder(orderId); if (x && x.syncStatus !== 'synced' && x.syncStatus !== 'rejected') { x.syncStatus = 'pending'; self._scheduleOrderRetry(orderId); } // 断网/冷启动超时：后台续命重试
      });
    },
    // 重开页面/恢复网络后，续传上次没同步完成的订单（文字 + 截图）
    resumePendingSyncs() {
      if (!(window.api && window.api.enabled())) return;
      var self = this;
      state.orders.forEach(function (o) {
        if (o.syncStatus === 'pending' || o.syncStatus === 'syncing') {
          self.syncOrder(o.id); // 文字单续传；成功后 syncOrder 内部会顺带 uploadOrderShot
        } else if (o.syncStatus === 'synced' && o.screenshot && /^data:/.test(o.screenshot)
                   && (o.imgStatus === 'pending' || o.imgStatus === 'uploading' || o.imgStatus === 'failed')) {
          // 跨会话续传截图：上次没成功的传图自动重试。
          // 含 'uploading' 卡死自愈：上次正在传时 app 被关 → 15s 定时器没了，重开后会永远卡在"同步中…"。
          // /^data:/ 区分本地 base64(待传) vs 已落 Drive 的 URL(已传成功)。
          o.imgStatus = 'pending';
          self.uploadOrderShot(o.id, o.screenshot);
        }
      });
    },
    // 两阶段下单·第二阶段：后台传图，15s 内未成则标记异常单（imgStatus=failed），可补传
    uploadOrderShot(orderId, image) {
      if (!(window.api && window.api.enabled()) || !image) return;
      var o = this.getOrder(orderId); if (!o) return;
      o.imgStatus = 'uploading'; o.screenshot = image;
      var self = this, done = false;
      var timer = setTimeout(function () { if (done) return; var x = self.getOrder(orderId); if (x && x.imgStatus === 'uploading') x.imgStatus = 'failed'; }, 15000);
      window.api.attachScreenshot(orderId, image).then(function (r) {
        done = true; clearTimeout(timer); var x = self.getOrder(orderId); if (!x) return;
        if (r && r.ok) { x.imgStatus = 'ok'; if (r.screenshotUrl) x.screenshot = utils.fastDriveImg(r.screenshotUrl); } else { x.imgStatus = 'failed'; }
      }).catch(function () { done = true; clearTimeout(timer); var x = self.getOrder(orderId); if (x) x.imgStatus = 'failed'; });
    },
    retryOrderShot(orderId) { var o = this.getOrder(orderId); if (o && o.screenshot) this.uploadOrderShot(orderId, o.screenshot); },

    // 状态流转
    // 商家端的乐观状态变更：盖 _localMutAt 时间戳，避免在途的旧 poll 把刚改的状态冲回去（见 applyVendorOrders 的保护窗）
    // C2 fix: status guards prevent invalid transitions
    approveOrder(id) { var o = this.getOrder(id); if (o && o.status === 'pending') { o.status = 'cooking'; o._localMutAt = Date.now(); try { window.merchantRinger && window.merchantRinger.stop(id); } catch (_) {} this.sync_({ action: 'updateOrderStatus', orderId: id, status: 'cooking' }); } },
    rejectOrder(id, reason) {
      var o = this.getOrder(id);
      if (o && o.status === 'pending') {
        o.status = 'rejected'; o.rejectReason = reason || '商家未通过对账'; o._localMutAt = Date.now();
        try { window.merchantRinger && window.merchantRinger.stop(id); } catch (_) {}
        // H16 fix: optimistically restore stock for local/demo mode
        if (o.items && o.items.length) {
          var mid = o.merchantId; var m = this.getMerchant(mid);
          if (m && m.menu) {
            o.items.forEach(function (it) {
              var menuItem = m.menu.find(function (x) { return x.id === it.id; });
              if (menuItem && menuItem.stock !== null && menuItem.stock !== undefined && !isNaN(Number(menuItem.stock))) {
                menuItem.stock = Number(menuItem.stock) + Number(it.qty || 0);
              }
            });
          }
        }
        this.sync_({ action: 'updateOrderStatus', orderId: id, status: 'rejected', rejectReason: o.rejectReason });
      }
    },
    // C2 fix: advanceOrder only from cooking→delivering→delivered (pending must go through approveOrder)
    advanceOrder(id) { var o = this.getOrder(id); if (!o) return; var f = ['cooking', 'delivering', 'delivered']; var i = f.indexOf(o.status); if (i >= 0 && i < f.length - 1) { o.status = f[i + 1]; o._localMutAt = Date.now(); this.sync_({ action: 'updateOrderStatus', orderId: id, status: o.status, deliveryPhoto: o.status === 'delivered' ? o.deliveryPhoto : '' }); } },
    setDeliveryPhoto(id, d) { var o = this.getOrder(id); if (o) { o.deliveryPhoto = d; o._localMutAt = Date.now(); if (d) this.sync_({ action: 'updateOrderStatus', orderId: id, status: o.status, deliveryPhoto: d }); } },
    // 批量送达：一批订单一次性标记已送达，并共用同一张到货照片（同地点多客户，不必逐个拍照发）
    batchDeliver(ids, photo) {
      var self = this; var now = Date.now();
      (ids || []).forEach(function (id) {
        var o = self.getOrder(id); if (!o) return;
        if (photo) o.deliveryPhoto = photo;
        o.status = 'delivered';
        o._localMutAt = now; // 同上：保护这次批量改动不被在途旧 poll 冲回
        self.sync_({ action: 'updateOrderStatus', orderId: id, status: 'delivered', deliveryPhoto: photo || o.deliveryPhoto || '' });
      });
    },

    // 菜单
    updatePrice(mid, iid, price) { var m = this.getMerchant(mid); if (!m) return; var it = m.menu.find(function (x) { return x.id === iid; }); if (it) { it.price = Math.max(0, Number(price) || 0); this._syncProduct(mid, it); } },
    updateItemField(mid, iid, field, val) { var m = this.getMerchant(mid); if (!m) return; var it = m.menu.find(function (x) { return x.id === iid; }); if (it) { it[field] = val; this._syncProduct(mid, it); } },
    toggleSoldOut(mid, iid) { var m = this.getMerchant(mid); if (!m) return; var it = m.menu.find(function (x) { return x.id === iid; }); if (it) { it.available = !it.available; this._syncProduct(mid, it); } },
    saveItemConfig(mid, iid, cfg) { var m = this.getMerchant(mid); if (!m) return; var it = m.menu.find(function (x) { return x.id === iid; }); if (it) { it.optionGroups = cfg.optionGroups || []; it.discount = cfg.discount || null; this._syncProduct(mid, it); } },
    addMenuItem(mid, category) { var m = this.getMerchant(mid); if (!m) return; var it = { id: utils.genId('it'), name: '新商品', price: 5.0, available: true, emoji: '🍽️', image: '', desc: '点这里编辑', category: category || (m.categories[0] || '食物'), stock: null }; m.menu.push(it); this._syncProduct(mid, it); },
    removeMenuItem(mid, iid) {
      var m = this.getMerchant(mid); if (!m) return;
      var idx = m.menu.findIndex(function (x) { return x.id === iid; }); if (idx < 0) return;
      var item = m.menu[idx]; m.menu.splice(idx, 1);
      this.sync_({ action: 'removeProduct', itemId: iid });
      // v3: 撤销栈（支持多层）
      if (!this._undoStack) this._undoStack = [];
      this._undoStack.push({ label: '已删除「' + item.name + '」', restore: function () { var mm = store.getMerchant(mid); if (mm) { mm.menu.splice(Math.min(idx, mm.menu.length), 0, item); store._syncProduct(mid, item); } } });
      if (this._undoStack.length > 5) this._undoStack.shift(); // 最多保留 5 层撤销
      this.pendingUndo = this._undoStack[this._undoStack.length - 1];
    },

    // 撤销
    pendingUndo: null,
    _undoStack: null,
    doUndo() {
      if (!this._undoStack || !this._undoStack.length) return;
      var act = this._undoStack.pop();
      act.restore();
      this.pendingUndo = this._undoStack.length ? this._undoStack[this._undoStack.length - 1] : null;
    },
    clearUndo() { this._undoStack = null; this.pendingUndo = null; },

    // 分类
    addCategory(mid, name) { var m = this.getMerchant(mid); if (!m) return; name = (name || '').trim(); if (name && m.categories.indexOf(name) < 0) { m.categories.push(name); this._syncMerchantConfig(mid); } },
    removeCategory(mid, name) {
      var m = this.getMerchant(mid); if (!m || m.categories.length <= 1) return;
      m.categories = m.categories.filter(function (c) { return c !== name; });
      var fallback = m.categories[0];
      m.menu.forEach(function (it) { if (it.category === name) { it.category = fallback; store._syncProduct(mid, it); } });
      this._syncMerchantConfig(mid);
    },
    groupedMenu(merchant, onlyAvailable) {
      if (!merchant) return [];
      var groups = [];
      var cats = merchant.categories && merchant.categories.length ? merchant.categories.slice() : ['食物'];
      cats.forEach(function (c) {
        var items = merchant.menu.filter(function (it) { return (it.category || cats[0]) === c; });
        if (onlyAvailable) items = items.filter(function (it) { return it.available; });
        if (items.length) groups.push({ name: c, items: items });
      });
      var others = merchant.menu.filter(function (it) { return cats.indexOf(it.category) < 0; });
      if (onlyAvailable) others = others.filter(function (it) { return it.available; });
      if (others.length) groups.push({ name: '其他', items: others });
      return groups;
    },

    // 配送设置
    setDeliveryMode(mid, mode) { var m = this.getMerchant(mid); if (m) { m.settings.deliveryMode = mode; this._syncMerchantConfig(mid); } },
    toggleOpen(mid) { var m = this.getMerchant(mid); if (m) { m.open = !m.open; this._syncMerchantConfig(mid); } },
    // ===== 套餐分层：专业版（会员积分 + 统计CRM）=====
    // pro 且未过期才享专业版；planUntil 为空 = 永久 pro；过期自动按基础版处理
    isPro(m) { if (!m || m.plan !== 'pro') return false; if (!m.planUntil) return true; return utils.todayYMD() <= m.planUntil; },
    planExpired(m) { return !!(m && m.plan === 'pro' && m.planUntil && utils.todayYMD() > m.planUntil); },
    get merchantIsPro() { return this.isPro(this.merchant); },

    // ===== 会员积分（团团豆）：PRO 专享，按商家独立 =====
    membershipOf(m) {
      if (!m || !m.settings || !m.settings.membership) return null;
      var mem = m.settings.membership;
      if (!mem.enabled) return null;
      if (!this.isPro(m)) return null;
      return mem;
    },
    membershipPoints(merchant, phone) {
      var mem = this.membershipOf(merchant);
      if (!mem || !mem.points || !phone) return 0;
      return Number(mem.points[phone]) || 0;
    },
    membershipCanRedeem(merchant, phone) {
      var mem = this.membershipOf(merchant);
      if (!mem) return false;
      var pts = this.membershipPoints(merchant, phone);
      var need = Number(mem.redeemPts) || 10;
      return pts >= need && (Number(mem.redeemRM) || 0) > 0;
    },
    membershipRedeemValue(merchant) {
      var mem = this.membershipOf(merchant);
      if (!mem) return 0;
      return Number(mem.redeemRM) || 0;
    },
    membershipRedeemPts(merchant) {
      var mem = this.membershipOf(merchant);
      if (!mem) return 10;
      return Number(mem.redeemPts) || 10;
    },
    membershipPtsPerRM(merchant) {
      var mem = this.membershipOf(merchant);
      if (!mem) return 1;
      return Math.max(1, Number(mem.ptsPerRM) || 1);
    },
    // 从订单 membershipJson 拆出展示字段
    parseMembership(order) {
      if (!order || !order.membershipJson) return { earned: 0, redeemed: false, discount: 0 };
      try { var mi = JSON.parse(order.membershipJson); return { earned: mi.earned || 0, redeemed: !!mi.redeemed, discount: mi.discount || 0 }; } catch (e) { return { earned: 0, redeemed: false, discount: 0 }; }
    },

    // ===== 计费 / 套餐管理（admin 端）=====
    PRO_PRICE: 39,  // 专业版月费（RM）
    BASIC_PRICE: 29, // 基础版月费（RM）
    _daysUntil(ymd) { try { return Math.ceil((new Date(ymd + 'T23:59').getTime() - Date.now()) / 86400000); } catch (e) { return 9999; } },
    planStatus(m) {
      if (!m) return { key: 'basic', label: '基础版 RM29' };
      if (this.planExpired(m)) return { key: 'expired', label: '已过期' };
      if (m.plan === 'pro') { var d = m.planUntil ? this._daysUntil(m.planUntil) : 9999; return d <= 14 ? { key: 'soon', label: '剩 ' + d + ' 天' } : { key: 'pro', label: '专业版 RM39' }; }
      return { key: 'basic', label: '基础版 RM29' };
    },
    // 计费用的商家规范列表：admin 在线时用 listVendors 返回的全量行，否则用本地 merchants
    billingRows() {
      if (window.api && window.api.enabled() && this.adminData.vendors.length) {
        return this.adminData.vendors.map(function (v) { return { id: v.vendorId, name: v.shopName, plan: v.plan || 'basic', planUntil: v.planUntil || '', hubId: v.HubID || '' }; });
      }
      return state.merchants.map(function (m) { return { id: m.id, name: m.name, plan: m.plan || 'basic', planUntil: m.planUntil || '', hubId: m.hubId || '' }; });
    },
    get billingSummary() {
      var self = this; var shops = this.billingRows();
      var proActive = shops.filter(function (m) { return self.isPro(m); });
      var basicActive = shops.filter(function (m) { return !self.isPro(m) && !self.planExpired(m); });
      var soon = proActive.filter(function (m) { return m.planUntil && self._daysUntil(m.planUntil) <= 14; });
      var expired = shops.filter(function (m) { return self.planExpired(m); });
      return { mrr: proActive.length * this.PRO_PRICE + basicActive.length * this.BASIC_PRICE, proActive: proActive.length, basic: basicActive.length, expiringSoon: soon.length, expired: expired.length, total: shops.length, revenueAll: state.payments.reduce(function (s, p) { return s + (Number(p.amount) || 0); }, 0) };
    },
    async loadPayments() {
      if (!(window.api && window.api.enabled())) return;
      try { var r = await window.api.listPayments(auth.token); if (r && r.ok && Array.isArray(r.payments)) state.payments = r.payments; } catch (e) {}
    },
    paymentsOf(mid) { return state.payments.filter(function (p) { return p.vendorId === mid; }).slice().sort(function (a, b) { return String(b.paidAt).localeCompare(String(a.paidAt)); }); },
    // 本地同步套餐到两处数据源（本地 merchants + admin 的 vendors 行），UI 立即反映
    _applyPlanLocal(mid, plan, planUntil) {
      var m = this.getMerchant(mid); if (m) { m.plan = plan; if (planUntil !== undefined) m.planUntil = planUntil; }
      var rv = this.adminData.vendors.find(function (v) { return v.vendorId === mid; });
      if (rv) { rv.plan = plan; if (planUntil !== undefined) rv.planUntil = planUntil; }
    },
    // 仅改套餐（不收款）
    setVendorPlan(mid, plan, planUntil) {
      plan = plan === 'pro' ? 'pro' : 'basic';
      this._applyPlanLocal(mid, plan, planUntil || '');
      this.sync_({ action: 'saveVendorPlan', vendorId: mid, plan: plan, planUntil: planUntil || '' });
    },
    // Admin 一键造测试商家：固定账号 test_basic / test_pro（密码 1234），灌 3 道菜让客户端能跑完整链路。
    // 幂等：账号已存在 → 不再造，只把套餐校正回 plan 参数后返回原 id（保证按钮所见即所得）。
    // 商家身上打 isTest='TEST'，可被「清除测试数据」按钮一并扫掉，不污染真实数据。
    ensureTestMerchant(plan) {
      plan = plan === 'pro' ? 'pro' : 'basic';
      var username = plan === 'pro' ? 'test_pro' : 'test_basic';
      var password = '1234';
      var existed = state.accounts.find(function (a) { return a.username === username; });
      if (existed) {
        // 校正套餐（防止被「设为 basic」改过后按钮失真）
        this.setVendorPlan(existed.merchantId, plan, plan === 'pro' ? '2099-12-31' : '');
        return { id: existed.merchantId, username: username, password: password, created: false };
      }
      var hubId = (state.hubs[0] && state.hubs[0].id) || '';
      var displayName = plan === 'pro' ? '🧪 测试·专业版商家' : '🧪 测试·基础版商家';
      var id = this.registerMerchant({
        name: displayName,
        desc: plan === 'pro' ? '专业版功能测试用（会员/CRM/券）' : '基础版功能测试用',
        logo: plan === 'pro' ? '💎' : '🆓',
        tngLabel: displayName, hubId: hubId,
        username: username, password: password, isTest: true,
      });
      if (plan === 'pro') this.setVendorPlan(id, 'pro', '2099-12-31');
      // 灌 3 道菜，让客户端能完整下单（不灌的话菜单空，customer 走不通）
      var m = this.getMerchant(id), self = this;
      if (m) {
        [
          { name: '测试招牌饭', price: 8.0, emoji: '🍱', desc: '测试用·标准菜品', category: '食物' },
          { name: '测试小食',   price: 4.5, emoji: '🍢', desc: '测试用·常规小吃', category: '小吃' },
          { name: '测试饮料',   price: 2.5, emoji: '🥤', desc: '测试用·饮料',     category: '饮料' },
        ].forEach(function (seed) {
          var it = { id: utils.genId('it'), name: seed.name, price: seed.price, available: true, emoji: seed.emoji, image: '', desc: seed.desc, category: seed.category, stock: null };
          m.menu.push(it); self._syncProduct(id, it);
        });
      }
      return { id: id, username: username, password: password, created: true };
    },
    // 记一笔收款（默认顺带续费：升到该套餐 + 到期日=本期结束）
    recordPayment(pmt) {
      var row = { payId: utils.genId('pay'), vendorId: pmt.vendorId, amount: Number(pmt.amount) || 0, plan: pmt.plan === 'pro' ? 'pro' : 'basic', paidAt: pmt.paidAt || utils.todayYMD(), periodStart: pmt.periodStart || '', periodEnd: pmt.periodEnd || '', note: pmt.note || '', isTest: pmt.isTest ? 'TEST' : '' };
      state.payments.unshift(row);
      // H33 fix: pro plan requires periodEnd (no permanent/unlimited free pro)
      if (row.plan === 'pro' && !row.periodEnd) { this.toastError('专业版套餐必须设置到期日'); return null; }
      if (pmt.applyPlan !== false) this._applyPlanLocal(pmt.vendorId, row.plan, row.periodEnd || undefined);
      this.sync_({ action: 'addPayment', payment: row, applyPlan: pmt.applyPlan !== false });
      return row;
    },

    // ===== 内部测试工具（admin 端，造数据均打 isTest 标记，可一键清除）=====
    _testCust(i) { var names = ['测试-阿明', '测试-小美', '测试-阿强', '测试-丽华', '测试-志伟']; var blds = ['A 栋', 'B 栋', 'C 栋']; return { name: names[i % names.length], phone: '0119' + String(1000000 + Math.floor(Math.random() * 8999999)), building: blds[i % blds.length], room: String(100 + Math.floor(Math.random() * 899)) }; },
    _firstTestMerchant() { return this.getMerchant('shop1') || state.merchants[0] || null; },
    _testCart(m) {
      var avail = (m.menu || []).filter(function (it) { return it.available !== false && it.stock !== 0 && !(it.optionGroups && it.optionGroups.length); });
      if (!avail.length) avail = (m.menu || []);
      var pick = avail[Math.floor(Math.random() * avail.length)] || { id: 't1', name: '测试商品', price: 8 };
      var price = utils.effPrice ? utils.effPrice(pick) : (pick.price || 8);
      return [{ id: pick.id, name: pick.name, price: price, qty: 1 + Math.floor(Math.random() * 2), options: '' }];
    },
    _placeTest(stt, i) {
      var m = this._firstTestMerchant(); if (!m) return null;
      var r = this.placeOrder({ merchantId: m.id, items: this._testCart(m), deliveryTime: '12:30', deliveryMode: (m.settings && m.settings.deliveryMode) || 'fixed', screenshot: '', remark: '测试' + (stt ? '·' + stt : ''), redeemMembership: false, customer: this._testCust(i || 0), isTest: true });
      return r && r.order ? r.order.id : null;
    },
    genTestOrders(n) { n = n || 5; var made = 0; for (var i = 0; i < n; i++) { if (this._placeTest('', i)) made++; } return made; },
    runTestFlow(stepMs) {
      var id = this._placeTest('全流程', 0); if (!id) return null; var self = this; stepMs = stepMs || 1200;
      setTimeout(function () { self.approveOrder(id); }, stepMs);
      setTimeout(function () { self.advanceOrder(id); }, stepMs * 2);
      setTimeout(function () { self.advanceOrder(id); }, stepMs * 3);
      return id;
    },
    simulateAllStates() {
      var self = this; var states = ['pending', 'cooking', 'delivering', 'delivered', 'rejected', 'cancelled'];
      var ids = states.map(function (stt, i) { return { s: stt, id: self._placeTest(stt, i) }; });
      // 留时间让订单先同步到后端，再推进状态（在线时避免「订单还没建好就改状态」）
      setTimeout(function () {
        ids.forEach(function (p) {
          if (!p.id) return;
          if (p.s === 'cooking') self.approveOrder(p.id);
          else if (p.s === 'delivering') { self.approveOrder(p.id); self.advanceOrder(p.id); }
          else if (p.s === 'delivered') { self.approveOrder(p.id); self.advanceOrder(p.id); self.advanceOrder(p.id); }
          else if (p.s === 'rejected') self.rejectOrder(p.id, '测试拒单');
          else if (p.s === 'cancelled') { var o = self.getOrder(p.id); if (o) { o.status = 'cancelled'; self.sync_({ action: 'cancelOrder', orderId: p.id }); } }
        });
      }, (window.api && window.api.enabled()) ? 1800 : 0);
      return ids.length;
    },
    async healthCheck() {
      var t0 = Date.now();
      if (window.api && window.api.enabled()) {
        try { var r = await window.api.health(auth.token); return { online: true, ok: !!(r && r.ok), ms: Date.now() - t0, schema: r && r.schema, counts: r && r.counts, error: r && r.error }; }
        catch (e) { return { online: true, ok: false, ms: Date.now() - t0, error: String(e) }; }
      }
      return { online: false, ok: true, ms: 0, counts: { vendors: state.merchants.length, orders: state.orders.length, payments: state.payments.length, testOrders: state.orders.filter(function (o) { return o.isTest; }).length } };
    },
    testDataCount() { return { orders: state.orders.filter(function (o) { return o.isTest; }).length, payments: state.payments.filter(function (p) { return p.isTest === 'TEST' || p.isTest === true; }).length }; },
    async clearTestData() {
      state.orders = state.orders.filter(function (o) { return !o.isTest; });
      state.payments = state.payments.filter(function (p) { return !(p.isTest === 'TEST' || p.isTest === true); });
      if (state.activeOrderId && !this.getOrder(state.activeOrderId)) state.activeOrderId = null;
      if (window.api && window.api.enabled()) {
        try { var r = await window.api.clearTestData(auth.token); return r || { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
      }
      return { ok: true, local: true };
    },
    async resetSeedData() {
      if (window.api && window.api.enabled()) {
        try { var r = await window.api.resetSeedData(auth.token); return r || { ok: true }; } catch (e) { return { ok: false, error: String(e) }; }
      }
      // 本地模式：清空后重新播种
      Object.assign(state, seedState());
      return { ok: true, local: true, message: 'Local data re-seeded' };
    },
    isOpen(m) {
      if (!m) return false;
      var h = m.settings && m.settings.hours;
      if (!h || !h.auto) return !!m.open;
      var days = h.openDays || [true, true, true, true, true, true, true];
      if (!days[new Date().getDay()]) return false;
      var now = utils.nowTime();
      if (h.openTime <= h.closeTime) return now >= h.openTime && now <= h.closeTime;
      return now >= h.openTime || now <= h.closeTime;
    },
    toggleDay(mid, dayIdx) { var m = this.getMerchant(mid); if (!m) return; if (!m.settings.hours.openDays) m.settings.hours.openDays = [true, true, true, true, true, true, true]; m.settings.hours.openDays[dayIdx] = !m.settings.hours.openDays[dayIdx]; this._syncMerchantConfig(mid); },

    // 收款码
    addPayQR(mid, label, image) { var m = this.getMerchant(mid); if (m) { m.payQRs.push({ id: utils.genId('qr'), label: label || '收款码', image: image }); this._syncMerchantConfig(mid); } },
    updatePayQRLabel(mid, qrId, label) { var m = this.getMerchant(mid); if (!m) return; var q = m.payQRs.find(function (x) { return x.id === qrId; }); if (q) { q.label = label; this._syncMerchantConfig(mid); } },
    removePayQR(mid, qrId) { var m = this.getMerchant(mid); if (m) { m.payQRs = m.payQRs.filter(function (x) { return x.id !== qrId; }); this._syncMerchantConfig(mid); } },

    // Admin：注册商家
    registerMerchant(data) {
      var id = utils.genId('shop');
      var cleanData = {
        name: utils.sanitize(data.name || '新商家', 60),
        desc: utils.sanitize(data.desc || '', 100),
        logo: utils.sanitize(data.logo || '🏪', 10),
        hubId: utils.sanitize(data.hubId || '', 30).toLowerCase(),
        tngLabel: utils.sanitize(data.tngLabel || data.name || 'New Shop', 60),
        username: utils.sanitize(data.username || '', 30),
        password: data.password
      };
      state.merchants.push({ id: id, name: cleanData.name, desc: cleanData.desc, logo: cleanData.logo, open: true, hubId: cleanData.hubId, tngLabel: cleanData.tngLabel, settings: defaultSettings('fixed'), payQRs: [], categories: ['食物', '小吃', '饮料'], menu: [], isTest: data.isTest ? 'TEST' : '' });
      state.accounts.push({ username: cleanData.username, role: 'merchant', merchantId: id });
      this._syncVendor(id);
      return id;
    },
    updateMerchant(id, data) {
      var m = this.getMerchant(id); if (!m) return;
      var clean = {};
      if (data.name !== undefined) clean.name = utils.sanitize(data.name, 60);
      if (data.desc !== undefined) clean.desc = utils.sanitize(data.desc, 100);
      if (data.logo !== undefined) clean.logo = utils.sanitize(data.logo, 10);
      if (data.hubId !== undefined) clean.hubId = utils.sanitize(data.hubId, 30).toLowerCase();
      if (data.tngLabel !== undefined) clean.tngLabel = utils.sanitize(data.tngLabel, 60);
      if (data.isTest !== undefined) clean.isTest = data.isTest ? 'TEST' : '';
      Object.assign(m, clean);
      this._syncVendor(id);
    },
    accountOf(merchantId) { return state.accounts.find(function (a) { return a.merchantId === merchantId; }) || null; },
    setMerchantPassword(merchantId, pwd) { var a = this.accountOf(merchantId); if (a && pwd) { this.sync_({ action: 'upsertVendor', vendor: { vendorId: merchantId, username: a.username, password: pwd } }); } },
    _syncVendor(id) {
      var m = this.getMerchant(id), a = this.accountOf(id);
      if (!m || !a) return;
      this.sync_({ action: 'upsertVendor', vendor: { vendorId: id, username: a.username, shopName: m.name, logo: m.logo, tngLabel: m.tngLabel, hubId: m.hubId || '', active: !!m.open, isTest: m.isTest || '' } });
    },
    removeMerchant(id) {
      var idx = state.merchants.findIndex(function (m) { return m.id === id; }); if (idx < 0) return;
      var merchant = state.merchants[idx];
      var orders = state.orders.filter(function (o) { return o.merchantId === id; });
      var account = state.accounts.find(function (a) { return a.merchantId === id; });
      state.merchants.splice(idx, 1);
      state.orders = state.orders.filter(function (o) { return o.merchantId !== id; });
      state.accounts = state.accounts.filter(function (a) { return a.merchantId !== id; });
      if (ui.merchantId === id) ui.merchantId = state.merchants[0] ? state.merchants[0].id : null;
      this.sync_({ action: 'removeVendor', vendorId: id });
      this.pendingUndo = { label: '已删除商家「' + merchant.name + '」', restore: function () {
        state.merchants.splice(Math.min(idx, state.merchants.length), 0, merchant);
        state.orders = state.orders.concat(orders);
        if (account) state.accounts.push(account);
      } };
    },

    resetAll() {
      Object.assign(state, seedState());
      ui.merchantId = null; ui.studentStep = 'merchants'; ui.studentMerchantId = null; ui.preview = false;
      this.logout(); this.profile = null; localStorage.removeItem(PROFILE_KEY);
      this._sfCache = {}; this._sfCacheOrder = []; this._merchantDataLoaded = {};
      this._undoStack = null; this.pendingUndo = null;
    },
  });

  // ==================== v3: 精准持久化 ====================
  // 仅监听 state 的顶层 key，避免 deep watch 全量序列化。
  // 序列化前剥离 base64 大图片字段，大幅减少 localStorage 写入量。
  var _persistSilentUntil = 0;
  function persistState() {
    if (Date.now() < _persistSilentUntil) return; // 跨标签同步静默期
    try {
      var raw = JSON.stringify(state);
      var stripped = stripForStorage(raw);
      localStorage.setItem(STORAGE_KEY, stripped);
      _lastPersisted = stripped;
    } catch (e) {}
  }

  var _lastPersisted = localStorage.getItem(STORAGE_KEY) || '';

  // v3: 分别监听需要持久化的顶层 key，而非整个 state
  var _persistKeys = ['merchants', 'orders', 'accounts', 'activeOrderId', 'hubs'];
  _persistKeys.forEach(function (key) {
    watch(function () { return state[key]; }, function () { persistState(); }, { deep: true });
  });

  // 跨标签页实时同步（v3: 防回声 — 收到 remote change 后 300ms 内不写入）
  window.addEventListener('storage', function (e) {
    if (e.key !== STORAGE_KEY || !e.newValue || e.newValue === _lastPersisted) return;
    _persistSilentUntil = Date.now() + 300;
    _lastPersisted = e.newValue;
    try {
      var d = JSON.parse(e.newValue);
      // 逐个赋值而非整体替换，保持 Vue 响应性
      if (d.hubs) state.hubs = d.hubs;
      if (d.merchants) state.merchants = d.merchants;
      if (d.orders) state.orders = d.orders;
      if (d.accounts) state.accounts = d.accounts;
      if (d.activeOrderId !== undefined) state.activeOrderId = d.activeOrderId;
    } catch (err) {}
  });

  window.store = store;
  // 乐观下单：重开页面后自动续传上次没同步完成的订单（断网/关页面兜底，捞回丢单）
  setTimeout(function () { try { store.resumePendingSyncs(); } catch (e) {} }, 400);
})();
