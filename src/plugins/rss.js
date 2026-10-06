/**
 * plugins/rss.js —— RSS 订阅
 *
 * Key 设计：rss:{chatId}:{id}
 *   { id, chatId, url, name, title, lastGuid, lastCheck, intervalMin, enabled }
 *
 * cron 每分钟被唤醒一次，但每个订阅按自己的 intervalMin（默认 30 分钟，
 * 可用 interval= 覆盖）决定是否真的去抓，避免把源站打爆。
 *
 * 解析用轻量正则实现，支持 RSS 2.0 和 Atom，零依赖。
 */
import { esc, shortId, fetchWithTimeout, humanizeMinutes } from '../utils.js';

const UA = 'tg-multibot/1.0 (+cloudflare-workers; rss)';

export default {
  name: 'rss',
  title: 'RSS 订阅',
  summary: '订阅博客/资讯，有新文章自动推送',

  commands: {
    rss: {
      desc: 'RSS 订阅管理',
      usage: '/rss add <url> [name=名字]  ·  list | del <id> | on|off <id>',
      detail: [
        '添加时先抓取验证 feed 是否有效，支持 RSS 2.0 和 Atom。',
        '有新文章时自动推送标题 + 链接。',
        '',
        '<b>示例</b>：',
        '  <code>/rss add https://example.com/feed.xml name=示例博客</code>',
        '  <code>/rss add https://example.com/atom.xml interval=60</code> — 每小时检查一次',
        '  <code>/rss list</code>',
        '  <code>/rss off abc12</code> — 暂停',
      ].join('\n'),
      run: handleRss,
    },
  },

  cron: cronRss,
};

/* ─────────────────────── 命令处理 ─────────────────────── */

async function handleRss(ctx) {
  const [sub, ...rest] = ctx.argv;
  switch ((sub || '').toLowerCase()) {
    case 'add':
    case 'new':
    case '添加':
      return addFeed(ctx, rest);
    case 'list':
    case 'ls':
    case '':
      return listFeeds(ctx);
    case 'del':
    case 'rm':
    case 'delete':
    case '删除':
      return delFeed(ctx, rest[0]);
    case 'on':
      return toggleFeed(ctx, rest[0], true);
    case 'off':
      return toggleFeed(ctx, rest[0], false);
    default:
      await ctx.reply('未知子命令。用法：<code>/rss add|list|del|on|off</code>，详见 <code>/help rss</code>');
  }
}

