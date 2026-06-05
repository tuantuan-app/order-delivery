/*
 * tuantuan-push Worker —— 三合一边缘节点
 *
 *   ┌─────────────┐
 *   │  /push      │  Web Push VAPID 签名+转发（GAS 不能签 ECDSA → Worker 必备）
 *   │  /api       │  反向代理 + 边缘缓存（5 个高频读 stale-while-revalidate，GAS 负载 ↓80%）
 *   │  /health    │  存活检查 + 缓存命中率统计
 *   └─────────────┘
 *
 * 为什么 /api 存在：
 *   GAS 单次调用 2-3s + 90min/天配额。5 商家 × 大量 polling = 配额吃紧。
 *   CF 边缘缓存：100K 请求/天免费、Cache API 无上限、PoP 在新加坡/吉隆坡。
 *   N 个客户端轮询同一份订单 → 折叠成 1 次 GAS 调用，其余打边缘（50ms）。
 *   命中率预期 80%+，延迟从 2.5s → 50ms，体感"嗖"。
 *
 * 接口契约：
 *   POST /push  · X-Worker-Secret 鉴权 · VAPID 签名 + push service 转发
 *   POST /api   · 无鉴权（GAS URL 本来就公开）· 路由到 GAS_API_BASE 并缓存读
 *               白名单读：getOrder(3s) / getVendorOrders(5s) / getStorefront(60s) /
 *                        getOrdersByPhone(15s) / listHubs(3600s)
 *               写入：透传 + 命中相关缓存键 delete（短 TTL 兜底）
 *   GET  /health · 返回服务状态
 *
 * 用量估算（保守）：
 *   /push 单次 CPU ~3ms（ECDH + ECDSA + AES-GCM + HMAC）
 *   /api  单次 CPU ~1ms（缓存命中）/ ~3ms（穿透 + GAS 转发）
 *   CF 免费 100,000 请求/天 + 10ms CPU/请求
 *   现实用量（5 商家 × 真实流量）：
 *     - /push: 250/天 = 0.25% 配额
 *     - /api : 5000/天（多端轮询）= 5% 配额
 *     合计仍 < 6%，距撞墙远得很。
 */

// admin.html 内嵌（wrangler [[rules]] Text loader 把整段 HTML 当字符串导入）
// 为什么：admin.html 不再放 Pages（避免 https://tuantuan-app.github.io/admin.html 公开可达）。
// Worker 直接吐这份 bundle 内的副本，仍走 Basic Auth + CSP 注入。
// 同步策略：root 的 admin.html 是源；wrangler deploy 时 esbuild 把它编进 bundle。
// admin.html 改动 → 必须 wrangler deploy 才生效（admin.html 本身极少改，logic 在 admin.js）。
import EMBEDDED_ADMIN_HTML from '../../admin.html';

