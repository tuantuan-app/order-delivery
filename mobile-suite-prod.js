// mobile-suite-prod.js — 只跑 PROD 烟雾，用 xmum hub + Kat 商家
const { chromium, webkit, devices } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'mobile-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const PROD_BASE = 'https://tuantuan-app.github.io';
const PROD_PATH = '/index.html';
const HUB = 'xmum';
const TEST_PHONE_PREFIX = '01666666';
const TEST_NAME = '🤖压测';
const TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const findings = [];
const created = [];
function log(tag, msg) {
  findings.push({ tag, msg });
  console.log(`[${tag}] ${msg}`);
}
async function snap(p, n) { try { await p.screenshot({ path: path.join(OUT, n), fullPage: true }); } catch(_) {} }

(async () => {
  const targets = [
    { name: 'iOS-xmum', engine: webkit, device: devices['iPhone 14'], suffix: '63' },
    { name: 'Android-xmum', engine: chromium, device: devices['Pixel 7'], suffix: '64' },
  ];
  for (const t of targets) {
    const phone = TEST_PHONE_PREFIX + t.suffix;
    console.log(`\n--- ${t.name} · prod xmum (phone=${phone}) ---`);
    const browser = await t.engine.launch({ headless: true });
    const ctx = await browser.newContext({ ...t.device });
    // ⚠ addInitScript 只接受 1 个 arg，多传的会被丢
    await ctx.addInitScript(({ profile, hub }) => {
      localStorage.setItem('canteen_hub_v1', hub);
      localStorage.setItem('canteen_profile_v4', JSON.stringify(profile));
    }, {
      profile: {
        name: TEST_NAME, phone,
        addresses: [{ id: 'a1', label: '默认地址', building: 'LY5', room: 'PW', isDefault: true }]
      },
      hub: HUB
    });

    const p = await ctx.newPage();
    const errs = [];
    p.on('pageerror', e => errs.push('PE: ' + e.message.split('\n')[0]));
    p.on('console', m => { if (m.type() === 'error') errs.push('CE: ' + m.text().slice(0, 100)); });

    let orderId = null;
    try {
      // PROD home
      await p.goto(PROD_BASE + PROD_PATH, { waitUntil: 'domcontentloaded', timeout: 30000 });
      // PROD 真 API 第一次加载 + worker cold start 偶发 ~5-7s
      // 不能用 .empty 探测，因为 .empty 在加载未完成时就显示（real UX bug, 见 finding）
      await p.waitForSelector('.shop-card', { timeout: 15000 }).catch(() => {});
      await p.waitForTimeout(500);
      await snap(p, `s2v2-${t.name}-01-home.png`);

      const shops = await p.locator('.shop-card').count();
      log(t.name, `prod home: ${shops} shop(s) in ${HUB} hub`);
      if (shops === 0) {
        log(t.name + '-FAIL', 'prod home empty');
        await browser.close(); continue;
      }

      // Open Kat 试营业
      await p.locator('.shop-card').first().click();
      await p.waitForTimeout(2500);
      await snap(p, `s2v2-${t.name}-02-menu.png`);

      const dishes = await p.locator('.dish').count();
      log(t.name, `menu: ${dishes} dishes`);
      if (dishes === 0) {
        log(t.name + '-WARN', 'menu empty — vendor has no items');
        await browser.close(); continue;
      }

      // 加入 the first simple-add item (skip 选规格)
      const addBtn = p.locator('button:has-text("加入")').first();
      if (!(await addBtn.isVisible().catch(() => false))) {
        log(t.name + '-WARN', 'no simple "加入" — all items have 选规格');
        // Try 选规格 flow
        const optBtn = p.locator('button:has-text("选规格")').first();
        if (await optBtn.isVisible().catch(() => false)) {
          await optBtn.click();
          await p.waitForTimeout(600);
          // Confirm with defaults
          await p.locator('button:has-text("加入购物车")').first().click();
          await p.waitForTimeout(500);
          log(t.name, 'added via 选规格 with defaults');
        }
      } else {
        await addBtn.click();
        await p.waitForTimeout(400);
        log(t.name, 'added via 加入');
      }

      // Checkout
      await p.locator('button:has-text("去结算")').first().click();
      await p.waitForTimeout(2000);
      await snap(p, `s2v2-${t.name}-03-checkout.png`);

      // Upload screenshot
      const fileIn = p.locator('input[type="file"]').first();
      await fileIn.waitFor({ state: 'attached', timeout: 8000 });
      await fileIn.setInputFiles({ name: 'pw.png', mimeType: 'image/png', buffer: TINY });
      await p.waitForTimeout(800);

      const submit = p.locator('button.btn--primary.btn--block').last();
      await p.waitForFunction(() => {
        const bs = document.querySelectorAll('button.btn--primary.btn--block');
        const b = bs[bs.length - 1]; return b && !b.disabled;
      }, { timeout: 10000 });
      await submit.click();
      await p.waitForTimeout(3000); // wait for placeOrder

      orderId = await p.evaluate(() => window.store && window.store.activeOrder && window.store.activeOrder.id);
      log(t.name, `order placed → ${orderId || 'NO ID'}`);
      if (orderId) created.push({ device: t.name, phone, orderId });
      await snap(p, `s2v2-${t.name}-04-status.png`);

      // CANCEL immediately
      p.once('dialog', d => d.accept());
      const cancelBtn = p.locator('button:has-text("取消订单")').first();
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
        await p.waitForTimeout(3000);
        await snap(p, `s2v2-${t.name}-05-cancelled.png`);
        const cancelled = await p.evaluate((id) => {
          if (!window.store) return false;
          const o = window.store.state.orders.find(o => o.id === id);
          return o && o.status === 'cancelled';
        }, orderId);
        log(t.name, `cancel succeeded: ${cancelled}`);
      } else {
        log(t.name + '-WARN', 'no cancel button — likely already approved/started');
      }
    } catch (e) {
      log(t.name + '-FAIL', e.message.split('\n')[0]);
    }

    // Console errors (suppress benign push/SW noise; flag real ones)
    if (errs.length) {
      const uniq = [...new Set(errs)];
      uniq.slice(0, 5).forEach(e => log(t.name + '-CONSOLE', e));
    }
    await browser.close();
  }

  // Save results
  fs.writeFileSync(path.join(OUT, 'prod-orders-v2.json'),
    JSON.stringify({ created, findings }, null, 2));
  console.log('\n========== CREATED ORDERS (need cleanup) ==========');
  created.forEach(o => console.log(`  • ${o.device}  phone=${o.phone}  orderId=${o.orderId}`));
  if (!created.length) console.log('  (none — see findings for why)');
})();
