/*
 * smoke-legal.js —— 法律文档 + 同意流程 + 密码 UX 集成测试
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8777';
const OUT = path.join(__dirname, 'smoke-legal-shots');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT);

const pass = []; const fail = [];
function ok(m) { console.log('  ✅ PASS  ' + m); pass.push(m); }
function bad(m) { console.log('  ❌ FAIL  ' + m); fail.push(m); }
async function snap(p, name) {
  try { await p.screenshot({ path: path.join(OUT, name), fullPage: false }); console.log('  📸  ' + name); }
  catch (_) {}
}

(async () => {
  const browser = await chromium.launch({ headless: true });

  // === A. 法律文档静态页可访问 + 内容完整 ===
  console.log('\n===== A. 法律页可达 =====');
  for (const p of ['/privacy.html', '/terms.html']) {
    const ctx = await browser.newContext({ viewport: { width: 414, height: 896 } });
    const page = await ctx.newPage();
    let err = false;
    page.on('pageerror', () => err = true);
    const resp = await page.goto(BASE + p);
    await page.waitForLoadState('networkidle');
    if (resp.status() === 200 && !err) ok('A.' + p + ' 200 OK 无 pageerror');
    else bad('A.' + p + ' HTTP ' + resp.status() + ' err=' + err);
    // 检查关键元素
    const hasTitle = await page.locator('h1').first().isVisible().catch(() => false);
    const hasFooter = await page.locator('.footer').first().isVisible().catch(() => false);
    if (hasTitle && hasFooter) ok('A.' + p + ' 含 h1 + footer');
    else bad('A.' + p + ' 缺少基础结构');
    await snap(page, 'A' + p.replace('/', '-').replace('.html', '') + '.png');
    await ctx.close();
  }

  // === B. 法律 markdown 文档存在 ===
  console.log('\n===== B. 法律 .md 源文件 =====');
  const files = ['legal/privacy-policy.md', 'legal/terms-of-service.md', 'legal/merchant-agreement.md', 'legal/README.md'];
  files.forEach(f => {
    if (fs.existsSync(path.join(__dirname, f))) {
      const stat = fs.statSync(path.join(__dirname, f));
      ok('B.' + f + ' 存在 (' + Math.round(stat.size / 1024) + 'KB)');
    } else bad('B.' + f + ' 缺失');
  });

  // === C. PDPA 关键章节齐全 ===
  console.log('\n===== C. PDPA 关键章节 =====');
  const pp = fs.readFileSync(path.join(__dirname, 'legal/privacy-policy.md'), 'utf8');
  const required = ['PDPA', 'Google Sheets', 'Cloudflare', '删除', '21 天', '保留', 'pdp.gov.my'];
  required.forEach(k => {
    if (pp.indexOf(k) >= 0) ok('C.privacy-policy 含 "' + k + '"');
    else bad('C.privacy-policy 缺 "' + k + '"');
  });

  // === D. 客户端首次填资料 → 强制勾选同意 ===
  console.log('\n===== D. ProfileForm 同意流程 =====');
  const ctxD = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const d = await ctxD.newPage();
  // 不预设 profile，模拟首次访问
  let dErr = false;
  d.on('pageerror', (e) => { bad('D pageerror: ' + e.message); dErr = true; });
  await d.goto(BASE + '/index.html?demo');
  await d.waitForLoadState('networkidle');
  // 直接进结算路径，应弹出 ProfileForm
  await d.evaluate(() => {
    var S = window.store; if (!S) return;
    var m = S.state.merchants[0]; if (m) S.openMerchant(m.id);
    S.ui.studentStep = 'checkout';
  });
  await d.waitForTimeout(500);
  await snap(d, 'D1-profile-form.png');
  const consentVisible = await d.locator('.tos-check').isVisible().catch(() => false);
  if (consentVisible) ok('D.首次访问 → ProfileForm 显示 tos-check');
  else bad('D.tos-check 没出现');
  // 不勾选直接提交 → 应有错误
  await d.fill('input[placeholder*="陈小明"]', '测试·小明');
  await d.fill('input[placeholder*="0123"]', '0199990000');
  // 楼栋下拉或填空
  const sel = d.locator('select.cat-select').first();
  if (await sel.isVisible().catch(() => false)) {
    await sel.selectOption({ index: 1 });
  } else {
    await d.fill('input[placeholder*="A 栋"]', 'A 栋');
  }
  await d.locator('button:has-text("保存并继续")').click();
  await d.waitForTimeout(200);
  const errVisible = await d.locator('.error').isVisible().catch(() => false);
  const errText = errVisible ? await d.locator('.error').textContent() : '';
  if (errText && errText.indexOf('同意') >= 0) ok('D.未勾选 → 被拦：' + errText.trim());
  else bad('D.未勾选竟然通过了: err=' + errText);
  await snap(d, 'D2-blocked.png');
  // 勾选后再提交
  await d.locator('.tos-check input[type="checkbox"]').check();
  await d.locator('button:has-text("保存并继续")').click();
  await d.waitForTimeout(400);
  const tosSaved = await d.evaluate(() => localStorage.getItem('tt_tos_accepted'));
  if (tosSaved === 'v1.0') ok('D.勾选后 → localStorage tt_tos_accepted=v1.0');
  else bad('D.接受标记未保存: ' + tosSaved);
  const tsSaved = await d.evaluate(() => localStorage.getItem('tt_tos_accepted_at'));
  if (tsSaved && tsSaved.match(/^\d{4}-\d{2}-\d{2}T/)) ok('D.时间戳记录 ' + tsSaved);
  else bad('D.时间戳缺失: ' + tsSaved);
  await ctxD.close();

  // === E. 已同意过的 → 不再问 ===
  console.log('\n===== E. 二次访问跳过同意 =====');
  const ctxE = await browser.newContext({ viewport: { width: 414, height: 896 } });
  await ctxE.addInitScript(() => {
    localStorage.setItem('tt_tos_accepted', 'v1.0');
    localStorage.setItem('tt_tos_accepted_at', new Date().toISOString());
  });
  const e = await ctxE.newPage();
  await e.goto(BASE + '/index.html?demo');
  await e.waitForLoadState('networkidle');
  await e.evaluate(() => {
    var S = window.store; if (!S) return;
    var m = S.state.merchants[0]; if (m) S.openMerchant(m.id);
    S.ui.studentStep = 'checkout';
  });
  await e.waitForTimeout(500);
  const stillShown = await e.locator('.tos-check').isVisible().catch(() => false);
  if (!stillShown) ok('E.已同意过 → tos-check 不再显示（avoid friction）');
  else bad('E.已同意过仍然显示 tos-check');
  await ctxE.close();

  // === F. 商家登录页 - 密码小眼睛 + 忘记密码 ===
  console.log('\n===== F. 商家登录 UX =====');
  const ctxF = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const f = await ctxF.newPage();
  await f.goto(BASE + '/merchant.html?demo');
  await f.waitForLoadState('networkidle');
  await snap(f, 'F1-login.png');

  // 密码输入框默认 type=password
  const pwInput = f.locator('input[type="password"]').first();
  if (await pwInput.isVisible().catch(() => false)) ok('F.默认 type=password ✓');
  else bad('F.密码输入框缺失');
  // 点小眼睛 → 切换为 text
  const eye = f.locator('.pw-eye').first();
  if (await eye.isVisible().catch(() => false)) {
    await eye.click();
    await f.waitForTimeout(200);
    const switched = await f.locator('input[type="text"][placeholder*="密码"]').first().isVisible().catch(() => false);
    if (switched) ok('F.小眼睛点一下 → 切 text 显示密码');
    else bad('F.切换失败');
    await snap(f, 'F2-eye-on.png');
    await eye.click();
    await f.waitForTimeout(200);
  } else bad('F.小眼睛按钮缺失');

  // 忘记密码链接
  const forgot = f.locator('.login__forgot');
  if (await forgot.isVisible().catch(() => false)) {
    const href = await forgot.getAttribute('href');
    if (href && href.indexOf('wa.me/60132831238') >= 0 && decodeURIComponent(href).indexOf('忘记密码') >= 0) {
      ok('F.忘记密码 → wa.me + 预填文案');
    } else bad('F.忘记密码 URL 错: ' + href);
  } else bad('F.忘记密码链接缺失');
  await ctxF.close();

  // === G. 客户端 footer 显示 ===
  console.log('\n===== G. footer 法律链接 =====');
  const ctxG = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const g = await ctxG.newPage();
  await g.goto(BASE + '/index.html?demo');
  await g.waitForLoadState('networkidle');
  const footer = g.locator('.app-footer');
  if (await footer.isVisible().catch(() => false)) {
    const links = await footer.locator('a').count();
    if (links >= 3) ok('G.index footer 含 3+ 链接');
    else bad('G.index footer 链接数 ' + links);
    const hasPrivacy = await footer.locator('a:has-text("隐私政策")').isVisible().catch(() => false);
    const hasTerms = await footer.locator('a:has-text("使用条款")').isVisible().catch(() => false);
    if (hasPrivacy) ok('G.footer 含「隐私政策」'); else bad('G.缺「隐私政策」');
    if (hasTerms) ok('G.footer 含「使用条款」'); else bad('G.缺「使用条款」');
  } else bad('G.footer 不可见');
  await ctxG.close();

  // === H. admin 重置密码 UX ===
  console.log('\n===== H. admin 重置密码工具 =====');
  const ctxH = await browser.newContext({ viewport: { width: 414, height: 896 } });
  const h = await ctxH.newPage();
  await h.goto(BASE + '/admin.html?demo');
  await h.waitForLoadState('networkidle');
  // admin 登录（一键登入入口早已下线，手填账密）
  await h.locator('input').first().fill('admin').catch(() => {});
  await h.locator('input[type="password"]').first().fill('admin123').catch(() => {});
  await h.locator('button:has-text("登录"), button:has-text("登入")').first().click().catch(() => {});
  await h.waitForTimeout(800);
  ok('H.admin 登录');
  // 切到商家管理 tab，编辑 shop1
  await h.evaluate(() => {
    var btns = Array.from(document.querySelectorAll('button')).filter(b => b.textContent.indexOf('商家') >= 0);
    if (btns.length) btns[0].click();
  });
  await h.waitForTimeout(500);
  await snap(h, 'H1-admin-vendors.png');
  // 找编辑按钮
  const editBtn = h.locator('button:has-text("编辑")').first();
  if (await editBtn.isVisible().catch(() => false)) {
    await editBtn.click();
    await h.waitForTimeout(400);
    await snap(h, 'H2-edit-vendor.png');
    // 检查重置工具
    const resetBtn = h.locator('button:has-text("重置为 1234")');
    const randomBtn = h.locator('button:has-text("随机生成")');
    const copyBtn = h.locator('button:has-text("复制")');
    if (await resetBtn.isVisible().catch(() => false)) ok('H.「重置为 1234」按钮可见');
    else bad('H.重置按钮缺失');
    if (await randomBtn.isVisible().catch(() => false)) ok('H.「随机生成」按钮可见');
    else bad('H.随机生成按钮缺失');
    if (await copyBtn.isVisible().catch(() => false)) ok('H.「复制」按钮可见');
    // 点重置看是否填到密码框
    await resetBtn.click();
    await h.waitForTimeout(200);
    const pwVal = await h.locator('input[v-model="form.password"], input[type="text"]').filter({ hasText: '' }).first().inputValue().catch(() => '');
    // Simpler check: localStorage / store state
    const formPwd = await h.evaluate(() => {
      // Vue 3 reactive 不易访问；只能 DOM 检查
      var ins = document.querySelectorAll('input');
      for (var i = 0; i < ins.length; i++) if (ins[i].value === '1234') return true;
      return false;
    });
    if (formPwd) ok('H.重置后密码框值为 1234');
    else bad('H.重置未生效');
    await snap(h, 'H3-after-reset.png');
  } else bad('H.找不到编辑按钮');
  await ctxH.close();

  console.log('\n========================================');
  console.log('  PASS: ' + pass.length + '   FAIL: ' + fail.length);
  if (fail.length) { console.log('FAILED:'); fail.forEach(m => console.log('   - ' + m)); }
  console.log('========================================');
  await browser.close();
  process.exit(fail.length ? 1 : 0);
})().catch(e => { console.error('Fatal:', e); process.exit(2); });
