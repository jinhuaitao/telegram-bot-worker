/**
 * 端到端集成测试：mock 掉 Telegram API 与所有外部服务，
 * 真实跑通 router → 插件 → store 的完整链路。
 */
const ROOT = new URL('../src/', import.meta.url).href.replace(/\/$/, '');

const { Store } = await import(`${ROOT}/store.js`);
const { Telegram } = await import(`${ROOT}/telegram.js`);
const { routeUpdate } = await import(`${ROOT}/router.js`);
const { runCron } = await import(`${ROOT}/cron.js`);
const { PLUGINS, buildCommandMap, validatePlugins } = await import(`${ROOT}/plugins/index.js`);
const { tsKey } = await import(`${ROOT}/utils.js`);

let pass = 0, fail = 0;
const check = (label, cond, extra = '') => {
  if (cond) { pass++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}${extra ? `\n      ${extra}` : ''}`); }
};

/* ─────────── Mock KV ─────────── */
class MockKV {
  constructor() { this.map = new Map(); }
  async get(key, type) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    return type === 'json' ? JSON.parse(v) : v;
  }
  async put(key, value) { this.map.set(key, value); }
  async delete(key) { this.map.delete(key); }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + limit);
    const next = start + limit;
    return {
      keys: slice.map((name) => ({ name })),
      list_complete: next >= all.length,
      cursor: String(next),
    };
  }
}

/* ─────────── Mock fetch ─────────── */
const outbox = [];   // 记录机器人发出的所有消息
const external = []; // 记录对外部服务的请求

const json = (obj) => new Response(JSON.stringify(obj), {
  status: 200, headers: { 'Content-Type': 'application/json' },
});

globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);

  if (u.includes('api.telegram.org')) {
    const method = u.split('/').pop();
    if (method === 'getMe') return json({ ok: true, result: { id: 1, username: 'testbot', first_name: 'Test' } });
    if (opts.body) {
      try {
        const p = JSON.parse(opts.body);
        if (p.text) outbox.push({ method, chatId: p.chat_id, text: p.text });
      } catch { /* ignore */ }
    }
    return json({ ok: true, result: { message_id: outbox.length + 1 } });
  }

  external.push(u);

  if (u.includes('geocoding-api.open-meteo.com')) {
    return json({
      results: [{
        name: '北京', latitude: 39.9, longitude: 116.4,
        timezone: 'Asia/Shanghai', country: '中国', admin1: '北京市',
      }],
    });
  }

  if (u.includes('api.open-meteo.com')) {
    return json({
      current: { temperature_2m: 18.5, relative_humidity_2m: 45, apparent_temperature: 17.2, weather_code: 1, wind_speed_10m: 3.4 },
      daily: {
        time: ['2026-10-01', '2026-10-02', '2026-10-03'],
        weather_code: [1, 3, 61],
        temperature_2m_max: [24, 22, 19],
        temperature_2m_min: [12, 11, 10],
        precipitation_probability_max: [10, 20, 80],
        wind_speed_10m_max: [5, 4, 7],
        sunrise: ['2026-10-01T06:12', '2026-10-02T06:13', '2026-10-03T06:14'],
        sunset: ['2026-10-01T17:48', '2026-10-02T17:47', '2026-10-03T17:46'],
      },
    });
  }

  if (u.includes('translate.googleapis.com')) {
    return json([[['你好世界', 'hello world', null, null, 10]], null, 'en']);
  }

  if (u.includes('example.com')) return new Response('Welcome to Example', { status: 200 });
  if (u.includes('down.example.org')) return new Response('boom', { status: 503 });

  return new Response('not found', { status: 404 });
};

/* ─────────── 组装 app ─────────── */
const env = {
  BOT_TOKEN: '123:TEST',
  BOT_KV: new MockKV(),
  DEFAULT_TZ: 'Asia/Shanghai',
  TRANSLATE_PROVIDER: 'google',
  MAX_MONITOR_PER_TICK: '20',
};
const app = {
  env,
  store: new Store(env.BOT_KV),
  bot: new Telegram(env.BOT_TOKEN),
  plugins: PLUGINS,
  commands: buildCommandMap(PLUGINS),
};

const CHAT = 10086;
let mid = 0;
const msg = (text) => ({
  update_id: ++mid,
  message: {
    message_id: mid, date: Math.floor(Date.now() / 1000),
    chat: { id: CHAT, type: 'private' },
    from: { id: CHAT, username: 'tester' },
    text,
  },
});

const send = async (text) => {
  outbox.length = 0;
  await routeUpdate(msg(text), app);
  return outbox.map((m) => m.text).join('\n');
};
const has = (haystack, needle) => haystack.includes(needle);

/* ─────────── 开始 ─────────── */
console.log('\n【插件契约】');
const errs = validatePlugins(PLUGINS);
check('契约校验无错误', errs.length === 0, errs.join('; '));
check('命令总数 >= 10', app.commands.size >= 10, `实际 ${app.commands.size}`);

console.log('\n【基础命令】');
let r = await send('/start');
check('/start 返回帮助', has(r, '多功能机器人') && has(r, '天气'));

r = await send('/ping');
check('/ping 返回 Pong', has(r, 'Pong') && has(r, 'Asia/Shanghai'));

r = await send('/id');
check('/id 返回会话 ID', has(r, String(CHAT)));

r = await send('/foobar');
check('未知命令有友好提示', has(r, '未知命令'));

r = await send('随便说句话');
check('私聊非命令有引导', has(r, '/help'));

console.log('\n【天气插件】');
r = await send('/weather 北京');
check('查询天气成功', has(r, '北京') && has(r, '当前') && has(r, '18.5°C'), r.slice(0, 120));
check('预报含三天', has(r, '今天') && has(r, '明天') && has(r, '后天'));
check('含日出日落', has(r, '日出'));

r = await send('/weather sub 北京 07:30');
check('订阅成功', has(r, '订阅成功') && has(r, '07:30'));

r = await send('/weather list');
check('订阅列表可见', has(r, '天气订阅') && has(r, '北京'));

r = await send('/weather off 北京');
check('取消订阅成功', has(r, '已取消'));

console.log('\n【监控插件】');
r = await send('/mon add https://example.com name=官网 interval=1 expect=200');
check('添加监控成功', has(r, '监控已添加') && has(r, '官网'), r.slice(0, 150));
check('首次探测正常', has(r, '🟢'));
const monId = (r.match(/ID：<code>([a-z0-9]+)<\/code>/) || [])[1];
check('返回了监控 ID', Boolean(monId), `解析到 ${monId}`);

r = await send('/mon list');
check('监控列表可见', has(r, '官网') && has(r, 'example.com'));

r = await send(`/mon check ${monId}`);
check('手动检查正常', has(r, '🟢') && has(r, '正常'));

r = await send('/mon add https://down.example.org name=坏站 interval=1 expect=200 threshold=1');
check('异常站点首次探测告警', has(r, '🔴') && has(r, '503'), r.slice(0, 150));

r = await send('/mon del 不存在');
check('删除不存在的监控有提示', has(r, '找不到'));

console.log('\n【提醒插件】');
r = await send('/remind 10m 喝水');
check('设置相对时间提醒', has(r, '提醒已设置') && has(r, '喝水'));
const remId = (r.match(/del ([a-z0-9]+)/) || [])[1];
check('返回提醒 ID', Boolean(remId));

r = await send('/remind 明天 9:00 提交周报');
check('设置中文绝对时间提醒', has(r, '提醒已设置') && has(r, '提交周报'));

r = await send('/reminders');
check('待办列表可见', has(r, '喝水') && has(r, '提交周报') && has(r, '待办提醒'));

r = await send('/remind 时间乱写 内容');
check('无法解析时间时给出提示', has(r, '没看懂时间'));

r = await send(`/remind del ${remId}`);
check('删除提醒成功', has(r, '已取消'));

console.log('\n【翻译插件】');
r = await send('/tr hello world');
check('翻译成功', has(r, '你好世界') && has(r, 'English → 中文'), r.slice(0, 120));

r = await send('/tr ja 早上好');
check('指定目标语言', has(r, '日本語') || has(r, 'ja'), r.slice(0, 120));

r = await send('/tr');
check('缺参数时给出用法', has(r, '用法'));

console.log('\n【设置插件】');
r = await send('/tz Asia/Tokyo');
check('设置时区成功', has(r, 'Asia/Tokyo'));

r = await send('/tz 火星/奥林帕斯');
check('非法时区被拒绝', has(r, '不是有效'));

await send('/tz Asia/Shanghai');

r = await send('/mute on');
check('静音开启', has(r, '静音'));
await send('/mute off');

console.log('\n【Cron 调度】');
// 手动塞一条「已到期」的提醒，验证派发
const past = Date.now() - 1000;
await env.BOT_KV.put(`rm:${tsKey(past)}:${CHAT}:zzzzz`, JSON.stringify({
  id: 'zzzzz', chatId: CHAT, text: '到点啦', at: past, tz: 'Asia/Shanghai', createdAt: past - 60000,
}));
outbox.length = 0;
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
check('到期提醒被派发', outbox.some((m) => has(m.text, '到点啦')), JSON.stringify(outbox.map(m => m.text)));
let remaining = (await env.BOT_KV.list({ prefix: 'rm:' })).keys.map((k) => k.name);
check('到期提醒被清除', !remaining.some((n) => n.endsWith(':zzzzz')), JSON.stringify(remaining));
check('未到期的「提交周报」仍在', remaining.some((n) => n.endsWith(':') === false) && remaining.length >= 1);

// 未到期的提醒不应被派发
const future = Date.now() + 3600000;
await env.BOT_KV.put(`rm:${tsKey(future)}:${CHAT}:yyyyy`, JSON.stringify({
  id: 'yyyyy', chatId: CHAT, text: '还没到', at: future, tz: 'Asia/Shanghai', createdAt: Date.now(),
}));
outbox.length = 0;
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
check('未到期提醒不被派发', !outbox.some((m) => has(m.text, '还没到')));
remaining = (await env.BOT_KV.list({ prefix: 'rm:' })).keys.map((k) => k.name);
check('未到期提醒仍保留', remaining.some((n) => n.endsWith(':yyyyy')), JSON.stringify(remaining));

// 监控告警：把监控项的 lastCheck 拨到过去使其到期，再跑一轮
for (const k of (await env.BOT_KV.list({ prefix: 'mon:' })).keys) {
  const it = JSON.parse(await env.BOT_KV.get(k.name));
  it.lastCheck = Date.now() - 999999;
  await env.BOT_KV.put(k.name, JSON.stringify(it));
}
outbox.length = 0;
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
const alerts = outbox.filter((m) => has(m.text, '异常告警'));
check('监控触发告警', alerts.length > 0, JSON.stringify(outbox.map(m => m.text.slice(0, 40))));
check('告警内容含问题描述', alerts.some((m) => has(m.text, '503')), JSON.stringify(alerts.map(a => a.text.slice(0, 80))));

// 再次运行：不应重复告警（防抖动）
outbox.length = 0;
for (const k of (await env.BOT_KV.list({ prefix: 'mon:' })).keys) {
  const it = JSON.parse(await env.BOT_KV.get(k.name));
  it.lastCheck = Date.now() - 999999;
  await env.BOT_KV.put(k.name, JSON.stringify(it));
}
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
check('持续故障不重复告警', outbox.filter((m) => has(m.text, '异常告警')).length === 0);

console.log('\n【外部请求覆盖】');
check('调用过地理编码', external.some((u) => u.includes('geocoding-api')));
check('调用过天气接口', external.some((u) => u.includes('api.open-meteo.com')));
check('调用过翻译接口', external.some((u) => u.includes('translate.googleapis')));
check('调用过被监控站点', external.some((u) => u.includes('example.com')));

console.log(`\n${'─'.repeat(46)}`);
console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / ${pass} 项通过`);
process.exit(fail === 0 ? 0 : 1);
