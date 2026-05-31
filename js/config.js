/*
 * config.js —— 运行配置 / 多环境切换
 *
 * 三档（按 URL 参数自动判断）：
 *   ?demo   → 纯本地演示，不连后端（数据存 localStorage，0 延迟，适合快速测 UI）
 *   ?test   → 连「测试后端」（独立 Sheet/GAS，真实延迟，测试数据不污染线上）
 *   不带参数 → 连「正式后端」（线上）
 *
 * ⚠ 建好测试后端后，把它的 Apps Script /exec 网址填进下面的 TEST_API。
 */
(function () {
  var PROD_API = 'https://script.google.com/macros/s/AKfycbxOqbUg6NtL0619X-PyJxsHcLAQfSatwYIBaMsgkVZomNmxExaUsKZVAA7mvEoLXZGpqQ/exec';
  var TEST_API = ''; // ← 填入「测试库」Apps Script 部署的 /exec 网址（建好测试后端后）

  var qs = location.search || '';
  var env = /[?&]demo\b/.test(qs) ? 'demo' : (/[?&]test\b/.test(qs) ? 'test' : 'prod');

  var apiBase = env === 'prod' ? PROD_API : (env === 'test' ? TEST_API : '');
  if (env === 'test' && !TEST_API) {
    // 未配置测试后端时退化为纯本地，绝不回退到线上，避免把测试数据误写进正式库
    console.warn('[config] ?test 模式但 TEST_API 未填写——暂按纯本地运行。请在 js/config.js 填入测试库 /exec 网址。');
  }

  // Web Push（Cloudflare Worker）
  // pushWorkerUrl 是公开的（浏览器订阅时不暴露 secret，真正鉴权用 X-Worker-Secret，由 GAS 持有）
  // vapidPublicKey 浏览器必须知道，用于 subscribe(applicationServerKey)
  var PUSH_WORKER_URL = 'https://tuantuan-push.keidev.workers.dev';
  var VAPID_PUBLIC_KEY = 'BA-VEznSdqmxxNaGpj8dO8yksm9DzNxV0UCPzHd7fAmb8WPxY_-lPudb87MTdKYDrxIJpjnk8cGXhn6LK7seQ9w';

  window.APP_CONFIG = {
    apiBase: apiBase,
    env: env,
    pushWorkerUrl: PUSH_WORKER_URL,
    vapidPublicKey: VAPID_PUBLIC_KEY,
  };

  // 非正式环境加醒目标记，避免把测试/演示当成线上误操作
  if (env !== 'prod') {
    var tag = env === 'demo' ? '本地演示' : '测试环境';
    try { document.title = '🧪' + tag + ' · ' + document.title; } catch (e) {}
    var paint = function () {
      var el = document.createElement('div');
      el.textContent = '🧪 ' + tag + (env === 'test' && !TEST_API ? '（未配置·按本地）' : '');
      el.style.cssText = 'position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:99999;background:#f59e0b;color:#fff;font:600 11px/1 sans-serif;padding:3px 10px;border-radius:0 0 8px 8px;pointer-events:none;opacity:.95';
      document.body.appendChild(el);
    };
    if (document.body) paint(); else document.addEventListener('DOMContentLoaded', paint);
  }
})();
