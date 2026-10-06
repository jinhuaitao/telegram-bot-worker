/**
 * store.js —— R2 存储封装
 *
 * Key 命名空间约定（插件按前缀隔离，互不干扰）：
 *   cfg:{chatId}                  用户设置        { tz, lang, muted }
 *   wx:{chatId}:{citySlug}        天气订阅        { city, lat, lon, tz, pushAt, lastPushDate }
 *   mon:{chatId}:{id}             监控项          { url, intervalMin, failCount, alerted, ... }
 *   rm:{paddedTs}:{chatId}:{id}   定时提醒        { text, at, tz, createdAt }
 *   ai:{chatId}                   AI 对话上下文   { messages, updatedAt }
 *   rss:{chatId}:{id}             RSS 订阅        { url, name, lastGuid, lastCheck, intervalMin, enabled }
 *   td:{chatId}:{id}              待办事项        { text, done, createdAt }
 *
 * 提醒的 key 用 14 位补零时间戳打头，使 R2 的 list 字典序天然等价于时间序遍历，
 * 这样 cron 只需从头扫、遇到未到期即可停止。
 *
 * 与 KV 封装的差异：
 *   · R2 的 list 返回 objects（仅元数据，不含内容），取内容仍要逐个 get
 *   · 翻页判据必须用 truncated，不能用「返回条数 < limit」—— R2 单次可能返回少于 limit 条
 *   · delete 支持传 key 数组（单次最多 1000 个），批量清空省 subrequest
 *   · 不传 delimiter，否则含分隔符的 key 会被折叠成 delimitedPrefixes
 *   · R2 无 TTL，写入即永久，靠 delete 显式清理
 */

const DELETE_BATCH = 1000; // R2 单次 delete 的 key 数上限

export class Store {
  constructor(r2) {
    if (!r2) throw new Error('缺少 BOT_R2 绑定，请检查 wrangler.toml');
    this.r2 = r2;
  }

  async getJSON(key, fallback = null) {
    try {
      const obj = await this.r2.get(key);
      if (!obj) return fallback;
      return await obj.json();
    } catch {
      return fallback;
    }
  }

  async setJSON(key, value) {
    await this.r2.put(key, JSON.stringify(value));
  }

  async del(key) {
    await this.r2.delete(key);
  }

  /** 翻一页 key 名（不传 delimiter，避免 key 被折叠成前缀） */
  async listPage(prefix, cursor, limit = 1000) {
    const res = await this.r2.list({ prefix, ...(cursor ? { cursor } : {}), limit });
    return {
      names: res.objects.map((o) => o.key),
      cursor: res.truncated ? res.cursor : null,
    };
  }

  /** 列出某前缀下的所有 key 名（自动翻页） */
  async listNames(prefix, max = 5000) {
    const names = [];
    let cursor;
    do {
      const page = await this.listPage(prefix, cursor, 1000);
      names.push(...page.names);
      cursor = page.cursor;
    } while (cursor && names.length < max);
    return names.slice(0, max);
  }

  /** 列出某前缀下所有 value */
  async listJSON(prefix, max = 1000) {
    const names = await this.listNames(prefix, max);
    const values = await Promise.all(names.map((n) => this.getJSON(n)));
    return values.map((v, i) => (v ? { ...v, __key: names[i] } : null)).filter(Boolean);
  }

  /** 清空某前缀（用于 /weather off 这类批量操作） */
  async clearPrefix(prefix) {
    const names = await this.listNames(prefix);
    for (let i = 0; i < names.length; i += DELETE_BATCH) {
      await this.r2.delete(names.slice(i, i + DELETE_BATCH));
    }
    return names.length;
  }

  /* ───────── 用户设置 ───────── */

  async getSettings(chatId, defaults = {}) {
    return this.getJSON(`cfg:${chatId}`, { ...defaults });
  }

  async saveSettings(chatId, patch) {
    const cur = await this.getSettings(chatId);
    const next = { ...cur, ...patch };
    await this.setJSON(`cfg:${chatId}`, next);
    return next;
  }
}
