// walkthrough.js — drive UI step-by-step like a real user, capture every screen.
// One screenshot per meaningful action. Names indicate what was JUST done.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'walkthrough-shots');
if (fs.existsSync(OUT)) {
  // Clean prior shots so order is unambiguous
  for (const f of fs.readdirSync(OUT)) {
    try { fs.unlinkSync(path.join(OUT, f)); } catch (_) {}
  }
} else {
  fs.mkdirSync(OUT);
}
const BASE = 'http://localhost:8777';
const TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

let stepNo = 0;
async function snap(page, label) {
  stepNo++;
  const name = `${String(stepNo).padStart(2, '0')}-${label}.png`;
  await page.screenshot({ path: path.join(OUT, name), fullPage: true });
  console.log(`📷 ${name}`);
  return name;
}
const noteOf = (page) => async () => {
  const errs = [];
  page.on('pageerror', e => errs.push('pageerror: ' + e.message.split('\n')[0]));
  page.on('console', m => { if (m.type() === 'error') errs.push('console: ' + m.text().slice(0, 120)); });
  return errs;
};

(async () => {
  const browser = await chromium.launch({ headless: true });

  // =========== ROLE A · CUSTOMER (cold start, no profile, no hub) ===========
  console.log('\n=========== CUSTOMER ===========');
  const cctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const c = await cctx.newPage();
  const cErrs = []; c.on('pageerror', e => cErrs.push('PE: ' + e.message)); c.on('console', m => { if (m.type() === 'error') cErrs.push('CE: ' + m.text().slice(0, 100)); });

  // Set time to lunch hour for shop availability
  const noon = new Date(); noon.setHours(12, 30, 0, 0);
  await c.clock.install({ time: noon }); await c.clock.resume();

  await c.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
  await c.waitForTimeout(1500);
  await snap(c, 'A-customer-arrives');

  // Try dismissing the hub picker by clicking outside (should fail)
  await c.locator('.modal').first().click({ position: { x: 10, y: 10 } }).catch(() => {});
  await c.waitForTimeout(300);
  await snap(c, 'A-tried-dismiss-modal');

  // Pick UTM 团团
  await c.locator('.hub-picker__item:has-text("UTM")').first().click();
  await c.waitForTimeout(700);
  await snap(c, 'A-picked-UTM-home');

  // Try the top "切换" to re-open picker
  await c.locator(':text("切换")').first().click();
  await c.waitForTimeout(400);
  await snap(c, 'A-switch-reopens-picker');
  await c.locator('.hub-picker__item:has-text("UTM")').first().click();
  await c.waitForTimeout(500);

  // Click first shop — 阿强快餐
  await c.locator('.shop-card').first().click();
  await c.waitForTimeout(800);
  await snap(c, 'A-shop-menu');

  // Try a category chip — 限时优惠
  const promoChip = c.locator('button:has-text("限时优惠"), .shop-cat:has-text("限时优惠"), :text-is("限时优惠")').first();
  if (await promoChip.isVisible().catch(() => false)) {
    await promoChip.click();
    await c.waitForTimeout(400);
    await snap(c, 'A-promo-category');
  }

  // Back to 全部
  await c.locator('button:has-text("全部"), :text-is("全部")').first().click().catch(() => {});
  await c.waitForTimeout(300);

  // Search "鸡"
  const search = c.locator('input[placeholder*="搜"]').first();
  if (await search.isVisible().catch(() => false)) {
    await search.fill('鸡');
    await c.waitForTimeout(400);
    await snap(c, 'A-search-鸡');
    await search.fill('');
    await c.waitForTimeout(200);
  }

  // Add the promotional 海南鸡饭 (RM 6.40)
  await c.locator('.dish:has-text("海南鸡饭")').first().locator('button:has-text("加入")').first().click();
  await c.waitForTimeout(300);
  await snap(c, 'A-added-hainan-chicken');

  // Click 选规格 on 招牌鸡扒饭
  const optBtn = c.locator('.dish:has-text("招牌鸡扒饭") button:has-text("选规格")').first();
  if (await optBtn.isVisible().catch(() => false)) {
    await optBtn.click();
    await c.waitForTimeout(500);
    await snap(c, 'A-option-sheet-default');

    // Pick 大份 +2
    const bigOpt = c.locator('.opt-row:has-text("大份")').first();
    if (await bigOpt.isVisible().catch(() => false)) {
      await bigOpt.click();
      await c.waitForTimeout(200);
    }
    // Pick 加煎蛋 (multi)
    const eggOpt = c.locator('.opt-row:has-text("加煎蛋")').first();
    if (await eggOpt.isVisible().catch(() => false)) {
      await eggOpt.click();
      await c.waitForTimeout(200);
    }
    await snap(c, 'A-option-sheet-chosen');
    // Confirm
    await c.locator('button:has-text("加入购物车")').first().click();
    await c.waitForTimeout(400);
    await snap(c, 'A-after-options-confirmed');
  }

  // Click 去结算 — without profile, first hit is the 填写收货资料 form
  await c.locator('button:has-text("去结算")').first().click();
  await c.waitForTimeout(700);
  await snap(c, 'A-profile-form-on-first-checkout');

  // Try submitting with empty form (see validation)
  const saveBtn = c.locator('button:has-text("保存并继续")').first();
  if (await saveBtn.isVisible().catch(() => false)) {
    await saveBtn.click().catch(() => {});
    await c.waitForTimeout(400);
    await snap(c, 'A-profile-empty-submit-attempt');
  }

  // Fill it like a real user
  await c.locator('input[placeholder*="陈小明"], input[placeholder*="例如：陈"]').first().fill('小明').catch(() => {});
  await c.locator('input[type="tel"], input[placeholder*="12-345"]').first().fill('0123456789').catch(() => {});
  // Building select / picker
  const bldgPicker = c.locator('button:has-text("请选择楼栋"), select, .picker-trigger').first();
  if (await bldgPicker.isVisible().catch(() => false)) {
    await bldgPicker.click();
    await c.waitForTimeout(400);
    await snap(c, 'A-building-picker');
    // Pick the first building from the list
    const firstBldg = c.locator('button.bldg, .bldg-item, .picker-item, button:has-text("A 栋"), button:has-text("A栋")').first();
    if (await firstBldg.isVisible().catch(() => false)) {
      await firstBldg.click();
      await c.waitForTimeout(300);
    } else {
      // Maybe it's a native select
      await c.locator('select').first().selectOption({ index: 1 }).catch(() => {});
    }
  }
  // Room
  const roomIn = c.locator('input[placeholder*="506"], input[placeholder*="B12"]').first();
  if (await roomIn.isVisible().catch(() => false)) {
    await roomIn.fill('301').catch(() => {});
  }
  // Terms
  const termsCb = c.locator('input[type="checkbox"]').first();
  if (await termsCb.isVisible().catch(() => false)) {
    await termsCb.check().catch(() => {});
  }
  await snap(c, 'A-profile-filled');

  // Save & continue
  await c.locator('button:has-text("保存并继续")').first().click();
  await c.waitForTimeout(800);
  await snap(c, 'A-checkout-page');

  // Look at submit gating
  await c.locator('button.btn--primary.btn--block').last().scrollIntoViewIfNeeded().catch(() => {});
  await c.waitForTimeout(200);
  await snap(c, 'A-checkout-bottom-submit-gated');

  // Edit address — open modal
  const addrEdit = c.locator('.co-addr, button:has-text("地址"), .address-card').first();
  if (await addrEdit.isVisible().catch(() => false)) {
    await addrEdit.click();
    await c.waitForTimeout(500);
    await snap(c, 'A-address-modal');
    // Close
    await c.locator('button:has-text("关闭"), button:has-text("取消")').first().click().catch(() => {});
    await c.waitForTimeout(300);
  }

  // Type a remark
  const remark = c.locator('input[placeholder*="少辣"], .remark-in').first();
  if (await remark.isVisible().catch(() => false)) {
    await remark.fill('请放门口，不要葱');
    await c.waitForTimeout(200);
  }

  // Upload screenshot
  await c.locator('input[type="file"]').first().setInputFiles({ name: 'pay.png', mimeType: 'image/png', buffer: TINY });
  await c.waitForTimeout(700);
  await snap(c, 'A-screenshot-attached');

  // Submit
  await c.locator('button.btn--primary.btn--block').last().click();
  await c.waitForTimeout(1500);
  await snap(c, 'A-order-submitted-status');

  // Cancel
  c.once('dialog', d => d.accept());
  await c.locator('button:has-text("取消订单")').first().click().catch(() => {});
  await c.waitForTimeout(800);
  await snap(c, 'A-cancelled');

  // Click 再点一单
  await c.locator('button:has-text("再点一单")').first().click().catch(() => {});
  await c.waitForTimeout(500);
  await snap(c, 'A-after-reorder-back-home');

  // 订单 tab
  await c.locator('.tabbar button:has-text("订单")').first().click();
  await c.waitForTimeout(500);
  await snap(c, 'A-orders-tab');

  // Click into past order
  const orderCard = c.locator('.order-card').first();
  if (await orderCard.isVisible().catch(() => false)) {
    await orderCard.click();
    await c.waitForTimeout(500);
    await snap(c, 'A-past-order-detail');
    // Back
    await c.locator('.icon-back, [aria-label="返回"]').first().click().catch(() => {});
    await c.waitForTimeout(300);
  }

  // 我的 tab
  await c.locator('.tabbar button:has-text("我的")').first().click().catch(() => {});
  await c.waitForTimeout(500);
  await snap(c, 'A-me-tab');

  await c.close();
  await cctx.close();

  // =========== ROLE B · MERCHANT (via admin god-view) ===========
  console.log('\n=========== MERCHANT ===========');
  const mctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const m = await mctx.newPage();
  const mErrs = []; m.on('pageerror', e => mErrs.push('PE: ' + e.message)); m.on('console', x => { if (x.type() === 'error') mErrs.push('CE: ' + x.text().slice(0, 100)); });

  await m.clock.install({ time: noon }); await m.clock.resume();
  await m.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
  await m.waitForTimeout(1000);
  await snap(m, 'B-admin-login-screen');

  // Wrong password attempt
  await m.locator('input').first().fill('admin');
  await m.locator('input[type="password"]').first().fill('hunter2');
  await m.locator('button:has-text("登录"), button:has-text("登入")').first().click();
  await m.waitForTimeout(1000);
  await snap(m, 'B-wrong-password');

  // Correct
  await m.locator('input[type="password"]').first().fill('admin123');
  await m.locator('button:has-text("登录"), button:has-text("登入")').first().click();
  await m.waitForTimeout(1500);
  await snap(m, 'B-admin-dashboard');

  // Switch to 商家 god-view
  await m.locator('button:has-text("商家")').first().click();
  await m.waitForTimeout(800);
  await snap(m, 'B-merchant-view-orders');

  // Approve first pending
  const approve = m.locator('button:has-text("同意做菜"), button:has-text("接单")').first();
  if (await approve.isVisible().catch(() => false)) {
    await approve.click();
    await m.waitForTimeout(700);
    await snap(m, 'B-after-approve');
  }

  // Advance: 开始配送
  const adv1 = m.locator('button:has-text("开始配送"), button:has-text("出餐")').first();
  if (await adv1.isVisible().catch(() => false)) {
    await adv1.click();
    await m.waitForTimeout(500);
    await snap(m, 'B-state-delivering');
  }

  // Reject flow on another pending
  const rejBtn = m.locator('button:has-text("拒绝")').first();
  if (await rejBtn.isVisible().catch(() => false)) {
    await rejBtn.click();
    await m.waitForTimeout(500);
    await snap(m, 'B-reject-modal');
    // Pick first reason from select if present
    const sel = m.locator('select').first();
    if (await sel.isVisible().catch(() => false)) {
      await sel.selectOption({ index: 1 }).catch(() => {});
      await m.waitForTimeout(200);
    }
    const conf = m.locator('button:has-text("确认拒绝"), button:has-text("确认")').first();
    if (await conf.isVisible().catch(() => false)) {
      await conf.click();
      await m.waitForTimeout(600);
      await snap(m, 'B-after-reject');
    } else {
      // Close
      await m.locator('button:has-text("取消"), button:has-text("关闭")').first().click().catch(() => {});
      await m.waitForTimeout(300);
    }
  }

  // Batch deliver modal
  const batchBtn = m.locator('button:has-text("批量送达")').first();
  if (await batchBtn.isVisible().catch(() => false)) {
    await batchBtn.click();
    await m.waitForTimeout(500);
    await snap(m, 'B-batch-deliver-modal');
    await m.locator('button:has-text("关闭"), button:has-text("取消")').first().click().catch(() => {});
    await m.waitForTimeout(300);
  }

  // 商品 menu mgmt
  await m.locator('button:has-text("商品")').first().click().catch(() => {});
  await m.waitForTimeout(700);
  await snap(m, 'B-menu-mgmt');

  // Try add item
  const addItem = m.locator('button:has-text("新增"), button:has-text("添加")').first();
  if (await addItem.isVisible().catch(() => false)) {
    await addItem.click();
    await m.waitForTimeout(500);
    await snap(m, 'B-add-item-dialog');
    // Close: try cancel button then Escape, then click outside
    await m.locator('.modal__head button, button:has-text("取消"), button:has-text("关闭"), button[aria-label="关闭"], .modal__close, .sheet__x').first().click().catch(() => {});
    await m.waitForTimeout(200);
    let stillOpen = await m.locator('.modal__panel').first().isVisible().catch(() => false);
    if (stillOpen) await m.keyboard.press('Escape');
    await m.waitForTimeout(200);
    stillOpen = await m.locator('.modal__panel').first().isVisible().catch(() => false);
    if (stillOpen) await m.locator('.modal').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await m.waitForTimeout(300);
  }

  // 会员 / 统计 (pro features) — use force click in case any overlay remains
  const stat = m.locator('.tabbar button:has-text("统计"), .tabbar button:has-text("会员")').first();
  if (await stat.isVisible().catch(() => false)) {
    await stat.click({ force: true }).catch(() => {});
    await m.waitForTimeout(600);
    await snap(m, 'B-stats-or-membership-tab');
  }

  // 设置
  await m.locator('.tabbar button:has-text("设置")').first().click({ force: true }).catch(() => {});
  await m.waitForTimeout(700);
  await snap(m, 'B-settings');

  // Scroll a bit
  await m.evaluate(() => window.scrollBy(0, 500));
  await m.waitForTimeout(300);
  await snap(m, 'B-settings-scrolled');

  // =========== ROLE C · ADMIN ===========
  console.log('\n=========== ADMIN ===========');
  // Back to 管理 view
  await m.locator('button:has-text("管理")').first().click().catch(() => {});
  await m.waitForTimeout(700);
  await m.evaluate(() => window.scrollTo(0, 0));
  await snap(m, 'C-admin-dashboard');

  // Bottom tabs: 经营/商家/计费/社区/测试
  for (const label of ['商家', '计费', '社区', '测试']) {
    const tab = m.locator(`.bottom-tabs button:has-text("${label}"), nav button:has-text("${label}"), [role="tablist"] button:has-text("${label}")`).first();
    if (await tab.isVisible().catch(() => false)) {
      await tab.click();
      await m.waitForTimeout(600);
      await snap(m, `C-tab-${label}`);
    } else {
      // Fallback — generic button with text
      const fallback = m.locator(`button:has-text("${label}")`).last();
      if (await fallback.isVisible().catch(() => false)) {
        await fallback.click().catch(() => {});
        await m.waitForTimeout(600);
        await snap(m, `C-tab-${label}-fallback`);
      }
    }
  }

  // Try test tools — clear test data dialog
  const clearBtn = m.locator('button:has-text("清除"), button:has-text("清空")').first();
  if (await clearBtn.isVisible().catch(() => false)) {
    let dlgText = '';
    m.once('dialog', async (d) => { dlgText = d.message(); await d.dismiss(); });
    await clearBtn.click().catch(() => {});
    await m.waitForTimeout(700);
    fs.writeFileSync(path.join(OUT, 'C-clear-confirm-text.txt'), dlgText || '(no dialog)');
    await snap(m, 'C-clear-attempt');
  }

  // Switch to 客户 god-view to check sample btn is visible there
  await m.locator('button:has-text("客户")').first().click().catch(() => {});
  await m.waitForTimeout(700);
  // Hub picker might pop
  const picker = m.locator('.hub-picker__item').first();
  if (await picker.isVisible().catch(() => false)) await picker.click();
  await m.waitForTimeout(500);
  await snap(m, 'C-god-view-customer-home');

  await m.locator('.shop-card').first().click().catch(() => {});
  await m.waitForTimeout(600);
  await m.locator('button:has-text("加入")').first().click().catch(() => {});
  await m.waitForTimeout(300);
  await m.locator('button:has-text("去结算")').first().click().catch(() => {});
  await m.waitForTimeout(700);
  await snap(m, 'C-god-view-checkout-has-sample-btn');

  await m.close();
  await mctx.close();

  await browser.close();

  // Persist any errors
  fs.writeFileSync(path.join(OUT, 'errors.json'), JSON.stringify({
    customer: cErrs, merchantOrAdmin: mErrs
  }, null, 2));
  console.log('\nDone — shots in', OUT);
  console.log('Customer console errors:', cErrs.length);
  console.log('Merchant/Admin console errors:', mErrs.length);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
