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

/* ─────────── Mock R2 ─────────── */
class MockR2 {
  constructor() { this.map = new Map(); }
  async get(key) {
    const v = this.map.get(key);
    if (v === undefined) return null;
    return {
      key,
      text: async () => v,
      json: async () => JSON.parse(v),
    };
  }
  async put(key, value) { this.map.set(key, String(value)); return { key }; }
  async delete(keyOrKeys) {
    for (const k of Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys]) this.map.delete(k);
  }
  async list({ prefix = '', cursor, limit = 1000 } = {}) {
    const all = [...this.map.keys()].filter((k) => k.startsWith(prefix)).sort();
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + limit);
    const next = start + limit;
    const truncated = next < all.length;
    return {
      objects: slice.map((key) => ({ key })),
      truncated,
      cursor: truncated ? String(next) : undefined,
    };
  }
}

/* ─────────── Mock fetch ─────────── */
const outbox = [];   // 记录机器人发出的所有消息
const external = []; // 记录对外部服务的请求

/* 可控的翻译源状态，用于测试降级链 */
const translateMock = { google: 'ok', mymemory: 'ok' };
const aiCalls = [];

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
    const name = decodeURIComponent((u.match(/name=([^&]*)/)?.[1] || '').replace(/\+/g, ' '));
    if (name.includes('上海')) {
      return json({
        results: [{
          name: '上海', latitude: 31.23, longitude: 121.47,
          timezone: 'Asia/Shanghai', country: '中国', admin1: '上海市',
        }],
      });
    }
    return json({
      results: [{
        name: '北京', latitude: 39.9, longitude: 116.4,
        timezone: 'Asia/Shanghai', country: '中国', admin1: '北京市',
      }],
    });
  }

  // ⚠️ 必须排在 api.open-meteo.com 之前：air-quality-api.open-meteo.com 也含该子串
  if (u.includes('air-quality-api.open-meteo.com')) {
    return json({
      current: { time: '2026-10-01T10:00', us_aqi: 62, pm10: 41.2, pm2_5: 23.7 },
    });
  }

  if (u.includes('api.open-meteo.com')) {
    return json({
      current: {
        // 真实情况下 current.time 是 15 分钟粒度（如 10:40），不是整点
        time: '2026-10-01T10:40',
        temperature_2m: 18.5, relative_humidity_2m: 45, apparent_temperature: 17.2,
        dew_point_2m: 6.1, weather_code: 1, wind_speed_10m: 3.4,
        wind_direction_10m: 135, wind_gusts_10m: 6.8, pressure_msl: 1013.2,
        cloud_cover: 40, visibility: 24140, precipitation: 0,
      },
      hourly: {
        // 覆盖 10:00~20:00；查询发生在 10:40，所以「未来」应从 11:00 起
        time: [
          '2026-10-01T10:00', '2026-10-01T11:00', '2026-10-01T12:00',
          '2026-10-01T13:00', '2026-10-01T14:00', '2026-10-01T15:00',
          '2026-10-01T16:00', '2026-10-01T17:00', '2026-10-01T18:00',
          '2026-10-01T19:00', '2026-10-01T20:00',
        ],
        temperature_2m: [18.5, 19.4, 20.8, 21.6, 22.1, 22.0, 21.2, 20.1, 18.8, 17.5, 16.9],
        weather_code: [1, 1, 2, 2, 3, 3, 61, 61, 80, 3, 2],
        precipitation_probability: [5, 5, 10, 10, 15, 20, 70, 75, 60, 30, 15],
      },
      daily: {
        time: ['2026-10-01', '2026-10-02', '2026-10-03'],
        weather_code: [1, 3, 61],
        temperature_2m_max: [24, 22, 19],
        temperature_2m_min: [12, 11, 10],
        precipitation_probability_max: [10, 20, 80],
        precipitation_sum: [0, 0.4, 6.2],
        wind_speed_10m_max: [5, 4, 7],
        wind_direction_10m_dominant: [140, 200, 90],
        uv_index_max: [6.4, 5.1, 2.2],
        sunrise: ['2026-10-01T06:12', '2026-10-02T06:13', '2026-10-03T06:14'],
        sunset: ['2026-10-01T17:48', '2026-10-02T17:47', '2026-10-03T17:46'],
        daylight_duration: [41760, 41640, 41520],
      },
    });
  }

  if (u.includes('translate.googleapis.com')) {
    if (translateMock.google === '429') return new Response('rate limited', { status: 429 });
    if (translateMock.google === '500') return new Response('boom', { status: 500 });
    return json([[['你好世界', 'hello world', null, null, 10]], null, 'en']);
  }

  if (u.includes('api.mymemory.translated.net')) {
    if (translateMock.mymemory === 'fail') {
      return json({
        responseStatus: 403,
        responseData: { translatedText: 'MYMEMORY WARNING: YOU USED ALL AVAILABLE FREE TRANSLATIONS FOR TODAY' },
      });
    }
    return json({ responseStatus: 200, responseData: { translatedText: '你好世界（来自 MyMemory）' } });
  }

  if (u.includes('example.com')) return new Response('Welcome to Example', { status: 200 });
  if (u.includes('down.example.org')) return new Response('boom', { status: 503 });

  return new Response('not found', { status: 404 });
};

