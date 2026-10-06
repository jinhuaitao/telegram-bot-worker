/**
* v2.test.mjs —— v2 新增功能的单元测试
* 覆盖：fx 参数解析与换算、todo 纯函数、rss XML 解析、
* ai 上下文裁剪、限流、SSRF 判定、命令别名
*/
import { parseFxArgs, convertFx, CURRENCIES} from '../src/plugins/fx.js';
import { renderTodoText, todoKeyboard, toggleTodoDone} from '../src/plugins/todo.js';
import { parseFeed} from '../src/plugins/rss.js';
import { trimContext, isContextExpired} from '../src/plugins/ai.js';
import { checkRateLimit} from '../src/router.js';
import { isPrivateHost} from '../src/plugins/monitor.js';
import { PLUGINS, buildCommandMap, validatePlugins} from '../src/plugins/index.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
const ok = JSON.stringify(got) === JSON.stringify(want);
if (ok) { pass++; console.log(` ✔ ${label}`);}
else { fail++; console.log(` ✖ ${label}\n 得到: ${JSON.stringify(got)}\n 期望: ${JSON.stringify(want)}`);}
}
function ok(label, cond) { eq(label, Boolean(cond), true);}

/* ─────────────────────── fx ─────────────────────── */

console.log('\n');
eq('默认 USD→CNY', parseFxArgs([]), { kind: 'convert', from: 'USD', to: 'CNY', amount: 1});
eq('USD CNY', parseFxArgs(['USD', 'CNY']), { kind: 'convert', from: 'USD', to: 'CNY', amount: 1});
eq('金额后置', parseFxArgs(['USD', 'CNY', '100']), { kind: 'convert', from: 'USD', to: 'CNY', amount: 100});
eq('金额前置', parseFxArgs(['100', 'USD', 'CNY']), { kind: 'convert', from: 'USD', to: 'CNY', amount: 100});
eq('只写一种货币默认兑 CNY', parseFxArgs(['EUR']), { kind: 'convert', from: 'EUR', to: 'CNY', amount: 1});
eq('小写货币自动大写', parseFxArgs(['usd', 'cny']).from, 'USD');
eq('list', parseFxArgs(['list']).kind, 'list');
ok('未知货币报错', parseFxArgs(['XXX', 'CNY']).error.includes('XXX'));
ok('非法 token 报错', Boolean(parseFxArgs(['USD', 'CNY', 'abc']).error));
ok('零金额报错', Boolean(parseFxArgs(['USD', 'CNY', '0']).error));
ok('常用货币表非空', Object.keys(CURRENCIES).length >= 10 && CURRENCIES.CNY === '人民币');

console.log('\n');
eq('100 * 7.1234', convertFx(100, 7.1234), 712.34);
eq('1 * 0.92', convertFx(1, 0.92), 0.92);

/* ─────────────────────── todo ─────────────────────── */

console.log('\n');
const todos = [
{ id: 'aa111', text: '买牛奶', done: false, createdAt: 1},
{ id: 'bb222', text: '写周报', done: true, createdAt: 2},
];
const rendered = renderTodoText(todos);
ok('空清单提示', renderTodoText([]).includes('空的'));
ok('未完成显示 ⬜', rendered.includes('⬜'));
ok('已完成显示 ✅', rendered.includes('✅'));
ok('文本被转义', renderTodoText([{ id: 'x', text: '<b>hi</b>', done: false, createdAt: 1}]).includes('&lt;b&gt;'));

const kb = todoKeyboard(todos);
eq('键盘回调格式', kb.inline_keyboard[0][0].callback_data, 'todo:toggle:aa111');
eq('键盘行数', kb.inline_keyboard.length, 2);
ok('已完成按钮带 ✅', kb.inline_keyboard[1][0].text.startsWith('✅'));

const item = { id: 'cc333', text: 't', done: false};
toggleTodoDone(item);
eq('翻转 false→true', item.done, true);
toggleTodoDone(item);
eq('翻转 true→false', item.done, false);

/* ─────────────────────── rss 解析 ─────────────────────── */