export default {
  async fetch(req, env) {
    // H20 fix: CORS 白名单（之前 '*' 任意站点都能 fetch 你的 Worker）。
    // OPTIONS 预检也要按 Origin 决定回响，否则浏览器拒绝跨站。
    const reqOrigin = req.headers.get('Origin') || '';
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }), reqOrigin);
    const url = new URL(req.url);

    // ---- Admin 工具：一次性清空 Sheet 数据（Basic Auth 保护 + workerSecret 转给 GAS） ----
    // 访问 https://tuantuan-push.keidev.workers.dev/admin/wipe → 浏览器弹密码框
    // 输入 admin 凭据 → Worker 调 GAS wipeAllData → 清表 → 返回 JSON
    if (url.pathname === '/admin/wipe') {
      // C22 fix: POST-only。防 CSRF：攻击者在受害者浏览器（已通过 Basic Auth）的页面里嵌
      // <img src="https://tuantuan-push.keidev.workers.dev/admin/wipe"> 就能触发 GET 清库；
      // 限定 POST 后必须自己构造 fetch，CORS 也会挡住跨站。
      if (req.method !== 'POST') {
        return new Response('Use POST. This endpoint is destructive — GET disabled to prevent CSRF.', { status: 405, headers: { 'Allow': 'POST' } });
      }
      const AUTH_USER = env.ADMIN_AUTH_USER || 'admin';
      const AUTH_PASS = env.ADMIN_AUTH_PASS || '';
      if (!AUTH_PASS) return new Response('AUTH not configured', { status: 500 });
      const auth = req.headers.get('Authorization');
      if (!auth || !checkBasicAuth(auth, AUTH_USER, AUTH_PASS)) {
        return new Response('Auth required', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="团团 Wipe"' },
        });
      }
      if (!env.GAS_API_BASE || !env.WORKER_SECRET) {
        return new Response('GAS_API_BASE/WORKER_SECRET not set', { status: 500 });
      }
      try {
        const r = await fetch(env.GAS_API_BASE, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify({ action: 'wipeAllData', workerSecret: env.WORKER_SECRET }),
        });
        const text = await r.text();
        return new Response('<pre>' + text + '</pre><p><a href="/admin">回到 admin</a></p>', {
          headers: { 'Content-Type': 'text/html;charset=utf-8' },
        });
      } catch (e) {
        return new Response('Wipe failed: ' + String(e), { status: 502 });
      }
    }

    // ---- Admin 入口（HTTP Basic Auth 保护）----
    // 访问 https://tuantuan-push.keidev.workers.dev/admin 需要输入通行码
    if (url.pathname === '/admin' || url.pathname === '/admin/') {
      const AUTH_USER = env.ADMIN_AUTH_USER || 'admin';
      const AUTH_PASS = env.ADMIN_AUTH_PASS || '';
      // H24 fix: fail-closed。之前 !AUTH_PASS 时直接 302 跳公开 admin.html，等于配置疏忽就完全没门。
      // 现在改为 500：宁可暂时挂掉 admin，也不能让未鉴权的人进。
      if (!AUTH_PASS) {
        return new Response('Admin authentication not configured (set ADMIN_AUTH_PASS in Worker env)', { status: 500 });
      }
      const auth = req.headers.get('Authorization');
      if (!auth || !checkBasicAuth(auth, AUTH_USER, AUTH_PASS)) {
        return new Response('Admin access requires authentication', {
          status: 401,
          headers: { 'WWW-Authenticate': 'Basic realm="团团 TuanTuan Admin"' },
        });
      }
      // admin.html 内嵌在 Worker bundle（不再 fetch Pages），原因：
      //   Pages 上不再存放 admin.html → tuantuan-app.github.io/admin.html 直接 404
      // 仍做两件事保持原行为：
      //   1. 注入 <base href="...Pages..."> 让相对路径 js/admin.js / styles.css 走 Pages
      //   2. 删 admin.html 原 CSP <meta>（HTTP 头版本更宽，允许从 Pages 加载 JS）
      let html = EMBEDDED_ADMIN_HTML;
      html = html.replace(/<meta\s+http-equiv=["']Content-Security-Policy["'][^>]*>\s*/i, '');
      // 防御性：admin.html 内自带的 "如果在 Pages → 跳 Worker" 守卫现在永远不会触发
      // （因为不再在 Pages），但留着不删（无害）
      html = html.replace('<head>', '<head><base href="https://tuantuan-app.github.io/">');
      const csp = "default-src 'self' https://tuantuan-app.github.io; "
                + "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://tuantuan-app.github.io; "
                + "style-src 'self' 'unsafe-inline' https://tuantuan-app.github.io; "
                + "img-src 'self' data: blob: https:; "
                + "connect-src 'self' https://script.google.com https://*.workers.dev https://*.googleusercontent.com; "
                + "font-src 'self' data: https://tuantuan-app.github.io; "
                + "object-src 'none'; frame-ancestors 'none'; base-uri 'self' https://tuantuan-app.github.io";
      return new Response(html, {
        headers: {
          'Content-Type': 'text/html;charset=utf-8',
          'Cache-Control': 'no-cache',
          'Content-Security-Policy': csp,
          'X-Content-Type-Options': 'nosniff',
          'X-Frame-Options': 'DENY',
          'Referrer-Policy': 'no-referrer',
        }
      });
    }

    if (url.pathname === '/health') {
      return cors(json({ ok: true, ts: Date.now(), service: 'tuantuan-push', endpoints: ['/push', '/api', '/health'], cron: ['hourly health check'] }), reqOrigin);
    }

    // 手动触发健康检查（admin 可在 admin.html 调用，绕过 1h cron 等候）
    // H25 fix: 加 Basic Auth。之前匿名可调 → 任何人能远程烧 GAS 配额（每次调用 GAS ~2-3s）。
    if (url.pathname === '/check' && req.method === 'POST') {
      const AUTH_USER = env.ADMIN_AUTH_USER || 'admin';
      const AUTH_PASS = env.ADMIN_AUTH_PASS || '';
      if (!AUTH_PASS) return cors(json({ ok: false, error: 'admin auth not configured' }, 500), reqOrigin);
      const auth = req.headers.get('Authorization');
      if (!auth || !checkBasicAuth(auth, AUTH_USER, AUTH_PASS)) {
        return cors(new Response('Auth required', { status: 401, headers: { 'WWW-Authenticate': 'Basic realm="团团 Check"' } }), reqOrigin);
      }
      return cors(json(await runHealthCheck(env)), reqOrigin);
    }
    if (url.pathname === '/api') {
      return cors(await handleApi(req, env), reqOrigin);
    }
    if (url.pathname !== '/push' || req.method !== 'POST') {
      return cors(json({ ok: false, error: 'not found' }, 404), reqOrigin);
    }

    // 鉴权
    const secret = req.headers.get('X-Worker-Secret') || '';
    if (!env.WORKER_SECRET || secret !== env.WORKER_SECRET) {
      return cors(json({ ok: false, error: 'unauthorized' }, 401), reqOrigin);
    }

    // 解析 body
    let body;
    try { body = await req.json(); } catch { return cors(json({ ok: false, error: 'invalid json' }, 400), reqOrigin); }
    const { subscription, payload, ttl, urgency } = body || {};
    if (!subscription || !subscription.endpoint || !subscription.keys) {
      return cors(json({ ok: false, error: 'subscription required' }, 400), reqOrigin);
    }
    if (!env.VAPID_JWK || !env.VAPID_PUBLIC || !env.VAPID_SUBJECT) {
      return cors(json({ ok: false, error: 'worker not configured (missing VAPID secrets)' }, 500), reqOrigin);
    }

    try {
      const r = await sendWebPush({
        subscription,
        payload: String(payload == null ? '' : payload),
        ttl: Number.isFinite(ttl) ? ttl : 86400,
        urgency: urgency || 'normal',
        vapidJwk: JSON.parse(env.VAPID_JWK),
        vapidPublic: env.VAPID_PUBLIC,
        vapidSubject: env.VAPID_SUBJECT,
      });
      const ok = r.status >= 200 && r.status < 300;
      return cors(json({ ok, status: r.status, body: r.body }, 200), reqOrigin);
    } catch (e) {
      console.error('push error', e);
      return cors(json({ ok: false, error: String((e && e.message) || e) }, 500), reqOrigin);
    }
  },

  // Cron Triggers 入口（wrangler.toml 配置每小时触发）
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runHealthCheck(env).then((r) => {
      // 日志可在 `wrangler tail` 看见
      console.log('[cron]', new Date().toISOString(), JSON.stringify(r).slice(0, 200));
    }));
  },
};

