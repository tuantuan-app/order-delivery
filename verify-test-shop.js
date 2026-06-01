// 一次性验证：admin 测试 tab 的「一键造测试商家」按钮渲染 + 点击后造出商家
const { chromium } = require('playwright');
const path = require('path');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await page.goto('http://localhost:8777/admin.html?demo', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  // admin 登录（一键登入入口早已下线，统一手填）
  await page.locator('input').first().fill('admin');
  await page.locator('input[type="password"]').first().fill('admin123');
  await page.locator('button:has-text("登录")').first().click();
  await page.waitForTimeout(900);

  // 切到 🧪 测试 tab
  await page.locator('.tabbar button:has-text("测试")').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, 'smoke-shots', 'TS1-test-tab.png'), fullPage: true });

  // 滚到「造测试商家」卡（在顶部健康检查上面）
  const basicBtn = page.locator('button:has-text("基础版商家")').first();
  const proBtn = page.locator('button:has-text("专业版商家")').first();

  if (!(await basicBtn.isVisible())) { console.log('FAIL 基础版按钮不可见'); process.exit(1); }
  if (!(await proBtn.isVisible())) { console.log('FAIL 专业版按钮不可见'); process.exit(1); }

  // 点基础版
  await basicBtn.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(__dirname, 'smoke-shots', 'TS2-after-basic.png'), fullPage: true });
  const basicCred = await page.locator('text=test_basic / 1234').first().isVisible().catch(() => false);
  console.log(basicCred ? 'PASS 基础版凭据显示' : 'FAIL 基础版凭据未显示');

  // 点专业版
  await proBtn.click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(__dirname, 'smoke-shots', 'TS3-after-pro.png'), fullPage: true });
  const proCred = await page.locator('text=test_pro / 1234').first().isVisible().catch(() => false);
  console.log(proCred ? 'PASS 专业版凭据显示' : 'FAIL 专业版凭据未显示');

  // 再点一次基础版 → 应"已存在"而非"已创建"
  await basicBtn.click();
  await page.waitForTimeout(400);
  const idempotent = await page.locator('text=已存在').first().isVisible().catch(() => false);
  console.log(idempotent ? 'PASS 重复点击幂等（显示"已存在"）' : 'FAIL 重复点击没有走幂等分支');

  // 切到 🏪 商家 tab 验证两个测试商家都进了列表
  await page.locator('.tabbar button:has-text("商家")').click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(__dirname, 'smoke-shots', 'TS4-shops-list.png'), fullPage: true });
  const basicInList = await page.locator('text=测试·基础版商家').first().isVisible().catch(() => false);
  const proInList = await page.locator('text=测试·专业版商家').first().isVisible().catch(() => false);
  console.log(basicInList ? 'PASS 基础版进了商家列表' : 'FAIL 基础版没进列表');
  console.log(proInList ? 'PASS 专业版进了商家列表' : 'FAIL 专业版没进列表');

  // 验证 plan badge
  const proBadge = await page.locator('.plan-badge--pro').first().isVisible().catch(() => false);
  console.log(proBadge ? 'PASS 看到 pro plan badge' : 'INFO 没看到 plan-badge--pro（也可能是 shop1 也有，但至少新店要有）');

  if (errors.length) { console.log('—— console / pageerrors ——'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('PASS 全程无 JS 错误');

  await browser.close();
  console.log('\nshots: smoke-shots/TS{1..4}-*.png');
})();
