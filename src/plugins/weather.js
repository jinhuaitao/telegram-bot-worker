/**
 * plugins/weather.js —— 天气查询 + 每日定时推送
 * 数据源：Open-Meteo（免费、无需 API Key）
 *   地理编码 https://geocoding-api.open-meteo.com/v1/search
 *   预报     https://api.open-meteo.com/v1/forecast
 */
import { esc, fetchWithTimeout, localDateStr, localTimeStr, formatInTz } from '../utils.js';

const GEO_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FC_URL = 'https://api.open-meteo.com/v1/forecast';
const AQ_URL = 'https://air-quality-api.open-meteo.com/v1/air-quality';

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
        '  <code>/weather 上海</code> — 立即查看上海天气（实况 + 逐小时 + 未来 3 天 + 空气质量）',
        '  <code>/weather sub 北京 07:30</code> — 每天 07:30 推送北京天气（精简版）',
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
    const [data, air] = await Promise.all([
      fetchWeather(place.latitude, place.longitude, place.timezone, 3),
      fetchAirQuality(place.latitude, place.longitude, place.timezone).catch(() => null),
    ]);
    await ctx.reply(renderWeather(place, data, { air }));
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

      const [data, air] = await Promise.all([
        fetchWeather(item.latitude, item.longitude, tz, 1),
        fetchAirQuality(item.latitude, item.longitude, tz).catch(() => null),
      ]);
      const place = { name: item.city, label: item.label, latitude: item.latitude, longitude: item.longitude, timezone: tz };
      // 每日推送保持精简：只给实况 + 今日概况 + 空气质量，不带逐小时
      await bot.sendMessage(item.chatId, `🌅 <b>早安</b>\n\n${renderWeather(place, data, { days: 1, hours: 0, air })}`);

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
    current: [
      'temperature_2m', 'relative_humidity_2m', 'apparent_temperature', 'dew_point_2m',
      'weather_code', 'wind_speed_10m', 'wind_direction_10m', 'wind_gusts_10m',
      'pressure_msl', 'cloud_cover', 'visibility', 'precipitation',
    ].join(','),
    hourly: 'temperature_2m,weather_code,precipitation_probability',
    daily: [
      'weather_code', 'temperature_2m_max', 'temperature_2m_min',
      'precipitation_probability_max', 'precipitation_sum',
      'wind_speed_10m_max', 'wind_direction_10m_dominant',
      'uv_index_max', 'sunrise', 'sunset', 'daylight_duration',
    ].join(','),
    timezone: tz && tz !== 'auto' ? tz : 'auto',
    forecast_days: String(days),
  });
  const res = await fetchWithTimeout(`${FC_URL}?${params}`, {}, 10000);
  if (!res.ok) throw new Error(`天气服务异常（HTTP ${res.status}）`);
  return res.json();
}

/** 空气质量（同样是 Open-Meteo，免费无 Key）。失败不影响主流程。 */
async function fetchAirQuality(lat, lon, tz) {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: 'us_aqi,pm10,pm2_5',
    timezone: tz && tz !== 'auto' ? tz : 'auto',
  });
  const res = await fetchWithTimeout(`${AQ_URL}?${params}`, {}, 10000);
  if (!res.ok) throw new Error(`空气质量服务异常（HTTP ${res.status}）`);
  return res.json();
}

/* ─────────────────────── 渲染 ─────────────────────── */

const WIND_DIRS = ['北', '东北', '东', '东南', '南', '西南', '西', '西北'];

function windDir(deg) {
  if (deg === undefined || deg === null || !Number.isFinite(Number(deg))) return '';
  return WIND_DIRS[Math.round(Number(deg) / 45) % 8];
}

function uvLevel(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n < 3) return '低';
  if (n < 6) return '中等';
  if (n < 8) return '高';
  if (n < 11) return '很高';
  return '极高';
}

function aqiLevel(aqi) {
  const n = Number(aqi);
  if (!Number.isFinite(n)) return { label: '暂无数据', dot: '⚪' };
  if (n <= 50) return { label: '优', dot: '🟢' };
  if (n <= 100) return { label: '良', dot: '🟡' };
  if (n <= 150) return { label: '轻度污染', dot: '🟠' };
  if (n <= 200) return { label: '中度污染', dot: '🔴' };
  if (n <= 300) return { label: '重度污染', dot: '🟣' };
  return { label: '严重污染', dot: '🟤' };
}

function fmtDaylight(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s)) return '';
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return `${h} 小时 ${m} 分`;
}

/** 在逐小时数组里找到「当前时刻」对应的下标 */
function findHourIndex(times, currentTime) {
  if (!times.length) return -1;
  if (!currentTime) return 0;
  const key = String(currentTime).slice(0, 13);
  const idx = times.findIndex((t) => String(t).slice(0, 13) >= key);
  return idx >= 0 ? idx : 0;
}

function placeLabel(place) {
  const parts = [place.name, place.admin1].filter((x, i, a) => x && a.indexOf(x) === i);
  return parts.join(' · ');
}

