/*
 * merchant.js —— 商家管理端（登录后锁定到自己的店）
 *  订单：对账(放大截图)→ 同意/拒绝 → 推进状态 → 送达可选上传到货照片
 *  菜单：按分类分组管理，可新增/删除分类、给菜品分类、上传图片(自动压缩 WebP)
 *  设置：营业开关、固定/灵活配送
 *  顶部「预览客户端」按钮
 */
(function () {
  const { computed, ref, reactive, onMounted, onUnmounted, watch } = Vue;
  const store = window.store;
  const ui = store.ui;

  const STATUS_TEXT = {
    pending: { label: '等待验证', cls: 'st-pending' }, cooking: { label: '备餐中', cls: 'st-cooking' },
    delivering: { label: '配送中', cls: 'st-delivering' }, delivered: { label: '已送达', cls: 'st-delivered' },
    rejected: { label: '已拒绝', cls: 'st-rejected' }, cancelled: { label: '已取消', cls: 'st-rejected' },
  };
  // 上传 → 压缩 WebP → 回调（opts 可指定 maxWidth/quality）
  function pickImage(e, cb, opts) { const f = e.target.files && e.target.files[0]; if (!f) return; store.utils.compressImage(f, opts).then(cb).catch(() => {}); e.target.value = ''; }

  window.MerchantApp = {
    template: `
      <div class="merchant" v-if="store.merchant">
        <div class="m-actionbar">
          <span class="m-actionbar__pending" v-if="pendingCount">🔔 {{ pendingCount }} 个新订单待处理</span>
          <span class="m-actionbar__pending muted" v-else>暂无待处理订单</span>
          <button class="btn btn--sm btn--ghost preview-btn" @click="store.previewAsStudent(ui.merchantId)">👀 预览客户端</button>
        </div>
        <div class="m-body">
          <m-orders v-if="tab==='orders'"></m-orders>
          <m-menu v-else-if="tab==='menu'"></m-menu>
          <m-membership v-else-if="tab==='membership' && pro"></m-membership>
          <m-crm v-else-if="tab==='crm' && pro"></m-crm>
          <upgrade-prompt v-else-if="tab==='upgrade'" feature="专业版" icon="✨"></upgrade-prompt>
          <m-settings v-else></m-settings>
        </div>
        <nav class="tabbar" role="navigation" aria-label="商家管理">
          <button :class="{active: tab==='orders'}" @click="tab='orders'"><span class="tabbar__ico">🧾</span><span>订单</span><i class="dot" v-if="pendingCount"></i></button>
          <button :class="{active: tab==='menu'}" @click="tab='menu'"><span class="tabbar__ico">🍽️</span><span>商品</span></button>
          <button v-if="pro" :class="{active: tab==='membership'}" @click="tab='membership'"><span class="tabbar__ico">🫘</span><span>会员</span></button>
          <button v-if="pro" :class="{active: tab==='crm'}" @click="tab='crm'"><span class="tabbar__ico">📊</span><span>统计</span></button>
          <button v-if="!pro" class="tabbar__upgrade" :class="{active: tab==='upgrade'}" @click="tab='upgrade'"><span class="tabbar__ico">✨</span><span>PRO</span></button>
          <button :class="{active: tab==='settings'}" @click="tab='settings'"><span class="tabbar__ico">⚙️</span><span>设置</span></button>
        </nav>
      </div>
      <div class="empty" v-else>账号未绑定店铺，请联系管理员。</div>
    `,
    setup() {
      const tab = ref('orders');
      const pro = computed(() => store.isPro(store.merchant));
      const pendingCount = computed(() => store.ordersOf(ui.merchantId).filter((o) => o.status === 'pending').length);
      // 新单提醒：按「订单号」判断，每个新单一生只响一次——避免轮询/同步抖动导致同一单重复提示
      const pendingIds = computed(() => store.ordersOf(ui.merchantId).filter((o) => o.status === 'pending').map((o) => o.id));
      var _alerted = new Set(pendingIds.value); // 进页面时已有的待处理单不提示
      watch(pendingIds, (ids) => {
        var fresh = false;
        ids.forEach((id) => { if (!_alerted.has(id)) { _alerted.add(id); fresh = true; } }); // 只对没见过的单提示，见过的即使消失再出现也不再响
        // 避免与新 merchantRinger 双响：ring.enabled 时由 ringer 负责持续响铃，这里跳过 playAlert
        var ringOn = store.merchant && store.merchant.settings && store.merchant.settings.ring && store.merchant.settings.ring.enabled;
        if (fresh && store.merchant && store.merchant.settings.soundOn !== false && !ringOn) store.utils.playAlert();
      });
      return { store, ui, tab, pro, pendingCount };
    },
  };

  // ---------- 升级引导（基础版点到专业版功能时的转化页）----------
  window.UpgradePrompt = {
    props: ['feature', 'icon'],
    template: `
      <div class="upsell">
        <div class="upsell__badge">PRO</div>
        <div class="upsell__ico">{{ icon || '🔒' }}</div>
        <h2 class="upsell__title">{{ feature }} 是专业版功能</h2>
        <p class="upsell__sub" v-if="store.planExpired(store.merchant)">你的专业版已于 <b>{{ store.merchant.planUntil }}</b> 到期，续费即可恢复使用。</p>
        <p class="upsell__sub" v-else>升级专业版即可解锁，吸引回头客、看懂你的生意。</p>
        <div class="upsell__feats">
          <div class="upsell__feat">🫘 团团豆会员 · 客户每单自动积豆，攒够抵现，回头率飙升</div>
          <div class="upsell__feat">📊 统计 CRM · 回头客、营收趋势、商品热度、会员效果</div>
          <div class="upsell__feat">📣 平台广告位 · 在客户端首页推广你的店（即将推出）</div>
        </div>
        <div class="upsell__plan">
          <div><div class="upsell__plan-name">基础版</div><div class="upsell__plan-price">RM 29 <span>/ 月</span></div></div>
          <div class="upsell__plan-name">专业版</div><div class="upsell__plan-price" style="color:var(--green-d)">RM 39 <span>/ 月</span></div>
          <div class="upsell__plan-now">当前：{{ store.merchant && store.merchant.plan === 'pro' ? '专业版(已过期)' : '基础版' }}</div>
        </div>
        <button class="btn btn--primary btn--block btn--pill" @click="contact">联系平台升级</button>
        <p class="upsell__note">升级由平台开通；开通后此功能立即可用。</p>
      </div>
    `,
    setup() {
      // H19 fix: provide real contact path instead of dead-end toast
      function contact() {
        var msg = '你好，我想升级团团专业版（PRO），请帮我开通。';
        window.open('https://wa.me/60132831238?text=' + encodeURIComponent(msg), '_blank');
      }
      return { store, contact };
    },
  };

  // ---------- 订单 ----------
  window.MOrders = {
    template: `
      <div class="m-orders">
        <div class="stat-row">
          <div class="stat"><div class="stat__num">{{ stats.done }}</div><div class="stat__label">已完成</div></div>
          <div class="stat"><div class="stat__num">{{ store.utils.rm(stats.revenue) }}</div><div class="stat__label">营收</div></div>
        </div>
        <!-- 搜索：订单号 / 姓名 / 电话 / 商品（跨全部状态） -->
        <div class="ord-search">
          <span class="ord-search__ico">🔍</span>
          <input v-model="query" placeholder="搜订单号 / 姓名 / 电话 / 商品" />
          <button class="ord-search__x" v-if="query" @click="query=''" aria-label="清除搜索">✕</button>
        </div>
        <div class="ord-search__hint" v-if="searching">搜索「{{ query.trim() }}」：{{ filtered.length }} 条结果（含全部状态）</div>

        <!-- 状态分类标签：默认停在「待处理」 -->
        <div class="ord-tabs" v-show="!searching">
          <button v-for="g in groups" :key="g.key" class="ord-tab" :class="{active: filter===g.key}" @click="filter=g.key">{{ g.label }}<i class="ord-tab__n" :class="{'ord-tab__n--doing': g.key==='doing'}" v-if="(g.key==='pending'||g.key==='doing') && counts[g.key]">{{ counts[g.key] }}</i></button>
        </div>
        <div class="ord-time" v-show="!searching">
          <button v-for="tf in timeFilters" :key="tf.key" class="ord-time__btn" :class="{active: timeFilter===tf.key}" @click="timeFilter=tf.key">{{ tf.label }}</button>
        </div>
        <button class="btn btn--block btn--ghost batch-entry" v-if="doingOrders.length>1 && !searching" @click="openBatch">📦 批量送达 · 同地点多单拍一张照片全搞定</button>
        <div class="skel-list" v-if="store.ui.merchantOrdersLoading && !orders.length">
          <div class="skel-card" v-for="n in 3" :key="'sk'+n"><div class="skel-line skel-line--40"></div><div class="skel-line skel-line--80"></div><div class="skel-line skel-line--60"></div></div>
        </div>
        <div class="empty" v-else-if="!filtered.length">{{ searching ? '未找到匹配的订单' : (filter==='pending' ? '没有待处理的订单 🎉' : '该分类暂无订单') }}</div>
        <div class="order-card" v-for="o in filtered" :key="o.id" @click="current=o">
          <div class="order-card__top"><span><b class="order-card__id">{{ o.id }}</b> <span class="muted sm">{{ store.utils.relTime(o.createdAt) }}</span></span><span class="chip" :class="st(o.status).cls">{{ st(o.status).label }}</span></div>
          <div class="order-card__cust">{{ o.customer.name }} · {{ o.customer.building }} {{ o.customer.room }} · {{ store.utils.displayPhone(o.customer.phone) }}</div>
          <div class="order-card__meta"><span>{{ o.items.reduce((s,i)=>s+i.qty,0) }} 件 · {{ store.utils.rm(o.total) }}</span><span>🕒 {{ o.deliveryTime }}</span></div>
          <div class="order-card__remark" v-if="o.remark">📝 {{ o.remark }}</div>
          <div class="order-card__shot" v-if="shotState(o).key==='wait'">⏳ 支付截图上传中…</div>
          <div class="order-card__shot order-card__shot--bad" v-else-if="shotState(o).key==='missing'">⚠ 客户截图还没传上（可能仍在传，下拉刷新或联系客户）</div>
          <div class="card-actions" v-if="o.status==='pending'" @click.stop>
            <button class="btn btn--sm btn--danger" @click="askReject(o)">拒绝</button>
            <button class="btn btn--sm btn--primary" @click="store.approveOrder(o.id)">同意做菜</button>
          </div>
          <div class="card-actions" v-else-if="o.status==='cooking'" @click.stop>
            <button class="btn btn--sm btn--ghost" @click="current=o">查看</button>
            <button class="btn btn--sm btn--primary" @click="store.advanceOrder(o.id)">开始配送</button>
          </div>
          <div class="card-actions" v-else-if="o.status==='delivering'" @click.stop>
            <button class="btn btn--sm btn--ghost" @click="current=o">＋到货照片</button>
            <button class="btn btn--sm btn--primary" @click="store.advanceOrder(o.id); current=o">确认送达</button>
          </div>
          <div class="card-actions" v-else-if="o.status==='delivered' && !o.deliveryPhoto" @click.stop>
            <button class="btn btn--sm btn--ghost" @click="current=o">＋ 补到货照片</button>
          </div>
        </div>

        <div class="modal" v-if="current" @click.self="current=null">
          <div class="modal__panel">
            <div class="modal__head"><span>订单 {{ current.id }}</span><button class="link-btn" @click="current=null">关闭</button></div>
            <div class="kv"><span>顾客</span><b>{{ current.customer.name }} <a class="tel" :href="'tel:+'+store.utils.waPhone(current.customer.phone)">📞 {{ store.utils.displayPhone(current.customer.phone) }}</a></b></div>
            <div class="kv"><span>送达</span><b>{{ current.customer.building }} {{ current.customer.room }}</b></div>
            <div class="kv"><span>时间</span><b>{{ current.deliveryTime }}</b></div>
            <div class="remark-box" v-if="current.remark">📝 客户备注：{{ current.remark }}</div>
            <div class="modal__items">
              <div class="line" v-for="it in current.items" :key="it.id"><span>{{ it.name }} × {{ it.qty }}</span><span>{{ store.utils.rm(it.price*it.qty) }}</span></div>
              <div class="line" v-if="store.parseMembership(current).discount>0"><span class="muted">🫘 会员抵扣</span><span>− {{ store.utils.rm(store.parseMembership(current).discount) }}</span></div>
              <div class="line line--total"><span>合计</span><span>{{ store.utils.rm(current.total) }}</span></div>
            </div>
            <div class="modal__label">💳 支付截图（点击放大对账，可双指放大看单号）</div>
            <img class="shot" v-if="current.screenshot" :src="current.screenshot" alt="" @click="openShot(current.screenshot)" />
            <div class="shot-missing" v-else-if="current.imagesPurgedAt" style="background:#f0f9ff;color:#0369a1">📄 截图已归档（订单 {{ Math.round((Date.now() - current.createdAt) / 86400000) }} 天前完成，文字记录保留：RM {{ current.total }} · {{ current.deliveryTime }}）</div>
            <div class="shot-missing" v-else>{{ shotState(current).key==='wait' ? '⏳ 客户支付截图上传中，请稍候…' : '⚠ 客户截图还没传上，可联系客户让其重新上传后再对账。' }}</div>

            <div class="modal__actions" v-if="current.status==='pending'">
              <button class="btn btn--danger" @click="askReject(current)">拒绝</button>
              <button class="btn btn--primary" @click="store.approveOrder(current.id)">同意并开始做菜</button>
            </div>
            <div class="modal__actions" v-else-if="current.status==='cooking'">
              <span class="chip st-cooking">备餐中</span>
              <button class="btn btn--primary" @click="store.advanceOrder(current.id)">开始配送</button>
            </div>
            <template v-else-if="current.status==='delivering'">
              <div class="modal__label">📸 到货照片（选填，送达后客户会看到）</div>
              <label class="upload__drop sm-drop" v-if="!current.deliveryPhoto"><input type="file" accept="image/*" @change="onPhoto($event, current)" hidden /><span class="upload__plus">＋</span><span>拍照 / 选择到货照片</span></label>
              <div class="upload__preview" v-else><img :src="current.deliveryPhoto" alt="" /><button class="link-btn" @click="store.setDeliveryPhoto(current.id,'')">移除</button></div>
              <button v-if="isDev" class="link-btn sm" @click="store.setDeliveryPhoto(current.id, store.utils.sampleDelivery())">用示例照片测试</button>
              <div class="modal__actions"><span class="chip st-delivering">配送中</span><button class="btn btn--primary" @click="store.advanceOrder(current.id)">确认送达</button></div>
            </template>
            <div class="modal__done" v-else>
              <span class="chip" :class="st(current.status).cls">{{ st(current.status).label }}</span>
              <span class="muted sm" v-if="current.rejectReason">原因：{{ current.rejectReason }}</span>
              <img class="thumb" v-if="current.status!=='delivered' && current.deliveryPhoto" :src="current.deliveryPhoto" @click="openShot(current.deliveryPhoto)" alt="" />
            </div>
            <!-- 已送达：补/换到货照片。独立整行区块（不能塞进 flex 的 .modal__done，否则上传框被挤压、显示不全） -->
            <div class="deliver-photo" v-if="current.status==='delivered'">
              <div class="modal__label">📸 到货照片（客户可见{{ current.deliveryPhoto ? '，可移除后重拍' : '，忘了拍可在此补上' }}）</div>
              <div class="upload__preview" v-if="current.deliveryPhoto"><img :src="current.deliveryPhoto" alt="" @click="openShot(current.deliveryPhoto)" /><button class="link-btn" @click="store.setDeliveryPhoto(current.id,'')">移除</button></div>
              <template v-else>
                <label class="upload__drop sm-drop"><input type="file" accept="image/*" @change="onPhoto($event, current)" hidden /><span class="upload__plus">＋</span><span>补拍 / 选择到货照片</span></label>
                <button v-if="isDev" class="link-btn sm" @click="store.setDeliveryPhoto(current.id, store.utils.sampleDelivery())">用示例照片测试</button>
              </template>
            </div>
            <!-- 通知客户：WhatsApp 一键发到其手机号 / 复制文案(微信/手动) -->
            <div class="notify-box" v-if="current.status==='delivering' || current.status==='delivered'">
              <div class="modal__label">📣 通知客户「{{ current.customer.name }}」</div>
              <div class="notify-row">
                <button class="btn btn--sm notify-wa" v-if="store.merchant.settings.waNotify" @click="notifyWhatsApp(current)">📱 WhatsApp 通知</button>
                <button class="btn btn--sm btn--ghost" @click="copyNotify(current)">📋 复制文案</button>
              </div>
              <p class="muted sm">客户在订单页已能实时看到「已送达」+到货照片；如需额外提醒，{{ store.merchant.settings.waNotify ? '点 WhatsApp 一键发，或' : '' }}复制文案粘到微信/短信发给客户。</p>
            </div>
          </div>
        </div>
        <!-- 拒绝理由（下拉选择） -->
        <div class="modal" v-if="rejecting" @click.self="rejecting=null">
          <div class="modal__panel">
            <div class="modal__head"><span>拒绝订单 {{ rejecting.id }}</span><button class="link-btn" @click="rejecting=null">取消</button></div>
            <div class="card__label">选择拒绝理由（会显示给客户）</div>
            <select class="reject-select" v-model="reasonChoice">
              <option v-for="r in reasons" :key="r" :value="r">{{ r }}</option>
            </select>
            <input v-if="reasonChoice==='其他（自定义）'" class="reject-custom" v-model="customReason" placeholder="请输入拒绝理由" />
            <div class="modal__actions">
              <button class="btn btn--ghost" @click="rejecting=null">返回</button>
              <button class="btn btn--danger" @click="confirmReject">确认拒绝</button>
            </div>
          </div>
        </div>

        <div class="lightbox" v-if="zoom" @click="zoom=null">
          <img :src="zoom" alt="" @click.stop />
          <div class="lightbox__bar"><button class="lightbox__btn" @click.stop="openTab(zoom)">在新标签打开（可双指放大）</button></div>
          <div class="lightbox__hint">点击空白处关闭</div>
        </div>

        <!-- 批量送达：勾同地点订单 → 一张到货照片 → 一次性全部送达 -->
        <div class="modal" v-if="batchOpen" @click.self="batchOpen=false">
          <div class="modal__panel">
            <div class="modal__head"><span>📦 批量送达</span><button class="link-btn" @click="batchOpen=false">关闭</button></div>
            <p class="muted sm">勾选送到同一地点的订单 → 拍一张到货照片 → 一次全部送达。地址已按楼栋<b>智能归并</b>（忽略空格/大小写），但<b>请核对每单完整地址</b>再确认，相似不等于同一处。</p>
            <div class="empty" v-if="!doingOrders.length">暂无进行中的订单。</div>
            <div class="batch-group" v-for="g in doingGroups" :key="g.building">
              <div class="batch-group__hd"><b>📍 {{ g.building }}</b><span class="muted sm">{{ g.orders.length }} 单</span><button class="link-btn" @click.prevent="selectGroup(g)">全选本栋</button></div>
              <label class="batch-item" v-for="o in g.orders" :key="o.id">
                <input type="checkbox" :checked="batchSel.indexOf(o.id)>=0" @change="toggleBatch(o.id)" />
                <div class="batch-item__main">{{ o.customer.building }} {{ o.customer.room }} · {{ o.customer.name }}<div class="muted sm">{{ o.id }} · {{ o.items.reduce((s,i)=>s+i.qty,0) }} 件 · {{ st(o.status).label }}</div></div>
              </label>
            </div>
            <template v-if="batchSel.length">
              <div class="modal__label">📸 到货照片（选填，这一张发给选中的 {{ batchSel.length }} 单）</div>
              <label class="upload__drop sm-drop" v-if="!batchPhoto"><input type="file" accept="image/*" @change="onBatchPhoto" hidden /><span class="upload__plus">＋</span><span>拍照 / 选择到货照片</span></label>
              <div class="upload__preview" v-else><img :src="batchPhoto" alt="" /><button class="link-btn" @click="batchPhoto=''">移除</button></div>
              <button v-if="isDev" class="link-btn sm" @click="batchPhoto=store.utils.sampleDelivery()">用示例照片测试</button>
              <button class="btn btn--primary btn--block" @click="batchDeliverGo">✅ 全部送达（{{ batchSel.length }} 单）</button>
              <button class="btn btn--block btn--ghost" @click="batchCopyGo">📋 复制群发文案（粘到 WhatsApp 广播 / 微信群发）</button>
            </template>
          </div>
        </div>
      </div>
    `,
    setup() {
      const current = ref(null); const zoom = ref(null);
      const reasons = ['截图与实付金额不符', '收款方/账户不正确', '重复支付 / 截图无效', '商品已售罄', '超出配送范围', '其他（自定义）'];
      const rejecting = ref(null); const reasonChoice = ref(reasons[0]); const customReason = ref('');
      const orders = computed(() => store.ordersOf(ui.merchantId));
      const GROUPS = { pending: ['pending'], doing: ['cooking', 'delivering'], done: ['delivered'], closed: ['rejected', 'cancelled'] };
      const groups = [{ key: 'pending', label: '待处理' }, { key: 'doing', label: '进行中' }, { key: 'done', label: '已完成' }, { key: 'closed', label: '已取消/拒' }];
      const filter = ref('pending');
      const timeFilter = ref('7d');
      const timeFilters = [{ key: 'today', label: '今日' }, { key: '7d', label: '近7天' }, { key: 'all', label: '全部' }];
      function timeOk(o) {
        if (timeFilter.value === 'all') return true;
        const t = Number(o.createdAt) || 0;
        if (timeFilter.value === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return t >= d.getTime(); }
        return t >= Date.now() - 7 * 86400000;
      }
      const counts = computed(() => { const c = {}; for (const k in GROUPS) c[k] = orders.value.filter((o) => GROUPS[k].indexOf(o.status) >= 0 && timeOk(o)).length; return c; });
      // 搜索：跨全部状态/时间匹配 订单号/姓名/电话/商品名；空则按分类+时间
      const query = ref('');
      const searching = computed(() => query.value.trim().length > 0);
      function hay(o) {
        const c = o.customer || {};
        return [o.id, c.name, c.phone, c.building, c.room, (o.items || []).map((i) => i.name).join(' ')].join(' ').toLowerCase();
      }
      const filtered = computed(() => {
        const q = query.value.trim().toLowerCase();
        if (q) return orders.value.filter((o) => hay(o).indexOf(q) >= 0);
        return orders.value.filter((o) => GROUPS[filter.value].indexOf(o.status) >= 0 && timeOk(o));
      });
      const stats = computed(() => {
        const os = orders.value;
        return {
          done: os.filter((o) => o.status === 'delivered').length,
          revenue: os.filter((o) => o.status === 'delivered').reduce((s, o) => s + (o.total || 0), 0),
        };
      });
      // v4: 自适应轮询 + 隐藏暂停 —— 省 GAS 配额
      //   起步 8s = 与后端"有 pending 时"间隔对齐，保证新单 ≤8s 到位
      //     之前起步 30s：商家页面刚开 30s 内来的新单，最长要等 30s 才显示 → 错过黄金接单期
      //     后端会自适应：无 pending 时回 30s（getVendorOrders pollIntervalMs），跟着调
      //   弹窗打开时仍照常 poll（不再 `if (current.value) return`）：
      //     之前商家点开 A 单看截图时，B/C/D 进单全部被吞掉
      //     现在 poll 后用 id 重新指向最新对象，弹窗内容跟着刷新；用户感知：实时
      //   tab 隐藏（锁屏/切 app/换 tab）立即暂停 setInterval，可见再 poll 一次重启
      let timer = null; let polling = false; let currentInterval = 8000;
      async function poll() {
        if (polling || !(window.api && window.api.enabled())) return;
        if (document.visibilityState === 'hidden') return; // 后台不烧 GAS
        polling = true;
        try {
          const r = await window.api.getVendorOrders(ui.merchantId, store.auth.token);
          if (r && r.ok) {
            const openId = current.value && current.value.id;
            store.applyVendorOrders(ui.merchantId, r.orders);
            // 弹窗打开时：用 orderId 重新指向最新对象，确保弹窗里的字段(status/screenshot/...)跟着 poll 刷新
            //   不重指：current.value 是旧对象引用 → applyVendorOrders 重建 state.orders 数组后弹窗显示过期数据
            //   订单从远端消失(被 admin 删等极端情况)：current.value=null → modal 自动关闭
            if (openId) current.value = store.getOrder(openId) || null;
            if (r.pollIntervalMs !== undefined && r.pollIntervalMs !== currentInterval) {
              currentInterval = r.pollIntervalMs;
              if (timer) clearInterval(timer);
              if (currentInterval > 0) timer = setInterval(poll, currentInterval);
              // pollIntervalMs === 0：后端示意停止（防御性，目前商家端不会返 0，但接住保险）
            }
          }
        } catch (e) {} finally { polling = false; }
      }
      function onVisibilityChange() {
        if (document.visibilityState === 'visible') {
          // 切回前台：立即追一次（商家最在意"漏单"），并重启 setInterval
          poll();
          if (!timer && currentInterval > 0) timer = setInterval(poll, currentInterval);
        } else {
          // 切走：停 setInterval（in-flight poll 让它自然返回，没新 tick）
          if (timer) { clearInterval(timer); timer = null; }
        }
      }
      onMounted(() => {
        if (window.api && window.api.enabled()) {
          poll();
          timer = setInterval(poll, currentInterval);
          document.addEventListener('visibilitychange', onVisibilityChange);
        }
      });
      // 预加载：把列表里的支付截图提前在后台拉好，商家点开订单即秒显（图小、浏览器自动缓存，只拉一次）
      const _preloaded = new Set();
      function preloadShots(list) {
        (list || []).forEach((o) => {
          const u = o && o.screenshot;
          if (u && !store.utils.isImg(u) && !_preloaded.has(u)) { _preloaded.add(u); const im = new Image(); im.src = u; }
        });
      }
      watch(orders, (list) => preloadShots(list), { immediate: true });
      onUnmounted(() => {
        if (timer) { clearInterval(timer); timer = null; }
        document.removeEventListener('visibilitychange', onVisibilityChange);
      });
      // 批量送达（同地点多单一次搞定）
      const batchOpen = ref(false); const batchSel = reactive([]); const batchPhoto = ref('');
      const doingOrders = computed(() => orders.value.filter(function (o) { return o.status === 'cooking' || o.status === 'delivering'; }).slice().sort(function (a, b) { return String((a.customer || {}).building || '').localeCompare(String((b.customer || {}).building || '')); }));
      // 楼栋归并键：忽略空格/大小写/全角差异（A栋=A 栋=a栋=Ａ栋），缓解"相似但不一致"
      function normBuilding(s) { return String(s || '').replace(/\s+/g, '').toLowerCase().replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); }); }
      // 按归并键分组；组标题用该组第一单的原始楼栋名，组内每单仍显示完整原始地址供核对
      const doingGroups = computed(() => { var map = {}, order = []; doingOrders.value.forEach(function (o) { var k = normBuilding((o.customer || {}).building) || '其他'; if (!map[k]) { map[k] = { building: ((o.customer || {}).building) || '其他', orders: [] }; order.push(k); } map[k].orders.push(o); }); return order.map(function (k) { return map[k]; }); });
      function selectGroup(g) { var ids = g.orders.map(function (o) { return o.id; }); var allSel = ids.every(function (id) { return batchSel.indexOf(id) >= 0; }); ids.forEach(function (id) { var i = batchSel.indexOf(id); if (allSel) { if (i >= 0) batchSel.splice(i, 1); } else if (i < 0) batchSel.push(id); }); }
      function openBatch() { batchSel.splice(0); batchPhoto.value = ''; batchOpen.value = true; }
      function toggleBatch(id) { var i = batchSel.indexOf(id); if (i >= 0) batchSel.splice(i, 1); else batchSel.push(id); }
      function onBatchPhoto(e) { pickImage(e, function (d) { batchPhoto.value = d; }); }
      // H13 fix: add confirmation dialog before batch delivery
      function batchDeliverGo() { if (!batchSel.length) return; var n = batchSel.length; if (!window.confirm('确认将 ' + n + ' 个订单标记为已送达？此操作不可撤回。')) return; store.batchDeliver(batchSel.slice(), batchPhoto.value); store.toastSuccess('已送达 ' + n + ' 单' + (batchPhoto.value ? '，到货照片已发给这些客户' : '')); batchSel.splice(0); batchPhoto.value = ''; batchOpen.value = false; }
      function batchCopyGo() { var m = store.merchant; var shop = m ? m.name : '商家'; var t = '【' + shop + '】您的订单已送达 🎉 请查收，感谢惠顾！'; if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { store.toastSuccess('群发文案已复制'); }, function () { window.prompt('复制群发文案：', t); }); else window.prompt('复制群发文案：', t); }
      function st(s) { return STATUS_TEXT[s] || { label: s, cls: '' }; }
      // 两阶段下单：截图为空时，默认按"还在上传"处理
      //   - 老阈值 5min 在 3G/弱信号 + GAS 冷启动 + Drive 慢写下仍可能误判（实测 p99 ~10min）
      //   - 客户端 imgStatus='uploading'/'slow' 本地状态后端拿不到，所以这里靠"订单创建时间"近似推断
      //   - 改 15min（与客户端 uploadOrderShot 60s 兜底 + retry 续传链路对齐留余量），
      //     真正超过 15min 还没截图 → 大概率客户跑了或断网了，才提示商家
      function shotState(o) {
        if (o.screenshot) return { key: 'ok' };
        if (o.status === 'rejected' || o.status === 'cancelled') return { key: 'na' };
        return (Date.now() - (Number(o.createdAt) || 0) < 15 * 60 * 1000) ? { key: 'wait' } : { key: 'missing' };
      }
      // 通知客户（WhatsApp wa.me 免费跳转 / 复制文案）。大马号 0xxx → 60xxx
      function waPhone(p) { var d = String(p || '').replace(/\D/g, ''); if (!d) return ''; if (d.charAt(0) === '0') d = '60' + d.slice(1); else if (d.slice(0, 2) !== '60' && d.length <= 10) d = '60' + d; return d; }
      function notifyMsg(o) {
        var m = store.getMerchant(o.merchantId); var shop = m ? m.name : '商家';
        var items = (o.items || []).map(function (i) { return i.name + '×' + i.qty; }).join('，');
        var head;
        switch (o.status) {
          case 'cooking':   head = '您的订单已接单，正在备餐 👨‍🍳'; break;
          case 'delivering':head = '您的订单正在配送中 🛵'; break;
          case 'delivered': head = '您的订单已送达 🎉 请查收'; break;
          case 'rejected':  head = '抱歉，本单未能接受' + (o.rejectReason ? '（' + o.rejectReason + '）' : ''); break;
          case 'cancelled': head = '本单已取消'; break;
          default:          head = '您有订单状态更新';
        }
        return '【' + shop + '】' + (o.customer.name || '您好') + '，' + head + '\n订单 ' + o.id + '：' + items + '\n合计 ' + store.utils.rm(o.total) + '。';
      }
      function notifyWhatsApp(o) { var ph = waPhone(o.customer && o.customer.phone); if (!ph) { store.toastError('该客户没有有效手机号'); return; } window.open('https://wa.me/' + ph + '?text=' + encodeURIComponent(notifyMsg(o)), '_blank'); }
      function copyNotify(o) { var t = notifyMsg(o); if (navigator.clipboard) navigator.clipboard.writeText(t).then(function () { store.toastSuccess('通知文案已复制，粘贴到微信发给客户'); }, function () { window.prompt('复制此文案发给客户：', t); }); else window.prompt('复制此文案发给客户：', t); }
      function askReject(o) { current.value = null; rejecting.value = o; reasonChoice.value = reasons[0]; customReason.value = ''; }
      function confirmReject() {
        const reason = reasonChoice.value === '其他（自定义）' ? (customReason.value.trim() || '商家未通过对账') : reasonChoice.value;
        store.rejectOrder(rejecting.value.id, reason); rejecting.value = null;
      }
      function onPhoto(e, o) { pickImage(e, (d) => store.setDeliveryPhoto(o.id, d)); }
      // 优先调用微信原生图片预览（在微信里打开时可双指放大）；否则用站内灯箱
      function openShot(src) {
        if (!src) return;
        if (window.wx && typeof window.wx.previewImage === 'function') { try { window.wx.previewImage({ current: src, urls: [src] }); return; } catch (e) {} }
        zoom.value = src;
      }
      function openTab(src) { var safeSrc = String(src || ''); if (!/^(https:|data:image\/)/.test(safeSrc)) return; try { const w = window.open('', '_blank'); if (w) { var img = w.document.createElement('img'); img.src = safeSrc; img.style.maxWidth = '100%'; w.document.title = '支付截图'; w.document.body.style.cssText = 'margin:0;background:#000;display:flex;align-items:center;justify-content:center;min-height:100vh'; w.document.body.appendChild(img); w.document.close(); } else { window.open(safeSrc, '_blank'); } } catch (e) { window.open(safeSrc, '_blank'); } }
      // H18 fix: only show sample/test buttons in non-prod environments
      const isDev = (window.APP_CONFIG && window.APP_CONFIG.env !== 'prod');
      return { store, ui, current, zoom, orders, stats, groups, filter, timeFilter, timeFilters, counts, filtered, query, searching, reasons, rejecting, reasonChoice, customReason, st, shotState, askReject, confirmReject, onPhoto, openShot, openTab, isDev, notifyWhatsApp, copyNotify, batchOpen, batchSel, batchPhoto, doingOrders, openBatch, toggleBatch, onBatchPhoto, batchDeliverGo, batchCopyGo, doingGroups, selectGroup };
    },
  };

  // ---------- 菜单（分类管理） ----------
  window.MMenu = {
    template: `
      <div class="m-menu">
        <div class="cat-admin">
          <div class="card__label">📂 商品分类</div>
          <div class="cat-chips">
            <span class="cat-chip" v-for="c in store.merchant.categories" :key="c">{{ c }}
              <button class="cat-chip__x" v-if="store.merchant.categories.length>1" @click="delCat(c)">×</button>
            </span>
          </div>
          <div class="cat-add"><input v-model="newCat" placeholder="自定义分类，如：套餐 / 甜品" @keyup.enter="addCat" /><button class="btn btn--sm btn--primary" @click="addCat">添加</button></div>
        </div>

        <div class="skel-list" v-if="store.ui.merchantMenuLoading && !store.merchant.menu.length">
          <div class="m-dish skel-dish" v-for="n in 4" :key="'sk'+n"><div class="skel-thumb"></div><div class="skel-dish__body"><div class="skel-line skel-line--60"></div><div class="skel-line skel-line--40"></div></div></div>
        </div>

        <div class="cat-section" v-for="g in groups" :key="g.name" v-show="!(store.ui.merchantMenuLoading && !store.merchant.menu.length)">
          <div class="cat-section__head"><span>{{ g.name }}</span><span class="muted sm">{{ g.items.length }} 项</span></div>
          <div class="m-dish" v-for="m in g.items" :key="m.id">
            <div class="m-dish__imgwrap">
              <label class="m-dish__img">
                <img v-if="store.utils.isImg(m.image)" :src="m.image" alt="" />
                <span v-else class="m-dish__emoji">{{ store.utils.dishEmoji(m) }}</span>
                <input type="file" accept="image/*" @change="onImg($event, m)" hidden />
                <span class="m-dish__cam">📷 上传</span>
              </label>
              <button class="emoji-pick-btn" @click="openEmoji(m)" v-if="!store.utils.isImg(m.image)">换图标</button>
              <button class="emoji-pick-btn" @click="set(m,'image','')" v-else>用图标</button>
            </div>
            <div class="m-dish__main">
              <div class="m-dish__top">
                <input class="m-dish__name" :value="m.name" @change="set(m,'name',$event.target.value)" placeholder="商品名" />
                <label class="price-edit m-dish__price">RM <input type="number" step="0.5" min="0" :value="m.price" @change="store.updatePrice(store.merchant.id, m.id, $event.target.value)" /></label>
              </div>
              <input class="m-dish__desc" :value="m.desc" @change="set(m,'desc',$event.target.value)" placeholder="添加描述（选填）" />
              <div class="m-dish__row">
                <button class="chip" :class="m.available ? 'st-delivered' : 'st-rejected'" @click="store.toggleSoldOut(store.merchant.id, m.id)">{{ m.available ? '在售' : '售罄' }}</button>
                <select class="cat-select" :value="m.category" @change="set(m,'category',$event.target.value)">
                  <option v-for="c in store.merchant.categories" :key="c" :value="c">{{ c }}</option>
                </select>
                <label class="price-edit">库存 <input type="number" min="0" :value="m.stock==null?'':m.stock" placeholder="不限" @change="set(m,'stock', $event.target.value===''? null : Math.max(0,Number($event.target.value)))" /></label>
                <button class="link-btn m-dish__cfg" @click="editCfg(m)">规格/折扣<span v-if="(m.optionGroups&&m.optionGroups.length)||store.utils.hasDiscount(m)"> ·已设</span></button>
                <button class="m-dish__del" @click="del(m)" title="删除商品" aria-label="删除商品">🗑</button>
              </div>
            </div>
          </div>
          <button class="add-dish-btn" @click="store.addMenuItem(store.merchant.id, g.name)">＋ 在「{{ g.name }}」添加商品</button>
        </div>

        <p class="muted center sm">建议上传真实照片更吸引下单；没有照片时点「换图标」选一个，列表就不会空。</p>

        <!-- Emoji 图标选择器（带搜索） -->
        <div class="modal" v-if="emojiFor" @click.self="emojiFor=null">
          <div class="modal__panel">
            <div class="modal__head"><span>选择图标</span><button class="link-btn" @click="emojiFor=null">关闭</button></div>
            <input class="emoji-search" v-model="emojiQ" placeholder="搜索：鸡 / 饭 / 面 / 奶茶 / 甜品 / chicken …" />
            <div class="emoji-grid">
              <button class="emoji-cell" v-for="x in filteredEmojis" :key="x.e" @click="chooseEmoji(x.e)">{{ x.e }}</button>
            </div>
            <p class="muted sm" v-if="!filteredEmojis.length">没有匹配的图标，换个词试试。</p>
          </div>
        </div>

        <!-- 规格 / 折扣 编辑 -->
        <div class="modal" v-if="cfgItem" @click.self="cfgItem=null">
          <div class="modal__panel">
            <div class="modal__head"><span>规格 / 折扣 · {{ cfgItem.name }}</span><button class="link-btn" @click="cfgItem=null">关闭</button></div>

            <div class="cfg-sec">
              <label class="fee-toggle"><input type="checkbox" v-model="draft.discount.enabled" /><span>开启折扣</span></label>
              <div class="cfg-row" v-if="draft.discount.enabled">
                <select class="cat-select" v-model="draft.discount.type"><option value="percent">按百分比 %</option><option value="fixed">直接减 RM</option></select>
                <input class="num-in" type="number" min="0" v-model.number="draft.discount.value" :placeholder="draft.discount.type==='percent'?'如 20':'如 1.5'" />
                <span class="muted sm">{{ draft.discount.type==='percent' ? '%' : 'RM' }}</span>
              </div>
            </div>

            <div class="cfg-sec">
              <div class="card__label">规格组（如 份量=单选 / 加料=多选）</div>
              <div class="opt-edit" v-for="(g,gi) in draft.optionGroups" :key="gi">
                <div class="opt-edit__head">
                  <input class="opt-edit__name" v-model="g.name" placeholder="规格组名称" />
                  <select class="cat-select" v-model="g.type"><option value="single">单选</option><option value="multi">多选</option></select>
                  <label class="fee-toggle sm"><input type="checkbox" v-model="g.required" /><span>必选</span></label>
                  <button class="link-btn danger-text" @click="draft.optionGroups.splice(gi,1)">删组</button>
                </div>
                <div class="opt-edit__opt" v-for="(o,oi) in g.options" :key="oi">
                  <input v-model="o.name" placeholder="选项名" />
                  <span class="muted sm">+RM</span><input class="num-in" type="number" min="0" step="0.5" v-model.number="o.price" />
                  <button class="link-btn danger-text" @click="g.options.splice(oi,1)">×</button>
                </div>
                <button class="link-btn" @click="g.options.push({id:'o'+Date.now(),name:'新选项',price:0})">＋ 选项</button>
              </div>
              <button class="btn btn--sm btn--ghost" @click="draft.optionGroups.push({id:'g'+Date.now(),name:'新规格组',type:'single',required:true,max:0,options:[]})">＋ 添加规格组</button>
            </div>

            <button class="btn btn--primary btn--block" @click="saveCfg">保存</button>
          </div>
        </div>
      </div>
    `,
    setup() {
      const newCat = ref('');
      const cfgItem = ref(null);
      const draft = reactive({ discount: { enabled: false, type: 'percent', value: 0 }, optionGroups: [] });
      function editCfg(m) {
        cfgItem.value = m;
        draft.discount = Object.assign({ enabled: false, type: 'percent', value: 0 }, m.discount || {});
        draft.optionGroups = JSON.parse(JSON.stringify(m.optionGroups || []));
      }
      function saveCfg() {
        const disc = draft.discount.enabled && Number(draft.discount.value) > 0 ? { enabled: true, type: draft.discount.type, value: Number(draft.discount.value) } : null;
        store.saveItemConfig(store.merchant.id, cfgItem.value.id, { optionGroups: draft.optionGroups, discount: disc });
        cfgItem.value = null;
      }
      const emojiFor = ref(null); const emojiQ = ref('');
      const filteredEmojis = computed(() => {
        const q = emojiQ.value.trim().toLowerCase();
        if (!q) return store.utils.emojiList;
        return store.utils.emojiList.filter((x) => x.e === q || x.k.toLowerCase().indexOf(q) >= 0);
      });
      function openEmoji(m) { emojiFor.value = m; emojiQ.value = ''; }
      function chooseEmoji(e) { if (emojiFor.value) { store.updateItemField(store.merchant.id, emojiFor.value.id, 'image', ''); store.updateItemField(store.merchant.id, emojiFor.value.id, 'emoji', e); } emojiFor.value = null; }
      const groups = computed(() => {
        // 商家端显示全部（含售罄），且空分类也显示出来方便添加
        const m = store.merchant; if (!m) return [];
        return m.categories.map((c) => ({ name: c, items: m.menu.filter((it) => (it.category || m.categories[0]) === c) }));
      });
      function addCat() { store.addCategory(store.merchant.id, newCat.value); newCat.value = ''; }
      function delCat(c) {
        const n = store.merchant.menu.filter((it) => (it.category || store.merchant.categories[0]) === c).length;
        const msg = n ? '删除分类「' + c + '」？该分类下 ' + n + ' 个菜品会移到第一个分类。' : '删除分类「' + c + '」？';
        if (window.confirm(msg)) store.removeCategory(store.merchant.id, c);
      }
      function set(m, field, val) { store.updateItemField(store.merchant.id, m.id, field, val); }
      // 商品图：宽度≤500px、WebP 质量 0.6，最省空间
      function onImg(e, m) { pickImage(e, (d) => store.updateItemField(store.merchant.id, m.id, 'image', d), { maxWidth: 500, quality: 0.6 }); }
      function del(m) { if (window.confirm('确定删除「' + m.name + '」？删除后底部会出现「撤销」。')) store.removeMenuItem(store.merchant.id, m.id); }
      return { store, newCat, groups, addCat, delCat, set, onImg, del, emojiFor, emojiQ, filteredEmojis, openEmoji, chooseEmoji, cfgItem, draft, editCfg, saveCfg };
    },
  };

  // ---------- 设置 ----------
  window.MSettings = {
    template: `
      <div class="m-settings">
        <div class="card">
          <div class="card__label">🏪 营业状态 · 当前
            <span class="pill-tag" :class="store.isOpen(store.merchant) ? 'pill-tag--open' : 'pill-tag--closed'">{{ store.isOpen(store.merchant) ? '营业中' : '休息中' }}</span>
          </div>
          <label class="fee-toggle" style="margin-bottom:10px"><input type="checkbox" v-model="store.merchant.settings.hours.auto" /><span>按固定时间自动营业/休息</span></label>

          <!-- 手动模式 -->
          <button v-if="!store.merchant.settings.hours.auto" class="btn" :class="store.merchant.open ? 'btn--primary' : 'btn--ghost'" @click="store.toggleOpen(store.merchant.id)">{{ store.merchant.open ? '营业中（点击改休息）' : '休息中（点击改营业）' }}</button>

          <!-- 自动模式：营业时段 + 假期 -->
          <template v-else>
            <div class="range-edit" style="margin-bottom:12px">营业 <input type="time" v-model="store.merchant.settings.hours.openTime" /> 至 <input type="time" v-model="store.merchant.settings.hours.closeTime" /></div>
            <div class="card__label" style="margin-top:4px">每周营业日（点亮=营业，灰色=休息）</div>
            <div class="weekday-row">
              <button v-for="d in weekdays" :key="d.idx" class="weekday-btn" :class="{ on: store.merchant.settings.hours.openDays[d.idx] }" @click="store.toggleDay(store.merchant.id, d.idx)">{{ d.label }}</button>
            </div>
            <p class="muted sm">到点自动开关，无需手动。没有固定时间就关掉上面开关，改用手动切换。</p>
          </template>
        </div>
        <div class="card">
          <div class="card__label">🛎️ 接单时间（由你决定）</div>
          <label class="fee-toggle"><input type="checkbox" v-model="store.merchant.settings.preorder" /><span>允许「营业前提前下单」（预订），到点再配送</span></label>
          <p class="muted sm">{{ store.merchant.settings.preorder ? '✅ 休息中客户也能先下单预订。' : '关闭＝营业了才接单，休息中只能浏览菜单。' }}下单截止时间在下方「固定配送时段」里按需调（不一定 20 分钟）。</p>
        </div>
        <div class="card">
          <div class="card__label">📝 客户备注 / 特殊需求</div>
          <label class="fee-toggle"><input type="checkbox" :checked="store.merchant.settings.allowRemark !== false" @change="store.merchant.settings.allowRemark = $event.target.checked" /><span>允许客户在结算时填写备注/需求（如少辣、不要葱、放门口）</span></label>
          <p class="muted sm">{{ store.merchant.settings.allowRemark !== false ? '✅ 客户结算页会显示备注框。' : '已关闭：客户结算页不再显示备注框，客户无法填写需求。' }}</p>
        </div>
        <div class="card">
          <div class="card__label">🔔 新单提示音</div>
          <label class="fee-toggle"><input type="checkbox" :checked="store.merchant.settings.soundOn !== false" @change="store.merchant.settings.soundOn = $event.target.checked" /><span>来新订单时响铃 + 震动提醒</span></label>
          <p class="muted sm">{{ store.merchant.settings.soundOn !== false ? '✅ 来新单会响一声提醒。' : '已静音：来新单不响（仍可在订单页看到红点）。' }}</p>
        </div>
        <div class="card">
          <div class="card__label">📣 送达通知</div>
          <p class="muted sm">所有订单：客户在订单页都会<b>实时</b>看到进度与「已送达」+到货照片（自动、免设置，这是统一保障）。</p>
          <label class="fee-toggle"><input type="checkbox" v-model="store.merchant.settings.waNotify" /><span>我用 WhatsApp —— 送达后在订单里显示「一键 WhatsApp 通知」</span></label>
          <p class="muted sm">没有 WhatsApp 也行：用「复制文案」粘到微信/短信发，或直接靠订单页实时状态。</p>
        </div>
        <div class="card">
          <div class="card__label">🚚 外送服务</div>
          <label class="fee-toggle"><input type="checkbox" v-model="store.merchant.settings.deliveryOffered" /><span>本店提供外送服务（关闭后客户端会显示「不提供外送」）</span></label>
        </div>

        <div class="card" v-if="store.merchant.settings.deliveryOffered">
          <div class="card__label">🏢 配送楼栋（客户下单从这里选，避免地址写乱）
            <span class="muted sm" style="float:right">已选 {{ (store.merchant.settings.coverage||[]).length }} / 25</span>
          </div>
          <p class="muted sm">勾选你配送的楼栋（最多 25 个，避免运力撑不住）；同社区其他商家加过的会出现在这里供勾选，没有的在下面添加（会进社区共享池，别家也能勾到）。</p>
          <div class="cov-grid" v-if="store.hubBuildings(store.merchant.hubId).length">
            <label class="cov-chip" v-for="b in store.hubBuildings(store.merchant.hubId)" :key="b" :class="{on: (store.merchant.settings.coverage||[]).indexOf(b)>=0}">
              <input type="checkbox" :checked="(store.merchant.settings.coverage||[]).indexOf(b)>=0" @change="store.toggleCoverage(store.merchant.id, b)" hidden />{{ b }}
            </label>
          </div>
          <p class="muted sm" v-else>本社区暂无楼栋，添加第一个 👇</p>
          <div class="cat-add"><input v-model="newBld" placeholder="添加楼栋，如：A 栋 / 宿舍 3 座" @keyup.enter="addBld" /><button class="btn btn--sm btn--primary" @click="addBld">添加</button></div>
        </div>

        <!-- 新单响铃（Web Audio · 零素材） -->
        <div class="card" v-if="store.merchant.settings.ring">
          <div class="card__label">🔔 新单响铃 <span class="muted sm">未接单时持续响 + N 分钟升级</span></div>
          <label class="fee-toggle"><input type="checkbox" v-model="store.merchant.settings.ring.enabled" /><span>开启新单响铃（推荐）</span></label>
          <div v-if="store.merchant.settings.ring.enabled" class="ring-settings">
            <div class="ring-row">
              <span>🔊 音量</span>
              <input type="range" min="0" max="1" step="0.05" v-model.number="store.merchant.settings.ring.volume" />
              <span class="muted sm">{{ Math.round((store.merchant.settings.ring.volume||0) * 100) }}%</span>
              <button class="btn btn--sm btn--ghost" @click="testRing">试听</button>
            </div>
            <div class="ring-row">
              <span>⏱ 响铃间隔</span>
              <input type="number" min="0.4" max="5" step="0.1" v-model.number="store.merchant.settings.ring.intervalSec" /><span class="muted sm">秒</span>
            </div>
            <div class="ring-row">
              <span>⏹ 响多久自停</span>
              <input type="number" min="5" max="120" v-model.number="store.merchant.settings.ring.maxDurationSec" /><span class="muted sm">秒</span>
            </div>
            <div class="ring-row">
              <span>⚠ 未接单升级响铃</span>
              <input type="number" min="1" max="30" v-model.number="store.merchant.settings.ring.escalateAfterMin" /><span class="muted sm">分钟后再响一次</span>
            </div>
            <div class="ring-row">
              <span>🌙 勿扰时段</span>
              <input type="time" v-model="store.merchant.settings.ring.quietStart" />
              <span class="muted sm">至</span>
              <input type="time" v-model="store.merchant.settings.ring.quietEnd" />
            </div>
            <p class="muted sm">勿扰时段本地不响，但手机系统 Web Push 通知不受影响（你可以静音手机自行决定）。留空两端 = 全天不勿扰。</p>
          </div>
        </div>

        <!-- 客户联系号码（WhatsApp） -->
        <!-- 加归一化预览：用户输入后立即显示"客户看到的格式"+"wa.me 链接"，避免怀疑值被截 -->
        <div class="card">
          <div class="card__label">💬 客户 WhatsApp 联系号 <span class="muted sm">客户在订单页可一键 wa.me 找你</span></div>
          <div class="ring-row">
            <span>WhatsApp 号</span>
            <input type="tel" inputmode="numeric" maxlength="20" v-model="store.merchant.settings.waNumber" @blur="normalizeWa" placeholder="例：0123456789（大马号自动加 60）" style="flex:1;min-width:160px;padding:6px 8px;border:1px solid var(--line,#e5e7eb);border-radius:6px" />
          </div>
          <p class="muted sm" v-if="waPreview.ok" style="color:var(--green-d)">✓ 客户将看到：<b>{{ waPreview.display }}</b> · 点击跳 <code style="font-size:11px">wa.me/{{ waPreview.intl }}</code></p>
          <p class="muted sm" v-else-if="store.merchant.settings.waNumber" style="color:#d97706">⚠ {{ waPreview.err }}（{{ waPreview.digits }} 位）— 客户点击不会跳转</p>
          <p class="muted sm">留空则客户端不展示「联系商家」按钮。这只是一个 wa.me 跳转链接，不会自动发送消息。</p>
        </div>

        <div class="card" v-if="store.merchant.settings.deliveryOffered">
          <div class="card__label">🛵 配送模式</div>
          <div class="mode-switch">
            <button class="mode-switch__opt" :class="{active: store.merchant.settings.deliveryMode==='fixed'}" @click="store.setDeliveryMode(store.merchant.id,'fixed')"><b>固定时间</b><span>客户从设定时段选</span></button>
            <button class="mode-switch__opt" :class="{active: store.merchant.settings.deliveryMode==='flexible'}" @click="store.setDeliveryMode(store.merchant.id,'flexible')"><b>灵活时间</b><span>显示"预计 X 分钟"</span></button>
          </div>
        </div>
        <div class="card">
          <div class="card__label">📲 收款码（客户结算时扫码付款，至少 1 个，可多传如支付宝）</div>
          <div class="qr-manage">
            <div class="qr-manage__item" v-for="q in store.merchant.payQRs" :key="q.id">
              <img class="qr-manage__img" :src="q.image" alt="" />
              <input class="qr-manage__label" :value="q.label" @change="store.updatePayQRLabel(store.merchant.id, q.id, $event.target.value)" />
              <button class="link-btn danger-text" @click="delQR(q)" v-if="store.merchant.payQRs.length>1">删除</button>
            </div>
          </div>
          <label class="upload__drop sm-drop"><input type="file" accept="image/*" @change="onQR" hidden /><span class="upload__plus">＋</span><span>上传收款码</span></label>
          <p class="error" v-if="store.merchant.payQRs.length===0">⚠ 还没有收款码，客户将无法付款，请至少上传一个。</p>
        </div>

        <div class="card">
          <div class="card__label">💰 附加费用（勾选后自动加进客户订单合计）</div>
          <div class="fee-row">
            <label class="fee-toggle"><input type="checkbox" v-model="store.merchant.settings.fees.packaging.enabled" /><span>收取打包费</span></label>
            <label class="price-edit">RM <input type="number" step="0.5" min="0" v-model.number="store.merchant.settings.fees.packaging.amount" :disabled="!store.merchant.settings.fees.packaging.enabled" /></label>
          </div>
          <div class="fee-row">
            <label class="fee-toggle"><input type="checkbox" v-model="store.merchant.settings.fees.delivery.enabled" /><span>收取配送费</span></label>
            <label class="price-edit">RM <input type="number" step="0.5" min="0" v-model.number="store.merchant.settings.fees.delivery.amount" :disabled="!store.merchant.settings.fees.delivery.enabled" /></label>
          </div>
        </div>

        <div class="card" v-if="store.merchant.settings.deliveryMode==='fixed'">
          <div class="card__label">⏰ 固定配送时段</div>
          <div class="slot-edit" v-for="(slot,i) in store.merchant.settings.fixedSlots" :key="i">
            <input type="time" v-model="store.merchant.settings.fixedSlots[i]" />
            <button class="link-btn" @click="store.merchant.settings.fixedSlots.splice(i,1)" v-if="store.merchant.settings.fixedSlots.length>1">删</button>
          </div>
          <button class="btn btn--sm btn--ghost" @click="store.merchant.settings.fixedSlots.push('18:00')">＋ 增加时段</button>
          <div class="range-edit" style="margin-top:12px">⏳ 下单截止：时段开始前 <input type="number" min="0" v-model.number="store.merchant.settings.cutoffMins" /> 分钟</div>
        </div>
        <div class="card" v-else>
          <div class="card__label">⏱ 预计送达区间（分钟）</div>
          <div class="range-edit"><input type="number" min="1" v-model.number="store.merchant.settings.flexibleMin" /> 至 <input type="number" min="1" v-model.number="store.merchant.settings.flexibleMax" /> 分钟</div>
          <div class="range-edit" style="margin-top:12px">⏳ 每日接单截止 <input type="time" v-model="store.merchant.settings.flexCloseTime" /></div>
        </div>
        <contact-panel role="merchant"></contact-panel>
        <!-- C6 fix: removed resetAll from merchant UI (admin-only now via admin.html test tab) -->
      </div>
    `,
    setup() {
      const weekdays = [{ idx: 1, label: '一' }, { idx: 2, label: '二' }, { idx: 3, label: '三' }, { idx: 4, label: '四' }, { idx: 5, label: '五' }, { idx: 6, label: '六' }, { idx: 0, label: '日' }];
      // 设置类(费用/时段/截止/营业时间)多为 v-model，无方法可挂 —— 用防抖 watch 自动存后端
      let t = null;
      watch(() => JSON.stringify({ s: store.merchant && store.merchant.settings, o: store.merchant && store.merchant.open }), () => {
        if (t) clearTimeout(t); const mid = store.merchant && store.merchant.id;
        t = setTimeout(() => { if (mid) store._syncMerchantConfig(mid); }, 700);
      });
      function reset() { if (window.confirm('确定清空全部数据并退出登录，恢复到初始状态吗？')) store.resetAll(); }
      function testRing() {
        var ok = window.merchantRinger && window.merchantRinger.testBeep(store.merchant && store.merchant.settings && store.merchant.settings.ring && store.merchant.settings.ring.volume);
        if (!ok) {
          try { store.toastError && store.toastError('请先点击页面任意位置，再点试听'); } catch (_) {}
        }
      }
      function onQR(e) { pickImage(e, (d) => { const label = window.prompt('给这个收款码起个名字：', "Touch 'n Go") || '收款码'; store.addPayQR(store.merchant.id, label, d); }); }
      function delQR(q) { if (window.confirm('删除收款码「' + q.label + '」？')) store.removePayQR(store.merchant.id, q.id); }
      const newBld = ref('');
      function addBld() { var n = (newBld.value || '').trim(); if (n) { store.addBuildingToHub(store.merchant.id, n); newBld.value = ''; } }
      // waNumber 归一化 + 预览：用户输完失焦时把内容压成纯数字、超 15 位截断并 toast
      //   解决两个隐患：① 误输入空格/横杠/字母 ② 输入超长被静默存（用户怀疑"页面把号码截断了"）
      function normalizeWa() {
        var m = store.merchant; if (!m) return;
        var raw = String(m.settings.waNumber || '');
        var d = raw.replace(/\D/g, '');
        if (d.length > 15) {
          store.toastError && store.toastError('手机号位数过多，已截到前 15 位');
          d = d.slice(0, 15);
        }
        // 仅当真的有变化才写回（v-model 已经把同值写回会触发 watch → sync 后端，浪费一次 saveVendorConfig）
        if (d !== raw) m.settings.waNumber = d;
      }
      // 预览：把 store.utils.waPhone / displayPhone 复用到当前 waNumber，做即时回显
      //   ok=true → 显示 "+60 16-510 1001 · wa.me/60165101001"
      //   ok=false → 红字提示位数不对，避免商家以为保存了
      const waPreview = computed(function () {
        var raw = (store.merchant && store.merchant.settings && store.merchant.settings.waNumber) || '';
        var d = String(raw).replace(/\D/g, '');
        if (!d) return { ok: false, digits: 0, err: '请输入号码' };
        if (d.length < 7) return { ok: false, digits: d.length, err: '位数过短（至少 7 位）' };
        if (d.length > 15) return { ok: false, digits: d.length, err: '位数过长（最多 15 位）' };
        return { ok: true, display: store.utils.displayPhone(d), intl: store.utils.waPhone(d) };
      });
      return { store, weekdays, reset, onQR, delQR, newBld, addBld, testRing, normalizeWa, waPreview };
    },
  };
})();
