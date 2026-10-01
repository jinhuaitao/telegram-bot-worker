/**
 * plugins/translate.js —— 翻译
 *
 * 默认 provider：Google 翻译公开端点（无需 API Key）
 * 可通过环境变量 TRANSLATE_PROVIDER 切换成 mymemory
 */
import { esc, fetchWithTimeout, looksChinese, chunkText } from '../utils.js';

const LANGS = {
  zh: 'zh-CN', 中文: 'zh-CN', 简体: 'zh-CN', 简体中文: 'zh-CN', chinese: 'zh-CN',
  'zh-tw': 'zh-TW', 繁体: 'zh-TW', 繁体中文: 'zh-TW',
  en: 'en', 英文: 'en', 英语: 'en', english: 'en',
  ja: 'ja', 日文: 'ja', 日语: 'ja', japanese: 'ja',
  ko: 'ko', 韩文: 'ko', 韩语: 'ko', korean: 'ko',
  fr: 'fr', 法语: 'fr', 法文: 'fr', french: 'fr',
  de: 'de', 德语: 'de', 德文: 'de', german: 'de',
  ru: 'ru', 俄语: 'ru', 俄文: 'ru', russian: 'ru',
  es: 'es', 西班牙语: 'es', spanish: 'es',
  pt: 'pt', 葡萄牙语: 'pt', portuguese: 'pt',
  it: 'it', 意大利语: 'it', italian: 'it',
  ar: 'ar', 阿拉伯语: 'ar', arabic: 'ar',
  th: 'th', 泰语: 'th', thai: 'th',
  vi: 'vi', 越南语: 'vi', vietnamese: 'vi',
  hi: 'hi', 印地语: 'hi', hindi: 'hi',
  tr: 'tr', 土耳其语: 'tr', turkish: 'tr',
  nl: 'nl', 荷兰语: 'nl', dutch: 'nl',
  pl: 'pl', 波兰语: 'pl', polish: 'pl',
};

const LANG_LABEL = {
  'zh-CN': '中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語', ko: '한국어',
  fr: 'Français', de: 'Deutsch', ru: 'Русский', es: 'Español', pt: 'Português',
  it: 'Italiano', ar: 'العربية', th: 'ไทย', vi: 'Tiếng Việt', hi: 'हिन्दी',
  tr: 'Türkçe', nl: 'Nederlands', pl: 'Polski',
};

const MAX_LEN = 3000;

export default {
  name: 'translate',
  title: '翻译',
  summary: '中英日韩等多语言互译，也可直接翻译被回复的消息',

  commands: {
    tr: {
      desc: '翻译文本',
      usage: '/tr [目标语言] <文本>  ·  或回复某条消息发 /tr',
      detail: [
        '不指定目标语言时自动判断：中文→英文，其他→中文。',
        '',
        '<b>示例</b>：',
        '  <code>/tr hello world</code> — 译成中文',
        '  <code>/tr 你好世界</code> — 译成英文',
        '  <code>/tr ja 早上好</code> — 译成日文',
        '  <code>/tr fr Hello</code> — 译成法文',
        '',
        '也可以<b>回复</b>一条消息并发送 <code>/tr</code> 直接翻译它。',
        '',
        '支持：' + Object.keys(LANG_LABEL).join(' '),
      ].join('\n'),
      run: handleTranslate,
    },
  },
};

async function handleTranslate(ctx) {
  const settings = await ctx.loadSettings();
  let text = ctx.args.trim();
  let target = null;

  // 若命令是对某条消息的回复，优先取被回复消息的内容
  const replied = ctx.message.reply_to_message;
  if (replied) {
    const repliedText = replied.text || replied.caption || '';
    if (repliedText) {
      text = [text, repliedText].filter(Boolean).join('\n');
    }
  }

  if (!text) {
    await ctx.reply(
      ['用法：<code>/tr [目标语言] 文本</code>', '', '例如 <code>/tr hello world</code> 或 <code>/tr ja 早上好</code>'].join('\n')
    );
    return;
  }

  // 解析可选的「目标语言」前缀
  const m = text.match(/^([A-Za-z-]{2,12}|[\u4e00-\u9fff]{2,6})\s+([\s\S]+)$/);
  if (m) {
    const key = m[1].toLowerCase();
    if (LANGS[key]) {
      target = LANGS[key];
      text = m[2].trim();
    }
  }

  if (!target) {
    target = looksChinese(text) ? 'en' : 'zh-CN';
  }

  if (text.length > MAX_LEN) {
    await ctx.reply(`❌ 文本太长（${text.length} 字），上限 ${MAX_LEN} 字。`);
    return;
  }

  await ctx.bot.sendChatAction(ctx.chatId);

  const provider = (ctx.env.TRANSLATE_PROVIDER || 'google').toLowerCase();
  try {
    const result =
      provider === 'mymemory'
        ? await translateMyMemory(text, target)
        : await translateGoogle(text, target);

    if (!result.text) {
      await ctx.reply('❌ 翻译服务没有返回结果，换个说法再试试。');
      return;
    }

    const fromLabel = LANG_LABEL[result.source] || result.source || '自动检测';
    const toLabel = LANG_LABEL[target] || target;

    await ctx.reply(
      [
        `🌐 <b>${esc(fromLabel)} → ${esc(toLabel)}</b>`,
        '',
        esc(result.text),
        '',
        `<i>由 ${esc(provider)} 提供 · 可用 /settings 调整时区等偏好</i>`,
      ].join('\n')
    );
  } catch (err) {
    await ctx.reply(`❌ 翻译失败：${esc(err.message)}`);
  }
}

/* ─────────────────────── Provider 实现 ─────────────────────── */

async function translateGoogle(text, target, source = 'auto') {
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;

  const res = await fetchWithTimeout(
    url,
    { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tg-multibot/1.0)' } },
    12000
  );
  if (!res.ok) throw new Error(`翻译服务返回 HTTP ${res.status}`);

  const data = await res.json();
  const segments = Array.isArray(data?.[0]) ? data[0] : [];
  const out = segments.map((seg) => (Array.isArray(seg) ? seg[0] || '' : '')).join('');
  return { text: out.trim(), source: data?.[2] || source };
}

async function translateMyMemory(text, target) {
  const url =
    `https://api.mymemory.translated.net/get` +
    `?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent('auto|' + target)}`;

  const res = await fetchWithTimeout(url, {}, 12000);
  if (!res.ok) throw new Error(`翻译服务返回 HTTP ${res.status}`);

  const data = await res.json();
  const out = data?.responseData?.translatedText;
  if (!out) throw new Error('翻译服务未返回结果');
  return { text: String(out).trim(), source: 'auto' };
}