console.log('\n');
const RSS2 = `<?xml version="1.0"?>
<rss version="2.0"><channel>
<title>示例博客</title>
<item><title><![CDATA[第一篇]]></title><link>https://example.com/1</link><guid>https://example.com/1</guid></item>
<item><title>第二篇</title><link>https://example.com/2</link></item>
</channel></rss>`;
const f1 = parseFeed(RSS2);
eq('RSS 标题', f1.title, '示例博客');
eq('RSS 文章数', f1.items.length, 2);
eq('RSS CDATA 标题', f1.items[0].title, '第一篇');
eq('RSS guid 回退到 link', f1.items[1].guid, 'https://example.com/2');

const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
<title>Atom 博客</title>
<entry><title>原子第一篇</title><link href="https://example.com/a1"/><id>urn:uuid:a1</id></entry>
</feed>`;
const f2 = parseFeed(ATOM);
eq('Atom 标题', f2.title, 'Atom 博客');
eq('Atom 文章数', f2.items.length, 1);
eq('Atom link 取 href', f2.items[0].link, 'https://example.com/a1');
eq('Atom guid 取 id', f2.items[0].guid, 'urn:uuid:a1');

eq('非 feed 返回 null', parseFeed('<html><body>hi</body></html>'), null);
eq('空字符串返回 null', parseFeed(''), null);
eq('无文章返回 null', parseFeed('<rss version="2.0"><channel><title>x</title></channel></rss>'), null);

/* ─────────────────────── ai 上下文 ─────────────────────── */

console.log('\n');
const msgs = Array.from({ length: 25}, (_, i) => ({
role: i % 2? 'assistant': 'user',
content: `m${i}`,
}));
const trimmed = trimContext(msgs, 10);
eq('保留最近 20 条', trimmed.length, 20);
eq('保留的是尾部', trimmed[0].content, 'm5');
eq('默认 10 轮', trimContext(msgs).length, 20);
eq('不足不裁', trimContext([{ role: 'user', content: 'hi'}]).length, 1);
eq('非数组兜底', trimContext(null).length, 0);

const NOW = Date.now();
ok('无上下文视为过期', isContextExpired(null, NOW));
ok('刚聊过不过期',!isContextExpired({ updatedAt: NOW}, NOW));
ok('25 小时前已过期', isContextExpired({ updatedAt: NOW - 25 * 3600000}, NOW));

/* ─────────────────────── 限流 ─────────────────────── */

console.log('\n');
const cid = `rl-test-${Date.now()}`;
let allowed = 0;
for (let i = 0; i < 20; i++) if (checkRateLimit(cid, NOW)) allowed++;
eq('前 20 条放行', allowed, 20);
eq('第 21 条被拦', checkRateLimit(cid, NOW), false);
eq('窗口过后恢复', checkRateLimit(cid, NOW + 61000), true);

/* ─────────────────────── SSRF ─────────────────────── */

console.log('\n');
const cases = [
['localhost', true], ['127.0.0.1', true], ['127.1.2.3', true],
['10.0.0.5', true], ['172.16.5.4', true], ['172.31.255.1', true],
['192.168.1.1', true], ['169.254.169.254', true], ['169.254.10.20', true],
['0.0.0.0', true], ['::1', true],
['172.15.0.1', false], ['172.32.0.1', false],
['8.8.8.8', false], ['example.com', false], ['api.frankfurter.app', false],
];
for (const [host, want] of cases) {
eq(`isPrivateHost(${host})`, isPrivateHost(host), want);
}

/* ─────────────────────── 别名与契约 ─────────────────────── */

console.log('\n');
const cmdMap = buildCommandMap(PLUGINS);
eq('w → weather', cmdMap.get('w')?.plugin.name, 'weather');
eq('t → translate', cmdMap.get('t')?.plugin.name, 'translate');
eq('r → remind', cmdMap.get('r')?.plugin.name, 'remind');
eq('别名标记 isAlias', cmdMap.get('w')?.isAlias, true);
eq('原命令非别名', cmdMap.get('weather')?.isAlias, false);
ok('别名与原命令同 run', cmdMap.get('w')?.run === cmdMap.get('weather')?.run);
eq('新插件全部注册', ['ai', 'rss', 'fx', 'todo', 'backup'].map((n) => PLUGINS.some((p) => p.name === n)), [true, true, true, true, true]);
eq('插件契约校验通过', validatePlugins(PLUGINS), []);

console.log(`\n${'─'.repeat(40)}`);
console.log(fail === 0? `✅ 全部通过（${pass} 项）`: `❌ ${fail} 项失败 / ${pass} 项通过`);
process.exit(fail === 0? 0: 1);