// ============================================================
// CORS + JSON helpers
// ============================================================
function checkBasicAuth(header, user, pass) {
  try {
    const b64 = header.replace(/^Basic\s+/i, '');
    const creds = atob(b64).split(':');
    return creds[0] === user && creds[1] === pass;
  } catch { return false; }
}

// H20 fix: CORS Origin 白名单。只允许 Pages 生产域 + 本地测试 + 任何 *.workers.dev（自己反代回自己）。
// Worker 端点本身没 cookie/auth-state（用 token in body），CORS 主要防：让你的 Worker 被别人挂着免费用。
const CORS_ALLOW = new Set([
  'https://tuantuan-app.github.io',
  'http://localhost:8777',
  'http://127.0.0.1:8777',
]);
function corsOrigin(origin) {
  if (!origin) return ''; // 同源 / 无 Origin → 无需设头
  if (CORS_ALLOW.has(origin)) return origin;
  // workers.dev 自反代（admin 网关 fetch /api）也放行
  try { if (new URL(origin).hostname.endsWith('.workers.dev')) return origin; } catch (_) {}
  return '';
}
function cors(res, origin) {
  const allow = corsOrigin(origin || '');
  if (allow) {
    res.headers.set('Access-Control-Allow-Origin', allow);
    res.headers.set('Vary', 'Origin');
  }
  res.headers.set('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Worker-Secret, Authorization');
  return res;
}
function json(o, status = 200) {
  return new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });
}

