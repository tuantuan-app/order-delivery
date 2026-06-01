// Full-coverage end-to-end smoke: customer + merchant + admin scenarios.
// Demo mode (no backend) → exercises UI + state. For cross-role rendering, uses admin god-view (one shared store).
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'smoke-full-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);
const BASE = 'http://localhost:8777';

const findings = []; // { tag, label, detail }
function note(tag, label, detail = '') {
  findings.push({ tag, label, detail });
  console.log(`  [${tag}] ${label}${detail ? ' :: ' + detail : ''}`);
}
async function snap(p, name) {
  await p.screenshot({ path: path.join(OUT, name), fullPage: true });
}
async function safe(label, fn) {
  try { await fn(); }
  catch (e) { note('FAIL', label, e.message.split('\n')[0]); }
}
function pickElText(p, sel) {
  return p.locator(sel).first().textContent().then(t => (t || '').trim()).catch(() => '');
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  // Pre-seed customer profile so checkout works
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '测试顾客', phone: '0199999991', building: 'A 栋', room: 'T01'
    }));
  });
  const errorsByPage = new Map();
  function wireErrors(p, name) {
    errorsByPage.set(name, []);
    p.on('pageerror', e => errorsByPage.get(name).push('pageerror: ' + e.message));
    p.on('console', m => { if (m.type() === 'error') errorsByPage.get(name).push('console: ' + m.text()); });
  }

  // ============================== CUSTOMER ==============================
  console.log('\n========== CUSTOMER (index.html?demo) ==========');
  const cust = await ctx.newPage();
  wireErrors(cust, 'customer');
  const noonToday = new Date(); noonToday.setHours(12, 15, 0, 0);
  await cust.clock.install({ time: noonToday });
  await cust.clock.resume();
  await cust.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
  await cust.waitForTimeout(1000);

  // -- A. Home / shop list rendering --
  await safe('A1 home renders', async () => {
    await cust.waitForSelector('.shop-card', { timeout: 5000 });
    const n = await cust.locator('.shop-card').count();
    note('PASS', `A1 home shows ${n} shops`);
    await snap(cust, 'A1-home.png');
  });

  // -- A2. Shop list shows closed shops --
  await safe('A2 closed shops marked', async () => {
    const closed = await cust.locator('.shop-card--closed').count();
    if (closed > 0) note('PASS', `A2 ${closed} shop(s) flagged closed visually`);
    else note('GAP?', `A2 no shop-card--closed found — closed shop styling may be missing or no closed shops`);
  });

  // -- A3. Bottom nav present, tabs work --
  await safe('A3 nav tabs', async () => {
    const tabs = await cust.locator('.tabbar button').count();
    note('PASS', `A3 tabbar has ${tabs} tabs`);
    await cust.locator('.tabbar button:has-text("订单")').click();
    await cust.waitForTimeout(400);
    await snap(cust, 'A3-orders-tab.png');
    const ordersHeading = await pickElText(cust, '.cust-head, h2');
    if (ordersHeading.includes('订单')) note('PASS', 'A3 orders tab renders');
    else note('FAIL', 'A3 orders tab did not render heading');
    await cust.locator('.tabbar button:has-text("我的")').click();
    await cust.waitForTimeout(400);
    await snap(cust, 'A3-me-tab.png');
    await cust.locator('.tabbar button:has-text("首页")').click();
    await cust.waitForTimeout(400);
  });

  // -- B. Open a flexible-mode shop --
  await safe('B1 open shop', async () => {
    const target = cust.locator('.shop-card:has-text("叻沙")').first();
    if (!(await target.isVisible())) throw new Error('叻沙 shop not visible');
    await target.click();
    await cust.waitForTimeout(600);
    await snap(cust, 'B1-menu.png');
    note('PASS', 'B1 menu page opened');
  });

  // -- B2. Category chips visible --
  await safe('B2 category filters', async () => {
    const chips = await cust.locator('.shop-cat, [class*="cat"]').count();
    note(chips > 0 ? 'PASS' : 'GAP?', `B2 category filter chips: ${chips}`);
  });

  // -- B3. Add simple item via 加入 --
  await safe('B3 add simple item', async () => {
    const addBtn = cust.locator('button:has-text("加入")').first();
    await addBtn.click();
    await cust.waitForTimeout(300);
    const cartCount = await pickElText(cust, '.cart-bar__count');
    if (cartCount.includes('件')) note('PASS', `B3 cart bar shows: ${cartCount}`);
    else note('FAIL', 'B3 cart bar not showing count');
    await snap(cust, 'B3-cart-added.png');
  });

  // -- B4. Stepper increment from cart bar/list --
  await safe('B4 stepper increment', async () => {
    const stepperAdd = cust.locator('.stepper__btn--add').first();
    if (await stepperAdd.isVisible().catch(() => false)) {
      await stepperAdd.click();
      await cust.waitForTimeout(200);
      const ct = await pickElText(cust, '.cart-bar__count');
      note('PASS', `B4 after increment, cart: ${ct}`);
    } else {
      note('GAP?', 'B4 .stepper__btn--add not visible on menu (only on checkout?)');
    }
  });

  // -- B5. Options-required item (选规格) --
  await safe('B5 options sheet', async () => {
    const optBtn = cust.locator('button:has-text("选规格")').first();
    if (await optBtn.isVisible().catch(() => false)) {
      await optBtn.click();
      await cust.waitForTimeout(500);
      await snap(cust, 'B5-options-sheet.png');
      const sheet = cust.locator('.option-sheet, [class*="sheet"]');
      const visible = await sheet.first().isVisible().catch(() => false);
      note(visible ? 'PASS' : 'FAIL', `B5 options sheet ${visible ? 'opened' : 'did not open'}`);
      // close sheet
      const closeBtn = cust.locator('button:has-text("取消"), [aria-label="关闭"]').first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
      else await cust.keyboard.press('Escape');
      await cust.waitForTimeout(300);
    } else {
      note('GAP?', 'B5 no 选规格 item on this shop menu');
    }
  });

  // -- B6. Search input filters menu --
  await safe('B6 search', async () => {
    const searchIn = cust.locator('input[placeholder*="搜索"]').first();
    if (await searchIn.isVisible().catch(() => false)) {
      await searchIn.fill('鸡');
      await cust.waitForTimeout(300);
      await snap(cust, 'B6-search.png');
      note('PASS', 'B6 search input present, query "鸡" applied');
      await searchIn.fill('');
      await cust.waitForTimeout(200);
    } else {
      note('GAP?', 'B6 no search input on menu page');
    }
  });

  // -- C. Checkout --
  await safe('C1 go to checkout', async () => {
    await cust.locator('button:has-text("去结算")').first().click();
    await cust.waitForTimeout(800);
    await snap(cust, 'C1-checkout.png');
    note('PASS', 'C1 checkout page opened');
  });

  // -- C2. Submit gating: no screenshot → disabled --
  await safe('C2 submit gating no shot', async () => {
    const btn = cust.locator('button.btn--primary.btn--block').last();
    const disabled = await btn.isDisabled();
    const text = (await btn.textContent() || '').trim();
    if (disabled && text.includes('请先上传')) note('PASS', `C2 submit disabled w/ "${text}"`);
    else note('FAIL', `C2 submit gating broken: disabled=${disabled} text="${text}"`);
  });

  // -- C3. Sample btn hidden on customer --
  await safe('C3 no sample btn on customer', async () => {
    const sampleVisible = await cust.locator('button:has-text("用示例图测试")').first().isVisible().catch(() => false);
    note(sampleVisible ? 'FAIL' : 'PASS', sampleVisible ? 'C3 sample btn VISIBLE on customer' : 'C3 sample btn hidden on customer');
  });

  // -- C4. Edit address from checkout --
  await safe('C4 edit address modal', async () => {
    await cust.locator('.co-addr').click({ trial: false });
    await cust.waitForTimeout(500);
    await snap(cust, 'C4-addr-modal.png');
    const modal = cust.locator('.modal, [class*="modal"]').first();
    const visible = await modal.isVisible().catch(() => false);
    if (visible) {
      note('PASS', 'C4 address edit modal opens');
      // Close it
      const closeBtn = cust.locator('button:has-text("关闭")').first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
      await cust.waitForTimeout(300);
    } else {
      note('GAP?', 'C4 address edit modal did not appear');
    }
  });

  // -- C5. Remark input --
  await safe('C5 remark input', async () => {
    const remark = cust.locator('input[placeholder*="少辣"], .remark-in').first();
    if (await remark.isVisible().catch(() => false)) {
      await remark.fill('请放门口、不要葱');
      note('PASS', 'C5 remark input works');
    } else {
      note('GAP?', 'C5 remark input not present (settings.allowRemark may be off)');
    }
  });

  // -- C6. Multiple QR tabs if shop has them --
  await safe('C6 QR tabs', async () => {
    const tabs = await cust.locator('.qr-tab').count();
    note(tabs > 1 ? 'PASS' : 'INFO', `C6 ${tabs} QR tab(s) (multi-QR only when shop configures >1)`);
  });

  // -- C7. Upload screenshot enables submit --
  await safe('C7 upload enables submit', async () => {
    await cust.locator('input[type="file"]').first().setInputFiles({ name: 'pay.png', mimeType: 'image/png', buffer: TINY_PNG });
    await cust.waitForTimeout(800);
    await snap(cust, 'C7-after-upload.png');
    const btn = cust.locator('button.btn--primary.btn--block').last();
    const dis = await btn.isDisabled();
    const t = (await btn.textContent() || '').trim();
    if (!dis && t.includes('提交订单')) note('PASS', `C7 enabled, "${t}"`);
    else note('FAIL', `C7 still disabled: ${dis} text=${t}`);
  });

  // -- C8. Submit places order, status page renders --
  await safe('C8 submit → status', async () => {
    await cust.locator('button.btn--primary.btn--block').last().click();
    await cust.waitForTimeout(1500);
    await snap(cust, 'C8-status-pending.png');
    const hero = await pickElText(cust, '.status-hero__label, .status h2');
    const stepperItems = await cust.locator('.status-step, [class*="step"]').count();
    note('PASS', `C8 status: hero="${hero}" steps=${stepperItems}`);
  });

  // -- C9. Cancel pending order --
  await safe('C9 cancel pending order', async () => {
    cust.once('dialog', d => d.accept());
    const cancelBtn = cust.locator('button:has-text("取消订单")').first();
    if (await cancelBtn.isVisible().catch(() => false)) {
      await cancelBtn.click();
      await cust.waitForTimeout(800);
      await snap(cust, 'C9-cancelled.png');
      const title = await pickElText(cust, '.status-rejected__title, h2');
      if (title.includes('取消')) note('PASS', `C9 cancelled state rendered: "${title}"`);
      else note('FAIL', `C9 cancel did not flow to cancelled view (heading: ${title})`);
    } else {
      note('GAP?', 'C9 cancel button not visible');
    }
  });

  // -- C10. Re-order via 再点一单 (returns to menu) --
  await safe('C10 reorder button', async () => {
    const reorderBtn = cust.locator('button:has-text("再点一单"), button:has-text("再来一单")').first();
    if (await reorderBtn.isVisible().catch(() => false)) {
      await reorderBtn.click();
      await cust.waitForTimeout(500);
      note('PASS', 'C10 reorder navigates back');
    } else {
      note('GAP?', 'C10 reorder button not found in cancelled state');
    }
  });

  // -- D. My Orders list --
  await safe('D1 my orders list', async () => {
    await cust.locator('.tabbar button:has-text("订单")').click();
    await cust.waitForTimeout(500);
    await snap(cust, 'D1-my-orders.png');
    const cards = await cust.locator('.order-card').count();
    note('PASS', `D1 my-orders shows ${cards} card(s)`);
  });

  // -- D2. Open past order --
  await safe('D2 open past order', async () => {
    const card = cust.locator('.order-card').first();
    if (await card.isVisible().catch(() => false)) {
      await card.click();
      await cust.waitForTimeout(500);
      await snap(cust, 'D2-past-order-detail.png');
      note('PASS', 'D2 past order detail opens');
    }
  });

  // ============================== MERCHANT (via admin god-view sharing store) ==============================
  console.log('\n========== MERCHANT (via admin god-view for shared store) ==========');
  const adm = await ctx.newPage();
  wireErrors(adm, 'admin');
  await adm.clock.install({ time: noonToday });
  await adm.clock.resume();
  await adm.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
  await adm.waitForTimeout(800);

  // -- E1. Admin 登录 --（一键登入入口早已下线，统一手填）
  await safe('E1 admin login', async () => {
    await adm.locator('input').first().fill('admin');
    await adm.locator('input[type="password"]').first().fill('admin123');
    await adm.locator('button:has-text("登录"), button:has-text("登入")').first().click();
    await adm.waitForTimeout(1200);
    await snap(adm, 'E1-admin-home.png');
    note('PASS', 'E1 admin logged in');
  });

  // -- F1. God-view switch to merchant --
  await safe('F1 switch to merchant', async () => {
    await adm.locator('button:has-text("商家")').first().click();
    await adm.waitForTimeout(800);
    await snap(adm, 'F1-merchant-view.png');
    const hasOrders = await adm.locator('.order-card').first().isVisible().catch(() => false);
    note(hasOrders ? 'PASS' : 'INFO', `F1 merchant view orders visible: ${hasOrders}`);
  });

  // -- F2. Pending order — approve --
  await safe('F2 approve pending', async () => {
    const acceptBtn = adm.locator('button:has-text("接单"), button:has-text("同意")').first();
    if (await acceptBtn.isVisible().catch(() => false)) {
      await acceptBtn.click();
      await adm.waitForTimeout(500);
      await snap(adm, 'F2-after-approve.png');
      note('PASS', 'F2 approve clicked');
    } else {
      note('GAP?', 'F2 no 接单/同意 button visible (no pending orders?)');
    }
  });

  // -- F3. Reject with reason --
  await safe('F3 reject flow', async () => {
    const rejBtn = adm.locator('button:has-text("拒绝")').first();
    if (await rejBtn.isVisible().catch(() => false)) {
      await rejBtn.click();
      await adm.waitForTimeout(500);
      await snap(adm, 'F3-reject-modal.png');
      const sel = adm.locator('select.reject-select, select').first();
      if (await sel.isVisible().catch(() => false)) {
        await sel.selectOption({ index: 1 }).catch(() => {});
      }
      await adm.locator('button:has-text("确认拒绝")').first().click().catch(() => {});
      await adm.waitForTimeout(500);
      await snap(adm, 'F3-after-reject.png');
      note('PASS', 'F3 reject flow exercised');
    } else {
      note('GAP?', 'F3 reject button not visible (need pending order)');
    }
  });

  // -- F4. Advance order (备餐 → 配送 → 送达) --
  await safe('F4 advance status', async () => {
    let advanced = 0;
    for (let i = 0; i < 3; i++) {
      const advBtn = adm.locator('button:has-text("开始备餐"), button:has-text("开始配送"), button:has-text("确认送达")').first();
      if (await advBtn.isVisible().catch(() => false)) {
        await advBtn.click();
        await adm.waitForTimeout(400);
        advanced++;
      } else break;
    }
    await snap(adm, 'F4-advanced.png');
    note(advanced > 0 ? 'PASS' : 'GAP?', `F4 advance buttons exercised x${advanced}`);
  });

  // -- F5. Batch deliver entry --
  await safe('F5 batch deliver', async () => {
    const batchBtn = adm.locator('button:has-text("批量送达")').first();
    if (await batchBtn.isVisible().catch(() => false)) {
      await batchBtn.click();
      await adm.waitForTimeout(500);
      await snap(adm, 'F5-batch-modal.png');
      const closeBtn = adm.locator('button:has-text("关闭")').first();
      if (await closeBtn.isVisible().catch(() => false)) await closeBtn.click();
      note('PASS', 'F5 batch deliver modal opens');
    } else {
      note('INFO', 'F5 no batch-deliver entry (needs >1 active order)');
    }
  });

  // -- F6. Order search --
  await safe('F6 order search', async () => {
    const searchIn = adm.locator('input[placeholder*="搜"], input[placeholder*="订单"]').first();
    if (await searchIn.isVisible().catch(() => false)) {
      await searchIn.fill('S1');
      await adm.waitForTimeout(400);
      note('PASS', 'F6 order search input works');
      await searchIn.fill('');
    } else {
      note('GAP?', 'F6 no order search input visible');
    }
  });

  // -- G. Menu management --
  await safe('G1 menu tab', async () => {
    const menuTab = adm.locator('button:has-text("菜单"), button:has-text("商品")').first();
    if (await menuTab.isVisible().catch(() => false)) {
      await menuTab.click();
      await adm.waitForTimeout(500);
      await snap(adm, 'G1-menu-mgmt.png');
      note('PASS', 'G1 menu mgmt tab opened');
    } else {
      note('GAP?', 'G1 no 菜单/商品 tab visible');
    }
  });

  // -- G2. Add new item flow --
  await safe('G2 add item', async () => {
    const addBtn = adm.locator('button:has-text("新增"), button:has-text("添加")').first();
    if (await addBtn.isVisible().catch(() => false)) {
      await addBtn.click();
      await adm.waitForTimeout(500);
      await snap(adm, 'G2-add-item.png');
      note('PASS', 'G2 add-item dialog opens');
      const cancel = adm.locator('button:has-text("取消"), button:has-text("关闭")').first();
      if (await cancel.isVisible().catch(() => false)) await cancel.click();
    } else {
      note('GAP?', 'G2 no add-item entry');
    }
  });

  // -- H. Settings tab --
  await safe('H1 settings tab', async () => {
    const setTab = adm.locator('button:has-text("设置")').first();
    if (await setTab.isVisible().catch(() => false)) {
      await setTab.click();
      await adm.waitForTimeout(500);
      await snap(adm, 'H1-settings.png');
      note('PASS', 'H1 settings tab opened');
    }
  });

  // -- I. Admin self-view ops --
  await safe('I1 back to admin view', async () => {
    await adm.locator('button:has-text("管理")').first().click();
    await adm.waitForTimeout(500);
    await snap(adm, 'I1-admin-back.png');
    note('PASS', 'I1 god-view back to admin');
  });

  // -- I2. Vendor list / billing area --
  await safe('I2 admin tabs', async () => {
    const labels = ['商家', '计费', '社区', '测试'];
    const tabs = adm.locator('.bottom-tabs, .tabbar, nav').first();
    for (const lab of labels) {
      const t = adm.locator(`button:has-text("${lab}")`).first();
      if (await t.isVisible().catch(() => false)) {
        await t.click();
        await adm.waitForTimeout(400);
        await snap(adm, `I2-${lab}.png`);
        note('PASS', `I2 admin tab "${lab}" opened`);
      } else {
        note('INFO', `I2 admin tab "${lab}" not found`);
      }
    }
  });

  // -- I3. Test tools: clearTestData / resetSeedData buttons --
  await safe('I3 test tools', async () => {
    const tools = ['一键种子', '重新播种', '清空测试数据', 'clearTestData', 'resetSeed'];
    let found = 0;
    for (const lab of tools) {
      if (await adm.locator(`button:has-text("${lab}")`).first().isVisible().catch(() => false)) {
        note('PASS', `I3 found test tool: ${lab}`);
        found++;
      }
    }
    if (!found) note('GAP?', 'I3 no recognizable test-tool buttons visible (may be under 测试 tab)');
  });

  // -- J. God-view → customer (verify sample btn visible) --
  await safe('J1 god-view customer + sample btn', async () => {
    await adm.locator('button:has-text("客户")').first().click();
    await adm.waitForTimeout(700);
    await adm.locator('.shop-card').first().click();
    await adm.waitForTimeout(500);
    await adm.locator('button:has-text("加入")').first().click();
    await adm.waitForTimeout(300);
    await adm.locator('button:has-text("去结算")').first().click();
    await adm.waitForTimeout(800);
    await snap(adm, 'J1-god-customer-checkout.png');
    const sampleVisible = await adm.locator('button:has-text("用示例图测试")').first().isVisible().catch(() => false);
    note(sampleVisible ? 'PASS' : 'FAIL', `J1 sample btn ${sampleVisible ? 'visible' : 'hidden'} in admin god-view`);
  });

  await browser.close();

  // ============================== REPORT ==============================
  console.log('\n========== REPORT ==========');
  const tally = findings.reduce((a, f) => ((a[f.tag] = (a[f.tag] || 0) + 1), a), {});
  Object.keys(tally).sort().forEach(t => console.log(`  ${t}: ${tally[t]}`));
  console.log('\n-- console / page errors per page --');
  for (const [pg, errs] of errorsByPage) {
    console.log(`  ${pg}: ${errs.length} errors`);
    errs.slice(0, 5).forEach(e => console.log(`    ${e}`));
  }
  console.log(`\n  shots dir: ${OUT}`);
})();
