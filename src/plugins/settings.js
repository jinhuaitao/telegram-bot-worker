/**
 * plugins/settings.js —— 用户偏好：时区、静音
 */
import { esc, isValidTz, formatInTz } from '../utils.js';

const COMMON_TZ = [
  ['Asia/Shanghai', '中国标准时间 (UTC+8)'],
  ['Asia/Hong_Kong', '中国香港 (UTC+8)'],
  ['Asia/Taipei', '中国台湾 (UTC+8)'],
  ['Asia/Tokyo', '日本 (UTC+9)'],
  ['Asia/Singapore', '新加坡 (UTC+8)'],
  ['Europe/London', '伦敦'],
  ['America/New_York', '纽约'],
  ['America/Los_Angeles', '洛杉矶'],
  ['UTC', '协调世界时'],
];

export default {
  name: 'settings',
  title: '设置',
  summary: '时区、静音等个人偏好',

  commands: {
    settings: { desc: '查看当前设置', usage: '/settings', run: showSettings },
    tz: {
      desc: '设置时区',
      usage: '/tz Asia/Shanghai',
      detail: '所有定时推送、提醒都以该时区为准。默认取 DEFAULT_TZ。',
      run: setTz,
    },
    mute: { desc: '开关静音（只影响定时推送）', usage: '/mute on|off', run: setMute },
  },
};

async function showSettings(ctx) {
  const s = await ctx.loadSettings();
  await ctx.reply(
    [
      '⚙️ <b>当前设置</b>',
      '',
      `时区：<code>${esc(s.tz)}</code>`,
      `当前时间：${esc(formatInTz(Date.now(), s.tz))}`,
      `定时推送：${s.muted ? '🔕 已静音' : '🔔 开启'}`,
      '',
      '常用时区：',
      ...COMMON_TZ.map(([tz, label]) => `  <code>${esc(tz)}</code> ${esc(label)}`),
      '',
      '用 <code>/tz 时区名</code> 修改。',
    ].join('\n')
  );
}

async function setTz(ctx) {
  const tz = ctx.argv[0];
  if (!tz) {
    await ctx.reply('用法：<code>/tz Asia/Shanghai</code>\n用 <code>/settings</code> 查看常用时区列表。');
    return;
  }
  if (!isValidTz(tz)) {
    await ctx.reply(`❌ <code>${esc(tz)}</code> 不是有效的 IANA 时区名，例如 <code>Asia/Shanghai</code>。`);
    return;
  }
  await ctx.store.saveSettings(ctx.chatId, { tz });
  await ctx.reply(`✅ 时区已设为 <code>${esc(tz)}</code>\n当前时间：${esc(formatInTz(Date.now(), tz))}`);
}

async function setMute(ctx) {
  const v = (ctx.argv[0] || '').toLowerCase();
  const on = ['on', '1', 'true', '开', '是'].includes(v);
  const off = ['off', '0', 'false', '关', '否'].includes(v);
  if (!on && !off) {
    await ctx.reply('用法：<code>/mute on</code> 或 <code>/mute off</code>');
    return;
  }
  await ctx.store.saveSettings(ctx.chatId, { muted: on });
  await ctx.reply(on ? '🔕 定时推送已静音（手动命令仍会正常回复）' : '🔔 定时推送已恢复');
}
