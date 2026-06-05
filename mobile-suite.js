// mobile-suite.js — 4 suite 全面移动端测试
//   Suite 1: 跨设备 layout (5 设备 × webkit+chromium = 10 上下文, demo 模式无后端)
//   Suite 2: 真 PROD 烟雾测试（iPhone 14 webkit + Pixel 7 chromium, 各 1 单, 立刻取消）
//   Suite 3: PWA / Service Worker / Manifest 检查
//   Suite 4: 20 商家容量压测（demo 注入 mock 数据）
//
// 用法: node mobile-suite.js [suite=1,2,3,4]   默认全跑
//      node mobile-suite.js suite=1            只跑 suite 1
const { chromium, webkit, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'mobile-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const PROD_BASE = 'https://tuantuan-app.github.io';
const DEMO_PATH = '/index.html?demo';
const PROD_PATH = '/index.html';

// PROD 测试标记 —— 后续 admin 一搜就找到
const TEST_PHONE_PREFIX = '01666666'; // + 2 digits per order
const TEST_NAME = '🤖压测';

const TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const argSuites = (process.argv.find(a => a.startsWith('suite=')) || 'suite=1,2,3,4').split('=')[1].split(',').map(Number);
const runSuite = (n) => argSuites.includes(n);

const findings = [];
function log(suite, tag, msg, detail = '') {
  const line = `[S${suite}] ${tag} ${msg}${detail ? ' :: ' + detail : ''}`;
  findings.push({ suite, tag, msg, detail });
  console.log(line);
}
async function snap(p, name) {
  try { await p.screenshot({ path: path.join(OUT, name), fullPage: true }); }
  catch (e) { console.log('snap fail:', name, e.message.split('\n')[0]); }
}

// PROD orders 我创建的，需要清理的
const createdOrders = [];

// ============================================================
//                          SUITE 1
//   跨设备 layout (demo, 无后端) — 5 设备 × 2 引擎
// ============================================================
async function suite1() {
  console.log('\n========== SUITE 1 · 跨设备 layout ==========');
  const targets = [
    { name: 'iPhone-SE', engine: webkit, device: devices['iPhone SE'] },
    { name: 'iPhone-14', engine: webkit, device: devices['iPhone 14'] },
    { name: 'iPhone-14-ProMax', engine: webkit, device: devices['iPhone 14 Pro Max'] },
    { name: 'Pixel-7', engine: chromium, device: devices['Pixel 7'] },
    { name: 'Galaxy-S9p', engine: chromium, device: devices['Galaxy S9+'] },
    { name: 'iPad-Pro', engine: webkit, device: devices['iPad Pro 11'] },
  ];
  for (const t of targets) {
    const tag = `${t.name}(${t.engine === webkit ? 'webkit' : 'chromium'})`;
    console.log(`\n--- ${tag} · ${t.device.viewport.width}×${t.device.viewport.height} ---`);
    const browser = await t.engine.launch({ headless: true });
    const ctx = await browser.newContext({
      ...t.device,
      // pre-seed hub + profile so we skip onboarding
      storageState: undefined,
    });
    await ctx.addInitScript(() => {
      localStorage.setItem('canteen_hub_v1', 'utm');
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: '测试用户', phone: '0199999999',
        addresses: [{ id: 'a1', label: '默认地址', building: 'A 栋', room: '301', isDefault: true }]
      }));
    });
    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push(`PE: ${e.message.split('\n')[0]}`));
    p.on('console', m => { if (m.type() === 'error') errs.push(`CE: ${m.text().slice(0, 100)}`); });

    // Customer side
    try {
      await p.goto(PROD_BASE + DEMO_PATH, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await p.waitForTimeout(1500);
      await snap(p, `s1-${t.name}-01-home.png`);
      const shops = await p.locator('.shop-card').count();
      if (shops === 0) { log(1, 'FAIL', `${tag}: home empty`); }
      else log(1, 'PASS', `${tag}: home ${shops} shops`);

      // Enter first shop
      await p.locator('.shop-card:not(.shop-card--closed)').first().click();
      await p.waitForTimeout(700);
      await snap(p, `s1-${t.name}-02-menu.png`);
      const dishes = await p.locator('.dish').count();
      if (dishes === 0) { log(1, 'FAIL', `${tag}: menu empty`); }

      // Add item
      await p.locator('button:has-text("加入")').first().click();
      await p.waitForTimeout(300);
      // Checkout
      await p.locator('button:has-text("去结算")').first().click();
      await p.waitForTimeout(800);
      await snap(p, `s1-${t.name}-03-checkout.png`);

      // My tab
      // Use icon-back to leave checkout (or browser back)
      await p.goBack();
      await p.waitForTimeout(400);
      await p.goBack();
      await p.waitForTimeout(400);
      const meTab = p.locator('.tabbar button:has-text("我的")').first();
      if (await meTab.isVisible().catch(() => false)) {
        await meTab.click();
        await p.waitForTimeout(500);
        await snap(p, `s1-${t.name}-04-me-tab.png`);
      }
    } catch (e) {
      log(1, 'FAIL', `${tag}: ${e.message.split('\n')[0]}`);
    }

    // Merchant page (just check it renders)
    try {
      await p.goto(PROD_BASE + '/merchant.html?demo', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await p.waitForTimeout(1500);
      await snap(p, `s1-${t.name}-05-merchant-login.png`);
      log(1, 'PASS', `${tag}: merchant page loads`);
    } catch (e) {
      log(1, 'FAIL', `${tag}: merchant ${e.message.split('\n')[0]}`);
    }

    if (errs.length) {
      const uniq = [...new Set(errs)];
      uniq.slice(0, 3).forEach(e => log(1, 'CONSOLE', `${tag}: ${e}`));
    }
    await browser.close();
  }
}

