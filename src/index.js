/**
 * index.js —— Worker 入口
 *
 *   fetch()     ← Telegram Webhook 推送更新
 *   scheduled() ← Cron Trigger 每分钟唤醒，驱动各插件的定时任务
 */
import { Telegram } from './telegram.js';
import { Store } from './store.js';
import { routeUpdate } from './router.js';
import { runCron } from './cron.js';
import { PLUGINS, buildCommandMap, validatePlugins } from './plugins/index.js';
import { esc } from './utils.js';

/**
 * 代码版本标记。改功能时顺手更新 ——
 * /setup?action=diagnose 会把它显示出来，方便确认线上跑的到底是哪一版。
 */
const CODE_VERSION = '2026-10-06 · v2（多源翻译降级 + AI/RSS/汇率/待办/备份/限流/SSRF）';

/** 组装一次性的应用上下文 */
function createApp(env) {
  return {
    env,
    store: new Store(env.BOT_R2),
    bot: new Telegram(env.BOT_TOKEN),
    plugins: PLUGINS,
    commands: buildCommandMap(PLUGINS),
  };
}

// 冷启动时校验插件契约
const CONTRACT_ERRORS = validatePlugins(PLUGINS);
if (CONTRACT_ERRORS.length) {
  console.error('[bootstrap] 插件契约存在问题：\n  - ' + CONTRACT_ERRORS.join('\n  - '));
}

export default {
  /* ───────────── Telegram Webhook ───────────── */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 一键自注册 Webhook —— 让「面板连 GitHub 部署」的用户不必碰命令行。
    // 用法：浏览器打开 /setup?key=<WEBHOOK_SECRET>
    if (url.pathname === '/setup') {
      return handleSetup(url, env);
    }

    // 健康检查 / 状态页
    // /healthz 返回机器可读的 JSON，供 Uptime Kuma 等外部监控轮询
    if (url.pathname === '/healthz') {
      return new Response(
        JSON.stringify({
          ok: true,
          version: CODE_VERSION,
          plugins: PLUGINS.map((p) => p.name),
          time: new Date().toISOString(),
        }),
        {
          status: 200,
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store',
          },
        }
      );
    }
    if (request.method === 'GET') {
      return html(statusPage(env, url));
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    // 路径校验（可选，配合 webhook 的 secret path 使用）
    if (url.pathname !== '/' && url.pathname !== '/webhook') {
      return new Response('Not Found', { status: 404 });
    }

    // 校验 Telegram 的 secret token —— 防止伪造请求
    const secret = env.WEBHOOK_SECRET;
    if (secret) {
      const got = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
      if (got !== secret) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const app = createApp(env);

    // 必须立刻 200，否则 Telegram 会重推；真正的处理丢到 waitUntil
    ctx.waitUntil(
      routeUpdate(update, app).catch((err) => {
        console.error('[fetch] 处理更新失败', err);
      })
    );

    return new Response('OK', { status: 200 });
  },

  /* ───────────── Cron Trigger ───────────── */
  async scheduled(event, env, ctx) {
    const app = createApp(env);
    ctx.waitUntil(
      runCron(event, app).catch((err) => {
        console.error('[scheduled] 调度失败', err);
      })
    );
  },
};

