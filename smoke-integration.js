/*
 * smoke-integration.js —— 集成测试：组件交互、冲突检测、关键路径
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8777';
const OUT = path.join(__dirname, 'smoke-deep-shots');

const pass = []; const fail = []; const warn = [];
function ok(m) { console.log('  ✅ PASS  ' + m); pass.push(m); }
function bad(m) { console.log('  ❌ FAIL  ' + m); fail.push(m); }
function meh(m) { console.log('  ⚠ WARN  ' + m); warn.push(m); }

(async () => {
  const browser = await chromium.launch({ headless: true });

  // 6.1 商家 playAlert (pre-session) vs ringer (本 session) 冲突检测
  console.log('\n===== 组 6 · 集成冲突检测 =====');
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    let alertCalls = 0;
    // 拦截 playAlert
    await p.exposeBinding('_countPlayAlert', () => { alertCalls++; });
    await p.addInitScript(() => {
      // 等 store.utils 上来后 patch playAlert
      var iv = setInterval(() => {
        if (window.store && window.store.utils && window.store.utils.playAlert && !window._patched) {
          var orig = window.store.utils.playAlert;
          window.store.utils.playAlert = function () { window._countPlayAlert(); return orig.apply(this, arguments); };
          window._patched = true;
          clearInterval(iv);
        }
      }, 50);
    });
    await p.goto(BASE + '/merchant.html?demo');
    await p.waitForLoadState('networkidle');
    // 登录
    await p.waitForSelector('input[placeholder="商家账号"]');
    await p.fill('input[placeholder="商家账号"]', 'shop1');
    await p.fill('input[type="password"]', '1234');
    await p.click('button:has-text("登录")');
    await p.waitForFunction(() => window.store && window.store.auth && window.store.auth.user, { timeout: 5000 });
    await p.waitForTimeout(500);
    // 注入新 pending 单 → 应该触发 pendingCount watch
    const before = alertCalls;
    const ringerStart = await p.evaluate(() => {
      var S = window.store;
      // 跟踪 ringer.start 调用次数
      window._ringerStarts = 0;
      var origStart = window.merchantRinger.start;
      window.merchantRinger.start = function (id) { window._ringerStarts++; return origStart.call(this, id); };
      // 注入新 pending 单
      S.state.orders.unshift({
        id: '#integration1', merchantId: 'shop1', hubId: 'utm',
        customer: { name: 'X', phone: '0199999990', building: 'A 栋', room: 'T01' },
        items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }],
        subtotal: 9.5, packagingFee: 0, deliveryFee: 0, total: 9.5,
        status: 'pending', deliveryTime: '12:30',
        createdAt: Date.now(), createdAtText: '刚刚', syncStatus: 'synced', imgStatus: 'ok',
      });
      // 强制触发 applyVendorOrders（通过模拟远端返回）
      S.applyVendorOrders('shop1', [{
        orderId: '#integration1', vendorId: 'shop1', HubID: 'utm', status: 'pending',
        customerName: 'X', phone: '0199999990', building: 'A 栋', room: 'T01',
        items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }],
        subtotal: 9.5, packagingFee: 0, deliveryFee: 0, total: 9.5,
        deliveryTime: '12:30', createdAt: new Date().toISOString(),
      }]);
      return window._ringerStarts;
    });
    await p.waitForTimeout(500);
    const after = alertCalls;
    console.log('  ℹ playAlert 调用 ' + (after - before) + ' 次, ringer.start 调用 ' + ringerStart + ' 次');
    if (ringerStart >= 1 && (after - before) >= 1) {
      meh('6.1 检测到声音冲突：playAlert + ringer 同时触发。建议把 merchant.js 的 watcher 改为只在 ring 未启用时 playAlert');
    } else if (ringerStart >= 1) {
      ok('6.1 仅 ringer 触发（playAlert 没二次触发）');
    } else {
      bad('6.1 ringer 未触发：' + ringerStart);
    }
    await ctx.close();
  }

  // 6.2 多 tab 不互相干扰（双开商家 tab，同一 merchant id）
  // 简化：单页验证 _lastPending 内部状态正确
  console.log('\n===== 组 7 · 状态稳定性 =====');
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE + '/merchant.html?demo');
    await p.waitForLoadState('networkidle');
    await p.waitForSelector('input[placeholder="商家账号"]');
    await p.fill('input[placeholder="商家账号"]', 'shop1');
    await p.fill('input[type="password"]', '1234');
    await p.click('button:has-text("登录")');
    await p.waitForFunction(() => window.store && window.store.auth && window.store.auth.user, { timeout: 5000 });
    await p.waitForTimeout(500);
    // 模拟两次连续 applyVendorOrders，确认 _lastPending 正确 diff
    const result = await p.evaluate(() => {
      var S = window.store;
      // round 1: 2 pending
      S.applyVendorOrders('shop1', [
        { orderId: '#r1o1', vendorId: 'shop1', HubID: 'utm', status: 'pending', customerName: 'A', phone: '0199990001', building: 'A 栋', room: 'T01', items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }], subtotal: 9.5, total: 9.5, deliveryTime: '12:30', createdAt: new Date().toISOString() },
        { orderId: '#r1o2', vendorId: 'shop1', HubID: 'utm', status: 'pending', customerName: 'B', phone: '0199990002', building: 'A 栋', room: 'T02', items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }], subtotal: 9.5, total: 9.5, deliveryTime: '12:30', createdAt: new Date().toISOString() },
      ]);
      var round1Pending = window.merchantRinger.pending().sort();
      // round 2: r1o1 接单→cooking, r1o2 still pending, 新增 r2o3 pending
      S.applyVendorOrders('shop1', [
        { orderId: '#r1o1', vendorId: 'shop1', HubID: 'utm', status: 'cooking', customerName: 'A', phone: '0199990001', building: 'A 栋', room: 'T01', items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }], subtotal: 9.5, total: 9.5, deliveryTime: '12:30', createdAt: new Date().toISOString() },
        { orderId: '#r1o2', vendorId: 'shop1', HubID: 'utm', status: 'pending', customerName: 'B', phone: '0199990002', building: 'A 栋', room: 'T02', items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }], subtotal: 9.5, total: 9.5, deliveryTime: '12:30', createdAt: new Date().toISOString() },
        { orderId: '#r2o3', vendorId: 'shop1', HubID: 'utm', status: 'pending', customerName: 'C', phone: '0199990003', building: 'A 栋', room: 'T03', items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }], subtotal: 9.5, total: 9.5, deliveryTime: '12:30', createdAt: new Date().toISOString() },
      ]);
      var round2Pending = window.merchantRinger.pending().sort();
      window.merchantRinger.stopAll();
      return { round1: round1Pending, round2: round2Pending };
    });
    // 注意：demo seed 已包含 #S1-01 (pending)，所以期望值要含
    if (result.round1.indexOf('#r1o1') >= 0 && result.round1.indexOf('#r1o2') >= 0) ok('7.1 round1 含 r1o1+r1o2 (+seed): ' + JSON.stringify(result.round1));
    else bad('7.1 round1 异常: ' + JSON.stringify(result.round1));
    if (result.round2.indexOf('#r1o1') < 0 && result.round2.indexOf('#r1o2') >= 0 && result.round2.indexOf('#r2o3') >= 0) ok('7.2 round2: r1o1 离队、r1o2 留、r2o3 入队 ✓');
    else bad('7.2 round2 异常: ' + JSON.stringify(result.round2));
    await ctx.close();
  }

  // 8.1 整个 contact-wa URL 长度 < 200 字符（避免某些 IM 客户端截断）
  console.log('\n===== 组 8 · 输出可用性 =====');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: 'X', phone: '0199999990',
        addresses: [{ id: 'a1', label: '默认', building: 'A 栋', room: 'T01', isDefault: true }],
      }));
    });
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    await p.evaluate(() => {
      var m = window.store.getMerchant('shop1');
      if (m && m.settings) m.settings.waNumber = '0123456789';
      window.store.state.orders.unshift({
        id: '#u8', merchantId: 'shop1', hubId: 'utm',
        customer: { name: 'X', phone: '0199999990', building: 'A 栋', room: 'T01' },
        items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }],
        subtotal: 9.5, total: 9.5, status: 'cooking', deliveryTime: '12:30',
        createdAt: Date.now(), syncStatus: 'synced',
      });
      window.store.state.activeOrderId = '#u8';
      window.store.ui.studentStep = 'status';
      window.store.ui.studentTab = 'home';
    });
    await p.waitForTimeout(400);
    const href = await p.locator('a.contact-wa').getAttribute('href').catch(() => null);
    if (href) {
      console.log('  ℹ wa.me URL 长度: ' + href.length);
      if (href.length < 250) ok('8.1 wa.me URL ' + href.length + ' 字符 < 250（IM 兼容）');
      else meh('8.1 wa.me URL ' + href.length + ' 字符过长');
      // wa.me 规范：65535 但部分老 Whatsapp 会截，250 是安全线
    }
    await ctx.close();
  }

  // 9.1 manifest 内 SVG 图标可用
  console.log('\n===== 组 9 · PWA 资产 =====');
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.webmanifest'), 'utf8'));
  if (manifest.icons && manifest.icons.length >= 2) ok('9.1 manifest 含 ' + manifest.icons.length + ' 个图标');
  else bad('9.1 manifest 图标缺失');
  // SVG data URL 安全检查
  if (manifest.icons.every(i => i.src.indexOf('data:image/svg') === 0 || i.src.indexOf('/') === 0)) ok('9.2 manifest 图标都是 SVG data URL 或本地路径');
  else meh('9.2 manifest 含外部图标 URL');
  if (manifest.start_url && manifest.scope && manifest.display === 'standalone') ok('9.3 manifest 满足 iOS A2HS 要求（start_url/scope/standalone）');
  else bad('9.3 manifest 不满足 iOS A2HS');
  if (manifest.theme_color) ok('9.4 theme_color="' + manifest.theme_color + '"');

  // 10.1 sw.js 处理 push 事件
  const swSrc = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
  if (swSrc.indexOf("addEventListener('push'") >= 0) ok('10.1 sw.js 监听 push 事件');
  else bad('10.1 sw.js 未监听 push');
  if (swSrc.indexOf("addEventListener('notificationclick'") >= 0) ok('10.2 sw.js 监听 notificationclick');
  else bad('10.2 sw.js 未监听 click');
  if (swSrc.indexOf("addEventListener('pushsubscriptionchange'") >= 0) ok('10.3 sw.js 监听 pushsubscriptionchange（订阅轮换）');
  else meh('10.3 sw.js 未监听 subscriptionchange');

  console.log('\n========================================');
  console.log('  PASS: ' + pass.length + '   FAIL: ' + fail.length + '   WARN: ' + warn.length);
  if (fail.length) { console.log('FAILED:'); fail.forEach(m => console.log('   - ' + m)); }
  if (warn.length) { console.log('WARN/INSIGHT:'); warn.forEach(m => console.log('   - ' + m)); }
  console.log('========================================');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('Fatal:', e); process.exit(2); });