function renderWeather(place, data, { days = 3, air = null, hours = 6 } = {}) {
  const cur = data.current || {};
  const daily = data.daily || {};
  const hourly = data.hourly || {};
  const [icon, desc] = describe(cur.weather_code);

  const lines = [`${icon} <b>${esc(place.label || place.name)}</b>`, '━━━━━━━━━━━━━━'];

  /* ── 实况 ── */
  if (cur.temperature_2m !== undefined) {
    lines.push(
      '',
      '<b>实况</b>',
      `🌡 <b>${round(cur.temperature_2m)}°C</b>　体感 ${round(cur.apparent_temperature)}°C　${esc(desc)}`,
      `💧 湿度 ${cur.relative_humidity_2m}%　露点 ${round(cur.dew_point_2m)}°C`
    );

    const dir = windDir(cur.wind_direction_10m);
    lines.push(
      `💨 ${dir ? dir + '风 ' : ''}${round(cur.wind_speed_10m)} m/s` +
        (cur.wind_gusts_10m !== undefined && cur.wind_gusts_10m !== null
          ? `　阵风 ${round(cur.wind_gusts_10m)} m/s`
          : '')
    );

    const row1 = [];
    if (cur.pressure_msl !== undefined && cur.pressure_msl !== null) {
      row1.push(`气压 ${Math.round(cur.pressure_msl)} hPa`);
    }
    if (cur.visibility !== undefined && cur.visibility !== null) {
      row1.push(`能见度 ${round(cur.visibility / 1000)} km`);
    }
    if (row1.length) lines.push(`🧭 ${row1.join('　')}`);

    const row2 = [];
    if (cur.cloud_cover !== undefined && cur.cloud_cover !== null) row2.push(`云量 ${cur.cloud_cover}%`);
    if (cur.precipitation !== undefined && cur.precipitation !== null && cur.precipitation > 0) {
      row2.push(`当前降水 ${round(cur.precipitation)} mm`);
    }
    if (row2.length) lines.push(`☁️ ${row2.join('　')}`);
  }

  /* ── 空气质量（紧随「云量」下方，与实况同属「此刻」） ── */
  if (air?.current && air.current.us_aqi !== undefined && air.current.us_aqi !== null) {
    const a = air.current;
    const { label, dot } = aqiLevel(a.us_aqi);
    lines.push('<b>空气质量</b>', `${dot} ${esc(label)}　AQI ${Math.round(a.us_aqi)}（美标）`);
    const parts = [];
    if (a.pm2_5 !== undefined && a.pm2_5 !== null) parts.push(`PM2.5 ${round(a.pm2_5)}`);
    if (a.pm10 !== undefined && a.pm10 !== null) parts.push(`PM10 ${round(a.pm10)}`);
    if (parts.length) lines.push(`　　${parts.join('　')} μg/m³`);
  }

  /* ── 日出日落（同样归入「此刻」） ── */
  if (daily.sunrise?.[0] && daily.sunset?.[0]) {
    lines.push(
      `☀️ 日出 ${esc(String(daily.sunrise[0]).slice(11))}　日落 ${esc(String(daily.sunset[0]).slice(11))}` +
        (daily.daylight_duration?.[0] ? `　昼长 ${fmtDaylight(daily.daylight_duration[0])}` : '')
    );
  }

  /* ── 逐小时 ── */
  const hTimes = hourly.time || [];
  if (hours > 0 && hTimes.length) {
    const start = findHourIndex(hTimes, cur.time);
    if (start >= 0) {
      lines.push('', `<b>未来 ${hours} 小时</b>`);
      for (let i = start; i < Math.min(start + hours, hTimes.length); i++) {
        const [hIcon] = describe(hourly.weather_code?.[i]);
        const t = round(hourly.temperature_2m?.[i]);
        const p = hourly.precipitation_probability?.[i];
        lines.push(
          `${esc(String(hTimes[i]).slice(11, 16))}　${hIcon} ${t}°C` +
            (p !== undefined && p !== null ? `　💧${p}%` : '')
        );
      }
    }
  }

  /* ── 逐日 ── */
  const dates = daily.time || [];
  if (dates.length) {
    const n = Math.min(days, dates.length);
    lines.push('', `<b>未来 ${n} 天</b>`);
    for (let i = 0; i < n; i++) {
      const [dIcon, dDesc] = describe(daily.weather_code?.[i]);
      const label = i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : String(dates[i]).slice(5);
      const lo = round(daily.temperature_2m_min?.[i]);
      const hi = round(daily.temperature_2m_max?.[i]);
      const pop = daily.precipitation_probability_max?.[i];

      lines.push(
        `<b>${label}</b>　${dIcon} ${esc(dDesc)}　<b>${lo}~${hi}°C</b>` +
          (pop !== undefined && pop !== null ? `　💧${pop}%` : '')
      );

      const detail = [];
      const wind = daily.wind_speed_10m_max?.[i];
      if (wind !== undefined && wind !== null) {
        const wd = windDir(daily.wind_direction_10m_dominant?.[i]);
        detail.push(`💨 ${wd ? wd + '风 ' : ''}${round(wind)} m/s`);
      }
      const uv = daily.uv_index_max?.[i];
      if (uv !== undefined && uv !== null) detail.push(`☀️ UV ${round(uv)} ${uvLevel(uv)}`);
      const sum = daily.precipitation_sum?.[i];
      if (sum !== undefined && sum !== null && sum > 0) detail.push(`🌧 降水 ${round(sum)} mm`);
      if (detail.length) lines.push(`　　${detail.join('　')}`);
    }
  }

  return lines.join('\n');
}

function round(n) {
  return n === undefined || n === null ? '-' : Math.round(n * 10) / 10;
}

function slug(name) {
  return encodeURIComponent(String(name).trim().toLowerCase());
}
