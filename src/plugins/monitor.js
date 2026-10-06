/**
 * plugins/monitor.js —— 站点/接口监控告警
 *
 * 支持检查：HTTP 状态码、响应正文包含/不包含关键字、响应耗时、请求超时
 * 防抖动：连续失败达到阈值才告警；恢复正常时补一条恢复通知
 */
import { esc, shortId, humanizeMinutes } from '../utils.js';

const DEFAULTS = {
  intervalMin: 5,
  timeoutMs: 10000,
  failThreshold: 2,
  method: 'GET',
};

export default {
  name: 'monitor',
  title: '监控',
  summary: '定时探活 URL，异常时主动告警',

  commands: {
    mon: {
      desc: '监控管理',
      usage: '/mon add <url> [选项] | list | del <id> | check <id> | on|off <id>',
      detail: [
        '<b>选项</b>（key=value，可任意组合）：',
        '  <code>name=官网</code> 显示名称',
        '  <code>interval=5</code> 检查间隔（分钟，最小 1）',
        '  <code>expect=200</code> 期望状态码',
        '  <code>contains=Welcome</code> 正文必须包含',
        '  <code>notcontains=Error</code> 正文不得包含',
        '  <code>maxlatency=2000</code> 响应耗时上限（毫秒）',
        '  <code>timeout=10</code> 请求超时（秒）',
        '  <code>method=POST</code> 请求方法',
        '',
        '<b>示例</b>：',
        '  <code>/mon add https://example.com name=官网 interval=5 expect=200</code>',
        '  <code>/mon add https://api.test.com/health contains=ok maxlatency=1500</code>',
      ].join('\n'),
      run: handleMon,
    },
  },

  cron: cronMonitor,
};

/* ─────────────────────── 命令处理 ─────────────────────── */

async function handleMon(ctx) {
  const [sub, ...rest] = ctx.argv;
  switch ((sub || '').toLowerCase()) {
    case 'add':
    case 'new':
    case '添加':
      return addMonitor(ctx, rest);
    case 'list':
    case 'ls':
    case '':
      return listMonitors(ctx);
    case 'del':
    case 'rm':
    case 'delete':
    case '删除':
      return delMonitor(ctx, rest[0]);
    case 'check':
    case 'test':
    case '检查':
      return checkNow(ctx, rest[0]);
    case 'on':
      return toggleMonitor(ctx, rest[0], true);
    case 'off':
      return toggleMonitor(ctx, rest[0], false);
    default:
      await ctx.reply('未知子命令。用法：<code>/mon add|list|del|check|on|off</code>，详见 <code>/help mon</code>');
  }
}

