# 架构分析 · GAS vs Cloudflare 分工

最后审计：2026-05-30 · 当前部署：纯 GAS + Push Worker(VAPID 签名)

---

## TL;DR（看这一段就行）

| 优先级 | 改动 | 收益 | 工作量 |
|---|---|---|---|
| **现在不动** | 当前架构 | 5-7 商家完全 hold 得住 | 0 |
| **触发线 #1**：单日 GAS 时长 > 50 min（admin 监控面板会自己告警） | 加 Worker 读缓存（5 个高频读 API） | GAS 负载 ↓ 60-80%，读延迟 2.5s → 0.3s | 1 天 |
| **触发线 #2**：单日 GAS 时长 > 70 min 或商家 > 10 家 | 加 GAS 内部 CacheService + 批量接口 | GAS 进一步 ↓ 30% | 0.5 天 |
| **触发线 #3**：> 30 商家 | 完整迁移到 Worker + D1/KV | 0 GAS 依赖、可扛百级商家 | 1 周 |

不要提前优化。**先让 admin 配额面板告诉你撞线了**再动手。

---

## 一、当前架构（事实陈述）

```
浏览器 ──HTTPS──→ GAS /exec  (所有 API)
浏览器 ──HTTPS──→ CF Worker /push  (仅 VAPID 签名)
GAS ──── UrlFetchApp ────→ CF Worker /push  (推送给客户/商家)
```

**关键事实**：
- GAS 免费配额：**90 min/天**总执行时长（不是请求数）
- 单次 GAS 调用从握手到返回 ≈ **2-3 秒**（HTTP RTT + GAS 冷启动 + Sheet 读写）
- CF Worker：100K 请求/天，每请求 10ms CPU
- 我们的 push Worker 单次 CPU ≈ 3ms（ECDH + ECDSA + AES-GCM）

---

## 二、按 API 分类（写 vs 读 × 频率 × 实时性需求）

### A. 强写入 —— 必须 GAS、不可缓存

| API | 用途 | 频率 | 后果若延迟 |
|---|---|---|---|
| `placeOrder` | 下单 | 客户主动 | 重复下单 / 超卖 |
| `attachScreenshot` | 补传支付凭证 | 后台 | 商家看不到付款证据 |
| `updateOrderStatus` | 接单/拒单/送达 | 商家点击 | 客户看不到状态 |
| `cancelOrder` | 取消 | 客户主动 | 库存不回 / 积分不退 |
| `saveProduct/Product/removeProduct` | 上架/下架 | 商家偶发 | 卖了下架商品 |
| `saveVendorConfig` | 改设置 | 商家偶发 | 配置不生效 |
| `saveSubscription` | 推送订阅落库 | 客户首次允许 | 通知发不出去 |
| `vendorLogin/adminLogin` | 认证 | 偶发 | 安全风险 |
| 管理员所有 `save/upsert/remove` | 内部 | 极低频 | — |

**结论**：写入全部走 GAS。CF Worker 不碰这些。

### B. 单用户热读 —— GAS，但**可加 30s GAS 内部缓存**

| API | 当前调用频率 | 实时性需求 | 改造建议 |
|---|---|---|---|
| `getMembership` | 结算前 1 次 | 高（积分不能错） | 不动 |
| `getOrdersByPhone` | 「我的订单」tab 打开 + 切回前台 | 中（30s 内可接受） | GAS 内 `CacheService` 缓存 15s（按 phone） |

### C. 高频轮询读 —— **Cloudflare Worker 缓存收益最大**

这是改造性价比最高的一组。

| API | 当前轮询 | 单次延迟 | 单店每天调用数 | 边缘缓存 TTL |
|---|---|---|---|---|
| `getOrder` | pending 5s / cooking 15s / delivering 8s | 2-3s | ~300 | **3s**（短 TTL，stale-while-revalidate） |
| `getVendorOrders` | hasPending 8s / hasActive 12s / idle 30s | 2-3s | ~1500 | **5s**（同上） |
| `getStorefront` | 首屏打开 + 偶发刷新 | 2-3s | ~50 (按店) | **60s**（菜单变动不密） |

**为什么 stale-while-revalidate 关键**：
- 用户看到 3 秒前的状态，**完全可接受**（外卖场景没人 1 秒一刷）
- 同时 Worker 后台触发新的 fetch，下一次请求是最新的
- 用户感知延迟：**3s → 50ms**（CF 边缘 PoP 在新加坡/吉隆坡）

### D. 全局静态读 —— **Worker KV 长缓存**

| API | 用途 | 改动多频繁 | 缓存 TTL |
|---|---|---|---|
| `listHubs` | 地址簿楼栋池 | 几乎从不（管理员添加楼栋） | **1h** + 写入时 purge |
| `listAllOrders` (admin) | 后台报表 | 实时性差点没关系 | **30s** |
| `listVendors` (admin) | 后台 | 偶发 | **5min** |
| `listPayments` (admin) | 后台 | 几乎从不 | **5min** |

### E. 一次性写入 —— 不优化

`addPayment`、`saveVendorPlan`、`saveHub`、`addHubBuilding`、`removeHub`、`upsertVendor` —— admin 偶发，量小，留着原样。

### F. 监控/工具 —— 不优化

`health`、`getSystemUsage`、`clearTestData`、`resetSeedData`、`testPush` —— admin 自用，量小。

---

## 三、缓存失效（Cache Invalidation）

**这是最容易写错的部分**。每个写入要 purge 相关的读缓存：

