# 团团外卖 · 产品与系统说明书

最后更新：2026-05-31  ·  版本：v4.7 (Web Push + 边缘缓存)

---

## 0. 一句话产品

> **校园 / 社区里给小商家用的"我有外卖"工具**。零成本搭建，10 分钟上线，一台手机就能接单。

---

## 1. 产品定位

### 1.1 卖给谁

| 客群 | 痛点 | 我们的解法 |
|---|---|---|
| 小商家（食堂档口、外烩、宿舍代煮）| 没有 GrabFood / FoodPanda 的资格、也付不起抽成 | **0 抽成**，自建外卖入口 |
| 校园 / 社区里的客户 | 想点附近商家但没渠道 | 一个链接，直接下单 |
| 平台运营方（你）| 想验证模式 / 做副业 | **0 成本运营**（GAS + CF 全部免费），按月收商家订阅费 |

### 1.2 不卖给谁

- 已经在 GrabFood / FoodPanda 跑出量的商家（我们替代不了它们的骑手网络）
- 单日 > 500 单的连锁（应该自建系统）
- 需要"调度配送队伍"的 3P 业务（我们不做物流）

### 1.3 商业模式

- **客户**：免费用，不抽成
- **商家**：基础版 `RM 9/月` + 专业版 `RM 29/月`（解锁优惠券、CRM、广告位）
- **平台**：所有费用 0（GAS + CF + GitHub Pages 三件套）

---

## 2. 用户角色

### 2.1 客户（Customer）·  `index.html`

- **不需要注册账号**，凭手机号识别身份
- 浏览商家 → 选菜 → 结算（含支付截图上传）→ 追踪订单 → 收菜
- 多地址簿、订单历史、优惠券核销、Web Push 状态通知

### 2.2 商家（Merchant）·  `merchant.html`

- 账号密码登录（账号由平台开通）
- 接单 / 拒单 / 备餐 / 配送 / 送达 全状态流转
- 上传到货照片、批量送达
- 设置：营业时间、配送时段、收款码、楼栋覆盖、响铃配置
- 专业版：优惠券、CRM 统计、平台广告位

### 2.3 管理员（Admin / Platform）·  `admin.html`（不对外）

- "上帝视角"：用同一套数据切换 客户 / 商家 / admin 视图
- 商家管理、套餐计费、收款记录、系统健康检查
- **系统配额监控**：实时看 GAS 用量，决定何时启用阶段 2 缓存
- 测试工具：一键造测试单、清除测试数据、重置种子

---

## 3. 核心功能盘点

### 3.1 客户端

| 功能 | 状态 | 文件 |
|---|---|---|
| 商家列表 + 营业状态 | ✅ | js/student.js MerchantList |
| 菜单浏览 + 跨类搜索 | ✅ | js/student.js MenuList |
| 商品规格 / 库存 / 折扣 | ✅ | js/student.js OptionSheet |
| 购物车（行级，同商品不同规格分行）| ✅ | js/student.js cart |
| 结算（自动计算包装/配送费）| ✅ | js/student.js CheckoutView |
| 支付截图上传（强制，admin 可绕过试样图）| ✅ | js/student.js + js/api.js attachScreenshot |
| 优惠券核销 | ✅ | js/store.js applyCoupon |
| 团团豆会员积分（专业版） | ✅ | js/store.js membership |
| **两阶段下单**（文字秒回 + 截图后台传）| ✅ | api.js placeOrder + attachScreenshot |
| 地址簿（多地址、默认、一键切换）| ✅ | js/store.js currentAddress |
| 订单追踪（5 状态可视化 + 到货照片）| ✅ | js/student.js OrderStatus |
| 取消订单（pending 阶段可取消）| ✅ | js/store.js cancelOrder |
| 「再来一单」一键复购 | ✅ | js/student.js reorder |
| **Web Push 通知**（接单 / 出发 / 送达 / 拒单 锁屏推送）| ✅ | sw.js + js/notify.js |
| **WhatsApp 联系商家**（状态相关预填文案）| ✅ | js/student.js OrderStatus contact-wa |
| 软引导通知开通（首次下单后弹一次，dismiss 7 天）| ✅ | js/notify.js maybePrompt |
| iOS 加主屏引导（Decision 1B）| ✅ | js/notify.js isIOSSafari |

