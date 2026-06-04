# 测试流水线审计 — 优化清单（Claude × Codex 双盲交叉验证）

> **日期**: 2026-06-04
> **审计人**: Claude (Anthropic Opus 4.7) × Codex CLI (OpenAI)
> **方法**: 两边独立读仓库 → 交叉对比 → 我（Claude）合并并核实强 claim
> **范围**: 仓库根的 `smoke-*.js / verify-*.js / pressure-test-*.js / prod-test-all.js / test-*.{cmd,ps1}` + `.github/workflows/` + `package.json`
> **不审计**: 业务代码本身（已有 `PRE_LAUNCH_TEST_REPORT.md` / `WORKFLOW_REPORT.md` 覆盖）

---

## TL;DR — 决策摘要

测试**数量**够（19 个脚本、约 3700 行），**质量**塌方。三件事最致命：

1. **`smoke-full.js` 是“样子货”**：记录 FAIL 但从不 `process.exit(1)`，CI 接它进去也只会一直绿。两个审计独立发现。
2. **CI 完全不跑测试**：`.github/workflows/sync-pages.yml` 只 copy + deploy。等于「写了几千行 Playwright 然后没人按门铃」。
3. **prod / 测试库密码明文 committed**：`prod-test-all.js`、`pressure-test-concurrent-order.js`、`pressure-test-e2e-flow.js`、`verify-katherine-admin.js` 全在源码里写真 admin/merchant 密码。

这三个修不掉，剩下的优化都白搭。

---

## 一、Critical（必须先修，否则其余优化无意义）

### T-C1. `smoke-full.js` 永远 exit 0 — CI 永远绿，无法检测回归
- **文件**: `smoke-full.js:489-501`
- **证据**: 文件末尾只有 `await browser.close()` + `console.log` 报告，**整个文件不含 `process.exit`**。`note('FAIL', ...)` 仅把字符串塞进 `findings` 数组，最后用 `tally` 打印计数，**不退出**。
- **后果**: 接进 CI 后，任何 FAIL 都会被吞，CI 全绿。等于零保护。
- **修复**: 末尾加 `const failed = findings.filter(f => f.tag === 'FAIL').length; process.exit(failed ? 1 : 0);`
- **顺手治**: `pressure-test-concurrent-order.js` 也没把超卖/缓存命中等失败映射成退出码（只 `process.exit(0)` 收尾）。

### T-C2. `.github/workflows/sync-pages.yml` 不跑任何测试 — 推 main 就上线，无门控
- **文件**: `.github/workflows/sync-pages.yml:13-29`
- **证据**: workflow 只做 `cp index.html …` 然后 `actions-gh-pages@v4` 推同步。
- **后果**: 任何 smoke / verify 的回归保护都形同虚设。和测试质量无关——测试根本没被执行。
- **修复**: 加一个 `pull_request: branches:[main]` 触发的 job，里面跑「快通道」(见 T-H4)。失败就 block 合并。

### T-C3. 真实凭据明文 committed 进仓库
- **文件**:
  - `prod-test-all.js:9` — `katherineAdmin / katherine1014@tuantuan`（**正式后台**）
  - `prod-test-all.js:10` — `katMerchant / katMerchant1014`（**正式商户**）
  - `pressure-test-concurrent-order.js:18` — `katherineTest / katherine1014@tuantuan`
  - `pressure-test-e2e-flow.js:19` — 同上
  - `verify-katherine-admin.js:2,20` — 测试 GAS URL + admin 密码（Codex 补充）
- **后果**: 任何 fork / clone / npm install 都拿到 prod 管理员密码。git history 不会因为删文件而清除。
- **修复**:
  1. **立刻轮换** `katherineAdmin` 密码（不是改文件就完）。
  2. 改用 `process.env.TUANTUAN_ADMIN_PASS` + `.env.example`，把真值放 GitHub Secrets / 本地 `.env`（加 `.gitignore`）。
  3. `git filter-repo` 重写历史移除旧密码 commit（或至少标注「已轮换、勿用」）。

