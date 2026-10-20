const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const fixture = name => fs.readFileSync(path.join(__dirname, 'fixtures/hema-browse', `${name}.html`), 'utf8');

async function check() {
  const calls = [];
  let override, failure;
  const context = { module: { exports: {} }, URL, AbortController, setTimeout, clearTimeout,
    require: name => name === 'axios' ? { get: async (url, options) => {
      calls.push(url);
      assert.equal(new URL(url).origin, 'https://www.kuaikaw.cn');
      assert.equal(options.timeout, 10000);
      assert.equal(options.maxRedirects, 0);
      assert.equal(options.maxContentLength, 8 * 1024 * 1024);
      assert.ok(!/cookie|authorization|session|token/i.test(JSON.stringify(options.headers)));
      if (failure) throw failure;
      const name = url.endsWith('/0/2') ? 'page2' : url.endsWith('/1129') ? 'genre' : 'browse';
      return { data: override ?? fixture(name) };
    }, post: () => { throw Error('目录不得请求解锁或其他 POST 接口'); } } : require(name) };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'src/native/hema.js'), 'utf8'), context);
  const { browseList } = context.module.exports;
  const first = await browseList();
  assert.equal(first.success, true, first.error);
  assert.equal(calls.length, 1, '首次目录请求不应重复抓取第一页');
  assert.equal(first.results[0].series_id, 'hema:41000415116');
  assert.equal(first.results[0].episode_count, 41);
  assert.equal(first.results[0].source, 'hema');
  assert.equal(first.results[0].rank, undefined, '目录不能伪装成榜单');
  assert.equal(first.results[0].heat, undefined, '关注量不能伪装成热度');
  assert.equal(first.total, 0);
  assert.equal(first.totalPages, 0, '不发布无法核实的分类总页数');
  assert.equal(first.hasMore, true);
  assert.equal(first.nextPage, 2);
  assert.ok(first.genres.some(item => item.slug === '417-464'));
  assert.ok(!first.genres.some(item => item.slug === '0'), '全部按钮由界面提供，不重复');

  const second = await browseList({ page: 2 });
  assert.equal(second.success, true, second.error);
  assert.equal(second.page, 2);
  assert.notEqual(second.results[0].series_id, first.results[0].series_id);
  assert.equal(calls.at(-1), 'https://www.kuaikaw.cn/browse/0/2');
  const genre = await browseList({ genre: '1129' });
  assert.equal(genre.success, true, genre.error);
  assert.equal(genre.sourceUrl, 'https://www.kuaikaw.cn/browse/1129');

  override = fixture('genre').replace('"typeThreeId": "1129"', '"typeThreeId": "417-464"')
    .replace('href="/browse/1129/2"', 'href="/browse/417-464/2"');
  assert.equal((await browseList({ genre: '417-464' })).success, true);
  assert.equal(calls.at(-1), 'https://www.kuaikaw.cn/browse/417-464');
  const beforeInvalid = calls.length;
  for (const options of [{ genre: '../unlock' }, { genre: '999999' }, { page: 0 }, { page: 1.5 }, { page: Infinity }]) {
    assert.equal((await browseList(options)).success, false);
  }
  assert.equal(calls.length, beforeInvalid, '不请求未知题材或无效路径');

  override = fixture('browse').replace(/<a\b[^>]*>下一页<\/a>/, '');
  const last = await browseList();
  assert.equal(last.success, true);
  assert.equal(last.hasMore, false);
  assert.equal(last.nextPage, null);
  override = fixture('browse').replace('href="/browse/0/2"', 'data-href="/browse/0/2"');
  assert.equal((await browseList()).hasMore, false);
  override = fixture('browse');
  assert.equal((await browseList({ page: 2 })).success, false, '分页不一致必须报错');
  assert.equal((await browseList({ genre: '1129' })).success, false, '题材不一致必须报错');
  override = '<html><script>throw Error("must not execute")</script></html>';
  assert.match((await browseList()).error, /数据异常/);
  override = fixture('browse');
  const beforeRefresh = calls.length;
  assert.equal((await browseList({ forceRefresh: true })).success, true);
  assert.equal(calls.length, beforeRefresh + 1, '刷新重新获取题材且复用当前首页响应');
  failure = Object.assign(Error('private network details'), { code: 'ECONNABORTED' });
  assert.match((await browseList()).error, /超时/);

  const browse = fs.readFileSync(path.join(root, 'src/components/Browse.jsx'), 'utf8');
  assert.match(browse, /mediaSources\.map\(\(\{ id, label \}\) => <option key=\{id\} value=\{id\}>\{label\}<\/option>\)/);
  assert.match(fs.readFileSync(path.join(root, 'src/components/mediaSourcesModel.mjs'), 'utf8'), /id: 'hema', label: '河马短剧'/);
  assert.match(browse, /source !== 'hongguo' && !totalPages && \(page > 1 \|\| meta.hasMore\)/);
  assert.match(browse, /西饭热播榜暂未接入/);
  const paging = browse.slice(browse.indexOf('  const gotoPage ='), browse.indexOf('  // ===== 打开某部剧'));
  for (const source of ['hema', 'xifan']) {
    let selectedPage = 1;
    vm.runInNewContext(paging + '\ngotoPage(2);', { source, page: 1, meta: {hasMore:true,totalPages:0},
      invalidateList() {}, setError() {}, setPage(value) { selectedPage = value; }, document: {querySelector:()=>null} });
    assert.equal(selectedPage, 2, source + ' 下一页必须改变当前页码');
  }

  const main = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  const routeStart = main.indexOf("ipcMain.handle('browse-list'");
  assert.ok(routeStart >= 0);
  const routeEnd = main.indexOf('\nipcMain.handle(', routeStart + 1);
  assert.ok(routeEnd > routeStart);
  let handler;
  vm.runInNewContext(main.slice(routeStart, routeEnd), {
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    require: name => ({ browseList: options => ({ name, options }) }),
  });
  for (const source of ['hema', 'xifan', 'hongguo']) {
    const options = { source, genre: '1129', page: 2 };
    const routed = await handler({}, options);
    assert.equal(routed.name, `./src/native/${source === 'hongguo' ? 'catalog' : source}`, '主控须补齐河马 IPC 分流');
    assert.equal(routed.options, options);
  }
  console.log('PASS 河马公开目录、题材白名单、组合题材、分页、刷新、异常与发现页入口；无榜单/热度伪造');
}

check().catch(error => { console.error(error); process.exitCode = 1; });
