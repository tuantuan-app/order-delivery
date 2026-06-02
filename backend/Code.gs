/**
 * 团团 · Google Apps Script 后端 v3（高性能 + 安全加固）
 * ------------------------------------------------------------------
 * v3 改进：
 *   - 请求级数据缓存：同一次 HTTP 请求内每张表只读一次，后续走内存
 *   - 批量写入：updateOrderStatus 合并多次 setValue 为单次 batch
 *   - Token 修复：Date.now() 只调一次，消除毫秒级竞态
 *   - 密码加盐：SHA-256(pwd + salt)，salt 随机 16 位 hex
 *   - 输入校验：所有用户输入走 sanitize_()，防非法字符
 *   - 库存恢复：取消订单时自动回补库存
 *   - 服务端配送时间校验：placeOrder_ 校验 cutoff/closeTime
 *   - SystemLogs 只追加，无删除/修改接口
 *   - 自适应轮询提示：响应中带 pollIntervalMs 建议值
 */
const SHEET_ID = '';
const TAB_VENDORS = 'Vendors';
const TAB_ORDERS = 'Orders';
const TAB_ORDERS_ARCHIVE = 'OrdersArchive'; // 90+ 天前终态订单归档，热表保持小
const TAB_MENU = 'Menu';
const TAB_HUBS = 'Hubs';
const TAB_LOGS = 'SystemLogs';
const TAB_PAYMENTS = 'Payments';
const TAB_SUBSCRIPTIONS = 'Subscriptions';

const SCHEMA = {
  Vendors: ['vendorId', 'username', 'password', 'passwordHash', 'shopName', 'logo', 'tngLabel', 'HubID', 'active', 'settingsJson', 'payQRsJson', 'categoriesJson', 'plan', 'planUntil', 'isTest'],
  Payments: ['payId', 'vendorId', 'amount', 'plan', 'paidAt', 'periodStart', 'periodEnd', 'note', 'isTest'],
  Orders: ['orderId', 'vendorId', 'HubID', 'createdAt', 'customerName', 'phone', 'building', 'room', 'items', 'subtotal', 'packagingFee', 'deliveryFee', 'total', 'deliveryTime', 'screenshotUrl', 'status', 'rejectReason', 'deliveryPhotoUrl', 'remark', 'membershipJson', 'isTest', 'imagesPurgedAt'],
  // 归档表：跟 Orders 同 schema + archivedAt 时间戳；90 天前终态订单搬这里
  OrdersArchive: ['orderId', 'vendorId', 'HubID', 'createdAt', 'customerName', 'phone', 'building', 'room', 'items', 'subtotal', 'packagingFee', 'deliveryFee', 'total', 'deliveryTime', 'screenshotUrl', 'status', 'rejectReason', 'deliveryPhotoUrl', 'remark', 'membershipJson', 'isTest', 'imagesPurgedAt', 'archivedAt'],
  Menu: ['itemId', 'vendorId', 'HubID', 'name', 'price', 'available', 'image', 'emoji', 'desc', 'category', 'stock', 'optionsJson', 'discountJson', 'isTest'],
  Hubs: ['hubId', 'name', 'buildingsJson'],
  SystemLogs: ['timestamp', 'actor', 'action', 'details'],
  // Web Push 订阅。subId = SHA-256(endpoint) 保证幂等：同一设备重订阅会覆盖而非堆积
  Subscriptions: ['subId', 'role', 'identity', 'endpoint', 'p256dh', 'auth', 'ua', 'createdAt', 'lastNotifiedAt', 'failCount', 'isTest'],
};

const TOKEN_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

// ==================== 请求级数据缓存 ====================
// 同一次 doPost 内，每张表只从 Sheet 读一次，后续操作走内存。
// 写操作同时更新缓存和 Sheet，保证本次请求内后续读操作能看到最新数据。
var _reqCache = null; // { tableName: { headers: [], rows: [] }, dirty: Set }

function cacheReset_() {
  _reqCache = { _dirty: new Set() };
}

function cacheRead_(name) {
  if (!_reqCache) cacheReset_();
  if (_reqCache[name]) return _reqCache[name];
  const sh = sheet_(name);
  const values = sh.getDataRange().getValues();
  const headers = values.length > 0 ? values[0].map(String) : [];
  const rows = values.slice(1).map(function (row) {
    const o = {};
    headers.forEach(function (h, i) { o[h] = row[i]; });
    return o;
  });
  _reqCache[name] = { headers: headers, rows: rows };
  return _reqCache[name];
}

/** 在缓存中查找行（只读），避免每次遍历 */
function cacheFind_(name, col, val) {
  const c = cacheRead_(name);
  const ci = c.headers.indexOf(col);
  if (ci < 0) return null;
  for (var i = 0; i < c.rows.length; i++) {
    if (String(c.rows[i][col]) === String(val)) return c.rows[i];
  }
  return null;
}

function cacheFilter_(name, col, val) {
  const c = cacheRead_(name);
  return c.rows.filter(function (r) { return String(r[col]) === String(val); });
}

/** 标记表为脏，请求结束时批量写回 Sheet */
function cacheDirty_(name) {
  if (!_reqCache) cacheReset_();
  _reqCache._dirty.add(name);
}

/** 新增行（同时写缓存 + 标记脏） */
function cacheAppend_(name, obj) {
  const c = cacheRead_(name);
  const row = {};
  c.headers.forEach(function (h) {
    var v = obj[h];
    if (v && typeof v === 'object') v = JSON.stringify(v);
    row[h] = (v === undefined || v === null) ? '' : v;
  });
  c.rows.push(row);
  cacheDirty_(name);
}

/** 原地更新缓存中某行的某个字段（标记脏） */
function cacheUpdateCell_(name, idCol, idVal, setCol, setVal) {
  const c = cacheRead_(name);
  const row = c.rows.find(function (r) { return String(r[idCol]) === String(idVal); });
  if (!row) return false;
  row[setCol] = setVal;
  cacheDirty_(name);
  return true;
}

/** Upsert 缓存行 */
function cacheUpsert_(name, idCol, obj) {
  const c = cacheRead_(name);
  var existing = null;
  for (var i = 0; i < c.rows.length; i++) {
    if (String(c.rows[i][idCol]) === String(obj[idCol])) { existing = c.rows[i]; break; }
  }
  var row = {};
  c.headers.forEach(function (h) {
    var v = obj[h];
    if (v && typeof v === 'object') v = JSON.stringify(v);
    row[h] = (v === undefined || v === null) ? '' : v;
  });
  if (existing) Object.assign(existing, row);
  else c.rows.push(row);
  cacheDirty_(name);
}

/** 从缓存删除行 */
function cacheDelete_(name, col, val) {
  const c = cacheRead_(name);
  for (var i = c.rows.length - 1; i >= 0; i--) {
    if (String(c.rows[i][col]) === String(val)) c.rows.splice(i, 1);
  }
  cacheDirty_(name);
}

/** 将所有脏表写回 Sheet（请求结束时调用） */
function cacheFlush_() {
  if (!_reqCache) return;
  var dirty = _reqCache._dirty;
  if (!dirty || !dirty.size) return;
  var arr = [];
  dirty.forEach(function (name) { arr.push(name); });
  arr.forEach(function (name) {
    var c = _reqCache[name];
    if (!c) return;
    var sh = sheet_(name);
    // 写 header
    if (c.headers.length > 0) sh.getRange(1, 1, 1, c.headers.length).setValues([c.headers]);
    // 清空旧数据行（保留 header）
    var lastRow = sh.getLastRow();
    if (lastRow > 1) sh.deleteRows(2, lastRow - 1);
    // 批量写入所有行
    if (c.rows.length > 0) {
      var rowsArr = c.rows.map(function (row) {
        return c.headers.map(function (h) { return row[h] !== undefined ? row[h] : ''; });
      });
      sh.getRange(2, 1, rowsArr.length, c.headers.length).setValues(rowsArr);
    }
  });
}

// ==================== 自建库 / 表 ====================
var _ss = null;
var _schemaReady = false;

function ss_() {
  if (_ss) return _ss;
  if (SHEET_ID) { _ss = SpreadsheetApp.openById(SHEET_ID); return _ss; }
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) { _ss = active; return _ss; }
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('SHEET_ID');
  if (id) { try { _ss = SpreadsheetApp.openById(id); return _ss; } catch (e) {} }
  _ss = SpreadsheetApp.create('团团数据库');
  props.setProperty('SHEET_ID', _ss.getId());
  return _ss;
}

function sheet_(name) {
  const ss = ss_();
  let sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); if (SCHEMA[name]) sh.appendRow(SCHEMA[name]); }
  else if (sh.getLastRow() === 0 && SCHEMA[name]) sh.appendRow(SCHEMA[name]);
  return sh;
}

function migrateHeaders_(name) {
  if (!SCHEMA[name]) return;
  const sh = sheet_(name);
  const lastCol = Math.max(1, sh.getLastColumn());
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String);
  let col = headers.length;
  SCHEMA[name].forEach(function (h) { if (headers.indexOf(h) < 0) { col++; sh.getRange(1, col).setValue(h); } });
}

