/**
 * 入口测试：Worker 的 fetch 边界行为与 Webhook 安全校验
 */
const worker = (await import('../src/index.js')).default;

/* mock 掉 Telegram API，避免测试真的发网络请求 */
const calls = [];
const json = (obj) => new Response(JSON.stringify(obj), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  calls.push({ url: u, opts });
  const method = u.split('/').pop();
  if (method === 'getMe') return json({ ok: true, result: { id: 1, username: 'testbot', first_name: 'Test' } });
  if (method === 'setWebhook' || method === 'deleteWebhook') return json({ ok: true, result: true });
  if (method === 'getWebhookInfo') {
    return json({ ok: true, result: { url: 'https://x.workers.dev', pending_update_count: 0, last_error_message: null } });
  }
  if (u.includes('translate.googleapis.com')) {
    return json([[['你好世界', 'hello', null, null, 10]], null, 'en']);
  }
  if (u.includes('api.mymemory.translated.net')) {
    return json({ responseStatus: 200, responseData: { translatedText: '你好世界' } });
  }
  return json({ ok: true, result: { message_id: 1 } });
};

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${extra ? `\n      ${extra}` : ''}`); }
};

const noopCtx = { waitUntil() {} };
const req = (method, path = '/', headers = {}, body) =>
  new Request(`https://x.workers.dev${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });

const SECRET = 'right-secret';
const authHeaders = { 'X-Telegram-Bot-Api-Secret-Token': SECRET };
const env = { BOT_TOKEN: '123:TEST', WEBHOOK_SECRET: SECRET, BOT_KV: {} };

console.log('\n【导出契约】');
check('导出 fetch', typeof worker.fetch === 'function');
check('导出 scheduled', typeof worker.scheduled === 'function');

console.log('\n【状态页】');
const page = await worker.fetch(req('GET'), { BOT_KV: {}, DEFAULT_TZ: 'Asia/Shanghai' }, noopCtx);
const html = await page.text();
check('GET 返回 200', page.status === 200);
check('Content-Type 是 HTML', (page.headers.get('Content-Type') || '').includes('text/html'));
check('列出全部插件', ['天气', '监控', '提醒', '翻译', '设置', '帮助'].every((n) => html.includes(n)));
check('提示缺失的配置项', html.includes('还差几步') && html.includes('BOT_TOKEN'));
check('配置齐全时给出注册指引', (await (await worker.fetch(req('GET'), env, noopCtx)).text()).includes('注册 Webhook'));

console.log('\n【路由边界】');
check('PUT 返回 405', (await worker.fetch(req('PUT'), env, noopCtx)).status === 405);
check('未知路径返回 404', (await worker.fetch(req('POST', '/nope', authHeaders, '{}'), env, noopCtx)).status === 404);
check('/webhook 路径可用', (await worker.fetch(req('POST', '/webhook', authHeaders, '{}'), env, noopCtx)).status === 200);

console.log('\n【Webhook 安全校验】');
check('缺失 secret 头返回 403', (await worker.fetch(req('POST', '/', {}, '{}'), env, noopCtx)).status === 403);
check('错误 secret 返回 403', (await worker.fetch(req('POST', '/', { 'X-Telegram-Bot-Api-Secret-Token': 'wrong' }, '{}'), env, noopCtx)).status === 403);
check('正确 secret 返回 200', (await worker.fetch(req('POST', '/', authHeaders, '{}'), env, noopCtx)).status === 200);
check('非法 JSON 返回 400', (await worker.fetch(req('POST', '/', authHeaders, 'not json'), env, noopCtx)).status === 400);
check('未配置 secret 时不校验（兼容）',
  (await worker.fetch(req('POST', '/', {}, '{}'), { BOT_TOKEN: 'x', BOT_KV: {} }, noopCtx)).status === 200);

console.log('\n【一键注册 Webhook /setup】');
check('缺 WEBHOOK_SECRET 返回 400',
  (await worker.fetch(req('GET', '/setup?key=abc'), { BOT_TOKEN: 'x', BOT_KV: {} }, noopCtx)).status === 400);
