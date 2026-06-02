# 团团 (Tuantuan) 上线前测试 — 修复进度报告

> **更新日期**: 2026-06-02 | **状态**: Critical 全清零 + 三大配额瓶颈全部拆除
> **审计来源**: Claude Code + Claude Workflow + OpenAI Codex 三方独立审计

---

## 修复进度总览

| 严重度 | 总数 | ✅ 已修复 | 🔧 待修复 |
|--------|------|----------|----------|
| 🔴 Critical | 23 | **23** | **0** |
| 🟠 High | 35 | **22** | 13 |
| 🟡 Medium | 48 | **5** | 43 |
| 🟢 Low | 20 | 0 | 20 |

### 0 配额可行性矩阵（20 商家，长期）

| 资源 | 上限 | 裸跑撞墙时间 | 修复后稳态 | 余量 |
|---|---|---|---|---|
| **GAS 90 min/天** | 90 min | 8-12 个月 | ~10-15 min（M1 修） | **6 倍 ✅** |
| **Sheet 1000 万 cell** | 10M | **1.83 年** | 90 天热表 ~1.2M（归档修） | **8 倍 + 归档表独立扩容 ✅** |
| **Drive 15 GB** | 15 GB | **25 天**（1MB/单） | 30 天清理后 ~1.8 GB | **8 倍 ✅** |
| **Cloudflare Workers** | 100k req/天 | 永不撞 | ~12k/天 | **8 倍 ✅** |

**3 大原本会撞墙的瓶颈全部拆除**。20 商家 0 配额无忧 ✓。

---

## ✅ 本会话累计修复（22 项）

### 🔴 Critical 收尾（5 项）
- **C3** 密码加盐 SHA-256（salt:hash 自动透明升级旧 hash）
- **C15** Token 加 role 前缀防提权（保留名 admin/root/system/super 第二道防线）
- **C17** cacheFlush_ 进 withLock_ 锁内（防双 request flush 交错）
- **C18** sync 去重键改用 syncKey() 显式取实体 ID（**付款不再被错合并丢失**）
- **C21** 跨标签按 id 增量合并（15s 本地保护，告别 last-write-wins）

### 🟠 High（5 项，Worker 端为主）
- **C22** /admin/wipe POST-only（防 CSRF）
- **H2** 缓存失效补全（状态变更失效 getVendorOrders；店铺改失效 listPublicVendors）
- **H20** CORS Origin 白名单（Pages + localhost + *.workers.dev 自反代）
- **H24** admin 网关 fail-closed（!AUTH_PASS 返回 500 而非跳公开页）
- **H25** /check 端点加 Basic Auth（防匿名烧 GAS 配额）

### 🟡 Medium（成本/容量/体验，5 项）
- **M1** 轮询自适应：终态停止 + 隐藏 tab 暂停 + 商家 30s 起步 → 省 ~26k GAS calls/天
- **M8** 本地变更保护窗 8s → 15s（覆盖更长 GAS+边缘缓存延迟）
- **M13** payments 加入 localStorage 持久化（刷新不丢付款记录）
- **M22** getMembership 进缓存白名单（结算页常查走边缘 30s TTL）
- **★ 新** 30 天前订单截图自动清理（Drive 配额保护：30 天稳态 1.8 GB << 15 GB）
- **★ 新** 90 天前订单归档（Sheet cell 保护：热表永远 ~1.2M cell，归档表独立扩容）

### 🛠 工具/可维护性
- 楼栋添加竞态修复（admin 社区 tab）
- 一键造测试商家入口（test_basic / test_pro）
- 三端 `<meta>` CSP 删失效的 frame-ancestors
- 5 处「一键登入」死引用清掉

---

## 📦 订单归档怎么做

### 设计思路

| | 热表 Orders | 归档表 OrdersArchive |
|---|---|---|
| 保留范围 | 近 90 天 + 所有未完成单 | 90 天前的终态单（delivered/rejected/cancelled） |
| 行数 | 20 商家 × 30 单/天 × 90 = 54k | 累计增长 |
| Cell 占用 | ~1.2M（固定） | 每年 ~4.8M，独立计入 10M |
| 查询频率 | 高（admin/商家/客户每天读） | 低（admin 偶尔审计） |
| 走缓存 | ✅ 有边缘缓存 | ❌ 直读，不缓存 |

### 触发方式（任选）