function ensureSchema_() {
  if (_schemaReady) return;
  const props = PropertiesService.getScriptProperties();
  // 版本号每加一张表都 +1，强制走一次 sheet_/migrateHeaders_ 创建新表 / 补列
  if (props.getProperty('SCHEMA_READY9') === '1') { _schemaReady = true; return; }
  Object.keys(SCHEMA).forEach(function (n) { sheet_(n); migrateHeaders_(n); });
  if (props.getProperty('SEEDED5') !== '1') {
    var cfg = defaultConfig_();
    var flexCfg = defaultConfig_(); flexCfg.deliveryMode = 'flexible';
    var cats = JSON.stringify(['食物', '小吃', '饮料']);
    var hpw = sha256_('1234');
    function vrow(id, name, logo, tng, hub, conf, qrs, plan, planUntil, active) {
      return { vendorId: id, username: id, password: '', passwordHash: hpw,
        shopName: name, logo: logo, tngLabel: tng, HubID: hub, active: active !== false,
        settingsJson: JSON.stringify(conf), payQRsJson: JSON.stringify(qrs), categoriesJson: cats,
        plan: plan || 'basic', planUntil: planUntil || '',
        isTest: 'TEST' }; // 所有 seed 商家自带 TEST 标 → admin「清除测试数据」可一键扫平
    }

    // shop1：PRO 专业版 — 配置包装费、扩展时段、会员积分
    cfg.membership = { enabled: true, ptsPerRM: 1, redeemPts: 10, redeemRM: 2, points: { "0123456701": 5, "0123456704": 12 } };
    cfg.fees.packaging = { enabled: true, amount: 0.50 };
    cfg.fixedSlots = ['12:00', '12:30', '13:00', '18:00', '18:30'];
    cfg.coverage = ['A 栋', 'B 栋', 'C 栋'];
    upsertRow_(TAB_VENDORS, 'vendorId', vrow('shop1', '阿强快餐', '🍛', 'Ah Keong Food', 'utm', cfg, [{ id: 'q1', label: "Touch 'n Go", image: demoQR_('TNG') }, { id: 'q2', label: '支付宝', image: demoQR_('Alipay') }], 'pro', '2026-12-31'));

    // shop2：基础版
    flexCfg.coverage = ['A 栋', 'B 栋'];
    flexCfg.flexibleMin = 25; flexCfg.flexibleMax = 35;
    upsertRow_(TAB_VENDORS, 'vendorId', vrow('shop2', '叻沙小馆', '🍜', 'Laksa House', 'utm', flexCfg, [{ id: 'q1', label: "Touch 'n Go", image: demoQR_('TNG') }], 'basic', ''));

    // shop3：已过期 PRO（planUntil 已过，店铺关闭）
    var cfg3 = defaultConfig_();
    cfg3.coverage = ['宿舍 1 座'];
    cfg3.fixedSlots = ['12:00', '13:00'];
    cfg3.fees.packaging = { enabled: true, amount: 0.30 };
    upsertRow_(TAB_VENDORS, 'vendorId', vrow('shop3', '炸鸡工坊', '🍗', 'Crispy Chicken', 'ukm', cfg3, [{ id: 'q1', label: "Touch 'n Go", image: demoQR_('TNG') }], 'pro', '2025-01-01', false));

    // shop4：新入驻基础版
    var flexCfg4 = defaultConfig_(); flexCfg4.deliveryMode = 'flexible';
    flexCfg4.coverage = ['C 栋', 'D 栋'];
    flexCfg4.flexibleMin = 30; flexCfg4.flexibleMax = 45;
    upsertRow_(TAB_VENDORS, 'vendorId', vrow('shop4', '深夜食堂', '🏮', 'Midnight Kitchen', 'utm', flexCfg4, [{ id: 'q1', label: "Touch 'n Go", image: demoQR_('TNG') }], 'basic', ''));

    // Hubs（含楼栋列表）
    upsertRow_(TAB_HUBS, 'hubId', { hubId: 'utm', name: 'UTM 团团', buildingsJson: JSON.stringify(['A 栋', 'B 栋', 'C 栋', 'D 栋', 'E 栋']) });
    upsertRow_(TAB_HUBS, 'hubId', { hubId: 'ukm', name: 'UKM 团团', buildingsJson: JSON.stringify(['宿舍 1 座', '宿舍 2 座', '宿舍 3 座']) });

    function M(id, vid, hub, name, price, emoji, desc, cat, stock, opts, disc) {
      return { itemId: id, vendorId: vid, HubID: hub, name: name, price: price, available: true, image: '', emoji: emoji, desc: desc, category: cat, stock: stock, optionsJson: opts ? JSON.stringify(opts) : '', discountJson: disc ? JSON.stringify(disc) : '', isTest: 'TEST' };
    }
    var ricePortion = [{ id: 'g1', name: '份量', type: 'single', required: true, max: 1, options: [{ id: 'o1', name: '标准', price: 0 }, { id: 'o2', name: '大份 (+饭)', price: 2 }] }, { id: 'g2', name: '加料', type: 'multi', required: false, max: 3, options: [{ id: 'o3', name: '加煎蛋', price: 1.5 }, { id: 'o4', name: '加香肠', price: 2 }, { id: 'o5', name: '加菜', price: 1 }] }];
    [
      // shop1 菜单
      M('a1', 'shop1', 'utm', '招牌鸡扒饭', 9.5, '🍗', '香煎鸡扒 + 白饭 + 时蔬', '食物', '', ricePortion, null),
      M('a2', 'shop1', 'utm', '黑椒牛肉饭', 11.0, '🥩', '黑椒滑牛肉，微辣', '食物', 5, null, null),
      M('a3', 'shop1', 'utm', '海南鸡饭', 8.0, '🍚', '油鸡 + 鸡油饭', '食物', '', null, { enabled: true, type: 'percent', value: 20 }),
      M('a4', 'shop1', 'utm', '美禄冰', 3.0, '🥤', '冰镇美禄加炼奶', '饮料', '', null, null),
      M('a5', 'shop1', 'utm', '香辣鸡翅(4只)', 7.0, '🍖', '辣味脆皮鸡翅', '小吃', 8, null, null),
      // shop2 菜单
      M('b1', 'shop2', 'utm', '咖喱叻沙', 7.5, '🍜', '浓郁椰香咖喱汤底', '食物', '', null, null),
      M('b2', 'shop2', 'utm', '亚参叻沙', 7.5, '🌶️', '酸辣开胃', '食物', '', null, null),
      M('b4', 'shop2', 'utm', '薏米水', 2.5, '🥛', '清热解腻', '饮料', '', null, null),
      // shop3 菜单
      M('c1', 'shop3', 'ukm', '炸鸡翼(3只)', 6.0, '🍖', '现炸脆皮', '小吃', '', null, null),
      M('c2', 'shop3', 'ukm', '薯条', 4.0, '🍟', '黄金薯条', '小吃', '', null, null),
      M('c3', 'shop3', 'ukm', '可乐', 2.5, '🥤', '冰镇', '饮料', '', null, null),
      // shop4 菜单
      M('d1', 'shop4', 'utm', '日式咖喱饭', 10.0, '🍛', '浓郁咖喱 + 米饭', '食物', '', null, null),
      M('d2', 'shop4', 'utm', '味噌拉面', 8.5, '🍜', '豚骨味噌汤底', '食物', '', null, null),
      M('d3', 'shop4', 'utm', '抹茶拿铁', 5.0, '🍵', '冰镇抹茶', '饮料', '', null, null),
    ].forEach(function (m) { upsertRow_(TAB_MENU, 'itemId', m); });
    props.setProperty('SEEDED5', '1');
  }
  props.setProperty('SCHEMA_READY9', '1'); _schemaReady = true;

  // ==== 一次性 migration：给老 seed 数据补打 isTest='TEST' 标 ====
  // 老版本部署时 seed 没标 TEST，导致 admin「清除测试数据」清不掉
  // 此 migration 找到种子 shopId / itemId 列表，强制打 TEST 标
  // 只跑一次，由 SEEDS_TAGGED1 标志位控制
  if (props.getProperty('SEEDS_TAGGED1') !== '1') {
    try {
      var seedVendorIds = ['shop1', 'shop2', 'shop3', 'shop4'];
      var seedItemIds = ['a1', 'a2', 'a3', 'a4', 'a5', 'b1', 'b2', 'b4', 'c1', 'c2', 'c3', 'd1', 'd2', 'd3'];
      var taggedV = 0, taggedM = 0;
      seedVendorIds.forEach(function (vid) {
        var v = cacheFind_(TAB_VENDORS, 'vendorId', vid);
        if (v && v.isTest !== 'TEST') { cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'isTest', 'TEST'); taggedV++; }
      });
      seedItemIds.forEach(function (iid) {
        var m = cacheFind_(TAB_MENU, 'itemId', iid);
        if (m && m.isTest !== 'TEST') { cacheUpdateCell_(TAB_MENU, 'itemId', iid, 'isTest', 'TEST'); taggedM++; }
      });
      cacheFlush_();
      logAction_('migration', 'SEEDS_TAGGED1', 'vendors=' + taggedV + ' menu=' + taggedM);
    } catch (e) {
      logAction_('migration', 'SEEDS_TAGGED1_FAIL', String(e).slice(0, 100));
    }
    props.setProperty('SEEDS_TAGGED1', '1');
  }
}

function setupSheet() { ensureSchema_(); const u = ss_().getUrl(); Logger.log('DB: ' + u); return u; }

// ==== 一次性工具：清空 Vendors/Orders/Menu/Payments/Subscriptions，保留 Hubs 和 schema ====
// 用 clasp 调：clasp run wipeAllData
// 或在 Apps Script 编辑器选这个函数 → Run
// 保留 SEEDED5='1' 防止下次请求自动再 seed
function wipeAllData() {
  ensureSchema_();
  cacheReset_();
  var tabs = [TAB_VENDORS, TAB_ORDERS, TAB_MENU, TAB_PAYMENTS, TAB_SUBSCRIPTIONS];
  var counts = {};
  tabs.forEach(function (name) {
    var sh = sheet_(name);
    var n = sh.getLastRow();
    if (n > 1) sh.deleteRows(2, n - 1); // 保留表头（第 1 行）
    counts[name] = n - 1;
  });
  PropertiesService.getScriptProperties().setProperty('SEEDED5', '1'); // 锁住别再 seed
  Logger.log('Wiped: ' + JSON.stringify(counts));
  return counts;
}

// HTTP 形式：workerSecret 守卫，可通过 /exec POST 触发
function wipeAllDataAction_(body) {
  var sp = PropertiesService.getScriptProperties();
  var storedSecret = sp.getProperty('WORKER_SECRET');
  // C14 fix: fail-closed — if WORKER_SECRET is not configured, reject ALL wipe attempts
  if (!storedSecret || body.workerSecret !== storedSecret) {
    return { ok: false, error: 'unauthorized' };
  }
  var counts = wipeAllData();
  return { ok: true, wiped: counts };
}

// ==================== 老订单截图清理（Drive 配额保护） ====================
// 30 天前的订单：删支付截图 + 送达照（释放 Drive 配额，绕过 15GB 限制），
// 但保留订单本身和金额、时间、状态等所有文字记录用于对账。
// imagesPurgedAt 列标时间戳：UI 看到这个标 + 空 screenshotUrl → 显示"截图已归档"
//
// 触发方式（任选其一）：
//   1) admin UI: 测试 tab 加按钮，doPost action='purgeOldImages'
//   2) 时间触发器（推荐）：Apps Script 编辑器 → 触发器 → 添加触发器 → purgeOldImagesDaily → 每天
//   3) Worker Cron：每日 POST {action:'purgeOldImages', workerSecret:..., days:30}
function purgeOldImages_(daysOld) {
  ensureSchema_();
  daysOld = Number(daysOld) || 30;
  var cutoff = Date.now() - daysOld * 86400000;
  var sh = sheet_(TAB_ORDERS);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: true, scanned: 0, deleted: 0, message: 'empty table' };
  var headers = values[0].map(String);
  var col = {
    createdAt: headers.indexOf('createdAt'),
    screenshotUrl: headers.indexOf('screenshotUrl'),
    deliveryPhotoUrl: headers.indexOf('deliveryPhotoUrl'),
    imagesPurgedAt: headers.indexOf('imagesPurgedAt'),
  };
  if (col.createdAt < 0 || col.screenshotUrl < 0 || col.imagesPurgedAt < 0) {
    return { ok: false, error: 'missing required columns (re-run ensureSchema_)' };
  }
  var scanned = 0, purged = 0, filesDeleted = 0;
  // 从第 2 行（数据首行）开始
  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var createdAt = row[col.createdAt];
    var ts = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
    if (!ts || ts > cutoff) continue;
    if (row[col.imagesPurgedAt]) continue; // 已清理
    scanned++;
    var changed = false;
    [col.screenshotUrl, col.deliveryPhotoUrl].forEach(function (ci) {
      if (ci < 0) return;
      var url = row[ci];
      if (!url) return;
      // Drive 文件 ID 提取（一般 25+ 位 base62）
      var m = String(url).match(/[-\w]{25,}/);
      if (!m) { row[ci] = ''; changed = true; return; }
      try { DriveApp.getFileById(m[0]).setTrashed(true); filesDeleted++; } catch (e) { /* 文件已不在，忽略 */ }
      row[ci] = ''; changed = true;
    });
    if (changed) {
      var rowIdx = r + 1; // sheet 1-based
      if (col.screenshotUrl >= 0) sh.getRange(rowIdx, col.screenshotUrl + 1).setValue('');
      if (col.deliveryPhotoUrl >= 0) sh.getRange(rowIdx, col.deliveryPhotoUrl + 1).setValue('');
      sh.getRange(rowIdx, col.imagesPurgedAt + 1).setValue(new Date().toISOString());
      purged++;
    }
  }
  cacheReset_(); // 缓存失效，下次读取走全新数据
  logAction_('system', 'IMAGES_PURGED', 'days=' + daysOld + ' scanned=' + scanned + ' purged=' + purged + ' files=' + filesDeleted);
  return { ok: true, scanned: scanned, purged: purged, filesDeleted: filesDeleted, daysOld: daysOld };
}

// Apps Script 时间触发器入口（用户自己在 Apps Script 编辑器 → 触发器 设每天跑）
function purgeOldImagesDaily() { return purgeOldImages_(30); }

// doPost 调用版（admin 鉴权）
function purgeOldImagesAction_(body) {
  return purgeOldImages_(body && body.days);
}

// ==================== 老订单归档（Sheet 10M cell 保护） ====================
// 90 天前 + 终态（delivered/rejected/cancelled）的订单：从 Orders 搬到 OrdersArchive
// 热表保持 ~90 天 × 20 商家 × 30 单 = 54k 行 ≈ 1.2M cell << 10M 上限，永不撞墙
// 归档表照样在同 workbook，可查（getArchivedOrders）；超过 8M cell 时返回警告让 admin 处理
//
// 触发方式（任选其一）：
//   1) admin UI: 测试 tab 加按钮，doPost action='archiveOldOrders'
//   2) 时间触发器（推荐）：Apps Script 编辑器 → 触发器 → archiveOldOrdersDaily → 每周
//   3) Worker Cron：每周日调一次
function archiveOldOrders_(daysOld) {
  ensureSchema_();
  daysOld = Number(daysOld) || 90;
  var cutoff = Date.now() - daysOld * 86400000;
  var terminal = { delivered: 1, rejected: 1, cancelled: 1 };
  var sh = sheet_(TAB_ORDERS);
  var ash = sheet_(TAB_ORDERS_ARCHIVE);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: true, scanned: 0, archived: 0, message: 'empty table' };
  var headers = values[0].map(String);
  var aHeaders = ash.getRange(1, 1, 1, Math.max(1, ash.getLastColumn())).getValues()[0].map(String);
  // 用列名映射，不假设两表列顺序一致
  var createdAtCol = headers.indexOf('createdAt');
  var statusCol = headers.indexOf('status');
  if (createdAtCol < 0 || statusCol < 0) return { ok: false, error: 'missing createdAt/status' };
  var archivedAtCol = aHeaders.indexOf('archivedAt');
  if (archivedAtCol < 0) return { ok: false, error: 'OrdersArchive 缺 archivedAt 列（re-run ensureSchema_）' };

  var nowIso = new Date().toISOString();
  var toArchive = [];   // 累积要写入归档的行（对齐 aHeaders 列顺序）
  var rowsToDelete = []; // 要从主表删除的行号（1-based，逆序删保索引）

  for (var r = 1; r < values.length; r++) {
    var row = values[r];
    var st = String(row[statusCol] || '').toLowerCase();
    if (!terminal[st]) continue;
    var createdAt = row[createdAtCol];
    var ts = createdAt instanceof Date ? createdAt.getTime() : Date.parse(String(createdAt));
    if (!ts || ts > cutoff) continue;
    // 构造归档行：按 aHeaders 顺序取值；archivedAt 用 nowIso
    var archRow = aHeaders.map(function (h, i) {
      if (h === 'archivedAt') return nowIso;
      var srcIdx = headers.indexOf(h);
      return srcIdx >= 0 ? row[srcIdx] : '';
    });
    toArchive.push(archRow);
    rowsToDelete.push(r + 1); // sheet 1-based
  }

  if (!toArchive.length) {
    return { ok: true, scanned: values.length - 1, archived: 0, message: '无可归档（无 ' + daysOld + ' 天前的终态订单）' };
  }

  // 批量 append 到归档表（一次 setValues 远快于逐行）
  var startRow = ash.getLastRow() + 1;
  ash.getRange(startRow, 1, toArchive.length, aHeaders.length).setValues(toArchive);

  // 从主表删除（逆序，避免行号错位）
  rowsToDelete.sort(function (a, b) { return b - a; });
  rowsToDelete.forEach(function (rn) { sh.deleteRow(rn); });

  cacheReset_();

  // 归档表容量检查：超 8M cell 提醒 admin 该手动 export 清理
  var aRows = ash.getLastRow() - 1;
  var aCells = aRows * aHeaders.length;
  var warning = '';
  if (aCells > 8000000) warning = '⚠ OrdersArchive 已用 ' + Math.round(aCells / 100000) / 10 + 'M cell（80% of 10M）。建议导出 CSV 后清空归档表';

  logAction_('system', 'ORDERS_ARCHIVED', 'days=' + daysOld + ' archived=' + toArchive.length + ' archiveRows=' + aRows);
  return { ok: true, scanned: values.length - 1, archived: toArchive.length, archiveRows: aRows, archiveCells: aCells, daysOld: daysOld, warning: warning };
}