// ============================================================
//                          SUITE 2
//   PROD 烟雾 (创建真实订单 → 立刻取消) iOS + Android
// ============================================================
async function suite2() {
  console.log('\n========== SUITE 2 · PROD 烟雾 ==========');
  const targets = [
    { name: 'iOS-Safari', engine: webkit, device: devices['iPhone 14'], phoneSuffix: '61' },
    { name: 'Android-Chrome', engine: chromium, device: devices['Pixel 7'], phoneSuffix: '62' },
  ];
  for (const t of targets) {
    const tag = `${t.name}`;
    const phone = TEST_PHONE_PREFIX + t.phoneSuffix;
    console.log(`\n--- ${tag} · prod 烟雾 (phone=${phone}) ---`);
    const browser = await t.engine.launch({ headless: true });
    const ctx = await browser.newContext({ ...t.device });
    // Seed hub so picker doesn't block
    await ctx.addInitScript((profile) => {
      localStorage.setItem('canteen_hub_v1', 'utm');
      localStorage.setItem('canteen_profile_v4', JSON.stringify(profile));
    }, {
      name: TEST_NAME, phone: phone,
      addresses: [{ id: 'a1', label: '默认地址', building: 'A 栋', room: 'PW', isDefault: true }]
    });
    const p = await ctx.newPage();
    const errs = []; const networkErrs = [];
    p.on('pageerror', e => errs.push(`PE: ${e.message.split('\n')[0]}`));
    p.on('console', m => { if (m.type() === 'error') errs.push(`CE: ${m.text().slice(0, 100)}`); });
    p.on('requestfailed', r => networkErrs.push(`${r.method()} ${r.url().slice(0, 80)} → ${r.failure() ? r.failure().errorText : '?'}`));

    let orderId = null;
    try {
      await p.goto(PROD_BASE + PROD_PATH, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await p.waitForTimeout(2500); // prod 真 API 比 demo 慢
      await snap(p, `s2-${t.name}-01-home.png`);

      const shops = await p.locator('.shop-card').count();
      if (shops === 0) {
        log(2, 'FAIL', `${tag}: prod home empty (api 挂了?)`);
        await browser.close(); continue;
      }
      log(2, 'PASS', `${tag}: prod home ${shops} shops`);

      // Enter first open shop
      await p.locator('.shop-card:not(.shop-card--closed)').first().click();
      await p.waitForTimeout(2000);
      await snap(p, `s2-${t.name}-02-menu.png`);

      // Add an item that doesn't need 选规格
      const addBtn = p.locator('button:has-text("加入")').first();
      if (!(await addBtn.isVisible().catch(() => false))) {
        log(2, 'FAIL', `${tag}: no '加入' on menu`);
        await browser.close(); continue;
      }
      await addBtn.click();
      await p.waitForTimeout(500);

      // Checkout
      await p.locator('button:has-text("去结算")').first().click();
      await p.waitForTimeout(1500);
      await snap(p, `s2-${t.name}-03-checkout.png`);

      // Upload tiny screenshot
      const fileIn = p.locator('input[type="file"]').first();
      await fileIn.waitFor({ state: 'attached', timeout: 8000 });
      await fileIn.setInputFiles({ name: 'pw.png', mimeType: 'image/png', buffer: TINY });
      await p.waitForTimeout(800);

      // Submit
      const submit = p.locator('button.btn--primary.btn--block').last();
      await p.waitForFunction(() => {
        const bs = document.querySelectorAll('button.btn--primary.btn--block');
        const b = bs[bs.length - 1]; return b && !b.disabled;
      }, { timeout: 10000 });
      await submit.click();
      await p.waitForTimeout(2500); // 真 placeOrder

      // Grab the order ID from store
      orderId = await p.evaluate(() => window.store && window.store.activeOrder && window.store.activeOrder.id);
      log(2, orderId ? 'PASS' : 'FAIL', `${tag}: prod order placed → ${orderId || 'NO ID'}`);
      if (orderId) createdOrders.push({ device: tag, phone, orderId });
      await snap(p, `s2-${t.name}-04-status.png`);

      // CANCEL IMMEDIATELY to minimize merchant impact
      p.once('dialog', d => d.accept());
      const cancelBtn = p.locator('button:has-text("取消订单")').first();
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
        await p.waitForTimeout(2500); // sync cancel to prod
        await snap(p, `s2-${t.name}-05-cancelled.png`);
        const cancelled = await p.evaluate((id) => {
          if (!window.store) return false;
          const o = window.store.state.orders.find(o => o.id === id);
          return o && o.status === 'cancelled';
        }, orderId);
        log(2, cancelled ? 'PASS' : 'WARN', `${tag}: cancelled state=${cancelled}`);
      } else {
        log(2, 'WARN', `${tag}: no cancel button visible — order may have already been approved by merchant`);
      }
    } catch (e) {
      log(2, 'FAIL', `${tag}: ${e.message.split('\n')[0]}`);
    }

    if (errs.length) {
      const uniq = [...new Set(errs)];
      uniq.slice(0, 5).forEach(e => log(2, 'CONSOLE', `${tag}: ${e}`));
    }
    if (networkErrs.length) {
      networkErrs.slice(0, 3).forEach(e => log(2, 'NETWORK', `${tag}: ${e}`));
    }
    await browser.close();
  }
}

