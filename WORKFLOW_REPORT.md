# 团团 (Tuantuan) Pre-Launch QA Synthesis Report

**Date:** 2026-06-02  
**Audit Sources:** Customer-Facing Code Review · Merchant-Facing Code Review · Admin Panel Audit · Backend & Worker Audit  
**Scope:** `js/student.js`, `js/merchant.js`, `js/admin.js`, `js/store.js`, `js/merchant-ringer.js`, `js/merchant-crm.js`, `js/api.js`, `js/console.js`, `admin.html`, `index.html`, `merchant.html`, `backend/Code.gs` (1609 lines), `worker/src/index.js` (614 lines)

---

## Executive Summary

**Overall Assessment: 🔴 BLOCK — Do Not Launch**

The platform has 13 confirmed critical-severity defects spanning all four audit surfaces. Two are data-corruption race conditions in the backend mutex layer (`withLock_`) and state-machine layer (order status transitions). Four are revenue-impacting bugs (MRR under-reported by 26%, fees trusted from client, membership points lost on concurrency). Two are authentication-breaking (unsalted passwords, admin plaintext auth). The remaining critical issues include a vendor data-wipe footgun (`resetAll`), NaN stock guards, and a double-submit race that creates duplicate orders.

The shared root cause pattern is **missing server-side validation** — prices, fees, order statuses, and stock values are all trusted from the client. This cannot be fixed by patching the frontend alone.

**Top 3 Most Critical Issues:**

| # | Issue | Impact |
|---|-------|--------|
| 1 | `withLock_` does not verify lock acquisition — all mutating operations race | Silent data corruption on every concurrent write path |
| 2 | No order status transition validation — any status can jump to any other | Orders can be resurrected, skipped, or reverted |
| 3 | Unsalted SHA-256 password hashing (header claims salt exists) | All 50+ vendor passwords share identical protection; rainbow-table trivial |

**Summary Counts (deduplicated across audits):**

| Severity | Count |
|----------|-------|
| 🔴 Critical | 13 |
| 🟠 High | 22 |
| 🟡 Medium | 27 |
| 🟢 Low | 17 |
| **Total** | **79** |

---

## Critical Issues (🔴) — Must Fix Before Launch

---

### C1. `withLock_` Does Not Verify Lock Acquisition — All Mutating Operations Race

