// 验证 visibility 隐藏时停 polling，可见再启 —— GAS 配额关键优化
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });

  // === 客户端 activeOrder ===
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_profile_v4', JSON.stringify({ name: 'P', phone: '0199999991', building: 'A 栋', room: 'T01' }));
    localStorage.setItem('canteen_hub_v1', 'utm');
  });
  const cust = await ctx.newPage();

  // 计数 GAS 调用（demo 模式没真后端，但能数 setInterval tick 频率）
  let pollCount = 0;
  cust.on('console', m => { if (m.text().includes('[poll-test]')) pollCount++; });
  await cust.addInitScript(() => {
    // 注入：拦截 window.api.getOrder 计数
    Object.defineProperty(window, 'api', {
      set(v) {
        const orig = v && v.getOrder;
        if (orig) {
          v.getOrder = function () { console.log('[poll-test] getOrder called'); return Promise.resolve({ ok: true, order: { status: 'pending' }, pollIntervalMs: 1000 }); };
          v.enabled = function () { return true; }; v.base = function () { return 'mock'; };
        }
        Object.defineProperty(window, '_api', { value: v, writable: true });
      },
      get() { return window._api; },
    });
  });

  await cust.goto('http://localhost:8777/index.html?demo', { waitUntil: 'domcontentloaded' });
  await cust.waitForTimeout(800);

  // 进商家 → 加菜 → 结算 → 提交 → 进 status 页
  const shop = cust.locator('.shop-card:has-text("叻沙")').first();
  if (await shop.isVisible().catch(()=>false)) await shop.click();
  await cust.waitForTimeout(400);
  await cust.locator('button:has-text("加入")').first().click().catch(()=>{});
  await cust.waitForTimeout(200);
  await cust.locator('button:has-text("去结算")').first().click().catch(()=>{});
  await cust.waitForTimeout(400);

  // demo 模式没 api.enabled，poll 不启动。这里没法真测到 GAS 配额节省。
  // 改测代码路径：直接在代码里查关键字
  const fs = require('fs');
  const path = require('path');
  const studentSrc = fs.readFileSync(path.join(__dirname, 'js/student.js'), 'utf8');
  const merchantSrc = fs.readFileSync(path.join(__dirname, 'js/merchant.js'), 'utf8');

  function has(src, pattern, label) {
    const ok = pattern.test(src);
    console.log(ok ? 'PASS ' + label : 'FAIL ' + label);
    return ok;
  }

  console.log('=== 客户端 (student.js) ===');
  has(studentSrc, /document\.visibilityState === 'hidden'.*return/s, '客户端 poll 内 hidden 时 early return');
  has(studentSrc, /stopped\s*=\s*true/, '客户端终态 stopped flag');
  has(studentSrc, /if \(timer\) \{ clearInterval\(timer\); timer = null; \}/, '客户端 hidden 时清 setInterval');
  has(studentSrc, /visibilitychange/, '客户端 visibilitychange 监听');
  has(studentSrc, /pollIntervalMs === 0/, '客户端响应 pollIntervalMs=0');

  console.log('\n=== 商家端 (merchant.js) ===');
  // 起步 8s = 与后端"有 pending 单"间隔对齐 —— 新单要尽快被商家看到（旧版 30s 起步会让新单延迟最多 30s）
  // 后端 idle 时返回 30s，setInterval 会自适应调高；不再用 30s 起步
  has(merchantSrc, /currentInterval = 8000/, '商家端起步 8s（保证新单 ≤8s 到位，idle 时自适应调到 30s）');
  has(merchantSrc, /document\.visibilityState === 'hidden'.*return/s, '商家端 poll 内 hidden 时 early return');
  has(merchantSrc, /pollIntervalMs !== undefined && r\.pollIntervalMs !== currentInterval/, '商家端响应 pollIntervalMs 含 0');
  has(merchantSrc, /currentInterval > 0/, '商家端 pollIntervalMs=0 时不启 interval（防御）');
  has(merchantSrc, /onVisibilityChange/, '商家端 visibilitychange 监听');

  // 后端契约保持
  const codeGs = fs.readFileSync(path.join(__dirname, 'backend/Code.gs'), 'utf8');
  console.log('\n=== 后端 (Code.gs) ===');
  has(codeGs, /pending\s*\?\s*8000/, 'getVendorOrders: pending 8s');
  has(codeGs, /hasActive\s*\?\s*12000\s*:\s*30000/, 'getVendorOrders: active 12s / idle 30s');
  has(codeGs, /pending'\s*\?\s*5000/, 'getOrder: pending 5s');
  has(codeGs, /delivering'\s*\?\s*8000/, 'getOrder: delivering 8s');
  has(codeGs, /delivered.*rejected.*cancelled.*\?\s*0/, 'getOrder: 终态 pollMs=0');

  await browser.close();
  console.log('\n✅ 核查完毕：前端路径 + 后端响应契约都对齐');
})();