// ============================================================
//                          SUITE 3
//   PWA / SW / manifest 检查
// ============================================================
async function suite3() {
  console.log('\n========== SUITE 3 · PWA / SW / Manifest ==========');
  // 用 chromium 检查能力 + 验证 manifest 格式
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  const p = await ctx.newPage();
  try {
    await p.goto(PROD_BASE + PROD_PATH, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p.waitForTimeout(2000);

    // 1. Manifest fetch + parse
    const manifestUrl = await p.evaluate(() => {
      const l = document.querySelector('link[rel="manifest"]');
      return l ? l.href : null;
    });
    log(3, manifestUrl ? 'PASS' : 'FAIL', `<link rel=manifest>: ${manifestUrl || 'NONE'}`);
    if (manifestUrl) {
      const r = await p.evaluate(async (u) => {
        try { const res = await fetch(u); return { status: res.status, text: await res.text() }; }
        catch (e) { return { status: 0, error: String(e) }; }
      }, manifestUrl);
      log(3, r.status === 200 ? 'PASS' : 'FAIL', `manifest HTTP ${r.status}`);
      if (r.status === 200) {
        try {
          const m = JSON.parse(r.text);
          const required = ['name', 'short_name', 'start_url', 'display', 'icons'];
          const missing = required.filter(k => !m[k]);
          log(3, missing.length === 0 ? 'PASS' : 'WARN', `manifest required fields: missing=${missing.join(',') || 'none'}`);
          log(3, 'INFO', `manifest: name="${m.name}" display="${m.display}" theme=${m.theme_color || '-'} icons=${(m.icons || []).length}`);
        } catch (e) {
          log(3, 'FAIL', `manifest JSON parse: ${e.message}`);
        }
      }
    }

    // 2. Service Worker
    const swInfo = await p.evaluate(async () => {
      if (!('serviceWorker' in navigator)) return { supported: false };
      try {
        const reg = await navigator.serviceWorker.register('/sw.js');
        return { supported: true, scope: reg.scope, active: !!reg.active, installing: !!reg.installing };
      } catch (e) { return { supported: true, error: String(e) }; }
    });
    log(3, swInfo.supported ? 'PASS' : 'FAIL', `SW support: ${JSON.stringify(swInfo)}`);

    // 3. Push API support (WebKit / iOS Safari: only supported in PWA mode after A2HS)
    const pushSupport = await p.evaluate(() => ({
      pushManager: 'PushManager' in window,
      notification: 'Notification' in window,
      permission: 'Notification' in window ? Notification.permission : 'no-api',
    }));
    log(3, pushSupport.pushManager ? 'PASS' : 'INFO',
      `Push API: pushManager=${pushSupport.pushManager} Notification=${pushSupport.notification} permission=${pushSupport.permission}`);

    // 4. iOS Safari specifics — only in webkit
    await ctx.close();
    const wkb = await webkit.launch({ headless: true });
    const wkc = await wkb.newContext({ ...devices['iPhone 14'] });
    const wkp = await wkc.newPage();
    await wkp.goto(PROD_BASE + PROD_PATH, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await wkp.waitForTimeout(2000);
    const iosPwa = await wkp.evaluate(() => ({
      pushManager: 'PushManager' in window,
      notification: 'Notification' in window,
      standalone: typeof navigator.standalone !== 'undefined' ? navigator.standalone : null,
      ua: navigator.userAgent.slice(0, 80),
    }));
    log(3, 'INFO', `iOS webkit: pushManager=${iosPwa.pushManager} notification=${iosPwa.notification} standalone=${iosPwa.standalone}`);
    log(3, 'INFO', `(真 iOS 设备：Push 仅在 A2HS standalone 模式下可用，浏览器内不行)`);
    await wkb.close();

  } catch (e) {
    log(3, 'FAIL', `suite3: ${e.message.split('\n')[0]}`);
  }
  if (browser.contexts && browser.contexts().length) await browser.close().catch(() => {});
}

// ============================================================
//                          SUITE 4
//   20 商家容量压测 (demo 注入 mock)
// ============================================================
async function suite4() {
  console.log('\n========== SUITE 4 · 20 商家容量 ==========');
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ ...devices['Pixel 7'] });
  // Inject 20 mock merchants into the store on load
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_hub_v1', 'utm');
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '测试用户', phone: '0199999998',
      addresses: [{ id: 'a1', label: '默认地址', building: 'A 栋', room: '301', isDefault: true }]
    }));
  });
  const p = await ctx.newPage();
  let errs = [];
  p.on('pageerror', e => errs.push(`PE: ${e.message.split('\n')[0]}`));
  p.on('console', m => { if (m.type() === 'error') errs.push(`CE: ${m.text().slice(0, 100)}`); });

  try {
    await p.goto(PROD_BASE + DEMO_PATH, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p.waitForTimeout(1500);

    // Inject 16 additional merchants (demo already has 4 → 20 total)
    const before = await p.locator('.shop-card').count();
    log(4, 'INFO', `seed demo has ${before} merchants`);

    const tInject0 = Date.now();
    await p.evaluate(() => {
      const ms = window.store && window.store.state && window.store.state.merchants;
      if (!ms) return;
      // copy menu/settings from shop1 as template
      const tpl = ms.find(m => m.id === 'shop1');
      if (!tpl) return;
      for (let i = 5; i <= 20; i++) {
        const id = 'mock-shop-' + i;
        if (ms.some(m => m.id === id)) continue;
        const clone = JSON.parse(JSON.stringify(tpl));
        clone.id = id;
        clone.name = '测试商家 ' + String(i).padStart(2, '0');
        clone.desc = '压测占位 · 自动生成';
        clone.hubId = i % 3 === 0 ? 'ukm' : 'utm';
        clone.open = i % 7 !== 0; // 部分休息中
        ms.push(clone);
      }
    });
    const injectMs = Date.now() - tInject0;

    // Trigger re-render
    await p.reload();
    await p.waitForTimeout(1500);
    const afterReload = await p.locator('.shop-card').count();
    log(4, afterReload >= 14 ? 'PASS' : 'WARN', `after inject (utm hub visible): ${afterReload} merchants (injected in ${injectMs}ms)`);

    // Wait re-inject 没保住（reload 清了 store），重新注入
    await p.evaluate(() => {
      const ms = window.store && window.store.state && window.store.state.merchants;
      if (!ms) return;
      const tpl = ms.find(m => m.id === 'shop1');
      if (!tpl) return;
      for (let i = 5; i <= 20; i++) {
        const id = 'mock-shop-' + i;
        if (ms.some(m => m.id === id)) continue;
        const clone = JSON.parse(JSON.stringify(tpl));
        clone.id = id;
        clone.name = '测试商家 ' + String(i).padStart(2, '0');
        clone.desc = '压测占位 · 自动生成';
        clone.hubId = i % 3 === 0 ? 'ukm' : 'utm';
        clone.open = i % 7 !== 0;
        ms.push(clone);
      }
    });
    await p.waitForTimeout(500);
    const final = await p.locator('.shop-card').count();
    log(4, 'INFO', `final visible (utm hub, no reload): ${final}`);
    await snap(p, 's4-home-20-merchants.png');

    // Scroll perf — measure FPS-ish via scroll distance
    const tScroll0 = Date.now();
    for (let s = 0; s < 5; s++) {
      await p.evaluate(() => window.scrollBy(0, 300));
      await p.waitForTimeout(80);
    }
    const scrollMs = Date.now() - tScroll0;
    log(4, scrollMs < 1500 ? 'PASS' : 'WARN', `scroll 5×300px in ${scrollMs}ms (smooth threshold <1500ms)`);

    // Search across 20+
    const search = p.locator('input[placeholder*="搜索"]').first();
    if (await search.isVisible().catch(() => false)) {
      await search.fill('测试');
      await p.waitForTimeout(400);
      const searchResults = await p.locator('.shop-card').count();
      log(4, searchResults >= 1 ? 'PASS' : 'WARN', `search "测试" → ${searchResults} merchants in 20-shop store`);
      await snap(p, 's4-search-results.png');
      await search.fill('');
    }

    // Now admin dashboard with 20 vendors — switch to admin god-view
    await p.goto(PROD_BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded', timeout: 20000 });
    await p.waitForTimeout(1200);
    await p.locator('input').first().fill('admin');
    await p.locator('input[type="password"]').first().fill('admin123');
    await p.locator('button:has-text("登录"), button:has-text("登入")').first().click();
    await p.waitForTimeout(1500);
    // Inject vendors here too
    await p.evaluate(() => {
      const ms = window.store && window.store.state && window.store.state.merchants;
      if (!ms) return;
      const tpl = ms.find(m => m.id === 'shop1');
      if (!tpl) return;
      for (let i = 5; i <= 20; i++) {
        const id = 'mock-shop-' + i;
        if (ms.some(m => m.id === id)) continue;
        const clone = JSON.parse(JSON.stringify(tpl));
        clone.id = id; clone.name = '测试商家 ' + String(i).padStart(2, '0');
        clone.hubId = i % 3 === 0 ? 'ukm' : 'utm';
        ms.push(clone);
      }
    });
    await p.waitForTimeout(500);
    // Trigger UI refresh by clicking 经营 tab
    const reBtn = p.locator('button:has-text("经营")').first();
    if (await reBtn.isVisible().catch(() => false)) {
      await reBtn.click(); await p.waitForTimeout(600);
    }
    await snap(p, 's4-admin-dashboard-20.png');
    // Try 商家 tab to see vendor list
    const vTab = p.locator('button:has-text("商家")').last();
    if (await vTab.isVisible().catch(() => false)) {
      await vTab.click(); await p.waitForTimeout(800);
      await snap(p, 's4-admin-vendor-list-20.png');
      const vCount = await p.locator('.shop-card, .vendor-row, [class*="vendor"]').count();
      log(4, 'INFO', `admin vendor list: ${vCount} entries`);
    }

  } catch (e) {
    log(4, 'FAIL', `suite4: ${e.message.split('\n')[0]}`);
  }
  if (errs.length) [...new Set(errs)].slice(0, 5).forEach(e => log(4, 'CONSOLE', e));
  await browser.close();
}

// ============================================================
(async () => {
  const t0 = Date.now();
  if (runSuite(1)) await suite1();
  if (runSuite(2)) await suite2();
  if (runSuite(3)) await suite3();
  if (runSuite(4)) await suite4();
  const dur = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('\n========== FINAL REPORT ==========');
  const tally = findings.reduce((a, f) => ((a[f.tag] = (a[f.tag] || 0) + 1), a), {});
  Object.keys(tally).sort().forEach(t => console.log(`  ${t}: ${tally[t]}`));
  console.log(`\n  duration: ${dur}s`);

  if (createdOrders.length) {
    console.log('\n========== PROD 订单清理清单 ==========');
    console.log('以下是测试中创建的 PROD 订单（应已 cancelled）；');
    console.log('admin 搜索 phone 即可定位：');
    createdOrders.forEach(o => console.log(`  • ${o.device}  phone=${o.phone}  orderId=${o.orderId}`));
    fs.writeFileSync(path.join(OUT, 'PROD-ORDERS-TO-CLEAN.txt'),
      'PROD test orders created:\n' +
      createdOrders.map(o => `  ${o.device}\tphone=${o.phone}\torderId=${o.orderId}`).join('\n') +
      '\n\n清理: admin → 商家视图 → 搜 phone 0166666661 / 0166666662 → 已经 cancelled\n');
  }

  fs.writeFileSync(path.join(OUT, 'findings.json'), JSON.stringify({ findings, createdOrders, tally, durationSec: Number(dur) }, null, 2));
  console.log('\n  shots+report dir:', OUT);

  process.exit(0);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
