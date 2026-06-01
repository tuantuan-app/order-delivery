// 验证楼栋"连按多次也不丢"——以前的 bug：并发 async + 乱序响应整列覆盖
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
  await page.locator('input').first().fill('admin');
  await page.locator('input[type="password"]').first().fill('admin123');
  await page.locator('button:has-text("登录")').first().click();
  await page.waitForTimeout(900);

  // 切到 📍 社区 tab
  await page.locator('.tabbar button:has-text("社区")').click();
  await page.waitForTimeout(500);

  // 找到第一个 hub 的添加楼栋输入框（id="bld-utm"）
  const utmInput = page.locator('#bld-utm');
  if (!(await utmInput.isVisible())) { console.log('FAIL 找不到 #bld-utm 输入框'); process.exit(1); }

  // 记录原有楼栋数
  const beforeChips = await page.locator('.order-card:has-text("UTM") .cov-chip').count();
  console.log('原有楼栋数：', beforeChips);

  // 连按 5 个新楼栋（模拟快速 Enter）
  const newBlds = ['测试楼栋-1', '测试楼栋-2', '测试楼栋-3', '测试楼栋-4', '测试楼栋-5'];
  for (const b of newBlds) {
    await utmInput.fill(b);
    await utmInput.press('Enter');
    // 故意不 wait — 模拟用户真实快速操作；新代码应该 disable 输入框等响应
    await page.waitForTimeout(80); // 80ms 远短于 demo 本地 + 任何 GAS 真实延迟
  }

  // 等所有响应回来
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(__dirname, 'smoke-shots', 'HB1-after-5-adds.png'), fullPage: true });

  // 验证 5 个全部入账
  let allFound = true;
  for (const b of newBlds) {
    const visible = await page.locator(`.order-card:has-text("UTM") .cov-chip:has-text("${b}")`).first().isVisible().catch(() => false);
    console.log(visible ? `PASS 「${b}」入账` : `FAIL 「${b}」丢了`);
    if (!visible) allFound = false;
  }

  const afterChips = await page.locator('.order-card:has-text("UTM") .cov-chip').count();
  console.log('现有楼栋数：', afterChips, '（应=', beforeChips + 5, '）');
  console.log((afterChips === beforeChips + 5 && allFound) ? '\n✅ 全过：5 个并发添加无丢失' : '\n❌ 还有问题');

  // 重复添加去重测试
  await utmInput.fill('测试楼栋-1');
  await utmInput.press('Enter');
  await page.waitForTimeout(500);
  const dupCount = await page.locator('.order-card:has-text("UTM") .cov-chip:has-text("测试楼栋-1")').count();
  console.log(dupCount === 1 ? 'PASS 重复添加去重' : `FAIL 重复加成 ${dupCount} 个`);

  if (errors.length) { console.log('—— console / pageerrors ——'); errors.forEach(e => console.log('  ' + e)); }
  else console.log('PASS 全程无 JS 错误');

  await browser.close();
})();
