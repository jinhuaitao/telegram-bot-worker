/**
 * store.js —— KV 存储封装
 *
 * Key 命名空间约定（插件按前缀隔离，互不干扰）：
 *   cfg:{chatId}                  用户设置        { tz, lang, muted }
 *   wx:{chatId}:{citySlug}        天气订阅        { city, lat, lon, tz, pushAt, lastPushDate }
 *   mon:{chatId}:{id}             监控项          { url, intervalMin, failCount, alerted, ... }
 *   rm:{paddedTs}:{chatId}:{id}   定时提醒        { text, at, tz, createdAt }
 *
 * 提醒的 key 用 14 位补零时间戳打头，使 KV 的字典序遍历天然等价于时间序遍历，
 * 这样 cron 只需从头扫、遇到未到期即可停止。
 */

export class Store {
  constructor(kv) {
    if (!kv) throw new Error('缺少 BOT_KV 绑定，请检查 wrangler.toml');
    this.kv = kv;
  }

  async getJSON(key, fallback = null) {
    try {
      const v = await this.kv.get(key, 'json');
      return v ?? fallback;
    } catch {
      return fallback;
    }
  }

  async setJSON(key, value, opts) {
    await this.kv.put(key, JSON.stringify(value), opts);
  }

  async del(key) {
    await this.kv.delete(key);
  }

  /** 列出某前缀下的所有 key 名（自动翻页） */
  async listNames(prefix, max = 5000) {
    const names = [];
    let cursor;
    do {
      const res = await this.kv.list({ prefix, cursor, limit: 1000 });
      for (const k of res.keys) names.push(k.name);
      cursor = res.list_complete ? null : res.cursor;
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
    await Promise.all(names.map((n) => this.kv.delete(n)));
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