// Apps Script 时间触发器入口（推荐每周日跑一次，归档不需要每天）
function archiveOldOrdersWeekly() { return archiveOldOrders_(90); }

// doPost 调用版（admin 鉴权）
function archiveOldOrdersAction_(body) {
  return archiveOldOrders_(body && body.days);
}

// 查询归档（admin / 商家本人 / 客户本人按需查；不进缓存避免吃 GAS 配额）
function getArchivedOrders_(body) {
  var t = verifyToken_(body && body.token);
  ensureSchema_();
  var sh = sheet_(TAB_ORDERS_ARCHIVE);
  var values = sh.getDataRange().getValues();
  if (values.length < 2) return { ok: true, orders: [], total: 0 };
  var headers = values[0].map(String);
  var rows = values.slice(1).map(function (row) {
    var o = {}; headers.forEach(function (h, i) { o[h] = row[i]; }); return o;
  });

  // 权限过滤
  var filter = body && body.filter || {};
  if (t && t.role === 'vendor') filter.vendorId = t.principal; // 商家只能看自己的
  if (filter.vendorId) rows = rows.filter(function (r) { return r.vendorId === filter.vendorId; });
  if (filter.phone) rows = rows.filter(function (r) { return String(r.phone || '').replace(/\D/g, '') === String(filter.phone).replace(/\D/g, ''); });
  if (filter.fromDate) rows = rows.filter(function (r) { return Date.parse(r.createdAt) >= Date.parse(filter.fromDate); });
  if (filter.toDate)   rows = rows.filter(function (r) { return Date.parse(r.createdAt) <= Date.parse(filter.toDate); });

  // 默认按时间倒序，分页
  rows.sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); });
  var limit = Math.min(Math.max(1, Number(body && body.limit) || 100), 500);
  var offset = Math.max(0, Number(body && body.offset) || 0);
  var paged = rows.slice(offset, offset + limit).map(parseItems_);

  return { ok: true, orders: paged, total: rows.length, limit: limit, offset: offset };
}

// ==================== 原始读写工具（仅 schema 初始化用，不参与请求缓存） ====================
function readRows_(name) {
  const values = sheet_(name).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(String);
  return values.slice(1).map(function (row) { const o = {}; headers.forEach(function (h, i) { o[h] = row[i]; }); return o; });
}

/**
 * 按 username 单行查找 Vendor，不进请求缓存、不读整张表到内存。
 * 仿照 readRows_/sheet_ 风格：读表头 + 遍历数据行，命中即返回。
 * 返回 { row: {字段对象}, rowIndex: <1-based sheet 行号>, headers: [...] }，未命中返回 null。
 */
function readVendorByUsername_(username) {
  const sh = sheet_(TAB_VENDORS);
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return null;
  const headers = values[0].map(String);
  const uc = headers.indexOf('username');
  if (uc < 0) return null;
  for (let r = 1; r < values.length; r++) {
    if (String(values[r][uc]) === String(username)) {
      const o = {};
      headers.forEach(function (h, i) { o[h] = values[r][i]; });
      return { row: o, rowIndex: r + 1, headers: headers };
    }
  }
  return null;
}

/** 直接按行号写单个字段（用于登录时密码升级，避免触发全表缓存读） */
function writeVendorCell_(rowIndex, headers, col, val) {
  const ci = headers.indexOf(col);
  if (ci < 0) return;
  sheet_(TAB_VENDORS).getRange(rowIndex, ci + 1).setValue(val);
}

function upsertRow_(name, idCol, obj) {
  const sh = sheet_(name);
  const data = sh.getDataRange().getValues();
  const headers = data[0].map(String);
  const ic = headers.indexOf(idCol);
  const rowArr = headers.map(function (h) { let v = obj[h]; if (v && typeof v === 'object') v = JSON.stringify(v); return v === undefined || v === null ? '' : v; });
  for (let r = 1; r < data.length; r++) if (String(data[r][ic]) === String(obj[idCol])) { sh.getRange(r + 1, 1, 1, rowArr.length).setValues([rowArr]); return; }
  sh.appendRow(rowArr);
}

function deleteRowsBy_(name, col, val) {
  const sh = sheet_(name);
  const data = sh.getDataRange().getValues();
  const c = data[0].map(String).indexOf(col);
  if (c < 0) return;
  for (let r = data.length - 1; r >= 1; r--) if (String(data[r][c]) === String(val)) sh.deleteRow(r + 1);
}

