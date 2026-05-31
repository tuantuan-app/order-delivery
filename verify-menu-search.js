// Verify menu-search feature
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const OUT = path.join(__dirname, 'smoke-shots');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '搜索测试', phone: '0199999991', building: 'A 栋', room: 'T01'
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
  await cust.waitForTimeout(800);

  // open the shop with most items (阿强快餐)
  await cust.locator('.shop-card:has-text("阿强")').first().click();
  await cust.waitForTimeout(600);

  // Inspect menu count + search box visibility
  const menuCount = await cust.evaluate(() => window.store.studentMerchant.menu.length);
  console.log('menu items: ' + menuCount);
  const searchBox = cust.locator('.menu-search__in');
  const sbVisible = await searchBox.isVisible().catch(() => false);
  console.log(`search box visible: ${sbVisible} (expected: ${menuCount > 4})`);
  await cust.screenshot({ path: path.join(OUT, 'X1-menu-default.png'), fullPage: true });

  if (!sbVisible) { console.log('FAIL: search box not rendered'); await browser.close(); process.exit(1); }

  // type a query that should match (鸡)
  await searchBox.fill('鸡');
  await cust.waitForTimeout(300);
  await cust.screenshot({ path: path.join(OUT, 'X2-menu-search-chicken.png'), fullPage: true });
  const dishesAfter = await cust.locator('.dish').count();
  console.log(`after search "鸡": ${dishesAfter} dish(es) visible`);
  // category bar should be hidden during search
  const catBar = await cust.locator('.cat-bar').isVisible().catch(() => false);
  console.log(`cat-bar visible during search: ${catBar} (expected: false)`);

  // type a query that should NOT match
  await searchBox.fill('zzzz_nothing');
  await cust.waitForTimeout(300);
  await cust.screenshot({ path: path.join(OUT, 'X3-menu-search-empty.png'), fullPage: true });
  const emptyState = cust.locator('.menu-empty');
  const emptyVisible = await emptyState.isVisible().catch(() => false);
  console.log(`empty state visible for unknown query: ${emptyVisible} (expected: true)`);

  // clear
  await cust.locator('.menu-search__clr').click();
  await cust.waitForTimeout(300);
  const sbVal = await searchBox.inputValue();
  console.log(`after clear: input value = "${sbVal}" (expected: "")`);
  const catAfterClear = await cust.locator('.cat-bar').isVisible().catch(() => false);
  console.log(`cat-bar back after clear: ${catAfterClear} (expected: true)`);

  // Search by option name (规格), e.g. "辣" should match items with spicy option
  await searchBox.fill('辣');
  await cust.waitForTimeout(300);
  const dishesSpicy = await cust.locator('.dish').count();
  console.log(`after search "辣": ${dishesSpicy} dish(es) visible (any match name/desc/option)`);
  await cust.screenshot({ path: path.join(OUT, 'X4-menu-search-spicy.png'), fullPage: true });

  // Also verify on a shop with <=4 items (should NOT show search)
  await cust.locator('button:has-text("‹")').first().click();
  await cust.waitForTimeout(500);
  await cust.locator('.shop-card:has-text("深夜")').first().click();
  await cust.waitForTimeout(500);
  const smallMenuCount = await cust.evaluate(() => window.store.studentMerchant.menu.length);
  const sbOnSmall = await cust.locator('.menu-search__in').isVisible().catch(() => false);
  console.log(`小菜单店(${smallMenuCount}项) 搜索框: ${sbOnSmall} (expected: ${smallMenuCount > 4})`);
  await cust.screenshot({ path: path.join(OUT, 'X5-small-menu.png'), fullPage: true });

  await browser.close();
  console.log(`\nJS errors: ${errors.length}`);
  errors.forEach(e => console.log('  ' + e));
})();
