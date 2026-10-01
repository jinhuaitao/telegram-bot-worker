/**
 * plugins/remind.js —— 定时提醒
 *
 * Key 设计：rm:{14位补零时间戳}:{id}
 *   KV 的 list 按 key 字典序返回，补零后字典序 == 时间序，
 *   所以 cron 从头扫、一旦遇到未到期的就可以立刻停止。
 */
import { esc, parseWhen, humanizeUntil, formatInTz, tsKey, shortId } from '../utils.js';

const MAX_PER_CHAT = 50;
const MAX_AHEAD_MS = 365 * 86400000;

export default {
  name: 'remind',
  title: '提醒',
  summary: '到点自动推送一条消息',

  commands: {
    remind: {
      desc: '设置定时提醒',
      usage: '/remind <时间> <内容>',
      detail: [
        '<b>支持的时间写法</b>：',
        '  <code>10m</code> / <code>2h</code> / <code>1d</code> / <code>30分钟</code> / <code>2小时</code>',
        '  <code>09:30</code> — 今天该时刻，已过则顺延到明天',
        '  <code>9点30</code> / <code>明天 9:00</code> / <code>后天 9点</code>',
        '  <code>10-02 09:00</code> / <code>2026-10-02 09:00</code>',
        '',
        '<b>示例</b>：',
        '  <code>/remind 10m 喝水</code>',
        '  <code>/remind 明天 9:00 提交周报</code>',
        '  <code>/remind 2026-10-02 14:00 客户会议</code>',
      ].join('\n'),
      run: handleRemind,
    },
    reminders: { desc: '查看待办提醒', usage: '/reminders', run: listReminders },
  },

  cron: cronRemind,
};

/* ─────────────────────── 命令处理 ─────────────────────── */

async function handleRemind(ctx) {
  const raw = ctx.args.trim();
  if (!raw) {
    await ctx.reply(
      [
        '⏰ <b>设置提醒</b>',
        '',
        '用法：<code>/remind 时间 内容</code>',
        '',
        '例如：',
        '  <code>/remind 10m 喝水</code>',
        '  <code>/remind 明天 9:00 提交周报</code>',
        '  <code>/remind 09:30 打电话给客户</code>',
        '',
        '查看待办：<code>/reminders</code>',
      ].join('\n')
    );
    return;
  }

  // 子命令：list / del / clear
  const first = raw.split(/\s+/)[0].toLowerCase();
  if (first === 'list' || first === 'ls') return listReminders(ctx);
  if (first === 'del' || first === 'rm' || first === 'delete') {
    return delReminder(ctx, raw.split(/\s+/)[1]);
  }
  if (first === 'clear') return clearReminders(ctx);

  const settings = await ctx.loadSettings();
  const tz = settings.tz;

  const parsed = parseWhen(raw, tz);
  if (!parsed) {
    await ctx.reply(
      [
        '❌ 没看懂时间。',
        '',
        '可以写成：<code>10m</code>、<code>2小时</code>、<code>09:30</code>、<code>明天 9:00</code>、<code>2026-10-02 14:00</code>',
        '完整说明见 <code>/help remind</code>',
      ].join('\n')
    );
    return;
  }

  const text = parsed.rest.trim();
  if (!text) {
    await ctx.reply('❌ 还差提醒内容。例如：<code>/remind 10m 喝水</code>');
    return;
  }

  const now = Date.now();
  if (parsed.at <= now + 3000) {
    await ctx.reply('❌ 这个时间已经过去了，请换一个未来的时间。');
    return;
  }
  if (parsed.at - now > MAX_AHEAD_MS) {
    await ctx.reply('❌ 提醒时间最远支持一年后。');
    return;
  }

  // 限制单个会话的提醒数量
  const existing = await ctx.store.listNames(`rm:`, 10000);
  const mine = [];
  for (const name of existing) {
    const parts = name.split(':');
    // key 形如 rm:{ts}:{chatId}:{id}
    if (parts[2] === String(ctx.chatId)) mine.push(name);
  }
  if (mine.length >= MAX_PER_CHAT) {
    await ctx.reply(`❌ 待办提醒已达上限（${MAX_PER_CHAT} 条），先用 <code>/reminders</code> 清理一些。`);
    return;
  }

  const id = shortId(5);
  const key = `rm:${tsKey(parsed.at)}:${ctx.chatId}:${id}`;
  await ctx.store.setJSON(key, {
    id,
    chatId: ctx.chatId,
    text,
    at: parsed.at,
    tz,
    createdAt: now,
  });

  await ctx.reply(
    [
      '⏰ <b>提醒已设置</b>',
      '',
      `内容：${esc(text)}`,
      `时间：${esc(formatInTz(parsed.at, tz))}`,
      `还有：${esc(humanizeUntil(parsed.at, now))}`,
      '',
      `取消：<code>/remind del ${esc(id)}</code>`,
    ].join('\n')
  );
}

