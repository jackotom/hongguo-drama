import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// 回归：账号页收藏行的「查看」按钮曾被 `.account-history-list button`
// 的 width:100% 命中，导致主按钮被压成一条竖排文字。
// 这里用选择器特异性做静态检查，防止以后再写出更弱的规则被覆盖。

const css = fs.readFileSync(new URL('../AccountManagement.css', import.meta.url), 'utf8');

// 粗略计算单个选择器的特异性 [id, class, type]
function specificity(selector) {
  const text = selector.replace(/\s*>\s*/g, ' ').trim();
  const ids = (text.match(/#[\w-]+/g) || []).length;
  const classes = (text.match(/\.[\w-]+|\[[^\]]+\]|:[\w-]+/g) || []).length;
  const types = (text.match(/(^|\s)[a-z][\w-]*/gi) || []).length;
  return [ids, classes, types];
}

const compare = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
};

// 取出某个类名作为主选择器（不含后代）的所有规则块
function rulesFor(fragment) {
  const found = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let match;
  while ((match = re.exec(css))) {
    const selectorText = match[1].trim();
    if (!selectorText.includes(fragment)) continue;
    for (const selector of selectorText.split(',')) {
      if (selector.includes(fragment)) found.push({ selector: selector.trim(), body: match[2] });
    }
  }
  return found;
}

test('查看按钮的宽度规则必须胜过 .account-history-list button', () => {
  const baseline = specificity('.account-history-list button');
  const viewWidthRules = rulesFor('.account-view-button').filter(rule => /\bwidth\s*:/.test(rule.body));
  assert.ok(viewWidthRules.length, '.account-view-button 必须显式声明 width，否则继承列表按钮的 100%');
  for (const rule of viewWidthRules) {
    assert.ok(compare(specificity(rule.selector), baseline) > 0,
      `选择器「${rule.selector}」特异性不高于 .account-history-list button，会被它的 width:100% 覆盖`);
  }
});

test('查看按钮不得继承列表按钮的 flex 撑满行为', () => {
  const rules = rulesFor('.account-view-button');
  const flexRule = rules.find(rule => /\bflex\s*:/.test(rule.body));
  assert.ok(flexRule, '必须显式设置 flex，避免被列表按钮的默认 flex 行为影响');
  assert.match(flexRule.body, /flex\s*:\s*0\s+0\s+auto/, '查看按钮应为 flex: 0 0 auto，不参与拉伸');
});

test('收藏行容器用 flex 且允许主按钮收缩', () => {
  const liRules = rulesFor('account-row-with-view');
  const flexRule = liRules.find(rule => /display\s*:\s*flex/.test(rule.body));
  assert.ok(flexRule, '收藏行 li 必须是 flex 容器');
  const mainRules = rulesFor('account-row-with-view');
  assert.ok(mainRules.some(rule => /flex/.test(rule.body) && /button/.test(rule.selector)),
    '主按钮需要独立的 flex 声明以占据剩余宽度');
});