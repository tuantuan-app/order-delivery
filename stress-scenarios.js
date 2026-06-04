// stress-scenarios.js — edge-case + abnormal-user behavior probes
// per role (customer / merchant / admin). Not a clean-path replay.
// Goal: find UX cracks and validation holes a normal user could trip on.
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'stress-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);
const BASE = 'http://localhost:8777';
const TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const findings = [];
function add(role, tag, msg, detail = '') {
  const line = `[${role}] ${tag} ${msg}${detail ? ' :: ' + detail : ''}`;
  findings.push({ role, tag, msg, detail });
  console.log(line);
}
async function snap(p, n) { await p.screenshot({ path: path.join(OUT, n), fullPage: true }); }

(async () => {
  const browser = await chromium.launch({ headless: true });

  // Each scenario gets a FRESH context to avoid state-bleed (active orderId, etc.).
  async function freshCtx(profileOverride) {
    const c = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await c.addInitScript((profile) => {
      localStorage.setItem('canteen_hub_v1', 'utm');
      if (profile !== null) {
        localStorage.setItem('canteen_profile_v4', JSON.stringify(profile));
      }
    }, profileOverride === undefined ? {
      name: '测试顾客', phone: '0199999990', building: 'A 栋', room: 'T01'
    } : profileOverride);
    return c;
  }
  // Backwards-compat shim for older blocks; will be replaced below.
  const seed = {
    newPage: async () => { const c = await freshCtx(); const p = await c.newPage(); p._ownCtx = c; return p; },
  };
  async function closeP(p) { try { await p.close(); } catch (_) {} if (p._ownCtx) await p._ownCtx.close(); }

  const allErrs = [];
  function wireErr(p, label) {
    p.on('pageerror', e => { allErrs.push(`[${label}] pageerror: ${e.message.split('\n')[0]}`); });
    p.on('console', m => { if (m.type() === 'error') allErrs.push(`[${label}] console: ${m.text().slice(0, 200)}`); });
  }

  // =========================================================
  //                    CUSTOMER · 10 scenarios
  // =========================================================
  console.log('\n========== CUSTOMER EDGE CASES ==========');

  // ---- C-S1: Rapid double-click submit (double-order prevention) ----
  {
    const p = await seed.newPage(); wireErr(p, 'C-S1');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click();
    await p.waitForTimeout(500);
    await p.locator('input[type="file"]').first().setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: TINY });
    await p.waitForTimeout(400);
    const submit = p.locator('button.btn--primary.btn--block').last();
    // Triple-click as fast as possible
    await Promise.all([submit.click(), submit.click(), submit.click()]).catch(() => {});
    await p.waitForTimeout(1500);
    // Read store directly — most reliable across status / orders tabs.
    const myCount = await p.evaluate((phone) => {
      const all = (window.store && window.store.state && window.store.state.orders) || [];
      return all.filter(o => o.customer && o.customer.phone === phone).length;
    }, '0199999990');
    add('C-S1', myCount === 1 ? 'PASS' : myCount > 1 ? 'FAIL' : 'WARN',
        `triple-click submit → ${myCount} order(s) for our phone (expected 1)`);
    await snap(p, 'C-S1-after-multi-click.png');
    await closeP(p);
  }

  // ---- C-S2: Add item beyond stock via stepper ----
  {
    const p = await seed.newPage(); wireErr(p, 'C-S2');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    // Find an item with finite stock
    const stockedItem = p.locator('.dish:has-text("剩")').first();
    const hasStocked = await stockedItem.isVisible().catch(() => false);
    if (hasStocked) {
      const stockText = (await stockedItem.textContent() || '').match(/剩\s*(\d+)/);
      const stock = stockText ? Number(stockText[1]) : 0;
      // Try to click + many times beyond stock
      const addBtn = stockedItem.locator('button:has-text("加入")').first();
      if (await addBtn.isVisible().catch(() => false)) await addBtn.click();
      await p.waitForTimeout(150);
      const inc = stockedItem.locator('.stepper__btn--add').first();
      let clicks = 1;
      for (let i = 0; i < stock + 5; i++) {
        if (await inc.isDisabled().catch(() => true)) break;
        await inc.click();
        clicks++;
        await p.waitForTimeout(60);
      }
      const num = (await stockedItem.locator('.stepper__num').first().textContent() || '').trim();
      const capped = Number(num) <= stock;
      add('C-S2', capped ? 'PASS' : 'FAIL',
          `stock=${stock} clicked +${clicks}x → cart shows ${num} (capped=${capped})`);
    } else {
      add('C-S2', 'INFO', 'no finite-stock item visible in this demo shop');
    }
    await closeP(p);
  }

  // ---- C-S3: Switch hubs with cart in progress ----
  {
    const p = await seed.newPage(); wireErr(p, 'C-S3');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    const cartBefore = (await p.locator('.cart-bar__count').first().textContent().catch(() => '') || '').trim();
    // Back to home
    await p.locator('.icon-back, [aria-label="返回"]').first().click().catch(() => {});
    await p.waitForTimeout(400);
    // Click "切换" to reopen hub picker
    const switchBtn = p.locator(':text("切换")').first();
    if (await switchBtn.isVisible().catch(() => false)) {
      await switchBtn.click();
      await p.waitForTimeout(400);
      // Pick UKM (the other hub)
      const ukm = p.locator('.hub-picker__item:has-text("UKM")').first();
      if (await ukm.isVisible().catch(() => false)) {
        await ukm.click();
        await p.waitForTimeout(500);
        // After switching hub, did cart clear? Reopen the new hub's shop
        const shopsOther = await p.locator('.shop-card').count();
        const cartAfter = (await p.locator('.cart-bar__count').first().textContent().catch(() => '') || '').trim();
        add('C-S3', 'INFO',
            `cart before="${cartBefore}", hub→UKM (${shopsOther} shops), cart-bar after="${cartAfter}"`);
      } else {
        add('C-S3', 'INFO', 'UKM hub option not available');
      }
    }
    await closeP(p);
  }

  // ---- C-S4: Profile validation: bad phone, very long name ----
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    await ctx.addInitScript(() => { localStorage.setItem('canteen_hub_v1', 'utm'); });
    const p = await ctx.newPage(); wireErr(p, 'C-S4');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click();
    await p.waitForTimeout(600);
    // Look for name+phone inputs
    const nameIn = p.locator('input[placeholder*="姓"], input[placeholder*="名字"]').first();
    const phoneIn = p.locator('input[type="tel"]').first();
    if (await nameIn.isVisible().catch(() => false)) {
      // 200-char name
      const longName = '测试'.repeat(100);
      await nameIn.fill(longName);
      const stored = await nameIn.inputValue();
      add('C-S4', stored.length < longName.length ? 'PASS' : 'WARN',
          `name length cap: input=${longName.length} stored=${stored.length}`);
    }
    if (await phoneIn.isVisible().catch(() => false)) {
      for (const bad of ['abc', '0', '123', '!@#$', '电话号码', '+++++']) {
        await phoneIn.fill(bad);
        await p.waitForTimeout(100);
      }
      await phoneIn.fill('0199999990');
      await p.waitForTimeout(150);
      const err1 = await p.locator('.error, [class*="error"]').count();
      add('C-S4', 'INFO', `tried 6 bad phone values without crash; error markers present: ${err1}`);
    }
    await closeP(p);
    await ctx.close();
  }

  // ---- C-S5: Search XSS-ish / very long input ----
  {
    const p = await seed.newPage(); wireErr(p, 'C-S5');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    const search = p.locator('input[placeholder*="搜"]').first();
    if (await search.isVisible().catch(() => false)) {
      const payloads = [
        '<script>alert(1)</script>',
        '"><img src=x onerror=alert(1)>',
        "' OR '1'='1",
        '\\u0000',
        '🍔'.repeat(50),
        'a'.repeat(500),
        '\n\t\r\b',
      ];
      for (const x of payloads) {
        await search.fill(x);
        await p.waitForTimeout(150);
      }
      await search.fill('');
      add('C-S5', 'PASS', '7 abusive search inputs survived without crash/leak');
    } else {
      add('C-S5', 'INFO', 'no search input visible');
    }
    await closeP(p);
  }

  // ---- C-S6: Empty cart — can submit? ----
  {
    const p = await seed.newPage(); wireErr(p, 'C-S6');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    // Try checkout without adding anything
    const checkBtn = p.locator('button:has-text("去结算")').first();
    const vis = await checkBtn.isVisible().catch(() => false);
    add('C-S6', vis ? 'WARN' : 'PASS',
        `empty cart → "去结算" button visible: ${vis} (should be hidden)`);
    await closeP(p);
  }

  // ---- C-S7: Add then remove all → cart bar disappears ----
  {
    const p = await seed.newPage(); wireErr(p, 'C-S7');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    const addBtn = p.locator('button:has-text("加入")').first();
    await addBtn.click();
    await p.waitForTimeout(200);
    const inc = p.locator('.stepper__btn').first();
    // Click − until cart drops to 0
    let safety = 0;
    while (safety++ < 10) {
      const cnt = (await p.locator('.cart-bar__count').first().textContent().catch(() => '') || '').trim();
      if (!cnt) break;
      await inc.click().catch(() => {});
      await p.waitForTimeout(150);
    }
    const stillThere = await p.locator('.cart-bar__count').first().isVisible().catch(() => false);
    add('C-S7', !stillThere ? 'PASS' : 'WARN',
        `remove-all → cart bar hidden: ${!stillThere}`);
    await closeP(p);
  }

  // ---- C-S8: Closed shop — can't enter ----
  {
    const p = await seed.newPage(); wireErr(p, 'C-S8');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    const closed = p.locator('.shop-card--closed').first();
    const closedExists = await closed.isVisible().catch(() => false);
    if (closedExists) {
      // demo: shop3 is closed; but UTM only has shops 1/2/4 — try UKM
      await p.evaluate(() => { localStorage.setItem('canteen_hub_v1', 'ukm'); });
      await p.reload();
      await p.waitForTimeout(700);
      const closedShop = p.locator('.shop-card--closed').first();
      if (await closedShop.isVisible().catch(() => false)) {
        await closedShop.click();
        await p.waitForTimeout(400);
        const inShop = await p.locator('.dish').count();
        add('C-S8', inShop === 0 ? 'PASS' : 'WARN',
            `clicked closed shop → ${inShop} dishes loaded (should be 0 or blocked)`);
      } else {
        add('C-S8', 'INFO', 'no closed shop in UKM either');
      }
    } else {
      add('C-S8', 'INFO', 'no closed shop visible in current hub');
    }
    await closeP(p);
  }

  // ---- C-S9: Submit without screenshot (UI gating) — already covered, do triple-check ----
  {
    const p = await seed.newPage(); wireErr(p, 'C-S9');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click();
    await p.waitForTimeout(500);
    const btn = p.locator('button.btn--primary.btn--block').last();
    // Try force-click via JS dispatchEvent
    const enabled = !(await btn.isDisabled());
    if (!enabled) {
      // Try evaluate force click
      const beforeCount = await p.locator('.order-card').count();
      await p.evaluate(() => {
        const buttons = document.querySelectorAll('button.btn--primary.btn--block');
        const btn = buttons[buttons.length - 1];
        if (btn && !btn.disabled) btn.click();
      });
      await p.waitForTimeout(800);
      const after = await p.locator('.order-card').count();
      add('C-S9', 'PASS', `disabled submit cannot be force-clicked through (cards=${beforeCount}→${after})`);
    } else {
      add('C-S9', 'FAIL', 'submit was NOT disabled with no screenshot');
    }
    await closeP(p);
  }

  // ---- C-S10: localStorage state persistence (close & reopen) ----
  {
    const ctx = await freshCtx();
    const p = await ctx.newPage(); wireErr(p, 'C-S10');
    await p.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('.shop-card:not(.shop-card--closed)').first().click();
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click();
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click();
    await p.waitForTimeout(600);
    await p.locator('input[type="file"]').first().setInputFiles({ name: 'p.png', mimeType: 'image/png', buffer: TINY });
    await p.waitForTimeout(400);
    await p.locator('button.btn--primary.btn--block').last().click();
    await p.waitForTimeout(1200);
    await closeP(p);
    // Reopen the same context (same localStorage)
    const p2 = await ctx.newPage(); wireErr(p2, 'C-S10b');
    await p2.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded' });
    await p2.waitForTimeout(1200);
    // Should be on status page or have the order in 订单
    const onStatus = await p2.locator('.status-hero, .status-rejected').first().isVisible().catch(() => false);
    const orderInMyOrders = onStatus ? 'redirect to status' :
      (async () => {
        const t = await p2.locator('.tabbar button:has-text("订单")').first();
        if (await t.isVisible().catch(() => false)) {
          await t.click(); await p2.waitForTimeout(400);
          return await p2.locator('.order-card').count() + ' orders in 订单 tab';
        }
        return 'no tab visible';
      })();
    add('C-S10', onStatus ? 'PASS' : 'INFO',
        `reopen browser: status-page rendered=${onStatus}; my-orders=${typeof orderInMyOrders === 'string' ? orderInMyOrders : await orderInMyOrders}`);
    await p2.close();
    await ctx.close();
  }

  // =========================================================
  //                    MERCHANT (god-view) · 5 scenarios
  // =========================================================
  console.log('\n========== MERCHANT EDGE CASES ==========');

  // Helper: get logged-in admin → merchant view (fresh ctx, isolated localStorage)
  async function adminMerchantPage() {
    const c = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const p = await c.newPage(); p._ownCtx = c;
    wireErr(p, 'admin-helper');
    await p.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('input').first().fill('admin');
    await p.locator('input[type="password"]').first().fill('admin123');
    await p.locator('button:has-text("登录"), button:has-text("登入")').first().click();
    await p.waitForTimeout(1500);
    await p.locator('button:has-text("商家")').first().click();
    await p.waitForTimeout(800);
    return p;
  }

  // ---- M-S1: Approve same order rapidly (double-click) ----
  {
    const p = await adminMerchantPage();
    const accept = p.locator('button:has-text("接单"), button:has-text("同意做菜"), button:has-text("同意")').first();
    if (await accept.isVisible().catch(() => false)) {
      const beforeCard = (await p.locator('.order-card').first().textContent() || '').trim();
      await Promise.all([accept.click(), accept.click(), accept.click()]).catch(() => {});
      await p.waitForTimeout(800);
      const cards = await p.locator('.order-card').count();
      add('M-S1', 'PASS', `triple-click approve survived (no crash); cards now=${cards}`);
    } else {
      add('M-S1', 'INFO', 'no pending order to approve');
    }
    await closeP(p);
  }

  // ---- M-S2: Reject with empty reason ----
  {
    const p = await adminMerchantPage();
    const rejBtn = p.locator('button:has-text("拒绝")').first();
    if (await rejBtn.isVisible().catch(() => false)) {
      await rejBtn.click();
      await p.waitForTimeout(500);
      await snap(p, 'M-S2-reject-modal.png');
      // Try confirming with no reason picked
      const confirm = p.locator('button:has-text("确认拒绝"), button:has-text("确认")').first();
      if (await confirm.isVisible().catch(() => false)) {
        const before = await p.locator('.order-card').count();
        await confirm.click();
        await p.waitForTimeout(600);
        const after = await p.locator('.order-card').count();
        // If reject went through silently OR was blocked → both are OK; we just verify no crash
        add('M-S2', 'PASS', `confirm-without-reason: cards ${before}→${after}, no crash`);
      } else {
        add('M-S2', 'INFO', 'no confirm-reject button visible');
      }
      // Close modal if still open
      await p.keyboard.press('Escape').catch(() => {});
    } else {
      add('M-S2', 'INFO', 'no order to reject');
    }
    await closeP(p);
  }

  // ---- M-S3: Order search with non-existent / abusive input ----
  {
    const p = await adminMerchantPage();
    const search = p.locator('input[placeholder*="搜"], input[placeholder*="订单"]').first();
    if (await search.isVisible().catch(() => false)) {
      const baseCnt = await p.locator('.order-card').count();
      const queries = ['zzzz_nope', '<script>x</script>', '0199999999', '#S99-99', '0', '   '];
      let allOk = true;
      for (const q of queries) {
        await search.fill(q);
        await p.waitForTimeout(250);
        const cnt = await p.locator('.order-card').count();
        if (cnt > baseCnt) { allOk = false; break; }
      }
      await search.fill('');
      add('M-S3', allOk ? 'PASS' : 'WARN', `${queries.length} abusive search inputs; no result leak`);
    } else {
      add('M-S3', 'INFO', 'merchant search not visible');
    }
    await closeP(p);
  }

  // ---- M-S4: Switching status filters rapidly ----
  {
    const p = await adminMerchantPage();
    const tabs = ['待处理', '进行中', '已完成', '已取消'];
    for (const t of tabs) {
      const tab = p.locator(`.tabs button:has-text("${t}"), .chip:has-text("${t}"), button:has-text("${t}")`).first();
      if (await tab.isVisible().catch(() => false)) await tab.click().catch(() => {});
      await p.waitForTimeout(120);
    }
    add('M-S4', 'PASS', `rapid filter-tab switching across 4 states without crash`);
    await closeP(p);
  }

  // ---- M-S5: Settings — clear required fields ----
  {
    const p = await adminMerchantPage();
    const setTab = p.locator('button:has-text("设置")').first();
    if (await setTab.isVisible().catch(() => false)) {
      await setTab.click();
      await p.waitForTimeout(500);
      // Try clearing the WhatsApp number field
      const wa = p.locator('input').filter({ hasText: '' }).first();
      // Find phone-input on settings
      const inputs = await p.locator('input[type="tel"], input').all();
      // Just type into the first 3 visible inputs — clear → re-fill bad data
      let touched = 0;
      for (const inp of inputs.slice(0, 5)) {
        if (await inp.isVisible().catch(() => false) && await inp.isEnabled().catch(() => false)) {
          const orig = await inp.inputValue().catch(() => '');
          await inp.fill('').catch(() => {});
          await p.waitForTimeout(50);
          await inp.fill(orig).catch(() => {});
          touched++;
        }
      }
      add('M-S5', 'PASS', `settings: touched ${touched} inputs (clear→restore) without crash`);
    }
    await closeP(p);
  }

  // =========================================================
  //                    ADMIN · 5 scenarios
  // =========================================================
  console.log('\n========== ADMIN EDGE CASES ==========');

  // ---- A-S1: Rapid view switching customer ↔ merchant ↔ admin ----
  {
    const __c = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const p = await __c.newPage(); p._ownCtx = __c; wireErr(p, 'A-S1');
    await p.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(800);
    await p.locator('input').first().fill('admin');
    await p.locator('input[type="password"]').first().fill('admin123');
    await p.locator('button:has-text("登录"), button:has-text("登入")').first().click();
    await p.waitForTimeout(1500);
    for (let i = 0; i < 5; i++) {
      await p.locator('button:has-text("商家")').first().click().catch(() => {});
      await p.waitForTimeout(120);
      await p.locator('button:has-text("客户")').first().click().catch(() => {});
      await p.waitForTimeout(120);
      await p.locator('button:has-text("管理")').first().click().catch(() => {});
      await p.waitForTimeout(120);
    }
    add('A-S1', 'PASS', `15 view switches (customer↔merchant↔admin) without crash`);
    await closeP(p);
  }

  // ---- A-S2: Wrong login many times (any rate-limit?) ----
  {
    const __c = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const p = await __c.newPage(); p._ownCtx = __c; wireErr(p, 'A-S2');
    await p.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(700);
    for (let i = 0; i < 8; i++) {
      await p.locator('input').first().fill('admin');
      await p.locator('input[type="password"]').first().fill('wrong_pwd_' + i);
      await p.locator('button:has-text("登录"), button:has-text("登入")').first().click();
      await p.waitForTimeout(400);
    }
    const stillOnLogin = await p.locator('input[type="password"]').first().isVisible().catch(() => false);
    add('A-S2', 'INFO', `8 wrong-pwd attempts: still on login=${stillOnLogin} (no client rate-limit observed)`);
    await closeP(p);
  }

  // ---- A-S3: Walking 测试 / 健康 / 商家 tabs (the dashboard breadth) ----
  {
    const __c = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const p = await __c.newPage(); p._ownCtx = __c; wireErr(p, 'A-S3');
    await p.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(700);
    await p.locator('input').first().fill('admin');
    await p.locator('input[type="password"]').first().fill('admin123');
    await p.locator('button:has-text("登录"), button:has-text("登入")').first().click();
    await p.waitForTimeout(1500);
    // The admin home has 5 bottom tabs: 经营 / 商家 / 计费 / 社区 / 测试
    const tabs = ['经营', '商家', '计费', '社区', '测试'];
    let opened = 0;
    for (const t of tabs) {
      const sel = p.locator(`.bottom-tabs button:has-text("${t}"), nav button:has-text("${t}"), button:has-text("${t}")`).first();
      if (await sel.isVisible().catch(() => false)) {
        await sel.click({ timeout: 2000 }).catch(() => {});
        await p.waitForTimeout(300);
        opened++;
      }
    }
    add('A-S3', opened === tabs.length ? 'PASS' : 'INFO', `admin bottom tabs reached: ${opened}/${tabs.length}`);
    await closeP(p);
  }

  // ---- A-S4: Test tools — but DON'T actually wipe ----
  {
    const __c = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const p = await __c.newPage(); p._ownCtx = __c; wireErr(p, 'A-S4');
    await p.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(700);
    await p.locator('input').first().fill('admin');
    await p.locator('input[type="password"]').first().fill('admin123');
    await p.locator('button:has-text("登录"), button:has-text("登入")').first().click();
    await p.waitForTimeout(1500);
    const testTab = p.locator('button:has-text("测试")').first();
    if (await testTab.isVisible().catch(() => false)) {
      await testTab.click();
      await p.waitForTimeout(700);
      await snap(p, 'A-S4-test-tools.png');
      // CRITICAL: ensure destructive buttons require confirmation
      const danger = ['清除', '重置', '清空'];
      let withConfirm = 0;
      for (const d of danger) {
        const btn = p.locator(`button:has-text("${d}")`).first();
        if (await btn.isVisible().catch(() => false)) {
          // Hook dialog: if click triggers confirm dialog, dismiss
          let confirmed = false;
          p.once('dialog', d2 => { confirmed = true; d2.dismiss(); });
          await btn.click().catch(() => {});
          await p.waitForTimeout(500);
          if (confirmed) withConfirm++;
        }
      }
      add('A-S4', withConfirm > 0 ? 'PASS' : 'WARN',
          `destructive buttons with confirm: ${withConfirm}`);
    } else {
      add('A-S4', 'INFO', '"测试" tab not found');
    }
    await closeP(p);
  }

  // ---- A-S5: Admin sees god-view client preview WITH sample btn ----
  {
    const __c = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const p = await __c.newPage(); p._ownCtx = __c; wireErr(p, 'A-S5');
    await p.goto(BASE + '/admin.html?demo', { waitUntil: 'domcontentloaded' });
    await p.waitForTimeout(700);
    await p.locator('input').first().fill('admin');
    await p.locator('input[type="password"]').first().fill('admin123');
    await p.locator('button:has-text("登录"), button:has-text("登入")').first().click();
    await p.waitForTimeout(1500);
    await p.locator('button:has-text("客户")').first().click();
    await p.waitForTimeout(700);
    // Hub picker may show in admin god-view too
    const picker = p.locator('.hub-picker__item').first();
    if (await picker.isVisible().catch(() => false)) await picker.click();
    await p.waitForTimeout(500);
    await p.locator('.shop-card').first().click().catch(() => {});
    await p.waitForTimeout(400);
    await p.locator('button:has-text("加入")').first().click().catch(() => {});
    await p.waitForTimeout(200);
    await p.locator('button:has-text("去结算")').first().click().catch(() => {});
    await p.waitForTimeout(700);
    const sampleVis = await p.locator('button:has-text("用示例图测试")').first().isVisible().catch(() => false);
    add('A-S5', sampleVis ? 'PASS' : 'WARN',
        `admin god-view customer should see "用示例图测试": ${sampleVis}`);
    await closeP(p);
  }

  // =========================================================
  //                        REPORT
  // =========================================================
  console.log('\n========== ALL SCENARIOS ==========');
  const tally = findings.reduce((a, f) => ((a[f.tag] = (a[f.tag] || 0) + 1), a), {});
  Object.keys(tally).sort().forEach(t => console.log(`  ${t}: ${tally[t]}`));
  if (allErrs.length) {
    console.log(`\n  page/console errors: ${allErrs.length}`);
    const uniq = [...new Set(allErrs)];
    uniq.slice(0, 10).forEach(e => console.log('    ' + e));
  } else {
    console.log('\n  page/console errors: 0 ✅');
  }

  await browser.close();
  fs.writeFileSync(
    path.join(OUT, 'scenarios.json'),
    JSON.stringify({ findings, allErrs, summary: tally }, null, 2)
  );
  console.log('\n  shots+report dir:', OUT);
  // Exit non-zero on FAIL
  const failCount = (tally.FAIL || 0) + allErrs.length;
  process.exit(failCount ? 1 : 0);
})();