async function addMonitor(ctx, tokens) {
  if (!tokens.length) {
    await ctx.reply('用法：<code>/mon add https://example.com name=官网 interval=5 expect=200</code>');
    return;
  }

  // 第一个非 key=value 的 token 视为 URL
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
    await ctx.reply('❌ 缺少 URL。用法：<code>/mon add https://example.com name=官网</code>');
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

  // SSRF 防护：拒绝内网/保留地址
  if (isPrivateHost(parsed.hostname)) {
    await ctx.reply(
      `❌ <code>${esc(parsed.hostname)}</code> 指向内网或保留地址，不允许监控（SSRF 防护）。`
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
    name: opts.name || parsed.hostname,
    intervalMin: num(opts.interval, DEFAULTS.intervalMin, 1, 1440),
    expectStatus: opts.expect !== undefined ? num(opts.expect, null, 100, 599) : null,
    contains: opts.contains || null,
    notContains: opts.notcontains || opts.not_contains || null,
    maxLatencyMs: opts.maxlatency !== undefined ? num(opts.maxlatency, null, 1, 300000) : null,
    timeoutMs: num(opts.timeout, DEFAULTS.timeoutMs / 1000, 1, 120) * 1000,
    method: (opts.method || DEFAULTS.method).toUpperCase(),
    failThreshold: num(opts.threshold, DEFAULTS.failThreshold, 1, 20),
    enabled: true,
    failCount: 0,
    alerted: false,
    lastCheck: 0,
    lastStatus: null,
    lastLatency: null,
    lastError: null,
    createdAt: Date.now(),
  };

  await ctx.store.setJSON(`mon:${ctx.chatId}:${id}`, item);

  // 立即跑一次，让用户马上看到结果
  await ctx.bot.sendChatAction(ctx.chatId);
  const result = await probe(item);
  item.lastCheck = Date.now();
  item.lastStatus = result.status;
  item.lastLatency = result.latency;
  item.failCount = result.ok ? 0 : 1;
  item.lastError = result.ok ? null : result.problems.join('；');
  await ctx.store.setJSON(`mon:${ctx.chatId}:${id}`, item);

  await ctx.reply(
    [
      '✅ <b>监控已添加</b>',
      '',
      `ID：<code>${esc(id)}</code>`,
      `名称：${esc(item.name)}`,
      `地址：${esc(item.url)}`,
      `间隔：每 ${esc(humanizeMinutes(item.intervalMin))}`,
      `条件：${esc(describeRules(item))}`,
      '',
      `首次探测：${result.ok ? '🟢 正常' : '🔴 异常'}` +
        (result.latency ? ` · ${result.latency} ms` : '') +
        (result.ok ? '' : `\n${esc(result.problems.join('；'))}`),
    ].join('\n')
  );
}

async function listMonitors(ctx) {
  const items = await ctx.store.listJSON(`mon:${ctx.chatId}:`);
  if (!items.length) {
    await ctx.reply(
      ['📭 还没有监控项。', '', '试试：<code>/mon add https://example.com name=官网 interval=5</code>'].join('\n')
    );
    return;
  }
  items.sort((a, b) => a.createdAt - b.createdAt);
  const lines = [`📡 <b>监控项（${items.length}）</b>`, ''];
  for (const it of items) {
    const dot = !it.enabled ? '⏸' : it.alerted ? '🔴' : it.lastStatus ? '🟢' : '⚪';
    lines.push(
      `${dot} <code>${esc(it.id)}</code> <b>${esc(it.name)}</b>${it.enabled ? '' : ' <i>(已暂停)</i>'}`,
      `   ${esc(it.url)}`,
      `   每 ${esc(humanizeMinutes(it.intervalMin))} · ${esc(describeRules(it))}` +
        (it.lastLatency ? ` · ${it.lastLatency}ms` : ''),
      ''
    );
  }
  lines.push('详情/操作：<code>/mon check ID</code> · <code>/mon del ID</code> · <code>/mon off ID</code>');
  await ctx.reply(lines.join('\n'));
}

async function delMonitor(ctx, id) {
  if (!id) {
    await ctx.reply('用法：<code>/mon del ID</code>');
    return;
  }
  const key = `mon:${ctx.chatId}:${id}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.reply(`找不到监控项 <code>${esc(id)}</code>，用 <code>/mon list</code> 查看。`);
    return;
  }
  await ctx.store.del(key);
  await ctx.reply(`🗑 已删除监控 <b>${esc(item.name)}</b>`);
}

async function toggleMonitor(ctx, id, enabled) {
  if (!id) {
    await ctx.reply(`用法：<code>/mon ${enabled ? 'on' : 'off'} ID</code>`);
    return;
  }
  const key = `mon:${ctx.chatId}:${id}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.reply(`找不到监控项 <code>${esc(id)}</code>。`);
    return;
  }
  item.enabled = enabled;
  if (enabled) {
    item.failCount = 0;
    item.alerted = false;
  }
  await ctx.store.setJSON(key, item);
  await ctx.reply(enabled ? `▶️ 已恢复监控 <b>${esc(item.name)}</b>` : `⏸ 已暂停监控 <b>${esc(item.name)}</b>`);
}

async function checkNow(ctx, id) {
  if (!id) {
    await ctx.reply('用法：<code>/mon check ID</code>');
    return;
  }
  const key = `mon:${ctx.chatId}:${id}`;
  const item = await ctx.store.getJSON(key);
  if (!item) {
    await ctx.reply(`找不到监控项 <code>${esc(id)}</code>。`);
    return;
  }
  await ctx.bot.sendChatAction(ctx.chatId);
  const r = await probe(item);

  item.lastCheck = Date.now();
  item.lastStatus = r.status;
  item.lastLatency = r.latency;
  item.lastError = r.ok ? null : r.problems.join('；');
  await ctx.store.setJSON(key, item);

  await ctx.reply(
    [
      `${r.ok ? '🟢' : '🔴'} <b>${esc(item.name)}</b>`,
      '',
      `状态码：${r.status || '—'}`,
      `耗时：${r.latency} ms`,
      r.ok ? '结果：正常' : `问题：${esc(r.problems.join('；'))}`,
    ].join('\n')
  );
}

/* ─────────────────────── 定时探活 ─────────────────────── */

async function cronMonitor({ store, bot, env, now }) {
  const all = await store.listJSON('mon:');
  if (!all.length) return;

  const maxPerTick = Number(env.MAX_MONITOR_PER_TICK || 20);
  const due = all
    .filter((it) => it.enabled && now - (it.lastCheck || 0) >= it.intervalMin * 60000)
    .sort((a, b) => (a.lastCheck || 0) - (b.lastCheck || 0))
    .slice(0, maxPerTick);

  if (!due.length) return;

  // 限制并发，避免瞬时打满 subrequest
  const CONCURRENCY = 5;
  for (let i = 0; i < due.length; i += CONCURRENCY) {
    const batch = due.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (item) => {
        try {
          await handleProbeResult(item, store, bot, now);
        } catch (err) {
          console.error('[monitor] 处理失败', item.url, err);
        }
      })
    );
  }
}