// ============================================================
// Web Push 主流程：签 JWT → 加密 payload → POST 到 push service
// ============================================================
async function sendWebPush({ subscription, payload, ttl, urgency, vapidJwk, vapidPublic, vapidSubject }) {
  const endpoint = subscription.endpoint;
  const aud = new URL(endpoint).origin;

  // 1) VAPID JWT
  const jwt = await signVapidJwt({ aud, sub: vapidSubject, jwk: vapidJwk });

  // 2) 加密 payload（aes128gcm scheme，RFC 8291）
  const ciphertext = await encryptAes128Gcm({
    payload,
    userPublic: subscription.keys.p256dh,
    userAuth: subscription.keys.auth,
  });

  // 3) POST 到 endpoint
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Authorization': `vapid t=${jwt}, k=${vapidPublic}`,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      'TTL': String(ttl),
      'Urgency': urgency,
    },
    body: ciphertext,
  });
  let txt = '';
  try { txt = await res.text(); } catch {}
  return { status: res.status, body: txt.slice(0, 300) };
}

// ============================================================
// VAPID JWT：ECDSA P-256 + SHA-256 → ES256
// ============================================================
async function signVapidJwt({ aud, sub, jwk }) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const exp = Math.floor(Date.now() / 1000) + 12 * 3600; // 12 小时有效
  const claims = { aud, exp, sub: sub || 'mailto:noreply@example.com' };
  const encB64 = (o) => b64u(new TextEncoder().encode(JSON.stringify(o)));
  const signingInput = `${encB64(header)}.${encB64(claims)}`;

  const key = await crypto.subtle.importKey(
    'jwk',
    { ...jwk, key_ops: ['sign'] },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput)
  );
  return `${signingInput}.${b64u(new Uint8Array(sig))}`;
}