| 写入 | 必须 purge |
|---|---|
| `placeOrder` | `getOrder(orderId)` ⨯`getVendorOrders(vid)` ⨯`getOrdersByPhone(phone)` |
| `updateOrderStatus` | 同上 |
| `cancelOrder` | 同上 |
| `attachScreenshot` | `getOrder(orderId)` ⨯`getVendorOrders(vid)` |
| `saveProduct` / `updateProduct` / `removeProduct` | `getStorefront(vid)` |
| `saveVendorConfig` | `getStorefront(vid)` |
| `saveHub` / `addHubBuilding` / `removeHub` | `listHubs` |
| `upsertVendor` / `removeVendor` | `listVendors`, `listAllOrders` |
| `addPayment` | `listPayments` |

实现方式：Worker 在转发写入前，**先把响应里推断出的相关 cache key 加入 purge 列表**，写入成功后清掉 + 让下一次读 miss 触发 refresh。

---

## 四、推荐改造路线（按触发线）

### 阶段 0（**现在**）：什么都不做

理由：
- 5-7 商家完全在 GAS 90min/天配额内
- admin 「📊 系统配额监控」面板会告诉你撞线
- 提前优化 = 浪费时间 + 增加复杂度（多一个东西可能坏）

**唯一现在该做**：把 admin 配额监控的告警线从默认 70% 调到 50%（提前手感）。

### 阶段 1（**配额 50%+ 时启动**）：Reverse-Proxy Worker

```
浏览器 ──→ CF Worker /api ──→ Cache(check) ──→ miss? ──→ GAS /exec
                              ↓ hit                       ↓
                         50ms 返回                   2-3s + 写入 cache
```

工作量：~50 行 Worker + 5 个 API 的 cache key + invalidation。1 天。

**关键设计**：
- 客户端 `apiBase` 改成 Worker URL，**不改任何业务代码**
- Worker 对写入透传 + cache purge
- Worker 对读响应缓存到 Cache API（`caches.default`）

预期收益：
- 边缘命中率 80%+（轮询都打边缘）
- GAS 调用次数 ↓ 60-80%
- 客户感知延迟：3s → 50ms

### 阶段 2（**配额 70%+ 或 > 10 商家**）：GAS 内部 CacheService

在 GAS 内 `cacheRead_` 之上加一层 `CacheService.getScriptCache()`：

```js
function cacheReadFast_(name, ttl) {
  var key = 'tbl_' + name;
  var cached = CacheService.getScriptCache().get(key);
  if (cached) return JSON.parse(cached);
  var data = cacheRead_(name);
  CacheService.getScriptCache().put(key, JSON.stringify(data), ttl || 30);
  return data;
}
```

省 Sheet API 调用次数 / 减执行时长 30%。

**只在 GAS 撞配额时再做**——会让多副本一致性变复杂。

### 阶段 3（**> 30 商家**）：完整迁移

到这个阶段，GAS 配额完全不够，应该直接把数据搬到：
- **CF D1**（SQLite，5GB 免费） 替代 Sheet 做主存
- **CF Worker** 替代 GAS 跑业务逻辑
- Sheet 保留为"备份导出"（每天一次 cron dump）

工作量：~1 周（迁移 + 灰度 + 验证）

到那时候你应该有付费收入了，迁移成本完全合理。

---

## 五、为什么 CF 缓存优于"客户端缓存"

可能你会想：**直接让浏览器多缓存一点不就行了**？为什么要 CF 一层？

| 维度 | 浏览器 cache | CF 边缘 cache |
|---|---|---|
| 跨设备共享 | ❌ 每台设备各自 fetch | ✅ 一个商家的订单列表，所有商家设备共享一份 |
| 新设备首次访问 | ❌ 必须打 GAS | ✅ 只要别人最近打过，就有缓存 |
| Cache-Control 协商 | 浏览器复杂、易翻车 | Worker 显式控制，可预测 |
| GAS 压力 | 完全没减（首次必打） | 多设备共享，命中率高 |

**关键洞察**：外卖场景的轮询是**多个商家屏幕 + 多个客户屏幕同时在轮询同一份数据**。边缘缓存能把 N 个客户端的轮询折叠成 1 次 GAS 调用。这是浏览器缓存做不到的。

---

## 六、当前已经做对的事（别动）

- ✅ `pollIntervalMs` 后端自适应（pending/cooking/delivering 不同间隔，terminal 停）
- ✅ `api.js` 的 `_dedupe`（同参数并发只发一次）
- ✅ GAS `_reqCache`（请求内每张表只读一次）
- ✅ GAS `cacheFlush_`（批量写入而非逐次 setValue）
- ✅ admin 配额监控（让你提前看见撞线）
- ✅ 两阶段下单（文字秒回 + 截图后台传，避开 GAS 25s 超时）
- ✅ Push Worker 已部署（Web Push 唯一靠谱路径）

这些都是过去几个 session 里逐步加固的——**已经把 GAS 单体能撑住的天花板拉到 5-7 商家**。再往上才该启动阶段 1。

---

## 七、决策树

```
admin 配额面板今日运行时长占比

  < 40%   →   什么都不做。继续观察。
40-70%   →   启动阶段 1（Reverse-Proxy Worker）
70-90%   →   阶段 1 已上线 → 启动阶段 2（GAS CacheService）
  > 90%  →   阶段 2 已上线 → 启动阶段 3（迁 D1，准备付费）
```

把这个决策树**贴在团团项目自己的 admin 监控面板下边**当行动指引，比什么都强。
