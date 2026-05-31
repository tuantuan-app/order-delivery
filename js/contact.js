/*
 * contact.js —— 「合作 & 反馈」面板（客户端 + 商家端共用）
 *   纯前端：反馈/合作意向通过 WhatsApp(wa.me) 或 Email(mailto) 直达平台，零后端、零成本。
 *   复用 [[notify-customer]] 的 wa.me 跳转思路。role: 'customer' | 'merchant' 切换文案。
 */
(function () {
  const { ref, computed } = Vue;
  const PHONE_INTL = '60132831238';   // 0132831238 → 马来国际格式（去 0 加 60）
  const PHONE_DISPLAY = '013-283 1238';
  const EMAIL = 'nihaotuantuan@gmail.com';

  window.ContactPanel = {
    props: { role: { type: String, default: 'customer' } },
    template: `
      <div class="contact">
        <div class="contact__hero">
          <div class="contact__icon">🤝</div>
          <div class="contact__title">{{ role === 'merchant' ? '商务合作 & 反馈' : '合作 & 反馈' }}</div>
          <p class="contact__sub">{{ sub }}</p>
        </div>
        <textarea class="contact__ta" v-model="msg" rows="3" :placeholder="placeholder" maxlength="500"></textarea>
        <button class="btn btn--block contact__wa" @click="sendWhatsApp"><span class="contact__wa-ico">💬</span> 通过 WhatsApp 发送</button>
        <button class="btn btn--block btn--ghost contact__email" @click="sendEmail">✉️ 通过 Email 发送</button>
        <div class="contact__direct">
          <div class="contact__row"><span class="contact__k">WhatsApp</span><a class="contact__v" :href="waLink" target="_blank" rel="noopener">{{ phoneDisplay }}</a></div>
          <div class="contact__row"><span class="contact__k">Email</span><a class="contact__v" :href="'mailto:' + email">{{ email }}</a></div>
        </div>
      </div>
    `,
    setup(props) {
      const msg = ref('');
      function tag() { return props.role === 'merchant' ? '【商家合作/反馈】' : '【用户反馈/合作】'; }
      function body() { return tag() + (msg.value ? '\n' + msg.value : ''); }
      const waLink = computed(() => 'https://wa.me/' + PHONE_INTL + '?text=' + encodeURIComponent(body()));
      const sub = computed(() => props.role === 'merchant'
        ? '想升级套餐、申请平台广告位，或对后台有任何建议？直接找我们。'
        : '想在平台开店合作，或对使用有任何反馈、建议？我们很想听到你的声音。');
      const placeholder = computed(() => props.role === 'merchant' ? '说说你的合作意向或建议…' : '写下你的反馈或合作想法…');
      function sendWhatsApp() { window.open(waLink.value, '_blank'); }
      function sendEmail() {
        var subject = props.role === 'merchant' ? '商家合作 / 反馈' : '用户反馈 / 合作';
        window.location.href = 'mailto:' + EMAIL + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(msg.value || '');
      }
      return { role: props.role, msg, sub, placeholder, waLink, sendWhatsApp, sendEmail, email: EMAIL, phoneDisplay: PHONE_DISPLAY };
    },
  };
})();