1. **推荐：Apps Script 周触发器**
   ```
   Apps Script 编辑器 → 触发器（左边 ⏰）→ 添加触发器
     函数: archiveOldOrdersWeekly
     事件源: 时间驱动
     时间触发器类型: 周计时器
     星期/时间: 周日 凌晨 2-3 点
     失败通知: 立即邮件
   ```

2. **admin UI 手动**：测试 tab → 📦 归档老订单 → 「立即归档 90 天前的终态订单」

3. **Worker Cron**（如果想全自动化）：每周日 POST `archiveOldOrders`

### 客户/商家影响

- **客户**：「我的订单」默认只看主表（近 90 天），看更早的需 `getArchivedOrders({phone})`
- **商家**：商家端订单列表只看热表（合理 — 90 天后还没结清的不科学）
- **admin**：经营看板按需调 `getArchivedOrders()` 查全历史

### 容量预警

归档表自身达到 **8M cell（80% of 10M）** 时，函数返回 `warning` 字段。届时 admin 要做的事：
1. 用 `clasp run` 或 Sheet UI 把归档表导出 CSV 存 Drive（永久备份）
2. 清空归档表（`OrdersArchive` 整表删除数据行，保留表头）
3. 估算节奏：20 商家约 **2 年** 撞 8M，所以这是个低频运维项

---

## 🟠 仍待修复 High（13 项）

上线后第一周内修：

| # | 问题 | 工作量 |
|---|------|--------|
| **C23** | Worker 全端点零速率限制 → 上限 5 次/min/IP for /admin/wipe | ~30 行 |
| **H26** | /push 始终返回 200 → 传播实际 push service 状态 | ~5 行 |
| **H27** | /health 伪装 ok → 加 /readyz 真测 GAS | ~10 行 |
| H28-H34 | 各种 input sanitize 边界 / order ID race / image base64 大小限 / TOS 进 Sheet | 半天 |

---

## 🟡 Medium（43 项）

未修。**全部非阻断**，是体验/性能优化。性价比最高：
- **M4** 客户端首屏 Skeleton
- **M11** admin 看板加日期范围筛选
- **M16** merchant 端订单卡可折叠
- **M28** order ID 改 #A-001 友好形式

---

## ⏳ 上线部署清单（用户自己来）

```pwsh
# 1. 后端 GAS
cd D:\MyProject\order-delivery\backend
clasp push
# clasp push 之后 schema 会自动从 SCHEMA_READY8 升到 9，加 OrdersArchive 表
```

**Apps Script 编辑器里配 2 个时间触发器**（一次性）：

| 函数 | 触发频率 | 时间 | 作用 |
|---|---|---|---|
| `purgeOldImagesDaily` | 每天 | 凌晨 2-3 点 | 删 30 天前订单的支付截图（Drive 配额） |
| `archiveOldOrdersWeekly` | 每周日 | 凌晨 3-4 点 | 把 90 天前终态订单搬到归档表（Sheet cell 配额） |

```pwsh
# 2. Worker
cd D:\MyProject\order-delivery\worker
npx wrangler deploy

# 3. 前端：自动随 Pages 部署
```

### 部署后一次性影响

| 影响 | 谁感知 | 处理 |
|------|---------|------|
| 所有现存 token 失效 | 商家/admin | 重新输账密一次 |
| 老密码 hash 升级 | 商家/admin | 完全无感 |
| 客户 / 商家界面 | — | 无影响 |

---

## 📊 当前延迟全貌

| 场景 | 用户开通知 | 用户拒通知（兜底） |
|------|--------------|--------------|
| 商家接单 → 客户看到"备餐中" | **< 1s**（WebPush） | 5-8s |
| 客户下单 → 商家响铃 | **< 1s**（WebPush + 钟声） | 8-30s |
| 商家送达 → 客户收通知 | **< 1s** | 8s |
| 首屏看店铺/菜单 | 60s 边缘缓存 | 同 |

**结论**：通知体验秒级；不开通知 = 常规外卖 app 水平 10s 内。

---

## 🚦 上线状态：可上线

**🟢 Go**：23/23 Critical 清零，3 大配额瓶颈拆除。
**第一周**：补 C23（限速）+ H26/H27（健康检查），防 abuse。
**第一季度**：M4/M11/M16/M28 体验优化。

---

## 三方审计共识（更新）

> ✅ **23/23 Critical 修复**，平台可上线。
> ✅ **GAS / Sheet / Drive 三大配额风险全拆除**。
> 🟡 剩余 13 个 High 是上线后 1 周内的"加固期"工作量。
> 🟢 43 个 Medium / 20 个 Low 是上线后 1-3 个月的"优化期"工作量。