// ============================================================
// aes128gcm 加密（RFC 8291 单 record）
// 输出 = salt(16) || rs(4,BE)=4096 || idlen(1)=65 || asPub(65) || ciphertext
// ============================================================
async function encryptAes128Gcm({ payload, userPublic, userAuth }) {
  const uaPub = b64uDecode(userPublic);   // 65B uncompressed
  const uaAuth = b64uDecode(userAuth);    // 16B
  const plain = new TextEncoder().encode(payload);

  // 应用端临时 ECDH 密钥对
  const epk = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPubRaw = new Uint8Array(await crypto.subtle.exportKey('raw', epk.publicKey));

  // 导入用户公钥
  const uaPubKey = await crypto.subtle.importKey(
    'raw', uaPub,
    { name: 'ECDH', namedCurve: 'P-256' },
    false, []
  );

  // ECDH 共享密钥（32B）
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: uaPubKey }, epk.privateKey, 256
  ));

  // —— RFC 8291 双层 HKDF ——
  // 1) PRK_key = HMAC-SHA256(auth_secret, ECDH_secret)
  const prkKey = await hmac(uaAuth, ecdh);
  // info = "WebPush: info\0" || ua_public || as_public
  const info1 = concat(new TextEncoder().encode('WebPush: info\0'), uaPub, asPubRaw);
  // IKM = HKDF-Expand(PRK_key, info1, 32)
  const ikm = await hkdfExpand(prkKey, info1, 32);

  // 2) PRK = HMAC-SHA256(salt, IKM)
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);

  // CEK = HKDF-Expand(PRK, "Content-Encoding: aes128gcm\0", 16)
  const cekRaw = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  // Nonce = HKDF-Expand(PRK, "Content-Encoding: nonce\0", 12)
  const nonce = await hkdfExpand(prk, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);

  // pad: payload || 0x02 (last record delimiter)
  const padded = new Uint8Array(plain.length + 1);
  padded.set(plain, 0);
  padded[plain.length] = 0x02;

  // AES-128-GCM 加密
  const cekKey = await crypto.subtle.importKey('raw', cekRaw, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce }, cekKey, padded
  ));

  // 拼装 header：salt(16) + rs(4,BE) + idlen(1)=65 + asPub(65)
  const rs = 4096;
  const head = new Uint8Array(16 + 4 + 1 + 65);
  head.set(salt, 0);
  head[16] = (rs >>> 24) & 0xff;
  head[17] = (rs >>> 16) & 0xff;
  head[18] = (rs >>> 8)  & 0xff;
  head[19] = rs          & 0xff;
  head[20] = 65;
  head.set(asPubRaw, 21);

  return concat(head, cipher);
}

