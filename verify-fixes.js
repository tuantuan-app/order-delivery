// verify-fixes.js — confirm Fix 2 (tabbar on terminal state) + Fix 3 (multi-required option validation)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'verify-user-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
const BASE = 'http://localhost:8777';
const TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

async function snap(p, n) { await p.screenshot({ path: path.join(OUT, n), fullPage: true }); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_hub_v1', 'utm');
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '测试顾客', phone: '0199999990', building: 'A 栋', room: 'T01'
    }));
  });

  // ======== FIX 2: tabbar on cancelled/rejected/delivered ========
  console.log('\n--- Fix 2: tabbar on terminal-state status page ---');
  const p = await ctx.newPage();
  await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1200);
  // Go through to status=pending then cancel
  await p.locator('.shop-card:not(.shop-card--closed)').first().click();
  await p.waitForTimeout(500);
  await p.locator('button:has-text("加入")').first().click();
  await p.waitForTimeout(300);
  await p.locator('button:has-text("去结算")').first().click();
  await p.waitForTimeout(500);
  await p.locator('input[type="file"]').first().setInputFiles({ name: 'pay.png', mimeType: 'image/png', buffer: TINY });
  await p.waitForTimeout(500);
  await p.locator('button.btn--primary.btn--block').last().click();
  await p.waitForTimeout(1200);
  // On status=pending: tabbar should be HIDDEN (focus on flow)
  const pendingNav = await p.locator('.tabbar').isVisible().catch(() => false);
  console.log(`[Fix2] pending state: tabbar visible=${pendingNav} (expected false)`);
  // Cancel
  p.once('dialog', d => d.accept());
  await p.locator('button:has-text("取消订单")').first().click();
  await p.waitForTimeout(700);
  await snap(p, 'FIX2-cancelled-with-tabbar.png');
  const cancelledNav = await p.locator('.tabbar').isVisible().catch(() => false);
  const cancelTitle = (await p.locator('.status-rejected__title').first().textContent().catch(() => '') || '').trim();
  console.log(`[Fix2] cancelled state: tabbar visible=${cancelledNav} title="${cancelTitle}" (expected tabbar=true)`);
  // Verify can click 订单 tab now
  if (cancelledNav) {
    await p.locator('.tabbar button:has-text("订单")').click();
    await p.waitForTimeout(400);
    const cards = await p.locator('.order-card').count();
    console.log(`[Fix2] tabbar→订单 from cancelled: ${cards} order card(s)`);
  }
  await p.close();

  // ======== FIX 3: multi-required option validation ========
  console.log('\n--- Fix 3: multi-required option group validation ---');
  // Fresh context — avoid bleed from p1's active orderId
  const ctx2 = await browser.newContext({ viewport: { width: 414, height: 896 } });
  await ctx2.addInitScript(() => {
    localStorage.setItem('canteen_hub_v1', 'utm');
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '测试顾客', phone: '0199999990', building: 'A 栋', room: 'T01'
    }));
  });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
  await p2.waitForTimeout(1200);
  await p2.locator('.shop-card:not(.shop-card--closed)').first().click();
  await p2.waitForTimeout(500);
  // Mutate the 招牌鸡扒饭 item so its multi group is required (no defaults).
  // Menu lives on each merchant: store.state.merchants[i].menu — NOT store.state.menu.
  const mutated = await p2.evaluate(() => {
    const ms = window.store && window.store.state && window.store.state.merchants;
    if (!ms) return 'no merchants';
    for (const m of ms) {
      const t = (m.menu || []).find(it => it.name === '招牌鸡扒饭');
      if (t && t.optionGroups) {
        const g2 = t.optionGroups.find(g => g.type === 'multi');
        if (g2) { g2.required = true; g2.min = 1; return 'mutated ' + m.name; }
      }
    }
    return 'not found';
  });
  console.log(`[Fix3] mutation: ${mutated}`);
  await p2.waitForTimeout(300);
  await p2.locator('button:has-text("选规格")').first().click();
  await p2.waitForTimeout(500);
  await snap(p2, 'FIX3-sheet-required-multi.png');
  // Inspect confirm button
  const confirmBtn = p2.locator('button.sheet__add').first();
  const dis1 = await confirmBtn.isDisabled();
  console.log(`[Fix3] sheet opened with multi-required + 0 selected: confirm disabled=${dis1} (expected true)`);
  // Pick one option from multi group → should enable
  const multiOpts = await p2.locator('.opt-group').last().locator('.opt-row').all();
  if (multiOpts.length) {
    await multiOpts[0].click();
    await p2.waitForTimeout(200);
    const dis2 = await confirmBtn.isDisabled();
    console.log(`[Fix3] after picking 1 option: confirm disabled=${dis2} (expected false)`);
    await snap(p2, 'FIX3-after-pick.png');
    // Unpick → should re-disable
    await multiOpts[0].click();
    await p2.waitForTimeout(200);
    const dis3 = await confirmBtn.isDisabled();
    console.log(`[Fix3] after unpicking: confirm disabled=${dis3} (expected true)`);
    // Try clicking confirm anyway with 0 selected — should show error
    const enabled = !(await confirmBtn.isDisabled());
    if (enabled) {
      console.log('[Fix3] WARN — confirm enabled with 0 selected, click would slip through');
    } else {
      console.log('[Fix3] confirm hard-disabled; OK');
    }
  }
  await p2.close();

  await browser.close();
  console.log('\nDONE');
})().catch(e => { console.error('FATAL', e); process.exit(1); });
