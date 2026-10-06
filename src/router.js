/**
 * router.js —— 更新分发
 * 把 Telegram 的 update 解析成 ctx，再交给插件命令处理
 */
import { isValidTz } from './utils.js';

/**
 * 解析命令文本：/cmd@botname args
 * @returns {{cmd:string, args:string}|null}
 */
export function parseCommand(text) {
  if (!text || !text.startsWith('/')) return null;
  const m = text.match(/^\/([A-Za-z0-9_]+)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/);
  if (!m) return null;
  return { cmd: m[1].toLowerCase(), args: (m[2] || '').trim() };
}

/** 构造 ctx（对每个 update 调用一次） */
function createContext(app, message) {
  const chatId = message.chat.id;
  const text = message.text || message.caption || '';
  const parsed = parseCommand(text);
  const args = parsed ? parsed.args : '';

  let settingsPromise = null;
  const loadSettings = async () => {
    if (!settingsPromise) {
      settingsPromise = (async () => {
        const defaults = { tz: app.env.DEFAULT_TZ || 'UTC', muted: false };
        const s = await app.store.getSettings(chatId, defaults);
        const tz = isValidTz(s.tz) ? s.tz : defaults.tz;
        return { ...defaults, ...s, tz };
      })();
    }
    return settingsPromise;
  };

  return {
    app,
    env: app.env,
    store: app.store,
    bot: app.bot,

    message,
    chatId,
    from: message.from,
    chat: message.chat,
    isPrivate: message.chat.type === 'private',

    text,
    command: parsed?.cmd || null,
    args,
    argv: args ? args.split(/\s+/) : [],

    loadSettings,
    getTz: async () => (await loadSettings()).tz,

    /** 回复当前会话（HTML 模式，超长自动分片） */
    reply: (body, extra = {}) =>
      app.bot.sendMessage(chatId, body, {
        reply_to_message_id: extra.replyTo === false ? undefined : message.message_id,
        ...extra,
      }),

    /** 发送到当前会话但不引用原消息（用于定时推送等） */
    send: (body, extra = {}) => app.bot.sendMessage(chatId, body, extra),
  };
}

/** 处理一条消息 */
async function handleMessage(app, message) {
  const ctx = createContext(app, message);

  if (!ctx.command) {
    // 非命令：在私聊里给个温和提示，群聊里保持安静
    if (ctx.isPrivate && ctx.text.trim()) {
      await ctx.reply(
        '我只听得懂命令哦。发送 <code>/help</code> 看看我能做什么。',
        { disable_web_page_preview: true }
      );
    }
    return;
  }

  const entry = app.commands.get(ctx.command);
  if (!entry) {
    await ctx.reply(
      `未知命令 <code>/${ctx.command}</code>\n发送 <code>/help</code> 查看全部命令。`
    );
    return;
  }

  try {
    await entry.run(ctx);
  } catch (err) {
    console.error(`[router] /${ctx.command} 执行失败`, err);
    await app.bot
      .sendMessage(
        ctx.chatId,
        `❌ 命令执行出错：<code>${String(err.message || err).replace(/[<>&]/g, '')}</code>`
      )
      .catch(() => null);
  }
}

/** 处理内联按钮回调 */
async function handleCallback(app, query) {
  const ctx = {
    app,
    env: app.env,
    store: app.store,
    bot: app.bot,
    chatId: query.message?.chat?.id,
    from: query.from,
    message: query.message,
    text: '',
    args: '',
    argv: [],
    loadSettings: async () => {
      const defaults = { tz: app.env.DEFAULT_TZ || 'UTC', muted: false };
      const s = await app.store.getSettings(query.message?.chat?.id, defaults);
      return { ...defaults, ...s, tz: isValidTz(s.tz) ? s.tz : defaults.tz };
    },
    getTz: async () => app.env.DEFAULT_TZ || 'UTC',
    reply: (body) => app.bot.sendMessage(query.message.chat.id, body),
    send: (body) => app.bot.sendMessage(query.message.chat.id, body),
  };

  try {
    // 交给插件处理（约定回调数据格式为 "plugin:action:payload"）
    const [pluginName, ...rest] = String(query.data || '').split(':');
    const plugin = app.plugins.find((p) => p.name === pluginName);
    if (plugin?.onCallback) {
      await plugin.onCallback(ctx, rest.join(':'));
    } else {
      await app.bot.answerCallbackQuery(query.id, '该按钮已失效');
    }
  } catch (err) {
    console.error('[router] 回调处理失败', err);
    await app.bot.answerCallbackQuery(query.id, '处理失败，请重试').catch(() => null);
  }
}

/** 入口：分发任意 update */
export async function routeUpdate(update, app) {
  if (!update || typeof update !== 'object') return;

  if (update.message) return handleMessage(app, update.message);
  if (update.edited_message) return handleMessage(app, update.edited_message);
  if (update.channel_post) return handleMessage(app, update.channel_post);
  if (update.callback_query) return handleCallback(app, update.callback_query);
}
