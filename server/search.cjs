const { searchApp } = require('../src/native/hongguo-app-search');
const { searchHongguo } = require('../src/native/hongguo-search');
const cursors = new Map();
async function search(keyword, options) {
  const key = `${keyword}:${options.page}`, cached = cursors.get(key);
  try {
    const result = await searchApp(keyword, { ...options, cursor: cached?.expires > Date.now() ? cached.cursor : null });
    if (result.hasMore) cursors.set(`${keyword}:${options.page + 1}`, { cursor: result.cursor, expires: Date.now() + 300000 });
    while (cursors.size > 100) cursors.delete(cursors.keys().next().value);
    return result;
  } catch { return searchHongguo(keyword, options); }
}
module.exports = { search };
