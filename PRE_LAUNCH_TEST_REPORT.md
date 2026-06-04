# 🚀 团团 (Tuantuan) 上线前测试 — 最终报告

> **日期**: 2026-06-02 | **方法**: 多代理并行代码审计（5 agents × 50 次代码读取）
> **审计范围**: 全栈 — `Code.gs` (1609行) + `worker/src/index.js` (614行) + 全部前端 JS (~3000行)
> **发现问题**: **79 个** (13 🔴 Critical + 22 🟠 High + 27 🟡 Medium + 17 🟢 Low)

---

## 📊 执行摘要

### 总体评估: 🔴 BLOCK — 上线前必须修复 13 个 Critical 问题

两轮独立代码审计（Claude 快速审查 + 5-agent 深度并行分析）一致发现本平台存在严重的安全性和数据完整性缺陷。**核心根因是「缺少服务端校验」** — 价格、费用、订单状态、库存值全部信任客户端提交的数据。这无法仅通过前端补丁修复。

### Top 5 最严重问题

| # | 问题 | 影响类型 | 
|---|------|----------|
| 1 | `withLock_()` 不验证锁获取 — 所有写操作可并发竞态 | 数据损坏 |
| 2 | 订单状态转换无校验 — 任意状态可跳转/回退 | 业务逻辑 |
| 3 | 密码无盐 SHA-256（注释声称已加盐但实际未实现）| 安全认证 |
| 4 | 服务端信任客户端提交的价格和费用 — 客户可付 RM 0 | 营收流失 |
| 5 | `resetAll()` 在商家端可一键清空全平台数据 | 灾难性数据丢失 |

---

## 🔴 Critical (13) — 必须修再上线

### C1. `withLock_` 不验证锁获取 — 所有写操作并发竞态
- **文件**: `backend/Code.gs:623-627`
- **问题**: `LockService.waitLock()` 返回 void，超时后不抛异常。锁获取失败时，被保护的函数仍然执行，无任何互斥保护。
- **后果**: 双人同时下单最后一单 → 都成功 → 库存变 -1。影响所有 `placeOrder`/`cancelOrder`/`updateOrderStatus`/`saveProduct`/`removeProduct`
- **修复**: 加 `if (!lock.hasLock()) return { ok: false, error: 'system busy' }`

### C2. 订单状态转换无服务端校验
- **文件**: `backend/Code.gs:1078-1107`, `js/store.js:1080-1093`
- **问题**: `updateOrderStatus_` 接受任何 status 字符串直接写入。pending 可跳到 delivered，delivered 可退回 pending，rejected 可复活。
- **修复**: 后端加状态机：`pending→[cooking,rejected,cancelled]`, `cooking→[delivering]`, `delivering→[delivered]`

### C3. 密码无盐 SHA-256（注释声称有盐）
- **文件**: `backend/Code.gs:409` — `function hashPwd_(p) { return sha256_(p); }`
- **问题**: 第 8 行注释写"密码加盐"但实际未实现。所有相同密码 → 相同 hash。种子密码 `1234` 的 SHA-256 可通过彩虹表秒破。
- **修复**: 生成 16 位随机 hex salt，存储为 `salt:hash`，加 1000+ 次迭代

### C4. 双重点击可创建重复订单
- **文件**: `js/student.js:754-766`
- **问题**: `submit()` 无 `submitting` ref 锁。移动端快速双击触发两次 `placeOrder()` → 两个相同订单入 `state.orders`。
- **修复**: 加 `const submitting = ref(false)` + `:disabled="submitting"`

### C5. NaN 库存值绕过所有守卫
- **文件**: `js/store.js:339`, `js/student.js:82,85-86`
- **问题**: `Number("INVALID")` = `NaN`。`NaN !== ''` = `true` → 通过真值检查。`NaN - qty` = `NaN`。所有 `NaN <= 0` 判断为 `false` → 无限下单。
- **修复**: 加 `isNaN(n)` 检查，NaN 转 null

