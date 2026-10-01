/**
 * utils.js —— 通用工具
 * 时区换算、时间自然语言解析、HTML 转义、带超时的 fetch
 */

/* ───────────────────────── 文本 ───────────────────────── */

/** Telegram parse_mode=HTML 转义（用户输入必须经过它） */
export function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** 按 Telegram 4096 上限切分长文本 */
export function chunkText(text, size = 3800) {
  const s = String(text ?? '');
  if (s.length <= size) return [s];
  const out = [];
  let rest = s;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) out.push(rest);
  return out;
}

/* ───────────────────────── 网络 ───────────────────────── */

/** 带超时的 fetch */
export async function fetchWithTimeout(url, options = {}, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 简易并发池 */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        results[i] = await worker(items[i], i);
      } catch (err) {
        results[i] = { __error: err };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/* ───────────────────────── 时区 ───────────────────────── */

export function isValidTz(tz) {
  if (!tz || typeof tz !== 'string') return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** 某时刻在某时区的日期字符串 "2026-10-01" */
export function localDateStr(ts, tz) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(ts));
}

/** 某时刻在某时区的 "HH:MM"（24 小时制） */
export function localTimeStr(ts, tz) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(ts));
}

/** 该时区在该时刻相对 UTC 的偏移毫秒数 */
export function tzOffsetMs(tz, ts) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const p = {};
  for (const part of dtf.formatToParts(new Date(ts))) p[part.type] = part.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - ts;
}

/** 把「某时区的墙上时间」换算成 UTC 时间戳 */
export function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, 0);
  let ts = guess - tzOffsetMs(tz, guess);
  ts = guess - tzOffsetMs(tz, ts); // 跨 DST 边界二次修正
  return ts;
}

/** 在某时区的「今天」基础上加减天数，返回 [y, m, d] */
export function shiftLocalDays(ts, tz, days) {
  const [y, m, d] = localDateStr(ts, tz).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}

/* ─────────────────── 自然语言时间解析 ─────────────────── */

const EN_UNITS = {
  s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
  m: 60000, min: 60000, mins: 60000, minute: 60000, minutes: 60000,
  h: 3600000, hr: 3600000, hrs: 3600000, hour: 3600000, hours: 3600000,
  d: 86400000, day: 86400000, days: 86400000,
  w: 604800000, week: 604800000, weeks: 604800000,
};

const CN_UNITS = {
  秒: 1000, 秒钟: 1000,
  分: 60000, 分钟: 60000,
  时: 3600000, 小时: 3600000, 钟头: 3600000,
  天: 86400000, 日: 86400000,
  周: 604800000, 星期: 604800000, 礼拜: 604800000,
};

const DAY_WORDS = { 今天: 0, 今晚: 0, 今日: 0, 明天: 1, 明早: 1, 明晚: 1, 明日: 1, 后天: 2 };

/**
 * 解析提醒时间。支持：
 *   10m / 2h / 1d / 30min / 2 hours      → 相对
 *   10分钟 / 2小时 / 3天                  → 相对（中文）
 *   09:30                                 → 今天该时刻，已过则顺延到明天
 *   10-02 09:00 / 2026-10-02 09:00        → 绝对
 *   明天 9:00 / 后天 9点 / 今晚 20:30      → 中文相对日
 * @returns {{at:number, rest:string}|null}
 */
