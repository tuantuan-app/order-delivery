# tuantuan-push Worker

Web Push（VAPID）签名 + 转发，纯 Cloudflare Worker 免费层运行。

为什么需要这个 Worker：Google Apps Script 没有 ECDSA P-256，而 Web Push 协议（VAPID + aes128gcm）强制要它。CF Worker 的 Web Crypto API 原生支持。

---

## 一、首次部署（一次性，~10 分钟）

### 0. 前置条件

```bash
node --version    # 需要 >= 18
wrangler --version
wrangler whoami   # 应该能看到你的 Cloudflare 账号邮箱
```

如果还没装 wrangler / 还没登录：

```bash
npm install -g wrangler
wrangler login
```

### 1. 生成 VAPID 密钥 + Worker 鉴权串

```bash
cd worker
node scripts/gen-vapid.mjs
```

会输出 4 行字符串：`VAPID_JWK`、`VAPID_PUBLIC`、`WORKER_SECRET`、`VAPID_SUBJECT`。

⚠️ **绝对不要把它们提交进 git**。`.gitignore` 已经把 `worker/.dev.vars` 排除掉了；安全做法是马上把它们存进 Cloudflare（下一步），然后关掉终端。

> **PS**：如果你想让我（Claude）帮你生成一次（仅在你本机终端打印，不入仓库），运行：
> ```
> cd worker && node scripts/gen-vapid.mjs
> ```

### 2. 把 5 个值存为 Worker secret

依次跑下面 5 条，每条都会让你交互式输入对应那一行：

```bash
cd worker
wrangler secret put VAPID_JWK
# 粘贴：{"key_ops":["sign"],"ext":true,"kty":"EC",...} ← 上一步 #1 整段
wrangler secret put VAPID_PUBLIC
# 粘贴：BA-VEzn...                                    ← 上一步 #2
wrangler secret put WORKER_SECRET
# 粘贴：e7SzQDD...                                    ← 上一步 #3
wrangler secret put VAPID_SUBJECT
# 粘贴：mailto:katherinetan2003x@gmail.com           ← 上一步 #4
wrangler secret put GAS_API_BASE
# 粘贴：https://script.google.com/macros/s/AKfycb.../exec  ← /api 反向代理目标
```

> **`GAS_API_BASE` 是干嘛的**：Worker `/api` 端点反向代理到 GAS 并做边缘缓存。Worker 把客户端 POST 转给这个 URL。值 = `js/config.js` 里的 `PROD_API`。

### 3. 部署

```bash
wrangler deploy
```

会打印一行 URL，长这样：

```
Published tuantuan-push (X.XX sec)
  https://tuantuan-push.<你的子域>.workers.dev
```

**把那个 URL 记下来**，下一步要塞进 `js/config.js` 和 GAS PropertiesService。

### 4. 验证 Worker 活着

```bash
curl https://tuantuan-push.<你的子域>.workers.dev/health
# 期望：{"ok":true,"ts":...,"service":"tuantuan-push"}
```

### 5. 把 Worker URL 告诉前端 + 后端

**前端** `js/config.js` 增加两个字段：

```js
window.APP_CONFIG = {
  apiBase: '...',
  pushWorkerUrl: 'https://tuantuan-push.<你的子域>.workers.dev',
  vapidPublicKey: 'BA-VEzn...',   // 上一步 #2 同一个值
};
```

**后端** GAS Apps Script 编辑器里 → 项目设置 → 脚本属性，新建两条：

| Key | Value |
|---|---|
| `PUSH_WORKER_URL` | `https://tuantuan-push.<你的子域>.workers.dev` |
| `WORKER_SECRET` | `e7SzQDD...` ← 跟 Worker secret 那条值一模一样 |

---

## 二、日常使用

### 改 Worker 代码 → 重新部署

```bash
cd worker
wrangler deploy
```

### 看实时日志（调试用）

```bash
wrangler tail
```

### 修改某个 secret

```bash
wrangler secret put VAPID_JWK    # 会提示是否覆盖
```

### 看哪些 secret 已设置（不显示值）

```bash
wrangler secret list
```

---

## 三、调用方式

### `/push` —— GAS 后端自动调

```http
POST https://tuantuan-push.<域>.workers.dev/push
Content-Type: application/json
X-Worker-Secret: <WORKER_SECRET>

{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/...",
    "keys": { "p256dh": "...", "auth": "..." }
  },
  "payload": "{\"title\":\"备餐中\",\"body\":\"商家已接单\"}",
  "ttl": 86400,
  "urgency": "high"
}
```

### `/api` —— 浏览器自动走（边缘缓存反向代理）

```http
POST https://tuantuan-push.<域>.workers.dev/api
Content-Type: text/plain;charset=utf-8

{ "action": "getOrder", "orderId": "#abc12345" }
```

- **白名单读**（缓存）：`getOrder(3s)` / `getVendorOrders(5s)` / `getStorefront(60s)` / `getOrdersByPhone(15s)` / `listHubs(3600s)`
- **写入**（透传 + 失效）：`placeOrder` / `updateOrderStatus` / `cancelOrder` / `attachScreenshot` / `saveProduct`...
- 响应头 `X-Cache: HIT | MISS | BYPASS` 用于调试
- 响应头 `X-Invalidated: ["getOrder✓", "getVendorOrders✓"]` 显示写入命中了哪些缓存键
- **客户端 fallback**：如果 `/api` 失败，`js/api.js` 自动重试 GAS 直连（graceful degradation）

返回：

```json
{ "ok": true, "status": 201 }
```

`status: 404 / 410` 表示订阅已失效（用户卸载了浏览器/拒绝了通知），调用方应从数据库删除该订阅。

---

## 四、配额监控

CF Workers 免费层：100,000 请求/天 + 10ms CPU/请求。

预估单 Push CPU：~3ms。

5 商家 × 50 通知/日 = 250 请求/日 = **0.25% 配额**。

到 CF Dashboard → Workers & Pages → `tuantuan-push` → Metrics 看实际用量。