### C6. `resetAll()` 商家端可一键清空全平台
- **文件**: `js/store.js:1385-1391`, `js/merchant.js:672`
- **问题**: 商家设置页的"清空所有数据并恢复初始"调用 `store.resetAll()` → `Object.assign(state, seedState())` 替换整个共享状态。一个商家即可清掉所有其他商家的数据。
- **修复**: 从商家 UI 移除此按钮（仅 admin 可用）

### C7. MRR 计算错误 — PRO_PRICE 写成了 29 而非 39
- **文件**: `js/store.js:1200-1201`
- **问题**: `PRO_PRICE: 29` 和 `BASIC_PRICE: 29` 相同。但 UI 标签显示"专业版 RM 39/月"。MRR 少算了 `proActive × RM 10`/月。
- **修复**: 改 `PRO_PRICE` 为 `39`

### C8. Admin 密码明文存储和比较
- **文件**: `backend/Code.gs:698-716`
- **问题**: `String(body.password) === p` — 直接明文比较。Script Properties 若泄露 → admin 密码即泄露。
- **修复**: 存储 `hashPwd_(ADMIN_PASS)` + hash 后比较

### C9. 删除商家不级联删 Payments — 孤儿数据
- **文件**: `backend/Code.gs:1165-1173`
- **问题**: 删 Vendors + Orders + Menu，但漏 `TAB_PAYMENTS`。孤儿 payment 行累积，污染 billing 报表。
- **修复**: 加 `cacheDelete_(TAB_PAYMENTS, 'vendorId', vendorId)`

### C10. 服务端信任客户端提交的单项价格
- **文件**: `backend/Code.gs:973-998`
- **问题**: 服务端用 `Number(it.price)` 直接算小计，不交叉验证菜单价格。恶意客户可 `price: 0.01`。
- **修复**: 按 `itemId` 查菜单，用服务端价格 + 选项附加费重算

### C11. 服务端信任客户端提交的包装费/配送费
- **文件**: `backend/Code.gs:975`
- **问题**: `packagingFee` 和 `deliveryFee` 直接从请求体取值，不验证商家设置。客户可传 0。
- **修复**: 服务端强制按 `settings.fees` 计算

### C12. 会员积分并发丢失 — 整个 settingsJson blob 竞争
- **文件**: `backend/Code.gs:1001-1011`
- **问题**: 积分存储在 `settingsJson` 的一个大 JSON 里。两个并发订单读取→修改→写回 → 后写的覆盖先写的 → 积分永久丢失。
- **修复**: 积分独立成表（一行一个 phone+vendorId）

### C13. Admin 面板硬编码弱密码 "1234"
- **文件**: `js/admin.js:269`
- **问题**: "重置为 1234" 按钮设置商家密码为 `'1234'`。一键误操作 → 真实商家被弱密码保护。
- **修复**: 改为随机密码生成器 + 一次性弹窗显示

---

## 🟠 High Priority (22) — 应在首批修复

| # | 问题 | 文件 |
|---|------|------|
| H1 | `cacheFlush_` 全表重写 → GAS 配额枯竭风险 | `backend/Code.gs:134-157` |
| H2 | Worker 缓存失效不完整 — 多处漏 invalidate | `worker/src/index.js:428-450` |
| H3 | 非登录端点无限速 → DoS/GAS 配额耗尽 | `backend/Code.gs:490-559` |
| H4 | 付款截图设为 `ANYONE_WITH_LINK` → 金融隐私泄露 | `backend/Code.gs:466` |
| H5 | 预约模式下所有时段过完后购物车可用但不可结账 | `js/student.js:49,85,699,750` |
| H6 | "下单成功" 在服务端确认前就提示 → 误导 | `js/student.js:764` |
| H7 | QR 码弹窗中 `openTab` 字符串拼接 → XSS | `js/student.js:753-754` |
| H8 | `saveProfile` 地址簿分支静默丢弃 building/room | `js/store.js:878-894` |
| H9 | 图片压缩错误静默吞掉（商户+客户两端）| `js/student.js:752`, `js/merchant.js:19` |
| H10 | `clearTestData` 前后端不对称 → 测试数据残留 | `js/store.js:1298-1306` |
| H11 | AudioContext 非用户手势时静默失败 → 响铃不响 | `js/merchant-ringer.js:63-71` |
| H12 | Token 走 POST body 且存 localStorage → 泄露风险 | `js/store.js:709`, `js/api.js:55-71` |
| H13 | 批量送达无确认弹窗 → 误操作 | `js/merchant.js:317-326` |
| H14 | 预览客户端模式可下真实自订单 | `js/store.js:981` |
| H15 | 三处 pending 计数不一致 | `js/merchant.js:25-26,38,51,114` |
| H16 | 拒单不乐观恢复库存/积分 | `js/store.js:1081` |
| H17 | `normalizeRemoteOrder` 不包含 `hubId` | `js/store.js:322-335` |
| H18 | "用示例照片测试"按钮在生产环境可见 | `js/merchant.js:176,190,243` |
| H19 | PRO 升级引导是死胡同（无付款/联系方式）| `js/merchant.js:67-94` |
| H20 | CORS `Allow-Origin: *` — CSRF 和数据泄露风险 | `worker/src/index.js:192` |
| H21 | `saveProduct_` 可通过猜 itemId 跨商家覆盖 | `backend/Code.gs:823-836` |
| H22 | `vendorLogin_` 错误信息区分"账号不存在"/"密码错误"→ 账号枚举 | `backend/Code.gs:662-696` |