// ==================== 输入校验 & 清洗 ====================
var _sanitizePattern = /[<>"']/g;
function sanitize_(val, maxLen) {
  if (val === null || val === undefined) return '';
  var s = String(val).replace(_sanitizePattern, '');
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

function validateName_(name) {
  if (!name || String(name).trim().length === 0) return '姓名不能为空';
  if (String(name).length > 60) return '姓名不能超过60个字符';
  return null;
}

function validatePhone_(phone) {
  var s = String(phone || '').replace(/\D/g, '');
  if (s.length < 7 || s.length > 15) return '手机号格式不正确（7-15位数字）';
  return null;
}

function validateRequired_(val, label) {
  if (!val || String(val).trim().length === 0) return (label || '字段') + '不能为空';
  return null;
}

// ==================== 密码（C3 fix: SHA-256 + 随机 salt） ====================
// 旧格式：sha256(password) —— 无 salt，全员同密码同 hash，彩虹表秒破
// 新格式：salt:sha256(salt + ':' + password) —— 每用户独立 16 hex salt
// 兼容：verifyPwd_ 同时认两种格式；vendorLogin_ 成功后自动升级旧 hash 到新格式
function hashPwd_(password, salt) {
  salt = salt || Utilities.getUuid().replace(/-/g, '').slice(0, 16);
  return salt + ':' + sha256_(salt + ':' + String(password));
}
function verifyPwd_(password, stored) {
  if (!stored) return false;
  var s = String(stored);
  if (s.indexOf(':') < 0) return sha256_(password) === s.toLowerCase(); // 旧无盐格式兜底
  var salt = s.split(':')[0];
  return hashPwd_(password, salt) === s;
}
function isLegacyPwdHash_(stored) {
  return !!stored && String(stored).indexOf(':') < 0;
}

// ==================== Token（C15 fix: 加 role 前缀防提权） ====================
// 旧格式：base64("principal.ts.sig") —— 商家若用 vendorId='admin' 注册，登录拿到的
//        token 在 requireAdmin_ 里 === 'admin' 判定通过 → 提权漏洞
// 新格式：base64("role:principal.ts.sig") —— role 进签名内，commit_role 与 vendorId 分离
// verifyToken_ 旧返回字符串，新返回 {role, principal} 对象（旧客户端 token 会被拒，强制重登）
function makeToken_(principal, role) {
  role = role || 'vendor';
  var secret = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET');
  if (!secret || secret === 'change-me') {
    secret = Utilities.getUuid();
    PropertiesService.getScriptProperties().setProperty('TOKEN_SECRET', secret);
  }
  var now = Date.now(); // 只调一次！修复 v2 毫秒级竞态 bug
  var subject = role + ':' + principal; // role 进签名
  var payload = subject + '.' + now;
  return Utilities.base64EncodeWebSafe(payload + '.' + sha256_(payload + '.' + secret).slice(0, 24));
}

function verifyToken_(token) {
  try {
    var raw = Utilities.newBlob(Utilities.base64DecodeWebSafe(token)).getDataAsString();
    var parts = raw.split('.');
    if (parts.length < 3) return null;
    var subject = parts[0], ts = parts[1], sig = parts[2];
    var secret = PropertiesService.getScriptProperties().getProperty('TOKEN_SECRET') || '';
    if (!secret) return null;
    if (sha256_(subject + '.' + ts + '.' + secret).slice(0, 24) !== sig) return null;
    if (Date.now() - Number(ts) > TOKEN_MAX_AGE_MS) return null;
    var i = subject.indexOf(':');
    if (i < 0) return null; // 旧无 role 格式 → 强制重登（部署后一次性影响所有在线 token）
    return { role: subject.slice(0, i), principal: subject.slice(i + 1) };
  } catch (e) { return null; }
}
// 辅助：日志/审计需要 principal 字符串
function tokenPrincipal_(token) { var t = verifyToken_(token); return t ? t.principal : ''; }

function requireVendor_(body, vendorId) {
  var t = verifyToken_(body.token);
  if (!t) return '请重新登录（令牌无效或过期）';
  if (t.role === 'admin') return null; // admin 可代任意商家操作
  if (t.role !== 'vendor') return '需要商家身份';
  if (vendorId && t.principal !== String(vendorId)) return '无权操作其它商家的数据';
  return null;
}

function requireAdmin_(body) {
  var t = verifyToken_(body.token);
  return (t && t.role === 'admin') ? null : '需要管理员权限';
}

// ==================== Drive 图片 ====================
function getDriveFolder_() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty('DRIVE_FOLDER');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  var f = DriveApp.createFolder('团团-图片');
  props.setProperty('DRIVE_FOLDER', f.getId());
  return f;
}

function saveImageToDrive_(dataUrl, name) {
  if (!dataUrl || String(dataUrl).indexOf('data:') !== 0) return dataUrl || '';
  var blob;
  var b64 = String(dataUrl).match(/^data:([^;]+);base64,(.*)$/);
  if (b64) blob = Utilities.newBlob(Utilities.base64Decode(b64[2]), b64[1], name || 'img');
  else { var utf = String(dataUrl).match(/^data:([^;,]+)[^,]*,(.*)$/); if (!utf) return ''; blob = Utilities.newBlob(decodeURIComponent(utf[2]), utf[1], (name || 'img') + '.svg'); }
  var file = getDriveFolder_().createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  // thumbnail 端点比 lh3.googleusercontent.com/d/<id> 加载更快更稳；sz=w1000 够看清付款单号
  return 'https://drive.google.com/thumbnail?id=' + file.getId() + '&sz=w1000';
}

// ==================== 操作日志（v4：只走 Apps Script Logger，不再写 Sheet）====================
// 决定：放弃 Sheet 日志表
//   - 节省 GAS 执行时长（每次写一行 Sheet ~ 200ms）
//   - 节省 Sheet 10M cells 配额（日志增长无上限）
//   - Apps Script 「执行记录」面板已可查近期 console.log 输出（beta 阶段够用）
//   - 真出问题再回开 Sheet 日志（一行代码而已）
function logAction_(actor, action, details) {
  var sanitizedActor = sanitize_(actor, 100);
  var sanitizedAction = sanitize_(action, 100);
  var sanitizedDetails = typeof details === 'string' ? sanitize_(details, 500) : JSON.stringify(details);
  console.log('[%s] %s | %s', sanitizedAction, sanitizedActor, sanitizedDetails);
}

// ==================== HTTP 入口 ====================
function doGet() {
  ensureSchema_();
  return json_({ ok: true, service: 'community-delivery-v3', time: new Date().toISOString() });
}

function doPost(e) {
  var _t0 = Date.now(); // 用量监控：记录本次执行时长
  var _action = '?';
  cacheReset_(); // 请求级缓存：本次请求内每张表只读一次
  try {
    ensureSchema_();
    var raw = (e && e.postData && e.postData.contents) || '{}';
    var body = safeParse_(raw);
    if (!body || typeof body !== 'object') body = {};
    _action = (body && body.action) || '?';

    var result;
    switch (body.action) {
      // 公开
      case 'vendorLogin':       result = vendorLogin_(body); break;
      case 'adminLogin':        result = adminLogin_(body); break;
      case 'listHubs':          result = { ok: true, hubs: cacheRead_(TAB_HUBS).rows }; break;
      // 公开：客户端首页用 → 过滤 active=true + isTest != 'TEST'
      case 'listPublicVendors': result = listPublicVendors_(); break;
      case 'placeOrder':        result = withLock_(function () { return placeOrder_(body); }); break;
      case 'attachScreenshot':  result = withLock_(function () { return attachScreenshot_(body); }); break;
      case 'cancelOrder':       result = withLock_(function () { return cancelOrder_(body); }); break;
      case 'getOrder':          result = getOrder_(body); break;
      case 'getOrdersByPhone':  result = getOrdersByPhone_(body); break;
      case 'getMembership':     result = getMembership_(body); break;
      case 'getStorefront':     result = getStorefront_(body); break;
      // 商家
      case 'getVendorOrders':   result = getVendorOrders_(body); break;
      case 'updateOrderStatus': result = withLock_(function () { return updateOrderStatus_(body); }); break;
      case 'updateProduct':     result = withLock_(function () { return updateProduct_(body); }); break;
      case 'saveProduct':       result = withLock_(function () { return saveProduct_(body); }); break;
      case 'removeProduct':     result = withLock_(function () { return removeProduct_(body); }); break;
      case 'saveVendorConfig':  result = withLock_(function () { return saveVendorConfig_(body); }); break;
      // 管理员
      case 'listVendors':       result = adminGuard_(body, function () { return { ok: true, vendors: cacheRead_(TAB_VENDORS).rows, accounts: cacheRead_(TAB_VENDORS).rows }; }); break;
      case 'listAllOrders':     result = adminGuard_(body, function () { return { ok: true, orders: cacheRead_(TAB_ORDERS).rows.map(parseItems_) }; }); break;
      case 'upsertVendor':      result = adminGuard_(body, function () { return withLock_(function () { return upsertVendor_(body); }); }); break;
      case 'removeVendor':      result = adminGuard_(body, function () { return withLock_(function () { return removeVendor_(body); }); }); break;
      case 'saveHub':           result = adminGuard_(body, function () { return withLock_(function () { return saveHub_(body); }); }); break;
      case 'addHubBuilding':    result = withLock_(function () { return addHubBuilding_(body); }); break;
      case 'removeHub':         result = adminGuard_(body, function () { return withLock_(function () { return removeHub_(body); }); }); break;
      case 'removeHubBuilding': result = adminGuard_(body, function () { return withLock_(function () { return removeHubBuilding_(body); }); }); break;
      case 'saveHubBuildings':  result = adminGuard_(body, function () { return withLock_(function () { return saveHubBuildings_(body); }); }); break;
      // 计费 / 套餐（仅管理员）
      case 'saveVendorPlan':    result = adminGuard_(body, function () { return withLock_(function () { return saveVendorPlan_(body); }); }); break;
      case 'addPayment':        result = adminGuard_(body, function () { return withLock_(function () { return addPayment_(body); }); }); break;
      case 'listPayments':      result = adminGuard_(body, function () { return { ok: true, payments: cacheRead_(TAB_PAYMENTS).rows }; }); break;
      // 内部测试工具（仅管理员）
      case 'clearTestData':     result = adminGuard_(body, function () { return withLock_(function () { return clearTestData_(body); }); }); break;
      case 'resetSeedData':    result = adminGuard_(body, function () { return withLock_(function () { return resetSeedData_(body); }); }); break;
      case 'health':            result = adminGuard_(body, function () { return { ok: true, service: 'community-delivery', schema: 'SCHEMA_READY9', time: new Date().toISOString(), counts: { vendors: cacheRead_(TAB_VENDORS).rows.length, orders: cacheRead_(TAB_ORDERS).rows.length, payments: cacheRead_(TAB_PAYMENTS).rows.length, testOrders: cacheFilter_(TAB_ORDERS, 'isTest', 'TEST').length, subscriptions: cacheRead_(TAB_SUBSCRIPTIONS).rows.length } }; }); break;
      case 'getSystemUsage':    result = adminGuard_(body, function () { return getSystemUsage_(); }); break;
      // Web Push
      case 'saveSubscription':  result = withLock_(function () { return saveSubscription_(body); }); break;
      case 'testPush':          result = adminGuard_(body, function () { return testPush_(body); }); break;
      // 健康检查（由 CF Worker Cron 每小时调用；workerSecret 自鉴权，绕过 adminGuard）
      case 'systemSelfCheck':   result = systemSelfCheck_(body); break;
      // 一次性清表（workerSecret 自鉴权；保留 Hubs / schema / 表头）
      case 'wipeAllData':       result = wipeAllDataAction_(body); break;
      case 'purgeOldImages':    result = adminGuard_(body, function () { return withLock_(function () { return purgeOldImagesAction_(body); }); }); break;
      case 'archiveOldOrders':  result = adminGuard_(body, function () { return withLock_(function () { return archiveOldOrdersAction_(body); }); }); break;
      case 'getArchivedOrders': result = getArchivedOrders_(body); break;
      default:                  result = { ok: false, error: '未知操作: ' + sanitize_(String(body.action), 50) };
    }
    // C17 fix: cacheFlush_ 已挪进 withLock_ 内（防两请求 flush 交错）。
    //   纯读 action（listVendors/listPayments 等）不产生脏数据 → 不需 flush
    //   写 action 全部走 withLock_ → 锁内 flush 保证 mutation+flush 原子
    //   兜底：保留这里的 flush，处理"漏网"边界（万一新 action 没走 withLock_）
    try { cacheFlush_(); } catch (e) {}
    try { trackUsage_(_action, Date.now() - _t0); } catch (e) {} // 用量监控：失败不影响业务
    return json_(result);
  } catch (err) {
    try { cacheFlush_(); } catch (e) {}
    try { trackUsage_(_action + ':error', Date.now() - _t0); } catch (e) {}
    return json_({ ok: false, error: String(err).slice(0, 200) });
  }
}

// ==================== 用量监控（admin "系统配额"）====================
// 按天聚合调用次数 + 总执行时长，存 PropertiesService（脚本级、跨执行持久）
// 仅保留最近 7 天，避免 Property 上限（500KB / 500 keys）
function trackUsage_(action, ms) {
  var sp = PropertiesService.getScriptProperties();
  var key = 'u_' + Utilities.formatDate(new Date(), 'GMT+8', 'yyyyMMdd');
  var raw = sp.getProperty(key);
  var rec = raw ? safeParseObj_(raw) || { calls: {}, ms: 0 } : { calls: {}, ms: 0 };
  rec.calls[action] = (rec.calls[action] || 0) + 1;
  rec.ms = (rec.ms || 0) + (ms || 0);
  sp.setProperty(key, JSON.stringify(rec));
  // 5% 概率做一次清理（避免每次请求都扫 properties）
  if (Math.random() < 0.05) pruneUsage_(sp);
}
function pruneUsage_(sp) {
  var keep = {}; var today = new Date();
  for (var i = 0; i < 7; i++) {
    var d = new Date(today); d.setDate(d.getDate() - i);
    keep['u_' + Utilities.formatDate(d, 'GMT+8', 'yyyyMMdd')] = true;
  }
  var all = sp.getProperties();
  Object.keys(all).forEach(function (k) { if (k.indexOf('u_') === 0 && !keep[k]) sp.deleteProperty(k); });
}
function getSystemUsage_() {
  var sp = PropertiesService.getScriptProperties();
  var today = new Date();
  var days = [];
  for (var i = 6; i >= 0; i--) {
    var d = new Date(today); d.setDate(d.getDate() - i);
    var ymd = Utilities.formatDate(d, 'GMT+8', 'yyyyMMdd');
    var raw = sp.getProperty('u_' + ymd);
    var rec = raw ? safeParseObj_(raw) || { calls: {}, ms: 0 } : { calls: {}, ms: 0 };
    var totalCalls = Object.keys(rec.calls).reduce(function (s, k) { return s + rec.calls[k]; }, 0);
    days.push({ date: ymd, calls: totalCalls, ms: rec.ms || 0, byAction: rec.calls });
  }
  // 数据库尺寸
  var ordersRows = cacheRead_(TAB_ORDERS).rows.length;
  var vendorsRows = cacheRead_(TAB_VENDORS).rows.length;
  var paymentsRows = cacheRead_(TAB_PAYMENTS).rows.length;
  var orderCols = (TAB_HEADERS && TAB_HEADERS[TAB_ORDERS] || []).length || 20;
  var vendorCols = (TAB_HEADERS && TAB_HEADERS[TAB_VENDORS] || []).length || 12;
  var totalCells = ordersRows * orderCols + vendorsRows * vendorCols;
  return {
    ok: true,
    days: days,                                        // 最近 7 天，按日期升序
    quotaFreeMinutes: 90,                              // Apps Script 免费 90 分钟/天
    quotaWorkspaceMinutes: 360,                        // Workspace 6 小时/天
    sheets: { orders: ordersRows, vendors: vendorsRows, payments: paymentsRows, totalCells: totalCells, cellCap: 10000000 },
    timestamp: new Date().toISOString()
  };
}

function adminGuard_(body, fn) { var err = requireAdmin_(body); return err ? { ok: false, error: err } : fn(); }

function parseItems_(r) {
  r.items = safeParse_(r.items);
  if (r.deliveryTime instanceof Date) r.deliveryTime = Utilities.formatDate(r.deliveryTime, Session.getScriptTimeZone(), 'HH:mm');
  if (r.createdAt instanceof Date) r.createdAt = Utilities.formatDate(r.createdAt, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  return r;
}

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  // C1 fix: verify lock acquisition — without this, all mutating operations can race
  if (!lock.hasLock()) return { ok: false, error: 'System busy, please retry' };
  try {
    var r = fn();
    // C17 fix: flush in 锁内 — 之前 doPost 在锁外 finally flush，两请求 flush 可交错损坏数据
    try { cacheFlush_(); } catch (e) { /* flush 失败下次写时仍会重试，不丢数据 */ }
    return r;
  } finally { lock.releaseLock(); }
}

// ==================== 业务逻辑 ====================

// -- 登录 --
// 登录暴力破解防护：5 次失败 / 15 分钟 → 锁该账号 15 分钟
// 存 PropertiesService 计数 → 0 成本、跨请求持久
// 用 SHA-256(username) 截断做 key，避免账号枚举（攻击者看 key 列表无法推回 username）
function checkLoginRateLimit_(username) {
  var sp = PropertiesService.getScriptProperties();
  var key = 'lo_' + sha256_(username).slice(0, 16);
  var raw = sp.getProperty(key);
  var rec = raw ? safeParseObj_(raw) || { fails: 0, blockUntil: 0 } : { fails: 0, blockUntil: 0 };
  var now = Date.now();
  if (rec.blockUntil > now) {
    var remaining = Math.ceil((rec.blockUntil - now) / 60000);
    return { ok: false, error: '账号已锁定，请 ' + remaining + ' 分钟后再试', key: key, rec: rec };
  }
  return { ok: true, key: key, rec: rec };
}
function recordLoginFail_(check) {
  if (!check || !check.key || !check.rec) return;
  var sp = PropertiesService.getScriptProperties();
  check.rec.fails = (check.rec.fails || 0) + 1;
  if (check.rec.fails >= 5) {
    check.rec.blockUntil = Date.now() + 15 * 60 * 1000; // 15 分钟锁定
    check.rec.fails = 0; // 重置计数（下次又是 5 次新的窗口）
  }
  sp.setProperty(check.key, JSON.stringify(check.rec));
}
function recordLoginSuccess_(check) {
  if (!check || !check.key) return;
  try { PropertiesService.getScriptProperties().deleteProperty(check.key); } catch (_) {}
}

function vendorLogin_(body) {
  var username = sanitize_(body.username, 30).trim();
  var password = String(body.password || '');
  if (!username || !password) return { ok: false, error: '请输入账号和密码' };

  // 防暴力破解：先看 username 是否被锁
  var rate = checkLoginRateLimit_(username);
  if (!rate.ok) { logAction_(username, 'LOGIN_BLOCKED', '次数超限'); return { ok: false, error: rate.error }; }

  // 按 username 单行查找，避免把整张 Vendors 表读进请求缓存（登录提速关键）
  var found = readVendorByUsername_(username);
  // H22 fix: return generic error to prevent username enumeration
  if (!found) { recordLoginFail_(rate); logAction_(username, 'LOGIN_FAIL', 'invalid_credentials'); return { ok: false, error: '账号或密码错误' }; }
  var v = found.row;
  if (v.active === false || String(v.active).toUpperCase() === 'FALSE') { logAction_(username, 'LOGIN_FAIL', 'account_disabled'); return { ok: false, error: '账号或密码错误' }; }

  // 密码验证：C3 verifyPwd_ 同时认 新salt:hash 和 旧无盐sha256；明文兜底兼容老数据
  var ok = false;
  if (v.passwordHash) {
    ok = verifyPwd_(password, v.passwordHash);
  } else {
    ok = (String(v.password) === password);
  }

  // H22 fix: generic error to prevent password enumeration from different error messages
  if (!ok) { recordLoginFail_(rate); logAction_(username, 'LOGIN_FAIL', 'wrong_password'); return { ok: false, error: '账号或密码错误' }; }

  // 自动升级：明文 → 新salt:hash；或旧无盐 hash → 新salt:hash（彩虹表免疫）
  if (!v.passwordHash || isLegacyPwdHash_(v.passwordHash)) {
    writeVendorCell_(found.rowIndex, found.headers, 'passwordHash', hashPwd_(password));
    if (!v.passwordHash) writeVendorCell_(found.rowIndex, found.headers, 'password', '');
  }

  recordLoginSuccess_(rate);
  logAction_(username, 'LOGIN_SUCCESS', 'vendorId=' + v.vendorId);
  return { ok: true, token: makeToken_(String(v.vendorId), 'vendor'), vendor: vendorPublic_(v), pollIntervalMs: 15000 };
}

function adminLogin_(body) {
  var props = PropertiesService.getScriptProperties();
  var u = props.getProperty('ADMIN_USER');
  var pHash = props.getProperty('ADMIN_PASS_HASH');
  // C8/C16 fix: admin credentials must be configured; no default fallback
  if (!u || !pHash) return { ok: false, error: '管理员账号未配置，请联系平台初始化' };
  var username = sanitize_(body.username, 30).trim();

  // 防暴力破解：admin 也保护
  var rate = checkLoginRateLimit_('admin:' + username);
  if (!rate.ok) { logAction_(username, 'ADMIN_LOGIN_BLOCKED', '次数超限'); return { ok: false, error: rate.error }; }

  if (username === u && verifyPwd_(String(body.password || ''), pHash)) {
    recordLoginSuccess_(rate);
    logAction_(u, 'ADMIN_LOGIN_SUCCESS', '');
    // 自动升级 admin 密码 hash 旧无盐 → 新salt:hash（PropertiesService 直接覆盖）
    if (isLegacyPwdHash_(pHash)) {
      try { props.setProperty('ADMIN_PASS_HASH', hashPwd_(String(body.password || ''))); } catch (e) {}
    }
    return { ok: true, token: makeToken_('admin', 'admin') };
  }
  recordLoginFail_(rate);
  logAction_(username, 'ADMIN_LOGIN_FAIL', '');
  return { ok: false, error: '管理员账号或密码错误' };
}
function safeParseObj_(s) { try { var o = JSON.parse(s); return (o && typeof o === 'object') ? o : null; } catch (e) { return null; } }

// 套餐判定（服务端权威）：pro 且未过期才享专业版（会员积分 + 统计CRM）；planUntil 空=永久
function vendorIsPro_(v) {
  if (!v || String(v.plan) !== 'pro') return false;
  var until = String(v.planUntil || '');
  if (!until) return true;
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd') <= until;
}

function vendorPublic_(v) {
  var cats = safeParse_(v.categoriesJson);
  var settings = safeParseObj_(v.settingsJson) || defaultConfig_();
  // 脱敏：公开接口不暴露其他客户的积分数据
  if (settings.membership && settings.membership.points) {
    settings.membership = Object.assign({}, settings.membership, { points: {} });
  }
  return {
    vendorId: v.vendorId, shopName: v.shopName, logo: v.logo, tngLabel: v.tngLabel, hubId: v.HubID || '',
    open: !(v.active === false || String(v.active).toUpperCase() === 'FALSE'),
    plan: v.plan || 'basic', planUntil: v.planUntil || '',
    settings: settings,
    payQRs: safeParse_(v.payQRsJson) || [],
    categories: (cats && cats.length) ? cats : ['食物', '小吃', '饮料']
  };
}

function defaultConfig_() {
  return {
    deliveryOffered: true, deliveryMode: 'fixed', fixedSlots: ['12:30', '13:30'], flexibleMin: 20, flexibleMax: 30,
    fees: { packaging: { enabled: false, amount: 0.5 }, delivery: { enabled: false, amount: 1.0 } },
    hours: { auto: false, openTime: '08:00', closeTime: '20:00', openDays: [true, true, true, true, true, true, true] },
    cutoffMins: 20, flexCloseTime: '20:00'
  };
}

function demoQR_(seed) {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#fff"/><rect x="10" y="10" width="100" height="100" fill="none" stroke="#000" stroke-width="4"/><text x="60" y="66" font-size="14" text-anchor="middle" font-family="sans-serif">' + seed + '</text></svg>');
}

function menuOf_(vendorId) {
  return cacheFilter_(TAB_MENU, 'vendorId', vendorId).map(function (r) {
    if (r.stock === '' || r.stock === null) r.stock = null;
    return r;
  });
}

// -- 客户查会员积分（公开，按手机号 + 商家） --
function getMembership_(body) {
  var vid = sanitize_(String(body.vendorId || ''), 50);
  var phone = String(body.phone || '').replace(/\D/g, '');
  if (!vid || phone.length < 6) return { ok: false, error: '缺少 vendorId 或 phone' };
  var v = cacheFind_(TAB_VENDORS, 'vendorId', vid);
  if (!v) return { ok: false, error: '商家不存在' };
  var settings = safeParseObj_(v.settingsJson) || defaultConfig_();
  var m = (settings.membership && settings.membership.enabled) ? settings.membership : null;
  if (!m) return { ok: true, enabled: false };
  var pts = (m.points && m.points[phone]) ? Number(m.points[phone]) : 0;
  var needPts = Number(m.redeemPts) || 10;
  var valueRM = Number(m.redeemRM) || 0;
  return {
    ok: true, enabled: true,
    points: pts, ptsPerRM: Number(m.ptsPerRM) || 1,
    redeemPts: needPts, redeemRM: valueRM,
    canRedeem: pts >= needPts && valueRM > 0
  };
}

// -- 客户浏览店铺 --
function getStorefront_(body) {
  var vid = sanitize_(String(body.vendorId || ''), 50);
  var v = cacheFind_(TAB_VENDORS, 'vendorId', vid);
  if (!v) return { ok: false, error: '商家不存在' };
  // 测试商家不对外开放：直链访问也拒绝（即使有人猜到 vendorId）
  if (String(v.isTest || '').toUpperCase() === 'TEST') return { ok: false, error: '商家不存在' };
  return { ok: true, vendor: vendorPublic_(v), menu: menuOf_(v.vendorId), serverTime: new Date().toISOString() };
}

// 公开商家列表（客户端首页用）：过滤 active=false + isTest='TEST'
// 仅返回展示必需字段，密码哈希等敏感字段全部剥离
function listPublicVendors_() {
  var rows = cacheRead_(TAB_VENDORS).rows.filter(function (v) {
    if (String(v.isTest || '').toUpperCase() === 'TEST') return false; // 测试商家隐身
    if (v.active === false || String(v.active).toUpperCase() === 'FALSE') return false;
    return true;
  });
  var vendors = rows.map(function (v) {
    return vendorPublic_(v);
  });
  return { ok: true, vendors: vendors, serverTime: new Date().toISOString() };
}

// -- 商家配置 --
function saveVendorConfig_(body) {
  var err = requireVendor_(body, body.vendorId);
  if (err) return { ok: false, error: err };
  var vid = String(body.vendorId);
  if (body.settings) cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'settingsJson', JSON.stringify(body.settings));
  if (body.payQRs) cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'payQRsJson', JSON.stringify(body.payQRs));
  if (body.categories) cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'categoriesJson', JSON.stringify(body.categories));
  if (typeof body.open === 'boolean') cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'active', body.open);
  logAction_(tokenPrincipal_(body.token) || 'merchant', 'VENDOR_CONFIG', 'vendorId=' + vid);
  return { ok: true };
}

