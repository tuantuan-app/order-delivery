/*
 * 一次性生成 VAPID 密钥对 + Worker 鉴权随机串
 * 用法：node scripts/gen-vapid.mjs
 *
 * 输出到 stdout：
 *   1. VAPID_JWK       —— 私钥 JWK JSON，作为 Worker secret
 *   2. VAPID_PUBLIC    —— uncompressed base64url，作为 Worker secret + 客户端 config
 *   3. WORKER_SECRET   —— 随机串，GAS ↔ Worker 鉴权用
 *   4. VAPID_SUBJECT   —— 你的 mailto:
 *
 * ⚠️ 不要 commit！直接照搬到 wrangler secret put 设置。
 */

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

const kp = await subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify']
);

// 私钥导出为 JWK（包含 d、x、y）
const jwk = await subtle.exportKey('jwk', kp.privateKey);
// 公钥导出为 raw（65 字节 uncompressed: 0x04 || x32 || y32）
const pubRaw = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));

// 32 字节随机的 Worker 鉴权 secret
const workerSecret = new Uint8Array(32);
webcrypto.getRandomValues(workerSecret);

const b64u = (buf) => Buffer.from(buf).toString('base64url');

const subject = 'mailto:nihaotuantuan@gmail.com';

const banner = (s) => `\n\x1b[36m=== ${s} ===\x1b[0m`;
const note = (s) => `\x1b[33m${s}\x1b[0m`;

console.log(banner('VAPID 密钥对 + Worker 鉴权串已生成（一次性，妥善保存）'));
console.log(note('⚠️ 不要 commit 到 git。直接复制到对应 wrangler secret put 命令里。\n'));

console.log('## 1) VAPID_JWK  ——  Worker 私钥（JSON 字符串，整体复制粘贴）');
console.log(JSON.stringify(jwk));

console.log('\n## 2) VAPID_PUBLIC  ——  Worker 公钥 / 也写到 js/config.js 给浏览器订阅用');
console.log(b64u(pubRaw));

console.log('\n## 3) WORKER_SECRET  ——  随机鉴权串（GAS 也存这一串）');
console.log(b64u(workerSecret));

console.log('\n## 4) VAPID_SUBJECT  ——  联系邮箱（push service 出问题时联系你）');
console.log(subject);

console.log(banner('下一步：把上面 4 个值设为 Worker secret'));
console.log(`
cd worker
wrangler secret put VAPID_JWK       # 粘贴 #1 的整段 JSON
wrangler secret put VAPID_PUBLIC    # 粘贴 #2
wrangler secret put WORKER_SECRET   # 粘贴 #3
wrangler secret put VAPID_SUBJECT   # 粘贴 #4

然后 wrangler deploy 一次。
`);