**Affected Files:** `backend/Code.gs`, lines 623–627  
**Audit Source:** Backend & Worker Audit (#1)  
**Cross-References:** Amplifies Merchant B2/B3/B8 (status guards absent), Backend #4 (price trust), Backend #6 (membership points race)

**Description:** `LockService.getScriptLock().waitLock(20000)` returns `void` and does **not** throw on timeout. When the lock cannot be acquired within 20 seconds, the guarded function proceeds with zero mutual exclusion. Every mutating operation — `placeOrder`, `cancelOrder`, `updateOrderStatus`, `saveProduct`, `removeProduct`, `saveVendorConfig`, `resetSeedData`, `wipeAllData` — is vulnerable.

**Current code:**
```js
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}
```

**Concrete scenario:** Two customers place the last remaining item simultaneously. Both pass `waitLock` (one acquires lock, the other times out after 20s). The second `placeOrder` executes concurrently, reads stale stock=1, both succeed. Stock goes to -1.

**Fix:**
```js
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  if (!lock.hasLock()) return { ok: false, error: 'system busy, please retry' };
  try { return fn(); } finally { lock.releaseLock(); }
}
```

**Risk If Not Fixed:** Silent data corruption on every concurrent write. Duplicate orders, negative stock, lost membership points, cross-vendor overwrites. All other mutating-path fixes are useless if the lock doesn't work.

---

### C2. No Order Status Transition Validation — Any Status Can Jump to Any Other

**Affected Files:** `backend/Code.gs`, lines 1078–1107; `js/store.js`, lines 1080–1093  
**Audit Sources:** Backend & Worker Audit (#2), Merchant Audit (B2, B3, B8)

**Description:** `updateOrderStatus_` accepts any `status` string and writes it to the order row without validating the current-to-next transition. The frontend `approveOrder`, `rejectOrder`, `advanceOrder`, and `batchDeliver` in `store.js` also lack status pre-condition checks. A merchant can skip `cooking`/`delivering` and jump straight to `delivered`, revert `delivered` back to `pending`, or resurrect a `rejected` order.

The frontend-only status progression in `advanceOrder` (store.js:1082) uses a static array `['pending','cooking','delivering','delivered']` — calling `advanceOrder` on a `pending` order skips `approveOrder` entirely, missing the ringer stop and sync action.

**Fix (Backend):**
```js
var ALLOWED = {
  pending: ['cooking', 'rejected', 'cancelled'],
  cooking: ['delivering'],
  delivering: ['delivered'],
};
var allowed = ALLOWED[String(o.status)] || [];
if (allowed.indexOf(status) < 0) {
  return { ok: false, error: '不允许从 ' + o.status + ' 切换到 ' + status };
}
```
**Fix (Frontend):** Add status guards to `approveOrder` (check `o.status === 'pending'`), `rejectOrder` (check `o.status === 'pending'`), `advanceOrder` (refuse pending → cooking without approve), `batchDeliver` (check each order is in `cooking` or `delivering`).

**Risk If Not Fixed:** Billing integrity destroyed. Customers see orders resurrect. Merchants accidentally skip steps. Ringer/alerts bypassed.

---

### C3. Unsalted SHA-256 Password Hashing — Header Comment Claims Salt Exists But None Applied

**Affected Files:** `backend/Code.gs`, line 409  
**Audit Source:** Backend & Worker Audit (#3)

**Description:** Line 8 of `Code.gs` states `密码加盐：SHA-256(pwd + salt)，salt 随机 16 位 hex` but the implementation at line 409 is:
```js
function hashPwd_(password) { return sha256_(password); }
```
No salt. Every identical password hashes to the identical SHA-256 digest. All vendor and admin passwords share the same effective protection. A leaked Vendors sheet exposes every password to rainbow-table lookup.

**Fix:** Actually implement salt — generate 16 random hex bytes per password, store as `salt:hash`, use 1000+ iterations of `SHA-256(salt + password)`. Requires migration of existing `passwordHash` values in the Vendors sheet.

**Risk If Not Fixed:** Any sheet access leak (GAS console, backup export, error message) exposes all credentials. Combined with admin plaintext password (C13), authentication is broken at both layers.

---

### C4. Double-Submit Guard Missing on Place Order — Duplicate Orders Created

**Affected Files:** `js/student.js`, lines 754–766  
**Audit Source:** Customer Audit (#1)

**Description:** `CheckoutView.submit()` performs validation but has no `submitting` ref lock or button disabled-state guard. `store.placeOrder()` inserts optimistically and `emit('submitted')` changes the view step. On mobile, a rapid double-tap fires two click events before Vue re-renders, creating two identical orders in `state.orders`.

**Fix:** Add `const submitting = ref(false)` at the component level. Set `submitting.value = true` at line 754 before `store.placeOrder()`, reset to `false` in a `.finally()` block. Bind button `:disabled="submitting || !okSlots.length"`.

**Risk If Not Fixed:** Customers charged twice, duplicate orders clutter merchant pending list, stock double-decremented, membership points double-deducted.

---

### C5. NaN Stock Bypasses All Stock Guards — Infinite Ordering of Broken Items

**Affected Files:** `js/store.js`, line 339; `js/student.js`, lines 82, 85–86, 505  
**Audit Source:** Customer Audit (#2)

**Description:** `mapRemoteItem` converts `stock` to `Number(it.stock)`. If backend sends `stock: "INVALID"`, `Number("INVALID")` = `NaN`. This passes the truthiness check (`NaN !== ''` is `true`). Then `stockLeft` = `NaN - qty` = `NaN`. All guards fail: `NaN <= 0` is `false`, `NaN >= NaN` is `false`. The stepper never disables, the option-sheet never blocks.

**Fix:** At `store.js:339`:
```js
const n = Number(it.stock);
stock = (it.stock === '' || it.stock === null || it.stock === undefined || isNaN(n)) ? null : n;
```
Also add `isNaN(stock)` checks in all guard conditions as defense-in-depth.

**Risk If Not Fixed:** Unlimited ordering of broken-stock items. Backend rejects them (hopefully), but customer UX is confusing and merchant sees impossible orders.

---

### C6. `resetAll()` Destroys Entire Platform Data — One Merchant Can Wipe Everyone

**Affected Files:** `js/store.js`, lines 1385–1391; `js/merchant.js`, line 672  
**Audit Source:** Merchant Audit (B1)

**Description:** The "清空所有数据并恢复初始" button in merchant settings calls `store.resetAll()`, which executes `Object.assign(state, seedState())` — replacing the entire shared state (all merchants, all orders, all accounts) with seed data. In a multi-merchant setup, any single merchant clicking this button wipes every other merchant's data.

**Fix:** Either: (a) Remove the button from the merchant UI entirely (admin-only), or (b) Scope it to the current merchant's data only (delete own products, own orders; leave other merchants untouched). Also add a confirmation dialog with explicit warning text.

**Risk If Not Fixed:** Catastrophic data loss. One disgruntled or confused merchant erases the entire platform.

---

### C7. MRR Calculation Uses Wrong PRO_PRICE — Revenue Under-Reported by 26%

**Affected Files:** `js/store.js`, lines 1200–1201, 1222  
**Audit Source:** Admin Audit (F1)

**Description:** Constants `PRO_PRICE: 29` and `BASIC_PRICE: 29` are identical. The UI labels consistently show "专业版 RM 39/月" (admin.js:394–395). The MRR formula `proActive.length * this.PRO_PRICE + basicActive.length * this.BASIC_PRICE` thus under-reports professional-plan revenue by `proActive.count * RM 10` per month.

**Fix:** Change `PRO_PRICE` to `39` at line 1200.

**Risk If Not Fixed:** Billing dashboard KPI is wrong. Financial decisions based on incorrect MRR. If payment collection relies on this number, revenue is lost.

---

### C8. Admin Password Stored and Compared in Plaintext

**Affected Files:** `backend/Code.gs`, lines 698–716  
**Audit Source:** Admin Audit (S1)

**Description:** `adminLogin_` reads `ADMIN_USER` and `ADMIN_PASS` from Script Properties and compares using `String(body.password || '') === p` — direct plaintext comparison. Unlike vendor passwords (which at least use SHA-256), the admin password has no hashing at all. If Script Properties are ever exposed (GAS console access, debug endpoint, error message), the admin password is immediately compromised in cleartext.

**Fix:** Store `hashPwd_(ADMIN_PASS)` in Script Properties. Hash the submitted password before comparing. Also add salt (see C3).

**Risk If Not Fixed:** Admin account trivially compromised by anyone with GAS Script Properties access. Full platform control lost.

---

### C9. `removeVendor_` Does Not Cascade to Payments Table — Orphan Records Accumulate

**Affected Files:** `backend/Code.gs`, lines 1165–1173; `js/store.js`, lines 1368–1383  
**Audit Sources:** Backend & Worker Audit (#7), Admin Audit (F5, D1)

**Description:** `removeVendor_` deletes rows from `TAB_VENDORS`, `TAB_ORDERS`, `TAB_MENU` but omits `TAB_PAYMENTS`. Frontend `removeMerchant` also does not touch `state.payments`. After deleting a vendor, payment rows become orphans — they inflate `revenueAll` in `billingSummary`, appear as unlabeled entries (raw `vendorId`) in the billing tab, and accumulate garbage rows forever.

**Fix:** Add `cacheDelete_(TAB_PAYMENTS, 'vendorId', vendorId);` to `removeVendor_` in Code.gs:1173. In the frontend, filter `state.payments` by the removed vendorId.

**Risk If Not Fixed:** Billing reports permanently wrong. Payment history accumulates incorrect data. User sees raw IDs in the UI.

---

### C10. Server Trusts Client-Computed Line-Item Prices — No Menu Cross-Reference

**Affected Files:** `backend/Code.gs`, lines 973–998  
**Audit Source:** Backend & Worker Audit (#4)

**Description:** The server calculates `srvSubtotal` using `Number(it.price)` from the client-submitted items array and writes these prices directly into the order. Options (e.g., extra egg +RM 1.5) are stored as a flat sanitized string. The server never cross-references the submitted per-item price against the menu's base price + selected option surcharges. A malicious client can submit `price: 0.01` for every item.

**Fix:** For each item, look up the menu item by `itemId`, sum the base price + checked option surcharges from `settings.options`, and use that server-computed price. Reject if client price doesn't match within rounding tolerance.

**Risk If Not Fixed:** Revenue leakage. Malicious users pay arbitrary amounts. Financial records permanently wrong.

---

### C11. Server Trusts Client-Computed Fees — Packaging and Delivery Fees Not Validated

**Affected Files:** `backend/Code.gs`, lines 975  
**Audit Source:** Backend & Worker Audit (#5)

**Description:** `o.total = Math.round((srvSubtotal + (Number(o.packagingFee) || 0) + (Number(o.deliveryFee) || 0) - membershipDiscount) * 100) / 100;` The packaging and delivery fees come directly from the client request body. The server never validates them against `settings.fees.packaging.amount` or `settings.fees.delivery.amount`. A client can submit `packagingFee: 0` and `deliveryFee: 0`.

**Fix:** Read the vendor's `settings.fees` and enforce the correct amounts server-side. If `fees.packaging.enabled`, use `fees.packaging.amount`. Same for delivery fee.

**Risk If Not Fixed:** Revenue leakage. Combined with C10, a client can place an order paying only membership discount — potentially RM 0.

---

### C12. Membership Points Lost on Concurrent Orders — Single JSON Blob Race

**Affected Files:** `backend/Code.gs`, lines 1001–1011; `js/store.js`, line 1010  
**Audit Sources:** Backend & Worker Audit (#6), Customer Audit (#4)

**Description:** The entire `settingsJson` is read, modified in memory (points earned/redeemed), and written back as one JSON blob. If two orders arrive concurrently (amplified by the broken lock in C1), one order's point mutation overwrites the other's. Points are permanently lost with no audit log. Additionally, the frontend sets `membershipJson: ''` on every `placeOrder` regardless of redemption, and never decrements local points optimistically.

**Fix:** Store membership points in a separate sheet (one row per `phone+vendorId`) so point updates are row-level atomic. In the frontend, persist redemption data in `membershipJson` and decrement the local balance on order placement.

**Risk If Not Fixed:** Membership system unreliable. Points silently disappear. Customers lose earned rewards. Merchant loyalty program trust destroyed.

---

### C13. Hardcoded Weak Password Reset ("1234") in Admin Panel

**Affected Files:** `js/admin.js`, line 269  
**Audit Source:** Admin Audit (S5)

**Description:** The admin merchant edit form has a button labeled "重置为 1234" that sets the password field to `'1234'`. This hardcoded weak password is trivially dictionary-attackable even after backend hashing (since no salt — see C3). Visible to anyone with admin.html access. A single accidental click compromises a real merchant.

**Fix:** Replace with a random-password generator (e.g., 8 random alphanumeric chars displayed in a one-time alert). Remove the hardcoded value from source entirely.

**Risk If Not Fixed:** Real merchant accounts trivially compromised by admin error or malicious admin.

---

## High Priority (🟠) — Should Fix Before Launch

---

### H1. `cacheFlush_` Rewrites All Rows on Every Mutation — Quota Exhaustion Risk

**Affected Files:** `backend/Code.gs`, lines 134–157  
**Audit Source:** Backend & Worker Audit (#8)

**Description:** Every flush executes `deleteRows` for the entire data region, then `setValues` for every row in the table. With 1,000 orders × 27 columns = 27,000 cell writes per single status update. GAS has ~10M cell/day quota and a 6-minute execution limit. At scale, a few hundred mutations per day exhaust the quota.

**Fix:** Track individual row changes. Use `getRange(row, col).setValue(val)` for single-cell updates and `appendRow` for new rows. Reserve full-table rewrites for schema migrations only.

**Risk If Not Fixed:** Platform hits GAS quota mid-day. Orders stop processing. All merchants affected simultaneously.

---

### H2. Worker Cache Invalidation Gaps — Stale Data Served to Clients

**Affected Files:** `worker/src/index.js`, lines 428–450  
**Audit Source:** Backend & Worker Audit (#9, #10); Admin Audit (F3, F4)

**Description:** Multiple cache invalidation gaps:
- `updateOrderStatus`/`cancelOrder` only invalidate `getOrder`, not `getVendorOrders` → merchant polling shows stale status for up to 5s
- `saveVendorConfig` only invalidates `getStorefront`, not `listPublicVendors` → client homepage shows closed vendors as open for up to 30s
- `saveHubBuildings`/`removeHubBuilding` not in INVALIDATION map → customer hub picker stale for up to 3600s
- `resetSeedData`/`wipeAllData` have NO cache invalidation → stale cache for up to 3600s after data reset

**Fix:** Add all missing invalidation targets. For `resetSeedData`/`wipeAllData`, flush the entire Worker cache. Consider shorter TTLs (e.g., `listHubs`: 60s instead of 3600s) as defense-in-depth.

**Risk If Not Fixed:** Customers see closed shops as open. Hub building lists stale for an hour. Data resets invisible to clients.

---

### H3. No Rate Limiting on Non-Login Endpoints — GAS Quota Exhaustion + Enumeration

**Affected Files:** `backend/Code.gs`, lines 490–559; `worker/src/index.js`  
**Audit Sources:** Backend & Worker Audit (#12), Admin Audit (S2)

**Description:** Rate limiting exists only for login attempts. Every other endpoint — `placeOrder`, `getStorefront`, `getMembership`, `listPublicVendors`, `saveProduct` — is unthrottled. An attacker can flood `placeOrder` to create unlimited orders, exhaust GAS quota (90 min/day), or enumerate valid phone numbers via `getMembership_` (different responses for valid vs. invalid).

**Fix:** Implement per-IP/per-action rate limiting in the Worker layer using a simple KV counter. At minimum, add rate limits on `placeOrder` (10/min), `getMembership` (5/min per phone), and `getStorefront` (60/min per IP).

**Risk If Not Fixed:** Platform DoS-able by a single script. GAS quota exhausted. Customer PII enumerable.

---

### H4. Payment Screenshots Shared as `ANYONE_WITH_LINK` in Google Drive

**Affected Files:** `backend/Code.gs`, line 466  
**Audit Source:** Backend & Worker Audit (#13)

**Description:** `file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW)` makes payment screenshots publicly accessible to anyone who knows or guesses the Drive file ID. These images contain bank account numbers, real names, transaction references, and QR codes. Drive file IDs are enumerable through thumbnail URL patterns.

**Fix:** Serve screenshots through a GAS web-app endpoint that requires authentication, returning the image bytes via `ContentService`. Alternatively, use `DriveApp.Access.DOMAIN` if all users are in a Google Workspace domain.

**Risk If Not Fixed:** Financial PII of every customer exposed. Legal liability under data protection laws.

---

### H5. Pre-Order Cart Enabled But Checkout Blocked After All Slots Pass

**Affected Files:** `js/student.js`, lines 49, 85, 699, 750  
**Audit Source:** Customer Audit (#5)

**Description:** When a shop has `preorder: true` but is closed, the cart bar is shown and items can be added. However, the `closed` computed checks TODAY's slots only. If it's 10pm and the shop offers 12:00/18:00 slots, all have passed. The submit button shows "今日已截止" and is disabled. The user has a full cart but cannot check out. The pre-order feature should allow selecting future dates.

**Fix:** When `preorder: true` and shop is closed but all today's slots have passed, show a date picker for tomorrow's slots. Or at minimum, show a clear message: "今日配送时段已截止，明天 X:00 起可下单".

**Risk If Not Fixed:** Pre-order feature non-functional after last slot passes each day. False advertising — users can build carts but never check out.

---

### H6. "下单成功" Toast Shown Before Server Confirmation — Misleading UX

**Affected Files:** `js/student.js`, line 764  
**Audit Source:** Customer Audit (#6)

**Description:** `submit()` calls `store.placeOrder()` (optimistic insert), then immediately shows `store.toastSuccess('🎉 下单成功！')`. If the server later rejects the order (e.g., stock exhausted, slot full), the user has already seen success and may close the browser. When they return, the order shows as rejected — feeling like a bug.

**Fix:** Show "订单已提交，正在确认..." toast instead. After server sync confirms the status, show the final result. Or at minimum, push a notification if the order transitions to rejected after a success toast.

**Risk If Not Fixed:** Trust erosion. Users see success then failure. Support burden from confused customers.

---

### H7. Stored XSS via QR Code Image URL in `openTab` Popup

**Affected Files:** `js/student.js`, lines 753–754  
**Audit Source:** Customer Audit (#7)

**Description:** `openTab` uses string concatenation to build HTML for a popup:
```js
w.document.write('<title>收款码</title><body ...><img src="' + src + '" ...>');
```
If a malicious merchant sets their payment QR URL to `data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"><script>alert(document.cookie)</script></svg>`, the popup executes injected JavaScript. While the popup is a separate origin, the injected script can redirect to phishing pages.

**Fix:** Use `encodeURI(src)` for the img src attribute, or use `w.document.createElement('img')` + `img.src = src` (which handles attribute escaping properly). Additionally, restrict QR URLs to `https:` protocol only.

**Risk If Not Fixed:** XSS via merchant-controlled data. Phishing possible. Payment QR tampering.

---

### H8. `saveProfile` Silently Drops Building/Room When Address Book Exists

**Affected Files:** `js/store.js`, lines 878–894  
**Audit Source:** Customer Audit (#3)

**Description:** When `saveProfile()` receives `{ name, phone, building, room }` without an `addresses` array, the branch at line 888 (existing address book) updates only `name` and `phone`, completely ignoring `building` and `room`. The user's address change is silently discarded.

**Fix:** In the address-book branch, also update building/room on the address entries.

**Risk If Not Fixed:** Customer address changes silently lost. Deliveries go to old address. Customer blames merchant.

---

### H9. Image Compression Errors Silently Swallowed — Both Customer and Merchant Sides

**Affected Files:** `js/student.js`, line 752; `js/merchant.js`, line 19  
**Audit Sources:** Customer Audit (#18), Merchant Audit (B5)

**Description:** Both `compressImage` call sites use `.catch(() => {})` to silently ignore all compression errors. Corrupt files, OOM on large images, and non-image files masquerading as images all fail silently. The file input is also reset (`e.target.value = ''`), preventing retry. Users have no feedback that upload failed.

**Fix:** Surface error toast: "图片处理失败，请尝试更小的图片或刷新页面". Do not reset the file input on error. Add file size check before attempting to load into memory (reject > 10MB).

**Risk If Not Fixed:** Payment screenshots silently fail to attach. Orders placed without proof. Merchant menu photos missing.

---

### H10. clearTestData Frontend/Backend Asymmetry — Stale Test Data Persists

**Affected Files:** `js/store.js`, lines 1298–1306; `backend/Code.gs`, lines 1287–1300  
**Audit Sources:** Admin Audit (F2, D2)

**Description:** Backend clears Orders, Menu, Vendors, Payments (all with `isTest='TEST'`). Frontend clears only Orders and Payments — test vendors, test menu items, and test accounts remain in `state.merchants` and `state.accounts`. Additionally, `TAB_SUBSCRIPTIONS` is not cleared by either side. Test subscriptions accumulate and waste Worker push quotas. `clearTestData_` also omits `TAB_SUBSCRIPTIONS`; `resetSeedData_` skips Subscriptions entirely.

**Fix:** Frontend: also clear test vendors/menu/accounts. Backend: add `TAB_SUBSCRIPTIONS` to `clearTestData_` table list and `resetSeedData_` tab list. Also add `isTest: true` to seed data orders (lines 232–315 in store.js) so `testDataCount()` is accurate.

**Risk If Not Fixed:** Test data leaks into production views. Test subscriptions waste quotas. Test tab counter misleading.

---

### H11. AudioContext Fails Silently Outside User Gesture — Ringer Never Sounds

**Affected Files:** `js/merchant-ringer.js`, lines 63–71, 101–124  
**Audit Source:** Merchant Audit (R1)

**Description:** `ensureCtx()` creates or returns an AudioContext. If created outside a user gesture (e.g., from a polling callback), it enters `suspended` state. `startLoop()` attempts `ctx.resume().catch(() => {})` — if it fails, no error is surfaced. The merchant sees "ringing" status but hears nothing. Only `testBeep()` returns a `false` value and triggers a toast; the actual ring start path is silent on failure.

**Fix:** After `ctx.resume()`, check `ctx.state === 'running'`. If suspended, show a toast: "浏览器已阻止音频播放，请点击页面任意位置后刷新". Also call `ctx.resume()` on the first user click event (`document.addEventListener('click', ..., { once: true })`).

**Risk If Not Fixed:** Merchants miss new orders. Silent ringer = no alert. Delayed deliveries.

---

### H12. Token Sent in Request Body and Stored in localStorage — Exposure Risk

**Affected Files:** `js/store.js`, line 709; `js/api.js`, lines 55–71  
**Audit Source:** Merchant Audit (S1)

**Description:** Auth tokens are sent in the POST body (`Object.assign({}, payload, { token: auth.token })`) rather than as an `Authorization` header. Stored in plaintext localStorage. Any XSS in the app exposes the token. Tokens are also included in cacheable API requests (the `CACHEABLE` check at api.js:59 doesn't prevent token inclusion), meaning tokens could be cached at Cloudflare's edge.

**Fix:** Send token as `Authorization: Bearer <token>` header. This keeps it out of cache keys and request body logging. Add `HttpOnly` cookie consideration for future.

**Risk If Not Fixed:** Token theft via XSS. Token cached at edge. Session hijacking possible.

---

### H13. Batch Delivery Has No Confirmation Dialog — Accidental Multi-Order Delivery

**Affected Files:** `js/merchant.js`, lines 317–326  
**Audit Source:** Merchant Audit (B6)

**Description:** `batchDeliverGo()` immediately delivers all selected orders with no confirmation step. The button "全部送达 (N 单)" is styled as `btn--primary btn--block` — prominently placed and easily misclicked. One accidental tap irreversibly marks multiple orders as delivered.

**Fix:** Add a confirmation modal: "确认将 N 个订单标记为已送达？此操作不可撤销。" with explicit "确认送达" and "取消" buttons.

**Risk If Not Fixed:** Mass accidental delivery. Customers receive delivery notifications for undelivered food. Support nightmare.

---

### H14. Preview-as-Customer Can Create Real Self-Orders

**Affected Files:** `js/store.js`, line 981; `js/merchant.js`, line 27  
**Audit Source:** Merchant Audit (B7)

**Description:** "预览客户端" calls `store.previewAsStudent()` rendering the full student ordering flow for the merchant's own shop. The merchant can complete checkout and place an order to themselves, creating confusing self-orders in the pending list.

**Fix:** Either: (a) add a `previewOnly` flag that blocks `placeOrder` when in preview mode, showing "预览模式，无法下单", or (b) add `isPreview: true` to orders created in preview mode and filter them from the merchant's order list.

**Risk If Not Fixed:** Cluttered pending list. Merchants accidentally order from themselves. Confusion and wasted time.

---

### H15. Pending Count Inconsistency Across Three UI Locations

**Affected Files:** `js/merchant.js`, lines 25–26, 38, 51, 114  
**Audit Source:** Merchant Audit (U1)

**Description:** Three different counters show different numbers:
- Action bar: "🔔 {{ pendingCount }} 个新订单待处理" (pending only)
- Pending tab badge: counts pending only
- Doing tab badge: counts cooking + delivering
- Bottom nav dot: counts pending only

With 2 pending, 3 cooking, 1 delivering orders, the merchant sees: "2" in action bar, "2" on pending tab, "4" on doing tab, "2" dot on bottom nav. No single number tells them how many orders need total attention.

**Fix:** Unify the action bar count to show `pendingCount + cookingCount + deliveringCount` with a label like "{{ total }} 个订单进行中". Or provide per-status breakdown: "2 待处理 · 3 制作中 · 1 配送中".

**Risk If Not Fixed:** Merchant confusion. Missed orders. Trust in the alert system eroded.

---

### H16. Rejected Orders Do Not Restore Stock or Membership Points Optimistically

**Affected Files:** `js/store.js`, line 1081  
**Audit Source:** Merchant Audit (E3)

**Description:** `rejectOrder` sets `o.status = 'rejected'` but does NOT restore item stock or refund membership points locally. The menu still shows the item as sold out until a full menu reload, and the customer's points are not refunded until the next `getMembership` call. With the Worker cache on `getStorefront` (60s TTL), stale stock info persists.

**Fix:** In `rejectOrder`, iterate the order's items and increment stock in `state.merchants[vid].menu`. For membership, call `loadMembership` to refresh points. Alternatively, handle this server-side and let the next poll fix it — but reduce the Worker cache TTL for affected keys.

**Risk If Not Fixed:** Stock counts wrong after rejection. Items incorrectly show as sold out. Customer points appear lost.

---

### H17. `normalizeRemoteOrder` Does Not Include `hubId`

**Affected Files:** `js/store.js`, lines 322–335  
**Audit Source:** Merchant Audit (B4)

**Description:** When remote orders are normalized, `hubId` is never set on the returned object. Seed orders include `hubId`, so the inconsistency is silent in local-only mode. In online mode, remote orders have `hubId: undefined`, breaking any downstream logic that filters or groups by hub (admin analytics, cross-hub views).

**Fix:** Add `hubId` to the destructured fields (probably `hubId` or `hub_id` from the backend response) and include it in the returned object.

**Risk If Not Fixed:** Admin hub-distribution analytics broken. Multi-hub deployments show incorrect data.

---

### H18. "用示例照片测试" Button Visible in Production

**Affected Files:** `js/merchant.js`, lines 176, 190, 243  
**Audit Source:** Merchant Audit (U3)

**Description:** The "用示例照片测试" button appears in the delivery photo upload section and batch delivery UI. It inserts a placeholder SVG image as the delivery proof. In production, merchants can accidentally send fake delivery photos to real customers.

**Fix:** Wrap the button in a `v-if` that checks a dev/debug flag (e.g., `store.state.debugMode` or `location.hostname === 'localhost'`). Or remove entirely — the feature adds no production value.

**Risk If Not Fixed:** Fake delivery photos sent to customers. Trust destroyed. Dispute resolution impossible.

---

### H19. PRO Upgrade Prompt Is a Dead End — No Actionable Path

**Affected Files:** `js/merchant.js`, lines 82–85  
**Audit Source:** Merchant Audit (U4)

**Description:** The upgrade prompt shows pricing info but "联系平台升级" opens only a toast: "请通过平台客服/管理员开通专业版" — no WhatsApp link, no email, no action. The layout visually implies two clickable pricing options but they are static text.

**Fix:** Add an actual action: a WhatsApp link to platform admin, or an email `mailto:` link, or an in-app upgrade request that creates a notification for the admin. At minimum, show a phone number or contact info.

**Risk If Not Fixed:** Revenue blocked. Merchants want to upgrade but cannot. Lost subscription revenue.

---

### H20. CORS Allows All Origins (`*`) — CSRF and Data Exfiltration

**Affected Files:** `worker/src/index.js`, line 192  
**Audit Source:** Backend & Worker Audit (#14)

**Description:** `Access-Control-Allow-Origin: *` allows any website to make authenticated requests with the user's cookies/tokens. A malicious site visited in another tab can place orders, read order history, or scrape vendor data.

**Fix:** Whitelist known frontend origins: `https://tuantuan-app.github.io` and the Worker domain. Use `Access-Control-Allow-Credentials: true` only for authenticated endpoints.

**Risk If Not Fixed:** CSRF attacks possible. Customer data exfiltrated from third-party sites.

---

### H21. `saveProduct_` Allows Cross-Vendor Overwrite via Guessed itemId

**Affected Files:** `backend/Code.gs`, lines 823–836  
**Audit Source:** Backend & Worker Audit (#11)

**Description:** `cacheUpsert_(TAB_MENU, 'itemId', p)` matches on `itemId` only — not on `vendorId`. Auth only verifies the token matches `p.vendorId` (which the attacker sets to their own). If vendor A guesses vendor B's itemId and includes it in their `saveProduct` call, the existing row is overwritten.

**Fix:** In `saveProduct_`, if the itemId already exists, verify the existing row's `vendorId` matches the caller's vendorId. Reject cross-vendor overwrites.

**Risk If Not Fixed:** Malicious merchant overwrites competitor's menu items. Price manipulation. Menu corruption.

---

### H22. `vendorLogin_` Error Messages Enable Username Enumeration

**Affected Files:** `backend/Code.gs`, lines 673–685  
**Audit Source:** Backend & Worker Audit (#15)

**Description:** Different error messages for "账号不存在" vs. "密码错误" allow an attacker to enumerate valid vendor usernames. While per-username rate limiting exists (5 fails/15 min), an attacker with a candidate list can probe systematically.

**Fix:** Return a generic error: `'账号或密码错误'` for both cases.

**Risk If Not Fixed:** Account enumeration. Targeted password attacks on known-valid usernames.

---

## Medium Priority (🟡) — Fix in First Patch After Launch

---

### M1. Order Polling Continues on Terminal Orders Without `pollIntervalMs: 0`

**Files:** `js/student.js`, lines 848–870 | **Source:** Customer #8

If the server transitions an order to `delivered`/`rejected`/`cancelled` without `pollIntervalMs: 0` in the response, the `setInterval` continues indefinitely. **Fix:** Also stop polling when order status is terminal in the poll response body.

### M2. Reorder 150ms Timeout Insufficient for Cold Menu Fetch

**Files:** `js/student.js`, lines 114–126 | **Source:** Customer #9

On slow 3G, `store.studentMerchant` may be null/empty. Items silently skipped. **Fix:** Use `await`/polling pattern instead of fixed timeout, or queue items and retry after menu loads.

### M3. WhatsApp Link Malformed for Non-Malaysian Numbers

**Files:** `js/student.js`, lines 891–911 | **Source:** Customer #10

The `merchantWa` computed assumes all numbers are Malaysian (prepends `60`). Singapore, Thai, Indonesian numbers produce broken WhatsApp links. **Fix:** Use a proper international phone number parsing library, or store the full international number with country code.

### M4. Empty Addresses Array with Existing Profile = Blank Address Card, No Remediation

**Files:** `js/student.js`, line 623; `js/store.js`, lines 901–905 | **Source:** Customer #11

If profile exists but addresses array is empty, the address card is hidden with no fallback to prompt adding one. **Fix:** Show "请添加收货地址" prompt when addresses array is empty.

### M5. SWR Cache Serves Stale Data on Refresh Failure with No Indicator

**Files:** `js/store.js`, lines 663–673, 941–968 | **Source:** Customer #12

When background refresh fails, user stares at stale data with no "last updated" timestamp or warning. **Fix:** Add a subtle "数据可能已过期" indicator and a retry button when refresh fails.

### M6. Disabled "加入购物车" Button Gives No Reason for Required Options

**Files:** `js/student.js`, lines 602, 604–606 | **Source:** Customer #13

First-time users see a disabled button with no explanation that a size/option must be selected first. **Fix:** Show inline hint: "请选择份量" below unselected required option groups.

### M7. Modal Traps User When No Hubs Loaded — Cannot Dismiss or Retry

**Files:** `js/student.js`, lines 155–168, 220–231 | **Source:** Customer #14

`dismissPicker` is a no-op. If API hasn't loaded hubs yet, user is trapped in the modal. **Fix:** Add a dismiss button and a "重试" button. Allow backdrop click to dismiss.

### M8. 8-Second `_localMutAt` Protection Window Too Short for High-Latency Networks

**Files:** `js/store.js`, lines 754–810 | **Source:** Customer #15

Local mutations are protected from server overwrites for only 8 seconds. On slow networks, a poll response arriving > 8s after local cancel/approve can overwrite the local change. **Fix:** Increase to 30s, or use a version counter from the server.

### M9. Corrupted Base64 Screenshots Fail Silently on Resume Sync

**Files:** `js/store.js`, lines 1048–1062 | **Source:** Customer #16

If a data URI becomes corrupted in localStorage (partial write, quota exceeded), `resumePendingSyncs` fails silently. **Fix:** Detect corruption (try loading the image), flag as failed, show toast.

### M10. Plaintext Phone Numbers in localStorage

**Files:** `js/store.js`, lines 19, 899 | **Source:** Customer #17

Customer profiles with names and phone numbers stored in plaintext localStorage. **Fix:** At minimum, document this as a known risk. Consider encrypting PII fields with a device-derived key.

### M11. Unbounded `_alerted` Set Growth

**Files:** `js/merchant.js`, lines 54–58 | **Source:** Merchant D1

The `_alerted` Set tracks alerted order IDs but never prunes old entries. **Fix:** Prune entries for orders no longer in `pending` status during each poll cycle.

### M12. Polling Paused When Order Detail Modal Open — Missed Updates

**Files:** `js/merchant.js`, line 290 | **Source:** Merchant D2

When merchant has order detail open, polling pauses. If modal stays open for minutes, all new orders are missed until modal closes + next interval. **Fix:** Run poll in background even with modal open, or force-poll immediately on modal close.

### M13. Payment Data Not Persisted to localStorage

**Files:** `js/store.js`, line 1411 | **Source:** Merchant D3

`payments` is not in `_persistKeys`. Payment history lost on page reload. **Fix:** Add `'payments'` to the persistence key set.

### M14. Rapid God-View Switching Can Skip Data Hydration

**Files:** `js/console.js`, lines 111–116; `js/store.js`, lines 643–659 | **Source:** Admin E2

`_merchantDataLoaded[id]` set to `true` before fetch completes. If first load fails and second switch happens quickly, data is never hydrated. **Fix:** Set flag only after successful fetch. Add retry on flag collision.

### M15. Six Admin Computed Properties Each Full-Scan Orders Array

**Files:** `js/admin.js`, lines 103–136 | **Source:** Admin E3

At 1000+ orders, each filter/map/reduce pass scans the full array, leading to 6+ full scans on every data change. **Fix:** Pre-compute derived data structures once, or use `shallowRef` for the orders array with manual trigger.

### M16. No Worker Secret Rotation Mechanism

**Files:** `worker/src/index.js`, lines 137–139; `backend/Code.gs`, lines 319–323 | **Source:** Admin E5

Single hardcoded `WORKER_SECRET`. No versioning or secret-list approach for rotation without downtime. **Fix:** Support a list of valid secrets, add new before removing old during rotation.

### M17. Orphan Payment Rows Show Raw vendorId in Billing Tab

**Files:** `js/admin.js`, lines 383, 427 | **Source:** Admin UX1

After merchant deletion, payment rows show raw vendorId string with no "(已删除)" indicator. **Fix:** Add visual badge for deleted merchants in the payment list, or cascade-delete payments.

### M18. Seed Merchants Lack `isTest` Flag in Local Data

**Files:** `js/store.js`, lines 178–223 | **Source:** Admin UX2, D3

Seed merchants and orders don't have `isTest` set, so `testDataCount()` returns 0 initially. In offline mode, demo and real merchants are indistinguishable. **Fix:** Add `isTest: 'TEST'` to seed merchants and `isTest: true` to seed orders.

### M19. Only Last Sync Error Survives in `syncError`

**Files:** `js/store.js`, lines 732–743 | **Source:** Admin UX6

`syncError` is overwritten by subsequent sync attempts. If 5 operations fail and 1 succeeds, only the last error is visible. **Fix:** Accumulate errors in an array, show count: "N 个操作同步失败".

### M20. `resetSeedData` Does Not Invalidate Client/Worker Caches

**Files:** `backend/Code.gs`, lines 1303–1322 | **Source:** Admin D4

`resetSeedData_` resets `SEEDED5` and `SCHEMA_READY7` but does not purge Worker disk cache or signal clients to clear localStorage. **Fix:** Add cache invalidation as discussed in H2. Also consider adding a `seedVersion` field to API responses so clients can detect and auto-reload.

### M21. Token Signature Truncated to 96 Bits

**Files:** `backend/Code.gs`, line 420 | **Source:** Backend & Worker Audit (#16)

Only first 24 hex chars of SHA-256 HMAC used. While infeasible to brute-force online, reduces margin against offline attacks. **Fix:** Use full 64-char hex digest.

### M22. `getMembership` Not Cached by Worker — Unnecessary GAS Calls

**Files:** `worker/src/index.js`, lines 409–425 | **Source:** Backend & Worker Audit (#17)

Every storefront page load triggers one `getMembership` GAS call even though data changes infrequently. **Fix:** Add to READ_TTL with 10s TTL, and add invalidation on `placeOrder`.

### M23. Synchronous Push Delivery Loop Delays HTTP Response

**Files:** `backend/Code.gs`, lines 1423–1433 | **Source:** Backend & Worker Audit (#18)

Each push notification is sent synchronously in a `for` loop. 10 devices = 10 sequential round-trips. **Fix:** Batch all subscriptions into a single Worker request; Worker fans out concurrently.

### M24. `inQuietHours` Requires Both Start and End Fields Set

**Files:** `js/merchant-ringer.js`, lines 47–53 | **Source:** Merchant R2

If merchant sets only `quietStart` but leaves `quietEnd` empty, quiet hours never activate. No UI validation. **Fix:** Require both fields if either is set, or add a toggle for quiet hours and default end to "08:00".

### M25. CRM Customer Aggregation Key (`phone || name`) Unreliable

**Files:** `js/merchant-crm.js`, line 215 | **Source:** Merchant C2

Two different customers with the same name but different phones are merged. A customer who changes phone numbers appears as two entries. **Fix:** Use `phone` (normalized) as the primary key. Fall back to `phone + '_' + building` for customers without phone.

### M26. Member Phone Numbers Displayed in Full Without Masking

**Files:** `js/merchant-crm.js`, lines 52–56 | **Source:** Merchant C3

Membership customer list shows full phone numbers in an always-visible table. **Fix:** Show as `012-3456***` or behind a click-to-reveal toggle. Merchants need numbers for delivery but not in a persistent table view.

### M27. `addHubBuilding` Lacks `adminGuard_` — Merchants Can Pollute Hub Pool

**Files:** `backend/Code.gs`, lines 529, 1187–1208 | **Source:** Admin S6

Any authenticated merchant can add arbitrary building names to their community's hub pool. **Fix:** Add `adminGuard_` for bulk operations, or rate-limit building additions per merchant.

---

## Low Priority (🟢) — Nice to Have

---

### L1. `compressImage` Failure Gives Zero User Feedback (Student)

**Files:** `js/student.js`, line 752 | **Source:** Customer #18 (duplicate of H9, student-specific)

### L2. No Screenshot Quality Verification After Compression

**Files:** `js/student.js`, lines 692–693; `js/store.js`, lines 50–69 | **Source:** Customer #19

**Fix:** Show file size before/after compression. Allow zoom on preview. If compressed size < 20KB, warn about potential illegibility.

### L3. Cart Cleared Before Order Confirmed — Rejected Orders Lose Cart

**Files:** `js/student.js`, line 102 | **Source:** Customer #20

`onSubmitted()` calls `clearCart()` immediately. If order is rejected, cart is gone. The "再来一单" flow skips items with option groups. **Fix:** Save cart snapshot before clearing. Restore on rejection.

### L4. localStorage Quota Can Silently Drop Optimistic Orders

**Files:** `js/store.js`, lines 1400–1405 | **Source:** Customer #21

15+ offline orders with base64 screenshots can exceed 5-10MB quota. `persistState` fails silently. **Fix:** Track storage usage. Warn user when approaching limit. Prioritize order persistence over menu cache.

### L5. CSP Allows `'unsafe-eval'` in All Three HTML Files

**Files:** `index.html:8`, `merchant.html:6`, `admin.html:8–16` | **Source:** Customer #22, Merchant S3, Admin (implied)

**Fix:** Pre-compile Vue templates at build time to remove `'unsafe-eval'` requirement. Use nonce or hash-based CSP for inline scripts.

### L6. `TAB_HEADERS` Undefined — Quota Calculation Uses Fallback Values

**Files:** `backend/Code.gs`, lines 601–602 | **Source:** Backend & Worker Audit (#19)

`TAB_HEADERS` is never defined. Expression short-circuits to fallback values (20, 12). Cell-count estimate always wrong. **Fix:** Use `SCHEMA[tabName].length` instead.

### L7. No Request Body Size Limit on Worker `/push` Endpoint

**Files:** `worker/src/index.js`, lines 142–144 | **Source:** Backend & Worker Audit (#20)

**Fix:** Check `Content-Length` before parsing. Reject > 64KB payloads.

### L8. `connect-src` Allows All `*.workers.dev` Subdomains

**Files:** `merchant.html`, line 6 | **Source:** Merchant S4

**Fix:** Restrict to the app's specific Worker subdomain only.

### L9. GAS Error Response Leaks Raw Exception Messages

**Files:** `backend/Code.gs`, lines 555–559 | **Source:** Backend & Worker Audit (#20)

**Fix:** Log full error internally, return generic "系统异常，请稍后再试" to clients.

### L10. Undo Stack Limited to 5 Items, No Warning

**Files:** `js/store.js`, lines 1107–1111 | **Source:** Merchant D5

**Fix:** Show warning "撤销历史已满，最早的删除记录将被清除" when shifting. Increase stack to 10.

### L11. Escalated Object Never Cleaned of Stopped Orders

**Files:** `js/merchant-ringer.js`, lines 139–156 | **Source:** Merchant R4

**Fix:** Clean `escalated[orderId]` on status change to non-pending, not just on `stop()`.

### L12. `window.prompt` for Bulk Building Editing — Unusable With Many Buildings

**Files:** `js/admin.js`, line 208 | **Source:** Admin UX4

**Fix:** Use a `<textarea>` modal instead of `window.prompt()`.

### L13. Single-Line `window.prompt` for Payment QR Code Label

**Files:** `js/merchant.js`, line 679 | **Source:** Merchant U6

**Fix:** Use a proper modal with text input.

### L14. No Confirmation for "设为营业/设为休息" Toggle

**Files:** `js/admin.js`, line 236 | **Source:** Admin UX3

### L15. Dashboard Refresh Button Lacks Debounce

**Files:** `js/admin.js`, line 100 | **Source:** Admin UX5

### L16. Escalation Timer Fires After Max Duration Expired (Intended but Confusing)

**Files:** `js/merchant-ringer.js`, lines 118–123, 137–146 | **Source:** Merchant R3

**Fix:** Add clarifying comment or rename `stopTimer` to `stopCurrentBurst`.

### L17. `qtyOf` / `stockLeft` Use Item-Level Aggregation Across Options (Unclear UX)

**Files:** `js/student.js`, lines 80, 82 | **Source:** Customer #21 (Edge Case)

**Fix:** Add tooltip: "所有规格共享库存" when item has options.

---

## Role-by-Role Test Coverage Matrix

| Role | Feature | Status | Notes |
|------|---------|--------|-------|
| **Customer** | Browse public vendors | ⚠️ Issues | SWR cache stale on refresh failure (M5); hub picker traps on empty (M7) |
| **Customer** | View storefront | ⚠️ Issues | NaN stock bypass (C5); membership points not updated (C12) |
| **Customer** | Add to cart (options) | ⚠️ Issues | Disabled button no explanation (M6); shared stock pool unclear (L17) |
| **Customer** | Checkout | ❌ Broken | Double-submit creates dupes (C4); address edits silently lost (H8); toast before confirm (H6); pre-order blocked (H5); empty addresses = blank card (M4) |
| **Customer** | Upload payment screenshot | ⚠️ Issues | Silent compression failure (H9); no quality preview (L2); cart cleared on reject (L3) |
| **Customer** | Order status tracking | ⚠️ Issues | Polling indefinite (M1); 8s mut protection too short (M8) |
| **Customer** | WhatsApp merchant | ⚠️ Issues | Non-Malaysian numbers broken (M3) |
| **Customer** | QR code view | ❌ Broken | Stored XSS via merchant QR URL (H7) |
| **Customer** | Reorder | ⚠️ Issues | 150ms timeout insufficient (M2) |
| **Customer** | Profile management | ⚠️ Issues | Plaintext PII in localStorage (M10) |
| **Merchant** | Login | ⚠️ Issues | Unsalted passwords (C3); username enumeration (H22) |
| **Merchant** | View orders (polling) | ⚠️ Issues | Polling pauses on modal open (M12); count inconsistency (H15); stale after status change (H2) |
| **Merchant** | Approve/Reject/Advance orders | ❌ Broken | No status guards (C2); rejected orders don't restore stock (H16); advanceOrder skips approve (C2) |
| **Merchant** | Batch delivery | ❌ Broken | No confirmation (H13); no status re-validation (C2); test photo button in prod (H18) |
| **Merchant** | Menu management | ⚠️ Issues | Image compression silent fail (H9); undo stack limited (L10); cross-vendor overwrite (H21) |
| **Merchant** | Settings | ⚠️ Issues | resetAll wipes all data (C6); quiet hours broken with one field (M24) |
| **Merchant** | Ringer/Alerts | ❌ Broken | AudioContext silent fail (H11); escalation object leak (L11); confusing timer variable (L16) |
| **Merchant** | PRO upgrade | ⚠️ Issues | Dead-end button (H19); MRR wrong (C7) |
| **Merchant** | CRM/Membership | ⚠️ Issues | Customer aggregation unreliable (M25); phones not masked (M26); watch overwrites edits (CRM C1) |
| **Merchant** | Preview as Customer | ⚠️ Issues | Can create real self-orders (H14) |
| **Admin** | Dashboard KPIs | ❌ Broken | MRR under-reported 26% (C7); open/active field mismatch (Admin F6); 6× full-scan (M15) |
| **Admin** | Merchant management | ⚠️ Issues | Weak password reset (C13); removeVendor orphans payments (C9); no confirm toggle (L14) |
| **Admin** | Billing | ⚠️ Issues | Orphan payment rows (M17); payments not persisted (M13) |
| **Admin** | Hub management | ⚠️ Issues | Cache invalidation missing (H2); bulk edit unusable (L12); merchant pollution (M27) |
| **Admin** | Test data management | ❌ Broken | Frontend/backend asymmetry (H10); no cache invalidation (H2); subscriptions never cleaned (H10) |
| **Admin** | God-view switching | ⚠️ Issues | Race conditions on rapid switch (M14) |
| **Backend** | Auth / Login | ❌ Broken | Unsalted passwords (C3); admin plaintext (C8); username enum (H22); token in body (H12) |
| **Backend** | Mutex / Locking | ❌ Broken | withLock_ doesn't verify acquisition (C1) |
| **Backend** | Order state machine | ❌ Broken | No status transition validation (C2) |
| **Backend** | Order placement | ❌ Broken | Client-computed prices trusted (C10); client-computed fees trusted (C11); membership points race (C12) |
| **Backend** | Data cascade | ⚠️ Issues | removeVendor orphans payments (C9); saveProduct cross-vendor overwrite (H21) |
| **Backend** | Caching / Flush | ❌ Broken | Full-table rewrites on every mutation (H1); no rate limiting (H3) |
| **Backend** | File storage | ❌ Broken | Payment screenshots ANYONE_WITH_LINK (H4) |
| **Worker** | Cache invalidation | ❌ Broken | Multiple gaps (H2); no invalidation for getMembership (M22) |
| **Worker** | CORS | ⚠️ Issues | Allows all origins (H20) |
| **Worker** | CSP | ⚠️ Issues | unsafe-eval/inline (L5) |
| **Worker** | Push notifications | ⚠️ Issues | Synchronous delivery loop (M23); no body size limit (L7) |

---

## Pre-Launch Checklist

### Backend (Code.gs) — Must Complete Before Launch

- [ ] **C1:** Fix `withLock_` to check `lock.hasLock()` after `waitLock` and return error if not acquired (line 623)
- [ ] **C2:** Add order status transition validation to `updateOrderStatus_` (line 1078)
- [ ] **C3:** Implement actual salted SHA-256 password hashing in `hashPwd_` (line 409) + migrate existing passwords
- [ ] **C8:** Hash the admin password; store hashed version in Script Properties (line 698)
- [ ] **C9:** Add `cacheDelete_(TAB_PAYMENTS, 'vendorId', vendorId)` to `removeVendor_` (line 1173)
- [ ] **C10:** Server-side price recomputation in `placeOrder_` — validate against menu base price + options (line 973)
- [ ] **C11:** Server-side fee validation in `placeOrder_` — enforce from `settings.fees` (line 975)
- [ ] **C12:** Extract membership points to a separate sheet (one row per phone+vendorId) for row-level atomicity (line 1001)
- [ ] **H1:** Replace `cacheFlush_` full-table rewrite with targeted `setValue`/`appendRow` (line 134)
- [ ] **H3:** Add rate limiting on `placeOrder`, `getMembership`, `getStorefront` (Worker layer preferably)
- [ ] **H4:** Change payment screenshot sharing from `ANYONE_WITH_LINK` to authenticated endpoint (line 466)
- [ ] **H21:** Fix `saveProduct_` to reject cross-vendor itemId overwrites (line 823)
- [ ] **H22:** Unify login error messages to prevent username enumeration (line 673)
- [ ] Add `TAB_SUBSCRIPTIONS` to `clearTestData_` and `resetSeedData_` table lists (lines 1287, 1304)

### Worker (index.js) — Must Complete Before Launch

- [ ] **H2:** Add missing cache invalidation targets for `saveVendorConfig` → `listPublicVendors`, `updateOrderStatus`/`cancelOrder` → `getVendorOrders`, `saveHubBuildings`/`removeHubBuilding` → `listHubs`, `resetSeedData`/`wipeAllData` → flush all
- [ ] **H20:** Restrict CORS to known frontend origins only
- [ ] **M22:** Add `getMembership` to Worker read cache with invalidation on `placeOrder`
- [ ] **M23:** Add `/push-batch` endpoint so GAS sends one request, Worker fans out concurrently
- [ ] **L7:** Add request body size limit on `/push` endpoint (64KB max)

### Frontend (store.js) — Must Complete Before Launch

- [ ] **C4:** Add `submitting` ref to CheckoutView, disable button during submission
- [ ] **C5:** Add `isNaN()` check to `mapRemoteItem` stock conversion (line 339)
- [ ] **C6:** Remove `resetAll()` from merchant UI or scope to current merchant only (line 1385)
- [ ] **C7:** Change `PRO_PRICE` from 29 to 39 (line 1200)
- [ ] **H8:** Fix `saveProfile` to update building/room in address-book branch (line 888)
- [ ] **H10:** Add test vendors/menu/accounts clearing to frontend `clearTestData` (line 1298); add `isTest: true` to seed orders
- [ ] **H17:** Add `hubId` to `normalizeRemoteOrder` output (line 322)

### Frontend (student.js) — Must Complete Before Launch

- [ ] **H5:** Fix pre-order checkout to allow future date/slot selection when today's slots have passed (line 750)
- [ ] **H6:** Change "下单成功" toast to "订单已提交，正在确认..." until server confirms (line 764)
- [ ] **H7:** Escape QR URL in `openTab` — use `encodeURI()` or `createElement('img')` (line 753)

### Frontend (merchant.js) — Must Complete Before Launch

- [ ] **H11:** Fix AudioContext resume to check state and surface error; init on first user click (merchant-ringer.js:63)
- [ ] **H13:** Add confirmation dialog to `batchDeliverGo` (line 326)
- [ ] **H14:** Prevent real orders in preview-as-customer mode (store.js:981 or merchant.js:27)
- [ ] **H15:** Unify pending/doing counts across action bar, tabs, and bottom nav (lines 25, 38, 51, 114)
- [ ] **H18:** Hide "用示例照片测试" button in production (lines 176, 190, 243)
- [ ] **H19:** Add actionable link (WhatsApp/email) to PRO upgrade prompt (line 82)

### Frontend (admin.js) — Must Complete Before Launch

- [ ] **C13:** Replace hardcoded "1234" with random password generator (line 269)

### Frontend (Common) — Must Complete Before Launch

- [ ] **H9:** Surface error toast in `compressImage` catch blocks (student.js:752, merchant.js:19); add file size check
- [ ] **H12:** Send auth token as `Authorization` header instead of request body (store.js:709, api.js:55)

---

## Security Posture Summary

| Layer | Current State | Risk |
|-------|--------------|------|
| **Password Storage** | Unsalted SHA-256 (claims salt exists in header) | 🔴 Critical — All passwords rainbow-table attackable if sheet leaks |
| **Admin Auth** | Plaintext password in Script Properties | 🔴 Critical — Any GAS console access = full admin |
| **Token Security** | 96-bit truncated HMAC; sent in request body; stored localStorage plaintext | 🟠 High — Token forgery, XSS theft, edge caching |
| **Input Validation** | Client-computed prices, fees, and stock trusted by server | 🔴 Critical — Revenue manipulation, free orders |
| **Rate Limiting** | Login only; all other endpoints unthrottled | 🟠 High — DoS, enumeration, quota exhaustion |
| **File Security** | Payment screenshots `ANYONE_WITH_LINK` on Google Drive | 🟠 High — Financial PII publicly accessible by ID |
| **CORS** | `*` wildcard on all origins | 🟠 High — CSRF, cross-origin data theft |
| **CSP** | `unsafe-eval` + `unsafe-inline` on all three pages | 🟡 Medium — XSS protection weakened |
| **XSS** | QR code popup uses unescaped string concat; Vue interpolation elsewhere | 🟠 High — One confirmed XSS vector via merchant data |
| **Data at Rest** | Phone numbers, addresses, tokens in localStorage plaintext; base64 screenshots persisted | 🟡 Medium — PII exposure on shared devices |
| **Lock Service** | `waitLock` returns void, no acquisition verification | 🔴 Critical — All mutex-protected paths race |
| **Secret Rotation** | Single hardcoded secret, no rotation mechanism | 🟡 Medium — Manual downtime on compromise |

**Overall Security Verdict: 🔴 Not Launch-Ready**

The platform has 7 critical or high security defects. The core auth stack (passwords, tokens, admin) needs hardening before any real customer or payment data can be trusted to the system.

---

## Top 10 Recommendations Ordered by Impact/Effort Ratio

| # | Recommendation | Impact | Effort | Ratio |
|---|---------------|--------|--------|-------|
| 1 | Fix `withLock_` — add `hasLock()` check (1 line) | Stops all concurrent data corruption | 5 min | Highest |
| 2 | Change `PRO_PRICE` from 29 to 39 (1 line) | Fixes MRR dashboard; 26% revenue reporting | 1 min | Highest |
| 3 | Add order status transition guard (20 lines) | Prevents all order state corruption | 30 min | Highest |
| 4 | Add `submitting` ref to CheckoutView (5 lines) | Stops duplicate orders | 10 min | Very High |
| 5 | Add `isNaN()` guard to stock conversion (1 line) | Prevents infinite ordering of broken items | 5 min | Very High |
| 6 | Remove or scope `resetAll()` in merchant UI (conditional + confirm dialog) | Prevents catastrophic platform data loss | 15 min | Very High |
| 7 | Escape QR URL in `openTab` (1 line: `encodeURI`) | Closes XSS vector | 5 min | Very High |
| 8 | Server-side price/fee validation in `placeOrder_` (30 lines) | Closes revenue manipulation; blocks free orders | 2 hours | High |
| 9 | Replace `cacheFlush_` full-table rewrite with targeted writes (50 lines) | Prevents GAS quota exhaustion at scale | 3 hours | High |
| 10 | Add missing Worker cache invalidation targets | Fixes stale data across all clients | 1 hour | High |

---

**Report prepared for go/no-go launch decision. Recommendation: BLOCK until 13 critical items are resolved. Schedule follow-up audit targeting backend lock/state-machine/auth fixes specifically.**