async function listReminders(ctx) {
  const names = await ctx.store.listNames('rm:');
  const mine = names.filter((n) => n.split(':')[2] === String(ctx.chatId));
  if (!mine.length) {
    await ctx.reply('📭 没有待办提醒。\n\n用 <code>/remind 10m 喝水</code> 设一个试试。');
    return;
  }
  const items = (await Promise.all(mine.map((n) => ctx.store.getJSON(n)))).filter(Boolean);
  items.sort((a, b) => a.at - b.at);

  const now = Date.now();
  const settings = await ctx.loadSettings();
  await ctx.reply(
    [
      `⏰ <b>待办提醒（${items.length}）</b>`,
      '',
      ...items.map(
        (it) =>
          `• <code>${esc(it.id)}</code> ${esc(it.text)}\n  ${esc(formatInTz(it.at, it.tz || settings.tz))} · ${esc(humanizeUntil(it.at, now))}`
      ),
      '',
      '取消：<code>/remind del ID</code> · 清空：<code>/remind clear</code>',
    ].join('\n')
  );
}

async function delReminder(ctx, id) {
  if (!id) {
    await ctx.reply('用法：<code>/remind del ID</code>，ID 见 <code>/reminders</code>');
    return;
  }
  const names = await ctx.store.listNames('rm:');
  const target = names.find((n) => {
    const parts = n.split(':');
    return parts[2] === String(ctx.chatId) && parts[3] === id;
  });
  if (!target) {
    await ctx.reply(`找不到提醒 <code>${esc(id)}</code>。`);
    return;
  }
  await ctx.store.del(target);
  await ctx.reply(`🗑 已取消提醒 <code>${esc(id)}</code>`);
}

async function clearReminders(ctx) {
  const names = await ctx.store.listNames('rm:');
  const mine = names.filter((n) => n.split(':')[2] === String(ctx.chatId));
  await Promise.all(mine.map((n) => ctx.store.del(n)));
  await ctx.reply(mine.length ? `🗑 已清空 ${mine.length} 条提醒` : '本来就没有待办提醒。');
}

/* ─────────────────────── 定时派发 ─────────────────────── */

async function cronRemind({ store, bot, now }) {
  let cursor;
  let scanned = 0;

  outer: do {
    const res = await store.kv.list({ prefix: 'rm:', cursor, limit: 200 });

    for (const k of res.keys) {
      const at = Number(k.name.split(':')[1]);
      // 字典序 == 时间序：一旦遇到未到期，后面的都未到期，直接停
      if (at > now) break outer;

      scanned++;
      const item = await store.getJSON(k.name);
      await store.del(k.name);

      if (!item) continue;

      try {
        const settings = await store.getSettings(item.chatId, { muted: false });
        if (settings.muted) continue;

        await bot.sendMessage(
          item.chatId,
          [
            '⏰ <b>提醒</b>',
            '',
            esc(item.text),
            '',
            `<i>设定于 ${esc(formatInTz(item.createdAt, item.tz || 'UTC'))}</i>`,
          ].join('\n')
        );
      } catch (err) {
        console.error('[remind] 派发失败', item.chatId, err);
      }

      if (scanned > 200) break outer; // 单次 tick 的安全上限
    }

    cursor = res.list_complete ? null : res.cursor;
  } while (cursor);
}