// ============================================================
// HKDF / HMAC / 编解码 工具
// ============================================================
async function hmac(keyBytes, data) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, data));
}
async function hkdfExpand(prk, info, length) {
  // 单 block 够用（length <= 32）
  if (length <= 32) {
    const t = await hmac(prk, concat(info, new Uint8Array([0x01])));
    return t.slice(0, length);
  }
  // 多 block 兜底
  let out = new Uint8Array(0);
  let prev = new Uint8Array(0);
  let i = 1;
  while (out.length < length) {
    prev = await hmac(prk, concat(prev, info, new Uint8Array([i])));
    out = concat(out, prev);
    i++;
  }
  return out.slice(0, length);
}
function concat(...arrs) {
  let total = 0;
  for (const a of arrs) total += a.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const a of arrs) { out.set(a, off); off += a.length; }
  return out;
}
function b64u(buf) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uDecode(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// ============================================================
// /api 反向代理 + 边缘缓存（stale-while-revalidate）
// ============================================================
//
// 设计：
//   - 缓存层：CF Cache API（caches.default），免费 + 无大小限制 + region-local
//   - 缓存键：合成 URL，把 action + 关键参数排序拼成 query string
//   - 命中：读 cache，返回 + X-Cache: HIT 头便于调试
//   - 未命中：fetch GAS，缓存（仅当响应 ok=true），返回 + X-Cache: MISS
//   - 写入：透传 GAS，成功后 explicit delete 相关缓存键
//   - 失败：透传错误响应，不缓存
//
// 客户端契约（详见 js/api.js）：
//   - 浏览器 POST 到 /api，body = { action, ...原参数 }
//   - 响应 = 同 GAS /exec 的 JSON
//   - 客户端 try /api → 失败时 fallback 到 GAS 直连（graceful degradation）
//
// 缓存键策略（必须可被「写」精确反向构造）：
//   getOrder?orderId=X            → key: a=getOrder&orderId=X
//   getVendorOrders?vendorId=Y    → key: a=getVendorOrders&vendorId=Y
//   getStorefront?vendorId=Y      → key: a=getStorefront&vendorId=Y
//   getOrdersByPhone?phone=Z      → key: a=getOrdersByPhone&phone=Z
//   listHubs                      → key: a=listHubs
//
// 写入失效映射：
//   placeOrder(order)           → invalidate {orderId, vendorId, phone} 对应的 3 个 key
//   updateOrderStatus(orderId)  → invalidate getOrder({orderId})（其它靠短 TTL 自然过期）
//   cancelOrder(orderId)        → 同上
//   attachScreenshot(orderId)   → 同上
//   saveProduct/Vendor*         → invalidate getStorefront({vendorId})
//   addHubBuilding/saveHub/etc  → invalidate listHubs
//
// 客户端读后写场景的一致性：
//   写完立刻读 → cache 已 delete → 必穿透到 GAS 拿最新 → ✓

const READ_TTL = {
  getOrder: 3,
  getVendorOrders: 5,
  getStorefront: 60,
  getOrdersByPhone: 15,
  listHubs: 3600,
  listPublicVendors: 30, // 客户端首页 — 30s TTL 平衡刷新感和缓存
  getMembership: 30,     // M22 fix: 结算页一笔订单常查 2-3 次，30s TTL 全吃边缘
};

const READ_KEY_FIELDS = {
  getOrder: ['orderId'],
  getVendorOrders: ['vendorId'],
  getStorefront: ['vendorId'],
  getOrdersByPhone: ['phone'],
  listHubs: [],
  listPublicVendors: [],
  getMembership: ['vendorId', 'phone'], // 按 vendor+phone 唯一定位
};

// 写入 → 受影响缓存键。返回 [{ action, ...params }] 数组
const INVALIDATION = {
  placeOrder: (b) => {
    const o = (b && b.order) || {};
    return [
      { action: 'getOrder', orderId: o.orderId },
      { action: 'getVendorOrders', vendorId: o.vendorId },
      { action: 'getOrdersByPhone', phone: o.phone },
      // 🐛 H2 补漏：之前 placeOrder 没失效 getStorefront → 库存扣减后客户看到旧 stock
      // 真实场景：顾客 A 抢走最后 1 份 → 顾客 B 60s 内仍看到 stock=1 → 下单失败 → 体验差
      { action: 'getStorefront', vendorId: o.vendorId },
    ].filter(x => Object.values(x).every(v => v != null && v !== ''));
  },
  // 取消/拒单同样会恢复库存 → 也要失效 getStorefront
  cancelOrder: (b) => ([
    { action: 'getOrder', orderId: b && b.orderId },
    { action: 'getVendorOrders', vendorId: b && b.vendorId },
    { action: 'getStorefront', vendorId: b && b.vendorId },
  ]).filter(x => x.orderId || x.vendorId),
  // H2 fix: 之前 updateOrderStatus 只失效 getOrder，没失效 getVendorOrders → 商家界面
  // 看到的订单列表里状态可能是缓存的旧值。saveVendorConfig 同理：商家改店设置后，
  // 客户端 listPublicVendors 还是旧 open/hub 状态。再补几个 admin 楼栋操作。
  updateOrderStatus: (b) => ([
    { action: 'getOrder', orderId: b && b.orderId },
    { action: 'getVendorOrders', vendorId: b && b.vendorId },
    // 拒单会恢复库存（H16 fix）→ 也要失效 getStorefront
    { action: 'getStorefront', vendorId: b && b.vendorId },
  ]).filter(x => x.orderId || x.vendorId),
  // cancelOrder 移到 placeOrder 同区（含 getStorefront 失效），删除重复声明
  attachScreenshot: (b) => ([
    { action: 'getOrder', orderId: b && b.orderId },
    { action: 'getVendorOrders', vendorId: b && b.vendorId },
  ]).filter(x => x.orderId || x.vendorId),
  saveProduct: (b) => ([{ action: 'getStorefront', vendorId: b && b.vendorId }]).filter(x => x.vendorId),
  updateProduct: (b) => ([{ action: 'getStorefront', vendorId: b && b.vendorId }]).filter(x => x.vendorId),
  removeProduct: (b) => ([{ action: 'getStorefront', vendorId: b && b.vendorId }]).filter(x => x.vendorId),
  saveVendorConfig: (b) => ([
    { action: 'getStorefront', vendorId: b && b.vendorId },
    { action: 'listPublicVendors' }, // 公开商家列表 (open/hub/plan) 可能变了
  ]).filter(x => x.vendorId || x.action === 'listPublicVendors'),
  saveVendorPlan: (b) => ([
    { action: 'getStorefront', vendorId: b && b.vendorId },
    { action: 'listPublicVendors' },
  ]).filter(x => x.vendorId || x.action === 'listPublicVendors'),
  addHubBuilding: () => ([{ action: 'listHubs' }]),
  saveHub: () => ([{ action: 'listHubs' }]),
  removeHub: () => ([{ action: 'listHubs' }]),
  // H2 fix: 之前漏了 admin 楼栋删除/批量保存 → 客户端楼栋下拉残留
  removeHubBuilding: () => ([{ action: 'listHubs' }]),
  saveHubBuildings: () => ([{ action: 'listHubs' }]),
  // admin 增删改商家 → 影响公开商家列表
  upsertVendor: () => ([{ action: 'listPublicVendors' }]),
  removeVendor: () => ([{ action: 'listPublicVendors' }]),
};

function buildCacheRequest(action, params) {
  // CF Cache API 用 Request 做 key。合成一个稳定 URL：参数按 key 字典序拼接
  const u = new URL('https://cache.internal/api');
  u.searchParams.set('a', action);
  Object.keys(params).sort().forEach(k => {
    if (params[k] != null && params[k] !== '') u.searchParams.set(k, String(params[k]));
  });
  return new Request(u.toString(), { method: 'GET' });
}

async function forwardToGAS(gasUrl, body) {
  return fetch(gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
  });
}

