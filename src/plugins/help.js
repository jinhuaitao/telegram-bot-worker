/**
 * plugins/help.js —— 帮助与自检
 */
import { esc } from '../utils.js';

export default {
  name: 'help',
  title: '帮助',
  summary: '查看所有可用命令与运行状态',

  commands: {
    start: { desc: '开始使用', usage: '/start', hidden: false, run: showHelp },
    help: { desc: '查看帮助', usage: '/help [命令]', run: showHelp },
    id: { desc: '查看当前会话 ID', usage: '/id', run: showId },
    ping: { desc: '连通性自检', usage: '/ping', run: showPing },
  },
};

async function showHelp(ctx) {
  const { app, argv } = ctx;

  // /help weather → 单个命令详情
  if (argv[0]) {
    const key = argv[0].replace(/^\//, '').toLowerCase();
    const entry = app.commands.get(key);
    if (!entry) {
      await ctx.reply(`找不到命令 <code>/${esc(key)}</code>，用 /help 查看全部。`);
      return;
    }
    const lines = [
      `<b>/${esc(key)}</b> — ${esc(entry.desc || '')}`,
      '',
      entry.usage ? `用法：<code>${esc(entry.usage)}</code>` : '',
      entry.detail ? `\n${entry.detail}` : '',
      entry.plugin ? `\n所属插件：${esc(entry.plugin.title || entry.plugin.name)}` : '',
    ];
    await ctx.reply(lines.filter(Boolean).join('\n'));
    return;
  }

  // 按插件分组输出全部命令
  const groups = new Map();
  for (const [name, entry] of app.commands) {
    if (entry.hidden) continue;
    const p = entry.plugin || { name: 'misc', title: '其他' };
    if (!groups.has(p.name)) groups.set(p.name, { title: p.title || p.name, summary: p.summary, items: [] });
    groups.get(p.name).items.push({ name, ...entry });
  }

  const blocks = [
    '🤖 <b>多功能机器人</b>',
    '<i>天气订阅 · 监控告警 · 定时提醒 · 翻译</i>',
    '',
  ];

  for (const g of groups.values()) {
    blocks.push(`<b>${esc(g.title)}</b>${g.summary ? ` — <i>${esc(g.summary)}</i>` : ''}`);
    for (const c of g.items) {
      blocks.push(`  <code>/${esc(c.name)}</code> ${esc(c.desc || '')}`);
    }
    blocks.push('');
  }

  blocks.push('用 <code>/help 命令名</code> 查看详细用法与示例。');
  await ctx.reply(blocks.join('\n'));
}

async function showId(ctx) {
  const { chatId, from, message } = ctx;
  await ctx.reply(
    [
      `会话 ID：<code>${esc(chatId)}</code>`,
      `类型：${esc(message.chat.type)}`,
      from?.username ? `你的用户名：@${esc(from.username)}` : '',
    ]
      .filter(Boolean)
      .join('\n')
  );
}

async function showPing(ctx) {
  const t0 = Date.now();
  const me = await ctx.bot.getMe().catch(() => null);
  const t1 = Date.now();
  const settings = await ctx.loadSettings();
  await ctx.reply(
    [
      '🏓 <b>Pong</b>',
      `Telegram API 往返：${t1 - t0} ms`,
      `时区：<code>${esc(settings.tz)}</code>`,
      me ? `机器人：@${esc(me.username)}` : '机器人信息获取失败',
    ].join('\n')
  );
}
