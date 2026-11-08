import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLanguage, systemLocale, readPreference, savePreference } from '../../i18n/language.mjs';
test('Chinese systems use Chinese; all other or unknown locales use English', () => {
  for (const locale of ['zh', 'zh-CN', 'zh_TW.UTF-8', 'zh-Hant-HK']) assert.equal(resolveLanguage('system', locale), 'zh-CN');
  for (const locale of ['en-US', 'ja-JP', 'de_DE.UTF-8', 'C', '', undefined]) assert.equal(resolveLanguage('system', locale), 'en');
});
test('saved selection overrides system; unknown preferences follow system', () => {
  assert.equal(resolveLanguage('en', 'zh-CN'), 'en');
  assert.equal(resolveLanguage('zh-CN', 'fr-FR'), 'zh-CN');
  assert.equal(resolveLanguage('bad', 'en-US'), 'en');
});
test('Linux locale priority follows LC_ALL, LC_MESSAGES, LANG', () => {
  assert.equal(systemLocale({LC_ALL:'en_US.UTF-8',LC_MESSAGES:'zh_CN',LANG:'zh_CN'}, 'zh-CN', 'linux'), 'en_US.UTF-8');
  assert.equal(systemLocale({LC_MESSAGES:'zh_TW', LANG:'en_US'}, 'en-US', 'linux'), 'zh_TW');
  assert.equal(systemLocale({LANG:'zh_CN'}, 'en-US', 'linux'), 'zh_CN');
  assert.equal(systemLocale({LANG:'en_US'}, 'zh-CN', 'darwin'), 'zh-CN');
});
test('preference survives new reads and failed writes do not change it', () => {
  const values = new Map(); const storage = {getItem:k=>values.get(k),setItem:(k,v)=>values.set(k,v)};
  assert.equal(readPreference(storage),'system');
  savePreference('en',storage); assert.equal(readPreference(storage),'en');
  assert.throws(()=>savePreference('ja',storage)); assert.equal(readPreference(storage),'en');
  assert.throws(()=>savePreference('zh-CN',{setItem(){throw Error('disk full')}}));
  savePreference('system',storage); assert.equal(readPreference(storage),'system');
  assert.equal(readPreference({getItem(){throw Error('unavailable')}}),'system');
});

import { readFileSync } from 'node:fs';
import { createTranslator } from '../../i18n/translator.mjs';
const dictionary = JSON.parse(readFileSync(new URL('../../i18n/en.json', import.meta.url)));
const templates = JSON.parse(readFileSync(new URL('../../i18n/templates.json', import.meta.url)));
const translate = createTranslator(dictionary, templates);
test('English UI translates messages while preserving dynamic source titles and non-text nodes', () => {
  assert.equal(translate('设置'), 'Settings');
  assert.equal(translate('继续观看 重生 第1集'), 'Continue 重生, episode 1');
  assert.equal(translate('未知的来源原文'), '未知的来源原文');
  const element = {type: 'span'}; assert.equal(translate(element), element);
  assert.equal(translate(49), 49);
});
test('English fragments preserve separation from adjacent numbers', () => {
  assert.equal(translate('共') + 49 + translate('集'), 'Total 49 episodes ');
  assert.match(translate(' 正在下载…'), /^ /);
});

import { formatMessage } from '../../i18n/translator.mjs';
import { buildSync } from 'esbuild';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

const require = createRequire(import.meta.url);
function loadModule(entryPoint, globals = {}) {
  const { outputFiles } = buildSync({ entryPoints: [entryPoint], bundle: true, platform: 'node', format: 'cjs', write: false, external: ['react'] });
  const module = { exports: {} };
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, require, ...globals });
  return module.exports;
}

test('complete messages distinguish page, rank and episode labels without changing source values', () => {
  assert.equal(translate('第 {0} 页', [1]), 'Page 1');
  assert.equal(translate('第 {0} / {1} 页', [2, 8]), 'Page 2 of 8');
  assert.equal(translate('榜单第 {0} 名', [3]), 'Rank 3');
  assert.equal(translate('第 {0} 集 / 共 {1} 集', [7, 49]), 'Episode 7 of 49');
  const title = '重生  《逆袭》 {1} $&';
  assert.equal(translate('《{0}》第 {1} 集', [title, 7]), `“${title}” · Episode 7`);
  assert.equal(formatMessage('《{0}》第 {1} 集', [title, 7]), `《${title}》第 7 集`);
  const path = '/下载  目录/重生/{0}.mp4';
  assert.equal(translate('未知消息：{0}', [path]), `未知消息：${path}`);
  assert.equal(translate('来源原文（保持  空格）'), '来源原文（保持  空格）');
  assert.equal(translate('剧名'), '剧名');
  assert.equal(translate('集数'), '集数');
  assert.equal(translate('标题'), '标题');
});

