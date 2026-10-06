# 插件式 Telegram 机器人 · Cloudflare Workers

一个机器人干所有事：**天气订阅 · 监控告警 · 定时提醒 · 翻译**。  
全部跑在 Cloudflare Workers 免费额度内，**不需要服务器、不需要数据库、不需要任何第三方 API Key**。

部署支持两条路：**Cloudflare 面板连 GitHub**（全程网页操作）或**本地命令行 wrangler**。两种方式都不用手动手建 bucket，但 R2 需要先给账号开通一次订阅（见下方「前置：开通 R2」）。

---

## 目录

- [它长什么样](#它长什么样)
- [架构](#架构)
- [部署](#部署)
- [命令手册](#命令手册)
- [插件开发：3 步加一个新功能](#插件开发3-步加一个新功能)
- [免费额度与限制](#免费额度与限制)
- [常见问题](#常见问题)

---

## 它长什么样

```
你: /weather 杭州          # 假设查询时刻是 15:40
🤖 ⛅ 杭州
   ━━━━━━━━━━━━━━

   实况
   🌡 26.4°C　体感 28.9°C　多云
   💧 湿度 68%　露点 20.1°C
   💨 东南风 3.6 m/s　阵风 7.2 m/s
   🧭 气压 1008 hPa　能见度 18.1 km
   ☁️ 云量 55%
   空气质量
   🟡 良　AQI 78（美标）
   　　PM2.5 31.8　PM10 52.4 μg/m³
   ☀️ 日出 05:52　日落 17:44　昼长 11 小时 52 分

   未来 6 小时
   16:00　⛅ 25.8°C　💧15%
   17:00　☁️ 24.6°C　💧35%
   18:00　🌧️ 23.1°C　💧70%
   19:00　🌧️ 22°C　💧75%
   20:00　🌦️ 21.4°C　💧60%
   21:00　🌦️ 20.6°C　💧45%

   未来 3 天
   今天　⛅ 多云　20.2~28.6°C　💧35%
   　　💨 东南风 5.2 m/s　☀️ UV 6.8 高　🌧 降水 0.2 mm
   明天　🌧️ 小雨　19.4~24.1°C　💧85%
   　　💨 西南风 8.4 m/s　☀️ UV 2.4 低　🌧 降水 12.6 mm
   后天　☀️ 晴　18.8~27.3°C　💧5%
   　　💨 东风 3.1 m/s　☀️ UV 7.1 高

你: /remind 明天 9:00 提交周报
🤖 ⏰ 提醒已设置
   内容：提交周报
   时间：2026-10-02 09:00
   还有：19 小时后

你: /mon add https://api.mysite.com/health name=线上接口 interval=5 expect=200 maxlatency=1500
🤖 ✅ 监控已添加
   ID：k7m2p   间隔：每 5 分钟
   首次探测：🟢 正常 · 142 ms

   （接口挂了之后，自动推给你）
🤖 🚨 服务异常告警
   名称：线上接口
   连续失败：2 次
   最近状态码：503 · 耗时：87 ms
   问题：状态码 503（期望 200）

你: /tr hello world
🤖 🌐 English → 中文
   你好世界
```

---

## 架构

```
                    ┌─────────────────────────────┐
   Telegram ──POST─▶│  Worker.fetch()             │
   Webhook          │  校验 secret → 立即 200      │
                    │  waitUntil(router)          │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │  router.js                  │
                    │  解析 update → 构造 ctx      │
                    │  查命令表 → 交给插件          │
                    └──────────────┬──────────────┘
                                   │
   Cron ──每分钟─▶ cron.js ────────┤
                                   │
                    ┌──────────────▼──────────────┐
                    │  plugins/index.js  注册表    │
                    └──┬────┬────┬────┬────┬──────┘
                       │    │    │    │    │
                    weather mon remind  tr  help/settings
                       │    │    │    │
                       └────┴────┴────┴──▶ R2 (BOT_R2)
                                            cfg: / wx: / mon: / rm:
```

**几个设计要点：**

| 设计                           | 为什么这么做                                                       |
| ---------------------------- | ------------------------------------------------------------ |
| 插件注册表扁平化                     | 加功能只改 `plugins/index.js` 一行，核心代码零改动                          |
| `fetch` 先返回 200 再处理          | Telegram 只等 1 秒左右，超时会重推导致重复回复                                |
| `ctx.waitUntil()`            | 让 Worker 在响应后继续跑完异步逻辑                                        |
| 提醒 key 用 `rm:{14位补零时间戳}:...` | R2 的 `list` 按字典序返回，补零后**字典序 == 时间序**，cron 扫到第一个未到期就能停，不用全表扫描 |
| 监控连续失败达阈值才告警                 | 网络抖动一次就报警会把人吵死；恢复时补一条恢复通知                                    |
| 每个插件独立 try/catch             | 一个插件抛错不影响其他插件和整体调度                                           |
| `wrangler.toml` 只写绑定名不写 ID   | 用 Wrangler 的自动预置，面板连 GitHub 和 CLI 两条路都不用手动建资源                |
| Worker 自带 `/setup` 端点        | 面板部署的用户不必装命令行工具，浏览器打开一个地址就能注册 Webhook                        |

---

## 部署

两种方式任选其一：

|       | 方式一 · 面板连 GitHub | 方式二 · 本地命令行          |
| ----- | ---------------- | -------------------- |
| 需要装东西 | 不需要              | Node.js 18+          |
| 更新方式  | `git push` 自动部署  | 手动 `wrangler deploy` |
| 适合    | 只想用，不想折腾环境       | 要本地调试、不想放 GitHub     |

两种方式都**不需要手动创建 bucket** —— `wrangler.toml` 里只声明了绑定名没写 ID，部署时 Cloudflare 会自动创建（名字形如 `tg-multibot-BOT_R2`）。

> ⚠️ **前置：开通 R2 订阅（一次性）**  
> 与 KV / D1 不同，R2 即使只用免费额度，也需要先在账号上开通一次订阅：Cloudflare 面板 → **Storage & databases → R2 → 走一次 checkout 并添加支付方式**。额度内是 `$0`，但不开通的话 bucket 建不出来、部署会在自动预置这一步失败。这一步只需做一次，之后跨所有 Worker 共享。

---

### 方式一 · Cloudflare 面板连接 GitHub

#### 第 1 步 · 把代码Fork到 GitHub

```bash
把代码Fork到 GitHub
```


#### 第 2 步 · 创建机器人，拿到 Token

在 Telegram 里找 [@BotFather](https://t.me/BotFather)：

1. 发送 `/newbot`
2. 按提示起名（显示名随意，用户名必须以 `bot` 结尾，例如 `my_kitchen_sink_bot`）
3. 记下返回的 Token，形如 `123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11`

#### 第 3 步 · 在 Cloudflare 连接仓库

1. 打开 [Cloudflare Dashboard](https://dash.cloudflare.com/) → **Workers & Pages**
2. 点 **Create** → **Workers** → **Connect to Git**
3. 授权 GitHub，选中刚推的仓库和分支（默认 `main`）
4. 填构建配置：
   | 配置项                | 填什么                                       |
   | ------------------ | ----------------------------------------- |
   | **Build command**  | `npm install`                             |
   | **Deploy command** | `npx wrangler deploy` ← 默认值，不用改           |
   | **Root directory** | 项目在仓库根目录就留空；在子目录里就填 `telegram-bot-worker` |
5. 点 **Deploy**，等一两分钟

首次部署会自动把 R2 bucket 一起建好（前提是已开通 R2 订阅）。部署完成后 Worker 地址形如：

```
https://tg-multibot.你的账号.workers.dev
```

#### 第 4 步 · 配置密钥

进入这个 Worker → **Settings** → **Variables & Secrets**，添加两个变量，类型都选 **Secret**：

| 名称               | 值                                               |
| ---------------- | ----------------------------------------------- |
| `BOT_TOKEN`      | 第 2 步拿到的 Token                                  |
| `WEBHOOK_SECRET` | 自己敲一串随机字符，例如 `7f3a9c2e5b8d1f4a6e9c0b3d7a2f5e8c` |

保存后回到 **Deployments**，点最新一次部署右侧的 **⋯ → Retry deployment**。  
（密钥要重新部署一次才会注入到运行环境。）

#### 第 5 步 · 一键注册 Webhook

先用浏览器打开你的 Worker 地址，状态页会列出所有插件和还缺哪些配置：

```
https://tg-multibot.你的账号.workers.dev
```

配置齐全后，访问下面这个地址（把 `key=` 换成你刚设的 `WEBHOOK_SECRET` 值）：

```
https://tg-multibot.你的账号.workers.dev/setup?key=你的WEBHOOK_SECRET
```

看到 **「@你的机器人 已就绪」** 就完成了，全程不需要命令行。

> ⚠️ 这个带 key 的地址不要分享给别人 —— 拿到它的人可以解除你的 Webhook。  
> 想随时检查状态：`/setup?key=...&action=info`；想断开连接：`/setup?key=...&action=delete`

现在去 Telegram 给机器人发一条 `/start`。

---

### 方式二 · 本地命令行

```bash
cd telegram-bot-worker
npm install
npx wrangler login

# 写入两个密钥（命令会交互式提示你粘贴）
npx wrangler secret put BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET

# 部署 —— R2 bucket 会自动创建（需已开通 R2 订阅）
npx wrangler deploy
```

部署成功会输出 Worker 地址。然后二选一完成 Webhook 注册：

```bash
# 选项 A：用脚本，会打印详细状态，排障时更好用
BOT_TOKEN=你的token WEBHOOK_SECRET=你设的密钥 \
  node scripts/setup.mjs https://tg-multibot.你的账号.workers.dev

# 选项 B：直接在浏览器打开
# https://tg-multibot.你的账号.workers.dev/setup?key=你设的WEBHOOK_SECRET
```

---

### 之后怎么更新

- **方式一**：`git push` 到连接的分支，Cloudflare 自动重新构建部署
- **方式二**：改完代码跑 `npx wrangler deploy`

注意：改 `wrangler.toml` 里的 `[vars]`（比如默认时区）也要走一次部署才会生效。

---

## 命令手册

### 🌤 天气（数据源 Open-Meteo，免费无 Key）

| 命令                      | 说明                        |
| ----------------------- | ------------------------- |
| `/weather 北京`           | 立即查询，含实况 + 逐小时 + 未来 3 天 + 空气质量 |
| `/weather sub 北京 07:30` | 每天 07:30 自动推送北京天气         |
| `/weather sub 上海`       | 不写时间则默认 07:30             |
| `/weather list`         | 查看已订阅的城市                  |
| `/weather off`          | 取消全部天气订阅                  |
| `/weather off 北京`       | 只取消北京                     |

**输出包含哪些内容**（分区顺序：先「此刻」，后「预报」）

| 分区         | 字段                                                    |
| ---------- | ----------------------------------------------------- |
| 实况         | 温度、体感、天气现象、湿度、露点、风向、风速、阵风、气压、能见度、云量、当前降水             |
| └ 空气质量     | 紧跟在「云量」下方 —— 美标 AQI 与等级（优/良/轻度…）、PM2.5、PM10           |
| └ 日出日落     | 同样归入「此刻」—— 日出、日落时间与昼长                                |
| 未来 6 小时    | **从下一个整点开始算** —— 整点温度、天气图标、降水概率                       |
| 未来 3 天     | 最高/最低温、天气现象、降水概率、最大风速与主导风向、UV 指数与强度、当日累计降水            |

> 「未来 6 小时」从**下一个整点**开始，不含当前所处的这一小时（那属于「实况」）。
> 例如 15:40 查询，列出的是 16:00 ~ 21:00。

> 时区自动取城市所在地（如北京→`Asia/Shanghai`），夏令时也能正确处理。
>
> 空气质量来自 `air-quality-api.open-meteo.com`，同样免费无 Key。**该接口失败不影响天气本身**（会静默省略空气质量分区）。
>
> 每天定时推送的是**精简版**（实况 + 今日概况 + 空气质量，不含逐小时），避免早安消息过长；`/weather 城市` 手动查询才是完整版。

### 📡 监控告警

| 命令                               | 说明            |
| -------------------------------- | ------------- |
| `/mon add <url> [选项]`            | 添加监控项，并立即探测一次 |
| `/mon list`                      | 列出所有监控项       |
| `/mon check <id>`                | 立即手动检查一次      |
| `/mon off <id>` / `/mon on <id>` | 暂停 / 恢复       |
| `/mon del <id>`                  | 删除            |

**选项**（`key=value`，可任意组合）：

| 选项                  | 默认           | 说明              |
| ------------------- | ------------ | --------------- |
| `name=官网`           | 域名           | 显示名称            |
| `interval=5`        | `5`          | 检查间隔，单位分钟（最小 1） |
| `expect=200`        | 状态码 <400 即通过 | 期望的状态码          |
| `contains=Welcome`  | —            | 正文必须包含该字符串      |
| `notcontains=Error` | —            | 正文不得包含该字符串      |
| `maxlatency=2000`   | —            | 响应耗时上限（毫秒）      |
| `timeout=10`        | `10`         | 请求超时（秒）         |
| `method=POST`       | `GET`        | 请求方法            |
| `threshold=2`       | `2`          | 连续失败几次才告警       |

示例：

```bash
/mon add https://example.com name=官网 interval=5 expect=200
/mon add https://api.mysite.com/health contains=ok maxlatency=1500 threshold=3
```

> 告警只在**连续失败达到阈值**时触发，恢复后会补一条 `✅ 服务已恢复`。  
> 服务端偶发 5xx 一次不会打扰你。

### ⏰ 定时提醒

| 命令                  | 说明     |
| ------------------- | ------ |
| `/remind <时间> <内容>` | 设置提醒   |
| `/reminders`        | 查看全部待办 |
| `/remind del <id>`  | 取消某条   |
| `/remind clear`     | 清空全部   |

**支持的时间写法**（全部按你的时区解析）：

| 写法                            | 含义                        |
| ----------------------------- | ------------------------- |
| `10m` / `30min` / `2h` / `1d` | 相对现在                      |
| `10分钟` / `2小时` / `3天`         | 相对现在（中文）                  |
| `09:30`                       | 今天该时刻，已过则顺延到明天            |
| `9点30`                        | 同上                        |
| `明天 9:00` / `后天 9点` / `今晚 8点` | 中文日期词（"今晚 8点"自动理解为 20:00） |
| `10-02 09:00`                 | 指定月-日                     |
| `2026-10-02 09:00`            | 完整日期时间                    |

```bash
/remind 10m 喝水
/remind 明天 9:00 提交周报
/remind 2026-10-02 14:00 客户会议
```

### 🌐 翻译

| 命令                | 说明                 |
| ----------------- | ------------------ |
| `/tr <文本>`        | 自动判断方向：中文→英文，其他→中文 |
| `/tr <目标语言> <文本>` | 指定目标语言             |
| 回复某条消息 + `/tr`    | 直接翻译那条消息           |

支持语言简写：`zh zh-tw en ja ko fr de ru es pt it ar th vi hi tr nl pl`

```bash
/tr hello world          → 你好世界
/tr ja 早上好             → おはようございます
/tr fr Hello             → Bonjour
```

> 默认用 Google 翻译的公开端点，无需 Key。  
> 如果被限流，可以在 `wrangler.toml` 里把 `TRANSLATE_PROVIDER` 改成 `mymemory`。

### ⚙️ 设置

| 命令                       | 说明               |
| ------------------------ | ---------------- |
| `/settings`              | 查看当前设置和常用时区列表    |
| `/tz Asia/Tokyo`         | 设置时区（影响所有定时任务）   |
| `/mute on` / `/mute off` | 静音定时推送（手动命令不受影响） |

### 🛠 其他

| 命令              | 说明                     |
| --------------- | ---------------------- |
| `/help`         | 按插件分组列出全部命令            |
| `/help weather` | 查看某个命令的详细用法            |
| `/id`           | 查看当前会话 ID              |
| `/ping`         | 连通性自检，显示 Telegram 往返延迟 |

---

## 插件开发：3 步加一个新功能

假设你要加一个「汇率查询」插件。

### 第 1 步 · 新建 `src/plugins/fx.js`

```js
import { esc, fetchWithTimeout } from '../utils.js';

export default {
  name: 'fx',
  title: '汇率',
  summary: '查询实时汇率',

  commands: {
    fx: {
      desc: '查询汇率',
      usage: '/fx USD CNY',
      run: async (ctx) => {
        const [from = 'USD', to = 'CNY'] = ctx.argv;
        const res = await fetchWithTimeout(
          `https://api.frankfurter.app/latest?from=${from}&to=${to}`
        );
        const data = await res.json();
        const rate = data?.rates?.[to];
        if (!rate) return ctx.reply('查不到这个货币对。');
        await ctx.reply(`💱 1 ${esc(from)} = <b>${esc(rate)}</b> ${esc(to)}`);
      },
    },
  },

  // 可选：每分钟被调用一次（用于定时任务）
  // cron: async ({ now, store, bot, env }) => { ... },
};
```

### 第 2 步 · 注册到 `src/plugins/index.js`

```js
import fx from './fx.js';

export const PLUGINS = [
  help, weather, monitor, remind, translate, settings,
  fx,          // ← 加这一行
];
```

### 第 3 步 · 部署

```bash
npm test && npx wrangler deploy
```

完成。`/help` 里会自动出现「汇率」分组，`/fx USD CNY` 立即可用 —— **核心代码一行都不用改**。

### 插件契约速查

```js
export default {
  name:    'fx',        // 唯一标识
  title:   '汇率',       // /help 里的分组名
  summary: '一句话说明',  // /help 里的副标题

  commands: {
    命令名: {            // 键名即 /命令名
      desc:   '一句话描述',
      usage:  '/fx USD CNY',        // 可选
      detail: '多行详细说明（HTML）', // 可选，/help fx 时显示
      hidden: false,                // 可选，true 则不在 /help 出现
      run: async (ctx) => {},
    },
  },

  cron: async (cronCtx) => {},   // 可选：每分钟调用一次
  onCallback: async (ctx, data) => {}, // 可选：处理内联按钮回调
};
```

### `ctx` 里有什么

| 字段                                     | 说明                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------ |
| `ctx.text`                             | 原始消息文本                                                                         |
| `ctx.command`                          | 命令名（不含斜杠）                                                                      |
| `ctx.args`                             | 命令后的完整参数字符串                                                                    |
| `ctx.argv`                             | 参数按空白切分后的数组                                                                    |
| `ctx.chatId` / `ctx.chat` / `ctx.from` | 会话与用户信息                                                                        |
| `ctx.isPrivate`                        | 是否私聊                                                                           |
| `ctx.reply(html, extra)`               | 回复当前消息（HTML 模式，超长自动分片）                                                         |
| `ctx.send(html)`                       | 发送但不引用原消息                                                                      |
| `ctx.store`                            | R2 封装：`getJSON` / `setJSON` / `del` / `listJSON` / `listNames` / `clearPrefix` |
| `ctx.bot`                              | Telegram API：`sendMessage` / `editMessageText` / `sendChatAction` 等            |
| `ctx.env`                              | 环境变量与绑定                                                                        |
| `ctx.loadSettings()`                   | 取用户设置（含 `tz`、`muted`，已带默认值和时区校验）                                               |

> ⚠️ **安全提醒**：回复文本里所有来自用户输入的内容，必须用 `esc()` 包一层再拼进 HTML，否则会被当作 Telegram 的 HTML 标签解析。

---

## 免费额度与限制

跑在 Cloudflare Workers 免费版上，这些额度足够个人/小团队长期使用。R2 的额度按**每月**计（不是每天），比原来的 KV 宽裕得多：

| 项目             | 免费额度                | 本项目的用量                            |
| -------------- | ------------------- | --------------------------------- |
| Worker 请求      | 10 万次/天             | Cron 每分钟 1 次 ≈ **1440 次/天**，加上消息量 |
| R2 写 / list（Class A） | 100 万次/月     | 监控/提醒状态更新 + 每轮 cron 扫 key，约几万/月   |
| R2 读（Class B）  | 1000 万次/月           | 每条消息读设置、cron 逐个取值，个人用量远低于此      |
| R2 存储          | 10 GB·月             | 订阅/提醒/监控的 JSON，通常只有几十 KB         |
| CPU 时间         | 10 ms/请求            | 见下方说明                             |
| 构建分钟数（仅面板部署路径） | 3000 分钟/月           | 每次 push 约 1 分钟                    |

> 换到 R2 主要是为了解决 KV 免费档「写入仅 1000 次/天」偏紧的问题：本项目 cron 每分钟都要回写监控/天气状态，监控项一多很容易触顶，R2 的 100 万次/月写额度基本用不完。代价是 R2 需要账号先开通一次订阅（见部署章节），且读延迟比 KV 略高（对象读通常不回边缘缓存）。


**几个需要注意的点：**

1. **CPU 时间 10ms 是「计算时间」，不含网络等待。**  
   调用 Telegram API、抓取被监控站点都属于 IO 等待，不计入 CPU。  
   所以本项目在免费额度下运行没问题。
2. **单次请求最多 50 个子请求（subrequest）。**  
   所以 `wrangler.toml` 里有 `MAX_MONITOR_PER_TICK = 20`，限制每轮最多检查 20 个监控项。  
   监控项很多时，可以调大这个值，但建议不超过 40。
3. **R2 是强一致的，写入/删除成功后全球立即可见。**  
   原来 KV 的「最终一致、写后几百毫秒才可见」问题在 R2 上不存在；但对象读要先回源到 bucket，延迟比 KV 的边缘缓存略高，所以每条消息仍只读一次设置（`loadSettings` 内部有 Promise 缓存）。
4. **提醒精度是分钟级**，依赖 Cron 每分钟触发。  
   Cloudflare 的 Cron 偶尔会有几秒到几十秒的延迟，属正常现象。
5. **`/weather` 和 `/tr` 依赖第三方免费接口**（Open-Meteo、Google 翻译）。  
   它们没有 SLA 保证，偶发失败时机器人会返回友好错误提示而不是静默失败。  
   一次 `/weather 城市` 会并发打 2 个 Open-Meteo 接口（预报 + 空气质量），走 `Promise.all`，所以延迟不会翻倍。

---

## 常见问题

**Q：发了命令没反应？**

先用浏览器打开 Worker 地址，状态页会直接告诉你缺什么配置。再访问下面这个地址看 Webhook 状态和最近错误：

```
https://你的地址.workers.dev/setup?key=你的WEBHOOK_SECRET&action=info
```

命令行排障：

```bash
# 看 Webhook 当前状态与最近错误
BOT_TOKEN=你的token node scripts/setup.mjs

# 实时看 Worker 日志
npx wrangler tail
```

日志里出现 `403 Forbidden`，说明 `WEBHOOK_SECRET` 和注册 Webhook 时用的值不一致，重新访问一次 `/setup?key=...` 即可。

**Q：R2 要手动创建吗？数据存在哪？**

bucket 不用手动建 —— `wrangler.toml` 里只写了 `binding = "BOT_R2"` 而没写 `bucket_id`，用的是 Wrangler 的**自动预置**：部署时自动创建，名字形如 `tg-multibot-BOT_R2`。

但**开通 R2 本身需要先在账号上做一次性操作**：Cloudflare 面板 → R2 → 走 checkout 加一个支付方式（免费额度内为 `$0`）。这一步不做的话，自动预置建 bucket 会失败。

所有订阅、监控项、提醒都存在这个 bucket 里，key 前缀分别是 `cfg:` / `wx:` / `mon:` / `rm:`。想看或清空，去 **Storage & databases → R2 → 选中 bucket**。

> 注意：如果你之前用的是 KV，换成 R2 后数据是**重新从空开始**的 —— 两者是不同产品，不会自动迁移。老 KV 里的订阅需要在 Telegram 里重新订一遍，或自行用 `wrangler` 导出后写入 R2。

**Q：改了代码怎么生效？**

- 面板路径：`git push`，Cloudflare 自动重新构建部署
- 命令行路径：`npx wrangler deploy`

改 `wrangler.toml` 里的 `[vars]`（比如默认时区）也要重新部署一次才生效。

**Q：怎么调试插件逻辑？**

```bash
npm test              # 单元 + 入口 + 端到端集成测试（149 项）
npx wrangler dev      # 本地起一个 Worker，配合 ngrok 之类做联调
```

`test/e2e.test.mjs` 用 mock 模拟了 Telegram API 和所有外部服务，能完整跑通「收消息 → 路由 → 插件 → 存储 → 定时派发」全链路，改代码后先跑它。

**Q：可以加内联按钮吗？**

可以。插件里导出 `onCallback(ctx, data)`，`ctx.reply` 时传 `reply_markup`。  
回调数据约定格式为 `插件名:动作:参数`，router 会自动分发到对应插件。

**Q：不用 GitHub，能用别的 Git 平台吗？**

Cloudflare 的 Git 集成还支持 GitLab（以及 Cursor Origin）。Bitbucket 等不在支持列表里的平台，可以用 GitHub Actions 之类的第三方 CI 调用 `npx wrangler deploy` 来部署，参考官方文档 [External CI/CD](https://developers.cloudflare.com/workers/ci-cd/external-cicd/)。

---

## 项目结构

```
telegram-bot-worker/
├── wrangler.toml              # Worker 配置：Cron、R2 绑定（自动预置）、环境变量
├── package.json
├── .dev.vars.example          # 本地开发环境变量模板
├── scripts/
│   └── setup.mjs              # 命令行版 Webhook 设置脚本（面板部署用不上）
├── src/
│   ├── index.js               # 入口：fetch / scheduled / setup（自注册 Webhook）
│   ├── router.js              # 解析 update → 构造 ctx → 分发到插件
│   ├── cron.js                # 定时调度：把 cronCtx 广播给各插件
│   ├── telegram.js            # Telegram API 封装（429 重试、自动分片）
│   ├── store.js               # R2 封装 + key 命名空间约定
│   ├── utils.js               # 时区换算、自然语言时间解析、转义
│   └── plugins/
│       ├── index.js           # ★ 插件注册表（加插件只改这里）
│       ├── help.js
│       ├── settings.js
│       ├── weather.js
│       ├── monitor.js
│       ├── remind.js
│       └── translate.js
└── test/
    ├── unit.test.mjs          # 时区 / 时间解析 / key 排序 单元测试（35 项）
    ├── entry.test.mjs         # Worker 入口、路由边界、Webhook 安全校验与自注册（39 项）
    └── e2e.test.mjs           # 全链路集成测试，mock 掉全部外部依赖（75 项）
```