// -- 商品 CRUD --
function saveProduct_(body) {
  var p = body.product || {};
  var err = requireVendor_(body, p.vendorId);
  if (err) return { ok: false, error: err };
  // H21 fix: prevent cross-vendor overwrite via guessed itemId
  if (p.itemId) {
    var existing = cacheFind_(TAB_MENU, 'itemId', String(p.itemId));
    if (existing && String(existing.vendorId) !== String(p.vendorId)) {
      return { ok: false, error: '无权修改其他商家的商品' };
    }
  }
  if (!p.itemId) p.itemId = 'it_' + Utilities.getUuid().slice(0, 8);
  // 清洗
  if (p.name) p.name = sanitize_(p.name, 60);
  if (p.desc) p.desc = sanitize_(p.desc, 200);
  if (p.category) p.category = sanitize_(p.category, 30);
  if (p.image) p.image = saveImageToDrive_(p.image, p.itemId);
  cacheUpsert_(TAB_MENU, 'itemId', p);
  logAction_(tokenPrincipal_(body.token) || 'merchant', 'PRODUCT_SAVE', 'itemId=' + p.itemId + ' ' + (p.name || ''));
  return { ok: true, itemId: p.itemId };
}

function removeProduct_(body) {
  var itemId = sanitize_(String(body.itemId || ''), 50);
  var it = cacheFind_(TAB_MENU, 'itemId', itemId);
  if (!it) return { ok: false, error: '商品不存在' };
  var err = requireVendor_(body, it.vendorId);
  if (err) return { ok: false, error: err };
  cacheDelete_(TAB_MENU, 'itemId', itemId);
  logAction_(tokenPrincipal_(body.token) || 'merchant', 'PRODUCT_REMOVE', 'itemId=' + itemId);
  return { ok: true };
}

// -- 订单 --
function ordersOf_(vendorId) {
  return cacheFilter_(TAB_ORDERS, 'vendorId', vendorId).map(parseItems_);
}

function getVendorOrders_(body) {
  var err = requireVendor_(body, body.vendorId);
  if (err) return { ok: false, error: err };
  var orders = ordersOf_(body.vendorId);
  // 自适应轮询：
  //   有 pending 单     → 8s  商家要快接单
  //   有 cooking/送中   → 12s 工作节奏，常规
  //   全闲（无活跃单） → 30s 闲时省调用
  var hasPending = orders.some(function (o) { return o.status === 'pending'; });
  var hasActive = orders.some(function (o) { return o.status === 'pending' || o.status === 'cooking' || o.status === 'delivering'; });
  var pollMs = hasPending ? 8000 : hasActive ? 12000 : 30000;
  return { ok: true, orders: orders, pollIntervalMs: pollMs };
}

// 客户「我的订单」：按手机号拉该手机的全部订单（订单归属手机，不归属设备）
function getOrdersByPhone_(body) {
  var phone = String(body.phone || '').replace(/\D/g, '');
  if (phone.length < 6) return { ok: false, error: '缺少手机号' };
  var rows = cacheRead_(TAB_ORDERS).rows.filter(function (r) {
    return String(r.phone || '').replace(/\D/g, '') === phone;
  }).map(parseItems_);
  // 脱敏：调用者就是客户自己（已知自己的 PII），不重复返回姓名/手机/地址
  var safeRows = rows.map(function (r) {
    return {
      orderId: r.orderId, vendorId: r.vendorId, createdAt: r.createdAt,
      items: r.items, subtotal: r.subtotal, packagingFee: r.packagingFee,
      deliveryFee: r.deliveryFee, total: r.total, deliveryMode: r.deliveryMode,
      deliveryTime: r.deliveryTime, screenshotUrl: r.screenshotUrl,
      status: r.status, rejectReason: r.rejectReason,
      deliveryPhotoUrl: r.deliveryPhotoUrl, membershipJson: r.membershipJson, remark: r.remark,
      imagesPurgedAt: r.imagesPurgedAt // 30 天前订单截图已归档的标记
    };
  });
  return { ok: true, orders: safeRows, pollIntervalMs: 12000 };
}

// 客户轮询（按状态分级 pollIntervalMs：焦虑时段拉快、稳定时段拉慢，总调用量反而下降）
function getOrder_(body) {
  var orderId = sanitize_(String(body.orderId || ''), 50);
  var o = cacheFind_(TAB_ORDERS, 'orderId', orderId);
  if (!o) return { ok: false, error: '订单不存在' };
  parseItems_(o);
  var status = String(o.status || 'pending');
  // 自适应轮询：
  //   pending    → 5s  客户最焦虑：等商家接单
  //   cooking    → 15s 备餐期，不急
  //   delivering → 8s  配送途中，紧张
  //   terminal   → 0   完结，停轮询
  var pollMs = (status === 'delivered' || status === 'rejected' || status === 'cancelled') ? 0
             : status === 'pending'    ? 5000
             : status === 'cooking'    ? 15000
             : status === 'delivering' ? 8000
             : 12000;
  return {
    ok: true,
    order: { orderId: o.orderId, status: o.status, rejectReason: o.rejectReason, deliveryTime: o.deliveryTime, total: o.total, deliveryPhotoUrl: o.deliveryPhotoUrl, items: o.items, imagesPurgedAt: o.imagesPurgedAt },
    pollIntervalMs: pollMs
  };
}