test('observed discovery filters and comment controls have English labels', () => {
  for (const label of ['漫画', '综合热播榜', '真人热播榜', '漫剧热播榜', 'AI 热播榜', '宫斗', '脑洞', '青春', '动作', '喜剧', '古言', '抗战', '灵异', '仙侠', '奇幻', '现言', '年代爱情', '民国爱情', '志怪', '权谋', '女性成长', '科幻', '法律', '刑侦', '求生', '武侠', '种田', '恐怖', '商战', '家国情怀', '民国传奇', '冒险', '魔幻', '爱情', '家族', '成长', '传奇', '年代', '灾难', '战争', '综艺', '剧情', '惊悚', '开启时间轴弹幕', '关闭时间轴弹幕', '开启本集评论', '关闭本集评论']) {
    assert.doesNotMatch(translate(label), /[\u4e00-\u9fff]/, label);
  }
});

test('download fallback and proxy results preserve quality, status and raw error codes', () => {
  assert.equal(translate('已下载更低质量片源：720P（原选 1080P）'), 'Downloaded at lower quality: 720P (requested 1080P)');
  assert.equal(translate('正在下载更低质量片源：720P（原选 1080P）'), 'Downloading at lower quality: 720P (requested 1080P)');
  assert.equal(translate('红果官网连接正常（HTTP 200，耗时 13ms）'), 'Connected to the official Hongguo website (HTTP 200, 13 ms)');
  assert.equal(translate('请求返回 HTTP 503（耗时 13ms）'), 'Request returned HTTP 503 (13 ms)');
  const certificate = translate('测试站点证书校验失败，连接已拒绝；请检查系统时间、证书链或代理的 HTTPS 配置（UNABLE_TO_VERIFY_LEAF_SIGNATURE）（耗时 13ms）');
  assert.doesNotMatch(certificate, /[\u4e00-\u9fff]/);
  assert.match(certificate, /UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
  assert.equal(translate(' · 经由 {0}', [translate('(直连)')]), ' · Via Direct connection');
});

test('shortcut labels translate each key and action, including Shift combinations', () => {
  const shortcuts = loadModule('src/shortcuts.js');
  assert.equal(shortcuts.formatShortcut('space'), '空格');
  assert.equal(shortcuts.formatShortcut('space', translate), 'Space');
  assert.equal(shortcuts.formatShortcut('shift+arrowright', translate), 'Shift + →');
  const hint = shortcuts.SHORTCUT_ACTIONS.map(action => `${shortcuts.formatShortcut(action.key, translate)} ${translate(action.label)}`).join(' · ');
  assert.doesNotMatch(hint, /[\u4e00-\u9fff]/);
  assert.equal(translate('全屏（{0}）', [shortcuts.formatShortcut('space', translate)]), 'Fullscreen (Space)');
  assert.equal(translate(shortcuts.validateShortcuts({ ...shortcuts.DEFAULT_SHORTCUTS, next: 'arrowup' }, translate)), 'Conflicts with Previous episode; choose another key');
});

test('language changes update the native bridge; bridge failure cannot undo UI or preference', async () => {
  const values = new Map();
  const calls = [];
  const document = { documentElement: {}, title: '' };
  const window = { localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) }, addEventListener() {}, electronAPI: {
    getAppInfo: async () => ({ systemLocale: 'zh-CN' }),
    setInterfaceLanguage: language => { calls.push(language); return Promise.reject(new Error('native bridge unavailable')); },
  } };
  const language = loadModule('src/i18n/index.js', { window, document, navigator: { language: 'en-US' } });
  await language.initializeLanguage();
  assert.equal(language.getLanguage(), 'zh-CN');
  language.setLanguagePreference('en');
  await Promise.resolve();
  assert.equal(language.getLanguage(), 'en');
  assert.equal(document.documentElement.lang, 'en');
  assert.equal(document.title, 'Hongguo Drama');
  assert.equal(values.get('hongguo:language'), 'en');
  assert.deepEqual(calls, ['zh-CN', 'en']);
  assert.equal(language.t('《{0}》第 {1} 集', ['重生  {1}', 7]), '“重生  {1}” · Episode 7');
  window.electronAPI.setInterfaceLanguage = () => { throw new Error('sync failure'); };
  language.setLanguagePreference('zh-CN');
  assert.equal(language.t('第 {0} 页', [1]), '第 1 页');
  assert.equal(document.title, '红果短剧');
});


test('known proxy failures translate with elapsed time while unknown raw errors stay unchanged', () => {
  for (const hint of ['连接超时，请检查代理地址/端口或代理是否可用', '代理端口拒绝连接，请确认代理软件已启动、端口填写正确', '无法解析代理地址，请检查主机名', '代理需要认证，请填写用户名与密码']) {
    assert.doesNotMatch(translate(hint), /[\u4e00-\u9fff]/);
    const result = translate(`${hint}（耗时 12000ms）`);
    assert.doesNotMatch(result, /[\u4e00-\u9fff]/);
    assert.match(result, /12000 ms/);
  }
  const unknown = '未知代理报错 ECONNRESET（耗时 123ms）';
  assert.equal(translate(unknown), unknown);
  assert.equal(translate('红果'), 'Hongguo');
});