---

## 🟡 Medium (27) — 首周补丁

M1-M27 详见完整审计报告 (`WORKFLOW_REPORT.md`)，关键项包括：
- M1: 终态订单仍轮询 → 浪费配额
- M8: `_localMutAt` 8s 保护窗对高延迟网络太短
- M13: `payments` 不持久化到 localStorage
- M15: 6 个 admin computed 各自全量扫 `state.orders`
- M22: `getMembership` 不走 Worker 缓存
- M27: `addHubBuilding` 缺 `adminGuard_` — 商家可污染社区楼栋池

---

## ✅ Pre-Launch Checklist

### 🔴 Blocking (修完才能上线)
- [ ] C1: `withLock_` 加 `hasLock()` 检查
- [ ] C2: 后端加状态转换白名单
- [ ] C3: 实现真加盐 SHA-256（含现有密码迁移）
- [ ] C4: `submit()` 加 `submitting` 锁
- [ ] C5: NaN 库存 → null 修复
- [ ] C6: 商家端移除 `resetAll` 按钮
- [ ] C7: `PRO_PRICE` 改为 39
- [ ] C8: Admin 密码 hash 化
- [ ] C9: `removeVendor_` 加 Payments 删除
- [ ] C10: 服务端按菜单重算价格
- [ ] C11: 服务端按 settings 重算费用
- [ ] C12: 积分独立成表或加锁
- [ ] C13: 移除硬编码 "1234" 改为随机密码

### 🟠 Should Fix (强烈建议)
- [ ] H1-H4: 安全/隐私相关
- [ ] H6-H7: UX 误导 + XSS
- [ ] H13-H14: 商家端数据安全

### 🟡 Could Fix (首周)
- [ ] M1-M27: 性能优化、UX 改进、边界情况

---

## 🔒 安全态势总结

| 维度 | 评分 | 关键问题 |
|------|------|----------|
| 认证 | 🔴 Weak | 无盐 SHA-256 (C3) + admin 明文 (C8) + 弱密码重置 (C13) |
| 授权 | 🔴 Weak | cancelOrder 无鉴权 + `saveProduct_` 跨商家 (H21) |
| 输入校验 | 🔴 Weak | 客户端价格/费用被信任 (C10, C11) + sanitize 过滤不足 |
| 数据保护 | 🟠 Poor | 付款截图公开 (H4) + Token 走 POST body (H12) |
| 传输安全 | 🟢 OK | HTTPS + Worker secret header |
| 攻击面 | 🟠 Medium | 无频率限制 (H3) + CORS * (H20) + 错误信息枚举 (H22) |

---

> 🤖 报告方法：Claude Code 直接审计 + 5-agent 并行深度分析 (customer/merchant/admin/backend/synthesis)
> 总分析量：~5000 行代码 × 4 个独立视角 + 交叉验证
> 两轮分析一致确认：**在不修复 Critical 问题的情况下不应上线**
