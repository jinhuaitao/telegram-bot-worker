/**
 * plugins/fx.js —— 汇率查询
 * 数据源：Frankfurter（免费、无需 API Key）
 *   https://api.frankfurter.dev/v1/latest?base=USD&symbols=CNY
 *   https://api.frankfurter.dev/v1/currencies
 */
import { esc, fetchWithTimeout } from '../utils.js';

const API_BASE = 'https://api.frankfurter.dev/v1';

/** 常用货币 → 中文名 */
const CN_NAMES = {
  CNY: '人民币',
  USD: '美元',
  EUR: '欧元',
  JPY: '日元',
  GBP: '英镑',
  HKD: '港币',
  KRW: '韩元',
  AUD: '澳元',
  CAD: '加元',
  CHF: '瑞士法郎',
  SGD: '新加坡元',
  TWD: '新台币',
  THB: '泰铢',
  NZD: '新西兰元',
  SEK: '瑞典克朗',
  NOK: '挪威克朗',
  DKK: '丹麦克朗',
  MXN: '墨西哥比索',
  INR: '印度卢比',
  BRL: '巴西雷亚尔',
  ZAR: '南非兰特',
  TRY: '土耳其里拉',
  RUB: '俄罗斯卢布',
  PLN: '波兰兹罗提',
  PHP: '菲律宾比索',
  MYR: '马来西亚林吉特',
  IDR: '印尼盾',
  ILS: '以色列新谢克尔',
  CZK: '捷克克朗',
  HUF: '匈牙利福林',
  RON: '罗马尼亚列伊',
  ISK: '冰岛克朗',
};

/** 中文名 → 代码（反查） */
const NAME_TO_CODE = {};
for (const [code, name] of Object.entries(CN_NAMES)) {
  NAME_TO_CODE[name] = code;
}
// 常见别名
Object.assign(NAME_TO_CODE, {
  '人民币元': 'CNY',
  '美金': 'USD',
  '美刀': 'USD',
  '欧罗': 'EUR',
  '港元': 'HKD',
  '台币': 'TWD',
});

function normalizeCurrency(input) {
  if (!input) return null;
  const s = String(input).trim();
  // 先试中文名
  if (NAME_TO_CODE[s]) return NAME_TO_CODE[s];
  // 再试代码（大小写不敏感）
  const code = s.toUpperCase();
  if (/^[A-Z]{3}$/.test(code)) return code;
  return null;
}

function displayName(code) {
  const cn = CN_NAMES[code];
  return cn ? `${code}(${cn})` : code;
}

async function fetchRate(from, to) {
  const url = `${API_BASE}/latest?base=${encodeURIComponent(from)}&symbols=${encodeURIComponent(to)}`;
  const res = await fetchWithTimeout(url, {}, 10000);
  if (!res.ok) throw new Error(`汇率服务异常（HTTP ${res.status}）`);
  const data = await res.json();
  const rate = data?.rates?.[to];
  if (rate === undefined || rate === null) throw new Error(`查不到 ${from} → ${to} 的汇率`);
  return { rate: Number(rate), date: data.date || '' };
}

export default {
  name: 'fx',
  title: '汇率',
  summary: '查询实时汇率，支持中文货币名',

  commands: {
    fx: {
      desc: '查询汇率 / 货币换算',
      usage: '/fx 100 USD CNY  |  /fx USD CNY  |  /fx 100 美元 人民币  |  /fx list',
      detail: [
        '示例：',
        '  <code>/fx USD CNY</code> — 1 美元 = 多少人民币',
        '  <code>/fx 100 USD CNY</code> — 100 美元 = 多少人民币',
        '  <code>/fx 100 美元 人民币</code> — 支持中文货币名',
        '  <code>/fx EUR</code> — 1 欧元 = 多少人民币（默认目标 CNY）',
        '  <code>/fx list</code> — 查看支持的货币列表',
      ].join('\n'),
      run: handleFx,
    },
  },
};

