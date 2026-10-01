/**
 * cron.js —— 定时调度
 * 每个 cron tick 唤醒一次，把 cronCtx 广播给所有声明了 cron 的插件
 */

export async function runCron(event, app) {
  const now = Date.now();

  const cronCtx = {
    now,
    cron: event?.cron || '* * * * *',
    scheduledTime: event?.scheduledTime || now,
    env: app.env,
    store: app.store,
    bot: app.bot,
    app,
  };

  const jobs = app.plugins.filter((p) => typeof p.cron === 'function');
  if (!jobs.length) return;

  // 插件之间互不阻塞：一个挂了不影响其他
  const results = await Promise.allSettled(
    jobs.map(async (plugin) => {
      const t0 = Date.now();
      try {
        await plugin.cron(cronCtx);
      } finally {
        const cost = Date.now() - t0;
        if (cost > 5000) {
          console.warn(`[cron] 插件 ${plugin.name} 耗时 ${cost}ms，接近 CPU 上限`);
        }
      }
    })
  );

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(`[cron] 插件 ${jobs[i].name} 执行失败`, r.reason);
    }
  });
}
