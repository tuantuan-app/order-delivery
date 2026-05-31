/*
 * main.js —— 三端独立入口的统一挂载器
 *   每个 HTML 先设 window.APP_MODE = 'customer' | 'merchant' | 'admin'，再加载本文件。
 *   按模式挂载对应根外壳；只注册「已加载到 window 上」的组件（各 HTML 只引各自需要的脚本）。
 */
(function () {
  const { createApp } = Vue;
  const store = window.store;
  const mode = window.APP_MODE || 'customer';

  // 微信内置浏览器 / iOS：输入框失焦(键盘收起)且未聚焦到另一输入框时复位，避免点普通按钮也跳顶
  window.addEventListener('focusout', function (e) {
    var t = e.target;
    if (!t || !/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
    setTimeout(function () {
      var a = document.activeElement;
      if (a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      window.scrollTo(0, 0);
    }, 80);
  }, true);

  // 预热后端实例（GAS 冷启动慢）
  if (window.api && window.api.enabled()) { try { fetch(window.api.base()).catch(function () {}); } catch (e) {} }

  var rootTemplate = mode === 'merchant' ? '<merchant-shell></merchant-shell>'
    : mode === 'admin' ? '<admin-shell></admin-shell>'
    : '<student-shell></student-shell>';

  const app = createApp({ template: rootTemplate });

  // 只注册存在的组件（未加载的脚本 → window.X 为 undefined → 跳过）
  function reg(name, comp) { if (comp) app.component(name, comp); }

  // 外壳 / 公共
  reg('student-shell', window.StudentShell);
  reg('merchant-shell', window.MerchantShell);
  reg('admin-shell', window.AdminShell);
  reg('login-view', window.LoginView);
  reg('sync-bar', window.SyncBar);
  reg('toast-bar', window.ToastBar);
  reg('contact-panel', window.ContactPanel);

  // 客户端
  reg('student-app', window.StudentApp);
  reg('merchant-list', window.MerchantList);
  reg('profile-form', window.ProfileForm);
  reg('menu-list', window.MenuList);
  reg('option-sheet', window.OptionSheet);
  reg('checkout-view', window.CheckoutView);
  reg('order-status', window.OrderStatus);
  reg('customer-orders', window.CustomerOrders);
  reg('customer-profile', window.CustomerProfile);

  // 商家端
  reg('merchant-app', window.MerchantApp);
  reg('m-orders', window.MOrders);
  reg('m-menu', window.MMenu);
  reg('m-settings', window.MSettings);
  reg('m-membership', window.MMembership);
  reg('m-crm', window.MCrm);
  reg('upgrade-prompt', window.UpgradePrompt);

  // 内部管理端
  reg('admin-app', window.AdminApp);
  reg('admin-dashboard', window.AdminDashboard);
  reg('admin-merchants', window.AdminMerchants);
  reg('admin-billing', window.AdminBilling);
  reg('admin-orders', window.AdminOrders);
  reg('admin-hubs', window.AdminHubs);
  reg('admin-test', window.AdminTest);

  app.mount('#app');
})();