async function handleApi(req, env) {
  if (req.method !== 'POST') return json({ ok: false, error: 'method not allowed' }, 405);
  if (!env.GAS_API_BASE) return json({ ok: false, error: 'GAS_API_BASE not configured (wrangler secret put GAS_API_BASE)' }, 500);

  let body;
  try { body = await req.json(); } catch { return json({ ok: false, error: 'invalid json' }, 400); }
  const action = body && body.action;
  if (!action) return json({ ok: false, error: 'action required' }, 400);

  // ===== READ 路径 =====
  if (READ_TTL[action]) {
    const ttl = READ_TTL[action];
    const fields = READ_KEY_FIELDS[action];
    const keyParams = {};
    fields.forEach(f => { keyParams[f] = body[f]; });
    const key = buildCacheRequest(action, keyParams);

    // 缓存命中？
    const hit = await caches.default.match(key);
    if (hit) {
      const text = await hit.text();
      return new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'X-Cache': 'HIT', 'X-Cached-TTL': String(ttl) },
      });
    }

    // 穿透到 GAS
    let upstream;
    try { upstream = await forwardToGAS(env.GAS_API_BASE, body); }
    catch (e) { return json({ ok: false, error: 'upstream fetch failed: ' + (e && e.message || e) }, 502); }
    const text = await upstream.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    // 只缓存 ok=true 的成功响应
    if (parsed && parsed.ok) {
      const toCache = new Response(text, {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=' + ttl },
      });
      try { await caches.default.put(key, toCache); } catch (_) { /* cache put failed: ignore */ }
    }
    return new Response(text, {
      status: upstream.status,
      headers: { 'Content-Type': 'application/json', 'X-Cache': 'MISS', 'X-Cached-TTL': String(ttl) },
    });
  }

  // ===== WRITE 路径 =====
  if (INVALIDATION[action]) {
    let upstream;
    try { upstream = await forwardToGAS(env.GAS_API_BASE, body); }
    catch (e) { return json({ ok: false, error: 'upstream fetch failed: ' + (e && e.message || e) }, 502); }
    const text = await upstream.text();
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    if (parsed && parsed.ok) {
      const targets = INVALIDATION[action](body) || [];
      const purged = [];
      for (const t of targets) {
        const a = t.action;
        const params = {};
        Object.keys(t).forEach(k => { if (k !== 'action') params[k] = t[k]; });
        try {
          const r = await caches.default.delete(buildCacheRequest(a, params));
          purged.push({ key: a, params, purged: r });
        } catch (e) { purged.push({ key: a, params, error: String(e) }); }
      }
      return new Response(text, {
        status: upstream.status,
        headers: { 'Content-Type': 'application/json', 'X-Invalidated': JSON.stringify(purged.map(p => p.key + (p.purged ? '✓' : '✗'))) },
      });
    }
    return new Response(text, { status: upstream.status, headers: { 'Content-Type': 'application/json' } });
  }

  // ===== 未识别 action：透传不缓存（auth / admin 等）=====
  let upstream;
  try { upstream = await forwardToGAS(env.GAS_API_BASE, body); }
  catch (e) { return json({ ok: false, error: 'upstream fetch failed: ' + (e && e.message || e) }, 502); }
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'Content-Type': 'application/json', 'X-Cache': 'BYPASS' },
  });
}

