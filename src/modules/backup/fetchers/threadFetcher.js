function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchThreads(channel, errors = []) {
  const threads = [];

  try {
    const active = await channel.threads.fetchActive();
    active.threads.forEach(t => threads.push(t));
  } catch (err) {
    errors.push(`获取活跃子区失败 [${channel.name}]: ${err.message}`);
  }

  try {
    let hasMore = true;
    let before;
    while (hasMore) {
      const archived = await channel.threads.fetchArchived({ limit: 100, before });
      archived.threads.forEach(t => threads.push(t));
      hasMore = archived.hasMore;
      if (archived.threads.size > 0) {
        before = archived.threads.last().id;
      } else {
        hasMore = false;
      }
      if (hasMore) await sleep(100);
    }
  } catch (err) {
    errors.push(`获取归档子区失败 [${channel.name}]: ${err.message}`);
  }

  return threads;
}

module.exports = { fetchThreads };