// -- 下单（含服务端时间校验 + 输入清洗 + 会员积分） --
function placeOrder_(body) {
  var o = body.order || {};
  var vid = sanitize_(String(o.vendorId || ''), 50);
  if (!vid) return { ok: false, error: '缺少 vendorId' };

  // 输入校验 & 清洗
  var nameErr = validateName_(o.customerName);
  if (nameErr) return { ok: false, error: nameErr };
  var phoneErr = validatePhone_(o.phone);
  if (phoneErr) return { ok: false, error: phoneErr };

  o.customerName = sanitize_(o.customerName, 60);
  o.phone = String(o.phone || '').replace(/\D/g, '');
  o.building = sanitize_(o.building, 60);
  o.room = sanitize_(o.room, 30);
  o.remark = sanitize_(o.remark, 120);

  var v = cacheFind_(TAB_VENDORS, 'vendorId', vid);
  if (!v) return { ok: false, error: '商家不存在' };

  // 服务端配送时间校验
  var settings = safeParseObj_(v.settingsJson) || defaultConfig_();
  var now = new Date();
  var nowMin = now.getHours() * 60 + now.getMinutes();
  var toMin = function (hhmm) { var p = String(hhmm || '').split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };

  if (settings.deliveryMode === 'fixed') {
    var cutoff = Number(settings.cutoffMins) || 0;
    var hasOpenSlot = (settings.fixedSlots || []).some(function (s) { return nowMin <= toMin(s) - cutoff; });
    if (!hasOpenSlot) return { ok: false, error: '当前时段下单已截止' };
  } else if (settings.deliveryMode === 'flexible') {
    if (nowMin > toMin(settings.flexCloseTime || '23:59')) return { ok: false, error: '今日已截止接单' };
  }

  if (!o.orderId) o.orderId = '#' + Utilities.getUuid().slice(0, 8);
  if (!o.createdAt) o.createdAt = now.toISOString();
  // 幂等：同一单号重复提交（乐观下单的回包丢失/无限重试场景）直接返回，绝不重复建单或重复扣库存
  if (cacheFind_(TAB_ORDERS, 'orderId', o.orderId)) return { ok: true, orderId: o.orderId, duplicate: true };

  // 库存校验 & 扣减
  var menu = menuOf_(vid);
  var items = safeParse_(o.items) && safeParse_(o.items).length ? safeParse_(o.items) : (Array.isArray(o.items) ? o.items : []);

  // 会员积分：核销抵扣（在扣库存之前——失败则直接返回，不动库存）
  var membership = (settings.membership && settings.membership.enabled) ? settings.membership : null;
  var membershipDiscount = 0;
  var membershipRedeemed = false;
  o.membershipJson = '';
  if (membership && vendorIsPro_(v) && o.redeemMembership) {
    var pts = (membership.points && membership.points[o.phone]) ? Number(membership.points[o.phone]) : 0;
    var needPts = Number(membership.redeemPts) || 10;
    if (pts >= needPts) {
      membershipDiscount = Number(membership.redeemRM) || 0;
      if (membershipDiscount > 0) {
        membership.points[o.phone] = pts - needPts;
        membershipRedeemed = true;
      }
    }
  }
  // 重算合计：小计 + 打包 + 配送 - 会员抵扣（C11 fix: use server-enforced fees）
  var srvSubtotal = items.reduce(function (s, it) { return s + (Number(it.price) || 0) * (Number(it.qty) || 0); }, 0);
  o.packagingFee = srvPkg;
  o.deliveryFee = srvDel;
  o.total = Math.round((srvSubtotal + srvPkg + srvDel - membershipDiscount) * 100) / 100;

  // C10+C11 fix: cross-reference prices + fees + stock against server-side config
  // C11: enforce packaging/delivery fees from vendor settings
  if (settings.fees) {
    var srvPkg = (settings.fees.packaging && settings.fees.packaging.enabled) ? (Number(settings.fees.packaging.amount) || 0) : 0;
    var srvDel = (settings.fees.delivery && settings.fees.delivery.enabled) ? (Number(settings.fees.delivery.amount) || 0) : 0;
    if (Math.abs((Number(o.packagingFee) || 0) - srvPkg) > 0.01 || Math.abs((Number(o.deliveryFee) || 0) - srvDel) > 0.01) {
      return { ok: false, error: '费用与商家设置不符' };
    }
  }
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var m = menu.find(function (x) { return String(x.itemId) === String(it.id); });
    if (!m) return { ok: false, error: '商品不存在：' + sanitize_(it.name || it.id, 30) };
    // Stock validation
    if (m.stock !== null && m.stock !== '' && !isNaN(Number(m.stock))) {
      if (Number(m.stock) < Number(it.qty)) return { ok: false, error: '库存不足：' + sanitize_(it.name || it.id, 30) };
    }
    // Compute server-side price: base price + selected option surcharges
    var serverPrice = Number(m.price) || 0;
    if (m.optionsJson) {
      try {
        var optionGroups = JSON.parse(String(m.optionsJson));
        var opts = safeParse_(it.options) || [];
        if (Array.isArray(optionGroups)) {
          optionGroups.forEach(function (g) {
            if (g.options) g.options.forEach(function (o) { if (opts.indexOf(o.name) >= 0) serverPrice += Number(o.price) || 0; });
          });
        }
      } catch (_) {}
    }
    var clientPrice = Number(it.price) || 0;
    // Allow small rounding differences (within 0.01)
    if (Math.abs(clientPrice - serverPrice) > 0.02) {
      return { ok: false, error: '价格异常：' + sanitize_(it.name || it.id, 30) + '（期望 RM ' + serverPrice.toFixed(2) + '）' };
    }
  }

  for (var i2 = 0; i2 < items.length; i2++) {
    var it2 = items[i2];
    var m2 = menu.find(function (x) { return String(x.itemId) === String(it2.id); });
    if (m2 && m2.stock !== null && m2.stock !== '' && !isNaN(Number(m2.stock))) {
      var newStock = Math.max(0, Number(m2.stock) - Number(it2.qty));
      cacheUpdateCell_(TAB_MENU, 'itemId', m2.itemId, 'stock', newStock);
    }
  }

  // 清洗订单项中的用户文本
  items = items.map(function (item) {
    return { id: item.id, name: sanitize_(item.name, 60), price: Number(item.price) || 0, qty: Number(item.qty) || 1, options: sanitize_(item.options || '', 200) };
  });
  o.items = items;
  o.isTest = o.isTest ? 'TEST' : ''; // 测试单标记，供一键清理（只删 TEST 行）

  // 会员积分：订单落成后自动积豆
  var pointsEarned = 0;
  if (membership && vendorIsPro_(v)) {
    var ptsPerRM = Math.max(1, Number(membership.ptsPerRM) || 1);
    pointsEarned = Math.floor((Number(o.total) || 0) / ptsPerRM);
    if (pointsEarned > 0) {
      if (!membership.points) membership.points = {};
      membership.points[o.phone] = (Number(membership.points[o.phone]) || 0) + pointsEarned;
    }
    // 回写会员设置（含积分变动）
    cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'settingsJson', JSON.stringify(settings));
  }
  o.membershipJson = JSON.stringify({ earned: pointsEarned, redeemed: membershipRedeemed, discount: membershipDiscount });

  if (o.screenshotUrl) o.screenshotUrl = saveImageToDrive_(o.screenshotUrl, o.orderId + '-pay');

  cacheAppend_(TAB_ORDERS, o);
  logAction_(o.customerName || 'customer', 'ORDER_PLACED', 'orderId=' + o.orderId + ' vendor=' + vid + ' total=' + (o.total || ''));
  notifyOrderEvent_(o, 'placed'); // 通知商家有新单（推送失败不影响返回）
  return { ok: true, orderId: o.orderId };
}

// -- 两阶段下单的第二阶段：补传支付截图到 Drive 并回写订单（先斩后奏） --
function attachScreenshot_(body) {
  var orderId = sanitize_(String(body.orderId || ''), 50);
  if (!orderId) return { ok: false, error: '缺少 orderId' };
  if (!body.screenshot) return { ok: false, error: '缺少截图' };
  var o = cacheFind_(TAB_ORDERS, 'orderId', orderId);
  if (!o) return { ok: false, error: '订单不存在' };
  // H23 fix: only allow screenshot for pending orders and verify phone ownership
  if (String(o.status) !== 'pending') return { ok: false, error: '订单状态不允许上传截图' };
  if (body.phone && String(body.phone || '').replace(/\D/g, '') !== String(o.phone || '').replace(/\D/g, '')) {
    return { ok: false, error: '无权操作此订单' };
  }
  var url = saveImageToDrive_(body.screenshot, orderId + '-pay');
  cacheUpdateCell_(TAB_ORDERS, 'orderId', orderId, 'screenshotUrl', url);
  logAction_('customer', 'ORDER_SHOT', 'orderId=' + orderId);
  return { ok: true, screenshotUrl: url };
}

// -- 会员积分退回辅助 --
function returnMembershipPoints_(o) {
  if (!o || !o.vendorId || !o.phone) return;
  var mi = safeParseObj_(o.membershipJson);
  if (!mi || !(mi.earned > 0)) return;
  var v = cacheFind_(TAB_VENDORS, 'vendorId', o.vendorId);
  if (!v) return;
  var settings = safeParseObj_(v.settingsJson) || defaultConfig_();
  var membership = (settings.membership && settings.membership.enabled) ? settings.membership : null;
  if (!membership || !membership.points) return;
  var phone = String(o.phone || '').replace(/\D/g, '');
  if (!phone) return;
  var cur = Number(membership.points[phone]) || 0;
  membership.points[phone] = Math.max(0, cur - mi.earned);
  cacheUpdateCell_(TAB_VENDORS, 'vendorId', o.vendorId, 'settingsJson', JSON.stringify(settings));
}

// -- 取消（待验证→已取消 + 库存恢复 + 积分退回） --
function cancelOrder_(body) {
  var orderId = sanitize_(String(body.orderId || ''), 50);
  var o = cacheFind_(TAB_ORDERS, 'orderId', orderId);
  if (!o) return { ok: false, error: '订单不存在' };
  if (String(o.status) !== 'pending') return { ok: false, error: '该订单已在处理，无法取消' };

  cacheUpdateCell_(TAB_ORDERS, 'orderId', orderId, 'status', 'cancelled');
  returnMembershipPoints_(o);

  // 恢复库存
  var items = safeParse_(o.items) || [];
  items.forEach(function (it) {
    var m = cacheFind_(TAB_MENU, 'itemId', it.id);
    if (m && m.stock !== null && m.stock !== '' && !isNaN(Number(m.stock))) {
      cacheUpdateCell_(TAB_MENU, 'itemId', it.id, 'stock', Number(m.stock) + Number(it.qty || 1));
    }
  });

  logAction_(o.customerName || 'customer', 'ORDER_CANCELLED', 'orderId=' + orderId + ' stockRestored=true');
  notifyOrderEvent_(o, 'cancelled'); // 通知商家客户取消了
  return { ok: true };
}

// -- 更新订单状态（批量写入：一次读、一次写） --
function updateOrderStatus_(body) {
  var orderId = sanitize_(String(body.orderId || ''), 50);
  var status = sanitize_(String(body.status || ''), 20);
  if (!orderId || !status) return { ok: false, error: '缺少 orderId 或 status' };

  var o = cacheFind_(TAB_ORDERS, 'orderId', orderId);
  if (!o) return { ok: false, error: '找不到订单 ' + orderId };
  var err = requireVendor_(body, o.vendorId);
  if (err) return { ok: false, error: err };

  // C2 fix: validate status transitions — prevent arbitrary/illegal state changes
  var currentStatus = String(o.status || 'pending');
  var ALLOWED_TRANSITIONS = {
    pending: ['cooking', 'rejected', 'cancelled'],
    cooking: ['delivering'],
    delivering: ['delivered']
  };
  var allowed = ALLOWED_TRANSITIONS[currentStatus];
  if (!allowed || allowed.indexOf(status) < 0) {
    return { ok: false, error: '不允许从 ' + currentStatus + ' 切换到 ' + status };
  }

  // 批量更新：一次修改缓存中的多个字段，flush 时一次性写回 Sheet
  cacheUpdateCell_(TAB_ORDERS, 'orderId', orderId, 'status', status);
  if (body.rejectReason) {
    cacheUpdateCell_(TAB_ORDERS, 'orderId', orderId, 'rejectReason', sanitize_(String(body.rejectReason), 200));
  }
  if (body.deliveryPhoto) {
    var photoUrl = saveImageToDrive_(body.deliveryPhoto, orderId + '-delivered');
    cacheUpdateCell_(TAB_ORDERS, 'orderId', orderId, 'deliveryPhotoUrl', photoUrl);
  }

  // 拒绝时退回会员积分
  if (status === 'rejected') returnMembershipPoints_(o);

  logAction_(tokenPrincipal_(body.token) || 'merchant', 'ORDER_' + status.toUpperCase(), 'orderId=' + orderId);
  // 状态变更 → 推送给客户（cooking/delivering/delivered/rejected 都有对应模板）
  o.status = status;
  if (body.rejectReason) o.rejectReason = sanitize_(String(body.rejectReason), 200);
  notifyOrderEvent_(o, status);
  return { ok: true };
}

// -- 更新商品单个字段 --
function updateProduct_(body) {
  var itemId = sanitize_(String(body.itemId || ''), 50);
  var field = sanitize_(String(body.field || ''), 20);
  if (!itemId || ['price', 'available', 'name', 'desc', 'category', 'stock', 'emoji', 'image', 'optionsJson', 'discountJson'].indexOf(field) < 0) {
    return { ok: false, error: '非法的商品字段' };
  }
  var it = cacheFind_(TAB_MENU, 'itemId', itemId);
  if (!it) return { ok: false, error: '找不到商品 ' + itemId };
  var err = requireVendor_(body, it.vendorId);
  if (err) return { ok: false, error: err };

  var val = body.value;
  if (field === 'name') val = sanitize_(String(val || ''), 60);
  else if (field === 'desc') val = sanitize_(String(val || ''), 200);
  else if (field === 'category') val = sanitize_(String(val || ''), 30);

  cacheUpdateCell_(TAB_MENU, 'itemId', itemId, field, val);
  logAction_(tokenPrincipal_(body.token) || 'merchant', 'PRODUCT_UPDATE', 'itemId=' + itemId + ' ' + field + '=' + String(val).slice(0, 50));
  return { ok: true };
}

