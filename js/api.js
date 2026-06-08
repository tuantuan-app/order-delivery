/*
 * api.js v4 —— 后端 API 客户端
 *
 * 新增（v4）：边缘缓存路由
 *   - 白名单读 API（getOrder/getVendorOrders/getStorefront/getOrdersByPhone/listHubs）
 *     默认走 CF Worker /api（边缘缓存，~50ms 命中、~3s 穿透）
 *   - 写入与未白名单 action 走 GAS 直连
 *   - 任何走 Worker 的请求若失败，自动 fallback 到 GAS 直连（graceful degradation）
 *   - 客户端零感知：方法签名、返回结构都不变
 *
 * v3 既有：请求去重（同参数并发合并）+ 超时控制
 */
(function () {
  // 这 6 个读 action 由 Worker 缓存。其它（写、admin、auth）一律 GAS 直连
  // M22 fix: getMembership 进缓存白名单。客户查会员积分按 {vendorId, phone} 缓存
  //   → 同 vendor+phone 30s 内重复查命中边缘，不烧 GAS（一笔订单结算页可能查 2-3 次）
  var CACHEABLE = { getOrder: 1, getVendorOrders: 1, getStorefront: 1, getOrdersByPhone: 1, listHubs: 1, listPublicVendors: 1, getMembership: 1 };

window.api = {
  base() { return (window.APP_CONFIG && window.APP_CONFIG.apiBase) || ''; },
  cacheBase() {
    // prod 模式：走 prod Worker（tuantuan-push.keidev.workers.dev）边缘缓存
    // test 模式：走 staging Worker（tuantuan-push-test.keidev.workers.dev）真实测试边缘缓存
    //          staging Worker 配的是测试 GAS URL，与 prod 隔离 → 测试数据不污染线上缓存
    // demo 模式：无后端，cacheBase() 返空，不走 Worker
    var env = (window.APP_CONFIG && window.APP_CONFIG.env) || 'prod';
    if (env === 'demo') return '';
    var w = (window.APP_CONFIG && window.APP_CONFIG.pushWorkerUrl) || '';
    return w ? (w + '/api') : '';
  },
  enabled() { return !!this.base(); },

  // ---- 请求去重：同参数并发只发一次 ----
  _pending: {},
  _dedupe(key, fn) {
    var self = this;
    if (self._pending[key]) return self._pending[key];
    self._pending[key] = fn().then(function (r) { delete self._pending[key]; return r; }, function (e) { delete self._pending[key]; throw e; });
    return self._pending[key];
  },

  // 实际发送：选 URL + try/catch + fallback
  async _postTo(url, payload, timeoutMs) {
    var controller = new AbortController();
    var timer = timeoutMs ? setTimeout(function () { controller.abort(); }, timeoutMs) : null;
    try {
      var res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return res.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  },

  async post(payload, timeoutMs) {
    var self = this;
    var action = payload && payload.action;
    // 走 Worker 还是直连？
    //   CACHEABLE 读 → Worker 边缘缓存
    //   其它（写、login）也优先走 Worker（避开浏览器→GAS 的 CORS/网络抖动问题）
    //   Worker 内部对非 CACHEABLE action 直接透传 GAS，零额外延迟
    //   失败自动 fallback 到 GAS 直连（兜底）
    var preferWorker = !!self.cacheBase();
    var url = preferWorker ? self.cacheBase() : self.base();
    try {
      return await self._postTo(url, payload, timeoutMs);
    } catch (e) {
      if (preferWorker && self.base()) {
        try { console.warn('[api] /api worker failed for ' + action + ', fallback to GAS:', (e && e.message || e)); } catch (_) {}
        return await self._postTo(self.base(), payload, timeoutMs);
      }
      throw e;
    }
  },

  // 公开
  vendorLogin(username, password) { return this.post({ action: 'vendorLogin', username, password }, 15000); }, // 登录 15s 超时
  adminLogin(username, password) { return this.post({ action: 'adminLogin', username, password }); },
  listHubs() { return this.post({ action: 'listHubs' }); },
  // 客户端首页：公开商家列表（已过滤 TEST + 已停业）
  listPublicVendors() { return this._dedupe('lpv', function () { return window.api.post({ action: 'listPublicVendors' }); }); },
  getMembership(vendorId, phone) { return this.post({ action: 'getMembership', vendorId, phone }); },
  addHubBuilding(hubId, name, token) { return this.post({ action: 'addHubBuilding', hubId, name, token }); },
  removeHubBuilding(hubId, name, token) { return this.post({ action: 'removeHubBuilding', hubId, name, token }); },
  saveHubBuildings(hubId, buildings, token) { return this.post({ action: 'saveHubBuildings', hubId, buildings, token }); },
  placeOrder(order) { return this.post({ action: 'placeOrder', order }, 25000); }, // 阶段1：仅文字，秒回 orderId
  attachScreenshot(orderId, image) { return this.post({ action: 'attachScreenshot', orderId, screenshot: image }, 60000); }, // 阶段2：后台补传截图(慢网+Drive冷启动 p95 ~40s，给 60s 余量)
  cancelOrder(orderId) { return this.post({ action: 'cancelOrder', orderId }); },
  getOrder(orderId) {
    return this._dedupe('getOrder_' + orderId, function () { return window.api.post({ action: 'getOrder', orderId }); });
  },
  getOrdersByPhone(phone) { return this.post({ action: 'getOrdersByPhone', phone }); },
  getStorefront(vendorId) {
    return this._dedupe('sf_' + vendorId, function () { return window.api.post({ action: 'getStorefront', vendorId }); });
  },
  // 商家
  getVendorOrders(vendorId, token) { return this.post({ action: 'getVendorOrders', vendorId, token }); },
  // 管理员
  listVendors(token) { return this.post({ action: 'listVendors', token }); },
  listAllOrders(token) { return this.post({ action: 'listAllOrders', token }); },
  // 计费 / 套餐
  saveVendorPlan(vendorId, plan, planUntil, token) { return this.post({ action: 'saveVendorPlan', vendorId, plan, planUntil, token }); },
  addPayment(payment, token) { return this.post({ action: 'addPayment', payment, token }); },
  listPayments(token) { return this.post({ action: 'listPayments', token }); },
  // 内部测试工具
  clearTestData(token) { return this.post({ action: 'clearTestData', token }); },
  resetSeedData(token) { return this.post({ action: 'resetSeedData', token }); },
  // 老订单截图清理（Drive 配额保护）：删 N 天前订单的支付截图+送达照，仅留文字记录
  purgeOldImages(days, token) { return this.post({ action: 'purgeOldImages', days: days || 30, token }, 60000); },
  // 老订单归档（Sheet 10M cell 保护）：90+ 天终态订单从 Orders 搬到 OrdersArchive 表
  archiveOldOrders(days, token) { return this.post({ action: 'archiveOldOrders', days: days || 90, token }, 120000); },
  // 查归档（admin 任意；商家自动限到自己；客户传 phone）
  getArchivedOrders(filter, token, limit, offset) { return this.post({ action: 'getArchivedOrders', filter, token, limit, offset }, 30000); },
  health(token) { return this.post({ action: 'health', token }, 15000); },
  // 系统配额监控：返回近 7 天每天调用数 + 总执行 ms + Sheet 行数 / cell 用量
  getSystemUsage(token) { return this.post({ action: 'getSystemUsage', token }, 15000); },
  // Web Push 订阅入库
  // payload: { role:'customer'|'merchant'|'admin', identity, subscription:{endpoint,keys:{p256dh,auth}}, ua? }
  saveSubscription(payload) { return this.post(Object.assign({ action: 'saveSubscription' }, payload || {}), 15000); },
  // 测试推一条（开发用，从 Worker 路径完整跑一遍）
  testPush(role, identity, payload, token) { return this.post({ action: 'testPush', role: role, identity: identity, payload: payload, token: token }, 20000); },
};
})();
