/*
 * admin-test.js —— 内部测试工具（仅 admin.html 加载，挂到 admin「🧪测试」tab）
 * 造的数据都打 isTest 标记；「清除测试数据」只删标记行（本地 + 后端 Google Sheet），不碰真实数据。
 */
(function () {
  const { ref, reactive, onMounted } = Vue;
  const store = window.store;

  window.AdminTest = {
    template: `
      <div class="admin-test">
        <div class="dash__title"><h2 style="font-size:inherit;margin:0">🧪 测试工具</h2><span class="muted sm">内部专用</span></div>
        <p class="test-banner">所有造出来的数据都带 <b>TEST</b> 标记。{{ online ? '当前连接真实后端（Google Sheet），造的单会进表，可一键删除。' : '当前为本地模式，仅改浏览器数据。' }}</p>

        <!-- 测试导览：告诉 admin 哪个 demo 商家测什么 -->
        <div class="card" style="background:#f0fdf4;border:1px solid #bbf7d0">
          <div class="card__label">🗺️ 测试导览 <span class="muted sm">不知道从哪开始？看这里</span></div>
          <p class="sm" style="margin:8px 0;line-height:1.7">
            <b>顶部「👁 视角」是核心</b>：在<b>同一套数据上</b>切换 🛠管理 / 🏪商家 / 🛒客户 三端，不用退出登录、不用开多窗口。
          </p>
          <div class="test-line"><span>🏪 测<b>专业版商家</b>（含会员/CRM/优惠券）</span><b>视角 → 商家 → 选 shop1（阿强快餐）</b></div>
          <div class="test-line"><span>🏪 测<b>基础版商家</b>（无 PRO 功能）</span><b>视角 → 商家 → 选 shop2 / shop4</b></div>
          <div class="test-line"><span>🏪 测<b>过期 PRO + 停业</b></span><b>视角 → 商家 → 选 shop3</b></div>
          <div class="test-line"><span>🛒 测<b>客户视角</b>（浏览/下单/追踪）</span><b>视角 → 客户</b></div>
          <div class="test-line"><span>📱 测<b>商家手机端响铃</b></span><b>视角 → 商家 → 设置 → 试听</b></div>
          <p class="sm muted" style="margin-top:10px">
            💡 完成 demo 测试后，<b>下方点「清除测试数据」</b>可一键扫平 4 demo 商家 + 14 demo 商品 + 所有 TEST 标记订单，留下空白等真实商家入驻。
          </p>
        </div>

        <!-- 健康检查 -->
        <div class="card">
          <div class="card__label">🩺 后端健康检查</div>
          <button class="btn btn--ghost btn--block" @click="runHealth" :disabled="hb">{{ hb ? '检测中…' : '检测后端连通 / Schema / 数据量' }}</button>
          <div class="test-out" v-if="health">
            <div class="test-line"><span>连接</span><b :class="health.ok ? 'ok' : 'bad'">{{ health.online ? (health.ok ? '在线 ✓' : '失败 ✕') : '本地模式' }}</b></div>
            <div class="test-line" v-if="health.online"><span>响应耗时</span><b>{{ health.ms }} ms</b></div>
            <div class="test-line" v-if="health.schema"><span>Schema</span><b>{{ health.schema }}</b></div>
            <div class="test-line" v-if="health.counts"><span>数据量</span><b>商家 {{ health.counts.vendors }} · 订单 {{ health.counts.orders }} · 收款 {{ health.counts.payments }}</b></div>
            <div class="test-line" v-if="health.counts && health.counts.testOrders != null"><span>其中测试单</span><b>{{ health.counts.testOrders }}</b></div>
            <div class="test-line" v-if="health.error"><span>错误</span><b class="bad">{{ health.error }}</b></div>
          </div>
        </div>

        <!-- Worker Cron 健康检查（手动触发版，绕过 1h 等候） -->
        <div class="card">
          <div class="card__label">🤖 Worker 健康检查 <span class="muted sm">每小时 Cron 自动跑；按钮立即测一次</span></div>
          <button class="btn btn--ghost btn--block" @click="runCheck" :disabled="cck">{{ cck ? '检查中…' : '立即跑一次健康检查' }}</button>
          <div class="test-out" v-if="check">
            <div class="test-line"><span>Worker → GAS</span><b :class="check.gasReachable ? 'ok' : 'bad'">{{ check.gasReachable ? '通 ✓' : '失败 ✕' }}</b></div>
            <div class="test-line" v-if="check.ms"><span>响应耗时</span><b :class="check.slow ? 'bad' : ''">{{ check.ms }} ms{{ check.slow ? ' (慢)' : '' }}</b></div>
            <div class="test-line" v-if="check.summary && check.summary.quotaPct != null"><span>GAS 配额</span><b :class="check.summary.quotaPct > 70 ? 'bad' : ''">{{ check.summary.quotaPct }}%</b></div>
            <div class="test-line" v-if="check.summary && check.summary.subscriptions != null"><span>订阅数</span><b>{{ check.summary.subscriptions }}</b></div>
            <div class="test-line" v-if="check.issues && check.issues.length"><span style="color:#b91c1c">⚠ 异常</span><b class="bad">{{ check.issues.length }} 项</b></div>
            <div v-if="check.issues && check.issues.length" style="margin-top:6px;padding:8px;background:#fef2f2;border-radius:6px">
              <div v-for="(iss, i) in check.issues" :key="i" class="sm" style="color:#991b1b">• {{ iss }}</div>
            </div>
            <div class="test-line" v-if="!check.issues || !check.issues.length"><span>状态</span><b class="ok">一切正常 ✓</b></div>
          </div>
          <p class="muted sm" style="margin-top:6px">异常会自动 Web Push 到所有 admin 订阅的设备（小时桶去重防轰炸）。先在本页同意通知，才会收到告警。</p>
        </div>

        <!-- 系统配额监控（GAS 日运行时长 / 调用分布 / Sheet 体量） -->
        <div class="card">
          <div class="card__label">📊 系统配额监控（GAS / Sheet）</div>
          <button class="btn btn--ghost btn--block" @click="loadUsage" :disabled="ub">{{ ub ? '加载中…' : '查看近 7 天用量' }}</button>
          <div class="test-out" v-if="usage">
            <div class="test-line"><span>今日调用</span><b>{{ usage.today.calls }} 次</b></div>
            <div class="test-line"><span>今日运行</span><b>{{ (usage.today.ms/1000).toFixed(1) }} 秒 · 占免费 90 分钟 {{ usage.today.pct }}%</b></div>
            <div class="test-line" v-if="usage.today.pct > 70"><span style="color:#b91c1c">⚠ 提醒</span><b class="bad">接近免费配额，考虑按状态分级或加 Workers 缓存</b></div>
            <div class="test-line" v-if="usage.topActions.length"><span>TOP 接口</span><b>{{ usage.topActions.slice(0,3).map(a => a.action+' ('+a.n+')').join(' · ') }}</b></div>
            <div class="test-line"><span>Sheet 行数</span><b>订单 {{ usage.sheets.orders }} · 商家 {{ usage.sheets.vendors }} · 收款 {{ usage.sheets.payments }}</b></div>
            <div class="test-line"><span>Cell 占用</span><b>{{ (usage.sheets.totalCells/1000).toFixed(0) }}K / 10M ({{ (usage.sheets.totalCells/100000).toFixed(2) }}%)</b></div>
            <div class="usage-week">
              <div class="usage-week__h">近 7 天调用</div>
              <div class="usage-bars">
                <div class="usage-bar" v-for="d in usage.days" :key="d.date" :title="d.date+': '+d.calls+' calls / '+(d.ms/1000).toFixed(0)+'s'">
                  <div class="usage-bar__fill" :style="{ height: Math.min(100, (d.calls/usage.maxCalls)*100) + '%' }"></div>
                  <div class="usage-bar__lbl">{{ d.date.slice(6) }}</div>
                </div>
              </div>
            </div>
          </div>
          <p class="muted sm" style="margin-top:8px">免费 90 分钟/天；超 70% 就该规划缓存。详见 commit message。</p>
        </div>

        <!-- 造订单 -->
        <div class="card">
          <div class="card__label">🧾 一键造测试订单</div>
          <div class="field-row">
            <label class="field"><span>数量</span><input type="number" v-model.number="n" min="1" max="50" /></label>
            <button class="btn btn--primary" style="align-self:end;flex:1" @click="makeOrders">生成 {{ n }} 张待处理单</button>
          </div>
          <p class="muted sm">为 shop1 造若干「待处理」订单（不同客户/楼栋），用于看商家端、客户端、统计的表现。</p>
        </div>

        <!-- 全流程 -->
        <div class="card">
          <div class="card__label">▶️ 一键跑通全流程</div>
          <button class="btn btn--primary btn--block" @click="flow">造 1 单并自动推进 待验证→备餐→配送→送达</button>
          <p class="muted sm">约 4 秒内自动走完整条状态链，演示端到端。</p>
        </div>

        <!-- 全状态全角色 -->
        <div class="card">
          <div class="card__label">🎭 模拟所有状态</div>
          <button class="btn btn--primary btn--block" @click="simAll">为每种状态各造一单（待验证/备餐/配送/送达/拒绝/取消）</button>
          <p class="muted sm">一次铺满 6 种状态，覆盖商家端各分类标签与客户端各种订单卡。</p>
        </div>

        <!-- 重置种子数据 -->
        <div class="card test-danger">
          <div class="card__label">🔄 重置全部数据（重新播种）</div>
          <button class="btn btn--danger btn--block" @click="resetSeed" :disabled="rb">{{ rb ? '重置中…' : '清空所有 Sheet 数据，重新播种完整测试数据集' }}</button>
          <p class="muted sm">⚠️ 删除 Google Sheet 中全部数据（Vendors / Orders / Menu / Hubs / Logs / Payments），然后重新写入 4 商家 + 14 商品 + 4 券 + 含楼栋的 Hub。</p>
        </div>

        <!-- 清除 -->
        <div class="card test-danger">
          <div class="card__label">🧹 清除测试数据 <span class="muted sm">含 4 个 demo 商家 + 14 demo 商品 + 所有 TEST 标记订单</span></div>
          <div class="test-line"><span>当前本地测试单</span><b>{{ cnt.orders }}</b></div>
          <div class="test-line"><span>当前本地测试收款</span><b>{{ cnt.payments }}</b></div>
          <button class="btn btn--danger btn--block" @click="clear" :disabled="cb">{{ cb ? '清除中…' : '清除全部测试数据（本地' + (online ? ' + Google Sheet' : '') + '）' }}</button>
          <p class="muted sm">点一下扫平所有带 TEST 标的数据（demo 商家 + demo 商品 + 测试订单）。真实商家/订单/收款不受影响。<br>⚠ <b>首次部署后请先点这个</b>清掉 demo 数据，再开始添加真实商家。</p>
        </div>
      </div>
    `,
    setup() {
      const online = !!(window.api && window.api.enabled());
      const n = ref(5);
      const hb = ref(false); const cb = ref(false); const rb = ref(false);
      const health = ref(null);
      const cnt = reactive({ orders: 0, payments: 0 });
      // 系统配额监控
      const ub = ref(false); const usage = ref(null);
      // Worker 健康检查（手动触发）
      const cck = ref(false); const check = ref(null);
      async function runCheck() {
        var workerUrl = (window.APP_CONFIG && window.APP_CONFIG.pushWorkerUrl) || '';
        if (!workerUrl) { store.toastError('未配置 pushWorkerUrl（js/config.js）'); return; }
        cck.value = true;
        try {
          var res = await fetch(workerUrl + '/check', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
          var r = await res.json();
          check.value = r;
          if (!r.ok && !r.gasReachable) store.toastError('Worker → GAS 不可达');
          else if (r.issues && r.issues.length) store.toastError('发现 ' + r.issues.length + ' 项异常');
          else store.toastSuccess('一切正常 ✓');
        } catch (e) { store.toastError('调用 Worker 失败：' + (e.message || e)); }
        finally { cck.value = false; }
      }
      async function loadUsage() {
        if (!online) return;
        ub.value = true;
        try {
          var r = await window.api.getSystemUsage(store.auth.token);
          if (!r || !r.ok) { store.toastError(r && r.error || '加载失败（后端需先部署最新 Code.gs）'); return; }
          var today = r.days[r.days.length - 1] || { calls: 0, ms: 0, byAction: {} };
          var pct = Math.round((today.ms / 60000) / 90 * 100); // 占免费 90 min 百分比
          var byAction = today.byAction || {};
          var topActions = Object.keys(byAction).map(function (k) { return { action: k, n: byAction[k] }; })
            .sort(function (a, b) { return b.n - a.n; });
          var maxCalls = Math.max.apply(Math, r.days.map(function (d) { return d.calls; }).concat([1]));
          usage.value = { today: { calls: today.calls, ms: today.ms, pct: pct }, topActions: topActions, sheets: r.sheets, days: r.days, maxCalls: maxCalls };
        } catch (e) { store.toastError('加载失败：' + (e.message || e)); } finally { ub.value = false; }
      }
      function refreshCnt() { var c = store.testDataCount(); cnt.orders = c.orders; cnt.payments = c.payments; }
      async function runHealth() { hb.value = true; try { health.value = await store.healthCheck(); } finally { hb.value = false; } }
      function makeOrders() { var m = store.genTestOrders(n.value); store.toastSuccess('已生成 ' + m + ' 张测试订单'); refreshCnt(); }
      function flow() { var id = store.runTestFlow(); store.toastSuccess(id ? '已开始全流程演示（约 4 秒）' : '没有可用商家'); refreshCnt(); }
      function simAll() { var k = store.simulateAllStates(); store.toastSuccess('已造 ' + k + ' 单覆盖全部状态'); refreshCnt(); }
      async function clear() {
        if (!window.confirm('确认清除全部带 TEST 标记的测试数据？真实数据不受影响。')) return;
        cb.value = true;
        try { var r = await store.clearTestData(); var rm = r && r.removed; store.toastSuccess('已清除测试数据' + (rm ? '（订单 ' + rm.orders + '）' : '')); refreshCnt(); }
        finally { cb.value = false; }
      }
      async function resetSeed() {
        if (!window.confirm('⚠️ 确认清空所有 Sheet 数据并重新播种？此操作不可撤销！')) return;
        rb.value = true;
        try { var r = await store.resetSeedData(); store.toastSuccess(r && r.message ? r.message : '已重置'); refreshCnt(); }
        finally { rb.value = false; }
      }
      onMounted(refreshCnt);
      return { online, n, hb, cb, rb, health, cnt, ub, usage, cck, check, loadUsage, runHealth, runCheck, makeOrders, flow, simAll, clear, resetSeed };
    },
  };
})();
