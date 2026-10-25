const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync, readdirSync } = require('node:fs');
const { join, relative } = require('node:path');
const I18n = require('../ui-prototype/i18n.js');

const JAPANESE = /[぀-ヿ一-鿿]/;
const root = join(__dirname, '../ui-prototype');
const html = readFileSync(join(root, 'index.html'), 'utf8');
const { en, ja } = I18n.messages;
const ARGS = {
  'delete.previewReconnect': ['Parent', ['a', 'b']],
  'instruction.previewItem': ['Name', 'Scope', 2, ['a', 'b']],
  'dev.metrics': [{ mode: 'worker', hands: 2, frameValid: true, inferenceMs: 1, displayMs: 2, revision: 'r' }],
  'ops.summary': [{ added: 1, updated: 2, reparented: 0, moved: 1, deleted: 3 }],
};
const render = (dict, key) =>
  typeof dict[key] === 'function' ? dict[key](...(ARGS[key] || [2, 'Name', 3])) : dict[key];

test('only a Japanese first language selects Japanese', () => {
  assert.equal(I18n.detect(['ja-JP']), 'ja');
  assert.equal(I18n.detect(['ja', 'en']), 'ja');
  for (const languages of [['en-US', 'ja'], ['fr'], ['jav'], [], undefined]) assert.equal(I18n.detect(languages), 'en');
});

test('English and Japanese define the same keys with the same kind of value', () => {
  assert.deepEqual(Object.keys(ja).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) assert.equal(typeof ja[key], typeof en[key], key);
});

test('English messages contain no Japanese text', () => {
  for (const key of Object.keys(en)) assert.doesNotMatch(render(en, key), JAPANESE, key);
});

test('every data-i18n key in the page exists', () => {
  const keys = [...html.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]);
  assert.ok(keys.length > 50);
  for (const key of keys) assert.ok(Object.hasOwn(en, key), key);
});

test('every data-i18n key in the landing page exists in both languages', () => {
  const landing = readFileSync(join(root, 'landing.html'), 'utf8');
  const keys = [...landing.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m => m[1]);
  assert.ok(keys.length > 30);
  for (const key of keys) assert.ok(Object.hasOwn(en, key) && Object.hasOwn(ja, key), key);
});

test('user-facing code keeps Japanese only in the dictionary', () => {
  const files = [];
  const walk = dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!['vendor', 'mediapipe', 'legal'].includes(entry.name)) walk(path);
      } else if (/\.(js|html)$/.test(entry.name) && entry.name !== 'i18n.js') files.push(path);
    }
  };
  walk(root);
  for (const file of files) assert.doesNotMatch(readFileSync(file, 'utf8'), JAPANESE, relative(root, file));
});

test('t fills in values, picks English plurals and returns unknown keys as is', () => {
  I18n.use('en');
  assert.equal(I18n.t('delete.branchConfirm', 1), 'Delete 1 node');
  assert.equal(I18n.t('delete.branchConfirm', 2), 'Delete 2 nodes');
  assert.equal(
    I18n.t('ops.summary', { added: 1, updated: 0, reparented: 0, moved: 0, deleted: 2 }),
    '1 added, 2 deleted',
  );
  assert.equal(I18n.t('missing.key'), 'missing.key');
  I18n.use('ja');
  assert.equal(I18n.t('delete.branchConfirm', 2), '子孫を含む2個を削除');
  I18n.use('fr');
  assert.equal(I18n.lang, 'en');
});

test('apply sets the page language, text and attributes', () => {
  const el = dataset => ({
    dataset,
    attributes: {},
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  });
  const button = el({ i18n: 'prompt.send', i18nTitle: 'prompt.hide' }),
    input = el({ i18nAriaLabel: 'prompt.label', i18nPlaceholder: 'prompt.placeholder' });
  const doc = { documentElement: {}, querySelectorAll: () => [button, input] };
  I18n.use('ja');
  I18n.apply(doc);
  assert.equal(doc.documentElement.lang, 'ja');
  assert.equal(button.textContent, '送信');
  assert.equal(button.attributes.title, '指示欄を隠す');
  assert.deepEqual(input.attributes, { 'aria-label': 'マップへの指示', placeholder: 'マップへの指示を入力' });
  I18n.use('en');
});

test('print messages exist in both languages', () => {
  for (const key of ['file.print', 'keys.print']) assert.ok(en[key] && ja[key], key);
});
