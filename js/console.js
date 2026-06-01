/*
 * console.js —— 入口外壳与登录
 *  StudentShell  : 学生端外壳（免登录），底部有去后台的入口
 *  ConsoleShell  : 后台外壳，未登录→登录页；登录后→admin 或 商家端；预览模式→学生视图
 *  LoginView     : 商家/管理员登录
 */
(function () {
  const { ref, reactive, computed } = Vue;
  const store = window.store;

  // ---------- 学生端外壳 ----------
  window.StudentShell = {
    template: `
      <div class="app-frame">
        <header class="appbar" role="banner">
          <div class="appbar__brand">🛵 {{ brand }}</div>
        </header>
        <student-app></student-app>
        <sync-bar></sync-bar>
        <toast-bar></toast-bar>
      </div>
    `,
    setup() {
      const brand = '团团';
      return { brand };
    },
  };

  // 同步失败提示条（云端写入失败时可见 + 重试）
  window.SyncBar = {
    template: `
      <div class="sync-bar" v-if="store.syncError && store.failedSyncs.length">
        <span>⚠ 网络有点慢，{{ store.failedSyncs.length }} 项未发送成功</span>
        <button @click="store.retrySync()" :disabled="store.syncBusy">{{ store.syncBusy ? '重试中…' : '点此重试' }}</button>
      </div>
    `,
    setup() { return { store }; },
  };

  // ---------- 商家端外壳（独立入口 merchant.html）----------
  // 只认 role==='merchant' 的登录态；admin 登录态在此视为未登录（同源共享 auth，按角色隔离）
  window.MerchantShell = {
    template: `
      <div class="app-frame">
        <student-app v-if="store.ui.preview"></student-app>
        <login-view v-else-if="!user"></login-view>
        <template v-else>
          <header class="appbar appbar--console" role="banner">
            <div>
              <div class="appbar__brand">{{ store.merchant ? store.merchant.logo + ' ' + store.merchant.name : '商家后台' }}</div>
              <div class="appbar__who">商家 · {{ user.username }}</div>
            </div>
            <button class="ghost-btn" @click="store.logout()">退出</button>
          </header>
          <merchant-app></merchant-app>
        </template>
        <sync-bar></sync-bar>
        <toast-bar></toast-bar>
        <div class="undo-bar" v-if="store.pendingUndo">
          <span>{{ store.pendingUndo.label }}</span>
          <span class="undo-bar__actions"><button class="undo-bar__do" @click="store.doUndo()">撤销</button><button class="undo-bar__x" @click="store.clearUndo()" aria-label="关闭">✕</button></span>
        </div>
      </div>
    `,
    setup() {
      const user = computed(() => (store.auth.user && store.auth.user.role === 'merchant') ? store.auth.user : null);
      return { store, user };
    },
  };

  // ---------- 内部管理端外壳（独立入口 admin.html，不对外链接）----------
  // 内部专用「上帝视角」：同一套(测试)数据上一键切换 管理 / 商家 / 客户 三端视图
  window.AdminShell = {
    template: `
      <div class="app-frame">
        <login-view v-if="!user"></login-view>
        <template v-else>
          <header class="appbar appbar--console" role="banner">
            <div>
              <div class="appbar__brand">🛠️ 平台后台</div>
              <div class="appbar__who">内部管理员 · {{ user.username }}</div>
            </div>
            <button class="ghost-btn" @click="store.logout()">退出</button>
          </header>
          <!-- 视角切换（仅内部）：在同一套数据上看三端 -->
          <div class="role-switch">
            <span class="role-switch__lbl">👁 视角</span>
            <button :class="{on: view==='admin'}" @click="setView('admin')">🛠 管理</button>
            <button :class="{on: view==='merchant'}" @click="setView('merchant')">🏪 商家</button>
            <button :class="{on: view==='customer'}" @click="setView('customer')">🛒 客户</button>
            <select v-if="view==='merchant'" class="role-switch__sel" v-model="shop" @change="pickShop">
              <option v-for="m in store.state.merchants" :key="m.id" :value="m.id">{{ m.name }}（{{ store.planStatus(m).label }}）</option>
            </select>
          </div>
          <admin-app v-if="view==='admin'"></admin-app>
          <merchant-app v-else-if="view==='merchant'"></merchant-app>
          <student-app v-else></student-app>
        </template>
        <sync-bar></sync-bar>
        <toast-bar></toast-bar>
        <div class="undo-bar" v-if="store.pendingUndo">
          <span>{{ store.pendingUndo.label }}</span>
          <span class="undo-bar__actions"><button class="undo-bar__do" @click="store.doUndo()">撤销</button><button class="undo-bar__x" @click="store.clearUndo()" aria-label="关闭">✕</button></span>
        </div>
      </div>
    `,
    setup() {
      const user = computed(() => (store.auth.user && store.auth.user.role === 'admin') ? store.auth.user : null);
      const view = ref('admin');
      const shop = ref((store.state.merchants[0] && store.state.merchants[0].id) || '');
      function pickShop() { store.ui.merchantId = shop.value; if (window.api && window.api.enabled()) store.loadMerchantData(shop.value); }
      function setView(v) {
        view.value = v;
        if (v === 'merchant') { if (!shop.value) shop.value = (store.state.merchants[0] && store.state.merchants[0].id) || ''; pickShop(); store.ui.preview = false; }
        else if (v === 'customer') { store.previewStorefront(); /* ui.preview=true + 商家列表 */ }
        else { store.ui.preview = false; }
      }
      return { store, user, view, shop, setView, pickShop };
    },
  };

  // ---------- Toast 通知条 ----------
  window.ToastBar = {
    template: `
      <div class="toast-bar" :class="'toast--' + store.toast.type" v-if="store.toast.visible" role="alert" aria-live="assertive">
        <span class="toast-bar__ico">{{ store.toast.type === 'error' ? '⚠️' : store.toast.type === 'success' ? '✅' : 'ℹ️' }}</span>
        <span>{{ store.toast.message }}</span>
      </div>
    `,
    setup() { return { store }; },
  };

  // ---------- 登录（按入口模式区分商家/管理员）----------
  window.LoginView = {
    template: `
      <div class="login">
        <div class="login__card">
          <div class="login__logo">{{ mode === 'admin' ? '🛠️' : '🛵' }}</div>
          <h1 class="login__title">{{ mode === 'admin' ? '内部管理后台' : '商家登录' }}</h1>
          <p class="login__sub">{{ mode === 'admin' ? '内部人员专用' : '商家入口 · 客户下单无需登录' }}</p>
          <!-- admin 端：直接表单登录（用 PropertiesService 里设置的 ADMIN_USER/ADMIN_PASS） -->
          <template v-if="mode === 'admin'">
            <label class="field"><span>账号</span><input v-model="username" placeholder="管理员账号" @keyup.enter="submit" /></label>
            <label class="field"><span>密码</span>
              <span class="pw-wrap">
                <input v-model="password" :type="showPw ? 'text' : 'password'" placeholder="请输入密码" @keyup.enter="submit" />
                <button type="button" class="pw-eye" @click="showPw = !showPw" :aria-label="showPw ? '隐藏密码' : '显示密码'">{{ showPw ? '🙈' : '👁' }}</button>
              </span>
            </label>
            <button class="btn btn--primary btn--block" :disabled="busy" @click="submit"><span class="spin" v-if="busy"></span>{{ busy ? '登录中…' : '登录' }}</button>
          </template>
          <template v-else>
            <label class="field"><span>账号</span><input v-model="username" placeholder="商家账号" @keyup.enter="submit" /></label>
            <label class="field"><span>密码</span>
              <span class="pw-wrap">
                <input v-model="password" :type="showPw ? 'text' : 'password'" placeholder="请输入密码" @keyup.enter="submit" />
                <button type="button" class="pw-eye" @click="showPw = !showPw" :aria-label="showPw ? '隐藏密码' : '显示密码'">{{ showPw ? '🙈' : '👁' }}</button>
              </span>
            </label>
            <button class="btn btn--primary btn--block" :disabled="busy" @click="submit"><span class="spin" v-if="busy"></span>{{ busy ? '登录中…' : '登录' }}</button>
            <a class="login__forgot" :href="forgotUrl" target="_blank" rel="noopener">🔑 忘记密码？联系平台</a>
          </template>
          <p class="error" v-if="error">{{ error }}</p>
          <!-- 演示账号：仅本地演示模式显示，接真实后端后自动隐藏 -->
          <div class="login__demo" v-if="showDemo && mode !== 'admin'">
            <div class="login__demo-title">演示账号（本地模式）</div>
            <button class="login__demo-row" @click="fill('shop1','1234')">商家：shop1 / 1234</button>
          </div>
        </div>
      </div>
    `,
    setup() {
      const mode = (window.APP_MODE === 'admin') ? 'admin' : 'merchant';
      const username = ref(''); const password = ref(''); const error = ref(''); const busy = ref(false);
      const showPw = ref(false);
      const showDemo = computed(() => !(window.api && window.api.enabled()));
      // 忘记密码 → 跳 wa.me，预填模板让用户连商家账号一起发
      const forgotUrl = computed(function () {
        var msg = '【团团 · 忘记密码】我的商家账号是：' + (username.value || '') + '，请帮我重置密码，谢谢！';
        return 'https://wa.me/60132831238?text=' + encodeURIComponent(msg);
      });
      async function submit() {
        error.value = '';
        const u = username.value.trim();
        if (window.api && window.api.enabled()) {
          busy.value = true;
          try {
            if (mode === 'admin') {
              const a = await window.api.adminLogin(u, password.value);
              if (a && a.ok) { store.setAuthUser({ username: u, role: 'admin', merchantId: null }, a.token); return; }
              // 后端明确拒绝（返回 ok:false）→ 不本地兜底，避免「假登入」状态
              error.value = (a && a.error) || '账号或密码错误';
              return;
            }
            const r = await window.api.vendorLogin(u, password.value);
            if (r && r.ok) {
              store.hydrateVendor(r.vendor); // 仅配置，菜单/订单懒加载
              store.setAuthUser({ username: u, role: 'merchant', merchantId: r.vendor.vendorId }, r.token);
              store.loadMerchantData(r.vendor.vendorId); // 后台并行加载，不阻塞登录
              return;
            }
            // 后端明确拒绝 → 不本地兜底
            error.value = (r && r.error) || '账号或密码错误';
          } catch (e) {
            // 仅网络异常（fetch throw）才考虑本地兜底（?demo 用）
            if (store.login(u, password.value) && store.auth.user.role === mode) return;
            error.value = mode === 'admin' ? ('无法连接后端：' + e) : '网络有点慢，请刷新页面再试';
          } finally { busy.value = false; }
          return;
        }
        // 纯本地演示：校验角色与入口一致
        if (store.login(u, password.value) && store.auth.user && store.auth.user.role === mode) return;
        store.logout();
        error.value = mode === 'admin' ? '管理员账号或密码错误' : '商家账号或密码错误';
      }
      function fill(u, p) { username.value = u; password.value = p; }
      return { mode, username, password, error, busy, showDemo, showPw, forgotUrl, submit, fill };
    },
  };
})();
