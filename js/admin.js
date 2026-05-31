/*
 * admin.js —— 平台管理员端
 *  商家管理：注册新商家（建店 + 发放登录账号）/ 编辑 / 开关 / 删除 / 查看登录凭据
 *  订单总览：跨所有商家的全部订单（只读监控）+ 统计
 */
(function () {
  const { computed, ref, reactive, onMounted } = Vue;
  const store = window.store;

  const STATUS_TEXT = {
    pending: { label: '等待验证', cls: 'st-pending' }, cooking: { label: '备餐中', cls: 'st-cooking' },
    delivering: { label: '配送中', cls: 'st-delivering' }, delivered: { label: '已送达', cls: 'st-delivered' },
    rejected: { label: '已拒绝', cls: 'st-rejected' },
  };

  window.AdminApp = {
    template: `
      <div class="admin">
        <div class="m-body">
          <admin-dashboard v-if="tab==='dash'"></admin-dashboard>
          <admin-merchants v-else-if="tab==='shops'"></admin-merchants>
          <admin-billing v-else-if="tab==='billing'"></admin-billing>
          <admin-test v-else-if="tab==='test'"></admin-test>
          <admin-hubs v-else></admin-hubs>
        </div>
        <nav class="tabbar" role="navigation" aria-label="管理员功能">
          <button :class="{active: tab==='dash'}" @click="tab='dash'"><span class="tabbar__ico">📈</span><span>经营</span></button>
          <button :class="{active: tab==='shops'}" @click="tab='shops'"><span class="tabbar__ico">🏪</span><span>商家</span></button>
          <button :class="{active: tab==='billing'}" @click="tab='billing'"><span class="tabbar__ico">💳</span><span>计费</span></button>
          <button :class="{active: tab==='hubs'}" @click="tab='hubs'"><span class="tabbar__ico">📍</span><span>社区</span></button>
          <button v-if="hasTest" :class="{active: tab==='test'}" @click="tab='test'"><span class="tabbar__ico">🧪</span><span>测试</span></button>
        </nav>
      </div>
    `,
    setup() { const tab = ref('dash'); const hasTest = !!window.AdminTest; return { tab, hasTest }; },
  };

  // ---------- 经营数据看板（CEO/CTO 视角，不堆订单明细） ----------
  window.AdminDashboard = {
    template: `
      <div class="dash">
        <div class="dash__title"><h2 style="font-size:inherit;margin:0">经营概览</h2> <button class="link-btn" @click="refresh" :disabled="loading">{{ loading ? '加载中…' : '刷新' }}</button></div>

        <!-- 核心指标 -->
        <div class="kpi-grid">
          <div class="kpi kpi--hero"><div class="kpi__num">{{ store.utils.rm(k.revenue) }}</div><div class="kpi__label">已完成营收</div></div>
          <div class="kpi"><div class="kpi__num">{{ k.today }}</div><div class="kpi__label">今日订单</div></div>
          <div class="kpi"><div class="kpi__num">{{ k.total }}</div><div class="kpi__label">累计订单</div></div>
          <div class="kpi"><div class="kpi__num">{{ store.utils.rm(k.aov) }}</div><div class="kpi__label">客单价</div></div>
          <div class="kpi"><div class="kpi__num" :class="{ 'kpi__num--warn': k.pending>0 }">{{ k.pending }}</div><div class="kpi__label">待处理</div></div>
          <div class="kpi"><div class="kpi__num">{{ k.openShops }}/{{ k.totalShops }}</div><div class="kpi__label">营业商家</div></div>
        </div>

        <!-- 近 7 天趋势 -->
        <div class="card">
          <div class="card__label">📅 近 7 天订单</div>
          <div class="bars">
            <div class="bars__col" v-for="d in trend" :key="d.label">
              <div class="bars__bar" :style="{ height: (d.h*70+2)+'px' }"><span v-if="d.n">{{ d.n }}</span></div>
              <div class="bars__lbl">{{ d.label }}</div>
            </div>
          </div>
        </div>

        <!-- 订单状态分布 -->
        <div class="card">
          <div class="card__label">🔄 订单状态分布</div>
          <div class="funnel">
            <div class="funnel__row" v-for="s in funnel" :key="s.key"><span class="chip" :class="s.cls">{{ s.label }}</span><div class="funnel__track"><div class="funnel__fill" :style="{ width:s.pct+'%', background:s.color }"></div></div><b>{{ s.n }}</b></div>
          </div>
          <p class="muted sm">拒单+取消率 {{ k.cancelRate }}%（越低越好）</p>
        </div>

        <!-- 商家排行 -->
        <div class="card">
          <div class="card__label">🏆 商家营收榜</div>
          <div class="empty" v-if="!topShops.length">暂无数据</div>
          <div class="rank" v-for="(s,i) in topShops" :key="s.name"><span class="rank__no" :class="{'rank__no--top':i<3}">{{ i+1 }}</span><span class="rank__name">{{ s.name }}</span><div class="rank__track"><div class="rank__fill" :style="{width:s.pct+'%'}"></div></div><b>{{ store.utils.rm(s.rev) }}</b></div>
        </div>

        <!-- 各社区分布 -->
        <div class="card" v-if="hubDist.length">
          <div class="card__label">📍 各社区订单分布</div>
          <div class="rank" v-for="h in hubDist" :key="h.name"><span class="rank__name">{{ h.name }}</span><div class="rank__track"><div class="rank__fill rank__fill--blue" :style="{width:h.pct+'%'}"></div></div><b>{{ h.n }} 单</b></div>
        </div>

        <!-- 热销商品 -->
        <div class="card">
          <div class="card__label">🔥 热销商品 Top</div>
          <div class="empty" v-if="!topItems.length">暂无数据</div>
          <div class="rank" v-for="(it,i) in topItems" :key="it.name"><span class="rank__no" :class="{'rank__no--top':i<3}">{{ i+1 }}</span><span class="rank__name">{{ it.name }}</span><b>{{ it.qty }} 份</b></div>
        </div>
        <p class="muted center sm">明细订单请到对应商家端查看；本页只看经营全局。</p>
      </div>
    `,
    setup() {
      const loading = ref(false);
      const a = ref(store.analytics());
      function recompute() { a.value = store.analytics(); }
      async function refresh() { loading.value = true; await store.refreshAdminData(); recompute(); loading.value = false; }
      onMounted(refresh);

      const orders = computed(() => a.value.orders);
      const vendors = computed(() => a.value.vendors);
      const k = computed(() => {
        const os = orders.value; const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0); const ds = dayStart.getTime();
        const done = os.filter((o) => o.status === 'delivered'); const revenue = done.reduce((s, o) => s + o.total, 0);
        const bad = os.filter((o) => o.status === 'rejected' || o.status === 'cancelled').length;
        return { revenue, today: os.filter((o) => o.at >= ds).length, total: os.length, aov: done.length ? revenue / done.length : 0,
          pending: os.filter((o) => o.status === 'pending').length, openShops: vendors.value.filter((v) => v.open).length, totalShops: vendors.value.length,
          cancelRate: os.length ? Math.round((bad / os.length) * 100) : 0 };
      });
      const trend = computed(() => {
        const days = []; const now = new Date(); now.setHours(0, 0, 0, 0);
        for (let i = 6; i >= 0; i--) { const d = new Date(now.getTime() - i * 86400000); const s = d.getTime(), e = s + 86400000; days.push({ label: ['日', '一', '二', '三', '四', '五', '六'][d.getDay()], n: orders.value.filter((o) => o.at >= s && o.at < e).length }); }
        const max = Math.max(1, ...days.map((d) => d.n)); days.forEach((d) => d.h = d.n / max); return days;
      });
      const funnel = computed(() => {
        const total = Math.max(1, orders.value.length);
        const defs = [{ key: 'pending', label: '待验证', cls: 'st-pending', color: '#fa9d3b' }, { key: 'cooking', label: '备餐', cls: 'st-cooking', color: '#e8801a' }, { key: 'delivering', label: '配送', cls: 'st-delivering', color: '#10aeff' }, { key: 'delivered', label: '送达', cls: 'st-delivered', color: '#048b44' }, { key: 'rejected', label: '拒绝', cls: 'st-rejected', color: '#fa5151' }, { key: 'cancelled', label: '取消', cls: 'st-rejected', color: '#b2b2b2' }];
        return defs.map((d) => { const n = orders.value.filter((o) => o.status === d.key).length; return Object.assign({}, d, { n, pct: Math.round((n / total) * 100) }); });
      });
      const topShops = computed(() => {
        const map = {}; orders.value.filter((o) => o.status === 'delivered').forEach((o) => { map[o.vendorId] = (map[o.vendorId] || 0) + o.total; });
        const arr = Object.keys(map).map((id) => { const v = vendors.value.find((x) => x.id === id); return { name: v ? v.name : id, rev: map[id] }; }).sort((x, y) => y.rev - x.rev).slice(0, 5);
        const max = Math.max(1, ...arr.map((x) => x.rev)); arr.forEach((x) => x.pct = Math.round((x.rev / max) * 100)); return arr;
      });
      const hubDist = computed(() => {
        const map = {}; orders.value.forEach((o) => { const h = o.hubId || '未分配'; map[h] = (map[h] || 0) + 1; });
        const arr = Object.keys(map).map((h) => ({ name: store.hubLabel(h) || h, n: map[h] })).sort((x, y) => y.n - x.n);
        const max = Math.max(1, ...arr.map((x) => x.n)); arr.forEach((x) => x.pct = Math.round((x.n / max) * 100)); return arr;
      });
      const topItems = computed(() => {
        const map = {}; orders.value.forEach((o) => (o.items || []).forEach((it) => { const nm = it.name || ''; map[nm] = (map[nm] || 0) + (Number(it.qty) || 0); }));
        return Object.keys(map).map((nm) => ({ name: nm, qty: map[nm] })).sort((x, y) => y.qty - x.qty).slice(0, 5);
      });
      return { store, loading, refresh, k, trend, funnel, topShops, hubDist, topItems };
    },
  };

  // ---------- 社区/抬头管理 ----------
  window.AdminHubs = {
    template: `
      <div class="admin-hubs-tab">
        <div class="card">
          <div class="card__label">📍 新增社区/地区抬头</div>
          <div class="field-row">
            <label class="field"><span>社区代码（网址 ?hub= 用，你自己定）</span><input v-model="form.id" placeholder="如：utm" /></label>
            <label class="field"><span>抬头名称（客户看到的）</span><input v-model="form.name" placeholder="如：UTM 团团" /></label>
          </div>
          <p class="error" v-if="error">{{ error }}</p>
          <button class="btn btn--primary btn--block" @click="add">添加社区</button>
        </div>

        <div class="order-card" v-for="h in store.state.hubs" :key="h.id">
          <div class="order-card__top">
            <span class="order-card__id">{{ h.name }}</span>
            <span class="chip st-delivering">?hub={{ h.id }}</span>
          </div>
          <div class="order-card__cust">{{ count(h.id) }} 个商家 · 客户专属链接：index.html?hub={{ h.id }}</div>
          <div class="admin-shop__actions">
            <button class="btn btn--sm btn--ghost" @click="rename(h)">改抬头</button>
            <button class="btn btn--sm btn--ghost" @click="copyLink(h)">复制客户链接</button>
            <button class="btn btn--sm btn--danger" @click="del(h)">删除</button>
          </div>
        </div>
        <p class="muted center sm">把对应链接发给该社区的客户即可，他们打开就只看到本社区的商家。</p>
      </div>
    `,
    setup() {
      const form = reactive({ id: '', name: '' });
      const error = ref('');
      function count(id) { return store.state.merchants.filter((m) => (m.hubId || '') === id).length; }
      function add() {
        if (!form.id.trim()) return (error.value = '请填写社区代码');
        if (!store.addHub(form.id, form.name)) return (error.value = '该社区代码已存在或无效');
        error.value = ''; form.id = ''; form.name = '';
      }
      function rename(h) { const n = window.prompt('修改抬头名称：', h.name); if (n !== null) store.updateHub(h.id, n); }
      function copyLink(h) {
        const link = location.origin + location.pathname.replace(/[^/]+$/, '') + 'index.html?hub=' + h.id;
        if (navigator.clipboard) navigator.clipboard.writeText(link).then(() => store.showToast('已复制：' + link, 'success'), () => store.showToast('无法复制，请手动：' + link, 'error'));
        else store.showToast('请复制此链接：' + link, 'info');
      }
      function del(h) { if (window.confirm('删除社区「' + h.name + '」？该社区下的商家不会被删除，但需重新分配社区。')) store.removeHub(h.id); }
      return { store, form, error, count, add, rename, copyLink, del };
    },
  };

  // ---------- 商家管理 ----------
  window.AdminMerchants = {
    template: `
      <div class="admin-shops">
        <button class="btn btn--primary btn--block" @click="openNew">＋ 注册新商家</button>
        <button class="btn btn--ghost btn--block preview-btn" @click="store.previewStorefront()">👀 测试 / 预览客户端首页</button>

        <div class="order-card" v-for="m in store.state.merchants" :key="m.id">
          <div class="admin-shop">
            <div class="shop-card__logo">{{ m.logo }}</div>
            <div class="admin-shop__body">
              <div class="shop-card__name">{{ m.name }}<span class="pill-tag" :class="m.open ? 'pill-tag--open' : 'pill-tag--closed'">{{ m.open ? '营业中' : '休息中' }}</span><span class="plan-badge" :class="'plan-badge--'+store.planStatus(m).key">{{ store.planStatus(m).label }}</span></div>
              <div class="shop-card__desc">{{ m.desc }}</div>
              <div class="shop-card__meta">{{ m.menu.length }} 个商品 · {{ store.ordersOf(m.id).length }} 张订单 · 📍 {{ m.hubId ? store.hubLabel(m.hubId) : '未分配社区' }}</div>
              <div class="cred" v-if="acc(m)">🔑 登录账号：<b>{{ acc(m).username }}</b></div>
            </div>
          </div>
          <div class="admin-shop__actions">
            <button class="btn btn--sm btn--ghost" @click="store.previewAsStudent(m.id)">👀 预览</button>
            <button class="btn btn--sm btn--ghost" @click="store.toggleOpen(m.id)">{{ m.open ? '设为休息' : '设为营业' }}</button>
            <button class="btn btn--sm btn--ghost" @click="openEdit(m)">编辑</button>
            <button class="btn btn--sm btn--danger" @click="del(m)">删除</button>
          </div>
        </div>

        <div class="modal" v-if="editing" @click.self="editing=null">
          <div class="modal__panel">
            <div class="modal__head"><span>{{ isNew ? '注册新商家' : '编辑商家' }}</span><button class="link-btn" @click="editing=null">关闭</button></div>
            <label class="field"><span>店名</span><input v-model="form.name" placeholder="例如：阿强快餐" /></label>
            <label class="field"><span>简介</span><input v-model="form.desc" placeholder="例如：中式快餐 · 米饭面食" /></label>
            <div class="field-row">
              <label class="field"><span>图标 Emoji</span><input v-model="form.logo" maxlength="2" placeholder="🍛" /></label>
              <label class="field"><span>TNG 收款名</span><input v-model="form.tngLabel" placeholder="Ah Keong Food" /></label>
            </div>
            <label class="field"><span>所属社区</span>
              <select class="reject-select" v-model="form.hubId">
                <option value="">不限 / 全部可见</option>
                <option v-for="h in store.state.hubs" :key="h.id" :value="h.id">{{ h.name }}（{{ h.id }}）</option>
              </select>
            </label>
            <div class="cred-box">
              <div class="card__label">🔑 商家登录账号</div>
              <div class="field-row">
                <label class="field"><span>账号</span><input v-model="form.username" :disabled="!isNew" placeholder="如 shop4" /></label>
                <label class="field"><span>密码</span>
                  <span class="pw-wrap">
                    <input v-model="form.password" :type="showPw ? 'text' : 'password'" :placeholder="isNew ? '设置初始密码' : '留空 = 不改 / 填新 = 重置'" />
                    <button type="button" class="pw-eye" @click="showPw = !showPw">{{ showPw ? '🙈' : '👁' }}</button>
                  </span>
                </label>
              </div>
              <div v-if="!isNew" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px">
                <button type="button" class="btn btn--sm btn--ghost" @click="form.password = '1234'; showPw = true">🔑 重置为 1234</button>
                <button type="button" class="btn btn--sm btn--ghost" @click="form.password = randomPwd(); showPw = true">🎲 随机生成</button>
                <button type="button" class="btn btn--sm btn--ghost" @click="copyPwd" :disabled="!form.password">📋 复制</button>
              </div>
              <p class="muted sm" v-if="!isNew">账号不可改；留空密码则保持原密码不变。</p>
            </div>
            <p class="error" v-if="error">{{ error }}</p>
            <button class="btn btn--primary btn--block" @click="save">{{ isNew ? '创建并发放账号' : '保存修改' }}</button>
          </div>
        </div>
      </div>
    `,
    setup() {
      const editing = ref(null); const isNew = ref(false); const error = ref('');
      const form = reactive({ name: '', desc: '', logo: '🏪', tngLabel: '', hubId: '', username: '', password: '' });
      const showPw = ref(false);
      function randomPwd() {
        // 8 位随机字母数字（去除易混 0/O/I/l）
        var c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
        var s = ''; for (var i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)];
        return s;
      }
      function copyPwd() {
        if (!form.password) return;
        if (navigator.clipboard) navigator.clipboard.writeText(form.password).then(
          function () { store.toastSuccess('密码已复制：' + form.password); },
          function () { window.prompt('复制密码：', form.password); }
        ); else window.prompt('复制密码：', form.password);
      }
      function acc(m) { return store.accountOf(m.id); }
      function openNew() { isNew.value = true; error.value = ''; editing.value = 'new'; Object.assign(form, { name: '', desc: '', logo: '🏪', tngLabel: '', hubId: (store.state.hubs[0] && store.state.hubs[0].id) || '', username: '', password: '1234' }); }
      function openEdit(m) {
        isNew.value = false; error.value = ''; editing.value = m;
        const a = acc(m);
        Object.assign(form, { name: m.name, desc: m.desc, logo: m.logo, tngLabel: m.tngLabel, hubId: m.hubId || '', username: a ? a.username : '', password: '' });
      }
      function save() {
        if (!form.name.trim()) return (error.value = '请填写店名');
        if (isNew.value) {
          if (!form.username.trim()) return (error.value = '请填写商家登录账号');
          if (store.usernameTaken(form.username)) return (error.value = '该账号已被占用');
          if (!form.password) return (error.value = '请设置密码');
          store.registerMerchant({ name: form.name.trim(), desc: form.desc.trim(), logo: form.logo.trim() || '🏪', tngLabel: form.tngLabel.trim() || form.name.trim(), hubId: form.hubId, username: form.username.trim(), password: form.password });
        } else {
          store.updateMerchant(editing.value.id, { name: form.name.trim(), desc: form.desc.trim(), logo: form.logo.trim() || '🏪', tngLabel: form.tngLabel.trim() || form.name.trim(), hubId: form.hubId });
          if (form.password) store.setMerchantPassword(editing.value.id, form.password);
        }
        error.value = ''; editing.value = null;
      }
      function del(m) { if (window.confirm('删除「' + m.name + '」及其全部订单与账号？不可撤销。')) store.removeMerchant(m.id); }
      return { store, editing, isNew, error, form, showPw, acc, openNew, openEdit, save, del, randomPwd, copyPwd };
    },
  };

  // ---------- 订单总览 ----------
  window.AdminOrders = {
    template: `
      <div class="admin-orders">
        <div class="stat-row">
          <div class="stat"><div class="stat__num">{{ orders.length }}</div><div class="stat__label">总订单</div></div>
          <div class="stat"><div class="stat__num">{{ pending }}</div><div class="stat__label">待处理</div></div>
          <div class="stat"><div class="stat__num">{{ store.utils.rm(revenue) }}</div><div class="stat__label">已完成营收</div></div>
        </div>
        <div class="empty" v-if="!orders.length">暂无订单</div>
        <div class="order-card" v-for="o in orders" :key="o.id">
          <div class="order-card__top"><span class="order-card__id">{{ shopName(o.merchantId) }} · {{ o.id }}</span><span class="chip" :class="st(o.status).cls">{{ st(o.status).label }}</span></div>
          <div class="order-card__cust">{{ o.customer.name }} · {{ o.customer.building }} {{ o.customer.room }}</div>
          <div class="order-card__meta"><span>{{ o.items.reduce((s,i)=>s+i.qty,0) }} 件 · {{ store.utils.rm(o.total) }}</span><span>🕒 {{ o.deliveryTime }}</span></div>
        </div>
      </div>
    `,
    setup() {
      const orders = computed(() => store.state.orders);
      const pending = computed(() => orders.value.filter((o) => o.status === 'pending').length);
      const revenue = computed(() => orders.value.filter((o) => o.status === 'delivered').reduce((s, o) => s + o.total, 0));
      function st(s) { return STATUS_TEXT[s] || { label: s, cls: '' }; }
      function shopName(id) { const m = store.getMerchant(id); return m ? m.name : '已删商家'; }
      return { store, orders, pending, revenue, st, shopName };
    },
  };

  // ---------- 计费 / 订阅追踪（SaaS 视角）----------
  window.AdminBilling = {
    template: `
      <div class="admin-billing">
        <div class="dash__title"><h2 style="font-size:inherit;margin:0">订阅与计费</h2><button class="link-btn" @click="refresh" :disabled="loading">{{ loading ? '加载中…' : '刷新' }}</button></div>
        <div class="kpi-grid">
          <div class="kpi kpi--hero"><div class="kpi__num">{{ store.utils.rm(sum.mrr) }}</div><div class="kpi__label">月度经常性收入 MRR</div></div>
          <div class="kpi"><div class="kpi__num">{{ sum.proActive }}/{{ sum.total }}</div><div class="kpi__label">付费商家</div></div>
          <div class="kpi"><div class="kpi__num" :class="{'kpi__num--warn': sum.expiringSoon>0}">{{ sum.expiringSoon }}</div><div class="kpi__label">14天内到期</div></div>
          <div class="kpi"><div class="kpi__num" :class="{'kpi__num--warn': sum.expired>0}">{{ sum.expired }}</div><div class="kpi__label">已过期</div></div>
          <div class="kpi"><div class="kpi__num">{{ store.utils.rm(sum.revenueAll) }}</div><div class="kpi__label">累计收款</div></div>
          <div class="kpi"><div class="kpi__num">{{ sum.basic }}</div><div class="kpi__label">基础版商家</div></div>
        </div>

        <div class="card"><div class="card__label">🏪 商家订阅状态</div>
          <div class="bill-row" v-for="m in rows" :key="m.id">
            <div class="bill-row__main">
              <div class="bill-row__name">{{ m.name }} <span class="plan-badge" :class="'plan-badge--'+store.planStatus(m).key">{{ store.planStatus(m).label }}</span></div>
              <div class="bill-row__sub">{{ m.plan === 'pro' ? (m.planUntil ? '到期 ' + m.planUntil : '永久专业版') : '基础版 RM 29/月' }}</div>
            </div>
            <button class="btn btn--sm btn--ghost" @click="open(m)">套餐 / 续费</button>
          </div>
          <div class="empty" v-if="!rows.length">暂无商家</div>
        </div>

        <div class="card"><div class="card__label">🧾 最近收款</div>
          <div class="empty" v-if="!payments.length">还没有收款记录</div>
          <div class="bill-pay" v-for="p in payments" :key="p.payId">
            <div><b>{{ shopName(p.vendorId) }}</b> <span class="muted sm">{{ p.note || (p.plan==='pro'?'专业版':'基础版') }}</span><span class="plan-badge plan-badge--pro" v-if="p.isTest==='TEST'" style="background:#eee;color:#888">TEST</span></div>
            <div class="bill-pay__r"><b>{{ store.utils.rm(p.amount) }}</b><span class="muted sm">{{ p.paidAt }}{{ p.periodEnd ? ' → '+p.periodEnd : '' }}</span></div>
          </div>
        </div>

        <div class="modal" v-if="editing" @click.self="editing=null">
          <div class="modal__panel">
            <div class="modal__head"><span>{{ editing.name }} · 套餐</span><button class="link-btn" @click="editing=null">关闭</button></div>
            <div class="field-row">
              <label class="field"><span>套餐</span>
                <select class="reject-select" v-model="form.plan">
                  <option value="basic">基础版 RM 29/月</option>
                  <option value="pro">专业版 RM 39/月</option>
                </select>
              </label>
              <label class="field"><span>到期日</span><input type="date" v-model="form.planUntil" :disabled="form.plan!=='pro'" /></label>
            </div>
            <div class="quick-row">
              <button class="btn btn--sm btn--ghost" @click="renew(1)">+1 个月</button>
              <button class="btn btn--sm btn--ghost" @click="renew(3)">+3 个月</button>
              <button class="btn btn--sm btn--ghost" @click="renew(12)">+1 年</button>
            </div>
            <div class="cred-box">
              <div class="card__label">记一笔收款（续费）</div>
              <div class="field-row">
                <label class="field"><span>金额 RM</span><input type="number" v-model.number="form.amount" min="0" step="0.01" /></label>
                <label class="field"><span>备注</span><input v-model="form.note" placeholder="如：5月续费 / TNG" /></label>
              </div>
              <p class="muted sm">「收款并续费」会记一笔账，并把套餐设为专业版、到期日设为上面的日期。</p>
            </div>
            <p class="error" v-if="error">{{ error }}</p>
            <button class="btn btn--primary btn--block" @click="pay">💳 收款并续费</button>
            <button class="btn btn--ghost btn--block" @click="saveOnly">仅保存套餐（不记账）</button>
          </div>
        </div>
      </div>
    `,
    setup() {
      const loading = ref(false);
      const editing = ref(null); const error = ref('');
      const form = reactive({ plan: 'basic', planUntil: '', amount: 29, note: '' });
      const sum = computed(() => store.billingSummary);
      const rows = computed(() => store.billingRows());
      const payments = computed(() => store.state.payments.slice().sort((a, b) => String(b.paidAt).localeCompare(String(a.paidAt))).slice(0, 30));
      function shopName(id) { const r = rows.value.find((x) => x.id === id); return r ? r.name : (store.getMerchant(id) ? store.getMerchant(id).name : id); }
      function pad(x) { return String(x).padStart(2, '0'); }
      function addMonths(ymd, n) { const d = ymd ? new Date(ymd + 'T00:00') : new Date(); d.setMonth(d.getMonth() + n); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
      function open(m) { error.value = ''; editing.value = m; var p = m.plan || 'basic'; Object.assign(form, { plan: p, planUntil: m.planUntil || '', amount: p === 'pro' ? store.PRO_PRICE : store.BASIC_PRICE, note: '' }); }
      function renew(months) { form.plan = 'pro'; form.planUntil = addMonths(form.planUntil && store._daysUntil(form.planUntil) > 0 ? form.planUntil : '', months); }
      function pay() {
        if (!editing.value) return;
        if (form.plan === 'pro' && !form.planUntil) return (error.value = '请设置到期日');
        store.recordPayment({ vendorId: editing.value.id, amount: form.amount, plan: form.plan, periodStart: store.utils.todayYMD(), periodEnd: form.plan === 'pro' ? form.planUntil : '', note: form.note, applyPlan: true });
        store.toastSuccess('已记账并续费 · ' + editing.value.name);
        editing.value = null;
      }
      function saveOnly() {
        if (!editing.value) return;
        if (form.plan === 'pro' && !form.planUntil) return (error.value = '请设置到期日');
        store.setVendorPlan(editing.value.id, form.plan, form.plan === 'pro' ? form.planUntil : '');
        store.toastSuccess('套餐已更新 · ' + editing.value.name);
        editing.value = null;
      }
      async function refresh() { loading.value = true; await store.refreshAdminData(); await store.loadPayments(); loading.value = false; }
      onMounted(refresh);
      return { store, loading, editing, error, form, sum, rows, payments, shopName, open, renew, pay, saveOnly, refresh };
    },
  };
})();
