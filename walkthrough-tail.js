// Capture the admin tabs that the main walkthrough missed.
const { chromium } = require('playwright');
const path = require('path');
const OUT = path.join(__dirname, 'walkthrough-shots');
const BASE = 'http://localhost:8777';
let n = 36;
async function snap(p, lbl) { n++; await p.screenshot({ path: path.join(OUT, `${n}-D-${lbl}.png`), fullPage: true }); console.log(`📷 ${n}-D-${lbl}.png`); }

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const p = await ctx.newPage();
  await p.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(800);
  await p.locator('input').first().fill('admin');
  await p.locator('input[type="password"]').first().fill('admin123');
  await p.locator('button:has-text("登录"), button:has-text("登入")').first().click();
  await p.waitForTimeout(1500);

  // Admin dashboard 经营 view (full default)
  await snap(p, 'admin-default');

  // Click each bottom tab — use very specific selector based on the .nav-* class
  const tabs = ['商家', '计费', '社区', '测试'];
  for (const t of tabs) {
    // Last button (in tabbar at bottom) with this text
    const btn = p.locator(`button:has-text("${t}")`).last();
    if (await btn.isVisible().catch(() => false)) {
      await btn.click().catch(() => {});
      await p.waitForTimeout(700);
      await snap(p, `admin-tab-${t}`);
    } else {
      console.log(`tab ${t} not visible`);
    }
  }

  // Customer god-view + checkout (to capture sample btn)
  await p.locator('button:has-text("客户")').first().click().catch(() => {});
  await p.waitForTimeout(700);
  // dismiss hub picker if any
  const picker = p.locator('.hub-picker__item').first();
  if (await picker.isVisible().catch(() => false)) await picker.click();
  await p.waitForTimeout(500);
  await snap(p, 'admin-god-customer-home');

  await p.locator('.shop-card:not(.shop-card--closed)').first().click();
  await p.waitForTimeout(600);
  await p.locator('button:has-text("加入")').first().click();
  await p.waitForTimeout(300);
  await p.locator('button:has-text("去结算")').first().click();
  await p.waitForTimeout(800);
  await snap(p, 'admin-god-customer-checkout');

  await browser.close();
})();