### T-C4. `pressure-test-e2e-flow.js` 清理不在 `finally` — 失败留垃圾商家
- **文件**: `pressure-test-e2e-flow.js:60-80, 139, 167, 217-218`
- **证据**: 商家在 T0 创建（`upsertVendor`）；清理 `removeVendor` 在 line 218；**整个 try 包裹不存在**，中途任何 `process.exit(1)` 都跳过清理。
- **后果**: 测试 sheet 每次失败堆一个 `e2e-XXXXXXXX` 商家；GAS 配额慢漏。
- **修复**: 整段流程包 `try { ... } finally { await api('removeVendor', ...) }`，并把 `process.exit(1)` 换成 `throw`，最外层 catch 输出。

---

## 二、High（明显错的，应该一起修）

### T-H1. 软标签 `GAP?` / `INFO` 把缺失功能伪装成通过 — `smoke-full.js`
- **证据**: `smoke-full.js:330,350,366,380,393,421,471` 等多处。例如 F2 接单按钮不可见时打 `GAP?`，F3 拒绝按钮不可见时打 `GAP?`，F5 批量送达入口缺失打 `INFO`。
- **问题**: 真出 bug 时，按钮可能因为 JS 错误而不渲染，被记成 `GAP?` 跳过 → 上线后才发现接单功能挂了。
- **修复**: 在 setup 阶段就**先保证有 pending order**（用 seed 或注入 state），跑到 F2/F3/F5 时按钮**必须**存在；不可见就是 FAIL。

### T-H2. 大量 `waitForTimeout(N)` 而非等具体状态 — 慢 + 间歇性失败
- **证据**: `smoke-full.js:56,238,300,307`、`pressure-test-e2e-flow.js:127,158,180,184`、`verify-phone-pwa-shotwait.js:294,328` 等几十处。
- **问题**: 慢机器 / 慢网络下假 timeout；CI 起来后会偶发 fail，最后被 disable。
- **修复**: 改用 `waitForFunction(() => store.studentMerchant?.menu?.length)`、`waitForResponse(/getStorefront/)`、`waitForLoadState('networkidle')`。把固定 sleep 留给「确实没有可等的事件」的场景（应该 < 5 处）。

### T-H3. 截图目录冲突 — 并行跑会互相覆盖
- **证据**: `smoke-integration.js:9` 和 `smoke-deep.js:16` 都写 `smoke-deep-shots/`；`smoke.js:7`、`verify-test-shop.js:24`、`verify-menu-search.js:5,35`、`verify-addrbook.js` 都写 `smoke-shots/`。
- **修复**: 每个脚本独立目录（命名 `shots/<scriptName>/`），失败时根据测试名追加时间戳，方便复盘。

### T-H4. 无统一 runner，无 fast/slow 分层
- **证据**: `package.json` 只有 playwright devDep，没有 `scripts` 字段；没有 jest / vitest / playwright-test。19 个文件得手敲 `node smoke-xxx.js` 一个个跑。
- **修复**: 增加 `package.json` scripts:
  ```json
  "scripts": {
    "test:fast":   "node tests/runner.js --suite=fast",      // smoke + smoke-legal + verify-*  ~2min, demo only
    "test:medium": "node tests/runner.js --suite=medium",    // + smoke-full + smoke-deep + smoke-notify  ~10min
    "test:slow":   "node tests/runner.js --suite=slow",      // + pressure-test-* + prod-test-all   走真后端
    "test:smoke-cache": "node smoke-cache.js"
  }
  ```
  runner 负责：先 `python -m http.server 8777` + `wait-on http://localhost:8777`，再串行/并行跑指定 suite，统一汇总 exit code。CI 跑 `test:fast`。

### T-H5. 共用 helper 不存在 — 改一处要改 6 个文件
- **证据**: `pass/fail/snap/TINY_PNG` 在 `smoke.js / smoke-full.js / smoke-notify.js / smoke-legal.js / smoke-deep.js / smoke-cache.js / smoke-integration.js / verify-phone-pwa-shotwait.js` 各自重写一遍（Codex 列了 7 处行号，我又验了 1 处）。
- **修复**: 抽出 `tests/lib/{assert.js, png.js, snap.js, waitFor.js, fixtures.js}`。各脚本 `require('./tests/lib')`。一处修，全部修。