### 3.2 商家端

| 功能 | 状态 | 文件 |
|---|---|---|
| 订单管理（按状态分类、搜索、时间筛选）| ✅ | js/merchant.js MOrders |
| 同意 / 拒绝 / 推进状态 / 送达 | ✅ | js/store.js approveOrder/advanceOrder |
| 批量送达（同地点拍一张到货照群发） | ✅ | js/store.js batchDeliver |
| 拒单原因（预设 + 自定义）| ✅ | js/merchant.js askReject |
| WhatsApp 通知客户（wa.me 跳转 + 复制文案）| ✅ | js/merchant.js notifyWhatsApp |
| 5 状态自适应文案模板（接单/配送/送达/拒单/取消）| ✅ | js/merchant.js notifyMsg |
| 商品管理（分类、规格、库存、折扣、上下架）| ✅ | js/merchant.js MMenu |
| 商家设置（营业时间、配送模式、收款码、楼栋）| ✅ | js/merchant.js MSettings |
| **新单持续响铃**（Web Audio 零素材）| ✅ | js/merchant-ringer.js |
| 响铃配置（音量 / 间隔 / 自停 / 升级 / 勿扰）| ✅ | js/merchant.js MSettings ring card |
| 5 分钟未接单自动升级响铃 | ✅ | js/merchant-ringer.js escalateAfterMin |
| **客户 WhatsApp 联系号**（让客户找你） | ✅ | js/merchant.js settings.waNumber |
| Web Push 接单提醒（锁屏 + 后台都收）| ✅ | sw.js + 后端 notifyOrderEvent_ |
| 「预览客户端」（自查菜单是否完整）| ✅ | js/store.js previewAsStudent |
| 优惠券管理（专业版）| ✅ | js/merchant-crm.js coupons |
| CRM 统计（专业版：回头客、热度、券效）| ✅ | js/merchant-crm.js |

### 3.3 内部端（Admin）

| 功能 | 状态 | 文件 |
|---|---|---|
| 三端「上帝视角」切换 | ✅ | js/admin.js preview |
| 商家 CRUD（开店、改账号、停用）| ✅ | js/admin.js |
| 套餐管理 / 收款记录 / MRR 统计 | ✅ | js/admin.js Payments |
| Hub 楼栋池管理 | ✅ | js/admin.js Hubs |
| **系统健康检查**（连接 / Schema / 数据量）| ✅ | js/admin-test.js runHealth |
| **GAS 配额监控**（近 7 天调用 + 时长占比）| ✅ | js/admin-test.js loadUsage |
| 测试工具（造单 / 全流程演示 / 全状态模拟 / 重置种子）| ✅ | js/admin-test.js |
| 一键清除 isTest 数据（不动真实数据）| ✅ | js/admin-test.js clear |

---

## 4. 端到端业务流程

### 4.1 客户下单全链路（含失败恢复）

```
┌─客户端 (index.html)─┐    ┌─CF Worker /api─┐    ┌─GAS /exec─┐    ┌─Google Sheet─┐
│                    │    │                │    │           │    │              │
│  1.填手机+地址      │    │                │    │           │    │              │
│  2.选商家+菜品      │    │                │    │           │    │              │
│  3.上传支付截图      │    │                │    │           │    │              │
│  4.点提交 ─────────►│    │                │    │           │    │              │
│                    │    │  placeOrder    │    │           │    │              │
│  (本地乐观入单 +    │    │  ─────────────►│  POST/exec ──►│ 写 Orders ►│
│   显示状态页)       │    │  ◄─ purge 缓存  │    │  返回 ok+id │    │              │
│                    │◄─── ok ok+id ◄──────│    │           │    │              │
│  5.后台传截图(15s)  │    │                │    │           │    │              │
│                    │    │  attachScreen  │    │           │    │              │
│                    │────►│ ─────────────►│  POST/exec ──►│ 写 Drive  │    │              │
│                    │    │                │    │  回 url   │    │              │
│  6.轮询订单状态(5s) │    │                │    │           │    │              │
│                    │────►│ getOrder      │    │           │    │              │
│                    │    │  ↳ HIT cache 50ms (98% of polls)        │    │              │
│                    │    │  ↳ MISS → GAS 2.5s + cache 3s          │    │              │
│                    │◄─── status         │    │           │    │              │
│  7.收到 push       │◄─── (Worker /push) │◄─── pushNotify_ ◄ 状态变更│    │              │
│  锁屏弹通知         │                    │                              │    │              │
│  8.点通知 → 跳订单页 │                    │                              │    │              │
└────────────────────┘    └────────────────┘    └───────────┘    └──────────────┘
```

