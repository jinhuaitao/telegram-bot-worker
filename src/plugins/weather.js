/**
 * plugins/weather.js —— 天气查询 + 每日定时推送
 * 数据源：Open-Meteo（免费、无需 API Key）
 *   地理编码 https://geocoding-api.open-meteo.com/v1/search
 *   预报     https://api.open-meteo.com/v1/forecast
 */
import { esc, fetchWithTimeout, localDateStr, localTimeStr, formatInTz } from '../utils.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FC_URL = 'https://api.open-meteo.com/v1/forecast';

/** WMO 天气码 → [emoji, 中文描述] */
const WMO = {
  0: ['☀️', '晴'],
  1: ['🌤️', '晴间多云'],
  2: ['⛅', '多云'],
  3: ['☁️', '阴'],
  45: ['🌫️', '有雾'],
  48: ['🌫️', '冻雾'],
  51: ['🌦️', '小毛毛雨'],
  53: ['🌦️', '毛毛雨'],
  55: ['🌦️', '大毛毛雨'],
  56: ['🌧️', '冻毛毛雨'],
  57: ['🌧️', '强冻毛毛雨'],
  61: ['🌧️', '小雨'],
  63: ['🌧️', '中雨'],
  65: ['🌧️', '大雨'],
  66: ['🌧️', '冻雨'],
  67: ['🌧️', '强冻雨'],
  71: ['🌨️', '小雪'],
  73: ['🌨️', '中雪'],
  75: ['❄️', '大雪'],
  77: ['❄️', '雪粒'],
  80: ['🌦️', '阵雨'],
  81: ['🌧️', '中阵雨'],
  82: ['⛈️', '强阵雨'],
  85: ['🌨️', '阵雪'],
  86: ['🌨️', '强阵雪'],
  95: ['⛈️', '雷阵雨'],
  96: ['⛈️', '雷阵雨伴冰雹'],
  99: ['⛈️', '强雷阵雨伴冰雹'],
};

function describe(code) {
  return WMO[code] || ['🌡️', `未知(${code})`];
}

export default {
  name: 'weather',
  title: '天气',
  summary: '查询任意城市天气，并支持每天定时推送',

  commands: {
    weather: {
      desc: '查天气 / 管理订阅',
      usage: '/weather 北京  |  /weather sub 北京 07:30  |  /weather list  |  /weather off [城市]',
      detail: [
        '示例：',
        '  <code>/weather 上海</code> — 立即查看上海天气（含未来 3 天）',
        '  <code>/weather sub 北京 07:30</code> — 每天 07:30 推送北京天气',
        '  <code>/weather list</code> — 查看已订阅的城市',
        '  <code>/weather off</code> — 取消全部天气订阅',
        '  <code>/weather off 北京</code> — 只取消北京',
      ].join('\n'),
      run: handleWeather,
    },
  },

  cron: cronWeather,
};

/* ─────────────────────── 命令处理 ─────────────────────── */

async function handleWeather(ctx) {
  const [first, ...rest] = ctx.argv;

  if (!first) {
    return showList(ctx);
  }

  const sub = first.toLowerCase();
  if (sub === 'list' || sub === 'ls' || sub === '列表') return showList(ctx);
  if (sub === 'off' || sub === 'unsub' || sub === '取消') return unsubscribe(ctx, rest.join(' ').trim());
  if (sub === 'sub' || sub === 'subscribe' || sub === '订阅') return subscribe(ctx, rest);

  // 否则当作城市名，直接查询
  return queryCity(ctx, [first, ...rest].join(' ').trim());
}

async function queryCity(ctx, city) {
  if (!city) {
    await ctx.reply('用法：<code>/weather 城市名</code>，例如 <code>/weather 杭州</code>');
    return;
  }
  await ctx.bot.sendChatAction(ctx.chatId);
  try {
    const place = await geocode(city);
    const data = await fetchWeather(place.latitude, place.longitude, place.timezone, 3);
    await ctx.reply(renderWeather(place, data));
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
  }
}

