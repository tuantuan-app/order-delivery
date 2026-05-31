# 测试库设置指南（安全推更新的关键）

> **为什么这步重要**：以后你改后端 `Code.gs` 或加新功能，都先连测试库验证，**100% 验过再推正式**。这就是大公司「Staging 环境」的免费版。

预计耗时：**20 分钟**（一次性，以后省下无数次的紧张）

---

## 一、建第二个 GAS 项目（10 分钟）

### Step 1 · 新建 Sheet
1. 进 [sheets.google.com](https://sheets.google.com) → 新建空白
2. 起名 **「团团 · 测试库」**（跟正式库区分开）
3. **不需要手动建表头**——后端启动会自动建

### Step 2 · 绑定 Apps Script
1. Sheet 顶部菜单 → **扩展程序 → Apps Script**
2. 起名 **「团团测试后端」**
3. 删掉默认的 `function myFunction()`
4. 把你现在正式库的 `backend/Code.gs` **整个粘贴进去**
5. 顶部 **保存 (💾)**

### Step 3 · 部署测试 Web App
1. 右上角 **「部署」 → 新建部署**
2. ⚙ 类型选 **「Web 应用」**
3. 描述写 **「测试环境 v1」**
4. **执行身份：我**
5. **谁可以访问：任何人**
6. 点 **「部署」**
7. 复制那个 `https://script.google.com/macros/s/AKfyc..../exec` URL —— **就是测试 GAS 的入口**

### Step 4 · 把 URL 填进 `js/config.js`

打开 `js/config.js`，把 `TEST_API` 改成你刚拿到的 URL：

```javascript
var PROD_API = 'https://script.google.com/macros/s/AKfyc...prod/exec';
var TEST_API = 'https://script.google.com/macros/s/AKfyc...TEST/exec';  // ← 填这里
```

保存。**不需要重新部署 Worker**——前端推一次静态文件即可。

---

## 二、加 Web Push 测试支持（5 分钟，可选）

如果你想在测试环境也测推送，**测试 GAS 也要 PropertiesService**：

1. Apps Script 编辑器（测试库）→ ⚙ 项目设置 → 脚本属性
2. 加两条（值跟正式库**完全一样**，反正都指向同一个 Worker）：

| Key | Value |
|---|---|
| `PUSH_WORKER_URL` | `https://tuantuan-push.keidev.workers.dev` |
| `WORKER_SECRET` | 跟正式库相同 |

**只能给一个测试设备订阅**，否则推送会同时弹到正式 + 测试两套库的订阅设备上（虽然不致命）。

如果嫌烦，**测试模式跳过推送的实践方法**：测试 GAS 的脚本属性留空 `PUSH_WORKER_URL`，`pushNotify_` 会自动返回 `error: 'not set'` 不影响业务。

---

## 三、怎么用（核心）

### 日常切换

| URL | 连哪个后端 | 用途 |
|---|---|---|
| `https://你的域/index.html` | 正式 GAS | 真实用户 |
| `https://你的域/index.html?test` | **测试 GAS** | 你改完代码先在这跑 |
| `https://你的域/index.html?demo` | 无（纯本地 localStorage）| 给完全离线的演示 |
| `https://你的域/admin.html?test` | 测试 GAS | 测试库的 admin 面板（独立数据） |

### URL 顶部标签

测试模式会自动在网页顶部加**橙色 🧪 测试环境** 标签 + 网页标题前加 🧪——绝对不会跟正式混淆。

### 测试数据保护

测试库的 `?test` 模式：
- ✅ **跳过 Cloudflare Worker 缓存**（直连测试 GAS）——测试数据不会被缓存到边缘
- ✅ 数据写在测试 Sheet，跟正式库**完全物理隔离**
- ✅ 截图存测试 GAS 自己的 Drive 文件夹
- ✅ 玩坏了点 admin → 测试工具 → 「重置种子」一键清空

---

## 四、推更新的标准流程（**正确步骤**）

### 改了 `Code.gs` 后端：

```
1. ✅ 本地跑 4 套 smoke test 全绿
2. ✅ Apps Script 编辑器（测试库）→ 部署「新版本」
3. ✅ 浏览器 ?test 测试改的功能
4. ✅ 跑 testPushSetup（前面给的 18 行测试函数）
5. ✅ Apps Script 编辑器（正式库）→ 部署「新版本」
6. ✅ 浏览器开正式 URL 点一遍主要功能
```

### 改了 `js/*` 前端：

```
1. ✅ 本地 python -m http.server 8777 验证
2. ✅ git push → GitHub Pages 自动重发
3. ✅ 浏览器开 ?test 跑一遍（确认 fallback 链路正常）
4. ✅ 浏览器开正式 URL 跑一遍
```

### 改了 `worker/`：

```
1. ✅ 本地 node --check worker/src/index.js
2. ✅ cd worker && wrangler deploy
3. ✅ curl /health 验证 endpoints: ["/push","/api","/health"]
4. ✅ 浏览器开正式 URL，F12 Network 看 X-Cache header 是否还工作
```

---

## 五、出问题怎么办（一键回滚）

| 问题层 | 回滚 |
|---|---|
| 前端 JS | `git revert HEAD && git push` |
| Worker | `cd worker && wrangler rollback` |
| GAS 后端 | Apps Script → 部署 → 管理部署 → 选上一版本 → 部署 |
| Sheet 数据 | Sheet → 文件 → 版本历史 → 选时间点恢复 |

每个都是**分钟级**。这是这套架构最大的隐藏价值。

---

## 六、额度消耗预估

| 资源 | 影响 |
|---|---|
| Cloudflare Worker | **0**（测试模式跳过 Worker，直连测试 GAS）|
| GAS 执行时长 | < 5%（测试库和正式库共享 90 min/天的 Google 账号配额，你每天测试 < 5 分钟）|
| Sheet cells | 测试库独立 10M cells 配额 |
| Drive 存储 | 测试库独立 15GB 共享配额（影响微乎其微）|

**完全 0 现金成本** ✓
