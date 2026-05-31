/*
 * sw.js —— Service Worker（项目根目录，scope=/ 覆盖全站）
 *
 * 职责：
 *   1) 接 push 事件：解析 payload → 展示系统通知
 *   2) 接 notificationclick：聚焦/打开对应订单页
 *   3) 接 pushsubscriptionchange：浏览器轮换 subscription 时通知前端重新订阅
 *
 * payload 协议（来自 Worker → push service → 这里）：
 *   {
 *     title: "备餐中",
 *     body:  "蔬菜咖喱鸡，约 25 分钟",
 *     tag:   "order-<orderId>",      // 同 tag 会折叠，避免刷屏
 *     url:   "/?role=customer#/track/<orderId>",  // 点击跳哪儿
 *     icon:  "/icon-192.png",
 *     badge: "/badge-72.png",
 *     renotify: false,
 *     requireInteraction: false       // 商家新单可设 true，让通知不自动消失
 *   }
 */

// 安装/激活：直接生效，不等老 SW 自然退场
self.addEventListener('install', (event) => { self.skipWaiting(); });
self.addEventListener('activate', (event) => { event.waitUntil(self.clients.claim()); });

// ---- 收到 push ----
self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json(); }
    catch (_) { data = { title: '订单更新', body: event.data.text() }; }
  }
  const title = data.title || '订单更新';
  const opts = {
    body: data.body || '',
    icon: data.icon || '/icon-192.png',
    badge: data.badge || '/badge-72.png',
    tag: data.tag || 'order',
    renotify: !!data.renotify,
    requireInteraction: !!data.requireInteraction,
    data: {
      url: data.url || '/',
      orderId: data.orderId,
      role: data.role,
    },
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// ---- 点击通知：聚焦已开页面，没开就新开 ----
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      // 同源页面已开 → 聚焦它（带上跳转参数，让 SPA 路由到目标）
      if ('focus' in c) {
        try {
          if (c.navigate) await c.navigate(target);
        } catch (_) {}
        return c.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});

// ---- 订阅被浏览器轮换：通知开着的页面重新订阅 ----
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      try { c.postMessage({ type: 'pushsubscriptionchange' }); } catch (_) {}
    }
  })());
});