async function subscribe(ctx, rest) {
  // /weather sub 北京 07:30  或  /weather sub 北京
  let city = '';
  let pushAt = '07:30';

  const timeMatch = rest.join(' ').match(/(\d{1,2}[:：]\d{2})\s*$/);
  if (timeMatch) {
    pushAt = timeMatch[1].replace('：', ':').padStart(5, '0');
    const [h, m] = pushAt.split(':').map(Number);
    if (h > 23 || m > 59) {
      await ctx.reply('❌ 推送时间格式不对，应为 <code>HH:MM</code>，例如 <code>07:30</code>。');
      return;
    }
    city = rest.join(' ').slice(0, timeMatch.index).trim();
  } else {
    city = rest.join(' ').trim();
  }

  if (!city) {
    await ctx.reply('用法：<code>/weather sub 城市 [HH:MM]</code>，例如 <code>/weather sub 北京 07:30</code>');
    return;
  }

  await ctx.bot.sendChatAction(ctx.chatId);
  let place;
  try {
    place = await geocode(city);
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
    return;
  }

  const settings = await ctx.loadSettings();
  const key = `wx:${ctx.chatId}:${slug(place.name)}`;
  const existing = await ctx.store.getJSON(key);

  await ctx.store.setJSON(key, {
    chatId: ctx.chatId,
    city: place.name,
    label: placeLabel(place),
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: place.timezone || settings.tz,
    pushAt,
    lastPushDate: existing?.lastPushDate || null,
    createdAt: existing?.createdAt || Date.now(),
  });

  await ctx.reply(
    [
      existing ? '♻️ 已更新天气订阅' : '✅ 天气订阅成功',
      '',
      `城市：<b>${esc(placeLabel(place))}</b>`,
      `推送时间：每天 <b>${esc(pushAt)}</b>（${esc(place.timezone || settings.tz)}）`,
      '',
      '用 <code>/weather list</code> 查看全部订阅。',
    ].join('\n')
  );
}