**关键设计点**：
- **乐观下单**：本地立即入单+显示状态页，不等后端确认（"秒回"体验）
- **两阶段写入**：文字（< 3s）+ 截图（15s 内后台传），避免 GAS 25s 超时
- **断网续传**：localStorage 持久化 + 8s 自动重试，关页面重开也接得上
- **保护窗口**：本地刚改的状态 8s 内不会被 stale poll 覆盖
- **多端共享**：换设备同手机号也能看到订单

### 4.2 商家接单全链路（含响铃 / 通知）

```
新单到达 GAS
    │
    ├──► 写 Orders sheet
    │
    ├──► notifyOrderEvent_('placed')
    │       │
    │       └──► Worker /push (VAPID 签名 + AES-128-GCM 加密)
    │               │
    │               └──► push service (FCM / Mozilla / Apple)
    │                       │
    │                       └──► 商家手机锁屏 弹: "📥 新订单 #abc · A栋506 · RM11"
    │
    └──► 商家 polling getVendorOrders 拿到新单（5-12s 自适应间隔）
            │
            ├──► applyVendorOrders diff pending 集合
            │       │
            │       └──► merchantRinger.start('#abc')
            │               │
            │               └──► Web Audio 蜂鸣 loop（默认 1.2s 间隔，30s 自停）
            │
            └──► UI 显示新单卡 + 「接单 / 拒绝」按钮
                    │
                    ├──► 点接单 → 乐观改 status='cooking' + ringer.stop + sync GAS
                    │       │
                    │       └──► GAS 写入 → notifyOrderEvent_('cooking')
                    │               │
                    │               └──► 客户收到 push: "👨‍🍳 备餐中"
                    │
                    └──► 5 分钟没动 → ringer escalate（再响一轮 + 触发事件）
```

### 4.3 状态流转图

```
       ┌──────────┐
       │ pending  │ 客户提交后
       └────┬─────┘
            │
    ┌───────┴────────┐
    │                │
    ▼                ▼
┌───────┐      ┌──────────┐      ┌──────────┐      ┌───────────┐
│cancelled│   │rejected  │      │ cooking  │ ───► │delivering │ ───► ┌───────────┐
└───────┘      └──────────┘      └──────────┘      └───────────┘     │ delivered │
  ↑              ↑                                   (商家推进)       └───────────┘
  │              │
  客户点取消    商家拒单
  (库存退、     (库存退、
   积分退)       积分退)
```

终态：`cancelled` / `rejected` / `delivered`（不再轮询）

---

## 5. 技术架构

### 5.1 拓扑图

```
              ┌────────────────────────────────────────────┐
              │          Cloudflare 边缘网络（免费）         │
              │                                            │
              │  ┌────────────────────────────────────┐   │
              │  │  Worker: tuantuan-push             │   │
              │  │  ┌─────────────┬─────────────┐    │   │
              │  │  │  /push      │  /api       │    │   │
              │  │  │  (Web Push) │  (反向代理 + │    │   │
              │  │  │  VAPID 签名 │   边缘缓存)   │    │   │
              │  │  │             │             │    │   │
              │  │  │  CPU ~3ms   │  CPU ~1ms   │    │   │
              │  │  └─────────────┴─────────────┘    │   │
              │  │  Cache API: 无上限 · region-local  │   │
              │  └────────────────────────────────────┘   │
              │                                            │
              │  ┌────────────────────────────────────┐   │
              │  │  CF Pages（可选） 或 GitHub Pages   │   │
              │  │  index.html / merchant.html /      │   │
              │  │  admin.html + js/ + sw.js          │   │
              │  └────────────────────────────────────┘   │
              └──────────┬─────────────────────────────────┘
                         │
                         │  HTTPS
                         ▼
              ┌────────────────────────────────────────────┐
              │  浏览器（Chrome / Edge / Safari / 微信）    │
              │  Vue 3 SPA + Service Worker + Push        │
              └──────────┬─────────────────────────────────┘
                         │
                         │  HTTPS（写入 + Worker fallback）
                         ▼
              ┌────────────────────────────────────────────┐
              │  Google Apps Script（免费 90min/天）         │
              │  Code.gs · doPost(action) 路由            │
              │  + 请求级缓存 + 批量写入 + 用量监控           │
              └──────────┬─────────────────────────────────┘
                         │
                         ▼
              ┌────────────────────────────────────────────┐
              │  Google Sheet（10M cells · 永久免费）         │
              │  Vendors / Orders / Menu / Hubs /          │
              │  Payments / SystemLogs / Subscriptions     │
              │  + Google Drive（截图，15GB 免费）           │
              └────────────────────────────────────────────┘
```

