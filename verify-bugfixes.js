// verify-bugfixes.js — confirm each of the 4 bugs + 2 UX fixes work at the UI.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const OUT = path.join(__dirname, 'bugfix-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
const BASE = 'http://localhost:8777';
const TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);
async function snap(p, n) { await p.screenshot({ path: path.join(OUT, n), fullPage: true }); }

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ============== Bug 1: ProfileForm error clears when user types ==============
  console.log('\n--- Bug 1: ProfileForm error clears after user types ---');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await ctx.addInitScript(() => { localStorage.setItem('canteen_hub_v1', 'utm'); });
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click();
    await p.waitForTimeout(600);
    // Empty submit → error appears
    await p.locator('button:has-text("保存并继续")').first().click();
    await p.waitForTimeout(300);
    const errBefore = (await p.locator('.error').first().textContent().catch(() => '') || '').trim();
    console.log(`[Bug1] error after empty submit: "${errBefore}"`);
    // Type name → error should clear
    await p.locator('input[placeholder*="陈小明"]').first().fill('小明');
    await p.waitForTimeout(200);
    const errAfter = (await p.locator('.error').first().textContent().catch(() => '') || '').trim();
    const cleared = !errAfter;
    console.log(`[Bug1] error after typing name: "${errAfter}" → cleared=${cleared}`);
    await snap(p, 'bug1-error-cleared.png');
    console.log(cleared ? '✅ Bug 1 FIXED' : '❌ Bug 1 STILL BROKEN');
    await ctx.close();
  }

  // ============== Bug 3: Edit address modal pre-fills building ==============
  console.log('\n--- Bug 3: Building pre-fills on "修改" address modal ---');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    // Seed a profile in migrated addresses[] format (what saveProfile actually persists)
    await ctx.addInitScript(() => {
      localStorage.setItem('canteen_hub_v1', 'utm');
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: '小红', phone: '0199888777',
        addresses: [{ id: 'a1', label: '默认地址', building: 'A 栋', room: '301', isDefault: true }]
      }));
    });
    const p = await ctx.newPage();
    const noon = new Date(); noon.setHours(12, 30, 0, 0);
    await p.clock.install({ time: noon }); await p.clock.resume();
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click();
    await p.waitForTimeout(800);
    // The address card (.co-addr) opens the editingAddr modal when only 1 address exists.
    await p.locator('.co-addr').first().click();
    await p.waitForTimeout(500);
    await snap(p, 'bug3-address-modal-prefilled.png');
    // The modal embeds <profile-form> — building is a <select.cat-select>
    const selectVal = await p.locator('.modal select.cat-select').first().inputValue().catch(() => '');
    const roomVal = await p.locator('.modal input[placeholder*="506"]').first().inputValue().catch(() => '');
    const nameVal = await p.locator('.modal input[placeholder*="陈小明"]').first().inputValue().catch(() => '');
    console.log(`[Bug3] name="${nameVal}" select(building)="${selectVal}" room="${roomVal}"`);
    const ok = selectVal === 'A 栋' && roomVal === '301' && nameVal === '小红';
    console.log(ok ? '✅ Bug 3 FIXED' : '❌ Bug 3 STILL BROKEN');
    await ctx.close();
  }

  // ============== Bug 2: Toast disappears after cancel ==============
  console.log('\n--- Bug 2: Toast clears on cancel + backToMerchants ---');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('canteen_hub_v1', 'utm');
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: '小明', phone: '0199888776',
        addresses: [{ id: 'a1', label: '默认地址', building: 'A 栋', room: '301', isDefault: true }]
      }));
    });
    const p = await ctx.newPage();
    const noon = new Date(); noon.setHours(12, 30, 0, 0);
    await p.clock.install({ time: noon }); await p.clock.resume();
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click();
    await p.waitForTimeout(600);
    await p.locator('input[type="file"]').first().setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: TINY });
    await p.waitForTimeout(400);
    await p.locator('button.btn--primary.btn--block').last().click();
    await p.waitForTimeout(700);
    // Verify toast visible right after submit
    const toastBefore = await p.evaluate(() => window.store && window.store.toast && window.store.toast.visible);
    console.log(`[Bug2] toast visible right after submit: ${toastBefore} (expected true)`);
    // Cancel
    p.once('dialog', d => d.accept());
    await p.locator('button:has-text("取消订单")').first().click();
    await p.waitForTimeout(500);
    const toastAfterCancel = await p.evaluate(() => window.store && window.store.toast && window.store.toast.visible);
    console.log(`[Bug2] toast after cancel: visible=${toastAfterCancel} (expected false)`);
    await snap(p, 'bug2-toast-after-cancel.png');
    const ok = toastBefore === true && toastAfterCancel === false;
    console.log(ok ? '✅ Bug 2 FIXED' : '❌ Bug 2 STILL BROKEN');
    await ctx.close();
  }

  // ============== Bug 4: cust-page has enough padding-bottom ==============
  console.log('\n--- Bug 4: Bottom content not covered by tabbar ---');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('canteen_hub_v1', 'utm');
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: '小明', phone: '0199888777',
        addresses: [{ id: 'a1', label: '默认地址', building: 'A 栋', room: '301', isDefault: true }]
      }));
    });
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    // Go to "我的" tab
    await p.locator('.tabbar button:has-text("我的")').first().click();
    await p.waitForTimeout(500);
    // Scroll to the very bottom
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await p.waitForTimeout(400);
    await snap(p, 'bug4-me-tab-bottom.png');
    // Check that .cust-page has padding-bottom >= 80
    const pad = await p.evaluate(() => {
      const el = document.querySelector('.cust-page');
      if (!el) return null;
      return parseInt(getComputedStyle(el).paddingBottom, 10);
    });
    console.log(`[Bug4] .cust-page padding-bottom: ${pad}px (expected >= 80)`);
    const ok = pad != null && pad >= 80;
    console.log(ok ? '✅ Bug 4 FIXED' : '❌ Bug 4 STILL BROKEN');
    await ctx.close();
  }

  // ============== UX#5: Shake animation on hub picker backdrop click ==============
  console.log('\n--- UX#5: Hub picker shakes on outside click ---');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    // No hub seeded — picker should show
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1200);
    const modalUp = await p.locator('.modal .hub-picker').first().isVisible().catch(() => false);
    console.log(`[UX5] hub picker visible: ${modalUp}`);
    // Click backdrop above the picker panel. The hub-picker modal uses align-items:flex-end,
    // so panel is at bottom — click upper area at y=200 (below appbar, above panel).
    await p.locator('.modal').first().click({ position: { x: 200, y: 200 }, force: true });
    await p.waitForTimeout(80);
    const shaking = await p.locator('.hub-picker--shake').first().isVisible().catch(() => false);
    console.log(`[UX5] shake class applied right after backdrop click: ${shaking}`);
    await snap(p, 'ux5-shake-applied.png');
    // After ~500ms it should clear
    await p.waitForTimeout(550);
    const shakingAfter = await p.locator('.hub-picker--shake').first().isVisible().catch(() => false);
    console.log(`[UX5] shake class auto-cleared after ~500ms: ${!shakingAfter}`);
    const ok = modalUp && shaking && !shakingAfter;
    console.log(ok ? '✅ UX#5 FIXED' : '❌ UX#5 STILL BROKEN');
    await ctx.close();
  }

  // ============== UX#10: Back button on terminal-state status page ==============
  console.log('\n--- UX#10: Back button on cancelled order (terminal state) ---');
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await ctx.addInitScript(() => {
      localStorage.setItem('canteen_hub_v1', 'utm');
      localStorage.setItem('canteen_profile_v4', JSON.stringify({
        name: '小明', phone: '0199888778',
        addresses: [{ id: 'a1', label: '默认地址', building: 'A 栋', room: '301', isDefault: true }]
      }));
    });
    const p = await ctx.newPage();
    const noon = new Date(); noon.setHours(12, 30, 0, 0);
    await p.clock.install({ time: noon }); await p.clock.resume();
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(1000);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click();
    await p.waitForTimeout(600);
    await p.locator('input[type="file"]').first().setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: TINY });
    await p.waitForTimeout(400);
    await p.locator('button.btn--primary.btn--block').last().click();
    await p.waitForTimeout(800);
    // Pending: back button should NOT be visible
    const backOnPending = await p.locator('.status__back').first().isVisible().catch(() => false);
    console.log(`[UX10] back button on PENDING: visible=${backOnPending} (expected false — still tracking)`);
    // Cancel
    p.once('dialog', d => d.accept());
    await p.locator('button:has-text("取消订单")').first().click();
    await p.waitForTimeout(700);
    // Cancelled: back button SHOULD be visible
    const backOnCancelled = await p.locator('.status__back').first().isVisible().catch(() => false);
    console.log(`[UX10] back button on CANCELLED: visible=${backOnCancelled} (expected true)`);
    await snap(p, 'ux10-back-on-cancelled.png');
    // Click it → should land on orders tab
    if (backOnCancelled) {
      await p.locator('.status__back').first().click();
      await p.waitForTimeout(500);
      const orderCards = await p.locator('.order-card').count();
      const activeTab = await p.locator('.tabbar button.active').first().textContent();
      console.log(`[UX10] after click: orders tab "${(activeTab || '').trim()}" with ${orderCards} card(s)`);
      const ok = !backOnPending && backOnCancelled && orderCards >= 1;
      console.log(ok ? '✅ UX#10 FIXED' : '❌ UX#10 STILL BROKEN');
    }
    await ctx.close();
  }

  await browser.close();
  console.log('\nDone — shots in', OUT);
})();
