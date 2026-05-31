/*
 * config.example.js —— 运行配置模板
 * 复制为 config.js 并把 apiBase 换成你自己的 GAS /exec 网址：
 *   cp js/config.example.js js/config.js
 *
 * apiBase 留空 = 纯本地演示（数据存 LocalStorage）；填 /exec 网址 = 连真实后端。
 * URL 带 ?demo = 强制本地演示（不连后端），方便无网演示/测试。
 */
(function () {
  var demo = /[?&]demo\b/.test(location.search);
  window.APP_CONFIG = {
    apiBase: demo ? '' : 'https://script.google.com/macros/s/你的部署ID/exec',
  };
})();
