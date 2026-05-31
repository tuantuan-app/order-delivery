/*
 * notify.js —— Web Push 订阅 / 权限 / 与后端同步
 *
 * 暴露 window.notify：
 *   .supported()                 → bool 浏览器是否支持（Notification + PushManager + SW）
 *   .permission()                → 'default' | 'granted' | 'denied' | 'unsupported'
 *   .request()                   → Promise<'granted'|'denied'|'default'>
 *   .registerSW()                → Promise<ServiceWorkerRegistration|null>
 *   .currentSubscription()       → Promise<PushSubscription|null>
 *   .subscribe()                 → Promise<{ endpoint, keys: { p256dh, auth } }>
 *   .unsubscribe()               → Promise<bool>
 *   .enable(role, identity, ua?) → 一站式：注册 SW + 订阅 + 同步到 GAS
 *                                  role: 'customer'|'merchant'|'admin'
 *                                  identity: phone(customer) / vendorId(merchant) / username(admin)
 *
 * 设计原则：
 *   1) 不主动弹权限——交给上层 UI 决定何时引导（避免一进站就被拒）
 *   2) 失败永远不抛红屏，返回 {ok:false, reason} 让上层柔性降级到 in-app + WhatsApp
 *   3) iOS Safari 需先「加到主屏」才能 Notification API 可用——unsupported 时上层放 PWA 安装引导
 */
