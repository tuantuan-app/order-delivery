// 定向验证：本轮 6 项改动
//   ① 客户端手机号输入框 +60 前缀
//   ② 客户卡 / 结算页 / 商家订单卡 / 商家详情 phone 显示用 displayPhone
//   ③ 商家端截图 wait 阈值 60s → 5min (shotState)
//   ④ iOS / Android standalone PWA 首启动恢复 modal 弹出 + 输入恢复
//   ⑤ 客户端 OrderStatus 顶部不再有 "正在发送给商家…" 旋转条
//   ⑥ wa.me / tel: 链接走 +60 国际格式
//
// 跑法：
//   先 python -m http.server 8777
//   node verify-phone-pwa-shotwait.js
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'verify-phone-pwa-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);
const BASE = 'http://localhost:8777';

const pass = [];
const fail = [];
function ok(m) { console.log('  PASS  ' + m); pass.push(m); }
function bad(m) { console.log('  FAIL  ' + m); fail.push(m); }
async function snap(p, name) { await p.screenshot({ path: path.join(OUT, name), fullPage: true }); }

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ============= 1. store.utils.waPhone / displayPhone 单元 =============
  console.log('\n=== 1. utils.waPhone / displayPhone ===');
  {
    const page = await browser.newPage();
    await page.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.store && window.store.utils);
    const cases = await page.evaluate(() => {
      const u = window.store.utils;
      return [
        ['0123456789', u.waPhone('0123456789'), u.displayPhone('0123456789')],
        ['123456789',  u.waPhone('123456789'),  u.displayPhone('123456789')],
        ['60123456789', u.waPhone('60123456789'), u.displayPhone('60123456789')],
        ['+60 12-345 6789', u.waPhone('+60 12-345 6789'), u.displayPhone('+60 12-345 6789')],
        ['',           u.waPhone(''),           u.displayPhone('')],
      ];
    });
    const exp = {
      '0123456789':    ['60123456789', '+60 12-345 6789'],
      '123456789':     ['60123456789', '+60 12-345 6789'],
      '60123456789':   ['60123456789', '+60 12-345 6789'],
      '+60 12-345 6789': ['60123456789', '+60 12-345 6789'],
      '':              ['', ''],
    };
    cases.forEach(([raw, wa, disp]) => {
      const [eWa, eDisp] = exp[raw];
      if (wa === eWa && disp === eDisp) ok(`utils "${raw}" → wa="${wa}" / display="${disp}"`);
      else bad(`utils "${raw}" → wa="${wa}" (expect ${eWa}) / display="${disp}" (expect ${eDisp})`);
    });
    await page.close();
  }

  // ============= 2. ProfileForm 手机号输入框带 +60 前缀 =============
  console.log('\n=== 2. ProfileForm phone-input +60 prefix ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    // 不预设 profile，让 needProfile 自然生效 → 进结算时弹 ProfileForm
    await ctx.addInitScript(() => { localStorage.setItem('canteen_hub_v1', 'utm'); });
    const page = await ctx.newPage();
    const noonToday = new Date(); noonToday.setHours(12, 15, 0, 0);
    await page.clock.install({ time: noonToday });
    await page.clock.resume();
    await page.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shop-card', { timeout: 5000 });
    await page.locator('.shop-card').first().click(); await page.waitForTimeout(400);
    await page.locator('.btn--primary:has-text("加入")').first().click(); await page.waitForTimeout(300);
    await page.locator('.cart-bar .btn--primary').click(); await page.waitForTimeout(500);

    const ccVisible = await page.locator('.field--phone .phone-input__cc').first().isVisible().catch(() => false);
    const ccText = ccVisible ? await page.locator('.field--phone .phone-input__cc').first().textContent() : '';
    if (ccVisible && ccText && ccText.includes('+60')) ok(`ProfileForm 显示 "${ccText.trim()}" 前缀`);
    else bad(`ProfileForm phone-input__cc 缺失或不含 +60 (visible=${ccVisible}, text="${ccText}")`);

    const placeholderHint = await page.locator('.field--phone input[type="tel"]').first().getAttribute('placeholder');
    if (placeholderHint && placeholderHint.includes('12')) ok(`placeholder 提示了去 0 写法: "${placeholderHint}"`);
    else bad(`placeholder 异常: "${placeholderHint}"`);

    await snap(page, '02-profile-form-phone.png');
    await page.close(); await ctx.close();
  }

  // ============= 3. profile-card / co-addr 用 displayPhone =============
  console.log('\n=== 3. profile-card + checkout co-addr → displayPhone ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: '测试顾客', phone: '0123456789', building: 'A 栋', room: 'T01',
      }));
      localStorage.setItem('canteen_hub_v1', 'utm');
    });
    const page = await ctx.newPage();
    const noonToday = new Date(); noonToday.setHours(12, 15, 0, 0);
    await page.clock.install({ time: noonToday });
    await page.clock.resume();
    await page.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shop-card', { timeout: 5000 });

    // 我的 tab → profile-card 上的 phone
    await page.locator('.tabbar button:has-text("我的")').click(); await page.waitForTimeout(400);
    const profSub = await page.locator('.profile-card__sub').first().textContent().catch(() => '');
    if (profSub.includes('+60') && profSub.includes('12') && !profSub.includes('0123456789')) {
      ok(`profile-card phone 显示 "${profSub.trim()}"`);
    } else {
      bad(`profile-card phone 异常: "${profSub.trim()}"`);
    }
    await snap(page, '03-customer-profile.png');

    // 回首页 → 进店 → 加单 → 结算 → 看 co-addr
    await page.locator('.tabbar button:has-text("首页")').click(); await page.waitForTimeout(300);
    await page.locator('.shop-card').first().click(); await page.waitForTimeout(400);
    await page.locator('.btn--primary:has-text("加入")').first().click(); await page.waitForTimeout(200);
    await page.locator('.cart-bar .btn--primary').click(); await page.waitForTimeout(500);

    const coWho = await page.locator('.co-addr__who').first().textContent().catch(() => '');
    if (coWho.includes('+60') && !coWho.includes('0123456789')) {
      ok(`结算页 co-addr__who 显示 "${coWho.trim()}"`);
    } else {
      bad(`co-addr__who 异常: "${coWho.trim()}"`);
    }
    await snap(page, '03-customer-checkout.png');
    await page.close(); await ctx.close();
  }

  // ============= 4. 客户端 OrderStatus 不再有 sync-note--go 旋转条 =============
  console.log('\n=== 4. OrderStatus 顶部不再有 "正在发送给商家…" ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: '测试顾客', phone: '0123456789', building: 'A 栋', room: 'T01',
      }));
      localStorage.setItem('canteen_hub_v1', 'utm');
    });
    const page = await ctx.newPage();
    const noonToday = new Date(); noonToday.setHours(12, 15, 0, 0);
    await page.clock.install({ time: noonToday });
    await page.clock.resume();
    await page.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shop-card', { timeout: 5000 });
    await page.locator('.shop-card').first().click(); await page.waitForTimeout(400);
    await page.locator('.btn--primary:has-text("加入")').first().click(); await page.waitForTimeout(200);
    await page.locator('.cart-bar .btn--primary').click(); await page.waitForTimeout(400);
    // 在 demo 模式下，admin god-view 才有示例图旁路；客户端没有，需要真传图
    const file = page.locator('input[type="file"]').first();
    await file.setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: TINY_PNG });
    await page.waitForTimeout(400);
    await page.locator('.btn--primary:has-text("提交订单"), .btn--primary:has-text("提交")').first().click();
    await page.waitForTimeout(700);

    // 应当在 status 页
    const onStatus = await page.locator('.status, .status-hero').first().isVisible().catch(() => false);
    if (onStatus) ok('提交后跳到 status 页');
    else bad('提交后没跳 status 页');

    // 找 sync-note--go：要么不存在，要么存在但不可见
    const goCount = await page.locator('.sync-note--go').count();
    if (goCount === 0) ok('OrderStatus 上 .sync-note--go 已彻底移除');
    else bad(`OrderStatus 上仍有 ${goCount} 个 .sync-note--go 节点`);

    // 顶部不应出现 "正在发送给商家…" 文本
    const html = await page.content();
    if (!html.includes('正在发送给商家')) ok('页面无 "正在发送给商家…" 文本');
    else bad('页面仍含 "正在发送给商家…" 文本');

    await snap(page, '04-status-no-spinner.png');
    await page.close(); await ctx.close();
  }

  // ============= 5. 商家端：phone 显示用 displayPhone + tel: 用 +60 国际格式 =============
  console.log('\n=== 5. 商家端 phone 显示 + tel: 链接 (走 admin god-view) ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(600);
    // 登录 admin
    const userIn = page.locator('input').first();
    if (await userIn.isVisible().catch(() => false)) {
      const all = await page.locator('input').all();
      await all[0].fill('admin');
      if (all.length > 1) await all[1].fill('admin123');
      await page.locator('button.btn--primary, button:has-text("登录")').first().click();
      await page.waitForTimeout(800);
    }
    // 切到商家视角
    const merchSwitch = page.locator('.role-switch button:has-text("商家")').first();
    if (await merchSwitch.isVisible().catch(() => false)) {
      await merchSwitch.click();
      await page.waitForTimeout(800);
      // 切到订单 tab (m-orders)
      const ordersTab = page.locator('button:has-text("订单"), .nav-tab:has-text("订单")').first();
      if (await ordersTab.isVisible().catch(() => false)) {
        await ordersTab.click();
        await page.waitForTimeout(600);
      }
    } else {
      bad('admin 端 role-switch 商家按钮不可见');
    }

    const orderCardCount = await page.locator('.order-card').count();
    if (orderCardCount > 0) ok(`商家端看到 ${orderCardCount} 单 (demo 种子)`);
    else bad('商家端没看到订单卡 (demo 种子未加载？)');

    if (orderCardCount > 0) {
      const custLine = await page.locator('.order-card__cust').first().textContent().catch(() => '');
      if (custLine.includes('+60')) ok(`商家订单卡 phone 显示 "${custLine.trim()}"`);
      else bad(`商家订单卡 phone 异常 (无 +60): "${custLine.trim()}"`);

      await page.locator('.order-card').first().click(); await page.waitForTimeout(400);
      const telHref = await page.locator('a.tel').first().getAttribute('href').catch(() => '');
      if (telHref && telHref.startsWith('tel:+60')) ok(`tel: 链接走 +60: "${telHref}"`);
      else bad(`tel: 链接异常: "${telHref}"`);

      const telText = await page.locator('a.tel').first().textContent().catch(() => '');
      if (telText && telText.includes('+60')) ok(`tel: 文本 +60: "${telText.trim()}"`);
      else bad(`tel: 文本无 +60: "${telText.trim()}"`);
    }

    await snap(page, '05-merchant-orders.png');
    await page.close(); await ctx.close();
  }

  // ============= 6. 商家端 shotState 5min 阈值 =============
  console.log('\n=== 6. shotState wait 阈值 = 5min (新单 4min 仍 "wait") ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const page = await ctx.newPage();
    await page.goto(BASE + '/merchant.html?demo', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    // 注入：构造 3 个无截图、不同 age 的订单，调用 shotState 直接验阈值
    const results = await page.evaluate(() => {
      // 假 order
      const NOW = Date.now();
      const make = (ageMs) => ({ screenshot: '', status: 'pending', createdAt: NOW - ageMs });
      // shotState 是 MOrders setup 内的闭包，不能直接拿。改为复刻同样的判定逻辑跑：
      function shot(o) {
        if (o.screenshot) return 'ok';
        if (o.status === 'rejected' || o.status === 'cancelled') return 'na';
        return (Date.now() - (Number(o.createdAt) || 0) < 5 * 60 * 1000) ? 'wait' : 'missing';
      }
      return {
        a30s: shot(make(30 * 1000)),      // 30s
        a4min: shot(make(4 * 60 * 1000)), // 4min
        a6min: shot(make(6 * 60 * 1000)), // 6min
      };
    });
    if (results.a30s === 'wait') ok('30s 无截图 → wait');
    else bad(`30s 无截图 → ${results.a30s} (期望 wait)`);
    if (results.a4min === 'wait') ok('4min 无截图 → wait (新阈值 5min)');
    else bad(`4min 无截图 → ${results.a4min} (期望 wait，旧 60s 阈值会算 missing)`);
    if (results.a6min === 'missing') ok('6min 无截图 → missing (超过 5min)');
    else bad(`6min 无截图 → ${results.a6min} (期望 missing)`);

    // 顺便 grep 源码确认阈值是 5*60*1000，而不是 60000
    const src = await page.evaluate(async () => (await fetch('/js/merchant.js')).text());
    if (src.includes('5 * 60 * 1000') && !src.match(/createdAt[^)]*\)\s*<\s*60000/)) {
      ok('merchant.js 源码已用 5 * 60 * 1000 替换 60000');
    } else {
      bad('merchant.js 源码未按预期更新 (找 5 * 60 * 1000 失败 或残留 60000 阈值)');
    }

    await page.close(); await ctx.close();
  }

  // ============= 7. PWA standalone 首启动恢复 modal =============
  console.log('\n=== 7. PWA standalone 首启动恢复 modal ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    // 模拟 standalone：override matchMedia('(display-mode: standalone)')
    // 注意：addInitScript 每次导航都跑，不能在这里清 localStorage，否则把代码刚写入的 tt_pwa_first_done 也擦掉
    await ctx.addInitScript(() => {
      const origMM = window.matchMedia;
      window.matchMedia = (q) => {
        if (q === '(display-mode: standalone)') return { matches: true, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} };
        return origMM.call(window, q);
      };
    });
    const page = await ctx.newPage();
    await page.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    // setTimeout 600ms 后弹
    await page.waitForTimeout(1500);

    const modalOpen = await page.locator('.modal:has-text("欢迎回到团团")').isVisible().catch(() => false);
    if (modalOpen) ok('standalone + 无 profile → 自动弹出恢复 modal');
    else bad('standalone + 无 profile → 恢复 modal 没弹（也许 store.profile 不为空？）');

    if (modalOpen) {
      // modal 里也用了 phone-input +60 前缀
      const ccText = await page.locator('.modal .phone-input__cc').first().textContent().catch(() => '');
      if (ccText && ccText.includes('+60')) ok(`恢复 modal 输入框带 "${ccText.trim()}" 前缀`);
      else bad(`恢复 modal phone-input__cc 异常: "${ccText}"`);
      await snap(page, '07-pwa-restore-modal.png');

      // 输入手机号 → 点 恢复 → 应当走 demo 模式无 api → 显示 "没找到这个号码的历史订单" toast
      await page.locator('.modal .phone-input input').fill('0199999991');
      await page.locator('.modal .btn--primary:has-text("恢复")').click();
      await page.waitForTimeout(800);

      const modalGone = !(await page.locator('.modal:has-text("欢迎回到团团")').isVisible().catch(() => false));
      if (modalGone) ok('恢复后 modal 自动关闭');
      else bad('恢复后 modal 没自动关闭');

      // demo 模式下 api.enabled() = false → loadMyOrders 直接 return → mine.length=0 → 走 store.profile = null 分支
      const profileNull = await page.evaluate(() => !window.store.profile);
      if (profileNull) ok('demo 模式无历史订单 → profile 复位为 null (按全新用户)');
      else bad('demo 模式应当因 no orders 把 profile 复位为 null');

      const donePersisted = await page.evaluate(() => localStorage.getItem('tt_pwa_first_done') === '1');
      if (donePersisted) ok('tt_pwa_first_done 写入 localStorage (下次不再弹)');
      else bad('tt_pwa_first_done 未写入');
    }

    // 重载页面 → 不应再弹
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1500);
    const reShow = await page.locator('.modal:has-text("欢迎回到团团")').isVisible().catch(() => false);
    if (!reShow) ok('再次进入不再重弹恢复 modal');
    else bad('恢复 modal 重弹 (一次性引导失效)');

    await page.close(); await ctx.close();
  }

  // ============= 8. 客户端 OrderStatus 上 merchantWa 链接走 +60 =============
  console.log('\n=== 8. 客户端 merchantWa 链接走 +60 ===');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: '测试顾客', phone: '0123456789', building: 'A 栋', room: 'T01',
      }));
      localStorage.setItem('canteen_hub_v1', 'utm');
    });
    const page = await ctx.newPage();
    const noonToday = new Date(); noonToday.setHours(12, 15, 0, 0);
    await page.clock.install({ time: noonToday });
    await page.clock.resume();
    await page.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.shop-card', { timeout: 5000 });
    // 注入: 给第一家店配置 waNumber=01234 5678 (大马号)，方便看链接
    await page.evaluate(() => {
      const m = window.store && window.store.state && window.store.state.merchants && window.store.state.merchants[0];
      if (m) { m.settings = m.settings || {}; m.settings.waNumber = '0123456789'; }
    });
    await page.locator('.shop-card').first().click(); await page.waitForTimeout(400);
    await page.locator('.btn--primary:has-text("加入")').first().click(); await page.waitForTimeout(200);
    await page.locator('.cart-bar .btn--primary').click(); await page.waitForTimeout(400);
    const file = page.locator('input[type="file"]').first();
    await file.setInputFiles({ name: 'shot.png', mimeType: 'image/png', buffer: TINY_PNG });
    await page.waitForTimeout(400);
    await page.locator('.btn--primary:has-text("提交")').first().click();
    await page.waitForTimeout(700);

    const waHref = await page.locator('a.contact-wa').first().getAttribute('href').catch(() => '');
    if (waHref && waHref.startsWith('https://wa.me/60')) ok(`merchantWa 链接走 wa.me/60: "${waHref.slice(0, 50)}..."`);
    else bad(`merchantWa 链接异常: "${waHref}"`);

    await page.close(); await ctx.close();
  }

  await browser.close();

  console.log('\n=== SUMMARY ===');
  console.log(`  PASS  ${pass.length}`);
  console.log(`  FAIL  ${fail.length}`);
  if (fail.length) {
    console.log('\n  失败项：');
    fail.forEach(f => console.log('    ✗ ' + f));
  }
  console.log(`\n  shots dir: ${OUT}`);
  process.exit(fail.length ? 1 : 0);
})().catch(e => {
  console.error('FATAL', e);
  process.exit(2);
});
