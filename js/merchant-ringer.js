/*
 * merchant-ringer.js —— 商家端持续响铃（Web Audio，零素材）
 *
 * 设计（Decision 2C：商家可配置响铃强度/音量/勿扰时段）：
 *   - 新 pending 订单到达 → 立刻 ring.start(orderId)
 *   - 订单离开 pending（接单/拒单/取消） → ring.stop(orderId)
 *   - 多单同时挂着只响一次（共用 audio loop），按订单 id 做 reference counting
 *   - 单次最长响 30s（settings.ring.maxDurationSec），避免页面挂机响一晚
 *   - 5 分钟未处理 → 自动二次响铃 + 标红 banner（escalation）
 *   - 勿扰时段（quietStart/quietEnd HH:MM）：本地静音，但 Web Push 通知不受影响
 *
 * 浏览器自动播放策略：AudioContext 必须在用户首次手势之后创建。
 * 商家肯定有过登录点击，但为防御性，第一次 start 失败会把按钮显式标红：
 *   ringerStatus = 'blocked' → UI 提示「点这里允许声音」
 *
 * 暴露 window.merchantRinger：
 *   .start(orderId)        - 开响（如果空闲）或加入响铃集合
 *   .stop(orderId)         - 停止该订单，集合为空时彻底静音
 *   .stopAll()             - 全部停（接单完成或勿扰）
 *   .pending()             - Set of orderIds currently ringing
 *   .testBeep(volume)      - 用户在设置里点「试听」时调用
 *   .status()              - 'idle' | 'ringing' | 'blocked' | 'quiet'
 */
(function () {
  var DEFAULTS = {
    enabled: true,
    volume: 0.7,             // 0.0–1.0
    intervalSec: 1.2,        // 蜂鸣间隔
    maxDurationSec: 30,      // 单次最长响多久（防扰民）
    escalateAfterMin: 5,     // 多少分钟未处理就再响一次 + 标红
    quietStart: '',          // 'HH:MM' 留空 = 无勿扰
    quietEnd: '',
  };

  function getSettings() {
    try {
      var m = window.store && window.store.merchant;
      if (!m || !m.settings) return DEFAULTS;
      return Object.assign({}, DEFAULTS, m.settings.ring || {});
    } catch (_) { return DEFAULTS; }
  }

  function nowHHMM() {
    var d = new Date();
    return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  }
  function inQuietHours(s) {
    if (!s.quietStart || !s.quietEnd) return false;
    var n = nowHHMM();
    // 跨夜：22:00 → 08:00 形式
    if (s.quietStart <= s.quietEnd) return n >= s.quietStart && n < s.quietEnd;
    return n >= s.quietStart || n < s.quietEnd;
  }

  // ---- 单 AudioContext + 单 loop ----
  var ctx = null;
  var loopTimer = null;
  var stopTimer = null;
  var pendingSet = {}; // orderId → escalationTimer
  var escalated = {};  // orderId → bool
  var statusState = 'idle';

  function ensureCtx() {
    if (ctx) return ctx;
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      ctx = new AC();
      return ctx;
    } catch (_) { return null; }
  }

  // 温暖钟声：E5 基音 + 2 个泛音叠加（让声音"有体积"而不是单频电子音）
  // 指数衰减包络模拟真实金属铃铛的余音 —— 简单但不电子、不刺耳
  function beep(volume, dur) {
    if (!ctx) return;
    var t0 = ctx.currentTime;
    var duration = 0.55; // 单次铃声 550ms，1.2s 间隔下留够安静空隙
    // 三层泛音（基音 + 八度 + 八度五度），振幅递减模拟自然铃铛
    var partials = [
      { freq: 659.25, amp: 0.65 }, // E5 基音（主体音色）
      { freq: 1318.5, amp: 0.25 }, // E6 八度泛音（明亮感）
      { freq: 988.31, amp: 0.15 }, // B5 五度泛音（和谐感）
    ];
    partials.forEach(function (p) {
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = p.freq;
      var peakVol = Math.max(0.0001, volume * p.amp);
      // 快速 attack (6ms) + 指数衰减 → 像真实铃铛敲下去的余音
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(peakVol, t0 + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + duration + 0.02);
    });
  }

  function startLoop() {
    if (loopTimer) return; // 已经在响
    var s = getSettings();
    if (inQuietHours(s)) { statusState = 'quiet'; return; }
    var c = ensureCtx();
    if (!c) { statusState = 'blocked'; return; }
    // 若被 autoplay 策略 suspend，尝试 resume
    if (c.state === 'suspended') {
      c.resume().catch(function () {});
    }
    statusState = 'ringing';
    var play = function () {
      try { beep(s.volume, 0.28); } catch (_) {}
    };
    play();
    loopTimer = setInterval(play, Math.max(400, s.intervalSec * 1000));
    // 单次最长 maxDurationSec 自动停
    if (stopTimer) clearTimeout(stopTimer);
    stopTimer = setTimeout(function () {
      if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
      statusState = Object.keys(pendingSet).length ? 'idle' : 'idle';
      // 不清空 pendingSet——升级响铃靠 escalation timer
    }, s.maxDurationSec * 1000);
  }

  function stopLoop() {
    if (loopTimer) { clearInterval(loopTimer); loopTimer = null; }
    if (stopTimer) { clearTimeout(stopTimer); stopTimer = null; }
    statusState = 'idle';
  }

  function start(orderId) {
    if (!orderId) return;
    var s = getSettings();
    if (!s.enabled) { statusState = 'idle'; return; }
    if (pendingSet[orderId]) return; // 已经在跟踪
    pendingSet[orderId] = setTimeout(function () {
      // 升级：5 分钟还在 pending → 再响一轮 + 标记
      if (pendingSet[orderId]) {
        escalated[orderId] = true;
        stopLoop();
        startLoop();
        try { window.dispatchEvent(new CustomEvent('ringer:escalate', { detail: { orderId: orderId } })); } catch (_) {}
      }
    }, Math.max(60, s.escalateAfterMin * 60) * 1000);
    startLoop();
  }

  function stop(orderId) {
    if (orderId && pendingSet[orderId]) {
      clearTimeout(pendingSet[orderId]);
      delete pendingSet[orderId];
      delete escalated[orderId];
    }
    if (Object.keys(pendingSet).length === 0) stopLoop();
  }

  function stopAll() {
    Object.keys(pendingSet).forEach(function (k) { clearTimeout(pendingSet[k]); });
    pendingSet = {};
    escalated = {};
    stopLoop();
  }

  function testBeep(vol) {
    var c = ensureCtx();
    if (!c) return false;
    if (c.state === 'suspended') c.resume().catch(function () {});
    try { beep(vol != null ? vol : getSettings().volume, 0.35); return true; }
    catch (_) { return false; }
  }

  function pending() { return Object.keys(pendingSet); }
  function isEscalated(orderId) { return !!escalated[orderId]; }
  function status() { return statusState; }

  // 页面可见时立即检查 pendingSet 是否需要继续响（visibilitychange 后浏览器可能 suspend ctx）
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && Object.keys(pendingSet).length && !loopTimer) {
      startLoop();
    }
  });

  window.merchantRinger = {
    start: start,
    stop: stop,
    stopAll: stopAll,
    testBeep: testBeep,
    pending: pending,
    isEscalated: isEscalated,
    status: status,
    defaults: DEFAULTS,
  };
})();
