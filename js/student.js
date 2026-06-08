/*
 * student.js —— 学生点单端
 *  商家列表 → 菜单(按分类分组+筛选) → 结算(费用明细+TNG码+上传截图) → 状态(动效+到货照片)
 *  支持商家"预览学生端"模式（不可真正下单）
 */
(function () {
  const { computed, ref, reactive, watch, onMounted, onUnmounted } = Vue;
  const store = window.store;
  const ui = store.ui;

  const STATUS_STEPS = [
    { key: 'pending', label: '等待验证', icon: '🔎' },
    { key: 'cooking', label: '备餐中', icon: '🍳' },
    { key: 'delivering', label: '配送中', icon: '🛵' },
    { key: 'delivered', label: '已送达', icon: '✅' },
  ];

  window.StudentApp = {
    template: `
      <div class="student">
        <div class="preview-bar" v-if="ui.preview">
          👀 预览模式（客户视角）{{ store.studentMerchant ? '· ' + store.studentMerchant.name : '' }}
          <button class="preview-bar__back" @click="store.exitPreview()">退出预览</button>
        </div>

        <!-- 订单记录 tab -->
        <customer-orders v-if="ui.studentTab==='orders'" @open="openHistory" @reorder="reorder"></customer-orders>
        <!-- 我的 tab -->
        <customer-profile v-else-if="ui.studentTab==='me'"></customer-profile>

        <!-- 首页 tab：完整点单流程 -->
        <merchant-list v-else-if="ui.studentStep === 'merchants'"></merchant-list>

        <template v-else-if="ui.studentStep === 'menu'">
          <div class="shop-head">
            <button class="icon-back" @click="store.backToMerchants()" aria-label="返回商家列表">‹</button>
            <div class="shop-head__logo">{{ store.studentMerchant.logo }}</div>
            <div class="shop-head__txt"><h1 class="shop-head__name">{{ store.studentMerchant.name }}</h1><div class="shop-head__sub">{{ store.studentMerchant.desc }}</div></div>
            <button class="icon-back shop-head__refresh" @click="store.refreshStorefront(ui.studentMerchantId)" aria-label="刷新菜单">↻</button>
          </div>
          <div class="shop-status" :class="open ? 'shop-status--open' : 'shop-status--closed'">
            <template v-if="open">🟢 营业中 · {{ store.studentMerchant.settings.deliveryOffered ? '提供外送服务' : '仅自取，不提供外送' }}</template>
            <template v-else>🛌 商家休息中{{ preorder ? '，可提前预订 · 营业后配送 🛎️' : '，暂不接单（可先浏览菜单）' }}</template>
          </div>
          <div class="ptr" v-if="pullDist>0" :style="{height: pullDist+'px'}">{{ pullDist>45 ? '松开刷新 ↻' : '下拉刷新菜单' }}</div>
          <div ref="pullArea" @touchstart="ptrStart" @touchend="ptrEnd">
          <menu-list :qty-of="qtyOfItem" @add="addSimple" @remove="removeSimple" @choose="openSheet"></menu-list>
          </div>
          <div class="cart-bar" v-if="cartCount > 0 && (open || preorder)">
            <div><div class="cart-bar__count">{{ cartCount }} 件 · 已选</div><div class="cart-bar__total">{{ store.utils.rm(cartTotal) }}</div></div>
            <button class="btn btn--primary btn--pill" @click="ui.studentStep='checkout'">去结算 →</button>
          </div>
          <option-sheet v-if="sheetItem" :item="sheetItem" :left="stockLeft(sheetItem)" @close="sheetItem=null" @add="addLine"></option-sheet>
        </template>

        <template v-else-if="ui.studentStep === 'checkout'">
          <profile-form v-if="needProfile" :buildings="store.studentMerchant && store.studentMerchant.settings.coverage"></profile-form>
          <checkout-view v-else :merchant="store.studentMerchant" :lines="cart" :subtotal="cartTotal" :preview="ui.preview" @back="ui.studentStep='menu'" @submitted="onSubmitted" @inc="incLine" @dec="decLine"></checkout-view>
        </template>

        <order-status v-else-if="ui.studentStep === 'status'" @neworder="startNew" @back="goTab('orders')"></order-status>

        <!-- iOS / Android PWA 首启动恢复引导：standalone 与浏览器是独立存储域，加主屏后本地资料丢失 -->
        <div class="modal" v-if="pwaRestoreOpen" @click.self="pwaDismiss">
          <div class="modal__panel">
            <div class="modal__head"><span>📱 欢迎回到团团</span><button class="link-btn" @click="pwaDismiss">稍后</button></div>
            <p class="muted sm" style="margin:6px 0 12px">首次在桌面 App 打开？输入你之前下单用的手机号，自动恢复历史订单和地址。</p>
            <label class="field field--phone"><span>手机号</span>
              <div class="phone-input"><span class="phone-input__cc">🇲🇾 +60</span><input v-model="pwaPhone" type="tel" inputmode="numeric" placeholder="12-345 6789（或 0123456789）" maxlength="20" /></div>
            </label>
            <p class="error" v-if="pwaErr">{{ pwaErr }}</p>
            <button class="btn btn--primary btn--block" :disabled="pwaSubmitting" @click="pwaSubmit">{{ pwaSubmitting ? '正在恢复…' : '恢复' }}</button>
            <p class="muted sm center" style="margin-top:10px">首次使用？点「稍后」直接开始点单。</p>
          </div>
        </div>

        <!-- 客户底部导航：仅在顶层视图显示（店内/结算/状态时隐藏，专注下单流程） -->
        <nav class="tabbar" v-if="!ui.preview && showNav" role="navigation" aria-label="主导航">
          <button :class="{active: ui.studentTab==='home'}" @click="goTab('home')"><span class="tabbar__ico">🏠</span><span>首页</span></button>
          <button :class="{active: ui.studentTab==='orders'}" @click="goTab('orders')"><span class="tabbar__ico">🧾</span><span>订单</span><i class="dot" v-if="liveCount">{{ liveCount }}</i></button>
          <button :class="{active: ui.studentTab==='me'}" @click="goTab('me')"><span class="tabbar__ico">👤</span><span>我的</span></button>
        </nav>
      </div>
    `,
    setup() {
      const cart = reactive([]); // 行级购物车：同商品不同规格 = 不同行
      const sheetItem = ref(null);
      const merchant = computed(() => store.studentMerchant);
      const open = computed(() => store.isOpen(merchant.value));
      const preorder = computed(() => !!(merchant.value && merchant.value.settings && merchant.value.settings.preorder));
      const needProfile = computed(() => !ui.preview && !store.profile);
      const cartCount = computed(() => cart.reduce((s, l) => s + l.qty, 0));
      const cartTotal = computed(() => cart.reduce((s, l) => s + l.unit * l.qty, 0));
      function qtyOfItem(id) { return cart.filter((l) => l.itemId === id).reduce((s, l) => s + l.qty, 0); }
      function findItem(id) { return merchant.value ? merchant.value.menu.find((m) => m.id === id) : null; }
      function stockLeft(item) { return !item || item.stock == null ? Infinity : (item.stock - qtyOfItem(item.id)); }
      function sig(id, opts) { return id + '#' + opts.map((o) => o.optId).sort().join(','); }
      function addLineRaw(item, opts, qty) {
        if (!item || !item.available || (!open.value && !preorder.value) || item.stock === 0) return;
        if (stockLeft(item) <= 0) return;
        const add = Math.min(qty || 1, stockLeft(item));
        const unit = store.utils.effPrice(item) + opts.reduce((s, o) => s + (Number(o.price) || 0), 0);
        const key = sig(item.id, opts);
        const ex = cart.find((l) => l.key === key);
        if (ex) ex.qty += add;
        else cart.push({ key: key, itemId: item.id, name: item.name, emoji: item.emoji, image: item.image, unit: unit, optionText: opts.map((o) => o.name).join('、'), options: opts, qty: add });
      }
      function addSimple(m) { addLineRaw(m, [], 1); }
      function removeSimple(m) { const l = cart.find((x) => x.itemId === m.id && x.options.length === 0); if (l) { l.qty--; if (l.qty <= 0) cart.splice(cart.indexOf(l), 1); } }
      function openSheet(m) { sheetItem.value = m; }
      function addLine(p) { addLineRaw(p.item, p.options, p.qty); sheetItem.value = null; }
      function incLine(key) { const l = cart.find((x) => x.key === key); if (!l) return; const it = findItem(l.itemId); if (it && stockLeft(it) <= 0) return; l.qty++; }
      function decLine(key) { const l = cart.find((x) => x.key === key); if (l) { l.qty--; if (l.qty <= 0) cart.splice(cart.indexOf(l), 1); } }
      function clearCart() { cart.splice(0, cart.length); }
      watch(() => ui.studentMerchantId, clearCart);
      function onSubmitted() { clearCart(); ui.studentStep = 'status'; }
      function startNew() { store.state.activeOrderId = null; store.backToMerchants(); }
      if (store.activeOrder && !ui.preview) ui.studentStep = 'status';
      if (!ui.preview) store.loadMyOrders(); // 进入即按本机手机号拉「我的订单」(状态以后端为准)
      // 客户端进入即拉公开商家列表（在线模式 → 替换本地 seedState；离线 → 用本地 demo）
      store.loadPublicVendors();
      store.loadHubs(); // 拉社区共享楼栋池（地址簿/送达切换用）
      // 底部导航：店内 / 结算 / 进行中订单 隐藏；首页与终态订单显示。
      // 终态（已取消/已拒/已送达 + 服务端整单未成）= 客单已结束，让用户自由切到「订单」「我的」
      const showNav = computed(() => {
        if (ui.studentTab !== 'home') return true;
        if (ui.studentStep === 'merchants') return true;
        if (ui.studentStep === 'status') {
          var o = store.activeOrder;
          if (!o) return true;
          if (o.syncStatus === 'rejected') return true;
          if (o.status === 'cancelled' || o.status === 'rejected' || o.status === 'delivered') return true;
        }
        return false;
      });
      function goTab(t) { ui.studentTab = t; if (t === 'home' && ['orders', 'me'].indexOf(ui.studentStep) < 0 && !store.activeOrder) ui.studentStep = 'merchants'; }
      function openHistory(id) { store.state.activeOrderId = id; ui.studentTab = 'home'; ui.studentStep = 'status'; }
      // 再来一单：进店并把可直接复购的商品加回购物车（含规格/已下架的提示手动选）
      function reorder(order) {
        store.openMerchant(order.merchantId); ui.studentTab = 'home'; ui.studentStep = 'menu';
        setTimeout(function () {
          const m = store.studentMerchant; if (!m) return;
          let added = 0, skipped = 0;
          (order.items || []).forEach(function (it) {
            const item = m.menu.find((x) => x.id === it.id);
            if (!item || !item.available || item.stock === 0 || (item.optionGroups && item.optionGroups.length)) { skipped++; return; }
            addLineRaw(item, [], it.qty || 1); added++;
          });
          if (skipped > 0) store.showToast(added ? '已加入可直接复购的商品；含规格或已变动的请手动选择' : '该店商品含规格或有变动，请手动选择', 'info');
        }, 150);
      }
      const liveCount = computed(() => store.profile ? store.state.orders.filter((o) => o.customer && o.customer.phone === store.profile.phone && ['pending', 'cooking', 'delivering'].indexOf(o.status) >= 0).length : 0);
      // 下拉刷新菜单
      const pullDist = ref(0); const pullArea = ref(null); let startY = null;
      function ptrStart(e) { startY = (window.scrollY <= 0) ? e.touches[0].clientY : null; pullDist.value = 0; }
      function ptrMove(e) { if (startY == null) return; e.preventDefault(); const d = e.touches[0].clientY - startY; if (d > 0 && window.scrollY <= 0) pullDist.value = Math.min(d * 0.5, 70); }
      function ptrEnd() { if (pullDist.value > 45) store.refreshStorefront(ui.studentMerchantId); pullDist.value = 0; startY = null; }
      onMounted(function () { pullArea.value && pullArea.value.addEventListener('touchmove', ptrMove, { passive: false }); });
      onUnmounted(function () { pullArea.value && pullArea.value.removeEventListener('touchmove', ptrMove); });

      // ====== iOS/Android PWA 首启动恢复 ======
      // 加主屏后 PWA 是独立存储域（与 Safari 不共享 localStorage/push subscription）
      // → 首次启动若没 profile，弹引导：输入手机号 → loadMyOrders + 从历史订单反推地址 + 申请通知权限
      var PWA_DONE_KEY = 'tt_pwa_first_done';
      var pwaRestoreOpen = ref(false);
      var pwaPhone = ref('');
      var pwaErr = ref('');
      var pwaSubmitting = ref(false);
      function pwaDismiss() {
        try { localStorage.setItem(PWA_DONE_KEY, '1'); } catch (_) {}
        pwaRestoreOpen.value = false;
        // 即便用户跳过恢复，PWA 模式下也尝试一次性申请通知权限（iOS 加主屏后唯一能拿到通知的入口）
        _maybeAskPwaNotify();
      }
      async function pwaSubmit() {
        var err = store.utils.validatePhone(pwaPhone.value);
        if (err) { pwaErr.value = err; return; }
        pwaErr.value = ''; pwaSubmitting.value = true;
        try {
          // 临时 profile（仅 phone）：让 loadMyOrders 能跑；之后从订单反推 name/addresses
          store.profile = { name: '', phone: String(pwaPhone.value).replace(/\D/g, ''), addresses: [] };
          await store.loadMyOrders();
          // 从历史订单反推个人资料 + 地址簿（按 building+room 去重，最近用过的设为默认）
          var mine = store.state.orders.filter(function (o) { return o.customer && o.customer.phone === store.profile.phone; });
          mine.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
          if (mine.length) {
            var seen = {}; var addrs = []; var name = '';
            mine.forEach(function (o) {
              if (!name && o.customer && o.customer.name) name = o.customer.name;
              var b = (o.customer && o.customer.building) || ''; var r = (o.customer && o.customer.room) || '';
              if (!b) return;
              var k = b + '|' + r; if (seen[k]) return; seen[k] = 1;
              addrs.push({ id: 'a' + Date.now() + addrs.length, label: addrs.length ? '其他' : '默认地址', building: b, room: r, isDefault: !addrs.length });
            });
            if (addrs.length) {
              store.profile = { name: name, phone: store.profile.phone, addresses: addrs };
              store.toastSuccess('✅ 恢复了 ' + mine.length + ' 个历史订单' + (addrs.length ? '，' + addrs.length + ' 个地址' : ''));
            } else {
              store.toastSuccess('✅ 恢复了 ' + mine.length + ' 个历史订单');
            }
            store._persistProfile && store._persistProfile();
          } else {
            store.profile = null; // 没有订单 → 不留半残 profile，让用户走正常首次填资料
            store.showToast('没找到这个号码的历史订单，可直接点单', 'info');
          }
          try { localStorage.setItem(PWA_DONE_KEY, '1'); } catch (_) {}
          pwaRestoreOpen.value = false;
          _maybeAskPwaNotify();
        } catch (e) {
          pwaErr.value = '恢复失败，请检查网络后重试';
        } finally { pwaSubmitting.value = false; }
      }
      function _maybeAskPwaNotify() {
        // PWA 内主动申请通知权限（iOS 加主屏后唯一能收到推送的路径）；失败静默
        try {
          if (window.notify && window.notify.supported() && window.notify.permission() === 'default' && store.profile) {
            window.notify.enable('customer', store.profile.phone, { askIfNeeded: true }).catch(function () {});
          }
        } catch (_) {}
      }
      onMounted(function () {
        // 仅在 standalone PWA + 还没 profile + 此前没引导过 时弹
        try {
          var isStandalone = window.notify && window.notify.isStandalone && window.notify.isStandalone();
          var done = localStorage.getItem(PWA_DONE_KEY) === '1';
          if (isStandalone && !store.profile && !done && !ui.preview) {
            // 稍延迟让 SPA 把首屏渲完，再弹
            setTimeout(function () { pwaRestoreOpen.value = true; }, 600);
          } else if (isStandalone && store.profile) {
            // 已有 profile（用户之前恢复过 / 在 PWA 内填过资料）→ 静默尝试申请通知权限
            _maybeAskPwaNotify();
          }
        } catch (_) {}
      });

      return { store, ui, cart, open, preorder, needProfile, sheetItem, cartCount, cartTotal, qtyOfItem, stockLeft, addSimple, removeSimple, openSheet, addLine, incLine, decLine, onSubmitted, startNew, showNav, goTab, openHistory, reorder, liveCount, pullDist, pullArea, ptrStart, ptrMove, ptrEnd, pwaRestoreOpen, pwaPhone, pwaErr, pwaSubmitting, pwaDismiss, pwaSubmit };
    },
  };

  // ---------- 商家列表 ----------
  window.MerchantList = {
    template: `
      <div class="m-list">
        <header class="home-hd">
          <div class="home-hd__loc" @click="onLocClick"><span class="home-hd__pin">📍</span><span class="home-hd__loc-t">{{ hubName || '请选择社区' }}</span><span class="home-hd__loc-edit">切换 ›</span></div>
          <h1 class="home-hd__title">{{ store.profile ? ('你好，' + store.profile.name) : '想吃点什么？' }}</h1>
        </header>
        <div class="home-search" v-if="store.currentHub">
          <span class="home-search__ic">🔍</span>
          <input v-model="q" placeholder="搜索商家或菜品" aria-label="搜索商家或菜品" />
          <button class="home-search__x" v-if="q" @click="q=''" aria-label="清除搜索">✕</button>
        </div>
        <div class="home-sec" v-if="store.currentHub"><span>{{ q ? '搜索结果' : '全部商家' }}</span><span class="home-sec__n">{{ filtered.length }}</span></div>

        <!-- 首次访问 / 未选社区 → 弹选择器（强制选才能看商家） -->
        <div class="modal" v-if="showHubPicker" @click.self="dismissPicker">
          <div class="modal__panel hub-picker" :class="{ 'hub-picker--shake': pickerShake }">
            <div class="hub-picker__title">📍 你在哪个社区？</div>
            <p class="hub-picker__sub">选了社区，才能看到附近的商家。可以随时点顶部切换。</p>
            <div class="hub-picker__list">
              <button class="hub-picker__item" v-for="h in store.state.hubs" :key="h.id" @click="pickHub(h.id)">
                <span class="hub-picker__ico">🏫</span>
                <span class="hub-picker__name">{{ h.name }}</span>
                <span class="hub-picker__arrow">›</span>
              </button>
              <div v-if="!store.state.hubs.length" class="empty">还没有社区开通服务</div>
            </div>
          </div>
        </div>

        <div class="modal" v-if="editAddr" @click.self="editAddr=false">
          <div class="modal__panel">
            <profile-form :buildings="store.hubBuildings(store.currentHub)" @done="editAddr=false"></profile-form>
          </div>
        </div>
        <div class="shop-cards">
          <!-- 加载未完成时显示一行轻量提示，避免闪现"暂未开通"（cold load 上 API ~3-5s） -->
          <div class="empty" v-if="!filtered.length && !store.ui.publicVendorsLoaded && !q"><span class="spin spin--dark"></span> 加载中…</div>
          <div class="empty" v-else-if="!filtered.length">{{ q ? '没有找到匹配的商家或菜品 🔍' : '本社区暂未开通商家' }}</div>
          <div class="shop-card" :class="{ 'shop-card--closed': !store.isOpen(m) }" v-for="m in filtered" :key="m.id" @click="store.openMerchant(m.id)">
            <div class="shop-card__logo">{{ m.logo }}</div>
            <div class="shop-card__body">
              <div class="shop-card__name">{{ m.name }}</div>
              <div class="shop-card__tags">
                <span class="tag" :class="store.isOpen(m) ? 'tag--open' : 'tag--off'">{{ store.isOpen(m) ? '营业中' : '休息中' }}</span>
                <span class="tag tag--promo" v-if="hasPromo(m)">🔥 特价</span>
                <span class="tag tag--mute" v-if="!m.settings.deliveryOffered">仅自取</span>
              </div>
              <div class="shop-card__desc">{{ m.desc }}</div>
              <div class="shop-card__meta">🍽 {{ m.menu.length }} 商品 · 🛵 {{ deliveryText(m) }}</div>
              <div class="shop-card__hit" v-if="matchedDishes(m).length">🔍 含 {{ matchedDishes(m).slice(0,3).join('、') }}{{ matchedDishes(m).length>3 ? ' 等' : '' }}</div>
            </div>
            <div class="shop-card__go">›</div>
          </div>
        </div>
      </div>
    `,
    setup() {
      const q = ref('');
      const editAddr = ref(false);
      const merchants = computed(() => store.visibleMerchants);
      // 搜索命中的菜品名（用于在店卡上提示"为什么这家店出现了"）
      function matchedDishes(m) {
        const k = q.value.trim().toLowerCase();
        if (!k) return [];
        return (m.menu || []).filter((it) => it.available && (it.name || '').toLowerCase().indexOf(k) >= 0).map((it) => it.name);
      }
      const filtered = computed(() => {
        const k = q.value.trim().toLowerCase();
        // 搜索同时匹配 商家名/简介 与 在售菜品名 —— 用户常常"想吃鸡饭"而不是"想去某家店"
        const base = k ? merchants.value.filter((m) => (m.name || '').toLowerCase().indexOf(k) >= 0 || (m.desc || '').toLowerCase().indexOf(k) >= 0 || matchedDishes(m).length > 0) : merchants.value;
        // 营业中的店排前面，休息/打烊的沉到底部（稳定排序，组内保持原顺序）——别让用户滑过一堆关着的店
        return base.slice().sort((a, b) => (store.isOpen(b) ? 1 : 0) - (store.isOpen(a) ? 1 : 0));
      });
      const hubName = computed(() => store.currentHubLabel());
      const locText = computed(() => {
        if (!store.profile) return hubName.value || '团团';
        var a = store.currentAddress();
        return a ? ('送至 · ' + a.building + ' ' + a.room) : (hubName.value || '团团');
      });
      // 社区选择器：未选社区 → 强制弹（除非系统里只 1 个社区，那自动选）
      const _pickerDismissed = ref(false);
      const showHubPicker = computed(() => {
        if (store.currentHub) return false;
        if (_pickerDismissed.value) return false;
        return true;
      });
      function pickHub(id) { store.setCurrentHub(id); _pickerDismissed.value = false; pickerShake.value = false; }
      // UX#5: clicking the backdrop should give visual feedback that the modal is mandatory
      // — without this, the user wonders if their click registered. Brief shake = "no, must pick".
      const pickerShake = ref(false);
      var _shakeTimer = null;
      function dismissPicker() {
        pickerShake.value = true;
        if (_shakeTimer) clearTimeout(_shakeTimer);
        _shakeTimer = setTimeout(function () { pickerShake.value = false; }, 450);
      }
      function onLocClick() {
        // 顶部 "切换" → 重新选社区
        store.setCurrentHub('');
        _pickerDismissed.value = false;
      }
      // 单社区系统：自动选，省一步
      onMounted(function () {
        if (!store.currentHub && store.state.hubs && store.state.hubs.length === 1) {
          store.setCurrentHub(store.state.hubs[0].id);
        }
      });
      function deliveryText(m) {
        if (!m.settings.deliveryOffered) return '仅自取';
        return m.settings.deliveryMode === 'fixed' ? '定时配送' : ('约 ' + m.settings.flexibleMin + '-' + m.settings.flexibleMax + ' 分钟');
      }
      function hasPromo(m) { return m.menu.some((it) => it.available && store.utils.hasDiscount(it)); }
      return { store, q, editAddr, merchants, filtered, matchedDishes, hubName, locText, deliveryText, hasPromo, showHubPicker, pickHub, dismissPicker, onLocClick, pickerShake };
    },
  };

  const ORDER_STATUS = {
    pending: { label: '等待验证', cls: 'st-pending' }, cooking: { label: '备餐中', cls: 'st-cooking' },
    delivering: { label: '配送中', cls: 'st-delivering' }, delivered: { label: '已送达', cls: 'st-delivered' },
    rejected: { label: '已拒绝', cls: 'st-rejected' }, cancelled: { label: '已取消', cls: 'st-rejected' },
  };

  // ---------- 我的订单（历史 + 实时状态） ----------
  window.CustomerOrders = {
    emits: ['open', 'reorder'],
    template: `
      <div class="cust-page">
        <h2 class="cust-head">我的订单 <span class="sm muted" v-if="store.ui.myOrdersRefreshing"><span class="spin spin--dark"></span> 刷新中…</span><span class="sm muted" v-else-if="store.ui.myOrdersError && orders.length">· 暂时连不上，显示本地记录</span></h2>
        <div class="empty" v-if="!orders.length">还没有订单，去首页点一单吧 🍱</div>
        <template v-if="active.length"><div class="cat-group__title">进行中</div>
          <div class="order-card" v-for="o in active" :key="o.id" @click="$emit('open', o.id)">
            <div class="order-card__top"><span class="order-card__id">{{ shopName(o.merchantId) }}</span><span class="chip" :class="st(o.status).cls">{{ st(o.status).label }}</span></div>
            <div class="order-card__cust">{{ items(o) }}</div>
            <div class="order-card__meta"><span>{{ store.utils.relTime(o.createdAt) }} · {{ o.id }}</span><span>{{ store.utils.rm(o.total) }}</span></div>
            <!-- syncing 静默不显示：提交时已弹"📤 订单已提交，正在确认…" toast，再挂旋转条会让人误以为没成功 -->
            <div class="sync-note sync-note--wait sm" v-if="o.syncStatus==='pending'">📶 网络有点慢，请刷新页面再试</div>
            <div class="sync-note sync-note--bad sm" v-else-if="o.syncStatus==='rejected'">❌ 下单未成功，请刷新页面重试</div>
            <div class="card-actions" v-if="o.imgStatus==='slow'" @click.stop><span class="img-sync__tag muted">⏳ 截图传送中…</span></div>
            <div class="card-actions" v-else-if="o.imgStatus==='failed'" @click.stop><span class="img-sync__tag">⚠ 截图没传上</span><button class="btn btn--sm btn--primary" @click="store.retryOrderShot(o.id)">重新上传</button></div>
          </div>
        </template>
        <template v-if="past.length"><div class="cat-group__title">历史订单</div>
          <div class="order-card" v-for="o in past" :key="o.id" @click="$emit('open', o.id)">
            <div class="order-card__top"><span class="order-card__id">{{ shopName(o.merchantId) }}</span><span class="chip" :class="st(o.status).cls">{{ st(o.status).label }}</span></div>
            <div class="order-card__cust">{{ items(o) }}</div>
            <div class="order-card__meta"><span>{{ store.utils.relTime(o.createdAt) }} · {{ o.id }}</span><span>{{ store.utils.rm(o.total) }}</span></div>
            <div class="card-actions" @click.stop><button class="btn btn--sm btn--ghost" @click="$emit('reorder', o)">再来一单</button></div>
          </div>
        </template>
      </div>
    `,
    setup() {
      const orders = computed(() => store.profile ? store.state.orders.filter((o) => o.customer && o.customer.phone === store.profile.phone) : []);
      const ACTIVE = ['pending', 'cooking', 'delivering'];
      const active = computed(() => orders.value.filter((o) => ACTIVE.indexOf(o.status) >= 0));
      const past = computed(() => orders.value.filter((o) => ACTIVE.indexOf(o.status) < 0));
      function shopName(id) { const m = store.getMerchant(id); return m ? m.name : '商家'; }
      function items(o) { return (o.items || []).map(function (i) { return i.name + '×' + i.qty; }).join('，'); }
      function st(s) { return ORDER_STATUS[s] || { label: s, cls: '' }; }
      function onVisible() { if (document.visibilityState === 'visible') store.loadMyOrders(); }
      onMounted(function () {
        store.loadMyOrders(); // 打开「订单」即刷新，商家改的状态(取消/拒绝/送达)同步过来
        document.addEventListener('visibilitychange', onVisible); // 回前台再刷一次，避免列表停留在过时状态
      });
      onUnmounted(function () { document.removeEventListener('visibilitychange', onVisible); });
      return { store, orders, active, past, shopName, items, st };
    },
  };

  // ---------- 我的（资料 + 统计） ----------
  window.CustomerProfile = {
    template: `
      <div class="cust-page">
        <h2 class="cust-head">我的</h2>
        <template v-if="!editing && store.profile">
          <div class="profile-card">
            <div class="profile-card__avatar">{{ store.profile.name.slice(0,1) }}</div>
            <div><div class="profile-card__name">{{ store.profile.name }}</div><div class="profile-card__sub">{{ store.utils.displayPhone(store.profile.phone) }}</div></div>
          </div>
          <!-- 地址簿（多地址 + 默认 + 切换） -->
          <div class="card addrbook">
            <div class="addrbook__head"><span>📍 配送地址簿（{{ addresses.length }}）</span><button v-if="addresses.length < 10" class="link-btn" @click="openAdd">+ 新增</button></div>
            <div v-if="!addresses.length" class="muted sm" style="padding:8px 0">还没有地址，点"+ 新增"添加一个</div>
            <div class="addr-row" v-for="a in addresses" :key="a.id">
              <div class="addr-row__body">
                <div class="addr-row__top"><span class="addr-label">{{ a.label }}</span><span class="chip chip--ok sm" v-if="a.isDefault">默认</span></div>
                <div class="addr-row__where">{{ a.building }} {{ a.room }}</div>
              </div>
              <div class="addr-row__acts">
                <button v-if="!a.isDefault" class="link-btn sm" @click="store.setDefaultAddress(a.id)">设为默认</button>
                <button class="link-btn sm" @click="startEdit(a)">编辑</button>
                <button v-if="addresses.length>1" class="link-btn sm danger-text" @click="askRemove(a)">删除</button>
              </div>
            </div>
          </div>
          <div class="card"><div class="kv"><span>累计订单</span><b>{{ stats.n }} 单</b></div><div class="kv"><span>累计消费</span><b>{{ store.utils.rm(stats.spent) }}</b></div></div>
          <div class="card"><label class="fee-toggle"><input type="checkbox" :checked="store.soundOn()" @change="store.setSoundOn($event.target.checked)" /><span>🔔 订单送达提示音</span></label></div>
          <button class="btn btn--block btn--ghost" @click="editing=true">编辑资料</button>
          <button class="btn btn--block btn--ghost danger-text" @click="clearMe">清除本机资料</button>
        </template>
        <profile-form v-else @done="editing=false"></profile-form>
        <contact-panel role="customer"></contact-panel>

        <!-- 新增地址 modal -->
        <div class="modal" v-if="addrModal==='add'" @click.self="addrModal=''">
          <div class="modal__panel">
            <div class="modal__head"><span>新增地址</span><button class="link-btn" @click="addrModal=''">关闭</button></div>
            <label class="field"><span>标签</span><input v-model="addrDraft.label" placeholder="如：家 / 办公室 / 朋友家" maxlength="20" /></label>
            <label class="field"><span>楼栋</span><input v-model="addrDraft.building" placeholder="如：A 栋 / 宿舍 1 座" maxlength="60" /></label>
            <label class="field"><span>标记点</span><input v-model="addrDraft.room" placeholder="如：506 / B12 柜" maxlength="30" /></label>
            <p class="error" v-if="addrErr">{{ addrErr }}</p>
            <button class="btn btn--primary btn--block" @click="saveAdd">保存</button>
          </div>
        </div>
        <!-- 编辑地址 modal -->
        <div class="modal" v-if="addrModal==='edit' && editing_addr" @click.self="addrModal=''">
          <div class="modal__panel">
            <div class="modal__head"><span>编辑地址</span><button class="link-btn" @click="addrModal=''">关闭</button></div>
            <label class="field"><span>标签</span><input v-model="editing_addr.label" maxlength="20" /></label>
            <label class="field"><span>楼栋</span><input v-model="editing_addr.building" maxlength="60" /></label>
            <label class="field"><span>标记点</span><input v-model="editing_addr.room" maxlength="30" /></label>
            <button class="btn btn--primary btn--block" @click="saveEdit">保存修改</button>
          </div>
        </div>
      </div>
    `,
    setup() {
      const editing = ref(!store.profile);
      const addresses = computed(() => (store.profile && store.profile.addresses) || []);
      const stats = computed(() => {
        const os = store.profile ? store.state.orders.filter((o) => o.customer && o.customer.phone === store.profile.phone) : [];
        return { n: os.length, spent: os.filter((o) => o.status !== 'rejected' && o.status !== 'cancelled').reduce((s, o) => s + (o.total || 0), 0) };
      });
      function clearMe() { if (window.confirm('清除本机保存的姓名/电话/地址？')) { store.clearProfile(); editing.value = true; } }
      // 地址簿管理
      const addrModal = ref(''); // '' | 'add' | 'edit'
      const addrDraft = reactive({ label: '', building: '', room: '' });
      const addrErr = ref('');
      const editing_addr = ref(null);
      function openAdd() { addrDraft.label = ''; addrDraft.building = ''; addrDraft.room = ''; addrErr.value = ''; addrModal.value = 'add'; }
      function saveAdd() {
        if (!addrDraft.building.trim()) { addrErr.value = '请填写楼栋'; return; }
        store.addAddress(addrDraft.label, addrDraft.building, addrDraft.room);
        addrModal.value = '';
      }
      function startEdit(a) { editing_addr.value = { id: a.id, label: a.label, building: a.building, room: a.room }; addrModal.value = 'edit'; }
      function saveEdit() {
        if (!editing_addr.value) return;
        store.updateAddress(editing_addr.value.id, { label: editing_addr.value.label, building: editing_addr.value.building, room: editing_addr.value.room });
        addrModal.value = ''; editing_addr.value = null;
      }
      function askRemove(a) { if (window.confirm('删除地址「' + a.label + '」？')) store.removeAddress(a.id); }
      return { store, editing, stats, clearMe, addresses, addrModal, addrDraft, addrErr, editing_addr, openAdd, saveAdd, startEdit, saveEdit, askRemove };
    },
  };

  // ---------- 资料表单 ----------
  window.ProfileForm = {
    props: ['buildings'],
    emits: ['done'],
    template: `
      <div class="card form-card">
        <h2 class="form-title">填写收货资料</h2>
        <p class="form-note">只需填一次，本机自动记住，下次免登录直接下单。</p>
        <label class="field"><span>姓名</span><input v-model="form.name" placeholder="例如：陈小明" maxlength="60" /></label>
        <label class="field field--phone"><span>手机号</span>
          <div class="phone-input"><span class="phone-input__cc">🇲🇾 +60</span><input v-model="form.phone" @blur="normalizePhone" type="tel" inputmode="numeric" placeholder="例如：12-345 6789（或 0123456789）" maxlength="20" /></div>
        </label>
        <p class="muted sm field-hint" v-if="phonePreview.ok" style="margin-top:-6px;color:var(--green-d)">✓ 将存为 <b>{{ phonePreview.display }}</b></p>
        <p class="muted sm field-hint" v-else-if="form.phone" style="margin-top:-6px;color:#d97706">⚠ {{ phonePreview.err }}（{{ phonePreview.digits }} 位）</p>
        <div class="field-row">
          <label class="field"><span>配送楼栋</span>
            <select v-if="buildings && buildings.length" class="cat-select" v-model="form.building">
              <option value="">请选择楼栋</option>
              <option v-for="b in buildings" :key="b" :value="b">{{ b }}</option>
              <option value="__other__">其他（手填）</option>
            </select>
            <input v-if="!(buildings && buildings.length)" v-model="form.building" placeholder="如：A 栋 / 3 号楼" maxlength="60" />
            <input v-if="(buildings && buildings.length) && form.building==='__other__'" v-model="otherBld" class="field-extra" placeholder="手填配送楼栋" maxlength="60" />
          </label>
          <label class="field"><span>标记点（选填）</span><input v-model="form.room" placeholder="如：506 / B12 柜" maxlength="30" /></label>
        </div>
        <p class="error" v-if="error">{{ error }}</p>
        <!-- PDPA 同意（仅首次填资料时显示，0 友情绑架的最小负担）-->
        <label v-if="needsConsent" class="tos-check">
          <input type="checkbox" v-model="agreed" />
          <span>我已阅读并同意 <a href="/terms.html" target="_blank" rel="noopener">使用条款</a> 和 <a href="/privacy.html" target="_blank" rel="noopener">隐私政策</a></span>
        </label>
        <button class="btn btn--primary btn--block" @click="submit">保存并继续</button>
      </div>
    `,
    setup(props, { emit }) {
      const ex = store.profile || {};
      // Bug 3 fix: legacy profiles store building/room flat, but saveProfile() migrates to
      // addresses[]. When reopening "修改地址", ex.building was undefined → form showed empty
      // even though the user had previously picked A 栋. Read from default address as fallback.
      var defaultAddr = {};
      if (Array.isArray(ex.addresses) && ex.addresses.length) {
        defaultAddr = ex.addresses.find(function (a) { return a.isDefault; }) || ex.addresses[0] || {};
      }
      const form = reactive({
        name: ex.name || '',
        phone: ex.phone || '',
        building: ex.building || defaultAddr.building || '',
        room: ex.room || defaultAddr.room || ''
      });
      const otherBld = ref('');
      if (props.buildings && props.buildings.length && form.building && props.buildings.indexOf(form.building) < 0) { form.building = '__other__'; otherBld.value = form.building === '__other__' ? (ex.building || defaultAddr.building || '') : form.building; }
      const error = ref('');
      // Bug 1 fix: clear stale error as soon as the user starts editing any field.
      // Previously the red "姓名不能为空" lingered after the user filled the name.
      watch(form, function () { if (error.value) error.value = ''; });
      watch(otherBld, function () { if (error.value) error.value = ''; });
      // 手机号失焦归一化：剥非数字 + 实时回显「将存为 +60 16-510 1001」
      //   避免用户被 iOS Safari 自动补全 / 误输入空格 / 怀疑被截断（之前曾有 "存了 01651" 的疑虑）
      //   maxlength 提到 20 给输入余量（含格式符），归一后再校验 7-15 位
      function normalizePhone() {
        var raw = String(form.phone || '');
        var d = raw.replace(/\D/g, '');
        if (d.length > 15) d = d.slice(0, 15);
        if (d !== raw) form.phone = d;
      }
      const phonePreview = computed(function () {
        var raw = String(form.phone || '');
        var d = raw.replace(/\D/g, '');
        if (!d) return { ok: false, digits: 0, err: '请输入号码' };
        if (d.length < 7) return { ok: false, digits: d.length, err: '位数过短，至少 7 位' };
        if (d.length > 15) return { ok: false, digits: d.length, err: '位数过长，最多 15 位' };
        return { ok: true, digits: d.length, display: store.utils.displayPhone(d) };
      });
      // PDPA 同意：localStorage 记录一次接受过的版本，下次不再问
      const TOS_VERSION = 'v1.0';
      const needsConsent = computed(function () { return localStorage.getItem('tt_tos_accepted') !== TOS_VERSION; });
      const agreed = ref(false);
      function submit() {
        var nameErr = store.utils.validateName(form.name);
        if (nameErr) return (error.value = nameErr);
        var phoneErr = store.utils.validatePhone(form.phone);
        if (phoneErr) return (error.value = phoneErr);
        var building = (props.buildings && props.buildings.length && form.building === '__other__') ? otherBld.value.trim() : (form.building || '').trim();
        if (!building) return (error.value = '请选择或填写配送楼栋');
        if (needsConsent.value && !agreed.value) return (error.value = '请先阅读并同意使用条款 + 隐私政策');
        // 记录 PDPA 同意证据（beta 阶段 localStorage 足够；商业规模时升级到后端 ConsentLogs）
        try {
          if (needsConsent.value) {
            localStorage.setItem('tt_tos_accepted', TOS_VERSION);
            localStorage.setItem('tt_tos_accepted_at', new Date().toISOString());
          }
        } catch (_) {}
        error.value = ''; store.saveProfile({ name: form.name, phone: form.phone, building: building, room: form.room }); emit('done');
      }
      return { form, error, submit, otherBld, needsConsent, agreed, normalizePhone, phonePreview, store };
    },
  };

  // ---------- 菜单（分类分组 + 筛选 + 折扣/规格） ----------
  window.MenuList = {
    props: ['qtyOf'],
    emits: ['add', 'remove', 'choose'],
    template: `
      <div class="menu">
        <!-- 菜单内搜索：菜品 >5 时显示，按名称/描述/规格匹配 -->
        <div class="menu-search" v-if="totalCount > 4">
          <input class="menu-search__in" type="text" v-model="q" placeholder="🔍 搜菜名 / 描述 / 规格" maxlength="30" />
          <button v-if="q" class="menu-search__clr" @click="q=''" aria-label="清空">×</button>
        </div>
        <div class="cat-bar" v-if="!q.trim() && catNames.length > 1">
          <button class="cat-pill" :class="{active: sel==='全部'}" @click="sel='全部'">全部</button>
          <button class="cat-pill" :class="{active: sel===c}" v-for="c in catNames" :key="c" @click="sel=c">{{ c }}</button>
        </div>
        <div class="menu-empty" v-if="q.trim() && hitCount===0">
          <div class="menu-empty__ic">🔎</div>
          <div class="menu-empty__t">没有匹配到「{{ q }}」</div>
          <button class="link-btn" @click="q=''">清空搜索</button>
        </div>
        <!-- 加载骨架：首次进店、本地还没菜品时显示，比"加载中"文字更不突兀 -->
        <div class="skel-list" v-if="store.ui.menuLoading && !shown.length">
          <div class="dish skel-dish" v-for="n in 5" :key="'sk'+n">
            <div class="skel-thumb"></div>
            <div class="skel-dish__body"><div class="skel-line skel-line--60"></div><div class="skel-line skel-line--40"></div><div class="skel-line skel-line--30"></div></div>
          </div>
        </div>
        <div class="menu-fail" v-if="store.ui.menuError && !shown.length">
          <div class="menu-fail__ic">😕</div>
          <div class="menu-fail__t">菜单没加载出来</div>
          <div class="menu-fail__sub">可能网络慢了一下</div>
          <button class="btn btn--primary btn--pill" @click="store.openMerchant(store.ui.studentMerchantId)">点此重试</button>
        </div>
        <div class="cat-group" v-for="g in displayed" :key="g.name">
          <div class="cat-group__title" :class="{ 'cat-group__title--promo': g.promo }">{{ g.name }}</div>
          <div class="dish" :class="{ 'dish--off': !m.available || m.stock===0 }" v-for="m in g.items" :key="g.name+m.id">
            <div class="dish__img">
              <img v-if="store.utils.isImg(m.image)" :src="m.image" alt="" /><span v-else>{{ store.utils.dishEmoji(m) }}</span>
              <span class="disc-badge" v-if="store.utils.hasDiscount(m)">{{ store.utils.discountLabel(m) }}</span>
            </div>
            <div class="dish__body">
              <div class="dish__name">{{ m.name }}
                <span class="pill-tag pill-tag--closed" v-if="!m.available || m.stock===0">售罄</span>
                <span class="pill-tag pill-tag--opt" v-else-if="m.optionGroups && m.optionGroups.length">可选规格</span>
              </div>
              <div class="dish__desc">{{ m.desc }}</div>
              <div class="dish__price">
                <span v-if="store.utils.hasDiscount(m)"><span class="price-now">{{ store.utils.rm(store.utils.effPrice(m)) }}</span> <span class="price-was">{{ store.utils.rm(m.price) }}</span></span>
                <span v-else>{{ store.utils.rm(m.price) }}</span>
                <span class="stock-tag stock-tag--low" v-if="m.available && m.stock>0 && (m.stock - qtyOf(m.id))<=3">⚡ 仅剩 {{ m.stock - qtyOf(m.id) }} 份</span>
                <span class="stock-tag" v-else-if="m.available && m.stock>0">· 剩 {{ m.stock - qtyOf(m.id) }} 份</span>
              </div>
            </div>
            <div class="dish__ctrl">
              <template v-if="m.available && m.stock!==0">
                <button v-if="m.optionGroups && m.optionGroups.length" class="btn btn--primary btn--sm btn--pill" @click="$emit('choose', m)">选规格<i class="ctrl-badge" v-if="qtyOf(m.id)">{{ qtyOf(m.id) }}</i></button>
                <template v-else>
                  <div class="stepper" v-if="qtyOf(m.id) > 0"><button class="stepper__btn" @click="$emit('remove', m)">−</button><span class="stepper__num">{{ qtyOf(m.id) }}</span><button class="stepper__btn stepper__btn--add" :disabled="m.stock!=null && qtyOf(m.id)>=m.stock" @click="$emit('add', m)">＋</button></div>
                  <button v-else class="btn btn--primary btn--sm btn--pill" @click="$emit('add', m)">加入</button>
                </template>
              </template>
            </div>
          </div>
        </div>
      </div>
    `,
    setup() {
      const sel = ref('全部');
      const q = ref(''); // 菜单内搜索关键字（菜名/描述/规格名）
      const groups = computed(() => {
        const base = store.groupedMenu(store.studentMerchant, false);
        const m = store.studentMerchant;
        const promo = m ? m.menu.filter((it) => it.available && it.stock !== 0 && store.utils.hasDiscount(it)) : [];
        return promo.length ? [{ name: '🔥 限时优惠', items: promo, promo: true }].concat(base) : base;
      });
      const catNames = computed(() => groups.value.map((g) => g.name));
      const shown = computed(() => (sel.value === '全部' ? groups.value : groups.value.filter((g) => g.name === sel.value)));
      const totalCount = computed(() => store.studentMerchant ? (store.studentMerchant.menu || []).length : 0);
      // 搜索：跨分类全局过滤；空 query 走原 shown(按 sel 过滤)
      const filtered = computed(() => {
        const Q = q.value.trim().toLowerCase(); if (!Q) return [];
        function optMatch(it) {
          if (!Array.isArray(it.optionGroups)) return false;
          return it.optionGroups.some(function (g) { return (g.options || []).some(function (o) { return ((o.name || '') + '').toLowerCase().includes(Q); }); });
        }
        return groups.value.map(function (g) {
          var items = g.items.filter(function (it) {
            return ((it.name || '') + '').toLowerCase().includes(Q)
              || ((it.desc || '') + '').toLowerCase().includes(Q)
              || optMatch(it);
          });
          return Object.assign({}, g, { items: items });
        }).filter(function (g) { return g.items.length > 0; });
      });
      const hitCount = computed(() => filtered.value.reduce(function (s, g) { return s + g.items.length; }, 0));
      const displayed = computed(() => q.value.trim() ? filtered.value : shown.value);
      return { store, sel, q, groups, catNames, shown, totalCount, filtered, hitCount, displayed };
    },
  };

  // ---------- 规格/加料 选择弹层（Grab 式底部抽屉） ----------
  window.OptionSheet = {
    props: ['item', 'left'],
    emits: ['close', 'add'],
    template: `
      <div class="sheet" @click.self="$emit('close')">
        <div class="sheet__panel">
          <div class="sheet__head">
            <div class="sheet__img"><img v-if="store.utils.isImg(item.image)" :src="item.image" alt="" /><span v-else>{{ store.utils.dishEmoji(item) }}</span></div>
            <div><div class="sheet__name">{{ item.name }}</div><div class="sheet__desc">{{ item.desc }}</div>
              <div class="sheet__price"><span class="price-now">{{ store.utils.rm(store.utils.effPrice(item)) }}</span> <span class="price-was" v-if="store.utils.hasDiscount(item)">{{ store.utils.rm(item.price) }}</span></div>
            </div>
            <button class="sheet__x" @click="$emit('close')" aria-label="关闭">✕</button>
          </div>
          <div class="sheet__body">
            <div class="opt-group" v-for="g in item.optionGroups" :key="g.id">
              <div class="opt-group__head"><span>{{ g.name }}</span><span class="opt-group__tag">{{ g.type==='single' ? (g.required?'必选':'单选') : ('多选' + (g.max? ' · 最多'+g.max:'')) }}</span></div>
              <button class="opt-row" v-for="o in g.options" :key="o.id" :class="{ on: isSel(g,o) }"
                role="checkbox" :aria-checked="isSel(g,o) ? 'true' : 'false'"
                @click.stop="toggle(g,o)"
                @keydown.space.prevent="toggle(g,o)" @keydown.enter.prevent="toggle(g,o)">
                <span class="opt-row__name"><i class="opt-mark" :class="g.type">{{ isSel(g,o) ? (g.type==='single'?'●':'✓') : '' }}</i>{{ o.name }}</span>
                <span class="opt-row__price" v-if="o.price>0">+{{ store.utils.rm(o.price) }}</span>
              </button>
            </div>
          </div>
          <div class="sheet__foot">
            <div class="stepper"><button class="stepper__btn" @click="qty>1 && qty--">−</button><span class="stepper__num">{{ qty }}</span><button class="stepper__btn stepper__btn--add" :disabled="qty>=left" @click="qty<left && qty++">＋</button></div>
            <button class="btn btn--primary btn--pill sheet__add" :disabled="!valid" @click="confirm">加入购物车 · {{ store.utils.rm(unit*qty) }}</button>
          </div>
          <p class="error center" v-if="err">{{ err }}</p>
        </div>
      </div>
    `,
    setup(props, { emit }) {
      const single = reactive({}); const multi = reactive({}); const qty = ref(1); const err = ref('');
      (props.item.optionGroups || []).forEach((g) => {
        if (g.type === 'single') single[g.id] = g.required && g.options[0] ? g.options[0].id : '';
        else multi[g.id] = [];
      });
      function isSel(g, o) { return g.type === 'single' ? single[g.id] === o.id : (multi[g.id] || []).indexOf(o.id) >= 0; }
      function toggle(g, o) {
        if (g.type === 'single') { single[g.id] = single[g.id] === o.id && !g.required ? '' : o.id; }
        else { const arr = multi[g.id]; const i = arr.indexOf(o.id); if (i >= 0) arr.splice(i, 1); else { if (g.max && arr.length >= g.max) { err.value = '「' + g.name + '」最多选 ' + g.max + ' 项'; return; } arr.push(o.id); } err.value = ''; }
      }
      const selected = computed(() => {
        const out = [];
        (props.item.optionGroups || []).forEach((g) => {
          if (g.type === 'single') { const o = g.options.find((x) => x.id === single[g.id]); if (o) out.push({ group: g.name, optId: o.id, name: o.name, price: o.price }); }
          else (multi[g.id] || []).forEach((id) => { const o = g.options.find((x) => x.id === id); if (o) out.push({ group: g.name, optId: o.id, name: o.name, price: o.price }); });
        });
        return out;
      });
      const unit = computed(() => store.utils.effPrice(props.item) + selected.value.reduce((s, o) => s + (Number(o.price) || 0), 0));
      // 必选门控：single-required 必须有选项 + multi-required 必须达到 min（默认 1）
      // 之前只 gate 了 single，导致「必选多选」组没选也能加购物车
      const minOf = (g) => (Number(g.min) > 0 ? Number(g.min) : 1);
      const groupOk = (g) => {
        if (g.type === 'single' && g.required) return !!single[g.id];
        if (g.type === 'multi' && g.required) return (multi[g.id] || []).length >= minOf(g);
        return true;
      };
      const valid = computed(() => (props.item.optionGroups || []).every(groupOk) && props.left > 0);
      function confirm() {
        const groups = props.item.optionGroups || [];
        const missS = groups.find((g) => g.type === 'single' && g.required && !single[g.id]);
        if (missS) { err.value = '请选择「' + missS.name + '」'; return; }
        const missM = groups.find((g) => g.type === 'multi' && g.required && (multi[g.id] || []).length < minOf(g));
        if (missM) { err.value = '「' + missM.name + '」至少选 ' + minOf(missM) + ' 项'; return; }
        emit('add', { item: props.item, options: selected.value, qty: qty.value });
      }
      return { store, single, multi, qty, err, isSel, toggle, selected, unit, valid, confirm };
    },
  };

  // ---------- 结算 ----------
  window.CheckoutView = {
    props: ['merchant', 'lines', 'subtotal', 'preview'],
    emits: ['back', 'submitted', 'inc', 'dec'],
    template: `
      <div class="checkout">
        <div class="checkout__head"><button class="icon-back" @click="$emit('back')" aria-label="返回">‹</button><h2>确认订单</h2></div>

        <!-- 送达地址置顶·最高权重（对齐主流外卖结算页：地址→时间→商品→支付）-->
        <!-- v-if 守卫：admin 上帝视角预览客户结算页时 store.profile 为 null，曾在此裸读 .building 崩渲染 -->
        <!-- 地址簿：currentAddr 即用户切换过的 / 默认 / 首条；多地址点卡片打开切换器；单地址打开编辑表单 -->
        <div class="card co-addr" v-if="store.profile && currentAddr" :class="{'co-addr--tap': !preview}" @click="!preview && (addresses.length>1 ? (pickerOpen=true) : (editingAddr=true))">
          <span class="co-addr__pin">📍</span>
          <div class="co-addr__body">
            <div class="co-addr__where"><span class="addr-label addr-label--inline" v-if="currentAddr.label">{{ currentAddr.label }}</span>{{ currentAddr.building }} {{ currentAddr.room }}</div>
            <div class="co-addr__who">{{ store.profile.name }} · {{ store.utils.displayPhone(store.profile.phone) }}</div>
          </div>
          <span class="co-addr__edit" v-if="!preview">修改 ›</span>
        </div>

        <div class="card">
          <div class="card__label">🕒 配送时间</div>
          <template v-if="mode === 'fixed'">
            <div class="slots"><button v-for="slot in merchant.settings.fixedSlots" :key="slot" class="slot" :class="{ active: chosenSlot===slot }" :disabled="!slotOk(slot)" @click="slotOk(slot) && (chosenSlot=slot)">{{ slot }}<small v-if="!slotOk(slot)"> 已截止</small></button></div>
            <p class="error" v-if="closed">⛔ 今日下单已截止（需在时段开始前 {{ merchant.settings.cutoffMins }} 分钟下单）</p>
          </template>
          <template v-else>
            <div class="flex-eta">⏱ 预计 {{ merchant.settings.flexibleMin }}-{{ merchant.settings.flexibleMax }} 分钟内送达</div>
            <p class="error" v-if="closed">⛔ 今日已截止接单（{{ merchant.settings.flexCloseTime }} 后停止）</p>
          </template>
        </div>

        <div class="card">
          <div class="co-line" v-for="l in lines" :key="l.key">
            <div class="co-line__info"><div class="co-line__name">{{ l.name }}</div><div class="co-line__opt" v-if="l.optionText">{{ l.optionText }}</div></div>
            <div class="stepper stepper--sm"><button class="stepper__btn" @click="$emit('dec', l.key)">−</button><span class="stepper__num">{{ l.qty }}</span><button class="stepper__btn stepper__btn--add" @click="$emit('inc', l.key)">＋</button></div>
            <div class="co-line__price">{{ store.utils.rm(l.unit*l.qty) }}</div>
          </div>
          <div class="line"><span class="muted">小计</span><span>{{ store.utils.rm(b.subtotal) }}</span></div>
          <div class="line" v-if="b.packaging>0"><span class="muted">打包费</span><span>{{ store.utils.rm(b.packaging) }}</span></div>
          <div class="line" v-if="b.delivery>0"><span class="muted">配送费</span><span>{{ store.utils.rm(b.delivery) }}</span></div>
          <div class="line co-discount" v-if="redeemMembership"><span class="muted">🫘 团团豆抵扣</span><span>− {{ store.utils.rm(membershipDiscount) }}</span></div>
          <div class="line line--total"><span>合计</span><span>{{ store.utils.rm(finalTotal) }}</span></div>
        </div>

        <div class="card cp-co" v-if="membershipEnabled">
          <div class="card__label">🫘 团团豆</div>
          <div v-if="membershipBalance > 0">
            <p class="muted sm" style="margin:0 0 8px">你有 <b>{{ membershipBalance }} 豆</b>（每 RM {{ membershipPtsPerRM }} 积 1 豆{{ membershipCanRedeem ? '，满 ' + membershipNeedPts + ' 豆可抵 RM ' + store.utils.rm(membershipRedeemValue) : '' }}）</p>
            <label class="fee-toggle" v-if="membershipCanRedeem && !redeemMembership">
              <input type="checkbox" v-model="redeemMembership" />
              <span>使用 {{ membershipNeedPts }} 豆抵扣 RM {{ store.utils.rm(membershipRedeemValue) }}</span>
            </label>
            <div class="cp-co__applied" v-if="redeemMembership">
              <span class="cp-co__ok">✓ 已用 {{ membershipNeedPts }} 豆抵扣 RM {{ store.utils.rm(membershipDiscount) }}</span>
              <button class="link-btn danger-text" @click="redeemMembership=false">取消</button>
            </div>
          </div>
          <p class="muted sm" v-else>暂无团团豆，下单后自动积豆。</p>
        </div>

        <div class="card" v-if="merchant.settings && merchant.settings.allowRemark !== false"><div class="card__label">📝 备注（选填）</div><input class="remark-in" v-model="remark" maxlength="60" placeholder="如：少辣、不要葱、放门口" /></div>

        <div class="card pay-card">
          <div class="card__label">💳 第一步：扫码付款 {{ store.utils.rm(finalTotal) }}</div>
          <template v-if="merchant.payQRs && merchant.payQRs.length">
            <div class="qr-tabs" v-if="merchant.payQRs.length > 1">
              <button class="qr-tab" :class="{active: qrIndex===i}" v-for="(q,i) in merchant.payQRs" :key="q.id" @click="qrIndex=i">{{ q.label }}</button>
            </div>
            <div class="qr-show">
              <img class="qr" :src="merchant.payQRs[qrIndex].image" alt="" @click="openTab(merchant.payQRs[qrIndex].image)" />
              <div class="qr-show__label">{{ merchant.payQRs[qrIndex].label }}</div>
              <div class="qr-show__to">收款方：{{ merchant.tngLabel }}</div>
            </div>
          </template>
          <p class="muted sm" v-else>商家尚未设置收款码，暂时无法扫码付款。</p>
        </div>

        <div class="card">
          <div class="card__label">📤 第二步：上传「支付成功」截图（必填）</div>
          <label class="upload__drop" v-if="!screenshot"><input type="file" accept="image/*" @change="onFile" hidden /><span class="upload__plus">＋</span><span>点击选择支付截图</span></label>
          <div class="upload__preview" v-else><img :src="screenshot" alt="" /><button class="link-btn" @click="screenshot=''">重新上传</button></div>
          <button v-if="allowSampleShot" class="link-btn sm" @click="screenshot=store.utils.sampleScreenshot({total:finalTotal})">没有截图？用示例图测试</button>
        </div>

        <p class="error" v-if="error">{{ error }}</p>
        <div v-if="preview" class="preview-note">预览模式不可真正下单</div>
        <button v-else class="btn btn--primary btn--block btn--pill" :disabled="closed || !screenshot || submitting" @click="submit">{{ submitting ? '提交中…' : (closed ? '今日已截止' : (!screenshot ? '请先上传支付截图' : '提交订单')) }}</button>

        <!-- 结算页直接改地址：点地址卡 → 底部弹出资料表单 -->
        <!-- 多地址切换器：单击当前地址卡时弹出，列出所有保存地址 + 跳"我的"管理 -->
        <div class="modal" v-if="pickerOpen" @click.self="pickerOpen=false">
          <div class="modal__panel">
            <div class="modal__head"><span>切换送达地址</span><button class="link-btn" @click="pickerOpen=false">关闭</button></div>
            <div class="addr-pick" v-for="a in addresses" :key="a.id" :class="{'addr-pick--on': (currentAddr && currentAddr.id===a.id)}" @click="store.selectAddress(a.id); pickerOpen=false">
              <div class="addr-pick__radio">{{ (currentAddr && currentAddr.id===a.id) ? '●' : '○' }}</div>
              <div class="addr-pick__body">
                <div class="addr-pick__top"><span class="addr-label">{{ a.label }}</span><span class="chip chip--ok sm" v-if="a.isDefault">默认</span></div>
                <div class="addr-pick__where">{{ a.building }} {{ a.room }}</div>
              </div>
            </div>
            <p class="muted sm center" style="margin-top:10px">在「我的 → 配送地址簿」可新增 / 编辑 / 改默认</p>
          </div>
        </div>
        <!-- 单地址 / 老入口：profile-form 编辑首条 -->
        <div class="modal" v-if="editingAddr" @click.self="editingAddr=false">
          <div class="modal__panel">
            <div class="modal__head"><span>修改送达资料</span><button class="link-btn" @click="editingAddr=false">关闭</button></div>
            <profile-form :buildings="merchant.settings.coverage" @done="editingAddr=false"></profile-form>
          </div>
        </div>
      </div>
    `,
    setup(props, { emit }) {
      const mode = computed(() => props.merchant.settings.deliveryMode);
      const screenshot = ref(''); const error = ref(''); const qrIndex = ref(0); const remark = ref(''); const editingAddr = ref(false);
      const allowSampleShot = window.APP_MODE === 'admin'; // 「示例图测试」旁路仅 admin 端(上帝视角)可用；真实客户端(index.html, APP_MODE='customer')永不显示，截图必须真实上传
      // 地址簿：currentAddr 跟随 ui.selectedAddrId / 默认地址；pickerOpen 控制切换器
      const addresses = computed(() => (store.profile && store.profile.addresses) || []);
      const currentAddr = computed(() => store.currentAddress());
      const pickerOpen = ref(false);
      const b = computed(() => store.feeBreakdown(props.merchant, props.subtotal));
      // 团团豆会员（PRO 专享）
      const customerPhone = computed(() => store.profile ? store.profile.phone : '');
      const membershipEnabled = computed(() => !!store.membershipOf(props.merchant));
      const membershipBalance = computed(() => store.membershipPoints(props.merchant, customerPhone.value));
      const membershipCanRedeem = computed(() => store.membershipCanRedeem(props.merchant, customerPhone.value));
      const membershipRedeemValue = computed(() => store.membershipRedeemValue(props.merchant));
      const membershipNeedPts = computed(() => store.membershipRedeemPts(props.merchant));
      const membershipPtsPerRM = computed(() => store.membershipPtsPerRM(props.merchant));
      const redeemMembership = ref(false);
      const membershipDiscount = computed(() => redeemMembership.value ? membershipRedeemValue.value : 0);
      const finalTotal = computed(() => Math.max(0, Math.round((b.value.total - membershipDiscount.value) * 100) / 100));
      // 下单截止判断（用本机时间）
      const nowMin = () => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); };
      const toMin = (hhmm) => { const p = String(hhmm || '').split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
      function slotOk(slot) { return nowMin() <= toMin(slot) - (Number(props.merchant.settings.cutoffMins) || 0); }
      const okSlots = computed(() => (props.merchant.settings.fixedSlots || []).filter(slotOk));
      const closed = computed(() => mode.value === 'fixed' ? okSlots.value.length === 0 : nowMin() > toMin(props.merchant.settings.flexCloseTime || '23:59'));
      const chosenSlot = ref(okSlots.value[0] || '');
      function onFile(e) { const f = e.target.files && e.target.files[0]; if (!f) return; store.utils.compressImage(f).then((d) => (screenshot.value = d)).catch(() => {}); e.target.value = ''; }
      function openTab(src) {
        // H7 fix: use proper DOM API to prevent XSS via QR URL
        var safeSrc = String(src || '');
        // Only allow https: and data:image schemes
        if (!/^(https:|data:image\/)/.test(safeSrc)) return;
        try { const w = window.open('', '_blank'); if (w) { var img = w.document.createElement('img'); img.src = safeSrc; img.style.cssText = 'max-width:100%'; w.document.title = '收款码'; w.document.body.style.cssText = 'margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh'; w.document.body.appendChild(img); w.document.close(); } else { window.open(safeSrc, '_blank'); } } catch (e) { window.open(safeSrc, '_blank'); } }
      // C4 fix: prevent double-submit with submitting guard
      const submitting = ref(false);
      function submit() {
        if (submitting.value) return;
        if (!props.lines.length) return (error.value = '购物车是空的');
        if (closed.value) return (error.value = '今日下单已截止');
        if (mode.value === 'fixed' && !slotOk(chosenSlot.value)) return (error.value = '请选择一个仍可下单的时间段');
        if (!screenshot.value) return (error.value = '请先上传支付成功截图才能提交');
        error.value = '';
        submitting.value = true;
        const dt = mode.value === 'fixed' ? chosenSlot.value : `预计 ${props.merchant.settings.flexibleMin}-${props.merchant.settings.flexibleMax} 分钟`;
        const items = props.lines.map((l) => ({ id: l.itemId, name: l.name + (l.optionText ? '（' + l.optionText + '）' : ''), price: l.unit, qty: l.qty, options: l.optionText }));
        // 乐观先行：本地立即建单、0 阻塞，秒提示成功并跳详情；同步/传图全在后台
        store.placeOrder({ merchantId: props.merchant.id, items: items, deliveryTime: dt, deliveryMode: mode.value, screenshot: screenshot.value, remark: remark.value, redeemMembership: redeemMembership.value });
        // H6 fix: show pending confirmation instead of premature success
        store.toastSuccess('📤 订单已提交，正在确认…');
        emit('submitted');
      }
      return { store, mode, chosenSlot, screenshot, error, qrIndex, b, remark, editingAddr, allowSampleShot, addresses, currentAddr, pickerOpen, slotOk, closed, onFile, openTab, submit, submitting, membershipEnabled, membershipBalance, membershipCanRedeem, membershipRedeemValue, membershipNeedPts, membershipPtsPerRM, redeemMembership, membershipDiscount, finalTotal };
    },
  };

  // ---------- 订单状态（带动效） ----------
  window.OrderStatus = {
    emits: ['neworder', 'back'],
    template: `
      <div class="status" v-if="order">
        <!-- UX#10: back arrow to "订单" list. Only meaningful once the order is in a terminal
             state (cancelled/rejected/delivered or sync-rejected). During active tracking
             we leave the page focused on the live status — no escape hatch needed because
             "再点一单" already exists for terminal cards. -->
        <button v-if="isTerminal" class="status__back" @click="$emit('back')" aria-label="返回订单列表">‹ 返回订单</button>
        <div class="status__order">{{ merchantName }} · 订单 {{ order.id }} · {{ order.createdAtText }}</div>

        <!-- 乐观下单：后端校验未通过（库存/截止/券）→ 整单未成，引导重下 -->
        <div class="card status-rejected" v-if="order.syncStatus==='rejected'">
          <div class="status-rejected__icon">❌</div><div class="status-rejected__title">下单未成功</div>
          <div class="status-rejected__reason">{{ order.syncError || '网络有点慢，请刷新页面再试' }}</div>
          <button class="btn btn--primary btn--pill" style="margin-top:14px" @click="$emit('neworder')">返回重新下单</button>
        </div>
        <template v-else>
        <!-- 乐观下单：syncing 静默（toast 已提示），仅 pending 异常态显示提示 -->
        <div class="sync-note sync-note--wait" v-if="order.syncStatus==='pending'">📶 网络有点慢，请刷新页面再试</div>

        <div class="card status-rejected" v-if="order.status === 'rejected'">
          <div class="status-rejected__icon">❌</div><div class="status-rejected__title">订单未通过</div>
          <div class="status-rejected__reason">{{ order.rejectReason }}</div><p class="muted sm">支付若已成功，请联系商家退款。</p>
        </div>

        <div class="card status-rejected" v-else-if="order.status === 'cancelled'">
          <div class="status-rejected__icon">🚫</div><div class="status-rejected__title">订单已取消</div>
          <p class="muted sm">你已取消这笔订单。</p>
        </div>

        <template v-else>
          <div class="status-hero" :class="'hero--' + order.status">
            <div class="status-anim" :class="'anim-' + order.status">{{ currentStep.icon }}</div>
            <div class="status-hero__label">{{ currentStep.label }}<span class="live-dots" v-if="order.status!=='delivered'"><i></i><i></i><i></i></span></div>
            <div class="status-hero__eta">配送时间：{{ order.deliveryTime }}</div>
          </div>
          <div class="timeline">
            <div class="timeline__step" :class="{ done: i<=ci, active: i===ci }" v-for="(s,i) in steps" :key="s.key">
              <div class="timeline__dot">{{ i<=ci ? '✓' : '' }}</div><div class="timeline__txt">{{ s.label }}</div>
            </div>
          </div>
          <div class="card delivered-card" v-if="order.status==='delivered' && order.deliveryPhoto">
            <div class="card__label">📸 您的餐已送达，请查收！</div><img class="delivery-photo" :src="order.deliveryPhoto" alt="" />
          </div>
          <div class="card" v-else-if="order.status==='delivered' && order.imagesPurgedAt" style="background:#f0f9ff">
            <div class="card__label" style="color:#0369a1">📄 订单已归档（30 天前完成，照片仅留 30 天，文字记录永久保留）</div>
          </div>
          <p class="muted center sm" v-else>📲 进度实时更新，送达会立刻显示在这里，请留意本页。</p>
        </template>

        <div class="card">
          <div class="card__label">🧾 订单内容</div>
          <div class="line" v-for="it in order.items" :key="it.id"><span>{{ it.name }} × {{ it.qty }}</span><span>{{ store.utils.rm(it.price*it.qty) }}</span></div>
          <div class="line" v-if="order.packagingFee>0"><span class="muted">打包费</span><span>{{ store.utils.rm(order.packagingFee) }}</span></div>
          <div class="line" v-if="order.deliveryFee>0"><span class="muted">配送费</span><span>{{ store.utils.rm(order.deliveryFee) }}</span></div>
          <div class="line line--total"><span>合计</span><span>{{ store.utils.rm(order.total) }}</span></div>
        </div>

        <!-- 两阶段下单：支付截图后台同步状态 -->
        <!-- uploading (0-30s)：正常态文案；slow (30-60s)：柔和"还在传"，避免吓到用户；failed (60s+/真错)：才提示补传 -->
        <div class="card img-sync img-sync--wait" v-if="order.imgStatus==='uploading'"><span class="spin spin--dark"></span> 支付截图上传中…（订单已发给商家，无需等待）</div>
        <div class="card img-sync img-sync--wait" v-else-if="order.imgStatus==='slow'"><span class="spin spin--dark"></span> 网络慢了点，截图还在传…（仍在后台尝试，不用关页面）</div>
        <div class="card img-sync img-sync--fail" v-else-if="order.imgStatus==='failed'">
          <div class="img-sync__t">⚠ 支付截图没传上</div>
          <p class="muted sm">网络有点慢，商家还没看到你的付款凭证，请补传。</p>
          <button class="btn btn--primary btn--pill img-sync__btn" @click="store.retryOrderShot(order.id)">一键补传截图</button>
        </div>

        <!-- 联系商家 WhatsApp（仅商家配置了 waNumber 时显示） -->
        <a class="btn btn--block btn--pill contact-wa" v-if="merchantWa" :href="merchantWa" target="_blank" rel="noopener">💬 WhatsApp 联系商家</a>

        <button class="btn btn--block btn--pill btn--danger" v-if="order.status === 'pending'" @click="cancel">取消订单</button>
        <button class="btn btn--block btn--pill btn--ghost" @click="$emit('neworder')">再点一单</button>
        </template>
      </div>
    `,
    setup() {
      const order = computed(() => store.activeOrder);
      const steps = STATUS_STEPS;
      const ci = computed(() => { if (!order.value) return 0; const i = steps.findIndex((s) => s.key === order.value.status); return i < 0 ? 0 : i; });
      const currentStep = computed(() => steps[ci.value]);
      const merchantName = computed(() => { const m = order.value && store.getMerchant(order.value.merchantId); return m ? m.name : ''; });
      function cancel() { if (order.value && window.confirm('确定取消这笔订单吗？')) store.cancelOrder(order.value.id); }
      // v4: 自适应轮询 + 隐藏暂停 + 终态停止 —— 省 GAS 配额
      //   后端 getOrder 按状态返 pollIntervalMs: pending 5s / cooking 15s / delivering 8s / 终态 0
      //   tab 隐藏（锁屏/切 app）立即暂停 setInterval；可见再追一次重启
      //   v3 之前只在 visible 时多 poll 一次但没在 hidden 时停 setInterval → 后台仍在烧 GAS
      let timer = null; let polling = false; let currentInterval = 12000; let stopped = false;
      async function poll() {
        const o = order.value; if (!o || polling || stopped || !(window.api && window.api.enabled())) return;
        if (document.visibilityState === 'hidden') return; // 后台不烧 GAS
        polling = true;
        try {
          const r = await window.api.getOrder(o.id);
          if (r && r.ok) {
            store.applyRemoteOrder(r.order);
            if (r.pollIntervalMs !== undefined) {
              if (r.pollIntervalMs === 0) {
                // 终态：彻底停轮询（stopped 防 visibilitychange 再启）
                stopped = true;
                if (timer) { clearInterval(timer); timer = null; }
                polling = false; return;
              }
              if (r.pollIntervalMs !== currentInterval) {
                currentInterval = r.pollIntervalMs;
                if (timer) clearInterval(timer);
                timer = setInterval(poll, currentInterval);
              }
            }
          }
        } catch (e) {} finally { polling = false; }
      }
      function onVisibilityChange() {
        if (stopped) return; // 终态后不重启
        if (document.visibilityState === 'visible') {
          // 切回前台：立即拉一次（避开手机浏览器对后台 setInterval 的节流），重启 interval
          poll();
          if (!timer) timer = setInterval(poll, currentInterval);
        } else {
          // 切走：停 setInterval（in-flight 让它自然返回）
          if (timer) { clearInterval(timer); timer = null; }
        }
      }
      onMounted(() => {
        if (window.api && window.api.enabled()) {
          var o = order.value;
          if (o && ['delivered', 'rejected', 'cancelled'].indexOf(o.status) >= 0) { stopped = true; return; }
          poll();
          timer = setInterval(poll, currentInterval);
          document.addEventListener('visibilitychange', onVisibilityChange);
        }
      });
      onUnmounted(() => {
        if (timer) { clearInterval(timer); timer = null; }
        document.removeEventListener('visibilitychange', onVisibilityChange);
      });
      // WhatsApp 商家：仅商家在设置里填了 waNumber 才出现 wa.me 按钮
      // 状态相关的文案：客户主动找商家时常见原因
      const merchantWa = computed(() => {
        var o = order.value; if (!o) return '';
        var m = store.getMerchant(o.merchantId);
        var raw = m && m.settings && m.settings.waNumber;
        if (!raw) return '';
        var d = String(raw).replace(/\D/g, '');
        if (!d) return '';
        if (d.charAt(0) === '0') d = '60' + d.slice(1);
        else if (d.slice(0, 2) !== '60' && d.length <= 10) d = '60' + d;
        var shop = m.name || '商家';
        var head;
        switch (o.status) {
          case 'pending':   head = '想问下订单 ' + o.id + ' 现在处理到哪一步了'; break;
          case 'cooking':   head = '请问订单 ' + o.id + ' 大概什么时候出餐'; break;
          case 'delivering':head = '请问订单 ' + o.id + ' 配送到哪了'; break;
          case 'delivered': head = '订单 ' + o.id + ' 想反馈一下'; break;
          case 'rejected':  head = '订单 ' + o.id + ' 被拒了，想问下原因'; break;
          default:          head = '订单 ' + o.id + ' 想咨询';
        }
        var text = '【' + shop + '】您好，' + head + '。';
        return 'https://wa.me/' + d + '?text=' + encodeURIComponent(text);
      });
      // UX#10: terminal = nothing more will happen to this order — safe to leave.
      const isTerminal = computed(() => {
        const o = order.value; if (!o) return false;
        if (o.syncStatus === 'rejected') return true;
        return o.status === 'cancelled' || o.status === 'rejected' || o.status === 'delivered';
      });
      return { store, order, steps, ci, currentStep, merchantName, cancel, merchantWa, isTerminal };
    },
  };
})();