async function addFeed(ctx, tokens) {
  if (!tokens.length) {
    await ctx.reply('用法：<code>/rss add https://example.com/feed.xml name=名字</code>');
    return;
  }

  let url = null;
  const opts = {};
  for (const t of tokens) {
    const m = t.match(/^([a-zA-Z]+)=([\s\S]*)$/);
    if (m) {
      opts[m[1].toLowerCase()] = m[2];
    } else if (!url) {
      url = t;
    }
  }

  if (!url) {
    await ctx.reply('❌ 缺少 URL。用法：<code>/rss add https://example.com/feed.xml</code>');
    return;
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    await ctx.reply(`❌ <code>${esc(url)}</code> 不是合法的 URL，需要带 http:// 或 https://`);
    return;
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    await ctx.reply('❌ 只支持 http / https 协议。');
    return;
  }

  await ctx.bot.sendChatAction(ctx.chatId);

  // 先抓一次验证 feed 有效
  let feed;
  try {
    const res = await fetchWithTimeout(parsed.toString(), { headers: { 'User-Agent': UA } }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const xml = await res.text();
    feed = parseFeed(xml);
    if (!feed || !feed.items.length) throw new Error('没有解析出任何文章');
  } catch (err) {
    await ctx.reply(
      [
        '❌ <b>这个地址不像有效的 RSS/Atom 订阅源</b>',
        '',
        esc(err.message || String(err)),
        '',
        '确认地址拼对了，且返回的是 RSS 2.0 或 Atom 格式的 XML。',
      ].join('\n')
    );
    return;
  }

  const num = (v, fallback, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };

  const id = shortId(5);
  const item = {
    id,
    chatId: ctx.chatId,
    url: parsed.toString(),
    name: opts.name || feed.title || parsed.hostname,
    title: feed.title || '',
    lastGuid: feed.items[0].guid || feed.items[0].link || '',
    lastCheck: Date.now(),
    intervalMin: num(
      opts.interval,
      num(ctx.env.RSS_INTERVAL_MIN, 30, 5, 1440),
      5,
      1440
    ),
    enabled: true,
    createdAt: Date.now(),
  };

  await ctx.store.setJSON(`rss:${ctx.chatId}:${id}`, item);

  await ctx.reply(
    [
      '📰 <b>RSS 订阅已添加</b>',
      '',
      `ID：<code>${esc(id)}</code>`,
      `名称：${esc(item.name)}`,
      `地址：${esc(item.url)}`,
      `检查间隔：每 ${esc(humanizeMinutes(item.intervalMin))}`,
      `最新文章：${esc(feed.items[0].title || '（无标题）')}`,
      '',
      '有新文章时会自动推送给你。',
    ].join('\n')
  );
}

async function listFeeds(ctx) {
  const items = await ctx.store.listJSON(`rss:${ctx.chatId}:`);
  if (!items.length) {
    await ctx.reply(
      ['📭 还没有 RSS 订阅。', '', '试试：<code>/rss add https://example.com/feed.xml name=名字</code>'].join('\n')
    );
    return;
  }
  items.sort((a, b) => a.createdAt - b.createdAt);
  const lines = [`📰 <b>RSS 订阅（${items.length}）</b>`, ''];
  for (const it of items) {
    lines.push(
      `${it.enabled ? '🟢' : '⏸'} <code>${esc(it.id)}</code> <b>${esc(it.name)}</b>${it.enabled ? '' : ' <i>(已暂停)</i>'}`,
      `   ${esc(it.url)}`,
      `   每 ${esc(humanizeMinutes(it.intervalMin))} 检查`,
      ''
    );
  }
  lines.push('操作：<code>/rss del ID</code> · <code>/rss off ID</code>');
  await ctx.reply(lines.join('\n'));
}

async function delFeed(ctx, id) {
  if (!id) {
    await ctx.reply('用法：<code>/rss del ID</code>');
    return;
  }
  const key = `rss:${ctx.chatId}:${id}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.reply(`找不到订阅 <code>${esc(id)}</code>，用 <code>/rss list</code> 查看。`);
    return;
  }
  await ctx.store.del(key);
  await ctx.reply(`🗑 已取消订阅 <b>${esc(item.name)}</b>`);
}

async function toggleFeed(ctx, id, enabled) {
  if (!id) {
    await ctx.reply(`用法：<code>/rss ${enabled ? 'on' : 'off'} ID</code>`);
    return;
  }
  const key = `rss:${ctx.chatId}:${id}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.reply(`找不到订阅 <code>${esc(id)}</code>。`);
    return;
  }
  item.enabled = enabled;
  await ctx.store.setJSON(key, item);
  await ctx.reply(enabled ? `▶️ 已恢复订阅 <b>${esc(item.name)}</b>` : `⏸ 已暂停订阅 <b>${esc(item.name)}</b>`);
}

/* ─────────────────────── 定时检查 ─────────────────────── */

async function cronRss({ store, bot, env, now }) {
  const all = await store.listJSON('rss:');
  if (!all.length) return;

  const maxPerTick = Number(env.MAX_RSS_PER_TICK || 10);
  const due = all
    .filter((it) => it.enabled && now - (it.lastCheck || 0) >= (it.intervalMin || 30) * 60000)
    .sort((a, b) => (a.lastCheck || 0) - (b.lastCheck || 0))
    .slice(0, maxPerTick);

  for (const sub of due) {
    try {
      await checkFeed(sub, store, bot, now);
    } catch (err) {
      console.error('[rss] 检查失败', sub.url, err);
      // 失败也更新 lastCheck，避免一个挂掉的源每分钟都重试
      sub.lastCheck = now;
      await store.setJSON(sub.__key, stripInternal(sub));
    }
  }
}

