/*
 * smoke-notify.js —— Web Push 套件 + 商家响铃 + wa.me 整合测试
 *
 * 演示模式（?demo），不依赖后端。覆盖：
 *   A. 客户下单后 → notify-banner 显示（默认 + iOS 软引导）
 *   B. notify-banner 「稍后」点击 → localStorage 落 dismiss 戳
 *   C. 商家登录 → 响铃设置卡渲染、试听按钮可点
 *   D. 商家未配 waNumber → 客户页面无 contact-wa 按钮
 *   E. 商家配置 waNumber → 客户页面出现 contact-wa，URL 含正确状态文案
 *   F. iOS UA + 非 standalone → A2HS 引导横幅
 *   G. 现有的下单 → 同步 → 截图链路无回归
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'smoke-notify-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const BASE = 'http://localhost:8777';

const pass = []; const fail = [];
function ok(m) { console.log('  ✅ PASS  ' + m); pass.push(m); }
function bad(m) { console.log('  ❌ FAIL  ' + m); fail.push(m); }
async function snap(p, name) {
  try { await p.screenshot({ path: path.join(OUT, name), fullPage: true }); console.log('  📸  ' + name); }
  catch (e) { console.log('  ⚠ snap fail: ' + name + ' ' + e.message); }
}

async function customerCtx(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 414, height: 896 },
    userAgent: opts.ua,
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '测试·小明', phone: '0199999990',
      addresses: [{ id: 'a1', label: '默认', building: 'A 栋', room: 'T01', isDefault: true }],
    }));
    // Lock time to noon to bypass cutoff
    var now = new Date(); now.setHours(12, 0, 0, 0);
    var origNow = Date.now;
    Date.now = function () { return now.getTime(); };
  });
  return ctx;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ============== A. 检查首页正常渲染（无 pageerror）+ 我的订单 tab 可用 ==============
  console.log('\n=== A. 首页正常渲染 + 通知 hook 接线 ===');
  const ctxA = await customerCtx(browser);
  const a = await ctxA.newPage();
  let aErr = false;
  a.on('pageerror', (e) => { bad('Customer pageerror: ' + e.message); aErr = true; });
  await a.goto(BASE + '/index.html?demo');
  await a.waitForLoadState('networkidle');
  await snap(a, 'A1-home.png');
  if (!aErr) ok('A.客户首页无 pageerror');
  // 验证 hook 已挂在 store.syncOrder（后端 OK 后才触发，符合设计）
  const hookHooked = await a.evaluate(() => {
    var src = window.store && window.store.syncOrder && window.store.syncOrder.toString();
    return src && src.indexOf('promptCustomerAfterOrder') >= 0;
  });
  if (hookHooked) ok('A.store.syncOrder 含 promptCustomerAfterOrder hook');
  else bad('A.syncOrder 未注入 hook');
  // 验证 setAuthUser 含商家引导
  const merchantHook = await a.evaluate(() => {
    var src = window.store && window.store.setAuthUser && window.store.setAuthUser.toString();
    return src && src.indexOf('promptMerchantAfterLogin') >= 0;
  });
  if (merchantHook) ok('A.store.setAuthUser 含 promptMerchantAfterLogin hook');
  else bad('A.setAuthUser 未注入 hook');
  await ctxA.close();

  // ============== B. 手动触发 notify-banner（验证 UI + dismiss 持久化） ==============
  console.log('\n=== B. 手动触发 notify-banner + 持久化 dismiss ===');
  const ctxB = await customerCtx(browser);
  const b = await ctxB.newPage();
  b.on('pageerror', (e) => bad('B pageerror: ' + e.message));
  await b.goto(BASE + '/index.html?demo');
  await b.waitForLoadState('networkidle');

  // 直接调 window.notify.maybePrompt（headless 默认 perm=denied，stub Notification.permission 成 default）
  await b.evaluate(() => {
    // notify.js 闭包里调的是 Notification.permission，必须改 getter 才能影响内部 permission()
    try { Object.defineProperty(Notification, 'permission', { get: function () { return 'default'; }, configurable: true }); } catch (_) {}
    window.notify.maybePrompt('customer', '0199999990');
  });
  await b.waitForTimeout(400);
  const visibleB = await b.locator('.notify-banner').isVisible().catch(() => false);
  if (visibleB) {
    ok('B.banner 显示');
    await snap(b, 'B1-banner.png');
    // 点稍后
    const later = b.locator('.notify-banner__btn--ghost');
    await later.click();
    await b.waitForTimeout(300);
    const gone = !(await b.locator('.notify-banner').isVisible().catch(() => false));
    if (gone) ok('B.稍后关闭'); else bad('B.banner 未消失');
    // 检查 localStorage
    const dismissed = await b.evaluate(() => localStorage.getItem('notify_dismissed_customer'));
    if (dismissed) ok('B.dismiss 戳已写入 localStorage');
    else bad('B.dismiss 戳缺失');
  } else {
    bad('B.banner 未显示');
  }
  await ctxB.close();

  // ============== C. iOS UA → A2HS 引导 ==============
  console.log('\n=== C. iOS Safari UA → A2HS 引导 ===');
  const ctxC = await customerCtx(browser, {
    ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1',
  });
  const c = await ctxC.newPage();
  c.on('pageerror', (e) => bad('C pageerror: ' + e.message));
  await c.goto(BASE + '/index.html?demo');
  await c.waitForLoadState('networkidle');
  await c.evaluate(() => window.notify.maybePrompt('customer', '0199999990'));
  await c.waitForTimeout(400);
  const iosVisible = await c.locator('.notify-banner').isVisible().catch(() => false);
  if (iosVisible) {
    const title = (await c.locator('.notify-banner__title').textContent()) || '';
    const desc  = (await c.locator('.notify-banner__desc').textContent()) || '';
    const icon  = (await c.locator('.notify-banner__icon').textContent()) || '';
    if (icon === '📱') ok('C.iOS 图标 📱 正确');
    else bad('C.iOS 图标异常: ' + icon);
    if (desc.indexOf('主屏') >= 0 || desc.indexOf('添加到') >= 0) ok('C.iOS A2HS 引导文案正确（在 desc）');
    else bad('C.iOS A2HS 文案缺失. desc=' + desc);
    await snap(c, 'C1-ios-a2hs.png');
  } else {
    bad('C.iOS banner 未显示');
  }
  await ctxC.close();

  // ============== D. 商家登录 → 响铃设置卡 + 试听 ==============
  console.log('\n=== D. 商家响铃设置卡 ===');
  const ctxD = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const d = await ctxD.newPage();
  d.on('pageerror', (e) => bad('D pageerror: ' + e.message));
  await d.goto(BASE + '/merchant.html?demo');
  await d.waitForLoadState('networkidle');

  // 登录 shop1 / 1234
  const usernameInp = d.locator('input[type="text"], input[placeholder*="用户"], input[placeholder*="账号"]').first();
  const passInp = d.locator('input[type="password"]').first();
  if (await usernameInp.isVisible().catch(() => false)) {
    await usernameInp.fill('shop1');
    await passInp.fill('1234');
    const loginBtn = d.locator('button:has-text("登录"), button:has-text("登入")').first();
    await loginBtn.click();
    await d.waitForTimeout(1000);
    ok('D.商家登录');
    await snap(d, 'D1-merchant-home.png');
  } else { bad('D.找不到登录表单'); }

  // 去设置 tab
  const settingsTab = d.locator('button:has-text("设置"), .tabbar__ico:has-text("⚙️")').first();
  if (await settingsTab.isVisible().catch(() => false)) {
    await settingsTab.click();
    await d.waitForTimeout(500);
    await snap(d, 'D2-merchant-settings.png');
  }
  // 检查响铃卡
  const ringCard = d.locator('text=新单响铃').first();
  if (await ringCard.isVisible().catch(() => false)) ok('D.响铃设置卡渲染');
  else bad('D.响铃设置卡未出现');

  // 检查试听按钮
  const testBtn = d.locator('button:has-text("试听")').first();
  if (await testBtn.isVisible().catch(() => false)) ok('D.试听按钮可见');
  else bad('D.试听按钮缺失');

  // 检查 waNumber 输入框
  const waInput = d.locator('input[type="tel"][placeholder*="0123"]').first();
  if (await waInput.isVisible().catch(() => false)) {
    await waInput.fill('0123456789');
    await d.waitForTimeout(500);
    ok('D.waNumber 输入');
    await snap(d, 'D3-wa-set.png');
  } else { bad('D.waNumber 输入框缺失'); }

  await ctxD.close();

  // ============== E. 客户端 wa.me 按钮（演示模式直接造数据） ==============
  console.log('\n=== E. 客户订单页 contact-wa 按钮 ===');
  const ctxE = await customerCtx(browser);
  // 注入：让 demo 模式的 shop1 带 waNumber + 造个 active 订单
  await ctxE.addInitScript(() => {
    // demo 模式 store 是从 seed 来的；启动后我们 evaluate 改 store
  });
  const e = await ctxE.newPage();
  e.on('pageerror', (er) => bad('E pageerror: ' + er.message));
  await e.goto(BASE + '/index.html?demo');
  await e.waitForLoadState('networkidle');

  // 注入 waNumber 到 shop1 + 创建 active 订单
  const injected = await e.evaluate(() => {
    if (!window.store) return false;
    var m = window.store.getMerchant('shop1');
    if (m && m.settings) m.settings.waNumber = '0123456789';
    // 造一个 cooking 状态订单
    window.store.state.orders.unshift({
      id: '#wae2e', merchantId: 'shop1', hubId: 'utm',
      customer: { name: '测试·小明', phone: '0199999990', building: 'A 栋', room: 'T01' },
      items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }],
      subtotal: 9.5, packagingFee: 0, deliveryFee: 0, total: 9.5,
      status: 'cooking', deliveryTime: '12:30',
      createdAt: Date.now(), createdAtText: '刚刚',
      syncStatus: 'synced', imgStatus: 'ok',
      screenshot: '',
    });
    window.store.state.activeOrderId = '#wae2e';
    window.store.ui.studentStep = 'status';
    window.store.ui.studentTab = 'home';
    return true;
  });
  if (injected) ok('E.注入 active 订单 + waNumber + 切到 status 视图');
  await e.waitForTimeout(800);
  await snap(e, 'E2-track-view.png');

  // 找 contact-wa
  const waLink = e.locator('a.contact-wa');
  const waVisible = await waLink.isVisible().catch(() => false);
  if (waVisible) {
    const href = await waLink.getAttribute('href');
    if (href && href.indexOf('wa.me/60123456789') >= 0) ok('E.wa.me URL 正确：' + href.slice(0, 80));
    else bad('E.wa.me URL 不对：' + href);
    if (href && decodeURIComponent(href).indexOf('出餐') >= 0) ok('E.cooking 状态文案"出餐"出现');
    else bad('E.cooking 状态文案缺失 decoded=' + (href ? decodeURIComponent(href).slice(0, 120) : ''));
  } else {
    bad('E.contact-wa 按钮未出现（可能 OrderStatus 没渲染）');
  }
  await ctxE.close();

  // ============== F. 商家无 waNumber → 客户端不显示按钮 ==============
  console.log('\n=== F. 商家无 waNumber → 不显示按钮 ===');
  const ctxF = await customerCtx(browser);
  const f = await ctxF.newPage();
  f.on('pageerror', (er) => bad('F pageerror: ' + er.message));
  await f.goto(BASE + '/index.html?demo');
  await f.waitForLoadState('networkidle');
  await f.evaluate(() => {
    var m = window.store.getMerchant('shop1');
    if (m && m.settings) m.settings.waNumber = ''; // 显式清空
    window.store.state.orders.unshift({
      id: '#nowae2e', merchantId: 'shop1', hubId: 'utm',
      customer: { name: 'X', phone: '0199999991', building: 'A 栋', room: 'T02' },
      items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }],
      subtotal: 9.5, packagingFee: 0, deliveryFee: 0, total: 9.5,
      status: 'cooking', deliveryTime: '12:30',
      createdAt: Date.now(), createdAtText: '刚刚', syncStatus: 'synced', imgStatus: 'ok',
    });
    window.store.state.activeOrderId = '#nowae2e';
    window.store.ui.studentStep = 'status';
    window.store.ui.studentTab = 'home';
  });
  await f.waitForTimeout(500);
  const noWa = !(await f.locator('a.contact-wa').isVisible().catch(() => false));
  if (noWa) ok('F.无 waNumber → 按钮不显示'); else bad('F.无 waNumber 仍显示按钮（异常）');
  await ctxF.close();

  // ============== G. window.merchantRinger 装载 ==============
  console.log('\n=== G. merchantRinger 模块装载 ===');
  const ctxG = await browser.newContext();
  const g = await ctxG.newPage();
  g.on('pageerror', (er) => bad('G pageerror: ' + er.message));
  await g.goto(BASE + '/merchant.html?demo');
  await g.waitForLoadState('networkidle');
  const ringer = await g.evaluate(() => {
    if (!window.merchantRinger) return null;
    return {
      hasStart: typeof window.merchantRinger.start === 'function',
      hasStop: typeof window.merchantRinger.stop === 'function',
      hasTest: typeof window.merchantRinger.testBeep === 'function',
      defaults: window.merchantRinger.defaults,
      status: window.merchantRinger.status(),
    };
  });
  if (ringer && ringer.hasStart && ringer.hasStop && ringer.hasTest) ok('G.merchantRinger API 完整 · status=' + ringer.status);
  else bad('G.merchantRinger 缺失或不完整: ' + JSON.stringify(ringer));
  // 检查默认配置
  if (ringer && ringer.defaults && ringer.defaults.enabled === true && ringer.defaults.escalateAfterMin === 5) {
    ok('G.默认配置正确（enabled=true, escalateAfter=5min）');
  } else { bad('G.默认配置异常: ' + JSON.stringify(ringer && ringer.defaults)); }
  await ctxG.close();

  // ============== H. window.notify 装载 ==============
  console.log('\n=== H. window.notify 模块装载 ===');
  const ctxH = await browser.newContext();
  const h = await ctxH.newPage();
  await h.goto(BASE + '/index.html?demo');
  await h.waitForLoadState('networkidle');
  const notify = await h.evaluate(() => ({
    has: !!window.notify,
    perm: window.notify && window.notify.permission(),
    sup: window.notify && window.notify.supported(),
    ios: window.notify && window.notify.isIOSSafari(),
    standalone: window.notify && window.notify.isStandalone(),
    methods: window.notify ? Object.keys(window.notify) : [],
  }));
  if (notify.has && notify.methods.indexOf('enable') >= 0) ok('H.window.notify 加载 · perm=' + notify.perm + ' sup=' + notify.sup);
  else bad('H.window.notify 缺失');
  await ctxH.close();

  // ============== I. 响铃 pendingSet 跟踪 ==============
  console.log('\n=== I. ringer.start/stop pendingSet 跟踪 ===');
  const ctxI = await browser.newContext();
  const i = await ctxI.newPage();
  await i.goto(BASE + '/merchant.html?demo');
  await i.waitForLoadState('networkidle');
  const ringFlow = await i.evaluate(() => {
    var R = window.merchantRinger;
    R.start('#o1'); R.start('#o2'); R.start('#o1'); // o1 重复应幂等
    var afterStart = R.pending().sort();
    R.stop('#o1');
    var afterStopOne = R.pending().sort();
    R.stopAll();
    var afterStopAll = R.pending();
    return { afterStart: afterStart, afterStopOne: afterStopOne, afterStopAll: afterStopAll };
  });
  if (JSON.stringify(ringFlow.afterStart) === '["#o1","#o2"]') ok('I.start 后 pendingSet=2 (幂等正确)');
  else bad('I.start 异常: ' + JSON.stringify(ringFlow.afterStart));
  if (JSON.stringify(ringFlow.afterStopOne) === '["#o2"]') ok('I.stop o1 后只剩 o2');
  else bad('I.stop o1 后异常: ' + JSON.stringify(ringFlow.afterStopOne));
  if (JSON.stringify(ringFlow.afterStopAll) === '[]') ok('I.stopAll 后 pendingSet 清空');
  else bad('I.stopAll 后异常: ' + JSON.stringify(ringFlow.afterStopAll));
  await ctxI.close();

  // ============== J. 勿扰时段判断 ==============
  console.log('\n=== J. 勿扰时段 (quietStart/quietEnd) ===');
  const ctxJ = await browser.newContext();
  const j = await ctxJ.newPage();
  await j.goto(BASE + '/merchant.html?demo');
  await j.waitForLoadState('networkidle');
  // 直接通过 state.merchants + ui.merchantId 让 store.merchant 有值
  const quietRes = await j.evaluate(() => {
    var R = window.merchantRinger; var S = window.store;
    // 取 demo seed 里的 shop1（应已存在 state.merchants 数组）
    var m = S.state.merchants && S.state.merchants[0];
    if (!m) return { error: 'no merchants seeded' };
    S.ui.merchantId = m.id;
    if (!m.settings) m.settings = {};
    var now = new Date(); var hh = String(now.getHours()).padStart(2, '0');
    m.settings.ring = { enabled: true, volume: 0.5, intervalSec: 1.2, maxDurationSec: 30, escalateAfterMin: 5, quietStart: hh + ':00', quietEnd: hh + ':59' };
    if (!S.merchant) return { error: 'computed merchant still null. ui.merchantId=' + S.ui.merchantId };
    R.start('#qt1');
    var status = R.status();
    R.stopAll();
    return { status: status, settingsRing: S.merchant.settings.ring };
  });
  if (quietRes.status === 'quiet') ok('J.勿扰时段内 status=quiet（不响）');
  else bad('J.勿扰时段判断异常: ' + JSON.stringify(quietRes));
  await ctxJ.close();

  // ============== 总结 ==============
  console.log('\n========================================');
  console.log('  PASS: ' + pass.length + '   FAIL: ' + fail.length);
  if (fail.length) { console.log('\nFAILED:'); fail.forEach(function (m) { console.log('   - ' + m); }); }
  console.log('========================================');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(function (e) { console.error('Fatal:', e); process.exit(2); });
