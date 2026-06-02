// 测试库活性检查：纯 ping，不含任何凭据；任何人都可跑
// 用途：每次本地起 server / 改后端推送后，确认 /exec URL 还活着
const TEST_API = 'https://script.google.com/macros/s/AKfycbwcpGelUCoaBf0fK01ZHEfzZCMeyfaYD6Gmu7er1iARzIDU_oTxqERWGAvXeWJtlyKkIA/exec';

(async () => {
  const t0 = Date.now();
  try {
    const r = await fetch(TEST_API, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action: 'listHubs' }),
    });
    const ms = Date.now() - t0;
    const text = await r.text();
    console.log('HTTP', r.status, '·', ms, 'ms');
    console.log('body:', text.slice(0, 300));
    if (r.status !== 200) {
      console.log('\n⛔ /exec 异常。检查：');
      console.log('  1. Apps Script 编辑器是否运行过任何函数（触发 OAuth 授权）');
      console.log('  2. 部署是否选 "Anyone Anonymous"');
      console.log('  3. config.js 的 TEST_API 是不是最新 deploy 的 URL');
      process.exit(1);
    }
    console.log('\n✅ 测试库就绪。');
    console.log('  Admin: http://localhost:8777/admin.html?test');
    console.log('  商家:  http://localhost:8777/merchant.html?test');
    console.log('  客户:  http://localhost:8777/index.html?test');
  } catch (e) {
    console.log('ERROR:', e.message);
    process.exit(1);
  }
})();