### 5.2 技术栈

| 层 | 技术 | 为什么 |
|---|---|---|
| 前端 | Vue 3 (no build, CDN) + 原生 fetch | 0 工具链、双击 HTML 就能跑 |
| 静态托管 | GitHub Pages / Cloudflare Pages | 都免费 + 自动 HTTPS |
| 边缘代理 | Cloudflare Workers | 100K req/天免费 + Web Crypto API（VAPID 必需） |
| 边缘缓存 | CF Cache API（caches.default）| 无大小限制、region-local、永久免费 |
| 后端 | Google Apps Script | 0 服务器、内建鉴权、与 Sheet 集成 |
| 数据库 | Google Sheets | 0 成本、10M cells、可视化运营 |
| 文件存储 | Google Drive | 截图、15 GB 免费 |
| 推送 | Web Push（VAPID + RFC 8291）| 浏览器标准、跨平台、免费 |
| 备用通讯 | WhatsApp wa.me 跳转 | 完全免费、马来用户 100% 覆盖 |

### 5.3 客户端工程结构

```
order-delivery/
├── index.html          # 客户端入口
├── merchant.html       # 商家端入口
├── admin.html          # 内部端入口（noindex）
├── manifest.webmanifest# PWA manifest（iOS 加主屏必备）
├── sw.js               # Service Worker：push + click 处理
├── js/
│   ├── config.js       # 多环境（demo / test / prod）+ Worker URL
│   ├── api.js          # 后端 API 客户端 + 缓存路由 + fallback
│   ├── store.js        # 全局 reactive store（数据中枢）
│   ├── notify.js       # Web Push 订阅 + 软引导横幅
│   ├── merchant-ringer.js  # 商家持续响铃 Web Audio
│   ├── student.js      # 客户端 Vue 组件
│   ├── merchant.js     # 商家端 Vue 组件
│   ├── merchant-crm.js # 优惠券 + CRM（专业版）
│   ├── admin.js        # 内部端 Vue 组件
│   ├── admin-test.js   # 测试工具（造单 / 监控）
│   ├── contact.js      # 合作反馈面板
│   ├── console.js      # 控制台 panel
│   └── main.js         # 路由 / 全局挂载
├── styles.css          # 主样式
├── styles-crm.css      # CRM / 优惠券样式
├── backend/
│   ├── Code.gs         # GAS 后端（1300+ 行）
│   └── README.md       # GAS 部署指南
├── worker/
│   ├── wrangler.toml   # CF Worker 配置
│   ├── package.json
│   ├── README.md       # Worker 部署指南
│   ├── src/index.js    # Worker 代码（/push + /api + /health）
│   └── scripts/
│       └── gen-vapid.mjs  # VAPID 密钥一次性生成
├── ARCHITECTURE.md     # 性能/架构分析（GAS vs CF）
├── PRODUCT.md          # 本文档
├── TESTING.md          # 测试指南
└── smoke-*.js          # 自动化测试套件
```

---

## 6. 数据模型（Google Sheet）

### 6.1 表清单

| 表名 | 行数估计 | 描述 |
|---|---|---|
| `Vendors` | 5-30 | 商家账号 + 设置 + 套餐 |
| `Orders` | 持续增长 | 全部订单（含 isTest 标记） |
| `Menu` | 50-300 | 全商家商品 |
| `Hubs` | 1-5 | 社区 / 校园 + 楼栋池 |
| `Payments` | 商家数 × 12 | 套餐收款流水（MRR 来源） |
| `SystemLogs` | 持续增长 | 关键操作审计（只追加） |
| `Subscriptions` | 客户 + 商家 + admin | Web Push 订阅（subId 幂等去重） |