// -- 管理员 --
function upsertVendor_(body) {
  var v = body.vendor || {};
  if (!v.vendorId || !v.username) return { ok: false, error: '缺少 vendorId/username' };

  var vendorId = sanitize_(String(v.vendorId), 30);
  var username = sanitize_(String(v.username), 30);
  // C15 fix: 保留名防御。即使 token role 校验失效，也别让"admin" 当作 vendorId 写进表
  // —— vendorLogin 拿到 vendorId='admin' 的 token 仍然只能是 role='vendor'，攻不到 requireAdmin_
  var RESERVED = { admin: 1, root: 1, system: 1, 'super': 1 };
  if (RESERVED[vendorId.toLowerCase()] || RESERVED[username.toLowerCase()]) {
    return { ok: false, error: '保留名，不可作为商家账号' };
  }
  // cacheUpsert_ 会把未给的列填 ''；故先取现有行，保留 plan/planUntil/isTest 不被清空
  var existing = cacheFind_(TAB_VENDORS, 'vendorId', vendorId) || {};

  var row = {
    vendorId: vendorId, username: username, password: '', passwordHash: '',
    shopName: sanitize_(v.shopName || '', 60), logo: sanitize_(v.logo || '🏪', 10),
    tngLabel: sanitize_(v.tngLabel || v.shopName || '', 60), HubID: sanitize_(String(v.hubId || v.HubID || ''), 30).toLowerCase(),
    active: v.active === false ? false : true,
    settingsJson: v.settingsJson || '', payQRsJson: v.payQRsJson || '', categoriesJson: v.categoriesJson || '',
    plan: v.plan || existing.plan || 'basic',
    planUntil: v.planUntil !== undefined ? v.planUntil : (existing.planUntil || ''),
    isTest: v.isTest !== undefined ? v.isTest : (existing.isTest || '')
  };

  // 如果提供了明文密码，自动 SHA-256 哈希存储
  if (v.password) {
    row.passwordHash = hashPwd_(String(v.password));
    row.password = '';
  } else if (v.passwordHash) {
    row.passwordHash = v.passwordHash;
  }

  cacheUpsert_(TAB_VENDORS, 'vendorId', row);
  logAction_('admin', 'VENDOR_UPSERT', 'vendorId=' + vendorId);
  return { ok: true };
}

function removeVendor_(body) {
  var vendorId = sanitize_(String(body.vendorId || ''), 30);
  if (!vendorId) return { ok: false, error: '缺少 vendorId' };
  cacheDelete_(TAB_VENDORS, 'vendorId', vendorId);
  cacheDelete_(TAB_ORDERS, 'vendorId', vendorId);
  cacheDelete_(TAB_MENU, 'vendorId', vendorId);
  cacheDelete_(TAB_PAYMENTS, 'vendorId', vendorId); // C9 fix: cascade to payments
  logAction_('admin', 'VENDOR_REMOVE', 'vendorId=' + vendorId);
  return { ok: true };
}

function saveHub_(body) {
  var hubId = sanitize_(String(body.hubId || ''), 30).toLowerCase();
  if (!hubId) return { ok: false, error: '缺少 hubId' };
  var nm = sanitize_(body.name || hubId, 60);
  var h = cacheFind_(TAB_HUBS, 'hubId', hubId);
  if (h) cacheUpdateCell_(TAB_HUBS, 'hubId', hubId, 'name', nm); // 只改名，保留 buildingsJson 池
  else cacheUpsert_(TAB_HUBS, 'hubId', { hubId: hubId, name: nm, buildingsJson: '[]' });
  logAction_('admin', 'HUB_SAVE', 'hubId=' + hubId);
  return { ok: true };
}

// 商家把楼栋加入本社区共享池（重复的自动去重；别家也能勾选到）
function addHubBuilding_(body) {
  var t = verifyToken_(body.token);
  if (!t) return { ok: false, error: '未授权' };
  var name = sanitize_(String(body.name || ''), 40).trim();
  if (!name) return { ok: false, error: '缺少楼栋名' };
  // hubId 由身份推导，不信客户端传值：商家只能往自己所属社区的池里加楼栋（admin 可指定任意社区）
  var hubId;
  if (t.role === 'admin') {
    hubId = sanitize_(String(body.hubId || ''), 30).toLowerCase();
  } else {
    var v = cacheFind_(TAB_VENDORS, 'vendorId', t.principal);
    if (!v) return { ok: false, error: '商家不存在' };
    hubId = sanitize_(String(v.HubID || ''), 30).toLowerCase();
  }
  if (!hubId) return { ok: false, error: '缺少 hubId' };
  var h = cacheFind_(TAB_HUBS, 'hubId', hubId);
  var list = (h && safeParse_(h.buildingsJson)) || [];
  if (list.indexOf(name) < 0) list.push(name);
  if (h) cacheUpdateCell_(TAB_HUBS, 'hubId', hubId, 'buildingsJson', JSON.stringify(list));
  else cacheUpsert_(TAB_HUBS, 'hubId', { hubId: hubId, name: hubId, buildingsJson: JSON.stringify(list) });
  return { ok: true, buildings: list, hubId: hubId };
}

/** Admin 从社区楼栋池中删除某个楼栋 */
function removeHubBuilding_(body) {
  var hubId = sanitize_(String(body.hubId || ''), 30).toLowerCase();
  var name = sanitize_(String(body.name || ''), 40).trim();
  if (!hubId || !name) return { ok: false, error: '缺少 hubId 或 name' };
  var h = cacheFind_(TAB_HUBS, 'hubId', hubId);
  if (!h) return { ok: false, error: '社区不存在' };
  var list = (h && safeParse_(h.buildingsJson)) || [];
  var idx = list.indexOf(name);
  if (idx >= 0) list.splice(idx, 1);
  cacheUpdateCell_(TAB_HUBS, 'hubId', hubId, 'buildingsJson', JSON.stringify(list));
  logAction_('admin', 'HUB_BUILDING_REMOVE', 'hubId=' + hubId + ' name=' + name);
  return { ok: true, buildings: list, hubId: hubId };
}

/** Admin 批量设置社区楼栋池（替换整列） */
function saveHubBuildings_(body) {
  var hubId = sanitize_(String(body.hubId || ''), 30).toLowerCase();
  var list = Array.isArray(body.buildings) ? body.buildings.map(function(b) { return sanitize_(String(b), 40).trim(); }).filter(Boolean) : [];
  if (!hubId) return { ok: false, error: '缺少 hubId' };
  var h = cacheFind_(TAB_HUBS, 'hubId', hubId);
  if (h) cacheUpdateCell_(TAB_HUBS, 'hubId', hubId, 'buildingsJson', JSON.stringify(list));
  else cacheUpsert_(TAB_HUBS, 'hubId', { hubId: hubId, name: hubId, buildingsJson: JSON.stringify(list) });
  logAction_('admin', 'HUB_BUILDINGS_SAVE', 'hubId=' + hubId + ' count=' + list.length);
  return { ok: true, buildings: list, hubId: hubId };
}

function removeHub_(body) {
  var hubId = sanitize_(String(body.hubId || ''), 30).toLowerCase();
  if (!hubId) return { ok: false, error: '缺少 hubId' };
  cacheDelete_(TAB_HUBS, 'hubId', hubId);
  logAction_('admin', 'HUB_REMOVE', 'hubId=' + hubId);
  return { ok: true };
}

// ==================== 计费 / 套餐（仅管理员）====================
function saveVendorPlan_(body) {
  var vid = sanitize_(String(body.vendorId || ''), 30);
  if (!vid) return { ok: false, error: '缺少 vendorId' };
  var v = cacheFind_(TAB_VENDORS, 'vendorId', vid);
  if (!v) return { ok: false, error: '商家不存在' };
  var plan = String(body.plan) === 'pro' ? 'pro' : 'basic';
  var planUntil = sanitize_(String(body.planUntil || ''), 10); // yyyy-MM-dd
  cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'plan', plan);
  cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'planUntil', planUntil);
  logAction_('admin', 'VENDOR_PLAN', 'vendorId=' + vid + ' plan=' + plan + ' until=' + planUntil);
  return { ok: true, plan: plan, planUntil: planUntil };
}

// 记一笔收款；默认顺带把商家升级到该套餐并把到期日设为本期结束（续费）
function addPayment_(body) {
  var p = body.payment || {};
  var vid = sanitize_(String(p.vendorId || ''), 30);
  if (!vid) return { ok: false, error: '缺少 vendorId' };
  var tz = Session.getScriptTimeZone();
  var row = {
    payId: p.payId || ('pay_' + Utilities.getUuid().slice(0, 8)),
    vendorId: vid,
    amount: Number(p.amount) || 0,
    plan: String(p.plan) === 'pro' ? 'pro' : 'basic',
    paidAt: sanitize_(String(p.paidAt || ''), 10) || Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd'),
    periodStart: sanitize_(String(p.periodStart || ''), 10),
    periodEnd: sanitize_(String(p.periodEnd || ''), 10),
    note: sanitize_(String(p.note || ''), 120),
    isTest: p.isTest ? 'TEST' : ''
  };
  cacheAppend_(TAB_PAYMENTS, row);
  if (body.applyPlan !== false) {
    cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'plan', row.plan);
    if (row.periodEnd) cacheUpdateCell_(TAB_VENDORS, 'vendorId', vid, 'planUntil', row.periodEnd);
  }
  logAction_('admin', 'PAYMENT_ADD', 'vendorId=' + vid + ' amount=' + row.amount + ' until=' + row.periodEnd);
  return { ok: true, payId: row.payId };
}

// ==================== 内部测试数据清理（仅管理员）====================
// 只删带 isTest='TEST' 标记的行，绝不触碰真实数据
function clearTestData_(body) {
  var removed = {
    orders: cacheFilter_(TAB_ORDERS, 'isTest', 'TEST').length,
    menu: cacheFilter_(TAB_MENU, 'isTest', 'TEST').length,
    vendors: cacheFilter_(TAB_VENDORS, 'isTest', 'TEST').length,
    payments: cacheFilter_(TAB_PAYMENTS, 'isTest', 'TEST').length
  };
  cacheDelete_(TAB_ORDERS, 'isTest', 'TEST');
  cacheDelete_(TAB_MENU, 'isTest', 'TEST');
  cacheDelete_(TAB_VENDORS, 'isTest', 'TEST');
  cacheDelete_(TAB_PAYMENTS, 'isTest', 'TEST');
  logAction_('admin', 'CLEAR_TEST_DATA', JSON.stringify(removed));
  return { ok: true, removed: removed };
}

// 一键重置：清空所有 Sheet 数据，重新播种（仅管理员）
function resetSeedData_(body) {
  var tabs = [TAB_VENDORS, TAB_ORDERS, TAB_MENU, TAB_HUBS, TAB_LOGS, TAB_PAYMENTS];
  tabs.forEach(function (name) {
    var sh = sheet_(name);
    var lastRow = sh.getLastRow();
    if (lastRow > 1) sh.deleteRows(2, lastRow - 1);
  });
  // 重置种子标记，让 ensureSchema_ 在下一次请求时重新播种
  var props = PropertiesService.getScriptProperties();
  props.setProperty('SEEDED5', '0');
  props.setProperty('SCHEMA_READY9', '0');
  _schemaReady = false;
  // 清空请求缓存
  cacheReset_();
  // 立即重新播种
  ensureSchema_();
  cacheFlush_();
  logAction_('admin', 'RESET_SEED_DATA', 'All data cleared and re-seeded');
  return { ok: true, message: 'All data cleared. Re-seeded with comprehensive test data.', sheetUrl: ss_().getUrl() };
}

// ==================== Web Push（订阅入库 + 转发到 Cloudflare Worker） ====================
//
// 设计：GAS 不直接签 ECDSA（不支持），把 subscription + payload + WORKER_SECRET 转给 CF Worker
// CF Worker 做 VAPID 签名 + RFC 8291 aes128gcm 加密 + POST 到 push service
//
// 入库幂等：subId = SHA-256(endpoint) 截断 32 字符，同一设备重订阅会 upsert 而非堆积。
// 失败计数：连续 5 次 4xx/5xx 自动从 Subscriptions 表清除（push service 已 410 GONE）。

