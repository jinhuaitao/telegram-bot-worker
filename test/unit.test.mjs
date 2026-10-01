import {
  parseWhen, localDateStr, localTimeStr, tsKey, looksChinese,
  formatInTz, zonedToUtc, humanizeUntil, isValidTz, esc, chunkText,
} from '../src/utils.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log(`  ✔ ${label}`); }
  else { fail++; console.log(`  ✖ ${label}\n      得到: ${JSON.stringify(got)}\n      期望: ${JSON.stringify(want)}`); }
}

const TZ = 'Asia/Shanghai';
// 基准时刻：北京时间 2026-10-01 14:00
const NOW = zonedToUtc(2026, 10, 1, 14, 0, TZ);
const fmt = (ts) => formatInTz(ts, TZ);

console.log('\n【时区基础】');
eq('NOW 落在 2026-10-01 14:00', fmt(NOW), '2026-10-01 14:00');
eq('UTC 视角是 06:00', localTimeStr(NOW, 'UTC'), '06:00');
eq('纽约视角是 02:00', localTimeStr(NOW, 'America/New_York'), '02:00');
eq('东京视角是 15:00', localTimeStr(NOW, 'Asia/Tokyo'), '15:00');
eq('本地日期字符串', localDateStr(NOW, TZ), '2026-10-01');
eq('有效时区判定', [isValidTz('Asia/Shanghai'), isValidTz('Mars/Olympus')], [true, false]);
// 夏令时：纽约 2026-03-08 之后进入 EDT(UTC-4)
eq('纽约夏令时偏移正确', localTimeStr(zonedToUtc(2026, 7, 1, 12, 0, 'America/New_York'), 'UTC'), '16:00');

console.log('\n【相对时间】');
eq('10m', parseWhen('10m', TZ, NOW), { at: NOW + 600000, rest: '' });
eq('2小时 喝水', parseWhen('2小时 喝水', TZ, NOW), { at: NOW + 7200000, rest: '喝水' });
eq('30min 站起来', parseWhen('30min 站起来', TZ, NOW), { at: NOW + 1800000, rest: '站起来' });
eq('1d', parseWhen('1d', TZ, NOW), { at: NOW + 86400000, rest: '' });
eq('45秒 计时', parseWhen('45秒 计时', TZ, NOW), { at: NOW + 45000, rest: '计时' });

console.log('\n【绝对时刻】');
eq('20:00 今天（未过）', parseWhen('20:00 健身', TZ, NOW), { at: zonedToUtc(2026, 10, 1, 20, 0, TZ), rest: '健身' });
eq('09:30 顺延到明天（已过）', parseWhen('09:30 开会', TZ, NOW), { at: zonedToUtc(2026, 10, 2, 9, 30, TZ), rest: '开会' });
eq('9点30 顺延明天', parseWhen('9点30 起床', TZ, NOW), { at: zonedToUtc(2026, 10, 2, 9, 30, TZ), rest: '起床' });
eq('明天 9:00', parseWhen('明天 9:00 提交周报', TZ, NOW), { at: zonedToUtc(2026, 10, 2, 9, 0, TZ), rest: '提交周报' });
eq('后天 9点', parseWhen('后天 9点 复盘', TZ, NOW), { at: zonedToUtc(2026, 10, 3, 9, 0, TZ), rest: '复盘' });
eq('明早 8点', parseWhen('明早 8点 跑步', TZ, NOW), { at: zonedToUtc(2026, 10, 2, 8, 0, TZ), rest: '跑步' });
eq('今晚 8点', parseWhen('今晚 8点 吃饭', TZ, NOW), { at: zonedToUtc(2026, 10, 1, 20, 0, TZ), rest: '吃饭' });
eq('明天 9点30分', parseWhen('明天 9点30分 开会', TZ, NOW), { at: zonedToUtc(2026, 10, 2, 9, 30, TZ), rest: '开会' });
eq('明天 9:00（回归）', parseWhen('明天 9:00 提交周报', TZ, NOW), { at: zonedToUtc(2026, 10, 2, 9, 0, TZ), rest: '提交周报' });
eq('今晚 20:30', parseWhen('今晚 20:30 看电影', TZ, NOW), { at: zonedToUtc(2026, 10, 1, 20, 30, TZ), rest: '看电影' });
eq('10-02 09:00', parseWhen('10-02 09:00 客户会议', TZ, NOW), { at: zonedToUtc(2026, 10, 2, 9, 0, TZ), rest: '客户会议' });
eq('2026-10-05 08:00', parseWhen('2026-10-05 08:00 出发', TZ, NOW), { at: zonedToUtc(2026, 10, 5, 8, 0, TZ), rest: '出发' });
eq('无法解析返回 null', parseWhen('hello world', TZ, NOW), null);
eq('空字符串返回 null', parseWhen('', TZ, NOW), null);

console.log('\n【KV key 时间序】');
const keys = [NOW + 3600000, NOW, NOW + 60000].map(tsKey).sort();
eq('字典序 == 时间序', keys, [tsKey(NOW), tsKey(NOW + 60000), tsKey(NOW + 3600000)]);
eq('跨数量级仍正确', tsKey(999) < tsKey(1000), true);
eq('定长 14 位', tsKey(NOW).length, 14);

console.log('\n【展示与文本】');
eq('humanizeUntil 90 分钟', humanizeUntil(NOW + 5400000, NOW), '1 小时 30 分钟后');
eq('humanizeUntil 已过期', humanizeUntil(NOW - 1000, NOW), '已到期');
eq('中文检测', [looksChinese('你好世界'), looksChinese('hello world')], [true, false]);
eq('HTML 转义', esc('<b>a & b</b>'), '&lt;b&gt;a &amp; b&lt;/b&gt;');
eq('长文本分片数', chunkText('x'.repeat(9000), 3800).length, 3);
eq('短文本不分片', chunkText('hi').length, 1);

console.log(`\n${'─'.repeat(40)}`);
console.log(fail === 0 ? `✅ 全部通过（${pass} 项）` : `❌ ${fail} 项失败 / ${pass} 项通过`);
process.exit(fail === 0 ? 0 : 1);