### 6.2 关键字段

```
Vendors:        vendorId(主) · username · passwordHash · shopName · HubID
                settingsJson · payQRsJson · plan · planUntil · isTest

Orders:         orderId(主) · vendorId · HubID · createdAt · customerName · phone
                building · room · items(JSON) · subtotal · total · screenshotUrl
                status · rejectReason · deliveryPhotoUrl · membershipJson · isTest

Menu:           itemId(主) · vendorId · HubID · name · price · stock · category
                optionsJson · discountJson · isTest

Subscriptions:  subId(主, SHA-256(endpoint) 截 32 字符) · role · identity
                endpoint · p256dh · auth · ua · createdAt · lastNotifiedAt
                failCount · isTest
```

### 6.3 自动迁移机制

`Code.gs` 用 `SCHEMA_READY{N}` 版本号触发自动建表 + 补列：
- 改 `SCHEMA` 对象 + 把 6 改 7 → 下次访问自动创建新表 / 补新列
- 不需要手动操作 Sheet
- 历史数据不受影响

当前版本：**SCHEMA_READY7**（含 Subscriptions 表）

---

## 7. 部署指南

### 7.1 第一次部署（~30 分钟）

#### Step 1 · 准备 Google 账号（5 分钟）
1. 进 [script.google.com](https://script.google.com) 新建项目
2. 把 `backend/Code.gs` 整段贴进去
3. 部署 → 新部署 → Web App → 执行身份「我」/ 访问权限「任何人」
4. 拿到 `/exec` URL
5. 把 URL 填到 `js/config.js` 的 `PROD_API`

#### Step 2 · 注册 Cloudflare（2 分钟）
1. [cloudflare.com](https://cloudflare.com) 注册（免费）

#### Step 3 · 装 wrangler + 登录（5 分钟）
```bash
npm install -g wrangler@3    # 注意：v4 要 Node 22+
wrangler login              # 浏览器授权
wrangler whoami             # 确认登录
```

#### Step 4 · 生成 VAPID 密钥 + 部署 Worker（10 分钟）
```bash
cd worker
node scripts/gen-vapid.mjs  # 输出 5 个 secret 值
wrangler secret put VAPID_JWK       # 粘贴 #1
wrangler secret put VAPID_PUBLIC    # 粘贴 #2
wrangler secret put WORKER_SECRET   # 粘贴 #3
wrangler secret put VAPID_SUBJECT   # 粘贴 #4
wrangler secret put GAS_API_BASE    # 粘贴 GAS /exec URL
wrangler deploy
```

#### Step 5 · 把 Worker URL 告诉前端 + 后端（3 分钟）

**前端 `js/config.js`**：
```js
var PUSH_WORKER_URL = 'https://tuantuan-push.<你的子域>.workers.dev';
var VAPID_PUBLIC_KEY = 'BA-VEzn...';  // gen-vapid 的 #2
```

**后端 GAS 脚本属性**（Apps Script 编辑器 → ⚙ 项目设置 → 脚本属性）：
| Key | Value |
|---|---|
| `PUSH_WORKER_URL` | `https://tuantuan-push.<域>.workers.dev` |
| `WORKER_SECRET` | gen-vapid 输出的 #3 |

#### Step 6 · 推前端到静态托管（5 分钟）
- **方案 A · GitHub Pages**：仓库 push → Settings → Pages → 选 main 分支
- **方案 B · Cloudflare Pages**：CF dashboard → Pages → 连 GitHub 仓库
- **方案 C · Netlify / Vercel**：拖文件夹

#### Step 7 · 验证（5 分钟）
1. 浏览器开 `https://你的域/health` 直访（Worker 的 /health）
2. 浏览器开 `https://你的域/admin.html` → 跑 `testPushSetup`
3. 用客户端 `index.html?demo` 下个测试单，看链路全通

### 7.2 日常更新

| 改了什么 | 重新部署什么 |
|---|---|
| 改 `js/*` / 改 `*.html` / 改 `*.css` | 推静态托管（git push 即可） |
| 改 `backend/Code.gs` | Apps Script → 部署 → 管理部署 → 新版本 |
| 改 `worker/src/index.js` | `cd worker && wrangler deploy` |
| 加新商家 | 用 admin.html → 商家管理 → 新增 |

---

## 8. 0 成本结构（核心承诺）

### 8.1 用了哪些免费服务

| 服务 | 免费配额 | 我们用量（5 商家 × 20 客户）| 占比 |
|---|---|---|---|
| Google Apps Script | 90 min/天执行时长 | 阶段 1 缓存后 ≈ 18 min | **20%** |
| Google Sheets | 10M cells | 1 年用量 < 50K cells | **0.5%** |
| Google Drive | 15 GB | 1 年截图 < 2 GB | **13%** |
| Cloudflare Workers | 100K req/天 | 阶段 1 后 ≈ 3K req | **3%** |
| CF Cache API | 无上限 | ~50 MB | **N/A** |
| GitHub Pages | 100 GB 带宽/月 | < 5 GB | **5%** |
| Web Push (FCM/Mozilla/Apple) | 完全免费 | 250 推送/天 | **N/A** |
| WhatsApp wa.me | 完全免费 | 用户点击触发 | **N/A** |

### 8.2 永远不付费的 3 个边界

1. **不上 Twilio WhatsApp Business API**（按月 + 按条计费 → 抛弃）
2. **不上 Vercel Pro / Netlify Pro**（GitHub Pages / CF Pages 够用）
3. **不上 OneSignal / Firebase 付费层**（自建 Worker + GAS 已覆盖）

### 8.3 唯一可能的小额支出

- 自定义域名（如 `tuantuan.my`）≈ RM 50/年 —— **可选**，不买就用 `*.workers.dev` 子域

---

## 9. 容量规划

### 9.1 当前架构能扛多少

| 阶段 | 商家数 | 日单量 | GAS 配额占比 | 行动 |
|---|---|---|---|---|
| 现在（v4.7）| 5 | 50 | ~20% | **舒服区** |
| 边缘缓存上线后 | 15 | 200 | ~40% | 推荐 |
| 加 GAS CacheService | 25 | 400 | ~70% | 红线警戒 |
| 迁 D1 / KV | 50+ | 1000+ | 0%（脱离 GAS）| 阶段 3 |

### 9.2 性能基线

| 操作 | 命中边缘 | 穿透 GAS | 体感 |
|---|---|---|---|
| 首屏菜单 (getStorefront) | **80ms** | 2.5s | 「啪」一下 |
| 订单轮询 (getOrder) | **50ms** | 2.5s | 实时 |
| 商家订单列表 (getVendorOrders) | **50ms** | 2.5s | 实时 |
| 下单 (placeOrder) | n/a（直连）| 3s | 立刻入本地，秒跳 |
| 状态变更 (updateOrderStatus) | n/a（直连） | 3s | 乐观更新，瞬间 |
| Web Push 推送送达 | 锁屏弹 < 1s | n/a | 像 WhatsApp |

### 9.3 撞线信号 & 应对

每天进 admin → 📊 系统配额监控看一眼。决策树：

| 配额占比 | 信号 | 应对 |
|---|---|---|
| < 40% | 绿区 | 继续做功能，不动架构 |
| 40-70% | 黄区 | 检查 admin 看哪个 action 高频 → 调整 TTL |
| 70-90% | 红区 | 启用 GAS CacheService（ARCHITECTURE.md 阶段 2） |
| > 90% | 危险 | 迁移 D1（ARCHITECTURE.md 阶段 3）|

---

## 10. 运维手册（Runbook）

### 10.1 「客户说下单后状态不刷新」

1. 进 admin → 系统健康 → 看 GAS 在线
2. 浏览器 F12 → Network → 看 `/api` 或 `/exec` 请求
3. 看响应头 `X-Cache`：HIT 说明走缓存（可能 stale 3s）；MISS 说明穿透了
4. 如果穿透还慢 → GAS 撞配额了（看 admin 监控）

### 10.2 「商家说没收到新单推送」

1. 商家手机 Chrome 设置 → 通知 → 看「团团」是否允许
2. 浏览器进 `?test` 或 admin → 跑 `testPush` 测一条
3. 看 GAS Logs → `NOTIFY_FAIL` 行（如果有）
4. 看 Worker `wrangler tail` → 看 push 请求
5. 看 CF dashboard → Workers Metrics → 看错误率

### 10.3 「Sheet 数据看起来乱了」

- **永远不要手改 Sheet**，会破坏 schema 一致性
- 进 admin → 测试工具 → 重置种子数据（**会全删，再三确认！**）
- 或者从 Drive 的 Sheet 历史版本恢复（自动备份）

### 10.4 「想给单个商家停用」

- admin → 商家管理 → 找到商家 → 改 `active` 为 false
- 客户端列表就会显示「休息中」

### 10.5 「Worker 挂了 / Cloudflare 故障」

- 客户端 fallback 链路自动启动 → 全部走 GAS 直连
- 体验慢一些（2.5s vs 50ms）但**功能完全不受影响**
- CF 历史可用率 99.99%，不太可能挂

### 10.6 「GAS 撞配额了」

- 当天剩余时间 GAS 拒服务 → 客户端会看到红色错误
- 临时缓解：admin 跑「清除测试数据」减少表行数
- 真正解决：跑 ARCHITECTURE.md 阶段 2 / 3 的迁移

---

## 11. 安全模型

### 11.1 身份与鉴权

| 角色 | 鉴权方式 | 在哪里 |
|---|---|---|
| 客户 | 手机号（不验证）| 客户端 localStorage |
| 商家 | username + 加盐 SHA-256 密码 | Vendors 表 + 服务端 token |
| Admin | username + 密码 + 额外 token 校验 | Code.gs adminGuard_ |
| GAS → Worker | `X-Worker-Secret` header | GAS PropertiesService |

### 11.2 加密

| 内容 | 算法 | 在哪用 |
|---|---|---|
| 密码 | SHA-256 + 16 字节随机盐 | Code.gs hashPwd_ |
| Token | HMAC-like, 7 天有效 | Code.gs makeToken_ |
| Web Push payload | AES-128-GCM + ECDSA P-256 签 VAPID | Worker /push |
| Subscription ID | SHA-256(endpoint) 截 32 字符 | Code.gs saveSubscription_ |

### 11.3 防滥用

| 攻击 | 防御 |
|---|---|
| 重复提交订单 | placeOrder 幂等：同 orderId 直接返回 |
| 推送轰炸 | `testPush` 受 adminGuard 保护 + Worker `X-Worker-Secret` 鉴权 |
| 订阅垃圾灌库 | endpoint 长度 > 500 拒绝 + 5 次失败自动清 |
| 订单遍历 | getOrder 只验证 orderId 存在，不验证客户身份（实际安全靠 orderId 难猜 + Drive 截图私链） |
| GAS DDoS | CF Worker 作为前置（虽然现在没显式 rate limit）+ GAS 自有配额硬限 |
| Sheet 删除 | SystemLogs 只追加，clearTestData 只删 isTest 行，resetSeedData 需要 admin token |

### 11.4 隐私

- 客户手机号存在 Sheet（明文）—— 仅商家 / admin 看得到
- 支付截图存 Drive 私链 —— 商家用临时 URL 访问
- Web Push 订阅含浏览器 endpoint —— 不可逆，只能用于发推
- 无外部分析 / 追踪 SDK（无 GA / FB SDK）

---

## 12. 演进路线图

### v4.7（当前）· "全链路 + 边缘缓存"
- [x] Web Push（VAPID + AES-128-GCM）
- [x] 商家持续响铃（Web Audio）
- [x] WhatsApp wa.me 集成
- [x] CF Worker 反向代理 + 边缘缓存
- [x] PWA manifest + iOS A2HS 引导

### v5.0 候选清单（按价值排序）
- [ ] Worker Cron Trigger：5 分钟未接单 → 后端再推一次（不依赖客户端）
- [ ] Worker Cron Trigger：每天凌晨清 stale subscriptions（failCount > 0 30 天）
- [ ] 客户端 push 软引导改进：根据「订单数」决定催促力度
- [ ] 商家「订单地图」热点图（在 admin 显示哪栋楼最频繁）
- [ ] 优惠券领取：从平台广告位领（专业版增值）
- [ ] 团购拼单（专业版新功能）
- [ ] 每周营业报表自动推商家 WhatsApp（用 wa.me + 周日凌晨 trigger）

### v6.0 远期（订单 > 1000/天后）
- [ ] D1 SQLite 替代 Sheet 做主存
- [ ] R2 对象存储替代 Drive 存截图
- [ ] CF Workers AI 做菜品推荐
- [ ] CF Queue 做异步任务

---

## 13. 不做什么（明确边界）

| 不做 | 原因 |
|---|---|
| 配送员调度 | 不是我们的事，商家自配送或自取 |
| 在线支付（Stripe / iPay88）| 截图付款已经够用，加在线支付增加合规 / 抽成 |
| 多语言 | 校园场景中文 + 简单英文够，i18n 是 v6+ |
| iOS / Android 原生 App | PWA 已经覆盖 95% 需求，App Store 审核 / 维护成本太高 |
| GraphQL / tRPC | 用了反而违背 0 成本承诺 |
| K8s / Docker / 容器 | 同上 |
| 第三方分析（GA / Mixpanel）| 隐私 + 0 成本，admin 监控够用 |

---

## 14. 关键设计取舍备忘

> 这些是「为什么不那样做」的答案，避免后人重复踩坑。

### 14.1 为什么不用 WebSocket / SSE 做实时推送
- GAS 不支持长连接
- 轮询 + Web Push 已经覆盖「实时」体验
- 加 WebSocket 要 Worker 常驻，超出免费层

### 14.2 为什么 Worker 不存数据
- 想保持「Sheet 作单一事实源」
- Worker 只做无状态加速：CPU 计算 + 边缘缓存
- 用了 D1 / KV 就要管 schema、备份、迁移 → 增加复杂度

### 14.3 为什么客户端不用 React / 不用 Vite
- 0 工具链 = 双击 HTML 就能跑
- 改一行 CSS / JS 不用等 build，直接刷新
- 项目规模 < 10K 行，没必要

### 14.4 为什么 admin 不在独立子域
- 用 `noindex` + 内部链接传播已经够保护
- 上独立子域要管 DNS、SSL 续期 → 麻烦
- 真正的安全靠 adminGuard_ 鉴权

### 14.5 为什么不强制 HTTPS Strict-Transport-Security
- GitHub Pages / CF Pages 自动 HTTPS
- 不上 HSTS 是因为不想给将来的灾备方案上锁

### 14.6 为什么用 `?demo` 而不是独立 demo 域
- 一份代码三种环境（prod / test / demo），URL 参数切换最简单
- 客户分享链接时把 `?demo` 截掉就是正式环境

---

## 15. 致维护者

- **改 `Code.gs` 永远要部署「新版本」**，否则改了等于没改
- **`SCHEMA_READY{N}` 版本号每加一张表 +1**，老用户访问时自动建表
- **Worker secret 改了就要重 deploy**（`wrangler deploy`）
- **本地试静态文件用 `python -m http.server 8777`**，跑 smoke test 也是这个端口
- **想新增 cacheable read API**：worker `READ_TTL` + api.js `CACHEABLE` 两边都加
- **想新增有副作用的 write API**：worker `INVALIDATION` 加映射
- **测试通过的标准**：smoke-notify.js + smoke-deep.js + smoke-integration.js + smoke-cache.js 全跑过

---

## 16. 致敬代码里的细节

如果你刚接手这套代码，先读这几处去理解灵魂：

1. **`js/store.js` `applyVendorOrders`** —— 8 秒保护窗 + ringer pendingSet diff
2. **`backend/Code.gs` `placeOrder_`** —— 服务端校验 + 幂等 + 库存扣减 + 积分 + Drive 上传
3. **`js/student.js` `OrderStatus.setup`** —— 自适应轮询 + visibility 即刷 + push 联动
4. **`worker/src/index.js` `handleApi`** —— 路由 + 边缘缓存 + 失效 + fallback
5. **`backend/Code.gs` `notifyOrderEvent_`** —— 推送决策中枢（6 种事件文案）

---

**「让没有外卖能力的小商家，10 分钟拥有自己的外卖平台。」**

—— 这是团团唯一的目的。