### T-H6. `smoke-cache.js` 名不副实 — 不跑 Worker 只 grep 字符串
- **证据**: `smoke-cache.js:3-4` 注释「不连真实 Worker」，`smoke-cache.js:17` `readFileSync` 扫 `worker/src/index.js`。
- **问题**: Worker 部署后 TTL/失效列表是否真生效**完全没测**。源码里写了 `getOrder: 3` 不代表 Cloudflare 边缘真按 3s TTL 缓存。
- **修复**: 改成（或新增）真正跑 staging Worker 的契约测试：连续打 `getStorefront`，检查 `X-Cache: HIT/MISS` 头；写入后立即读，验缓存确实失效。`pressure-test-concurrent-order.js:113-130` 已有雏形可抽。

### T-H7. 大量脚本无 server 自启 + 无健康检查
- **证据**: `smoke.js:16`、`smoke-full.js:14`、`smoke-deep.js:15` 都硬编码 `http://localhost:8777`，但脚本里都不查端口活没活。本地 server 没起就一堆 `net::ERR_CONNECTION_REFUSED`。
- **修复**: runner（T-H4）启动时 spawn `python -m http.server`，`wait-on tcp:8777`，跑完 kill 子进程。或脚本顶部加 `await fetch(BASE).catch(()=>{ console.error('server down'); process.exit(2); })`。

### T-H8. `prod-test-all.js` 打线上 prod + 留垃圾订单
- **证据**: `prod-test-all.js:8` (`tuantuan-push.keidev.workers.dev/api`)，`:245-249` 注释承认「admin 没法删个别订单，简单清理是改终态」。
- **问题**: 每次跑都给 prod sheet 留一批 `019000990xx` 测试电话的订单；真用户分析时被污染。
- **修复**:
  - 默认 **走 staging**，prod 模式必须显式 `--env=prod` 触发。
  - 给后端加一个 admin-only `cacheDelete_(TAB_ORDERS, 'phone', /^019000990/)` 的清理 endpoint，测试末尾真删行。
  - 或者：测试电话用 `isTest: true` 字段标，跑 `clearTestData` 一键清。

---

## 三、Medium（值得做，不阻塞）

### T-M1. Playwright 无 trace / video / requestfailed 监听 — 出错难复盘
- **证据**: 全部脚本都用 `chromium.launch({ headless: true })` + `ctx.newPage()`，没有 `context.tracing.start({ snapshots, screenshots, sources: true })`。失败时只能看最后一张截图猜。
- **修复**: lib 里的 fixture 默认开启 trace，失败时 `await context.tracing.stop({ path: 'shots/<scriptName>/trace.zip' })`。CI 上传 trace.zip 当 artifact。

### T-M2. 控制台错误只数不报警 — `smoke-full.js`
- **证据**: `smoke-full.js:41-45,495-497`，`errorsByPage` map 收集 pageerror/console error，最后只 `console.log(errs.length)`，不进 `findings.FAIL`。
- **修复**: 任何 pageerror 直接 `note('FAIL', ...)`；console-error 可白名单过滤（如 PWA install banner）后剩余的全 FAIL。

### T-M3. 13 个 Critical 缺陷只覆盖了 4 个的回归
- **覆盖情况**（Codex 给我的补充修正）：
  | Critical | 是否有回归 | 文件 |
  |---|---|---|
  | C1 锁竞态（非库存路径）| ❌ | — |
  | C2 状态机校验 | ⚠️ 部分 | `prod-test-all.js:100,121,197` 走 happy path，但**没测「pending → delivered 跳级」「rejected → 复活」**这种非法 transition 的拒绝 |
  | C3/C8 密码盐 / admin 明文 | ❌ | — |
  | C4 双击重复下单 | ❌ | — |
  | C5 NaN 库存 | ❌ | — |
  | C6 商家端 resetAll 全平台 | ❌ | — |
  | C7 PRO_PRICE=39 / MRR | ❌ | — |
  | C10 服务端价格信任 | ✅ | `prod-test-all.js:206,209` 验证服务端按菜单重算 |
  | C11 服务端费用信任 | ❌ | — |
  | C12 积分并发 | ❌ | — |
  | C13 硬编码 1234 | ❌ | — |
  | 库存并发抢 | ✅ | `pressure-test-concurrent-order.js`（不在 CI 里） |
  | 缓存失效 H2 | ✅ | 同上 |