export function parseWhen(input, tz, now = Date.now()) {
  const s = String(input ?? '').trim();
  if (!s) return null;

  const cut = (idx) => s.slice(idx).trim();

  // 1) 英文相对：10m / 2 hours
  let m = s.match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)(?![a-zA-Z])/);
  if (m) {
    const unit = EN_UNITS[m[2].toLowerCase()];
    if (unit) {
      const at = now + Math.round(parseFloat(m[1]) * unit);
      return { at, rest: cut(m[0].length) };
    }
  }

  // 2) 中文相对：10分钟 / 2小时
  m = s.match(/^(\d+(?:\.\d+)?)\s*(秒钟|钟头|分钟|小时|星期|礼拜|秒|分|时|天|日|周)/);
  if (m) {
    const unit = CN_UNITS[m[2]];
    if (unit) {
      const at = now + Math.round(parseFloat(m[1]) * unit);
      return { at, rest: cut(m[0].length) };
    }
  }

  // 3) 完整日期时间：2026-10-02 09:00
  m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})[\sT]+(\d{1,2})[:：](\d{2})/);
  if (m) {
    const at = zonedToUtc(+m[1], +m[2], +m[3], +m[4], +m[5], tz);
    return { at, rest: cut(m[0].length) };
  }

  // 4) 月-日 时:分：10-02 09:00（年份取当前时区年份）
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[\s]+(\d{1,2})[:：](\d{2})/);
  if (m) {
    const year = Number(localDateStr(now, tz).slice(0, 4));
    let at = zonedToUtc(year, +m[1], +m[2], +m[3], +m[4], tz);
    if (at < now - 86400000) at = zonedToUtc(year + 1, +m[1], +m[2], +m[3], +m[4], tz);
    return { at, rest: cut(m[0].length) };
  }

  // 5) 中文日期词 + 时刻：明天 9:00 / 后天 9点30 / 今晚 20:30 / 后天 9点
  m = s.match(/^(今天|今日|今晚|明天|明早|明晚|明日|后天)\s*(\d{1,2})\s*[:：点时]?\s*(\d{1,2})?\s*分?/);
  if (m) {
    const [y, mo, d] = shiftLocalDays(now, tz, DAY_WORDS[m[1]]);
    let h = +m[2];
    // 中文习惯：「今晚 8点」指 20:00 而非 08:00
    if ((m[1] === '今晚' || m[1] === '明晚') && h < 12) h += 12;
    const mi = m[3] ? +m[3] : 0;
    const at = zonedToUtc(y, mo, d, h, mi, tz);
    return { at, rest: cut(m[0].length) };
  }

  // 6) 裸时刻：09:30（今天，已过顺延明天）
  m = s.match(/^(\d{1,2})[:：](\d{2})/);
  if (m) {
    const [y, mo, d] = shiftLocalDays(now, tz, 0);
    let at = zonedToUtc(y, mo, d, +m[1], +m[2], tz);
    if (at <= now) {
      const [y2, mo2, d2] = shiftLocalDays(now, tz, 1);
      at = zonedToUtc(y2, mo2, d2, +m[1], +m[2], tz);
    }
    return { at, rest: cut(m[0].length) };
  }

  // 7) 裸时刻（点）：9点 / 9点30
  m = s.match(/^(\d{1,2})\s*[点時时](?:(\d{1,2})分?)?/);
  if (m) {
    const [y, mo, d] = shiftLocalDays(now, tz, 0);
    let at = zonedToUtc(y, mo, d, +m[1], m[2] ? +m[2] : 0, tz);
    if (at <= now) {
      const [y2, mo2, d2] = shiftLocalDays(now, tz, 1);
      at = zonedToUtc(y2, mo2, d2, +m[1], m[2] ? +m[2] : 0, tz);
    }
    return { at, rest: cut(m[0].length) };
  }

  return null;
}

/* ───────────────────────── 展示 ───────────────────────── */

/** 相对时间描述："3 分钟后" / "1 小时 20 分钟后" */
export function humanizeUntil(at, now = Date.now()) {
  let diff = at - now;
  if (diff <= 0) return '已到期';
  const d = Math.floor(diff / 86400000); diff %= 86400000;
  const h = Math.floor(diff / 3600000); diff %= 3600000;
  const mi = Math.floor(diff / 60000);
  const parts = [];
  if (d) parts.push(`${d} 天`);
  if (h) parts.push(`${h} 小时`);
  if (mi && !d) parts.push(`${mi} 分钟`);
  if (!parts.length) parts.push('不到 1 分钟');
  return parts.join(' ') + '后';
}

/** 在指定时区格式化为 "2026-10-01 14:23" */
export function formatInTz(ts, tz) {
  const date = localDateStr(ts, tz);
  const time = localTimeStr(ts, tz);
  return `${date} ${time}`;
}

/** 人类可读的间隔：90 → "1 小时 30 分钟" */
export function humanizeMinutes(min) {
  const m = Math.max(1, Math.round(min));
  if (m < 60) return `${m} 分钟`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} 小时 ${rest} 分钟` : `${h} 小时`;
}

/** 短 ID（用于监控项/提醒） */
export function shortId(len = 5) {
  const alphabet = 'abcdefghijkmnpqrstuvwxyz23456789';
  let out = '';
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

/** 毫秒时间戳 → 定长字符串，保证 KV key 字典序 == 时间序 */
export function tsKey(ts) {
  return String(Math.max(0, Math.floor(ts))).padStart(14, '0');
}

/** 判断文本是否主要为中文 */
export function looksChinese(text) {
  const cjk = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const letters = (text.match(/[a-zA-Z\u4e00-\u9fff]/g) || []).length;
  return letters > 0 && cjk / letters > 0.3;
}