const PAGE_CSS = `
  :root { color-scheme: light; }
  body { font: 15px/1.7 -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif;
         max-width: 680px; margin: 40px auto; padding: 0 20px; color: #1a1a1a; background: #fff; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #666; margin-bottom: 24px; }
  ul { list-style: none; padding: 0; }
  li { padding: 12px 0; border-bottom: 1px solid #eee; }
  li div { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 10px; }
  li span { color: #666; font-size: 13px; }
  code { background: #f4f4f5; padding: 2px 6px; border-radius: 4px; font-size: 13px;
         font-family: ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; }
  .ok { display: inline-block; background: #e7f6ec; color: #1a7f37; padding: 3px 10px;
        border-radius: 20px; font-size: 13px; }
  .warn { background: #fff5e6; color: #a15c00; padding: 14px 18px; border-radius: 8px; margin: 20px 0; }
  .card { background: #eef4ff; color: #1a3a6b; padding: 14px 18px; border-radius: 8px; margin: 20px 0; }
  .card p { margin: 8px 0; font-size: 14px; }
  .good { background: #e7f6ec; color: #1a7f37; padding: 14px 18px; border-radius: 8px; margin: 20px 0; }
`;

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function statusPage(env, url) {
  const rows = PLUGINS.map((p) => {
    const cmds = Object.entries(p.commands || {})
      .map(([name, d]) => `<code>/${esc(name)}</code> <span>${esc(d.desc || '')}</span>`)
      .join('');
    return `<li><b>${esc(p.title || p.name)}</b> <i>${esc(p.summary || '')}</i><div>${cmds}</div></li>`;
  }).join('');

  const missing = [];
  if (!env.BOT_TOKEN) missing.push('BOT_TOKEN 未配置');
  if (!env.BOT_R2) missing.push('BOT_R2 未绑定');
  if (!env.WEBHOOK_SECRET) missing.push('WEBHOOK_SECRET 未配置');

  let banner;
  if (missing.length) {
    banner = `<div class="warn">
      <b>还差几步就能用了</b>
      <p>请到 Cloudflare 面板的 <b>Settings → Variables &amp; Secrets</b> 补上：</p>
      <p>${missing.map((m) => '· ' + esc(m)).join('<br>')}</p>
      <p style="font-size:13px">保存后需要重新部署一次才会生效。</p>
    </div>`;
  } else {
    banner = `<div class="card">
      <b>最后一步：注册 Webhook</b>
      <p>在浏览器打开下面这个地址，机器人会自动把自己注册到 Telegram，不需要命令行：</p>
      <p><code>${esc(url.origin)}/setup?key=<b>你的 WEBHOOK_SECRET</b></code></p>
      <p style="font-size:13px">把 <code>key=</code> 后面换成你在面板里设置的 WEBHOOK_SECRET 值。</p>
    </div>`;
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Telegram Bot · 运行中</title>
<style>${PAGE_CSS}</style>
</head>
<body>
  <h1>Telegram Bot <span class="ok">运行中</span></h1>
  <p class="sub">Cloudflare Workers · 插件式架构 · 已注册 ${PLUGINS.length} 个插件</p>
  ${banner}
  <ul>${rows}</ul>
</body>
</html>`;
}

/* ───────────── 一键注册 Webhook ───────────── */

async function handleSetup(url, env) {
  const key = url.searchParams.get('key') || '';
  const action = (url.searchParams.get('action') || 'set').toLowerCase();

  if (!env.WEBHOOK_SECRET) {
    return html(resultPage('还没配置密钥', [
      '请先到 Cloudflare 面板的 <b>Settings → Variables &amp; Secrets</b> 添加一个名为 <code>WEBHOOK_SECRET</code> 的变量，类型选 <b>Secret</b>，值填一串随机字符。',
      '保存后重新部署一次，再回到本页。',
    ], false), 400);
  }

  if (!env.BOT_TOKEN) {
    return html(resultPage('缺少 BOT_TOKEN', [
      '请到 <b>Settings → Variables &amp; Secrets</b> 添加名为 <code>BOT_TOKEN</code> 的密钥，值是从 @BotFather 拿到的 Token。',
    ], false), 400);
  }

  if (key !== env.WEBHOOK_SECRET) {
    return html(resultPage('密钥不正确', [
      '地址里 <code>key=</code> 的值必须和你在面板里设置的 <code>WEBHOOK_SECRET</code> 完全一致。',
    ], false), 403);
  }

  const bot = new Telegram(env.BOT_TOKEN);
  const self = `${url.protocol}//${url.host}`;

  try {
    if (action === 'delete') {
      await bot.deleteWebhook();
      return html(resultPage('已解除 Webhook', [
        '机器人已断开与 Telegram 的连接。',
        '把地址里的 <code>action=delete</code> 去掉再访问一次，即可重新连接。',
      ], true));
    }

    if (action === 'info') {
      const info = await bot.getWebhookInfo();
      return html(resultPage('Webhook 当前状态', [
        `地址：<code>${esc(info.url || '未设置')}</code>`,
        `待处理更新：${esc(String(info.pending_update_count ?? 0))}`,
        `最近错误：${esc(info.last_error_message || '无')}`,
      ], Boolean(info.url)));
    }

    if (action === 'diagnose') {
      return html(await diagnosePage(env));
    }

    const me = await bot.getMe();
    await bot.setWebhook(self, env.WEBHOOK_SECRET, [
      'message', 'edited_message', 'channel_post', 'callback_query',
    ]);
    const info = await bot.getWebhookInfo();

    return html(resultPage(`@${esc(me.username)} 已就绪`, [
      `Webhook 已指向 <code>${esc(self)}</code>`,
      `待处理更新：${esc(String(info.pending_update_count ?? 0))}`,
      `最近错误：${esc(info.last_error_message || '无')}`,
      '现在去 Telegram 里给机器人发一条 <code>/start</code> 试试。',
    ], true));
  } catch (err) {
    return html(resultPage('设置失败', [
      esc(String(err.message || err)),
      '常见原因：BOT_TOKEN 填错了，或者网络暂时不通。改好后刷新本页重试。',
    ], false), 500);
  }
}

function resultPage(title, lines, ok) {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<style>${PAGE_CSS}</style>
</head>
<body>
  <h1>${ok ? '✅' : '⚠️'} ${esc(title)}</h1>
  <div class="${ok ? 'good' : 'warn'}">
    ${lines.map((l) => `<p style="margin:6px 0">${l}</p>`).join('')}
  </div>
  <p class="sub"><a href="/">← 返回状态页</a></p>
</body>
</html>`;
}

/* ───────────── 运行诊断 ───────────── */

async function diagnosePage(env) {
  const config = [
    ['BOT_TOKEN', Boolean(env.BOT_TOKEN), env.BOT_TOKEN
      ? '已配置'
      : '缺失 —— 去 Settings → Variables & Secrets 添加，类型选 Secret'],
    ['WEBHOOK_SECRET', Boolean(env.WEBHOOK_SECRET), env.WEBHOOK_SECRET
      ? '已配置'
      : '缺失 —— 没有它，任何人都能伪造消息打你的机器人'],
    ['BOT_R2', Boolean(env.BOT_R2), env.BOT_R2
      ? '已绑定'
      : '缺失 —— 订阅、提醒、监控都无法保存'],
    ['AI', Boolean(env.AI), env.AI
      ? '已绑定，翻译会优先走 Workers AI'
      : '未绑定 —— 翻译走 Google / MyMemory，可能遇到 429'],
  ];

  const translate = PLUGINS.find((p) => p.name === 'translate');
  let providerBlock = '';

  if (typeof translate?.diagnose === 'function') {
    try {
      const { chain, results } = await translate.diagnose(env);
      providerBlock = `
  <h2 style="font-size:15px;margin:26px 0 4px">翻译源实测</h2>
  <p class="sub" style="margin-bottom:8px">降级顺序：${chain.map((c) => `<code>${esc(c)}</code>`).join(' → ')}</p>
  <ul>
    ${results.map((r) => `<li>${r.ok ? '✅' : '❌'} <b>${esc(r.name)}</b> — ${esc(r.detail)} <span>${r.ms}ms</span></li>`).join('')}
  </ul>`;
    } catch (err) {
      providerBlock = `<div class="warn">翻译源自检失败：${esc(String(err.message || err))}</div>`;
    }
  }

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>运行诊断</title>
<style>${PAGE_CSS}</style>
</head>
<body>
  <h1>🔍 运行诊断</h1>
  <p class="sub">代码版本：<code>${esc(CODE_VERSION)}</code></p>

  <h2 style="font-size:15px;margin:26px 0 4px">绑定与配置</h2>
  <ul>
    ${config.map(([name, ok, note]) => `<li>${ok ? '✅' : '⚠️'} <b>${esc(name)}</b> — ${esc(note)}</li>`).join('')}
  </ul>
  ${providerBlock}
  <p class="sub" style="margin-top:26px"><a href="/">← 返回状态页</a></p>
</body>
</html>`;
}
