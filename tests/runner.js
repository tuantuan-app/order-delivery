/*
 * tests/runner.js —— 统一测试 runner（T-H4）
 *
 * 解决的事：
 *   - 19 个测试文件散在根目录、得一个个 `node smoke-xxx.js`
 *   - 大部分脚本硬编码 http://localhost:8777，但都不查端口活没活
 *   - 没有 fast/medium/slow 分层 → CI 不知道该跑哪些
 *
 * 设计：
 *   - fast    : demo-only + 退码正确 + 不依赖外网，~5 分钟  → CI gate
 *   - medium  : 整套 demo（含 smoke-full / smoke-deep / verify-* 全家桶）  ~15 分钟
 *   - slow    : pressure-* + prod-test-all（打真后端、需密码/token）        看心情
 *
 * 用法：
 *   node tests/runner.js --suite=fast
 *   node tests/runner.js --suite=medium --no-server      # CI 里如果已经起了别的 web 容器
 *   node tests/runner.js smoke.js verify-menu-search.js  # 跑指定文件
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8777;
const BASE = `http://localhost:${PORT}`;

// ---- 套件定义 ----
//
// fast 入选标准：
//   ① 退码正确（FAIL → exit 1）
//   ② demo-only（不打外网，CI 跑得动）
//   ③ 当前 baseline 绿（不绿的留给 medium，避免假阳性）
// 已知不绿（待 T-M6 / 测试补丁修）：
//   - smoke-legal.js     · H 段找不到 admin 编辑按钮（模板改名）
//   - verify-menu-search.js · 未预置 hub 导致 modal 拦截点击
//
const SUITES = {
  fast: [
    'smoke-cache.js',           // 静态契约扫描，秒级
    'smoke.js',                 // 客户基本流 + admin god-view
    'verify-hub-buildings.js',  // hub 楼栋 async race
    'smoke-integration.js',     // playAlert vs ringer 冲突
  ],
  // fast + 全部 demo 场景。包含已知坏掉的测试，方便手动排查。
  medium: [
    'smoke-cache.js',
    'smoke.js',
    'verify-hub-buildings.js',
    'smoke-integration.js',
    'smoke-legal.js',           // ⚠ baseline FAIL（H 段，T-M6 待修）
    'verify-menu-search.js',    // ⚠ baseline FAIL（modal 拦截，待修）
    'smoke-full.js',            // 已修 T-C1：FAIL 现在退非零
    'smoke-deep.js',
    'smoke-notify.js',
    'verify-phone-pwa-shotwait.js',
    'verify-poll-pause.js',     // ⚠ FAIL 不退码（T-M6），只做信息收集
    'verify-addrbook.js',       // ⚠ FAIL 不退码（T-M6），只做信息收集
    'verify-test-shop.js',
  ],
  // 真后端，需要凭据（来自 env）
  slow: [
    'verify-test-backend.js',
    'verify-katherine-admin.js',
    'pressure-test-concurrent-order.js',
    'pressure-test-e2e-flow.js',
    'prod-test-all.js',
  ],
};

// ---- 参数解析 ----
const args = process.argv.slice(2);
let suite = null;
let files = [];
let noServer = false;
for (const a of args) {
  if (a.startsWith('--suite=')) suite = a.slice(8);
  else if (a === '--no-server') noServer = true;
  else if (a.endsWith('.js')) files.push(a);
  else if (a === '-h' || a === '--help') {
    console.log('Usage: node tests/runner.js --suite=<fast|medium|slow> [--no-server] [files.js...]');
    process.exit(0);
  }
}
if (!suite && !files.length) suite = 'fast';
const testFiles = files.length ? files : SUITES[suite];
if (!testFiles) { console.error(`Unknown suite: ${suite}`); process.exit(2); }

// ---- 本地 server 启停 ----
async function waitFor(url, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const ok = await new Promise((res) => {
        const req = http.get(url, (r) => { r.resume(); res(r.statusCode < 500); });
        req.on('error', () => res(false));
        req.setTimeout(1000, () => { req.destroy(); res(false); });
      });
      if (ok) return true;
    } catch (_) {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function startServer() {
  // Python 3 ships on GH Actions ubuntu/windows runners. Locally same.
  const pythonBin = process.platform === 'win32' ? 'python' : 'python3';
  const child = spawn(pythonBin, ['-m', 'http.server', String(PORT)], {
    cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'], detached: false,
  });
  child.on('error', (e) => { console.error(`[runner] failed to spawn ${pythonBin}:`, e.message); });
  return child;
}

// ---- 跑测试 ----
async function runOne(file) {
  const full = path.join(ROOT, file);
  if (!fs.existsSync(full)) return { file, code: 127, ms: 0, skipped: true, reason: 'file not found' };
  console.log(`\n──── ▶ ${file}`);
  const t0 = Date.now();
  const out = spawnSync('node', [full], { stdio: 'inherit', cwd: ROOT });
  const ms = Date.now() - t0;
  const code = out.status == null ? (out.signal ? 130 : 1) : out.status;
  console.log(`──── ${code === 0 ? '✅' : '❌'} ${file} · exit=${code} · ${(ms / 1000).toFixed(1)}s`);
  return { file, code, ms, skipped: false };
}

(async () => {
  const tStart = Date.now();
  console.log(`[runner] suite=${suite || 'custom'} files=${testFiles.length} server=${noServer ? 'external' : 'managed'}`);

  let server = null;
  if (!noServer) {
    // 已经活着就别重起（避免 EADDRINUSE）
    const alreadyUp = await waitFor(BASE, 800);
    if (alreadyUp) {
      console.log(`[runner] ✓ server already at ${BASE}, reusing`);
    } else {
      console.log(`[runner] starting python http.server on :${PORT} ...`);
      server = startServer();
      const ok = await waitFor(BASE, 15000);
      if (!ok) {
        console.error(`[runner] ✗ server did not come up at ${BASE} in 15s. Is python installed?`);
        if (server) try { server.kill(); } catch (_) {}
        process.exit(2);
      }
      console.log(`[runner] ✓ server ready at ${BASE}`);
    }
  }

  // 进程退出时干掉子 server（无论怎么挂的）
  const cleanup = () => { if (server) { try { server.kill(); } catch (_) {} } };
  process.on('exit', cleanup);
  process.on('SIGINT', () => { cleanup(); process.exit(130); });
  process.on('SIGTERM', () => { cleanup(); process.exit(143); });

  const results = [];
  for (const f of testFiles) {
    results.push(await runOne(f));
  }

  // ---- 汇总 ----
  console.log('\n========================================');
  console.log('  SUMMARY');
  console.log('========================================');
  const passed = results.filter(r => r.code === 0 && !r.skipped);
  const failed = results.filter(r => r.code !== 0 && !r.skipped);
  const skipped = results.filter(r => r.skipped);
  for (const r of results) {
    const tag = r.skipped ? '⏭ ' : r.code === 0 ? '✅' : '❌';
    console.log(`  ${tag} ${r.file.padEnd(36)} exit=${r.code} · ${(r.ms / 1000).toFixed(1)}s`);
  }
  const totalSec = ((Date.now() - tStart) / 1000).toFixed(1);
  console.log(`\n  pass=${passed.length}  fail=${failed.length}  skip=${skipped.length}  total=${totalSec}s`);

  cleanup();
  process.exit(failed.length ? 1 : 0);
})().catch(e => { console.error('[runner] fatal:', e); process.exit(2); });
