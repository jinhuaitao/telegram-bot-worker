/**
 * plugins/ai.js —— AI 聊天
 *
 * 需要绑定 Workers AI（wrangler.toml 里有 [ai] binding = "AI"）。
 * 用 R2 存最近 10 轮对话作为上下文，超过 24 小时没聊过自动清空。
 */
import { esc } from '../utils.js';

const MODEL = '@cf/meta/llama-3.1-8b-instruct';
const MAX_ROUNDS = 10; // 保留最近 10 轮 = 20 条消息
const CONTEXT_TTL_MS = 24 * 3600000; // 24 小时

export default {
  name: 'ai',
  title: 'AI 聊天',
  summary: '和 AI 对话，支持连续上下文',

  commands: {
    ai: {
      desc: '和 AI 聊天（支持上下文）',
      usage: '/ai <问题>  ·  /ai clear 清空上下文',
      detail: [
        '连续对话：会记住最近 10 轮聊天内容，可以追问「那它呢？」这类指代。',
        '超过 24 小时没聊，上下文自动清空。',
        '',
        '<b>示例</b>：',
        '  <code>/ai 帮我写一封请假邮件</code>',
        '  <code>/ai 再正式一点</code> ← 接得上上一句',
        '  <code>/ai clear</code> — 手动清空上下文',
      ].join('\n'),
      run: handleAi,
    },
  },
};

async function handleAi(ctx) {
  if (!ctx.env.AI) {
    await ctx.reply(
      [
        '🤖 <b>AI 聊天还没开通</b>',
        '',
        '需要在 wrangler.toml 里加上 AI 绑定，然后重新部署：',
        '',
        '<code>[ai]',
        'binding = "AI"</code>',
        '',
        '免费额度每天 10000 neurons，个人用绰绰有余。',
        '绑定后 <code>/tr</code> 翻译也会优先走自家模型，不再受第三方限流影响。',
      ].join('\n')
    );
    return;
  }

  const raw = ctx.args.trim();
  if (!raw) {
    await ctx.reply(
      ['用法：<code>/ai 你的问题</code>', '', '例如 <code>/ai 今天北京天气适合跑步吗</code>'].join('\n')
    );
    return;
  }

  const [sub, ...rest] = ctx.argv;
  if (sub.toLowerCase() === 'clear') {
    await ctx.store.del(`ai:${ctx.chatId}`);
    await ctx.reply('🧹 上下文已清空，我们重新开始吧。');
    return;
  }

  const now = Date.now();
  const key = `ai:${ctx.chatId}`;
  let saved = await ctx.store.getJSON(key, null);

  // 超过 24 小时没聊：上下文过期，直接丢弃
  if (saved && now - (saved.updatedAt || 0) > CONTEXT_TTL_MS) {
    saved = null;
  }

  let messages = trimContext(saved?.messages || [], MAX_ROUNDS);
  messages.push({ role: 'user', content: raw });

  await ctx.bot.sendChatAction(ctx.chatId);

  let answer;
  try {
    // 只把最近 10 轮发给模型，避免 prompt 过长
    const res = await ctx.env.AI.run(MODEL, { messages: messages.slice(-MAX_ROUNDS * 2) });
    answer = String(res?.response || '').trim();
    if (!answer) throw new Error('模型未返回结果');
  } catch (err) {
    console.warn('[ai] 模型调用失败', err);
    await ctx.reply(
      [
        '❌ <b>AI 暂时不可用</b>',
        '',
        esc(err.message || String(err)),
        '',
        '稍后再试，或用 <code>/setup?action=diagnose</code> 查看 AI 绑定状态。',
      ].join('\n')
    );
    return;
  }

  messages.push({ role: 'assistant', content: answer });
  messages = trimContext(messages, MAX_ROUNDS);
  await ctx.store.setJSON(key, { messages, updatedAt: now });

  await ctx.reply(esc(answer));
}

/* ─────────────────────── 纯函数（可测试） ─────────────────────── */

/**
 * 把对话历史裁到最近 maxRounds 轮（每轮 = user + assistant 两条）。
 * @returns {Array<{role:string, content:string}>}
 */
export function trimContext(messages, maxRounds = MAX_ROUNDS) {
  const list = Array.isArray(messages) ? messages : [];
  const keep = Math.max(1, maxRounds) * 2;
  return list.slice(-keep);
}

/** 判断某份上下文是否已过期（供外部调用/测试） */
export function isContextExpired(saved, now = Date.now()) {
  if (!saved) return true;
  return now - (saved.updatedAt || 0) > CONTEXT_TTL_MS;
}