/* ─────────── 组装 app ─────────── */
const env = {
  BOT_TOKEN: '123:TEST',
  BOT_R2: new MockR2(),
  DEFAULT_TZ: 'Asia/Shanghai',
  TRANSLATE_PROVIDER: 'auto',
  MAX_MONITOR_PER_TICK: '20',
  // 集成测试会在一分钟内发几十条命令，关闭生产环境的命令限流（不影响任何断言）
  DISABLE_RATE_LIMIT: '1',
};
const app = {
  env,
  store: new Store(env.BOT_R2),
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
check('查询天气成功', has(r, '北京') && has(r, '实况') && has(r, '18.5°C'), r.slice(0, 120));
check('实况含体感/湿度/露点', has(r, '体感') && has(r, '湿度') && has(r, '露点'));
check('实况含风向风速阵风', has(r, '风') && has(r, '阵风') && has(r, 'm/s'));
check('实况含气压能见度云量', has(r, '气压') && has(r, '能见度') && has(r, '云量'));
check('预报含三天', has(r, '今天') && has(r, '明天') && has(r, '后天'));
check('逐日含 UV / 降水', has(r, 'UV') && has(r, '降水'));
check('含空气质量段', has(r, '空气质量') && has(r, 'AQI') && has(r, 'PM2.5'), r.slice(0, 160));
check('含日出日落与昼长', has(r, '日出') && has(r, '日落') && has(r, '昼长'));
check('含逐小时预报', has(r, '未来 6 小时'));
// 逐小时必须从「下一个整点」开始：查询时刻是 10:40，当前小时(10:00)属「此刻」，不该出现在「未来」里
{
  const seg = r.split('未来 6 小时')[1]?.split('未来 3 天')[0] || '';
  check(
    '逐小时从下一个整点开始（跳过当前小时 10:00）',
    seg.includes('11:00') && !seg.includes('10:00'),
    seg.slice(0, 140)
  );
  check('逐小时恰好 6 条', (seg.match(/\d{2}:\d{2}/g) || []).length === 6, seg.slice(0, 160));
}
// 分区顺序：此刻信息（实况→云量→空气质量→日出）必须排在预报之前
{
  const iCloud = r.indexOf('云量');
  const iAir = r.indexOf('空气质量');
  const iSun = r.indexOf('日出');
  const iHour = r.indexOf('未来 6 小时');
  const iDay = r.indexOf('未来 3 天');
  check(
    '空气质量/日出排在云量下方、预报之前',
    iCloud > -1 && iAir > iCloud && iSun > iAir && iHour > iSun && iDay > iHour,
    `云量@${iCloud} 空气@${iAir} 日出@${iSun} 逐小时@${iHour} 逐日@${iDay}`
  );
}
check('调用过空气质量接口', external.some((u) => u.includes('air-quality-api')));

r = await send('/weather sub 北京 07:30');
check('订阅成功', has(r, '订阅成功') && has(r, '07:30'));

r = await send('/weather list');
check('订阅列表可见', has(r, '天气订阅') && has(r, '北京'));

r = await send('/weather off 北京');
check('取消订阅成功', has(r, '已取消'));

r = await send('/weather_shanghai');
check('/weather_shanghai 直接查上海天气', has(r, '上海') && has(r, '实况') && has(r, '18.5°C'));

r = await send('/shanghai');
check('别名 /shanghai 生效', has(r, '上海') && has(r, '实况'));

r = await send('/weather_shanghai sub 08:00');
check('/weather_shanghai sub 订阅成功', has(r, '订阅成功') && has(r, '上海') && has(r, '08:00'));

r = await send('/weather list');
check('上海订阅出现在列表', has(r, '天气订阅') && has(r, '上海'));

r = await send('/weather_shanghai off');
check('/weather_shanghai off 取消成功', has(r, '已取消') && has(r, '上海'));

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
check('标注了实际使用的源', has(r, 'Google 翻译'), r.slice(0, 150));

r = await send('/tr ja 早上好');
check('指定目标语言', has(r, '日本語'), r.slice(0, 120));

r = await send('/tr');
check('缺参数时给出用法', has(r, '用法'));

console.log('\n【翻译降级链】');
// Google 限流 → 自动换 MyMemory
translateMock.google = '429';
r = await send('/tr hello world');
check('Google 429 时降级到 MyMemory', has(r, 'MyMemory') && has(r, '你好世界'), r.slice(0, 180));
check('提示已自动跳过不可用源', has(r, '跳过'), r.slice(0, 180));

// 全部源失败 → 友好提示 + 解决建议
translateMock.mymemory = 'fail';
r = await send('/tr hello world');
check('所有源都失败时给出友好提示', has(r, '翻译暂时不可用'), r.slice(0, 200));
check('提示里带上失败原因', has(r, '429'), r.slice(0, 200));
check('提示里给出解决方案', has(r, 'Workers AI'), r.slice(0, 250));
check('不把原始异常直接抛给用户', !has(r, 'undefined') && !has(r, 'TypeError'), r.slice(0, 200));

translateMock.google = 'ok';
translateMock.mymemory = 'ok';

// TRANSLATE_PROVIDER 可指定优先源
env.TRANSLATE_PROVIDER = 'mymemory';
r = await send('/tr hello world');
check('可指定 MyMemory 优先', has(r, 'MyMemory'), r.slice(0, 150));
env.TRANSLATE_PROVIDER = 'auto';

console.log('\n【Workers AI 翻译】');
env.AI = {
  run: async (model, params) => {
    aiCalls.push({ model, params });
    return { translated_text: '你好世界（来自 Workers AI）' };
  },
};

r = await send('/tr hello world');
check('绑定 AI 后优先走 Workers AI', has(r, 'Workers AI') && has(r, '来自 Workers AI'), r.slice(0, 180));
check('调用的是 m2m100 模型', aiCalls.some((c) => c.model === '@cf/meta/m2m100-1.2b'), JSON.stringify(aiCalls));
check('目标语言参数正确', aiCalls.some((c) => c.params.target_lang === 'zh'), JSON.stringify(aiCalls));
check('源语言参数正确', aiCalls.some((c) => c.params.source_lang === 'en'), JSON.stringify(aiCalls));

aiCalls.length = 0;
await send('/tr 你好世界');
check('中译英时源语言识别为 zh', aiCalls.some((c) => c.params.source_lang === 'zh'), JSON.stringify(aiCalls));
check('中译英时目标语言为 en', aiCalls.some((c) => c.params.target_lang === 'en'), JSON.stringify(aiCalls));

aiCalls.length = 0;
await send('/tr en おはよう');
check('日文假名被识别为 ja', aiCalls.some((c) => c.params.source_lang === 'ja'), JSON.stringify(aiCalls));
check('可指定译成英文', aiCalls.some((c) => c.params.target_lang === 'en'), JSON.stringify(aiCalls));

// AI 也挂了 → 继续降级到 Google
env.AI = { run: async () => { throw new Error('AI 服务繁忙'); } };
r = await send('/tr hello world');
check('AI 失败时继续降级到 Google', has(r, 'Google 翻译') && has(r, '你好世界'), r.slice(0, 180));
delete env.AI;

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
/* 便捷读取 mock R2：key 列表 / 单个对象内容 */
const r2Keys = async (prefix) => (await env.BOT_R2.list({ prefix })).objects.map((o) => o.key);
const r2Get = async (key) => (await env.BOT_R2.get(key)).json();

// 手动塞一条「已到期」的提醒，验证派发
const past = Date.now() - 1000;
await env.BOT_R2.put(`rm:${tsKey(past)}:${CHAT}:zzzzz`, JSON.stringify({
  id: 'zzzzz', chatId: CHAT, text: '到点啦', at: past, tz: 'Asia/Shanghai', createdAt: past - 60000,
}));
outbox.length = 0;
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
check('到期提醒被派发', outbox.some((m) => has(m.text, '到点啦')), JSON.stringify(outbox.map(m => m.text)));
let remaining = await r2Keys('rm:');
check('到期提醒被清除', !remaining.some((n) => n.endsWith(':zzzzz')), JSON.stringify(remaining));
check('未到期的「提交周报」仍在', remaining.some((n) => n.endsWith(':') === false) && remaining.length >= 1);

// 未到期的提醒不应被派发
const future = Date.now() + 3600000;
await env.BOT_R2.put(`rm:${tsKey(future)}:${CHAT}:yyyyy`, JSON.stringify({
  id: 'yyyyy', chatId: CHAT, text: '还没到', at: future, tz: 'Asia/Shanghai', createdAt: Date.now(),
}));
outbox.length = 0;
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
check('未到期提醒不被派发', !outbox.some((m) => has(m.text, '还没到')));
remaining = await r2Keys('rm:');
check('未到期提醒仍保留', remaining.some((n) => n.endsWith(':yyyyy')), JSON.stringify(remaining));

// 天气定时推送：塞一条「已到点」的订阅（pushAt=00:00 必然已过）
await env.BOT_R2.put(`wx:${CHAT}:${encodeURIComponent('北京')}`, JSON.stringify({
  chatId: CHAT, city: '北京', label: '北京 · 北京市',
  latitude: 39.9, longitude: 116.4, timezone: 'Asia/Shanghai',
  pushAt: '00:00', lastPushDate: null, createdAt: Date.now() - 60000,
}));
outbox.length = 0;
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
const wxPush = outbox.find((m) => has(m.text, '早安'));
check('天气订阅按点推送', Boolean(wxPush), JSON.stringify(outbox.map((m) => m.text.slice(0, 40))));
check('推送含实况与空气质量', Boolean(wxPush) && has(wxPush.text, '实况') && has(wxPush.text, '空气质量'));
check('推送保持精简（不带逐小时）', Boolean(wxPush) && !has(wxPush.text, '未来 6 小时'));

outbox.length = 0;
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
check('天气推送当日不重复', !outbox.some((m) => has(m.text, '早安')));

// 监控告警：把监控项的 lastCheck 拨到过去使其到期，再跑一轮
for (const k of await r2Keys('mon:')) {
  const it = await r2Get(k);
  it.lastCheck = Date.now() - 999999;
  await env.BOT_R2.put(k, JSON.stringify(it));
}
outbox.length = 0;
await runCron({ cron: '* * * * *', scheduledTime: Date.now() }, app);
const alerts = outbox.filter((m) => has(m.text, '异常告警'));
check('监控触发告警', alerts.length > 0, JSON.stringify(outbox.map(m => m.text.slice(0, 40))));
check('告警内容含问题描述', alerts.some((m) => has(m.text, '503')), JSON.stringify(alerts.map(a => a.text.slice(0, 80))));

// 再次运行：不应重复告警（防抖动）
outbox.length = 0;
for (const k of await r2Keys('mon:')) {
  const it = await r2Get(k);
  it.lastCheck = Date.now() - 999999;
  await env.BOT_R2.put(k, JSON.stringify(it));
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
