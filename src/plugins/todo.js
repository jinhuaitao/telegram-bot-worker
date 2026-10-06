/**
 * plugins/todo.js —— 待办清单
 *
 * 和 /remind 的区别：remind 是「到点推送」的定时提醒，
 * todo 是「一直躺在清单里」的持久事项，用内联按钮勾选完成。
 *
 * Key 设计：td:{chatId}:{id}
 *   { id, chatId, text, done, createdAt }
 */
import { esc, shortId } from '../utils.js';

const MAX_PER_CHAT = 100;
const MAX_LEN = 500;

export default {
  name: 'todo',
  title: '待办',
  summary: '持久待办清单，点按钮勾选完成',

  commands: {
    todo: {
      desc: '待办清单管理',
      usage: '/todo add <内容>  ·  list | done <id> | del <id> | clear',
      detail: [
        '<code>/todo list</code> 会带上内联按钮，点一下就能勾选/取消完成。',
        '',
        '<b>示例</b>：',
        '  <code>/todo add 买牛奶</code>',
        '  <code>/todo list</code>',
        '  <code>/todo done abc12</code>',
      ].join('\n'),
      run: handleTodo,
    },
  },

  onCallback: handleTodoCallback,
};

/* ─────────────────────── 命令处理 ─────────────────────── */

async function handleTodo(ctx) {
  const [sub, ...rest] = ctx.argv;
  switch ((sub || '').toLowerCase()) {
    case 'add':
    case 'new':
    case '添加':
      return addTodo(ctx, rest.join(' ').trim());
    case 'list':
    case 'ls':
    case '':
      return listTodos(ctx);
    case 'done':
    case 'finish':
    case '完成':
      return setDone(ctx, rest[0], true);
    case 'undone':
    case '取消完成':
      return setDone(ctx, rest[0], false);
    case 'del':
    case 'rm':
    case 'delete':
    case '删除':
      return delTodo(ctx, rest[0]);
    case 'clear':
    case '清空':
      return clearTodos(ctx);
    default:
      await ctx.reply('未知子命令。用法：<code>/todo add|list|done|del|clear</code>，详见 <code>/help todo</code>');
  }
}

async function addTodo(ctx, text) {
  if (!text) {
    await ctx.reply('用法：<code>/todo add 买牛奶</code>');
    return;
  }
  if (text.length > MAX_LEN) {
    await ctx.reply(`❌ 内容太长（${text.length} 字），上限 ${MAX_LEN} 字。`);
    return;
  }
  const count = (await ctx.store.listNames(`td:${ctx.chatId}:`)).length;
  if (count >= MAX_PER_CHAT) {
    await ctx.reply(`❌ 待办太多了（${MAX_PER_CHAT} 条上限），先完成或删除一些吧。`);
    return;
  }

  const id = shortId(5);
  await ctx.store.setJSON(`td:${ctx.chatId}:${id}`, {
    id,
    chatId: ctx.chatId,
    text,
    done: false,
    createdAt: Date.now(),
  });

  await ctx.reply(`📝 已加入待办：<code>${esc(id)}</code> ${esc(truncate(text, 40))}\n用 <code>/todo list</code> 查看全部。`);
}

async function listTodos(ctx, edit = false) {
  const items = await ctx.store.listJSON(`td:${ctx.chatId}:`);
  items.sort((a, b) => a.createdAt - b.createdAt);

  const text = renderTodoText(items);
  const keyboard = todoKeyboard(items);

  if (edit && ctx.message?.message_id) {
    await ctx.bot.editMessageText(ctx.chatId, ctx.message.message_id, text, { reply_markup: keyboard });
    return;
  }
  await ctx.reply(text, { reply_markup: keyboard });
}

async function setDone(ctx, id, done) {
  if (!id) {
    await ctx.reply(`用法：<code>/todo ${done ? 'done' : 'undone'} ID</code>`);
    return;
  }
  const key = `td:${ctx.chatId}:${id}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.reply(`找不到待办 <code>${esc(id)}</code>，用 <code>/todo list</code> 查看。`);
    return;
  }
  item.done = done;
  await ctx.store.setJSON(key, item);
  await ctx.reply(done ? `✅ 已完成：${esc(truncate(item.text, 40))}` : `↩️ 已恢复为未完成：${esc(truncate(item.text, 40))}`);
}

async function delTodo(ctx, id) {
  if (!id) {
    await ctx.reply('用法：<code>/todo del ID</code>');
    return;
  }
  const key = `td:${ctx.chatId}:${id}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.reply(`找不到待办 <code>${esc(id)}</code>。`);
    return;
  }
  await ctx.store.del(key);
  await ctx.reply(`🗑 已删除：${esc(truncate(item.text, 40))}`);
}

async function clearTodos(ctx) {
  const n = await ctx.store.clearPrefix(`td:${ctx.chatId}:`);
  await ctx.reply(n ? `🧹 已清空 ${n} 条待办。` : '📭 清单本来就是空的。');
}

/* ─────────────────────── 内联按钮回调 ─────────────────────── */

// router 约定：回调数据 "todo:toggle:<id>" → onCallback(ctx, "toggle:<id>")
async function handleTodoCallback(ctx, data) {
  const [action, id] = String(data || '').split(':');
  if (action !== 'toggle' || !id) return;

  const key = `td:${ctx.chatId}:${id}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.bot.answerCallbackQuery(ctx.callbackId || '', '这条待办已经没了');
    return;
  }

  toggleTodoDone(item);
  await ctx.store.setJSON(key, item);

  const items = await ctx.store.listJSON(`td:${ctx.chatId}:`);
  items.sort((a, b) => a.createdAt - b.createdAt);

  try {
    await ctx.bot.editMessageText(ctx.chatId, ctx.message.message_id, renderTodoText(items), {
      reply_markup: todoKeyboard(items),
    });
  } catch {
    // 消息没变化时会抛错，忽略即可
  }
  if (ctx.callbackId) {
    await ctx.bot.answerCallbackQuery(ctx.callbackId, item.done ? '✅ 已完成' : '↩️ 已恢复');
  }
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? t.slice(0, n) + '…' : t;
}

/* ─────────────────────── 纯函数（可测试） ─────────────────────── */

/** 渲染清单文本 */
export function renderTodoText(items) {
  const list = [...(items || [])].sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) {
    return ['📭 <b>待办清单是空的</b>', '', '用 <code>/todo add 内容</code> 加一条吧。'].join('\n');
  }
  const open = list.filter((t) => !t.done).length;
  const lines = [`📝 <b>待办清单</b>（${open} 未完成 / ${list.length}）`, ''];
  for (const t of list) {
    lines.push(`${t.done ? '✅' : '⬜'} <code>${esc(t.id)}</code> ${esc(t.text)}`);
  }
  lines.push('', '<i>点下方按钮可快速勾选/取消</i>');
  return lines.join('\n');
}

/** 生成内联键盘：每条一个勾选按钮 */
export function todoKeyboard(items) {
  const list = [...(items || [])].sort((a, b) => a.createdAt - b.createdAt);
  const rows = list.map((t) => [
    {
      text: `${t.done ? '✅' : '⬜'} ${truncate(t.text, 24)}`,
      callback_data: `todo:toggle:${t.id}`,
    },
  ]);
  return { inline_keyboard: rows };
}

/** 翻转完成状态（返回同一对象） */
export function toggleTodoDone(item) {
  item.done = !item.done;
  return item;
}
