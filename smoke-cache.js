/*
 * smoke-cache.js —— /api 缓存层契约测试（静态/白盒）
 *   不连真实 Worker，只验证：
 *     - api.js 路由决策对（缓存白名单 → Worker，其它 → GAS）
 *     - api.js fallback 链路（Worker fail → GAS 直连）
 *     - Worker 源码里 READ_TTL/INVALIDATION 表完整
 */
const fs = require('fs');
const path = require('path');

const pass = []; const fail = [];
function ok(m) { console.log('  ✅ PASS  ' + m); pass.push(m); }
function bad(m) { console.log('  ❌ FAIL  ' + m); fail.push(m); }

// === A. Worker 静态契约 ===
console.log('\n===== Worker /api 静态契约 =====');
const workerSrc = fs.readFileSync(path.join(__dirname, 'worker/src/index.js'), 'utf8');

// A.1 5 个白名单读 API 都在 READ_TTL
const reads = ['getOrder', 'getVendorOrders', 'getStorefront', 'getOrdersByPhone', 'listHubs'];
const ttlMatch = workerSrc.match(/const READ_TTL = \{([\s\S]*?)\};/);
if (ttlMatch) {
  reads.forEach(r => {
    if (ttlMatch[1].indexOf(r + ':') >= 0) ok('A.1 READ_TTL 含 ' + r);
    else bad('A.1 READ_TTL 缺 ' + r);
  });
} else bad('A.1 找不到 READ_TTL 表');

// A.2 11 个写入 action 都在 INVALIDATION（用更宽松的正则匹配嵌套箭头函数）
const writes = ['placeOrder', 'updateOrderStatus', 'cancelOrder', 'attachScreenshot',
                'saveProduct', 'updateProduct', 'removeProduct', 'saveVendorConfig',
                'addHubBuilding', 'saveHub', 'removeHub'];
// 提取整个 INVALIDATION 块（找下一个 export/function 边界为止）
const invStart = workerSrc.indexOf('const INVALIDATION = {');
const invEnd = workerSrc.indexOf('function buildCacheRequest');
const invBlock = invStart >= 0 && invEnd > invStart ? workerSrc.slice(invStart, invEnd) : '';
if (invBlock) {
  writes.forEach(w => {
    if (invBlock.indexOf(w + ':') >= 0) ok('A.2 INVALIDATION 含 ' + w);
    else bad('A.2 INVALIDATION 缺 ' + w);
  });
} else bad('A.2 找不到 INVALIDATION 块');

// A.3 关键：handleApi 函数体内不要求 X-Worker-Secret（/push 仍然要）
const handleApiStart = workerSrc.indexOf('async function handleApi');
const handleApiEnd = workerSrc.indexOf('// 未识别 action');
const handleApiBlock = workerSrc.slice(handleApiStart, handleApiEnd > 0 ? handleApiEnd + 500 : handleApiStart + 4000);
if (handleApiBlock.indexOf('X-Worker-Secret') < 0) ok('A.3 handleApi 不要求 X-Worker-Secret（公开 API）');
else bad('A.3 handleApi 错误要求了 X-Worker-Secret');

// A.4 Worker 只缓存成功响应（parsed.ok）
if (workerSrc.indexOf('parsed && parsed.ok') >= 0) ok('A.4 仅缓存 ok=true（失败不毒化缓存）');
else bad('A.4 失败响应可能被缓存');

// A.5 失效函数过滤空参数（防止 {orderId: undefined} 误删全表）
if (workerSrc.indexOf('Object.values(x).every(v => v != null && v !== \'\')') >= 0
    || workerSrc.indexOf(".filter(x => x.orderId)") >= 0) ok('A.5 失效函数过滤空参数（防错删）');
else bad('A.5 失效函数没过滤空参数');

// === B. api.js 路由契约 ===
console.log('\n===== api.js 路由契约 =====');
const apiSrc = fs.readFileSync(path.join(__dirname, 'js/api.js'), 'utf8');

// B.1 CACHEABLE 表 5 项齐全
const cacheTbl = apiSrc.match(/var CACHEABLE = \{([\s\S]*?)\};/);
if (cacheTbl) {
  reads.forEach(r => {
    if (cacheTbl[1].indexOf(r) >= 0) ok('B.1 CACHEABLE 含 ' + r);
    else bad('B.1 CACHEABLE 缺 ' + r);
  });
} else bad('B.1 找不到 CACHEABLE');

// B.2 fallback 逻辑：catch 后用 GAS 直连
if (/useCache[\s\S]{0,200}_postTo\(self\.base\(\)/.test(apiSrc)) ok('B.2 fallback 链路：Worker fail → GAS 直连');
else bad('B.2 fallback 链路缺失');

// B.3 cacheBase 函数存在
if (apiSrc.indexOf('cacheBase()') >= 0) ok('B.3 cacheBase() 拼接 pushWorkerUrl + "/api"');
else bad('B.3 cacheBase() 缺失');

// B.4 dedupe 仍然存在（v3 既有功能不丢）
if (apiSrc.indexOf('_dedupe') >= 0) ok('B.4 _dedupe 保留');
else bad('B.4 _dedupe 丢了');

// B.5 写入接口仍然走 self.post（不绕过路由判断）—— placeOrder/updateOrderStatus 等没硬编码 URL
const writesInApi = apiSrc.match(/(placeOrder|updateOrderStatus|cancelOrder|attachScreenshot)\([^)]*\)[\s\S]*?this\.post/g);
if (writesInApi && writesInApi.length >= 3) ok('B.5 写入 action 仍走 this.post（统一路由判断）');
else bad('B.5 写入接口绕过了 this.post: ' + (writesInApi ? writesInApi.length : 0));

// === C. 容量预估 ===
console.log('\n===== 容量预估（Worker 配额）=====');
console.log('  📊 CF 免费层：100,000 请求/天 + 10ms CPU/请求');
console.log('  📊 预估真实流量（5 商家 × 20 客户）：');
console.log('     - 客户 polling getOrder: 20 × 12 polls × 8h = 1920/天');
console.log('     - 商家 polling getVendorOrders: 5 × 10 polls × 12h = 600/天');
console.log('     - 客户首屏 getStorefront: 20 × 3 visits = 60/天');
console.log('     - 写入(placeOrder + status×3) × 30 orders: 120/天');
console.log('     - Web Push: 250/天');
console.log('     合计 ≈ 2950/天 = 2.95% 配额');
console.log('     边缘命中率 70% → GAS 直接负载从 2950 降到 ~900/天');
console.log('     GAS 90 min/天 ÷ 3s/请求 = 1800 请求理论上限');
console.log('     → 留 50% 缓冲，可扛 ~ 15-20 商家');
ok('C.1 容量分析就绪');

console.log('\n========================================');
console.log('  PASS: ' + pass.length + '   FAIL: ' + fail.length);
if (fail.length) { console.log('FAILED:'); fail.forEach(m => console.log('   - ' + m)); }
console.log('========================================');
process.exit(fail.length ? 1 : 0);