check('缺 BOT_TOKEN 返回 400',
  (await worker.fetch(req('GET', `/setup?key=${SECRET}`), { WEBHOOK_SECRET: SECRET, BOT_KV: {} }, noopCtx)).status === 400);
check('key 不正确返回 403',
  (await worker.fetch(req('GET', '/setup?key=wrong'), env, noopCtx)).status === 403);
check('缺 key 参数返回 403',
  (await worker.fetch(req('GET', '/setup'), env, noopCtx)).status === 403);

calls.length = 0;
let setupRes = await worker.fetch(req('GET', `/setup?key=${SECRET}`), env, noopCtx);
let setupBody = await setupRes.text();
const setCall = calls.find((c) => c.url.endsWith('/setWebhook'));
check('正确 key 返回 200', setupRes.status === 200);
check('调用了 setWebhook', Boolean(setCall));
check('Webhook 指向自己', setCall && JSON.parse(setCall.opts.body).url === 'https://x.workers.dev',
  setCall ? setCall.opts.body : '未调用');
check('带回 secret_token 校验', setCall && JSON.parse(setCall.opts.body).secret_token === SECRET);
check('页面显示机器人用户名', setupBody.includes('@testbot'));

calls.length = 0;
check('action=info 调用 getWebhookInfo',
  (await worker.fetch(req('GET', `/setup?key=${SECRET}&action=info`), env, noopCtx)).status === 200 &&
  calls.some((c) => c.url.endsWith('/getWebhookInfo')));

calls.length = 0;
await worker.fetch(req('GET', `/setup?key=${SECRET}&action=delete`), env, noopCtx);
check('action=delete 调用 deleteWebhook', calls.some((c) => c.url.endsWith('/deleteWebhook')));

console.log('\n【运行诊断】');
check('diagnose 需要 key 鉴权',
  (await worker.fetch(req('GET', '/setup?action=diagnose'), env, noopCtx)).status === 403);

const diagRes = await worker.fetch(req('GET', `/setup?key=${SECRET}&action=diagnose`), env, noopCtx);
const diag = await diagRes.text();
check('diagnose 返回 200', diagRes.status === 200);
check('显示代码版本', diag.includes('代码版本') && diag.includes('多源翻译降级'));
check('列出全部绑定项',
  ['BOT_TOKEN', 'WEBHOOK_SECRET', 'BOT_KV', 'AI'].every((n) => diag.includes(n)));
check('未绑定 AI 时给出提示', diag.includes('可能遇到 429'));
check('实测了翻译源', diag.includes('翻译源实测') && diag.includes('Google'));
check('显示降级顺序', diag.includes('降级顺序'));
check('诊断页不泄露密钥值', !diag.includes('123:TEST'));

const diagWithAI = await (await worker.fetch(
  req('GET', `/setup?key=${SECRET}&action=diagnose`),
  { ...env, AI: { run: async () => ({ translated_text: '你好' }) } },
  noopCtx
)).text();
check('绑定 AI 后诊断显示已绑定', diagWithAI.includes('优先走 Workers AI'));
check('绑定 AI 后降级链以 ai 开头', diagWithAI.includes('<code>ai</code>'));

console.log('\n【响应速度】');
// fetch 必须立刻返回，不能等业务处理完（否则 Telegram 会重推）
let resolved = false;
const slowEnv = {
  BOT_TOKEN: '123:TEST', WEBHOOK_SECRET: SECRET, BOT_KV: {},
};
const t0 = Date.now();
const r = await worker.fetch(req('POST', '/', authHeaders, JSON.stringify({
  update_id: 1,
  message: {
    message_id: 1, date: Math.floor(Date.now() / 1000),
    chat: { id: 1, type: 'private' }, from: { id: 1 }, text: '/help',
  },
})), slowEnv, { waitUntil: () => { resolved = true; } });
const cost = Date.now() - t0;
check('立即返回 200', r.status === 200);
check('业务处理被交给 waitUntil', resolved);
check(`响应耗时 < 50ms（实际 ${cost}ms）`, cost < 50);

console.log(`\n${'─'.repeat(46)}`);
console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / ${pass} 项通过`);
process.exit(fail === 0 ? 0 : 1);
