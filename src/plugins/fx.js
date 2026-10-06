/**
 * plugins/fx.js —— 汇率查询
 *
 * 数据源：frankfurter.app（欧洲央行数据，免费无 Key）
 */
import { esc, fetchWithTimeout } from '../utils.js';

const API = 'https://api.frankfurter.app/latest';

/** 常用货币表（代码 → 中文名） */
export const CURRENCIES = {
  USD: '美元', CNY: '人民币', EUR: '欧元', JPY: '日元', GBP: '英镑',
  HKD: '港币', AUD: '澳元', CAD: '加元', CHF: '瑞士法郎', KRW: '韩元',
  SGD: '新加坡元', TWD: '新台币', THB: '泰铢', MYR: '马来西亚林吉特',
  INR: '印度卢比', RUB: '俄罗斯卢布', SEK: '瑞典克朗', NZD: '新西兰元',
};

export default {
  name: 'fx',
  title: '汇率',
  summary: '查询实时汇率，支持金额换算',

  commands: {
    fx: {
      desc: '查询汇率',
      usage: '/fx USD CNY [金额]  ·  /fx list 看支持的货币',
      detail: [
        '金额可以写在前面也可以写在后面，不写金额默认换算 1。',
        '',
        '<b>示例</b>：',
        '  <code>/fx USD CNY</code> — 1 美元兑多少人民币',
        '  <code>/fx USD CNY 100</code> — 100 美元兑多少人民币',
        '  <code>/fx 100 USD CNY</code> — 同上（金额前置也行）',
        '  <code>/fx EUR</code> — 1 欧元兑多少人民币',
      ].join('\n'),
      run: handleFx,
    },
  },
};

async function handleFx(ctx) {
  const parsed = parseFxArgs(ctx.argv);

  if (parsed.kind === 'list') {
    const lines = ['💱 <b>支持的常用货币</b>', ''];
    for (const [code, name] of Object.entries(CURRENCIES)) {
      lines.push(`<code>${code}</code> ${esc(name)}`);
    }
    lines.push('', 'frankfurter.app 实际支持 30+ 种货币，这里只列出常用的。');
    await ctx.reply(lines.join('\n'));
    return;
  }

  if (parsed.error) {
    await ctx.reply(`❌ ${esc(parsed.error)}`);
    return;
  }

  const { from, to, amount } = parsed;

  if (from === to) {
    await ctx.reply(
      `💱 <b>${esc(fmtNum(amount))} ${esc(from)}</b> = <b>${esc(fmtNum(amount))} ${esc(to)}</b>\n<i>同一种货币，不用换啦 😄</i>`
    );
    return;
  }

  await ctx.bot.sendChatAction(ctx.chatId);

  try {
    const url = `${API}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    const res = await fetchWithTimeout(url, {}, 12000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const rate = data?.rates?.[to];
    if (!Number.isFinite(rate)) throw new Error('接口未返回该货币对的汇率');

    const result = convertFx(amount, rate);
    await ctx.reply(
      [
        `💱 <b>${esc(fmtNum(amount))} ${esc(from)}</b> ${esc(CURRENCIES[from] || '')}`,
        `= <b>${esc(fmtNum(result))} ${esc(to)}</b> ${esc(CURRENCIES[to] || '')}`,
        '',
        `<i>1 ${esc(from)} ≈ ${esc(fmtNum(rate, 4))} ${esc(to)} · 数据: frankfurter.app</i>`,
      ].join('\n')
    );
  } catch (err) {
    console.warn('[fx] 汇率查询失败', err);
    await ctx.reply(
      [
        '❌ <b>汇率查询失败</b>',
        '',
        esc(err.message || String(err)),
        '',
        '稍后再试，或用 <code>/fx list</code> 确认货币代码。',
      ].join('\n')
    );
  }
}

/* ─────────────────────── 纯函数（可测试） ─────────────────────── */

/**
 * 解析 /fx 参数。
 * @returns {{kind:'list'}} | {{kind:'convert', from, to, amount}} | {{error:string}}
 */
export function parseFxArgs(argv = []) {
  const tokens = (argv || []).map(String);

  if (tokens.length === 1 && tokens[0].toLowerCase() === 'list') {
    return { kind: 'list' };
  }

  let amount = 1;
  const codes = [];

  for (const t of tokens) {
    if (/^[\d,]+(\.\d+)?$/.test(t)) {
      amount = Number(t.replace(/,/g, ''));
    } else if (/^[a-zA-Z]{3}$/.test(t)) {
      codes.push(t.toUpperCase());
    } else {
      return { error: `看不懂「${t}」。用法：/fx USD CNY [金额]，或 /fx list 看支持的货币。` };
    }
  }

  if (amount <= 0 || !Number.isFinite(amount)) {
    return { error: '金额必须是大于 0 的数字。' };
  }

  if (codes.length > 2) {
    return { error: `货币太多了（${codes.join(' ')}）。用法：/fx USD CNY [金额]，或 /fx list 看支持的货币。` };
  }

  const from = codes[0] || 'USD';
  const to = codes[1] || 'CNY';

  if (!CURRENCIES[from]) return { error: `不支持的货币 ${from}，用 /fx list 查看常用货币。` };
  if (!CURRENCIES[to]) return { error: `不支持的货币 ${to}，用 /fx list 查看常用货币。` };

  return { kind: 'convert', from, to, amount };
}

/** 金额换算：保留合理小数位 */
export function convertFx(amount, rate) {
  const v = Number(amount) * Number(rate);
  return Math.round(v * 10000) / 10000;
}

function fmtNum(n, maxDigits = 4) {
  return Number(n).toLocaleString('en-US', { maximumFractionDigits: maxDigits });
}
