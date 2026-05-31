# 团团 · 后端（Google Apps Script，高度自动化）

零成本后端：Google Sheet 当数据库、Google Drive 存图片、Apps Script 当 API。
代码会**自动建库、自动建表、自动写入演示商家**，图片自动存 Drive，你几乎不用手动配置。

## 你需要做的（仅 3 步，都是 Google 强制、只能本人操作的一次性步骤）

1. 打开 <https://script.google.com/home/usersettings> ，把「Google Apps Script API」开关打开。
2. 在本会话输入并完成登录（浏览器授权你的 Google 账号）：
   ```
   ! clasp login
   ```
3. 运行一键部署脚本（其余全自动）：
   ```
   ! powershell -ExecutionPolicy Bypass -File backend\deploy.ps1
   ```
   脚本会：安装 clasp → 创建 Apps Script 项目 → 推送代码 → 部署 Web 应用 →
   把 `/exec` 网址自动写进 `js/config.js` 的 `apiBase` → 做健康检查。

> 首次健康检查若提示需授权：用浏览器打开脚本给出的 `/exec` 网址点一次授权，
> 或在编辑器（`clasp open`）里点一次运行 `setupSheet` 即可。之后一切正常。

完成后：前端商家登录会走真实后端（`Vendors` 表校验），下单/审批/到货照片会持久化到 Sheet+Drive，
重要事件写入 `SystemLogs` 审计日志。把 `apiBase` 改回空字符串即恢复纯本地演示。

## 自动创建的表

- **Vendors** `vendorId | username | password | passwordHash | shopName | logo | tngLabel | HubID | active`
  自动写入演示商家 shop1/shop2/shop3（密码 1234）。想更安全：填 `passwordHash`(SHA-256) 列，后端会优先用它。
- **Orders** 订单（截图/到货照片以 Drive 链接形式存 `screenshotUrl`/`deliveryPhotoUrl`）。
- **Menu** 商品（供改价/上下架定位）。
- **SystemLogs** `timestamp | actor | action | details` —— **只追加、不可改删**，无任何读/改/删接口。
  建议在表上设「保护范围」仅所有者可手动编辑，双保险防篡改。

## 接口（POST + JSON，Content-Type: text/plain）

- `vendorLogin {username,password}` → `{ok, token, vendor, orders}` / `{ok:false,error}`（记登录成功/失败）
- `placeOrder {order}` → 追加订单，截图存 Drive，记日志
- `updateOrderStatus {orderId,status,rejectReason?,deliveryPhoto?}` → 改状态，到货照片存 Drive，记日志
- `updateProduct {itemId,field,value}` → 改商品，记日志
- `getVendorOrders {vendorId}` → 该商家订单
- `GET` → 健康检查

多地区：各表的 `HubID` 列配合前端 `?hub=` 过滤。