(function () {
  var SW_URL = '/sw.js';
  var SW_SCOPE = '/';

  function supported() {
    return ('serviceWorker' in navigator)
      && ('PushManager' in window)
      && ('Notification' in window);
  }

  function permission() {
    if (!('Notification' in window)) return 'unsupported';
    return Notification.permission; // 'default' | 'granted' | 'denied'
  }

  function request() {
    if (!('Notification' in window)) return Promise.resolve('unsupported');
    return Notification.requestPermission();
  }

  // VAPID 公钥 base64url → Uint8Array（PushManager.subscribe 需要）
  function urlB64ToU8(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var base = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base);
    var out = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  async function registerSW() {
    if (!('serviceWorker' in navigator)) return null;
    try {
      var reg = await navigator.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
      // 等到 active 再返回，避免立刻 subscribe 时 reg.pushManager 还没就绪
      if (!reg.active) {
        await new Promise(function (resolve) {
          var w = reg.installing || reg.waiting;
          if (!w) return resolve();
          w.addEventListener('statechange', function () {
            if (w.state === 'activated') resolve();
          });
        });
      }
      return reg;
    } catch (e) {
      console.warn('[notify] SW register failed', e);
      return null;
    }
  }

  async function currentSubscription() {
    if (!('serviceWorker' in navigator)) return null;
    var reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return null;
    return await reg.pushManager.getSubscription();
  }

  function subToJson(sub) {
    if (!sub) return null;
    // PushSubscription.toJSON() 返回 { endpoint, expirationTime, keys: { p256dh, auth } }
    if (typeof sub.toJSON === 'function') return sub.toJSON();
    return { endpoint: sub.endpoint, keys: { p256dh: '', auth: '' } };
  }

  async function subscribe() {
    if (!supported()) throw new Error('unsupported');
    var cfg = window.APP_CONFIG || {};
    if (!cfg.vapidPublicKey) throw new Error('vapidPublicKey missing in APP_CONFIG');
    var reg = await registerSW();
    if (!reg) throw new Error('sw register failed');
    var sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlB64ToU8(cfg.vapidPublicKey),
      });
    }
    return subToJson(sub);
  }

  async function unsubscribe() {
    var reg = await navigator.serviceWorker.getRegistration();
    if (!reg) return false;
    var sub = await reg.pushManager.getSubscription();
    if (!sub) return false;
    return await sub.unsubscribe();
  }

  // 一站式：检查权限→订阅→同步到后端。失败永远不抛。
  async function enable(role, identity, opts) {
    opts = opts || {};
    if (!supported()) return { ok: false, reason: 'unsupported' };
    var p = permission();
    if (p === 'denied') return { ok: false, reason: 'denied' };
    if (p === 'default') {
      if (opts.askIfNeeded) {
        p = await request();
        if (p !== 'granted') return { ok: false, reason: 'denied' };
      } else {
        return { ok: false, reason: 'needs-permission' };
      }
    }
    // granted
    var sub;
    try { sub = await subscribe(); }
    catch (e) { return { ok: false, reason: 'subscribe-failed', error: String(e && e.message || e) }; }
    if (!sub || !sub.endpoint) return { ok: false, reason: 'no-subscription' };
    // 同步到后端
    if (window.api && typeof window.api.saveSubscription === 'function') {
      try {
        var r = await window.api.saveSubscription({
          role: role,
          identity: identity,
          subscription: sub,
          ua: navigator.userAgent || '',
        });
        if (!r || !r.ok) return { ok: false, reason: 'backend-rejected', error: r && r.error, subscription: sub };
      } catch (e) {
        return { ok: false, reason: 'backend-unreachable', error: String(e && e.message || e), subscription: sub };
      }
    }
    return { ok: true, subscription: sub };
  }

  // 监听 SW 推回来的 pushsubscriptionchange，让上层重新 enable
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', function (e) {
      if (e.data && e.data.type === 'pushsubscriptionchange') {
        try { window.dispatchEvent(new CustomEvent('notify:resubscribe')); } catch (_) {}
      }
    });
  }

  // ============================================================
  // 软引导横幅（不抢用户、不抢权限）
  // 时机：客户首次下单成功后；商家登录后（每 7 天最多一次）
  // 行为：'default' 才显示；'granted'/'denied' 都不显示；本次会话每个 role 只显示一次
  // iOS Safari 非 standalone：替换为「加到主屏」引导（Decision 1B）
  // ============================================================
  var _shown = {}; // 本会话已显示的 role
  var DISMISS_KEY_PREFIX = 'notify_dismissed_';
  var DISMISS_TTL = 7 * 24 * 60 * 60 * 1000; // 7 天

  function isIOSSafari() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) && /Safari/.test(ua) && !/Chrome|CriOS|FxiOS/.test(ua);
  }
  function isStandalone() {
    try {
      if ('standalone' in navigator && navigator.standalone) return true;
      if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return true;
    } catch (_) {}
    return false;
  }
  function recentlyDismissed(role) {
    var k = DISMISS_KEY_PREFIX + role;
    var t = Number(localStorage.getItem(k) || 0);
    return t && (Date.now() - t < DISMISS_TTL);
  }
  function markDismissed(role) {
    try { localStorage.setItem(DISMISS_KEY_PREFIX + role, String(Date.now())); } catch (_) {}
  }

  function buildBanner(opts) {
    var wrap = document.createElement('div');
    wrap.className = 'notify-banner';
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-live', 'polite');
    wrap.innerHTML =
      '<div class="notify-banner__icon">' + (opts.icon || '🔔') + '</div>' +
      '<div class="notify-banner__body">' +
        '<div class="notify-banner__title"></div>' +
        '<div class="notify-banner__desc"></div>' +
      '</div>' +
      '<div class="notify-banner__actions">' +
        '<button class="notify-banner__btn notify-banner__btn--ghost" data-act="later">稍后</button>' +
        '<button class="notify-banner__btn notify-banner__btn--primary" data-act="ok"></button>' +
      '</div>';
    wrap.querySelector('.notify-banner__title').textContent = opts.title || '';
    wrap.querySelector('.notify-banner__desc').textContent = opts.desc || '';
    wrap.querySelector('[data-act="ok"]').textContent = opts.okLabel || '允许';
    var close = function () { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); };
    wrap.querySelector('[data-act="later"]').addEventListener('click', function () { opts.onLater && opts.onLater(); close(); });
    wrap.querySelector('[data-act="ok"]').addEventListener('click', function () { opts.onOk && opts.onOk(close); });
    document.body.appendChild(wrap);
    // 进场动画
    requestAnimationFrame(function () { wrap.classList.add('notify-banner--in'); });
    return close;
  }

  function maybePrompt(role, identity) {
    role = role || 'customer';
    if (_shown[role]) return;
    if (recentlyDismissed(role)) return;
    // iOS Safari 非 PWA：先引导加主屏（iOS 16.4+ 装到主屏才能 Web Push）
    if (isIOSSafari() && !isStandalone()) {
      _shown[role] = true;
      buildBanner({
        icon: '📱',
        title: '想随时收到订单通知？',
        desc: '点击 Safari 下方 ⬆ 分享按钮 → 选「添加到主屏幕」，装成 App 后通知就到锁屏。',
        okLabel: '知道了',
        onLater: function () { markDismissed(role); },
        onOk: function (close) { markDismissed(role); close(); },
      });
      return;
    }
    if (!supported()) return; // 旧浏览器 / 不支持
    var p = permission();
    if (p !== 'default') return; // 已 granted 或 denied 都不再问
    _shown[role] = true;
    var copy = role === 'merchant'
      ? { title: '新订单通知', desc: '允许通知 = 即使没开页面，新单也响铃提醒，避免漏单。', okLabel: '开启提醒' }
      : { title: '订单状态推送', desc: '商家接单 / 出发 / 送达，第一时间通知你，不用一直盯着页面。', okLabel: '允许通知' };
    buildBanner({
      icon: '🔔',
      title: copy.title,
      desc: copy.desc,
      okLabel: copy.okLabel,
      onLater: function () { markDismissed(role); },
      onOk: async function (close) {
        var r = await enable(role, identity, { askIfNeeded: true });
        close();
        if (!r.ok && r.reason === 'denied') {
          // 用户拒绝了——记下来，别再问
          markDismissed(role);
        }
      },
    });
  }

  // 客户/商家方便方法
  function promptCustomerAfterOrder(phone) { maybePrompt('customer', phone); }
  function promptMerchantAfterLogin(vendorId) { maybePrompt('merchant', vendorId); }

  window.notify = {
    supported: supported,
    permission: permission,
    request: request,
    registerSW: registerSW,
    currentSubscription: currentSubscription,
    subscribe: subscribe,
    unsubscribe: unsubscribe,
    enable: enable,
    maybePrompt: maybePrompt,
    promptCustomerAfterOrder: promptCustomerAfterOrder,
    promptMerchantAfterLogin: promptMerchantAfterLogin,
    isIOSSafari: isIOSSafari,
    isStandalone: isStandalone,
  };
})();