// ============================================================
// 健康检查（Cron 每小时触发 + admin 可手动 /check 触发）
// ============================================================
//
// 策略：
//   1. Worker 调 GAS systemSelfCheck（带 WORKER_SECRET 鉴权）
//   2. GAS 内部检查（Sheet 访问 / 配额 / 数据量 / 失效订阅）
//   3. GAS 发现异常 → 自动 pushNotify_ 给所有 role='admin' 订阅
//   4. Worker 兜底：如果 GAS 不可达，记日志（wrangler tail 可看）
//
// 防告警轰炸：
//   - GAS 端 tag 按"小时桶"去重（同样错误 1 小时内只推一次）
//   - 恢复时（之前有问题、现在没有）也发一条 ✅ 消息
//
// 完全 0 成本：
//   - Cron 24 次/天 = Workers 配额 0.024%
//   - 每次调用 ~1 个 fetch + ~1 个 push = CPU < 5ms
//
// 可观测性：
//   - wrangler tail 实时看 cron 输出
//   - admin.html 「📊 系统配额监控」面板看
//   - CF dashboard → Worker → Triggers 看历史执行

async function runHealthCheck(env) {
  if (!env.GAS_API_BASE || !env.WORKER_SECRET) {
    return { ok: false, error: 'GAS_API_BASE or WORKER_SECRET not configured' };
  }
  const t0 = Date.now();
  try {
    const resp = await fetch(env.GAS_API_BASE, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'systemSelfCheck', workerSecret: env.WORKER_SECRET }),
    });
    const ms = Date.now() - t0;
    let body;
    try { body = await resp.json(); } catch (e) { body = { ok: false, error: 'invalid json: ' + (await resp.text()).slice(0, 100) }; }
    return {
      ok: !!(body && body.ok),
      ms: ms,
      issues: (body && body.issues) || [],
      summary: (body && body.summary) || {},
      gasReachable: true,
      slow: ms > 10000,
    };
  } catch (e) {
    // GAS 完全不可达——这是最严重情况
    return {
      ok: false,
      ms: Date.now() - t0,
      gasReachable: false,
      error: 'GAS unreachable: ' + ((e && e.message) || e),
    };
  }
}
