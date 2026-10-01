#!/usr/bin/env node
/**
 * scripts/setup.mjs —— 命令行版 Webhook 设置脚本
 *
 * 说明：如果你走的是「Cloudflare 面板连 GitHub」部署，用不上这个脚本 ——
 *       直接在浏览器打开 https://你的地址.workers.dev/setup?key=WEBHOOK_SECRET 即可。
 *       本脚本适合本地 CLI 部署的用户，好处是能打印完整的 Webhook 状态用于排障。
 *
 * 用法：
 *   BOT_TOKEN=xxx WEBHOOK_SECRET=yyy node scripts/setup.mjs https://your-worker.workers.dev
 *
 * 不带地址参数运行时会打印当前 Webhook 状态。
 */

const token = process.env.BOT_TOKEN;
const secret = process.env.WEBHOOK_SECRET || '';
const url = process.argv[2] || process.env.WORKER_URL || '';

const API = 'https://api.telegram.org';

async function call(method, payload) {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload ?? {}),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method} 失败：${data.description}`);
  return data.result;
}

function die(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

if (!token) {
  die('缺少 BOT_TOKEN。用法：BOT_TOKEN=xxx node scripts/setup.mjs https://your-worker.workers.dev');
}

const me = await call('getMe');
console.log(`\n✔ 机器人身份：@${me.username}（${me.first_name}）`);

if (!url) {
  const info = await call('getWebhookInfo');
  console.log('\n当前 Webhook 状态：');
  console.log(`  URL:              ${info.url || '(未设置)'}`);
  console.log(`  待处理更新:        ${info.pending_update_count ?? 0}`);
  console.log(`  最近错误:          ${info.last_error_message || '无'}`);
  console.log('\n要设置 Webhook，请带上 Worker 地址再运行一次：');
  console.log('  node scripts/setup.mjs https://your-worker.workers.dev\n');
  process.exit(0);
}

if (!url.startsWith('https://')) {
  die('Webhook 地址必须是 https://，Telegram 不接受 http。');
}

if (!secret) {
  console.warn('⚠ 未提供 WEBHOOK_SECRET，Webhook 将不做来源校验（不推荐）。');
}

console.log(`\n正在把 Webhook 指向 ${url} ...`);

await call('setWebhook', {
  url,
  ...(secret ? { secret_token: secret } : {}),
  allowed_updates: ['message', 'edited_message', 'channel_post', 'callback_query'],
  drop_pending_updates: true,
});

const info = await call('getWebhookInfo');
console.log('\n✔ Webhook 设置完成');
console.log(`  URL:              ${info.url}`);
console.log(`  待处理更新:        ${info.pending_update_count ?? 0}`);
console.log(`  最近错误:          ${info.last_error_message || '无'}`);
console.log('\n现在去 Telegram 里给机器人发一条 /start 试试吧。\n');