async function unsubscribe(ctx, city) {
  if (!city) {
    const n = await ctx.store.clearPrefix(`wx:${ctx.chatId}:`);
    await ctx.reply(n ? `✅ 已取消全部 ${n} 个天气订阅` : '你还没有任何天气订阅。');
    return;
  }

  let name = city;
  try {
    name = (await geocode(city)).name;
  } catch {
    /* 用原样名字兜底 */
  }
  const key = `wx:${ctx.chatId}:${slug(name)}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.reply(`没有找到 <b>${esc(city)}</b> 的订阅，用 <code>/weather list</code> 看看。`);
    return;
  }
  await ctx.store.del(key);
  await ctx.reply(`✅ 已取消 <b>${esc(item.label || item.city)}</b> 的天气推送`);
}

async function showList(ctx) {
  const items = await ctx.store.listJSON(`wx:${ctx.chatId}:`);
  if (!items.length) {
    await ctx.reply(
      [
        '📭 还没有天气订阅。',
        '',
        '试试：<code>/weather sub 北京 07:30</code>',
        '或直接查询：<code>/weather 北京</code>',
      ].join('\n')
    );
    return;
  }
  items.sort((a, b) => a.pushAt.localeCompare(b.pushAt));
  await ctx.reply(
    [
      `📋 <b>天气订阅（${items.length}）</b>`,
      '',
      ...items.map(
        (it) =>
          `• <b>${esc(it.label || it.city)}</b> — 每天 ${esc(it.pushAt)}\n  <i>${esc(it.timezone)}</i>`
      ),
      '',
      '取消：<code>/weather off 城市</code>',
    ].join('\n')
  );
}

/* ─────────────────────── 定时推送 ─────────────────────── */

async function cronWeather({ store, bot, now }) {
  const items = await store.listJSON('wx:');
  if (!items.length) return;

  for (const item of items) {
    try {
      const tz = item.timezone || 'Asia/Shanghai';
      const today = localDateStr(now, tz);
      if (item.lastPushDate === today) continue;

      const hhmm = localTimeStr(now, tz);
      if (hhmm < item.pushAt) continue; // 还没到点

      const settings = await store.getSettings(item.chatId, { muted: false });
      if (settings.muted) {
        item.lastPushDate = today;
        await store.setJSON(item.__key, stripInternal(item));
        continue;
      }

      const data = await fetchWeather(item.latitude, item.longitude, tz, 1);
      const place = { name: item.city, label: item.label, latitude: item.latitude, longitude: item.longitude, timezone: tz };
      await bot.sendMessage(item.chatId, `🌅 <b>早安</b>\n\n${renderWeather(place, data, { days: 1 })}`);

      item.lastPushDate = today;
      await store.setJSON(item.__key, stripInternal(item));
    } catch (err) {
      console.error('[weather] 推送失败', item.city, err);
    }
  }
}

function stripInternal(item) {
  const { __key, ...rest } = item;
  return rest;
}

/* ─────────────────────── 数据获取 ─────────────────────── */

async function geocode(city) {
  const url = `${GEO_URL}?name=${encodeURIComponent(city)}&count=1&language=zh&format=json`;
  const res = await fetchWithTimeout(url, {}, 10000);
  if (!res.ok) throw new Error(`地理编码服务异常（HTTP ${res.status}）`);
  const data = await res.json();
  const r = data?.results?.[0];
  if (!r) throw new Error(`找不到城市「${city}」，换个说法试试（如「北京」而不是「北京市朝阳区」）`);
  return {
    name: r.name,
    country: r.country || '',
    admin1: r.admin1 || '',
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone || 'auto',
  };
}

async function fetchWeather(lat, lon, tz, days = 3) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m',
    daily:
      'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
    timezone: tz && tz !== 'auto' ? tz : 'auto',
    forecast_days: String(days),
  });
  const res = await fetchWithTimeout(`${FC_URL}?${params}`, {}, 10000);
  if (!res.ok) throw new Error(`天气服务异常（HTTP ${res.status}）`);
  return res.json();
}

/* ─────────────────────── 渲染 ─────────────────────── */

function placeLabel(place) {
  const parts = [place.name, place.admin1].filter((x, i, a) => x && a.indexOf(x) === i);
  return parts.join(' · ');
}

function renderWeather(place, data, { days = 3 } = {}) {
  const cur = data.current || {};
  const daily = data.daily || {};
  const [icon, desc] = describe(cur.weather_code);

  const lines = [`${icon} <b>${esc(place.label || place.name)}</b>`];

  if (cur.temperature_2m !== undefined) {
    lines.push(
      '',
      `当前 <b>${round(cur.temperature_2m)}°C</b> · ${esc(desc)}`,
      `体感 ${round(cur.apparent_temperature)}°C · 湿度 ${cur.relative_humidity_2m}% · 风速 ${round(cur.wind_speed_10m)} m/s`
    );
  }

  const dates = daily.time || [];
  if (dates.length) {
    lines.push('', '──────────────');
    for (let i = 0; i < Math.min(days, dates.length); i++) {
      const [dIcon, dDesc] = describe(daily.weather_code?.[i]);
      const label = i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : dates[i];
      const lo = round(daily.temperature_2m_min?.[i]);
      const hi = round(daily.temperature_2m_max?.[i]);
      const pop = daily.precipitation_probability_max?.[i];
      const wind = round(daily.wind_speed_10m_max?.[i]);
      lines.push(
        `<b>${label}</b> ${dIcon} ${esc(dDesc)}  ${lo}~${hi}°C` +
          (pop !== undefined && pop !== null ? `  💧${pop}%` : '') +
          (wind !== undefined && wind !== null ? `  💨${wind}m/s` : '')
      );
    }
  }

  const sun = daily.sunrise?.[0] && daily.sunset?.[0];
  if (sun) {
    lines.push('', `☀️ 日出 ${esc(daily.sunrise[0].slice(11))} · 日落 ${esc(daily.sunset[0].slice(11))}`);
  }

  return lines.join('\n');
}

function round(n) {
  return n === undefined || n === null ? '-' : Math.round(n * 10) / 10;
}

function slug(name) {
  return encodeURIComponent(String(name).trim().toLowerCase());
}
