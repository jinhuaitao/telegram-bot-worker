/**
 * plugins/index.js —— 插件注册表
 *
 * ┌─ 插件契约 ───────────────────────────────────────────────┐
 * │ export default {                                         │
 * │   name:    'weather',       // 唯一标识                  │
 * │   title:   '天气',           // 帮助里的分组名            │
 * │   summary: '一句话说明',      // 帮助里的副标题            │
 * │                                                          │
 * │   commands: {              // 命令表：键名即 /命令        │
 * │     weather: {                                           │
 * │       desc:   '一句话描述',                               │
 * │       usage:  '/weather 城市',                           │
 * │       detail: '多行详细说明（HTML）',                     │
 * │       hidden: false,       // true 则不出现在 /help      │
 * │       run: async (ctx) => {}                             │
 * │     }                                                    │
 * │   },                                                     │
 * │                                                          │
 * │   cron: async (cronCtx) => {}   // 可选：每分钟被调用      │
 * │ }                                                        │
 * └──────────────────────────────────────────────────────────┘
 *
 * 新增插件只需：写一个文件 → 在下面 PLUGINS 数组里加一行。
 * 命令注册、帮助生成、定时调度都会自动生效，不需要改任何核心代码。
 */

import help from './help.js';
import settings from './settings.js';
import weather from './weather.js';
import monitor from './monitor.js';
import remind from './remind.js';
import translate from './translate.js';

export const PLUGINS = [
  help,
  weather,
  monitor,
  remind,
  translate,
  settings,
];

/** 建立 命令名 → { plugin, desc, usage, run } 的索引 */
export function buildCommandMap(plugins = PLUGINS) {
  const map = new Map();
  for (const plugin of plugins) {
    for (const [name, def] of Object.entries(plugin.commands || {})) {
      if (typeof def?.run !== 'function') continue;
      if (map.has(name)) {
        console.warn(`[plugins] 命令 /${name} 被重复定义，后者（${plugin.name}）覆盖前者`);
      }
      map.set(name.toLowerCase(), { ...def, plugin });
    }
  }
  return map;
}

/** 校验插件契约，尽早暴露低级错误 */
export function validatePlugins(plugins = PLUGINS) {
  const errors = [];
  const seen = new Set();
  for (const p of plugins) {
    if (!p?.name) errors.push('存在没有 name 的插件');
    if (seen.has(p.name)) errors.push(`插件名重复：${p.name}`);
    seen.add(p.name);
    if (p.cron && typeof p.cron !== 'function') errors.push(`插件 ${p.name} 的 cron 不是函数`);
    for (const [cmd, def] of Object.entries(p.commands || {})) {
      if (typeof def?.run !== 'function') errors.push(`插件 ${p.name} 的命令 /${cmd} 缺少 run 函数`);
    }
  }
  return errors;
}
