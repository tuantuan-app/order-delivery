/*
 * merchant-crm.js —— 商家端「会员积分」+「统计 / CRM」
 */
(function () {
  const { computed, ref, reactive } = Vue;
  const store = window.store;
  if (!store) return;
  const ui = store.ui;
  const utils = store.utils;

  // ============================================================
  //  会员积分设置
  // ============================================================
  window.MMembership = {
    template: `
      <div class="m-coupons">
        <div class="cp-intro">
          <div class="card__label">🫘 团团豆会员</div>
          <p class="muted sm">客户每单自动积豆，攒够即可抵扣现金。<b>零操作、自动运转</b>，比优惠券更能留住回头客。</p>
        </div>

        <div class="card" style="margin:12px">
          <label class="fee-toggle" style="margin-bottom:12px">
            <input type="checkbox" v-model="draft.enabled" @change="save" />
            <span><b>启用团团豆会员</b></span>
          </label>

          <template v-if="draft.enabled">
            <label class="field"><span>每消费 RM 积 1 豆</span>
              <input class="cp-in" type="number" min="1" step="1" v-model.number="draft.ptsPerRM" @change="save" />
            </label>
            <label class="field"><span>满 N 豆可抵扣</span>
              <input class="cp-in" type="number" min="1" step="1" v-model.number="draft.redeemPts" @change="save" />
            </label>
            <label class="field"><span>抵扣金额 RM</span>
              <input class="cp-in" type="number" min="0.5" step="0.5" v-model.number="draft.redeemRM" @change="save" />
            </label>
            <div class="cp-preview">
              示例：客户消费 RM {{ draft.ptsPerRM * draft.redeemPts || 10 }} 可攒够 {{ draft.redeemPts || 10 }} 豆，抵扣 RM {{ draft.redeemRM || 2 }}
            </div>
          </template>
          <p class="muted sm" v-else>开启后，客户端结账页将自动显示积分余额和抵扣选项。</p>
        </div>

        <!-- 客户积分明细 -->
        <div class="card" style="margin:12px" v-if="draft.enabled">
          <div class="card__label">👥 客户积分</div>
          <div class="empty" v-if="!memberList.length">还没有客户积豆，等客户下单后自动出现。</div>
          <table class="crm-table" v-else>
            <thead><tr><th>手机号</th><th class="num">团团豆</th><th class="num">可抵扣</th></tr></thead>
            <tbody>
              <tr v-for="m in memberList" :key="m.phone">
                <td>{{ m.phone }}</td>
                <td class="num">{{ m.points }}</td>
                <td class="num">{{ m.canRedeem ? '✓ RM ' + draft.redeemRM : '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    `,
    setup() {
      const merchant = computed(() => store.getMerchant(ui.merchantId));
      const mem = computed(() => {
        var m = merchant.value;
        if (!m || !m.settings || !m.settings.membership) return { enabled: false, ptsPerRM: 1, redeemPts: 10, redeemRM: 2, points: {} };
        return Object.assign({ enabled: false, ptsPerRM: 1, redeemPts: 10, redeemRM: 2, points: {} }, m.settings.membership);
      });
      const draft = reactive(Object.assign({}, mem.value));
      // 同步外部变化
      const stop = Vue.watch(mem, function (v) { Object.assign(draft, v); }, { deep: true });

      const memberList = computed(() => {
        var pts = draft.points || {};
        return Object.keys(pts).map(function (phone) {
          var p = Number(pts[phone]) || 0;
          return { phone: phone, points: p, canRedeem: p >= (Number(draft.redeemPts) || 10) };
        }).sort(function (a, b) { return b.points - a.points; });
      });

      function save() {
        var m = merchant.value; if (!m) return;
        if (!m.settings.membership) m.settings.membership = {};
        Object.assign(m.settings.membership, {
          enabled: draft.enabled,
          ptsPerRM: Math.max(1, Number(draft.ptsPerRM) || 1),
          redeemPts: Math.max(1, Number(draft.redeemPts) || 10),
          redeemRM: Math.max(0, Number(draft.redeemRM) || 0),
        });
        store._syncMerchantConfig(ui.merchantId);
      }

      return { store, draft, memberList, save };
    },
  };

  // ============================================================
  //  统计 / CRM
  // ============================================================
  window.MCrm = {
    template: `
      <div class="m-crm">
        <div class="crm-tabs">
          <button v-for="v in views" :key="v.key" class="crm-tab" :class="{active: view===v.key}" @click="view=v.key">{{ v.label }}</button>
        </div>
        <div class="crm-time">
          <button v-for="r in ranges" :key="r.key" class="ord-time__btn" :class="{active: range===r.key}" @click="range=r.key">{{ r.label }}</button>
        </div>

        <!-- KPI 概览（所有视图共用） -->
        <div class="crm-kpi">
          <div class="crm-kpi__cell"><div class="crm-kpi__num">{{ store.utils.rm(kpi.revenue) }}</div><div class="crm-kpi__lab">营收（已送达）</div></div>
          <div class="crm-kpi__cell"><div class="crm-kpi__num">{{ kpi.done }}</div><div class="crm-kpi__lab">完成订单</div></div>
          <div class="crm-kpi__cell"><div class="crm-kpi__num">{{ store.utils.rm(kpi.aov) }}</div><div class="crm-kpi__lab">客单价</div></div>
          <div class="crm-kpi__cell"><div class="crm-kpi__num">{{ kpi.rejRate }}%</div><div class="crm-kpi__lab">拒/取消率</div></div>
        </div>

        <div class="empty" v-if="!scoped.length && view!=='coupons'">该时间段还没有订单数据。</div>

        <!-- 客户清单（CRM 核心） -->
        <template v-else-if="view==='customers'">
          <div class="crm-sort">
            <span class="muted sm">{{ customers.length }} 位客户 · 排序</span>
            <select class="cat-select" v-model="custSort">
              <option value="spent">按消费</option><option value="count">按单数</option><option value="recent">按最近</option>
            </select>
          </div>
          <table class="crm-table">
            <thead><tr><th>客户</th><th class="num">单数</th><th class="num">消费</th><th class="num">最近</th></tr></thead>
            <tbody>
              <tr v-for="c in customers" :key="c.key">
                <td>
                  <div class="crm-cust__name">{{ c.name || '（未留名）' }}<span class="crm-tag" v-if="c.count>=3">回头客</span><span class="crm-tag crm-tag--new" v-else-if="c.count===1">新客</span></div>
                  <div class="muted sm">{{ c.phone }} · 客单 {{ store.utils.rm(c.aov) }}</div>
                </td>
                <td class="num">{{ c.count }}</td>
                <td class="num">{{ store.utils.rm(c.spent) }}</td>
                <td class="num sm">{{ store.utils.relTime(c.lastAt) }}</td>
              </tr>
            </tbody>
          </table>
        </template>

        <!-- 营收趋势 -->
        <template v-else-if="view==='trend'">
          <div class="card">
            <div class="card__label">每日营收（已送达）</div>
            <div class="crm-bars">
              <div class="crm-bar" v-for="d in trend" :key="d.label">
                <div class="crm-bar__track"><div class="crm-bar__fill" :style="{ height: (maxRev? (d.revenue/maxRev*100):0) + '%' }" :title="store.utils.rm(d.revenue)"></div></div>
                <div class="crm-bar__val">{{ d.orders || '' }}</div>
                <div class="crm-bar__lab">{{ d.label }}</div>
              </div>
            </div>
            <p class="muted sm center">柱高=营收，数字=单数</p>
          </div>
        </template>

        <!-- 商品热度 -->
        <template v-else-if="view==='products'">
          <table class="crm-table">
            <thead><tr><th>商品</th><th class="num">销量</th><th class="num">营收</th></tr></thead>
            <tbody>
              <tr v-for="(p,i) in products" :key="p.name">
                <td><span class="crm-rank" :class="{'crm-rank--top': i<3}">{{ i+1 }}</span> {{ p.name }}</td>
                <td class="num">{{ p.qty }}</td>
                <td class="num">{{ store.utils.rm(p.revenue) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="muted sm center" v-if="products.length">仅统计已送达订单的商品。</p>
        </template>

        <!-- 会员效果 -->
        <template v-else-if="view==='membership'">
          <div class="crm-kpi">
            <div class="crm-kpi__cell"><div class="crm-kpi__num">{{ membershipStats.members }}</div><div class="crm-kpi__lab">会员数</div></div>
            <div class="crm-kpi__cell"><div class="crm-kpi__num">{{ membershipStats.redeemedOrders }}</div><div class="crm-kpi__lab">抵扣订单</div></div>
            <div class="crm-kpi__cell"><div class="crm-kpi__num">{{ store.utils.rm(membershipStats.totalDiscount) }}</div><div class="crm-kpi__lab">累计抵扣</div></div>
            <div class="crm-kpi__cell"><div class="crm-kpi__num">{{ membershipStats.totalPoints }}</div><div class="crm-kpi__lab">流通豆数</div></div>
          </div>
          <p class="muted sm center">团团豆会员数据，按所选时间段统计。</p>
        </template>
      </div>
    `,
    setup() {
      const views = [{ key: 'customers', label: '客户' }, { key: 'trend', label: '营收趋势' }, { key: 'products', label: '商品热度' }, { key: 'membership', label: '会员效果' }];
      const ranges = [{ key: '7d', label: '近7天' }, { key: '30d', label: '近30天' }, { key: 'all', label: '全部' }];
      const view = ref('customers');
      const range = ref('30d');
      const custSort = ref('spent');

      const allOrders = computed(() => store.ordersOf(ui.merchantId));
      function rangeStart() {
        if (range.value === 'all') return 0;
        return Date.now() - (range.value === '7d' ? 7 : 30) * 86400000;
      }
      const scoped = computed(() => { const from = rangeStart(); return allOrders.value.filter((o) => (Number(o.createdAt) || 0) >= from); });
      const delivered = computed(() => scoped.value.filter((o) => o.status === 'delivered'));

      const kpi = computed(() => {
        const dv = delivered.value, all = scoped.value;
        const revenue = dv.reduce((s, o) => s + (Number(o.total) || 0), 0);
        const closed = all.filter((o) => o.status === 'rejected' || o.status === 'cancelled').length;
        const rejRate = all.length ? Math.round(closed / all.length * 100) : 0;
        return { revenue, done: dv.length, aov: dv.length ? revenue / dv.length : 0, rejRate };
      });

      // 客户聚合：按电话归并（无电话则按姓名）
      const customers = computed(() => {
        const map = {};
        scoped.value.forEach((o) => {
          if (o.status === 'rejected' || o.status === 'cancelled') return;
          const c = o.customer || {};
          const key = (c.phone || c.name || '匿名').trim() || '匿名';
          if (!map[key]) map[key] = { key, name: c.name || '', phone: c.phone || '', count: 0, spent: 0, lastAt: 0 };
          const r = map[key];
          r.count += 1; r.spent += Number(o.total) || 0;
          if (!r.name && c.name) r.name = c.name;
          if ((Number(o.createdAt) || 0) > r.lastAt) r.lastAt = Number(o.createdAt) || 0;
        });
        const list = Object.keys(map).map((k) => { const r = map[k]; r.aov = r.count ? r.spent / r.count : 0; return r; });
        const by = custSort.value;
        list.sort((a, b) => by === 'count' ? b.count - a.count : by === 'recent' ? b.lastAt - a.lastAt : b.spent - a.spent);
        return list;
      });

      // 每日趋势（按所选范围，最多 30 天）
      const trend = computed(() => {
        const days = range.value === '7d' ? 7 : range.value === '30d' ? 30 : 14;
        const buckets = [];
        const today = new Date(); today.setHours(0, 0, 0, 0);
        for (let i = days - 1; i >= 0; i--) {
          const d = new Date(today.getTime() - i * 86400000);
          buckets.push({ ts: d.getTime(), label: (d.getMonth() + 1) + '/' + d.getDate(), orders: 0, revenue: 0 });
        }
        const first = buckets.length ? buckets[0].ts : 0;
        delivered.value.forEach((o) => {
          const t = Number(o.createdAt) || 0; if (t < first) return;
          const idx = Math.floor((t - first) / 86400000);
          if (idx >= 0 && idx < buckets.length) { buckets[idx].orders += 1; buckets[idx].revenue += Number(o.total) || 0; }
        });
        return buckets;
      });
      const maxRev = computed(() => trend.value.reduce((m, d) => Math.max(m, d.revenue), 0));

      // 商品热度
      const products = computed(() => {
        const map = {};
        delivered.value.forEach((o) => (o.items || []).forEach((it) => {
          const k = it.name || '未命名';
          if (!map[k]) map[k] = { name: k, qty: 0, revenue: 0 };
          map[k].qty += Number(it.qty) || 0;
          map[k].revenue += (Number(it.price) || 0) * (Number(it.qty) || 0);
        }));
        return Object.keys(map).map((k) => map[k]).sort((a, b) => b.qty - a.qty);
      });

      // 会员效果（按所选时间段内非取消/拒绝订单统计）
      const membershipStats = computed(() => {
        const memOrders = scoped.value.filter(function (o) {
          if (o.status === 'cancelled' || o.status === 'rejected') return false;
          var mi = store.parseMembership(o);
          return mi.earned > 0 || mi.redeemed;
        });
        // 去重手机号 = 会员数
        var phones = {};
        memOrders.forEach(function (o) { if (o.customer && o.customer.phone) phones[o.customer.phone] = true; });
        var redeemedOrders = memOrders.filter(function (o) { return store.parseMembership(o).redeemed; });
        return {
          members: Object.keys(phones).length,
          totalPoints: memOrders.reduce(function (s, o) { return s + store.parseMembership(o).earned; }, 0),
          redeemedOrders: redeemedOrders.length,
          totalDiscount: redeemedOrders.reduce(function (s, o) { return s + store.parseMembership(o).discount; }, 0),
        };
      });

      return { store, views, ranges, view, range, custSort, scoped, kpi, customers, trend, maxRev, products, membershipStats };
    },
  };
})();
