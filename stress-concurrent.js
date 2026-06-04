// stress-concurrent.js — N parallel customers driving the full flow simultaneously
// Measures: per-step timing, fail rate, JS errors. Each customer gets its own
// isolated browser context (separate localStorage / cookies).
const { chromium } = require('playwright');

const BASE = 'http://localhost:8777';
const N = Number(process.env.N || 20);                  // concurrent users
const STEPS = ['load', 'hub-picked', 'shop-opened', 'item-added', 'checkout-open',
               'screenshot-attached', 'submitted', 'status-rendered'];
const TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

const results = [];   // { id, ok, failedAt, errs, timings: {step: ms} }

async function runCustomer(browser, id) {
  const r = { id, ok: false, failedAt: null, errs: [], timings: {}, totalMs: 0 };
  const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
  await ctx.addInitScript((idx) => {
    // Each user gets a unique phone so we can verify isolation
    const phone = '019999' + String(20000 + idx).padStart(5, '0');
    localStorage.setItem('canteen_hub_v1', 'utm');
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: '压测' + idx, phone, building: 'A 栋', room: 'T' + idx
    }));
  }, id);
  const page = await ctx.newPage();
  page.on('pageerror', e => r.errs.push('pageerror: ' + e.message.split('\n')[0]));
  page.on('console', m => { if (m.type() === 'error') r.errs.push('console: ' + m.text().slice(0, 120)); });

  const tStart = Date.now();
  const t = {};
  const mark = (step) => { t[step] = Date.now() - tStart; };

  try {
    await page.goto(BASE + '/index.html?demo', { waitUntil: 'domcontentloaded', timeout: 30000 });
    mark('load');

    await page.waitForSelector('.shop-card', { timeout: 15000 });
    mark('hub-picked'); // pre-seeded, so home loads directly

    r.failedAt = 'shop-opened';
    await page.locator('.shop-card:not(.shop-card--closed)').first().click({ timeout: 15000 });
    await page.waitForSelector('.dish', { timeout: 15000 });
    mark('shop-opened');

    r.failedAt = 'item-added';
    await page.locator('button:has-text("加入")').first().click({ timeout: 15000 });
    await page.waitForSelector('.cart-bar', { timeout: 8000 });
    mark('item-added');

    r.failedAt = 'checkout-open';
    await page.locator('button:has-text("去结算")').first().click({ timeout: 15000 });
    // input[type=file] is rendered as `hidden` — wait for 'attached', not visibility
    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
    mark('checkout-open');

    r.failedAt = 'screenshot-attached';
    await page.locator('input[type="file"]').first().setInputFiles(
      { name: 'p.png', mimeType: 'image/png', buffer: TINY }, { timeout: 8000 }
    );
    // Wait for submit to enable
    await page.waitForFunction(() => {
      const btns = document.querySelectorAll('button.btn--primary.btn--block');
      const b = btns[btns.length - 1];
      return b && !b.disabled;
    }, { timeout: 10000 });
    mark('screenshot-attached');

    r.failedAt = 'submitted';
    await page.locator('button.btn--primary.btn--block').last().click({ timeout: 10000 });
    mark('submitted');

    r.failedAt = 'status-rendered';
    await page.waitForFunction(() => {
      const hero = document.querySelector('.status-hero, .status, .status-rejected');
      return hero != null;
    }, { timeout: 15000 });
    mark('status-rendered');

    r.failedAt = null;
    r.ok = true;
  } catch (e) {
    r.errMsg = (e.message || '').split('\n')[0];
  } finally {
    r.timings = t;
    r.totalMs = Date.now() - tStart;
    try { await page.close(); } catch (_) {}
    try { await ctx.close(); } catch (_) {}
  }
  return r;
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * p))];
}

(async () => {
  console.log(`\n=========== CONCURRENT STRESS: ${N} parallel customers ===========`);
  console.log(`Target: ${BASE}  ·  All do full flow (load → hub → menu → cart → checkout → upload → submit → status)\n`);
  const t0 = Date.now();
  const browser = await chromium.launch({ headless: true });

  const runs = await Promise.all(Array.from({ length: N }, (_, i) => runCustomer(browser, i)));
  const wallMs = Date.now() - t0;

  await browser.close();

  // Aggregate
  const okCount = runs.filter(r => r.ok).length;
  const failCount = N - okCount;
  const errCount = runs.reduce((s, r) => s + r.errs.length, 0);
  const totals = runs.filter(r => r.ok).map(r => r.totalMs);

  console.log('\n--- RESULTS ---');
  console.log(`  Wall clock         : ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`  OK / Total         : ${okCount} / ${N}  (${((okCount / N) * 100).toFixed(0)}%)`);
  console.log(`  Failed             : ${failCount}`);
  console.log(`  Console/page errs  : ${errCount}`);
  if (totals.length) {
    console.log(`  Per-customer total : p50=${pct(totals, 0.5)}ms  p95=${pct(totals, 0.95)}ms  max=${Math.max(...totals)}ms`);
  }
  // Per-step percentiles (cumulative-from-start)
  console.log('\n--- Per-step (ms, cumulative from page-load start) ---');
  console.log('  step                p50    p95    max');
  for (const step of STEPS) {
    const arr = runs.filter(r => r.timings[step] != null).map(r => r.timings[step]);
    if (arr.length) {
      console.log(`  ${step.padEnd(20)}${String(pct(arr, 0.5)).padStart(5)}  ${String(pct(arr, 0.95)).padStart(5)}  ${String(Math.max(...arr)).padStart(5)}`);
    }
  }

  // Failure breakdown
  if (failCount) {
    console.log('\n--- FAILURES ---');
    const byStep = {};
    runs.filter(r => !r.ok).forEach(r => {
      const step = r.failedAt || 'unknown';
      (byStep[step] = byStep[step] || []).push({ id: r.id, err: r.errMsg });
    });
    for (const step of Object.keys(byStep)) {
      console.log(`  ${step}: ${byStep[step].length} customer(s)`);
      byStep[step].slice(0, 3).forEach(f => console.log(`    [#${f.id}] ${f.err}`));
    }
  }

  if (errCount) {
    console.log('\n--- CONSOLE / PAGE ERRORS (deduped) ---');
    const all = runs.flatMap(r => r.errs);
    const uniq = [...new Set(all)];
    uniq.slice(0, 10).forEach(e => console.log('  ' + e));
    if (uniq.length > 10) console.log(`  (... ${uniq.length - 10} more)`);
  }

  console.log('\n' + (failCount === 0 && errCount === 0 ? '✅ ALL PASS' : '❌ ISSUES FOUND'));
  process.exit(failCount === 0 && errCount === 0 ? 0 : 1);
})();