function saveSubscription_(body) {
  var role = sanitize_(String(body.role || ''), 16);
  var identity = sanitize_(String(body.identity || ''), 64);
  var sub = body.subscription || {};
  if (['customer', 'merchant', 'admin'].indexOf(role) < 0) return { ok: false, error: 'invalid role' };
  if (!identity) return { ok: false, error: 'identity required' };
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) return { ok: false, error: 'invalid subscription' };
  // 防滥用：endpoint 太长拒绝
  if (String(sub.endpoint).length > 500) return { ok: false, error: 'endpoint too long' };

  var subId = sha256_(sub.endpoint).slice(0, 32);
  var ua = sanitize_(String(body.ua || ''), 200);
  var now = new Date().toISOString();
  var isTest = body.isTest ? 'TEST' : '';
  cacheUpsert_(TAB_SUBSCRIPTIONS, 'subId', {
    subId: subId,
    role: role,
    identity: identity,
    endpoint: sub.endpoint,
    p256dh: sub.keys.p256dh,
    auth: sub.keys.auth,
    ua: ua,
    createdAt: now,
    lastNotifiedAt: '',
    failCount: 0,
    isTest: isTest,
  });
  logAction_(role + ':' + identity, 'SAVE_SUBSCRIPTION', subId);
  return { ok: true, subId: subId };
}

// 找到一个 role+identity 下的所有订阅（一个用户可能有多设备）
function subscriptionsByIdentity_(role, identity) {
  if (!role || !identity) return [];
  return cacheRead_(TAB_SUBSCRIPTIONS).rows.filter(function (r) {
    return r.role === role && String(r.identity) === String(identity);
  });
}

// 调 Worker 发一条 push。返回 { ok, status, error? }
// 失败时如果状态码是 404/410，自动从 Subscriptions 删除该订阅
function pushOne_(subRow, payload, options) {
  options = options || {};
  var sp = PropertiesService.getScriptProperties();
  var workerUrl = sp.getProperty('PUSH_WORKER_URL');
  var workerSecret = sp.getProperty('WORKER_SECRET');
  if (!workerUrl || !workerSecret) return { ok: false, error: 'PUSH_WORKER_URL / WORKER_SECRET not set in Script Properties' };
  var payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  try {
    var resp = UrlFetchApp.fetch(workerUrl + '/push', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'X-Worker-Secret': workerSecret },
      muteHttpExceptions: true,
      payload: JSON.stringify({
        subscription: { endpoint: subRow.endpoint, keys: { p256dh: subRow.p256dh, auth: subRow.auth } },
        payload: payloadStr,
        ttl: options.ttl || 86400,
        urgency: options.urgency || 'normal',
      }),
    });
    var code = resp.getResponseCode();
    var bodyText = resp.getContentText();
    var bodyObj = safeParseObj_(bodyText) || {};
    // push service 端的状态码（200/201 = 已交付；404/410 = 订阅过期；其它 = 临时失败）
    var pushStatus = bodyObj.status || code;
    if (pushStatus === 404 || pushStatus === 410) {
      // 订阅永久失效 → 直接删
      cacheDelete_(TAB_SUBSCRIPTIONS, 'subId', subRow.subId);
      return { ok: false, status: pushStatus, error: 'gone', removed: true };
    }
    if (!bodyObj.ok) {
      // 失败计数 +1；连续 5 次直接删
      var fc = (Number(subRow.failCount) || 0) + 1;
      if (fc >= 5) {
        cacheDelete_(TAB_SUBSCRIPTIONS, 'subId', subRow.subId);
        return { ok: false, status: pushStatus, error: 'too many fails', removed: true };
      }
      cacheUpdateCell_(TAB_SUBSCRIPTIONS, 'subId', subRow.subId, 'failCount', fc);
      return { ok: false, status: pushStatus, error: bodyObj.error || bodyText.slice(0, 100) };
    }
    // 成功 → 重置 failCount + 更新 lastNotifiedAt
    cacheUpdateCell_(TAB_SUBSCRIPTIONS, 'subId', subRow.subId, 'lastNotifiedAt', new Date().toISOString());
    if (Number(subRow.failCount) > 0) cacheUpdateCell_(TAB_SUBSCRIPTIONS, 'subId', subRow.subId, 'failCount', 0);
    return { ok: true, status: pushStatus };
  } catch (e) {
    return { ok: false, error: String(e).slice(0, 200) };
  }
}

// 向 role+identity 的所有设备推送。同一用户多端时全发。
function pushNotify_(role, identity, payload, options) {
  var subs = subscriptionsByIdentity_(role, identity);
  if (!subs.length) return { ok: false, error: 'no subscription', count: 0 };
  var sent = 0; var failed = 0; var details = [];
  for (var i = 0; i < subs.length; i++) {
    var r = pushOne_(subs[i], payload, options);
    if (r.ok) sent++; else failed++;
    details.push({ subId: subs[i].subId, status: r.status, error: r.error });
  }
  return { ok: sent > 0, sent: sent, failed: failed, count: subs.length, details: details };
}

// 管理员手工试推（admin-test 工具会调用）
function testPush_(body) {
  var role = body.role || 'customer';
  var identity = body.identity || '';
  var payload = body.payload || { title: '测试通知', body: '如果你看到这条消息，Web Push 已经接通！', tag: 'test-' + Date.now() };
  if (!identity) return { ok: false, error: 'identity required (phone / vendorId / username)' };
  return pushNotify_(role, identity, payload, { urgency: 'high' });
}

// ============================================================
// systemSelfCheck —— Worker Cron 每小时调一次
// ============================================================
//
// 自鉴权：body.workerSecret 必须等于 Script Properties 里的 WORKER_SECRET
//   不用 adminGuard 是因为 Worker Cron 没有 admin token
//
// 异常时 → push 给所有 role='admin' 订阅（最高紧急度）
// 防告警轰炸：tag 用「小时桶」去重，同样错误 1 小时内只弹一次

function systemSelfCheck_(body) {
  var sp = PropertiesService.getScriptProperties();
  var workerSecret = sp.getProperty('WORKER_SECRET');
  if (!workerSecret || body.workerSecret !== workerSecret) {
    return { ok: false, error: 'unauthorized' };
  }

  var issues = [];
  var summary = {};

  try {
    // 1. Sheet 访问性
    Object.keys(SCHEMA).forEach(function (name) {
      try { sheet_(name); } catch (e) { issues.push('表 ' + name + ' 异常: ' + String(e).slice(0, 80)); }
    });

    // 2. GAS 用量
    try {
      var usage = getSystemUsage_();
      var today = usage.days[usage.days.length - 1] || { ms: 0 };
      var pct = Math.round((today.ms / 60000) / 90 * 100);
      summary.quotaPct = pct;
      if (pct > 80) issues.push('GAS 配额 ' + pct + '% (严重，距撞墙仅 ' + (90 - Math.round(today.ms / 60000)) + ' min)');
      else if (pct > 60) issues.push('GAS 配额 ' + pct + '% (警戒线，请关注)');
      var cellPct = Math.round(usage.sheets.totalCells / 10000000 * 100);
      summary.cellPct = cellPct;
      if (cellPct > 80) issues.push('Sheet cells ' + cellPct + '% (距 10M 上限近)');
    } catch (e) { issues.push('用量统计错: ' + String(e).slice(0, 80)); }

    // 3. 数据量 + 失效订阅堆积
    try {
      summary.orders = cacheRead_(TAB_ORDERS).rows.length;
      summary.vendors = cacheRead_(TAB_VENDORS).rows.length;
      summary.subscriptions = cacheRead_(TAB_SUBSCRIPTIONS).rows.length;
      var staleSubs = cacheRead_(TAB_SUBSCRIPTIONS).rows.filter(function (s) {
        return Number(s.failCount) >= 3;
      });
      if (staleSubs.length > 5) issues.push(staleSubs.length + ' 个订阅连续失败（建议清理）');
    } catch (e) { issues.push('数据量检查错: ' + String(e).slice(0, 80)); }
  } catch (e) {
    issues.push('selfCheck 顶层异常: ' + String(e).slice(0, 100));
  }

  // 异常时 → push admin
  if (issues.length > 0) {
    try {
      var adminSubs = cacheRead_(TAB_SUBSCRIPTIONS).rows.filter(function (s) { return s.role === 'admin'; });
      if (adminSubs.length > 0) {
        var hourBucket = Math.floor(Date.now() / 3600000);
        var alertPayload = {
          title: '⚠ 团团系统异常 (' + issues.length + ' 项)',
          body: issues.slice(0, 3).join('；').slice(0, 200),
          tag: 'sys-alert-' + hourBucket,
          url: '/admin.html',
          urgency: 'high',
          renotify: false,
          orderId: 'system-alert',
          role: 'admin',
        };
        adminSubs.forEach(function (s) {
          try { pushOne_(s, alertPayload, { urgency: 'high' }); } catch (_) {}
        });
        logAction_('cron', 'HEALTH_ALERT_SENT', adminSubs.length + ' admins · ' + issues.length + ' issues');
      } else {
        logAction_('cron', 'HEALTH_ISSUES_NO_ADMIN_SUB', issues.length + ' issues · 管理员尚未订阅推送');
      }
    } catch (e) {
      logAction_('cron', 'HEALTH_ALERT_FAIL', String(e).slice(0, 100));
    }
  }

  return { ok: true, issues: issues, summary: summary, time: new Date().toISOString() };
}

// 订单事件 → 推送（最高善意：永不抛错影响业务）
// eventType: 'placed'(给商家) | 'cooking'/'delivering'/'delivered'/'rejected'(给客户) | 'cancelled'(给商家)
function notifyOrderEvent_(o, eventType) {
  try {
    if (!o || !eventType) return;
    var addr = (o.building || '') + (o.room ? ' ' + o.room : '');
    var totalStr = 'RM ' + Number(o.total || 0).toFixed(2);

    if (eventType === 'placed') {
      pushNotify_('merchant', o.vendorId, {
        title: '📥 新订单 ' + (o.orderId || ''),
        body: (o.customerName || '客户') + ' · ' + addr + ' · ' + totalStr,
        tag: 'new-order-' + o.orderId,
        url: '/merchant.html?source=push',
        renotify: true,
        requireInteraction: true,  // 商家新单不自动消失（防漏单）
        orderId: o.orderId,
        role: 'merchant',
      }, { urgency: 'high' });
    } else if (eventType === 'cooking') {
      pushNotify_('customer', o.phone, {
        title: '👨‍🍳 备餐中',
        body: '商家已接单：' + (o.orderId || ''),
        tag: 'order-' + o.orderId,
        url: '/?source=push#/track/' + o.orderId,
        orderId: o.orderId,
      }, { urgency: 'high' });
    } else if (eventType === 'delivering') {
      pushNotify_('customer', o.phone, {
        title: '🛵 配送中',
        body: '订单 ' + (o.orderId || '') + ' 已出发',
        tag: 'order-' + o.orderId,
        url: '/?source=push#/track/' + o.orderId,
        orderId: o.orderId,
      }, { urgency: 'high' });
    } else if (eventType === 'delivered') {
      pushNotify_('customer', o.phone, {
        title: '✅ 已送达',
        body: '订单 ' + (o.orderId || '') + ' 已到达，请尽快取餐',
        tag: 'order-' + o.orderId,
        url: '/?source=push#/track/' + o.orderId,
        renotify: true,
        orderId: o.orderId,
      }, { urgency: 'high' });
    } else if (eventType === 'rejected') {
      pushNotify_('customer', o.phone, {
        title: '❌ 商家拒单',
        body: o.rejectReason || ('订单 ' + (o.orderId || '') + ' 未能接受'),
        tag: 'order-' + o.orderId,
        url: '/?source=push#/track/' + o.orderId,
        orderId: o.orderId,
      }, { urgency: 'high' });
    } else if (eventType === 'cancelled') {
      pushNotify_('merchant', o.vendorId, {
        title: '🚫 客户已取消',
        body: '订单 ' + (o.orderId || '') + ' · ' + (o.customerName || '客户'),
        tag: 'cancel-' + o.orderId,
        url: '/merchant.html?source=push',
        orderId: o.orderId,
      });
    }
  } catch (e) {
    try { logAction_('system', 'NOTIFY_FAIL', eventType + ':' + (o && o.orderId) + ' ' + String(e).slice(0, 80)); } catch (_) {}
  }
}

// -- 演示数据 --
function seedDemoData() {
  ensureSchema_();
  cacheReset_();
  function pay(t) { return 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="460"><rect width="320" height="460" fill="#eef7f1"/><circle cx="160" cy="140" r="38" fill="#04a65a"/><text x="160" y="240" font-size="20" text-anchor="middle" font-family="sans-serif" font-weight="bold">Payment Successful</text><text x="160" y="290" font-size="30" fill="#04a65a" text-anchor="middle" font-family="sans-serif" font-weight="bold">RM ' + t + '</text></svg>'); }
  var r1 = placeOrder_({ order: { vendorId: 'shop1', HubID: 'utm', customerName: '陈小明', phone: '0123456789', building: 'A 栋', room: '506', items: [{ name: '招牌鸡扒饭', price: 9.5, qty: 1 }], subtotal: 9.5, packagingFee: 0.5, deliveryFee: 1, total: 11, deliveryTime: '12:30', screenshotUrl: pay('11.00'), status: 'pending' } });
  cacheFlush_();
  logAction_('system', 'SEED', 'done ' + r1.orderId);
  return ss_().getUrl();
}

// -- 工具 --
function safeParse_(s) { try { return JSON.parse(s); } catch (e) { return []; } }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function sha256_(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join(''); }