async function handleFx(ctx) {
  const argv = ctx.argv;

  if (!argv.length) {
    await ctx.reply(
      [
        '用法：<code>/fx 100 USD CNY</code>',
        '例如：<code>/fx 100 美元 人民币</code>、<code>/fx USD JPY</code>',
        '用 <code>/fx list</code> 查看支持的货币。',
      ].join('\n')
    );
    return;
  }

  const first = argv[0].toLowerCase();
  if (first === 'list' || first === '列表') {
    return showList(ctx);
  }

  // 解析：[金额] 货币1 [货币2]
  // 支持：/fx USD CNY / /fx 100 USD CNY / /fx EUR（默认转CNY）
  let amount = 1;
  let fromRaw, toRaw;

  const maybeAmount = parseAmount(argv[0]);
  if (maybeAmount !== null) {
    // 第一个是金额
    if (argv.length < 2) {
      await ctx.reply('用法：<code>/fx 100 USD CNY</code>，例如 <code>/fx 100 美元 人民币</code>');
      return;
    }
    amount = maybeAmount;
    fromRaw = argv[1];
    toRaw = argv[2] || 'CNY';
  } else {
    fromRaw = argv[0];
    toRaw = argv[1] || 'CNY';
  }

  const from = normalizeCurrency(fromRaw);
  const to = normalizeCurrency(toRaw);

  if (!from) {
    await ctx.reply(`❌ 不认识的货币 <code>${esc(fromRaw)}</code>，用 <code>/fx list</code> 查看支持的货币。`);
    return;
  }
  if (!to) {
    await ctx.reply(`❌ 不认识的货币 <code>${esc(toRaw)}</code>，用 <code>/fx list</code> 查看支持的货币。`);
    return;
  }

  if (from === to) {
    await ctx.reply(`💱 1 ${esc(displayName(from))} = <b>1</b> ${esc(displayName(to))}（同一货币）`);
    return;
  }

  await ctx.bot.sendChatAction(ctx.chatId);
  try {
    const { rate, date } = await fetchRate(from, to);
    const converted = amount * rate;
    const lines = [
      `💱 <b>${esc(displayName(from))} → ${esc(displayName(to))}</b>`,
      '',
      `1 ${esc(from)} = <b>${formatRate(rate)}</b> ${esc(to)}`,
    ];
    if (amount !== 1) {
      lines.push(`${formatAmount(amount)} ${esc(from)} = <b>${formatAmount(converted)}</b> ${esc(to)}`);
    } else {
      // amount=1 时也给几个常用金额参考
      lines.push('', `100 ${esc(from)} ≈ <b>${formatAmount(100 * rate)}</b> ${esc(to)}`);
    }
    if (date) lines.push('', `<i>数据日期：${esc(date)}（Frankfurter，欧洲央行参考价）</i>`);
    await ctx.reply(lines.join('\n'));
  } catch (err) {
    await ctx.reply(`❌ ${esc(err.message)}`);
  }
}

function parseAmount(s) {
  const m = String(s).replace(/,/g, '').match(/^(-?\d+(?:\.\d+)?)$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0 || n > 1e12) return null;
  return n;
}

function formatRate(n) {
  if (!Number.isFinite(n)) return '-';
  // 汇率一般保留4位小数，日元等大数值适当减少
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  if (n >= 100) return n.toFixed(3);
  return n.toFixed(4);
}

function formatAmount(n) {
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

async function showList(ctx) {
  try {
    const res = await fetchWithTimeout(`${API_BASE}/currencies`, {}, 10000);
    const data = await res.json();
    const codes = Object.keys(data).sort();
    const lines = ['💱 <b>支持的货币</b>', ''];
    for (const code of codes) {
      const cn = CN_NAMES[code] ? `（${CN_NAMES[code]}）` : '';
      lines.push(`• <code>${esc(code)}</code>${esc(cn)}`);
    }
    lines.push('', '用法：<code>/fx 100 USD CNY</code> 或 <code>/fx 100 美元 人民币</code>');
    await ctx.reply(lines.join('\n'));
  } catch {
    // 降级：用内置表
    const codes = Object.keys(CN_NAMES).sort();
    await ctx.reply(
      [
        '💱 <b>常用货币</b>',
        '',
        ...codes.map((c) => `• <code>${c}</code>（${CN_NAMES[c]}）`),
        '',
        '用法：<code>/fx 100 USD CNY</code>',
      ].join('\n')
    );
  }
}
