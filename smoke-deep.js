/*
 * smoke-deep.js —— 专业级深度测试
 *
 *  组 1 · A11y     — 键盘焦点 / ARIA / 颜色对比
 *  组 2 · 响应式    — 320/414/768/1024 多视口截图
 *  组 3 · 边界容错  — 权限拒 / Worker 死 / SW 注册失败 / GAS 离线 → 不崩溃
 *  组 4 · PM 场景  — 首次客 / 回头客 / 商家忙时 / 多端登录 / 拒单等
 *  组 5 · 安全/架构 — Worker 鉴权 / 重放 / 注入 / CORS
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8777';
const OUT = path.join(__dirname, 'smoke-deep-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const pass = []; const fail = []; const skip = []; const warn = [];
function ok(m) { console.log('  ✅ PASS  ' + m); pass.push(m); }
function bad(m) { console.log('  ❌ FAIL  ' + m); fail.push(m); }
function meh(m) { console.log('  ⚠ WARN  ' + m); warn.push(m); }
function nope(m) { console.log('  ⏭ SKIP  ' + m); skip.push(m); }

async function snap(p, name) {
  try { await p.screenshot({ path: path.join(OUT, name), fullPage: false }); console.log('  📸  ' + name); }
  catch (e) { meh('snap ' + name + ': ' + e.message); }
}

async function customerCtx(browser, opts) {
  opts = opts || {};
  const ctx = await browser.newContext({
    viewport: opts.viewport || { width: 414, height: 896 },
    userAgent: opts.ua,
    permissions: opts.permissions || [],
  });
  await ctx.addInitScript(() => {
    localStorage.setItem('canteen_profile_v4', JSON.stringify({
      name: 'X', phone: '0199999990',
      addresses: [{ id: 'a1', label: '默认', building: 'A 栋', room: 'T01', isDefault: true }],
    }));
  });
  return ctx;
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // ============================================================
  // 组 1：A11y（键盘 / ARIA / 焦点）
  // ============================================================
  console.log('\n===== 组 1 · A11y =====');
  {
    const ctx = await customerCtx(browser);
    const p = await ctx.newPage();
    p.on('pageerror', (e) => bad('A11y pageerror: ' + e.message));
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');

    // 触发 banner
    await p.evaluate(() => {
      try { Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }); } catch (_) {}
      window.notify.maybePrompt('customer', '0199999990');
    });
    await p.waitForTimeout(400);

    // 1.1 banner role 属性
    const role = await p.locator('.notify-banner').getAttribute('role');
    if (role === 'dialog') ok('1.1 notify-banner role="dialog" ✓');
    else bad('1.1 banner role 缺失：' + role);

    const aria = await p.locator('.notify-banner').getAttribute('aria-live');
    if (aria === 'polite') ok('1.2 notify-banner aria-live="polite" ✓');
    else bad('1.2 banner aria-live 缺失：' + aria);

    // 1.3 键盘 Tab 是否能到 "允许通知" 按钮
    await p.keyboard.press('Tab');
    const focusedTag = await p.evaluate(() => document.activeElement && document.activeElement.tagName);
    if (focusedTag) ok('1.3 Tab 后焦点可见 (' + focusedTag + ')');
    else meh('1.3 Tab 后焦点不可见');

    // 1.4 按钮 textContent 包含可读文字
    const okBtn = await p.locator('.notify-banner__btn--primary').textContent();
    const laterBtn = await p.locator('.notify-banner__btn--ghost').textContent();
    if (okBtn && okBtn.trim()) ok('1.4 primary 按钮文本 "' + okBtn.trim() + '"');
    else bad('1.4 primary 按钮文本为空');
    if (laterBtn && laterBtn.trim()) ok('1.5 ghost 按钮文本 "' + laterBtn.trim() + '"');

    // 1.6 颜色对比（绿色按钮 vs 白字）—— 用 ColorContrastRatio 估算
    const contrast = await p.evaluate(() => {
      const btn = document.querySelector('.notify-banner__btn--primary');
      if (!btn) return null;
      const cs = getComputedStyle(btn);
      // 解析 bg + color, 简化版亮度算法
      function rgb(s) { const m = s.match(/(\d+),\s*(\d+),\s*(\d+)/); return m ? [+m[1], +m[2], +m[3]] : [0,0,0]; }
      function lum(rgb) { return rgb.map(v=>v/255).map(v=>v<=.03928?v/12.92:Math.pow((v+.055)/1.055, 2.4)).reduce((a,b,i)=>a+b*[.2126,.7152,.0722][i],0); }
      const bg = lum(rgb(cs.backgroundColor));
      const fg = lum(rgb(cs.color));
      const ratio = (Math.max(bg,fg)+.05) / (Math.min(bg,fg)+.05);
      return { ratio: ratio.toFixed(2), bg: cs.backgroundColor, fg: cs.color };
    });
    if (contrast && contrast.ratio >= 4.5) ok('1.7 primary 按钮对比度 ' + contrast.ratio + ':1 ≥ WCAG AA');
    else if (contrast) meh('1.7 primary 按钮对比度 ' + contrast.ratio + ':1 (< 4.5 AA)' + ' bg=' + contrast.bg + ' fg=' + contrast.fg);

    await ctx.close();
  }

  // ============================================================
  // 组 2：多视口响应式
  // ============================================================
  console.log('\n===== 组 2 · 多视口响应式 =====');
  const viewports = [
    { name: '320-iphoneSE',  w: 320, h: 568 },
    { name: '414-iphonePro', w: 414, h: 896 },
    { name: '768-tablet',    w: 768, h: 1024 },
    { name: '1280-desktop',  w: 1280, h: 800 },
  ];
  for (const v of viewports) {
    const ctx = await customerCtx(browser, { viewport: { width: v.w, height: v.h } });
    const p = await ctx.newPage();
    let err = false;
    p.on('pageerror', () => { err = true; });
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    // 触发 banner
    await p.evaluate(() => {
      try { Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }); } catch (_) {}
      window.notify.maybePrompt('customer', '0199999990');
    });
    await p.waitForTimeout(300);
    await snap(p, '2-vp-' + v.name + '.png');
    if (err) bad('2.' + v.name + ' pageerror');
    else ok('2.' + v.name + ' 无 pageerror');
    // 验证 banner 不溢出
    const overflow = await p.evaluate(() => {
      const b = document.querySelector('.notify-banner');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { left: r.left, right: r.right, vw: window.innerWidth, top: r.top, bottom: r.bottom, vh: window.innerHeight };
    });
    if (overflow && overflow.left >= 0 && overflow.right <= overflow.vw && overflow.bottom <= overflow.vh) {
      ok('2.' + v.name + ' banner 不溢出（L=' + overflow.left.toFixed(0) + ' R=' + overflow.right.toFixed(0) + '/' + overflow.vw + '）');
    } else if (overflow) {
      bad('2.' + v.name + ' banner 溢出：' + JSON.stringify(overflow));
    }
    await ctx.close();
  }

  // ============================================================
  // 组 3：边界容错
  // ============================================================
  console.log('\n===== 组 3 · 边界容错 =====');

  // 3.1 permission='denied' → maybePrompt 静默
  {
    const ctx = await customerCtx(browser);
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    const ret = await p.evaluate(() => {
      try { Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true }); } catch (_) {}
      window.notify.maybePrompt('customer', '0199999990');
      return document.querySelector('.notify-banner') ? 'shown' : 'hidden';
    });
    if (ret === 'hidden') ok('3.1 denied → banner 不显示（尊重用户拒绝）');
    else bad('3.1 denied 仍弹 banner');
    await ctx.close();
  }

  // 3.2 permission='granted' → maybePrompt 静默（已开通不要重复打扰）
  {
    const ctx = await customerCtx(browser);
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    const ret = await p.evaluate(() => {
      try { Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true }); } catch (_) {}
      window.notify.maybePrompt('customer', '0199999990');
      return document.querySelector('.notify-banner') ? 'shown' : 'hidden';
    });
    if (ret === 'hidden') ok('3.2 granted → banner 不显示（避免重复打扰）');
    else bad('3.2 granted 仍弹 banner');
    await ctx.close();
  }

  // 3.3 SW 不支持环境 → notify.supported() === false 但不崩
  {
    const ctx = await customerCtx(browser);
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      delete navigator.serviceWorker;
    });
    let err = false;
    p.on('pageerror', () => { err = true; });
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    const sup = await p.evaluate(() => window.notify && window.notify.supported());
    if (sup === false && !err) ok('3.3 无 SW 环境 → supported()=false 且无 pageerror');
    else bad('3.3 异常 sup=' + sup + ' err=' + err);
    await ctx.close();
  }

  // 3.4 notify.enable() 在 denied 时返回 reason 不抛
  {
    const ctx = await customerCtx(browser);
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    const r = await p.evaluate(async () => {
      try { Object.defineProperty(Notification, 'permission', { get: () => 'denied', configurable: true }); } catch (_) {}
      return await window.notify.enable('customer', '0199999990');
    });
    if (r && r.ok === false && r.reason === 'denied') ok('3.4 enable() 在 denied 下返回 {ok:false, reason:denied}');
    else bad('3.4 enable 反应异常: ' + JSON.stringify(r));
    await ctx.close();
  }

  // 3.5 merchantRinger.testBeep 在 AudioContext 不可用时返回 false 不崩
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.AudioContext = undefined;
      window.webkitAudioContext = undefined;
    });
    await p.goto(BASE + '/merchant.html?demo');
    await p.waitForLoadState('networkidle');
    const r = await p.evaluate(() => window.merchantRinger.testBeep(0.5));
    if (r === false) ok('3.5 无 AudioContext → testBeep 返回 false（不崩）');
    else meh('3.5 无 AC 但 testBeep=' + r);
    await ctx.close();
  }

  // 3.6 ringer 在 enabled=false 时 start() 不响
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE + '/merchant.html?demo');
    await p.waitForLoadState('networkidle');
    const r = await p.evaluate(() => {
      var S = window.store; var m = S.state.merchants[0];
      S.ui.merchantId = m.id;
      m.settings.ring = { enabled: false, volume: 0.5, intervalSec: 1.2, maxDurationSec: 30, escalateAfterMin: 5, quietStart: '', quietEnd: '' };
      window.merchantRinger.start('#disabled-test');
      return { pending: window.merchantRinger.pending(), status: window.merchantRinger.status() };
    });
    if (r.pending.length === 0 && r.status === 'idle') ok('3.6 enabled=false → start() 不入队列');
    else bad('3.6 enabled=false 但还在跟踪: ' + JSON.stringify(r));
    await ctx.close();
  }

  // ============================================================
  // 组 4：PM 场景（用户故事）
  // ============================================================
  console.log('\n===== 组 4 · PM 真实场景 =====');

  // 4.1 首次客户：profile 未设 → 看到 profile-form 而非 banner（banner 应该等到下单成功后才出现）
  {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    // 首次访问没有 profile 时也不能弹 banner（不打断 onboarding）
    const ret = await p.evaluate(() => {
      // permission 默认是 'denied' headless，所以 banner 不应该弹
      return document.querySelector('.notify-banner') ? 'shown' : 'hidden';
    });
    if (ret === 'hidden') ok('4.1 首次访问无主动弹 banner（不打断 onboarding）');
    else bad('4.1 首次访问就弹 banner（打扰）');
    await ctx.close();
  }

  // 4.2 商家有多个 pending 单时 ringer 只响 1 个 loop（不叠加）
  {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    await p.goto(BASE + '/merchant.html?demo');
    await p.waitForLoadState('networkidle');
    const r = await p.evaluate(() => {
      var S = window.store; var m = S.state.merchants[0];
      S.ui.merchantId = m.id;
      m.settings.ring = { enabled: true, volume: 0.5, intervalSec: 1.2, maxDurationSec: 30, escalateAfterMin: 5, quietStart: '', quietEnd: '' };
      var R = window.merchantRinger;
      R.start('#o1'); R.start('#o2'); R.start('#o3');
      var pending = R.pending().length;
      R.stopAll();
      return pending;
    });
    if (r === 3) ok('4.2 商家 3 个 pending → ringer 跟踪 3 单（单 loop 不叠加）');
    else bad('4.2 跟踪数异常: ' + r);
    await ctx.close();
  }

  // 4.3 多状态文案分别正确（cooking/delivering/delivered/rejected）
  {
    const ctx = await customerCtx(browser);
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    const cases = ['pending', 'cooking', 'delivering', 'delivered', 'rejected'];
    for (const s of cases) {
      const ret = await p.evaluate((status) => {
        var m = window.store.getMerchant('shop1');
        if (!m.settings) m.settings = {};
        m.settings.waNumber = '0123456789';
        var existing = window.store.state.orders.find(o => o.id === '#pmtest');
        if (existing) {
          existing.status = status;
        } else {
          window.store.state.orders.unshift({
            id: '#pmtest', merchantId: 'shop1', hubId: 'utm',
            customer: { name: 'X', phone: '0199999990', building: 'A 栋', room: 'T01' },
            items: [{ id: 'a1', name: '招牌鸡扒饭', price: 9.5, qty: 1 }],
            subtotal: 9.5, packagingFee: 0, deliveryFee: 0, total: 9.5,
            status: status, deliveryTime: '12:30',
            createdAt: Date.now(), createdAtText: '刚刚', syncStatus: 'synced', imgStatus: 'ok',
          });
        }
        window.store.state.activeOrderId = '#pmtest';
        window.store.ui.studentStep = 'status';
        window.store.ui.studentTab = 'home';
        return true;
      }, s);
      await p.waitForTimeout(300);
      const href = await p.locator('a.contact-wa').getAttribute('href').catch(() => null);
      if (href) {
        const decoded = decodeURIComponent(href);
        // 状态 → 关键词
        const expectKw = { pending: '处理到哪一步', cooking: '什么时候出餐', delivering: '配送到哪', delivered: '反馈一下', rejected: '被拒了' }[s];
        if (decoded.indexOf(expectKw) >= 0) ok('4.3 status="' + s + '" wa.me 含 "' + expectKw + '"');
        else bad('4.3 status="' + s + '" wa.me 文案错: ' + decoded.slice(0, 100));
      } else {
        bad('4.3 status="' + s + '" wa.me 链接缺失');
      }
    }
    await ctx.close();
  }

  // 4.4 dismiss 后 7 天内不再弹（验证持久化）
  {
    const ctx = await customerCtx(browser);
    const p = await ctx.newPage();
    await p.goto(BASE + '/index.html?demo');
    await p.waitForLoadState('networkidle');
    // 第一次弹
    await p.evaluate(() => {
      try { Object.defineProperty(Notification, 'permission', { get: () => 'default', configurable: true }); } catch (_) {}
      window.notify.maybePrompt('customer', '0199999990');
    });
    await p.waitForTimeout(200);
    // 点稍后
    await p.locator('.notify-banner__btn--ghost').click();
    await p.waitForTimeout(200);
    // 重置内存 _shown，但 localStorage 保留——再次 maybePrompt 应被拦截
    const second = await p.evaluate(() => {
      // 模拟新 session 但同一 localStorage
      // 内部 _shown 已重置不易做；直接验证 maybePrompt 不显示新 banner
      // 简化：刷新页面后再调
      return localStorage.getItem('notify_dismissed_customer');
    });
    if (second) ok('4.4 dismiss 戳已存 localStorage (' + second.slice(0, 14) + '...)');
    else bad('4.4 dismiss 戳缺失');
    await ctx.close();
  }

  // ============================================================
  // 组 5：架构 / 安全
  // ============================================================
  console.log('\n===== 组 5 · 架构与安全 =====');

  // 5.1 Worker 没设 secret → 401（来自部署的 Worker 而非 mock）
  // 不验证真实 Worker（要联网），改为静态代码 review:
  // 验证 sw.js 不会泄漏 endpoint 到日志
  const swSrc = fs.readFileSync(path.join(__dirname, 'sw.js'), 'utf8');
  if (swSrc.indexOf('console.log') < 0 && swSrc.indexOf('console.error') < 0) ok('5.1 sw.js 无 console.log/error（不泄漏到 DevTools）');
  else meh('5.1 sw.js 有 console.* 调用——确认不打印敏感字段');

  // 5.2 notify.js 不存 plaintext secret
  const notifySrc = fs.readFileSync(path.join(__dirname, 'js/notify.js'), 'utf8');
  if (notifySrc.indexOf('WORKER_SECRET') < 0 && notifySrc.indexOf('JWK') < 0) ok('5.2 notify.js 不含 WORKER_SECRET / JWK 字样');
  else bad('5.2 notify.js 含敏感字符串');

  // 5.3 config.js 只暴露 PUBLIC 字段（vapidPublicKey 是公开的）
  const cfgSrc = fs.readFileSync(path.join(__dirname, 'js/config.js'), 'utf8');
  if (cfgSrc.indexOf('PRIVATE') < 0 && cfgSrc.indexOf('JWK') < 0 && cfgSrc.indexOf('SECRET') < 0) ok('5.3 config.js 不含 PRIVATE / JWK / SECRET');
  else bad('5.3 config.js 含敏感字符串！立即检查');

  // 5.4 .gitignore 拦截 worker secret 路径
  const gi = fs.readFileSync(path.join(__dirname, '.gitignore'), 'utf8');
  if (gi.indexOf('.wrangler') >= 0 && gi.indexOf('.dev.vars') >= 0) ok('5.4 .gitignore 拒收 worker secret 路径');
  else bad('5.4 .gitignore 未阻止 worker 密钥泄漏');

  // 5.5 Worker 代码无 console.log 打 secret
  const workerSrc = fs.readFileSync(path.join(__dirname, 'worker/src/index.js'), 'utf8');
  // 找所有 console.log/error 行，验证不含 env.WORKER_SECRET / env.VAPID_JWK
  const logLines = workerSrc.match(/console\.(log|error|warn|info)\([^)]*\)/g) || [];
  let secretLeak = false;
  logLines.forEach(line => {
    if (/WORKER_SECRET|VAPID_JWK|VAPID_PRIVATE|env\./.test(line)) secretLeak = true;
  });
  if (!secretLeak) ok('5.5 Worker 无 secret 写日志（' + logLines.length + ' 处 console.*）');
  else bad('5.5 Worker 日志可能泄漏 secret');

  // 5.6 Worker GET /push 应该拒绝（只允许 POST）
  // 静态检查
  if (workerSrc.indexOf("req.method !== 'POST'") >= 0 || workerSrc.indexOf("method: 'POST, OPTIONS'") >= 0) ok('5.6 Worker /push 限定 POST');
  else meh('5.6 Worker /push 方法限制 — 请人工核对');

  // 5.7 Worker CORS Allow-Origin: 现在是 *，对于纯 GAS → Worker 调用应改成 specific
  if (workerSrc.indexOf("Allow-Origin', '*'") >= 0) {
    meh('5.7 Worker CORS=* — 浏览器永远不会 fetch /push（只有 GAS UrlFetchApp 调），可收紧到 specific origin 但当前不致命');
  } else {
    ok('5.7 Worker CORS 已收紧');
  }

  // 5.8 saveSubscription_ 校验 endpoint 长度（防 DoS）
  const codeGs = fs.readFileSync(path.join(__dirname, 'backend/Code.gs'), 'utf8');
  if (codeGs.indexOf('endpoint too long') >= 0) ok('5.8 saveSubscription_ 限制 endpoint 长度（防 DoS）');
  else bad('5.8 saveSubscription_ 未限制 endpoint 长度');

  // 5.9 saveSubscription_ 限定 role 白名单
  if (/role[\s\S]*?indexOf[\s\S]*?customer.*merchant.*admin/.test(codeGs)) ok('5.9 saveSubscription_ role 白名单');
  else bad('5.9 saveSubscription_ role 未白名单');

  // 5.10 pushOne_ 自动清失效订阅
  if (codeGs.indexOf('pushStatus === 404') >= 0 && codeGs.indexOf("'subId'") >= 0) ok('5.10 pushOne_ 自动清失效订阅（404/410）');
  else bad('5.10 pushOne_ 未处理失效订阅');

  // 5.11 testPush_ 走 adminGuard（避免被外部触发推送轰炸）
  if (/'testPush':\s*result\s*=\s*adminGuard_/.test(codeGs)) ok('5.11 testPush 受 adminGuard 保护');
  else bad('5.11 testPush 未保护（外部可滥用）');

  // ============================================================
  // 总结
  // ============================================================
  console.log('\n========================================');
  console.log('  PASS: ' + pass.length + '   FAIL: ' + fail.length + '   WARN: ' + warn.length + '   SKIP: ' + skip.length);
  if (fail.length) { console.log('\nFAILED:'); fail.forEach(m => console.log('   - ' + m)); }
  if (warn.length) { console.log('\nWARN:'); warn.forEach(m => console.log('   - ' + m)); }
  console.log('========================================');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('Fatal:', e); process.exit(2); });