- **修复**: 加一组 regression-bug.js，每个 Critical 一个最小 test，专门构造攻击 payload（如 `placeOrder` 带 `price: 0.01`、`packagingFee: 0`、状态从 `pending` 直接到 `delivered`），断言后端**必须拒绝**。这是 launch-block 级别的护城河。

### T-M4. 无视觉回归基线
- **证据**: 每个 smoke 都疯狂截图（光 `smoke-full-shots/` 就 22 张），但没有 baseline + diff（`pixelmatch` / Playwright snapshot）。
- **问题**: 截图只在出 bug 后人肉翻；改 CSS 颜色 / 布局漂移不会被自动发现。
- **修复**: 至少给 5 个关键页面（客户首页、商家订单列表、admin dashboard、checkout、status）加 `expect(page).toHaveScreenshot()` baseline。容差给宽松（如 0.5%）避免抗锯齿误报。

### T-M5. 无后端单元测试
- **证据**: `backend/Code.gs` 1609 行 / `worker/src/index.js` 614 行，没有任何 `*.test.js` 也没有 vitest config。所有覆盖都靠 integration smoke。
- **问题**: 改 `placeOrder_` 里某行算价格的逻辑 → 你只能整端到端跑一遍才知道有没有挂。
- **修复**:
  - Worker 部分：纯 JS，加 vitest，`miniflare` 模拟 Cloudflare 环境，单测 READ_TTL / INVALIDATION / CORS / push handler。
  - GAS 部分：把纯函数（`sanitize_`, `hashPwd_`, `priceCompute_`）抽出来到 `backend/lib/*.js`，用 Node 跑单测；GAS 里 `eval(LIB)` 引入。

### T-M6. `verify-*` 脚本里有 console.log('FAIL') 但不 exit
- **证据**: Codex 列了 `verify-hub-buildings.js:49,55,65`；我抽查 `verify-katherine-admin.js:18-19` 也是 `console.log(... ? 'PASS' : 'FAIL ...')` 不退出。
- **修复**: 抽 helper（T-H5），每个 fail 计数，文件末尾 `process.exit(failCount?1:0)`。

### T-M7. 没有 flaky 重试 + 超时控制
- **证据**: 整个流水线都是 `node smoke-xxx.js`，没有 `retry: 2`、没有「单 test 超时 60s」。一个 test 卡死整个流水线就停在那。
- **修复**: 用 Playwright Test Runner（`@playwright/test`）替换裸 `playwright` API，自带 retry、并行、timeout、HTML report。19 个脚本 → 一个 `playwright.config.js` + 一堆 `*.spec.js`。

### T-M8. 无 PWA / Lighthouse / a11y 自动断言
- **证据**: `smoke-deep.js` 注释里写「组 1 A11y — 键盘 / ARIA / 颜色对比」，但只是手撸 `evaluate(() => ...)` 看 outline；没接 `axe-playwright` 也没跑 Lighthouse CI。
- **修复**: 加 `axe-playwright`，三个页面各跑一遍，断言无 `serious/critical` violation。Lighthouse CI 给 PWA + Perf + A11y 一个分数 budget。

---

## 四、Low（锦上添花）

- **T-L1**: `test-flow.ps1` 直接打 prod GAS 写 `isTest:true` 订单 — 跟 prod-test-all 同源问题，重复同一污染。可以合并掉。
- **T-L2**: 没有 `WORKFLOW_REPORT.md` / `PRE_LAUNCH_TEST_REPORT.md` 提到的 79 个问题与 test 的关联表，建议在每个 Critical 修复 PR 里要求「附带回归 test 文件名」。
- **T-L3**: 多脚本各自 `page.clock.install`、各自 fix 「中午 12:15」，提到 lib 里。
- **T-L4**: `smoke-shots/` 文件名混用中英文（如 `I2-商家.png`），Windows ↔ Linux CI 之间可能乱码；统一成 ASCII。
- **T-L5**: 没有「测试覆盖率」概念。Critical 修了一个，能不能立刻知道哪些路径变绿？挂个简单的 `c8` / `nyc` 给前端 JS 收覆盖率。