async function handleProbeResult(item, store, bot, now) {
  const r = await probe(item);

  item.lastCheck = now;
  item.lastStatus = r.status;
  item.lastLatency = r.latency;
  item.lastError = r.ok ? null : r.problems.join('；');

  if (r.ok) {
    // 从故障恢复 → 补一条恢复通知
    if (item.alerted) {
      item.alerted = false;
      item.failCount = 0;
      await bot.sendMessage(
        item.chatId,
        [
          '✅ <b>服务已恢复</b>',
          '',
          `名称：${esc(item.name)}`,
          `地址：${esc(item.url)}`,
          `状态码：${r.status} · 耗时：${r.latency} ms`,
        ].join('\n')
      );
    } else {
      item.failCount = 0;
    }
  } else {
    item.failCount = (item.failCount || 0) + 1;
    // 连续失败达到阈值且未告警 → 告警
    if (item.failCount >= item.failThreshold && !item.alerted) {
      item.alerted = true;
      await bot.sendMessage(
        item.chatId,
        [
          '🚨 <b>服务异常告警</b>',
          '',
          `名称：<b>${esc(item.name)}</b>`,
          `地址：${esc(item.url)}`,
          `连续失败：${item.failCount} 次`,
          `最近状态码：${r.status || '—'} · 耗时：${r.latency} ms`,
          '',
          `<b>问题</b>：${esc(r.problems.join('；'))}`,
          '',
          `<i>ID ${esc(item.id)} · 用 /mon off ${esc(item.id)} 可暂停</i>`,
        ].join('\n')
      );
    }
  }

  await store.setJSON(item.__key, stripInternal(item));
}

function stripInternal(item) {
  const { __key, ...rest } = item;
  return rest;
}

/* ─────────────────────── 探测实现 ─────────────────────── */

/**
 * 判断 hostname 是否指向内网/保留地址（SSRF 防护）。
 * 挡掉字面量形式的回环、私有网段、链路本地（含云元数据 169.254.169.254）。
 * 注意：DNS 解析后的 IP 不在检查范围内，主机名形式的内网域名仍需靠网络策略兜底。
 */
export function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().trim().replace(/\.$/, '');
  if (!h) return true;
  if (h === 'localhost' || h === '::1' || h === '::' || h === '0.0.0.0') return true;

  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const nums = v4.slice(1).map(Number);
    if (nums.some((n) => n > 255)) return true; // 非法 IP 也挡掉
    const [a, b] = nums;
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 127) return true; // 127.0.0.0/8 回环
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 链路本地
    return false;
  }

  // IPv6 字面量（URL 解析后 hostname 不带方括号）
  if (h.includes(':')) {
    return h === '::1' || h === '::' || h === '0:0:0:0:0:0:0:1';
  }
  return false;
}

async function probe(item) {
  // 纵深防御：cron 里加载的历史监控项也要再检查一次
  try {
    const u = new URL(item.url);
    if (isPrivateHost(u.hostname)) {
      return { ok: false, status: 0, latency: 0, problems: ['目标地址指向内网，已拦截（SSRF 防护）'] };
    }
  } catch {
    return { ok: false, status: 0, latency: 0, problems: ['URL 非法'] };
  }

  const started = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), item.timeoutMs || DEFAULTS.timeoutMs);

  try {
    const res = await fetch(item.url, {
      method: item.method || 'GET',
      redirect: 'follow',
      signal: ctrl.signal,
      headers: { 'User-Agent': 'tg-multibot/1.0 (+cloudflare-workers)' },
    });

    const latency = Date.now() - started;
    const needBody = Boolean(item.contains || item.notContains);
    let body = '';

    if (needBody) {
      body = await res.text();
      if (body.length > 300000) body = body.slice(0, 300000);
    } else {
      await res.arrayBuffer().catch(() => {});
    }

    const problems = [];
    if (item.expectStatus) {
      if (res.status !== item.expectStatus) {
        problems.push(`状态码 ${res.status}（期望 ${item.expectStatus}）`);
      }
    } else if (res.status >= 400) {
      problems.push(`状态码 ${res.status}`);
    }
    if (item.contains && !body.includes(item.contains)) {
      problems.push(`正文缺少关键字「${item.contains}」`);
    }
    if (item.notContains && body.includes(item.notContains)) {
      problems.push(`正文出现禁用关键字「${item.notContains}」`);
    }
    if (item.maxLatencyMs && latency > item.maxLatencyMs) {
      problems.push(`响应过慢 ${latency}ms（阈值 ${item.maxLatencyMs}ms）`);
    }

    return { ok: problems.length === 0, status: res.status, latency, problems };
  } catch (err) {
    const latency = Date.now() - started;
    const reason =
      err.name === 'AbortError'
        ? `请求超时（>${(item.timeoutMs || DEFAULTS.timeoutMs) / 1000}s）`
        : err.message || String(err);
    return { ok: false, status: 0, latency, problems: [`请求失败：${reason}`] };
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────── 描述 ─────────────────────── */

function describeRules(item) {
  const parts = [];
  parts.push(item.expectStatus ? `状态=${item.expectStatus}` : '状态<400');
  if (item.contains) parts.push(`含"${item.contains}"`);
  if (item.notContains) parts.push(`不含"${item.notContains}"`);
  if (item.maxLatencyMs) parts.push(`<${item.maxLatencyMs}ms`);
  return parts.join(' · ');
}
