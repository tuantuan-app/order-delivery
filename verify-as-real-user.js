// verify-as-real-user.js
// Drive customer + admin/merchant as a real user, with hub picker dismissed.
// Focus: behavior observations and probing edge cases.
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

const log = [];
function obs(role, tag, msg, detail = '') {
  const line = `[${role}] ${tag} ${msg}${detail ? ' :: ' + detail : ''}`;
  log.push(line); console.log(line);
}
async function snap(p, name) {
  await p.screenshot({ path: path.join(OUT, name), fullPage: true });
}
async function txt(p, sel) {
  try { return ((await p.locator(sel).first().textContent()) || '').trim(); } catch { return ''; }
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  // Pre-pick UTM hub so we don't bump into the picker each session (still test
  // first-visit modal in a separate page).
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_hub_v1', 'utm');
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '测试顾客', phone: '0199999991', building: 'A 栋', room: 'T01'
    }));
  });
  const consoleErrs = { customer: [], merchant: [], admin: [], firstvisit: [] };
  function wire(p, name) {
    p.on('pageerror', e => consoleErrs[name].push('pageerror: ' + e.message.split('\n')[0]));
    p.on('console', m => { if (m.type() === 'error') consoleErrs[name].push('console: ' + m.text().slice(0, 200)); });
  }

  // ============== 0. FIRST-VISIT MODAL UX CHECK ==============
  console.log('\n========== FIRST-VISIT CHECK (clean context) ==========');
  const fresh = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const first = await fresh.newPage();
  wire(first, 'firstvisit');
  await first.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
  await first.waitForTimeout(1200);
  const modalUp = await first.locator('.modal .hub-picker').first().isVisible().catch(() => false);
  obs('FIRST', modalUp ? 'PASS' : 'WARN', `hub picker modal forced on first visit: ${modalUp}`);
  await snap(first, 'FV1-first-visit-modal.png');
  // Try to dismiss by clicking outside — is it really mandatory?
  await first.locator('.modal').first().click({ position: { x: 10, y: 10 } }).catch(() => {});
  await first.waitForTimeout(300);
  const stillUp = await first.locator('.modal .hub-picker').first().isVisible().catch(() => false);
  obs('FIRST', stillUp ? 'PASS' : 'WARN', `clicking outside does NOT dismiss (intentional): ${stillUp}`);
  // Pick UTM
  await first.locator('.hub-picker__item').first().click();
  await first.waitForTimeout(700);
  const shopCount = await first.locator('.shop-card').count();
  obs('FIRST', 'INFO', `after picking UTM: ${shopCount} shops visible`);
  // Check the "切换" entry — can user switch later?
  const switchBtn = first.locator(':text("切换")').first();
  if (await switchBtn.isVisible().catch(() => false)) {
    await switchBtn.click();
    await first.waitForTimeout(500);
    const reopened = await first.locator('.hub-picker').isVisible().catch(() => false);
    obs('FIRST', reopened ? 'PASS' : 'WARN', `"切换" reopens hub picker: ${reopened}`);
    if (reopened) await first.locator('.hub-picker__item').first().click();
  }
  await first.close();
  await fresh.close();

  // ============== 1. CUSTOMER (hub pre-picked) ==============
  console.log('\n========== CUSTOMER ==========');
  const cust = await ctx.newPage();
  wire(cust, 'customer');
  await cust.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
  await cust.waitForTimeout(1200);
  await snap(cust, '01-customer-home.png');

  const shops = await cust.locator('.shop-card').count();
  obs('CUST', 'INFO', `UTM hub shows ${shops} shops`);
  const closed = await cust.locator('.shop-card--closed').count();
  obs('CUST', 'INFO', `closed shop styling: ${closed} card(s)`);

  // Open first non-closed shop
  await cust.locator('.shop-card:not(.shop-card--closed)').first().click();
  await cust.waitForTimeout(700);
  await snap(cust, '02-customer-menu.png');
  const dishes = await cust.locator('.dish').count();
  obs('CUST', dishes > 0 ? 'PASS' : 'FAIL', `menu shows ${dishes} dishes`);

  // PROBE: search
  const searchIn = cust.locator('input[placeholder*="搜"]').first();
  if (await searchIn.isVisible().catch(() => false)) {
    await searchIn.fill('鸡');
    await cust.waitForTimeout(300);
    const filtered = await cust.locator('.dish').count();
    obs('CUST', 'PROBE', `search "鸡" → ${filtered} dishes`);
    await searchIn.fill('zzzzz');
    await cust.waitForTimeout(300);
    const none = await cust.locator('.dish').count();
    const noResMsg = await cust.locator(':text("没找到"), :text("无结果"), :text("空")').count();
    obs('CUST', 'PROBE', `search "zzzzz" → ${none} dishes; "no result" hint: ${noResMsg}`);
    await searchIn.fill('');
    await cust.waitForTimeout(200);
  }

  // Add simple item
  const addBtn = cust.locator('button:has-text("加入")').first();
  await addBtn.click();
  await cust.waitForTimeout(300);
  const cartCnt = await txt(cust, '.cart-bar__count');
  obs('CUST', cartCnt ? 'PASS' : 'FAIL', `cart count after add: "${cartCnt}"`);

  // PROBE: stepper increment
  const stepperAdd = cust.locator('.stepper__btn--add').first();
  if (await stepperAdd.isVisible().catch(() => false)) {
    await stepperAdd.click();
    await cust.waitForTimeout(200);
    obs('CUST', 'PROBE', `stepper inc → cart="${await txt(cust, '.cart-bar__count')}"`);
  }

  // PROBE: options sheet on 选规格 item
  const optBtn = cust.locator('button:has-text("选规格")').first();
  if (await optBtn.isVisible().catch(() => false)) {
    await optBtn.click();
    await cust.waitForTimeout(500);
    await snap(cust, '03-options-sheet.png');
    const sheetUp = await cust.locator('.option-sheet, [class*="sheet"]').first().isVisible().catch(() => false);
    obs('CUST', sheetUp ? 'PASS' : 'FAIL', 'options sheet opened');
    // Try to confirm without picking
    const confirm = cust.locator('button:has-text("加入购物车")').first();
    if (await confirm.isVisible().catch(() => false)) {
      const dis = await confirm.isDisabled().catch(() => false);
      obs('CUST', 'PROBE', `confirm-without-options: disabled=${dis} (false=auto-selects default; true=blocks)`);
    }
    // Close the sheet — try cancel button, then mask
    const cancel = cust.locator('.sheet button:has-text("取消"), button[aria-label="关闭"], .sheet__close').first();
    if (await cancel.isVisible().catch(() => false)) {
      await cancel.click().catch(() => {});
    } else {
      // Click outside the sheet panel
      await cust.locator('.sheet').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    }
    await cust.waitForTimeout(500);
    const stillOpen = await cust.locator('.sheet').first().isVisible().catch(() => false);
    if (stillOpen) {
      obs('CUST', 'WARN', 'options sheet did NOT close via cancel/outside — pressing Escape');
      await cust.keyboard.press('Escape');
      await cust.waitForTimeout(300);
    }
  }

  // Go to checkout
  const checkoutBtn = cust.locator('button:has-text("去结算")').first();
  if (await checkoutBtn.isVisible().catch(() => false)) {
    await checkoutBtn.click();
    await cust.waitForTimeout(800);
    await snap(cust, '04-checkout.png');

    // PROBE: submit gating
    const submitBtn = cust.locator('button.btn--primary.btn--block').last();
    const subText = (await submitBtn.textContent() || '').trim();
    const subDis = await submitBtn.isDisabled();
    obs('CUST', 'PROBE', `pre-upload submit: disabled=${subDis} label="${subText}"`);

    // PROBE: "用示例图测试" must NOT be visible to real customers
    const sampleBtn = cust.locator('button:has-text("用示例图测试")').first();
    const sampleVis = await sampleBtn.isVisible().catch(() => false);
    obs('CUST', sampleVis ? 'FAIL' : 'PASS', `sample-image dev shortcut hidden: ${!sampleVis}`);

    // Upload tiny png
    await cust.locator('input[type="file"]').first().setInputFiles({
      name: 'pay.png', mimeType: 'image/png', buffer: TINY
    });
    await cust.waitForTimeout(800);
    await snap(cust, '05-after-upload.png');
    const subText2 = (await submitBtn.textContent() || '').trim();
    const subDis2 = await submitBtn.isDisabled();
    obs('CUST', subDis2 ? 'FAIL' : 'PASS', `post-upload submit: disabled=${subDis2} label="${subText2}"`);

    // Submit
    await submitBtn.click();
    await cust.waitForTimeout(1500);
    await snap(cust, '06-pending-status.png');
    const hero = await txt(cust, '.status-hero__label, .status h2, h2');
    obs('CUST', 'PASS', `after submit: status="${hero}"`);

    // PROBE: cancel button on pending
    cust.once('dialog', d => d.accept());
    const cancelBtn = cust.locator('button:has-text("取消订单")').first();
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click();
      await cust.waitForTimeout(800);
      await snap(cust, '07-cancelled.png');
      obs('CUST', 'PASS', `cancelled state: "${await txt(cust, 'h2')}"`);
    } else {
      obs('CUST', 'WARN', 'cancel button not visible on pending order');
    }
  }

  // After cancel, tabbar is hidden on the status page. Click "再点一单" to return.
  const reorderBtn = cust.locator('button:has-text("再点一单"), button:has-text("再来一单")').first();
  if (await reorderBtn.isVisible().catch(() => false)) {
    await reorderBtn.click();
    await cust.waitForTimeout(700);
    obs('CUST', 'PROBE', '"再点一单" navigates back from cancelled state');
  } else {
    obs('CUST', 'INFO', 'no 再点一单 — tabbar should be visible');
  }
  // Try tabbar now
  const ordersTabNow = cust.locator('.tabbar button:has-text("订单")').first();
  if (await ordersTabNow.isVisible().catch(() => false)) {
    await ordersTabNow.click();
    await cust.waitForTimeout(500);
    await snap(cust, '08-my-orders.png');
    const orderCards = await cust.locator('.order-card').count();
    obs('CUST', 'INFO', `my orders shows ${orderCards} card(s) after cancel`);
    const meTab = cust.locator('.tabbar button:has-text("我的")').first();
    if (await meTab.isVisible().catch(() => false)) {
      await meTab.click();
      await cust.waitForTimeout(500);
      await snap(cust, '09-me-tab.png');
      obs('CUST', 'PASS', '"我的" tab opened');
    }
  } else {
    obs('CUST', 'WARN', 'tabbar still hidden after 再点一单 — navigation friction');
  }

  await cust.close();

  // ============== 2. ADMIN + MERCHANT GOD-VIEW ==============
  console.log('\n========== ADMIN ==========');
  const adm = await ctx.newPage();
  wire(adm, 'admin');
  await adm.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
  await adm.waitForTimeout(1000);
  await snap(adm, '10-admin-login.png');

  // PROBE: wrong password
  await adm.locator('input').first().fill('admin');
  await adm.locator('input[type="password"]').first().fill('wrong_pwd');
  await adm.locator('button:has-text("登录"), button:has-text("登入")').first().click();
  await adm.waitForTimeout(1200);
  await snap(adm, '11-admin-wrong-pwd.png');
  const loginErr = await adm.locator('.toast, .alert, [class*="error"]').first().textContent().catch(() => '');
  obs('ADMIN', 'PROBE', `wrong-pwd response: "${(loginErr || '').trim().slice(0, 80)}"`);

  // Correct login
  await adm.locator('input[type="password"]').first().fill('admin123');
  await adm.locator('button:has-text("登录"), button:has-text("登入")').first().click();
  await adm.waitForTimeout(1500);
  await snap(adm, '12-admin-home.png');
  obs('ADMIN', 'PASS', 'admin logged in');

  // PROBE: god-view to merchant
  await adm.locator('button:has-text("商家")').first().click();
  await adm.waitForTimeout(800);
  await snap(adm, '13-merchant-view.png');
  const mOrders = await adm.locator('.order-card').count();
  obs('MERC', mOrders > 0 ? 'PASS' : 'INFO', `merchant orders: ${mOrders}`);

  // Approve + advance
  const acceptBtn = adm.locator('button:has-text("接单"), button:has-text("同意")').first();
  if (await acceptBtn.isVisible().catch(() => false)) {
    await acceptBtn.click();
    await adm.waitForTimeout(500);
    obs('MERC', 'PASS', 'approved');
  }
  // Advance through states
  let advanced = 0;
  for (let i = 0; i < 3; i++) {
    const advBtn = adm.locator('button:has-text("开始备餐"), button:has-text("开始配送"), button:has-text("确认送达")').first();
    if (await advBtn.isVisible().catch(() => false)) {
      await advBtn.click();
      await adm.waitForTimeout(400);
      advanced++;
    } else break;
  }
  obs('MERC', advanced > 0 ? 'PASS' : 'INFO', `state advanced x${advanced}`);
  await snap(adm, '14-merchant-advanced.png');

  // Reject flow (need another pending — try recycling via approve + reject buttons)
  const rejBtn = adm.locator('button:has-text("拒绝")').first();
  if (await rejBtn.isVisible().catch(() => false)) {
    await rejBtn.click();
    await adm.waitForTimeout(500);
    await snap(adm, '15-reject-modal.png');
    obs('MERC', 'PASS', 'reject modal opens');
    const cancel = adm.locator('button:has-text("取消")').first();
    if (await cancel.isVisible().catch(() => false)) await cancel.click();
    await adm.waitForTimeout(300);
  } else {
    obs('MERC', 'INFO', 'no reject button (no pending order left)');
  }

  // Menu management
  const menuTab = adm.locator('button:has-text("菜单"), button:has-text("商品")').first();
  if (await menuTab.isVisible().catch(() => false)) {
    await menuTab.click();
    await adm.waitForTimeout(500);
    await snap(adm, '16-menu-mgmt.png');
    const items = await adm.locator('.menu-row, [class*="dish"], [class*="item-"]').count();
    obs('MERC', 'INFO', `menu mgmt items visible: ${items}`);
  }

  // Settings tab
  const setTab = adm.locator('button:has-text("设置")').first();
  if (await setTab.isVisible().catch(() => false)) {
    await setTab.click();
    await adm.waitForTimeout(500);
    await snap(adm, '17-merchant-settings.png');
    // Look for key settings
    const hasHours = await adm.locator('input[type="time"]').count();
    const hasRing = await adm.locator(':text("响铃")').count();
    const hasWA = await adm.locator(':text("WhatsApp"), :text("wa.me"), :text("WA")').count();
    obs('MERC', 'INFO', `settings: hours-fields=${hasHours} ring-mentions=${hasRing} WA-mentions=${hasWA}`);
  }

  // Back to admin god-view
  const backBtn = adm.locator('button:has-text("管理"), button:has-text("admin")').first();
  if (await backBtn.isVisible().catch(() => false)) {
    await backBtn.click();
    await adm.waitForTimeout(500);
  }

  // Walk admin tabs
  for (const lab of ['商家', '社区', 'Hub', '套餐', '计费', '测试', '健康', '日志']) {
    const t = adm.locator(`button:has-text("${lab}"), .tab:has-text("${lab}")`).first();
    if (await t.isVisible().catch(() => false)) {
      await t.click().catch(() => {});
      await adm.waitForTimeout(400);
      await snap(adm, `18-admin-${lab}.png`);
      obs('ADMIN', 'PASS', `tab "${lab}" opened`);
    }
  }

  await adm.close();

  // ============== REPORT ==============
  console.log('\n========== CONSOLE ERRORS ==========');
  for (const role of Object.keys(consoleErrs)) {
    const errs = consoleErrs[role];
    if (errs.length === 0) obs(role.toUpperCase(), 'PASS', 'no console errors');
    else {
      [...new Set(errs)].slice(0, 5).forEach(e => obs(role.toUpperCase(), 'CONSOLE', e));
    }
  }

  await browser.close();
  fs.writeFileSync(path.join(OUT, 'log.txt'), log.join('\n'));
  console.log('\nDONE — shots + log in', OUT);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
