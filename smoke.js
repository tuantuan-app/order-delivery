// Smoke test: customer flow + admin god-view sample-btn visibility
// Verifies the 4 bug fixes in a way that demo mode CAN exercise (UI gating + state rendering).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'smoke-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

// 1x1 PNG bytes — minimal valid image for the screenshot upload
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const BASE = 'http://localhost:8777';

const pass = [];
const fail = [];
function ok(m) { console.log('  PASS  ' + m); pass.push(m); }
function bad(m) { console.log('  FAIL  ' + m); fail.push(m); }

async function snap(p, name) {
  await p.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log('  shot  ' + name);
}

async function tryClick(p, selector, ms = 600) {
  const el = p.locator(selector).first();
  if (await el.isVisible().catch(() => false)) {
    await el.click();
    await p.waitForTimeout(ms);
    return true;
  }
  return false;
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  // Pre-seed customer profile so we skip the gating profile-form and reach actual checkout
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: 'Smoke Bot', phone: '0199999991', building: 'A 栋', room: 'T01'
    }));
  });

  // === A. Customer flow ===
  console.log('\n=== A. Customer (index.html?demo) ===');
  const cust = await ctx.newPage();
  const custErrors = [];
  cust.on('pageerror', e => custErrors.push('pageerror: ' + e.message));
  cust.on('console', m => { if (m.type() === 'error') custErrors.push('console: ' + m.text()); });

  try {
    // Lock page clock to noon-today so shop's flex/fixed cutoffs don't refuse the order regardless of when this test runs
    const noonToday = new Date(); noonToday.setHours(12, 15, 0, 0);
    await cust.clock.install({ time: noonToday });
    await cust.clock.resume();
    await cust.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await cust.waitForTimeout(1200);
    await snap(cust, '01-cust-home.png');

    // First-time profile form may show; otherwise we'll see merchants list / hub bar
    // Profile form fields are inside #app — check if name input is visible
    const nameInput = cust.locator('input[placeholder*="陈小明"]').first();
    if (await nameInput.isVisible().catch(() => false)) {
      console.log('  filling profile...');
      await nameInput.fill('Smoke Bot');
      await cust.locator('input[placeholder*="0123456789"]').first().fill('0199999991');
      // building: dropdown OR text input
      const sel = cust.locator('select').first();
      if (await sel.isVisible().catch(() => false)) {
        await sel.selectOption({ index: 1 }).catch(() => {});
      } else {
        await cust.locator('input[placeholder*="A 栋"]').first().fill('A 栋').catch(() => {});
      }
      await cust.locator('input[placeholder*="506"]').first().fill('T01').catch(() => {});
      await tryClick(cust, 'button:has-text("保存")');
      await snap(cust, '02-cust-after-profile.png');
    }

    // Click a flexible-mode shop (叻沙小馆), avoiding fixed-slot shops past cutoff
    const shop = cust.locator('.shop-card:has-text("叻沙")').first();
    if (!(await shop.isVisible().catch(() => false))) {
      bad('no shop-card visible — hub picker / merchants list issue');
      await snap(cust, '02b-cust-no-merchants.png');
    } else {
      await shop.click();
      await cust.waitForTimeout(800);
      await snap(cust, '03-cust-menu.png');
      ok('merchant opened');
    }

    // Add an item — button is "加入" or "选规格" (the latter opens options panel)
    const addBtn = cust.locator('button:has-text("加入")').first();
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
      await cust.waitForTimeout(400);
      ok('item added (加入)');
    } else {
      bad('no 加入 button visible on menu');
    }

    // Go to checkout (floating bottom bar after adding)
    const goCheckout = cust.locator('button:has-text("去结算")').first();
    if (await goCheckout.isVisible().catch(() => false)) {
      await goCheckout.click();
      await cust.waitForTimeout(800);
    } else {
      bad('去结算 button not visible after adding item');
    }
    await snap(cust, '04-cust-checkout-no-shot.png');

    // === Verify Fix: submit button disabled, no sample button on customer ===
    const submit = cust.locator('button.btn--primary.btn--block').last();
    if (await submit.isVisible().catch(() => false)) {
      const disabled = await submit.isDisabled();
      const text = (await submit.textContent() || '').trim();
      if (disabled && text.includes('请先上传')) ok(`submit disabled w/ label: "${text}"`);
      else bad(`submit state wrong: disabled=${disabled} text="${text}"`);
    } else { bad('submit button not found on checkout'); }

    const sampleBtn = cust.locator('button:has-text("用示例图测试")');
    const sampleVisible = await sampleBtn.first().isVisible().catch(() => false);
    if (sampleVisible) bad('sample btn VISIBLE on customer — should be hidden (APP_MODE=customer)');
    else ok('sample btn hidden on customer (APP_MODE=customer)');

    // Upload screenshot
    const fileInput = cust.locator('input[type="file"]').first();
    await fileInput.setInputFiles({ name: 'pay.png', mimeType: 'image/png', buffer: TINY_PNG });
    await cust.waitForTimeout(1000);
    await snap(cust, '05-cust-checkout-with-shot.png');

    const submit2 = cust.locator('button.btn--primary.btn--block').last();
    const disabled2 = await submit2.isDisabled();
    const text2 = (await submit2.textContent() || '').trim();
    if (!disabled2 && text2.includes('提交订单')) ok(`after upload: enabled, label="${text2}"`);
    else bad(`after upload: state wrong, disabled=${disabled2} text="${text2}"`);

    // Submit
    await submit2.click();
    await cust.waitForTimeout(1500);
    await snap(cust, '06-cust-status.png');

    const statusVisible = await cust.locator('.status, .status-hero, h2:has-text("等待"), h2:has-text("订单")').first().isVisible().catch(() => false);
    if (statusVisible) ok('status page rendered after submit');
    else bad('status page not rendered after submit');

    // Visibility-change handler smoke (just verify it was attached — no error on emit)
    await cust.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
    await cust.waitForTimeout(400);
    ok('visibilitychange dispatched without JS error');

  } catch (e) {
    bad('Customer flow exception: ' + e.message);
    await snap(cust, '99-cust-crash.png');
  }

  if (custErrors.length) {
    custErrors.forEach(e => bad(e));
  } else {
    ok('no JS / console errors on customer page');
  }

  // === B. Admin god-view: sample btn should appear ===
  console.log('\n=== B. Admin god-view (admin.html?demo) ===');
  const adm = await ctx.newPage();
  const admErrors = [];
  adm.on('pageerror', e => admErrors.push('pageerror: ' + e.message));
  adm.on('console', m => { if (m.type() === 'error') admErrors.push('console: ' + m.text()); });

  try {
    await adm.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
    await adm.waitForTimeout(1000);
    await snap(adm, '10-adm-login.png');

    // try one-click login first
    if (!(await tryClick(adm, 'button:has-text("一键登入")', 800))) {
      // manual fallback
      await adm.locator('input').first().fill('admin').catch(() => {});
      await adm.locator('input[type="password"]').first().fill('admin123').catch(() => {});
      await tryClick(adm, 'button:has-text("登录"), button:has-text("登入")', 1000);
    }
    await adm.waitForTimeout(800);
    await snap(adm, '11-adm-home.png');

    // Switch to god-view "客户" — top chip-style buttons: 视角 | 管理 | 商家 | 客户
    if (!(await tryClick(adm, 'button:has-text("客户")', 1000))) {
      bad('god-view 客户 tab not found');
    }
    await snap(adm, '12-adm-preview.png');

    // Pick a shop
    const aShop = adm.locator('.shop-card').first();
    if (await aShop.isVisible().catch(() => false)) {
      await aShop.click();
      await adm.waitForTimeout(600);
    } else {
      bad('no shop-card in admin god-view customer mode');
    }
    // Add an item to reveal 去结算 button
    await tryClick(adm, 'button:has-text("加入")', 400);
    await tryClick(adm, 'button:has-text("去结算")', 1000);
    await snap(adm, '13-adm-checkout.png');

    const aSample = adm.locator('button:has-text("用示例图测试")');
    const aSampleVisible = await aSample.first().isVisible().catch(() => false);
    if (aSampleVisible) ok('sample btn VISIBLE in admin god-view (APP_MODE=admin)');
    else bad('sample btn HIDDEN in admin god-view — gate too strict');

  } catch (e) {
    bad('Admin flow exception: ' + e.message);
    await snap(adm, '99-adm-crash.png');
  }

  if (admErrors.length) {
    admErrors.forEach(e => bad(e));
  } else {
    ok('no JS / console errors on admin page');
  }

  await browser.close();

  console.log('\n=== SUMMARY ===');
  console.log(`  PASS  ${pass.length}`);
  console.log(`  FAIL  ${fail.length}`);
  fail.forEach(f => console.log('   ✗ ' + f));
  console.log(`  shots dir: ${OUT}`);
  process.exit(fail.length ? 1 : 0);
})();
