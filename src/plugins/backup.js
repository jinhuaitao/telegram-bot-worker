/**
 * plugins/backup.js —— 数据导出
 *
 * /export 把本会话的全部数据（设置、天气订阅、监控项、提醒、RSS、待办、AI 上下文）
 * 打包成一个 JSON 文件，通过 sendDocument 发给用户。
 */
import { esc, formatInTz } from '../utils.js';

export default {
  name: 'backup',
  title: '备份',
  summary: '导出本会话全部数据为 JSON',

  commands: {
    export: {
      desc: '导出本会话全部数据',
      usage: '/export',
      detail: '把设置、天气订阅、监控项、提醒、RSS 订阅、待办清单打包成 JSON 文件发给你，可用于备份或迁移。',
      run: handleExport,
    },
  },
};

async function handleExport(ctx) {
  const chatId = ctx.chatId;
  await ctx.bot.sendChatAction(chatId, 'upload_document');

  const stripKeys = (items) => items.map(({ __key, ...rest }) => rest);

  // 提醒的 key 是 rm:{时间戳}:{chatId}:{id}，按 chatId 过滤
  const rmNames = await ctx.store.listNames('rm:');
  const myRmNames = rmNames.filter((n) => n.split(':')[2] === String(chatId));
  const reminders = [];
  for (const n of myRmNames) {
    const v = await ctx.store.getJSON(n);
    if (v) reminders.push(v);
  }

  const [settings, weather, monitors, rss, todos, aiCtx] = await Promise.all([
    ctx.store.getSettings(chatId, {}),
    ctx.store.listJSON(`wx:${chatId}:`),
    ctx.store.listJSON(`mon:${chatId}:`),
    ctx.store.listJSON(`rss:${chatId}:`),
    ctx.store.listJSON(`td:${chatId}:`),
    ctx.store.getJSON(`ai:${chatId}`, null),
  ]);

  const payload = {
    version: 1,
    exportedAt: new Date().toISOString(),
    chatId,
    data: {
      settings,
      weather: stripKeys(weather),
      monitors: stripKeys(monitors),
      reminders,
      rss: stripKeys(rss),
      todos: stripKeys(todos),
      aiContext: aiCtx,
    },
  };

  const date = new Date().toISOString().slice(0, 10);
  const filename = `tg-bot-backup-${chatId}-${date}.json`;
  const content = JSON.stringify(payload, null, 2);

  const counts = [
    weather.length && `🌤 天气 ${weather.length}`,
    monitors.length && `📡 监控 ${monitors.length}`,
    reminders.length && `⏰ 提醒 ${reminders.length}`,
    rss.length && `📰 RSS ${rss.length}`,
    todos.length && `📝 待办 ${todos.length}`,
  ].filter(Boolean);

  try {
    await ctx.bot.sendDocument(
      chatId,
      { filename, content, mime: 'application/json' },
      {
        caption: [
          '📦 <b>数据导出完成</b>',
          '',
          counts.length ? counts.join(' · ') : '这个会话还没有存任何数据',
          '',
          `<i>导出时间：${esc(formatInTz(Date.now(), settings.tz || ctx.env.DEFAULT_TZ || 'UTC'))}</i>`,
        ].join('\n'),
      }
    );
  } catch (err) {
    console.warn('[backup] 发送文件失败', err);
    await ctx.reply(`❌ 导出失败：${esc(err.message || String(err))}\n稍后再试。`);
  }
}
