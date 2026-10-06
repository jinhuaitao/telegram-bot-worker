/**
 * telegram.js —— Telegram Bot API 轻封装
 * 带 429 限流重试、自动分片、HTML 模式
 */
import { chunkText } from './utils.js';

const API_BASE = 'https://api.telegram.org';

export class Telegram {
  constructor(token) {
    if (!token) throw new Error('缺少 BOT_TOKEN');
    this.token = token;
    this.base = `${API_BASE}/bot${token}`;
  }

  /** 调用任意 Bot API 方法 */
  async call(method, payload = {}, { retries = 2 } = {}) {
    const url = `${this.base}/${method}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      let data;
      try {
        data = await res.json();
      } catch {
        throw new Error(`Telegram ${method} 返回非 JSON（HTTP ${res.status}）`);
      }

      if (data.ok) return data.result;

      // 429：按 retry_after 等待后重试
      const retryAfter = data?.parameters?.retry_after;
      if (res.status === 429 && attempt < retries && retryAfter) {
        await new Promise((r) => setTimeout(r, Math.min(retryAfter, 30) * 1000));
        continue;
      }

      throw new Error(`Telegram ${method} 失败：${data.description || res.status}`);
    }
  }

  /**
   * 发送消息，超长自动分片
   * @param {object} opts { parse_mode, disable_web_page_preview, reply_to_message_id, reply_markup }
   */
  async sendMessage(chatId, text, opts = {}) {
    const parts = chunkText(text);
    const results = [];
    for (let i = 0; i < parts.length; i++) {
      const payload = {
        chat_id: chatId,
        text: parts[i],
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: opts.disable_web_page_preview !== false },
        ...(i === 0 && opts.reply_to_message_id
          ? { reply_parameters: { message_id: opts.reply_to_message_id } }
          : {}),
        ...(i === parts.length - 1 && opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
      };
      results.push(await this.call('sendMessage', payload));
    }
    return results;
  }

  async editMessageText(chatId, messageId, text, opts = {}) {
    return this.call('editMessageText', {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: opts.disable_web_page_preview !== false },
      ...(opts.reply_markup ? { reply_markup: opts.reply_markup } : {}),
    });
  }

  async answerCallbackQuery(id, text, showAlert = false) {
    return this.call('answerCallbackQuery', { callback_query_id: id, text, show_alert: showAlert });
  }

  /** 显示「正在输入…」 */
  async sendChatAction(chatId, action = 'typing') {
    return this.call('sendChatAction', { chat_id: chatId, action }).catch(() => null);
  }

  async getMe() {
    return this.call('getMe');
  }

  async setWebhook(url, secretToken, allowedUpdates) {
    return this.call('setWebhook', {
      url,
      ...(secretToken ? { secret_token: secretToken } : {}),
      ...(allowedUpdates ? { allowed_updates: allowedUpdates } : {}),
      drop_pending_updates: false,
    });
  }

  async deleteWebhook() {
    return this.call('deleteWebhook', { drop_pending_updates: false });
  }

  async getWebhookInfo() {
    return this.call('getWebhookInfo');
  }
}
