/**
 * plugins/translate.js —— 翻译
 *
 * 多源自动降级：任何一个源限流或失败，自动换下一个，用户无感。
 * 优先级：Workers AI（若绑定了 AI）→ Google → MyMemory
 * 可用 TRANSLATE_PROVIDER 把某个源提到最前面。
 *
 * 为什么要降级：Google 的公开端点是从 Cloudflare 共享出口 IP 调用的，
 * 高峰期很容易返回 429。单源方案会直接把错误抛给用户。
 */
import { esc, fetchWithTimeout, looksChinese } from '../utils.js';

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

  /**
   * 自检：实测每个翻译源当前是否可用。
   * 由 /setup?action=diagnose 调用，用于快速定位「为什么翻译不通」。
   */
  async diagnose(env) {
    const chain = buildChain(env);
    const results = [];

    for (const name of chain) {
      const t0 = Date.now();
      try {
        const r = await PROVIDERS[name]('hello', 'zh-CN', env);
        results.push({
          name,
          ok: Boolean(r?.text),
          detail: r?.text ? `返回「${r.text}」` : '返回了空结果',
          ms: Date.now() - t0,
        });
      } catch (err) {
        results.push({ name, ok: false, detail: err.message, ms: Date.now() - t0 });
      }
    }

    return { chain, results };
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

  const chain = buildChain(ctx.env);
  const failures = [];

  for (const name of chain) {
    try {
      const result = await PROVIDERS[name](text, target, ctx.env);
      if (!result?.text) {
        failures.push(`${name}：返回空结果`);
        continue;
      }

      const fromLabel = LANG_LABEL[result.source] || result.source || '自动检测';
      const toLabel = LANG_LABEL[target] || target;
      const note = failures.length
        ? ` · 已自动跳过 ${failures.length} 个不可用源`
        : '';

      await ctx.reply(
        [
          `🌐 <b>${esc(fromLabel)} → ${esc(toLabel)}</b>`,
          '',
          esc(result.text),
          '',
          `<i>${esc(PROVIDER_LABEL[name] || name)}${note}</i>`,
        ].join('\n')
      );
      return;
    } catch (err) {
      failures.push(`${name}：${err.message}`);
      console.warn(`[translate] ${name} 失败，换下一个源：${err.message}`);
    }
  }

  // 所有源都挂了
  const limited = failures.some((f) => f.includes('429'));
  await ctx.reply(
    [
      '❌ <b>翻译暂时不可用</b>',
      '',
      ...failures.map((f) => `· ${esc(f)}`),
      '',
      limited
        ? '免费翻译源被限流了。稍等几分钟再试，或按 README 启用 Workers AI —— 那是 Cloudflare 自家的模型，不受第三方限流影响。'
        : '稍后再试，或换一段更短的文本。',
    ].join('\n')
  );
}

/* ─────────────────────── 源的选择与降级 ─────────────────────── */

const PROVIDER_LABEL = {
  ai: 'Workers AI',
  google: 'Google 翻译',
  mymemory: 'MyMemory',
};

const PROVIDERS = {
  ai: translateWorkersAI,
  google: translateGoogle,
  mymemory: translateMyMemory,
};

/**
 * 构造尝试顺序。默认自动把「已绑定的 AI」排在前面，
 * 其余按可靠性排序；TRANSLATE_PROVIDER 可把指定源提到最前。
 */
function buildChain(env) {
  const available = [];
  if (env.AI) available.push('ai');
  available.push('google', 'mymemory');

  const preferred = String(env.TRANSLATE_PROVIDER || 'auto').toLowerCase();
  if (preferred === 'auto' || !available.includes(preferred)) return available;
  return [preferred, ...available.filter((p) => p !== preferred)];
}

/**
 * 轻量语言检测。
 * m2m100 和 MyMemory 都不支持自动检测源语言，必须我们自己判断。
 * 覆盖主流语言，判断不了的按英文处理。
 */
function detectLang(text) {
  const s = String(text);
  if (/[\u3040-\u30ff]/.test(s)) return 'ja';   // 日文假名（必须在汉字之前判断）
  if (/[\uac00-\ud7af]/.test(s)) return 'ko';   // 韩文
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh';   // 中文
  if (/[\u0400-\u04ff]/.test(s)) return 'ru';   // 西里尔字母
  if (/[\u0600-\u06ff]/.test(s)) return 'ar';   // 阿拉伯字母
  if (/[\u0e00-\u0e7f]/.test(s)) return 'th';   // 泰文
  if (/[\u0900-\u097f]/.test(s)) return 'hi';   // 天城文
  return 'en';
}

/** 把内部语言码转成 m2m100 认的代码（它只认两字母） */
function toM2M100Lang(code) {
  if (code === 'zh-CN' || code === 'zh-TW') return 'zh';
  return String(code).split('-')[0];
}

/* ─────────────────────── Provider 实现 ─────────────────────── */

/** Cloudflare Workers AI —— 自家模型，不受第三方限流影响 */
async function translateWorkersAI(text, target, env) {
  if (!env.AI) throw new Error('未绑定 Workers AI');

  const source = detectLang(text);
  const res = await env.AI.run('@cf/meta/m2m100-1.2b', {
    text,
    source_lang: toM2M100Lang(source),
    target_lang: toM2M100Lang(target),
  });

  const out = res?.translated_text;
  if (!out) throw new Error('模型未返回结果');
  return { text: String(out).trim(), source };
}

/** Google 公开端点 —— 质量好但容易 429，所以带一次退避重试 */
async function translateGoogle(text, target, source = 'auto') {
  const url =
    `https://translate.googleapis.com/translate_a/single` +
    `?client=gtx&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}` +
    `&dt=t&q=${encodeURIComponent(text)}`;
  const opts = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; tg-multibot/1.0)' } };

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetchWithTimeout(url, opts, 12000);

    if (res.ok) {
      const data = await res.json();
      const segments = Array.isArray(data?.[0]) ? data[0] : [];
      const out = segments.map((seg) => (Array.isArray(seg) ? seg[0] || '' : '')).join('');
      return { text: out.trim(), source: data?.[2] || source };
    }

    // 429 是瞬时限流，短暂等待后重试一次；仍失败则交给降级链
    if (res.status === 429 && attempt === 0) {
      await new Promise((r) => setTimeout(r, 600));
      continue;
    }
    throw new Error(`HTTP ${res.status}`);
  }

  throw new Error('HTTP 429 限流');
}

/** MyMemory —— 免费无 Key，但 langpair 必须显式给出源语言 */
async function translateMyMemory(text, target, env) {
  const source = detectLang(text);
  const url =
    `https://api.mymemory.translated.net/get` +
    `?q=${encodeURIComponent(text)}` +
    `&langpair=${encodeURIComponent(`${source}|${target}`)}` +
    (env.MYMEMORY_EMAIL ? `&de=${encodeURIComponent(env.MYMEMORY_EMAIL)}` : '');

  const res = await fetchWithTimeout(url, {}, 12000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  const data = await res.json();
  const status = Number(data?.responseStatus);
  const out = data?.responseData?.translatedText;

  // MyMemory 出错时把错误说明塞在 translatedText 里，靠 responseStatus 判断
  if (status && status !== 200) throw new Error(String(out || status).slice(0, 60));
  if (!out) throw new Error('未返回结果');

  return { text: String(out).trim(), source };
}