async function checkFeed(sub, store, bot, now) {
  const res = await fetchWithTimeout(sub.url, { headers: { 'User-Agent': UA } }, 15000);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const feed = parseFeed(await res.text());

  sub.lastCheck = now;
  if (!feed || !feed.items.length) {
    await store.setJSON(sub.__key, stripInternal(sub));
    return;
  }

  const newestGuid = feed.items[0].guid || feed.items[0].link || '';

  if (!sub.lastGuid) {
    // 首次成功检查：只记录，不推送，避免把历史文章全推一遍
    sub.lastGuid = newestGuid;
  } else {
    const fresh = [];
    for (const it of feed.items) {
      const g = it.guid || it.link || '';
      if (g && g === sub.lastGuid) break;
      fresh.push(it);
    }
    if (fresh.length) {
      sub.lastGuid = fresh[0].guid || fresh[0].link || sub.lastGuid;
      // 按发布时间从旧到新推送
      for (const it of fresh.slice().reverse()) {
        await bot.sendMessage(
          sub.chatId,
          [
            `📰 <b>${esc(it.title || '无标题')}</b>`,
            `<i>${esc(sub.name)}</i>`,
            it.link ? esc(it.link) : '',
          ].filter(Boolean).join('\n'),
          { disable_web_page_preview: false }
        );
      }
    }
  }

  await store.setJSON(sub.__key, stripInternal(sub));
}

function stripInternal(item) {
  const { __key, ...rest } = item;
  return rest;
}

/* ─────────────────────── 轻量 Feed 解析 ─────────────────────── */

function tagContent(body, tag) {
  const m = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1] : '';
}

/** 去 CDATA 包裹并剥掉内嵌标签 */
function cleanText(s) {
  let t = String(s || '').trim();
  t = t.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gi, '$1');
  return t.replace(/<[^>]*>/g, '').trim();
}

/**
 * 解析 RSS 2.0 / Atom XML。
 * @returns {{title:string, items:Array<{title,link,guid}>}|null}
 */
export function parseFeed(xml) {
  const s = String(xml || '');
  if (!/<(rss|feed)[\s>]/i.test(s)) return null;

  const items = [];

  // RSS 2.0：<item>
  const itemRe = /<item[\s>]([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRe.exec(s))) {
    const body = m[1];
    const link = cleanText(tagContent(body, 'link'));
    items.push({
      title: cleanText(tagContent(body, 'title')),
      link,
      guid: cleanText(tagContent(body, 'guid')) || link,
    });
  }

  // Atom：<entry>
  const entryRe = /<entry[\s>]([\s\S]*?)<\/entry>/gi;
  while ((m = entryRe.exec(s))) {
    const body = m[1];
    const linkM = body.match(/<link[^>]*?href\s*=\s*["']([^"']+)["'][^>]*\/?>/i);
    const link = (linkM ? linkM[1] : cleanText(tagContent(body, 'link'))).trim();
    const id = cleanText(tagContent(body, 'id'));
    items.push({
      title: cleanText(tagContent(body, 'title')),
      link,
      guid: id || link,
    });
  }

  if (!items.length) return null;

  // 标题：RSS 取 <channel><title>，Atom 取第一个 <entry> 之前的 <title>
  let title = '';
  const channelM = s.match(/<channel[\s>]([\s\S]*?)<\/channel>/i);
  if (channelM) {
    title = cleanText(tagContent(channelM[1], 'title'));
  } else {
    const feedHead = s.split(/<entry[\s>]/i)[0];
    title = cleanText(tagContent(feedHead, 'title'));
  }

  return { title, items: items.filter((it) => it.title || it.link) };
}
