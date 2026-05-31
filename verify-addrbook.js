// Verify address-book: legacy migration + add/edit/delete/default + checkout switcher
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  // Pre-seed LEGACY profile to test migration
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '迁移测试', phone: '0199999991', building: 'A 栋', room: 'T01'  // legacy fields
    }));
  });
  const cust = await ctx.newPage();
  const errors = [];
  cust.on('pageerror', e => errors.push('JS: ' + e.message));
  cust.on('console', m => { if (m.type() === 'error') errors.push('Con: ' + m.text()); });
  const noon = new Date(); noon.setHours(12, 15, 0, 0);
  await cust.clock.install({ time: noon });
  await cust.clock.resume();
  await cust.goto('http://localhost:8777/index.html?demo', { waitUntil: 'domcontentloaded' });
  await cust.waitForTimeout(1000);

  // 1. Verify legacy → migrated structure
  const migrated = await cust.evaluate(() => {
    const p = window.store.profile;
    return { hasAddresses: Array.isArray(p && p.addresses), count: p && p.addresses && p.addresses.length, building: p && p.addresses && p.addresses[0] && p.addresses[0].building, isDefault: p && p.addresses && p.addresses[0] && p.addresses[0].isDefault };
  });
  console.log('migration:', JSON.stringify(migrated), '(expected: {hasAddresses:true, count:1, building:"A 栋", isDefault:true})');

  // 2. Navigate to "我的" tab
  await cust.locator('.tabbar button:has-text("我的")').click();
  await cust.waitForTimeout(500);
  await cust.screenshot({ path: path.join(__dirname, 'smoke-shots', 'Y1-me-tab-addrbook.png'), fullPage: true });
  const addrbookHeader = await cust.locator('.addrbook__head').textContent().catch(() => '');
  console.log('addrbook header:', addrbookHeader);

  // 3. Add a 2nd address
  await cust.locator('button:has-text("+ 新增")').click();
  await cust.waitForTimeout(400);
  await cust.locator('input[placeholder*="家"]').first().fill('办公室');
  await cust.locator('input[placeholder*="A 栋"]').first().fill('C 栋');
  await cust.locator('input[placeholder*="506"]').first().fill('Office-12');
  await cust.locator('.modal button:has-text("保存")').click();
  await cust.waitForTimeout(400);
  await cust.screenshot({ path: path.join(__dirname, 'smoke-shots', 'Y2-after-add.png'), fullPage: true });
  const count2 = await cust.locator('.addr-row').count();
  console.log(`addresses after add: ${count2} (expected: 2)`);

  // 4. Set 2nd as default
  await cust.locator('button:has-text("设为默认")').first().click();
  await cust.waitForTimeout(300);
  await cust.screenshot({ path: path.join(__dirname, 'smoke-shots', 'Y3-set-default.png'), fullPage: true });
  const defaultIdx = await cust.evaluate(() => window.store.profile.addresses.findIndex(a => a.isDefault));
  console.log(`default index: ${defaultIdx} (expected: 1, the new 办公室)`);

  // 5. Go to a shop and verify checkout shows new default address
  await cust.locator('.tabbar button:has-text("首页")').click();
  await cust.waitForTimeout(400);
  await cust.locator('.shop-card:has-text("叻沙")').first().click();
  await cust.waitForTimeout(500);
  await cust.locator('button:has-text("加入")').first().click();
  await cust.waitForTimeout(300);
  await cust.locator('button:has-text("去结算")').first().click();
  await cust.waitForTimeout(700);
  await cust.screenshot({ path: path.join(__dirname, 'smoke-shots', 'Y4-checkout-with-default.png'), fullPage: true });
  const coAddrTxt = await cust.locator('.co-addr__where').textContent().catch(() => '');
  console.log(`checkout shows: "${coAddrTxt.trim()}" (expected to contain 办公室 + C 栋 + Office-12)`);

  // 6. Click co-addr → picker opens (since 2 addresses)
  await cust.locator('.co-addr').click();
  await cust.waitForTimeout(400);
  await cust.screenshot({ path: path.join(__dirname, 'smoke-shots', 'Y5-picker-open.png'), fullPage: true });
  const pickerOpen = await cust.locator('.addr-pick').first().isVisible().catch(() => false);
  console.log(`picker opened: ${pickerOpen} (expected: true)`);

  // 7. Pick the FIRST (default address) → verify switch
  if (pickerOpen) {
    await cust.locator('.addr-pick').first().click();
    await cust.waitForTimeout(400);
    const coAddrTxt2 = await cust.locator('.co-addr__where').textContent().catch(() => '');
    console.log(`after pick first: "${coAddrTxt2.trim()}" (expected to contain A 栋 + T01)`);
    await cust.screenshot({ path: path.join(__dirname, 'smoke-shots', 'Y6-after-pick.png'), fullPage: true });
  }

  await browser.close();
  console.log(`\nJS errors: ${errors.length}`);
  errors.forEach(e => console.log('  ' + e));
})();