---

## 五、立刻可执行的行动清单（按工时 × 影响排序）

| # | 行动 | 工时 | 影响 |
|---|---|---|---|
| 1 | **轮换 `katherineAdmin` 密码** + 把所有 ADMIN 常量改读 `process.env` | 30 min | 🔴 安全 |
| 2 | `smoke-full.js` 末尾加 `process.exit(failCount ? 1 : 0)`（T-C1） | 5 min | 🔴 阻断回归 |
| 3 | `pressure-test-e2e-flow.js` 包 `try/finally` 清理（T-C4） | 15 min | 🟠 数据污染 |
| 4 | `.github/workflows/test.yml` 新建 PR-gate，跑 `node smoke.js && node verify-poll-pause.js && node smoke-legal.js`（demo only，不依赖外网，3~5 min） | 1h | 🔴 上线门控 |
| 5 | 抽 `tests/lib/{assert,png,snap,server}.js` + 把 6 个 smoke 改成引用（T-H5） | 3h | 🟠 维护性 |
| 6 | 加 `npm run test:fast` runner + `wait-on` 健康检查（T-H4/T-H7） | 2h | 🟠 体验 |
| 7 | 写 12 个 regression-bug 测试（每个 Critical 一个，专测后端是否拒非法 payload）（T-M3） | 1d | 🔴 上线护城河 |
| 8 | `smoke-cache.js` 改成跑 staging Worker 看 `X-Cache` 头（T-H6） | 2h | 🟠 名实相符 |
| 9 | Playwright Test Runner 迁移 + trace artifact（T-M1/T-M7） | 4h | 🟡 可观测 |
| 10 | 接入 `axe-playwright` + Lighthouse CI budget（T-M8） | 3h | 🟡 质量 |

---

## 六、Claude × Codex 一致性

两边独立审计的**完全一致**结论（无分歧）：
- T-C1（smoke-full 永绿）、T-C2（CI 不跑测试）、T-C3（密码泄漏）、T-H3（shots 冲突）、T-H6（smoke-cache 名不副实）、T-H5（无 helper）

**Codex 补充我没看到**：
- T-C4（pressure-test-e2e-flow 清理不在 finally）— 已核实
- T-H1（`GAP?` / `INFO` 软标签）— 已核实
- T-H2（waitForTimeout 滥用规模）— 给了具体行号
- T-H8 数据污染细节（`prod-test-all.js:245-249` 自承）
- T-M6（verify-* 不 exit）
- 凭据泄漏范围（`verify-katherine-admin.js` 我漏了）

**我修正 Codex 的**：
- T-M3：Codex 说「C2 状态机已经覆盖」过宽，实际 `prod-test-all.js` 只走 happy-path transitions，**非法 transition 拒绝**没测。
- 我加了 13 个 Critical 一一对照表（Codex 没做这步）。

**没有需要互相驳斥的分歧。**

---

## 七、如果只做一件事

**把 `.github/workflows/test.yml` 加上**（T-C2），里面跑 demo-only 的快 suite（`smoke.js` + `smoke-legal.js` + `verify-poll-pause.js` + `verify-addrbook.js` + `verify-menu-search.js`，全是 demo 不需要外网），失败 block PR。

光这一步就能拦住未来 80% 的「改 store.js 一行结果客户下单挂了」类回归。其余优化可以 1~2 周慢慢补。

---

> 报告生成方式：
> - Claude (Opus 4.7) 独立审计 19 个测试文件 + CI + package.json，输出 7 个发现
> - Codex CLI (gpt-5-codex) 独立审计同一批文件，输出 9 + 7 (复核) 发现
> - Claude 核实 Codex 的两个最强 claim（smoke-full 不退出、cleanup 不在 finally），都为真
> - Claude 合并去重，输出本报告
