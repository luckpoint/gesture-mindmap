const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { createHash } = require('node:crypto');
const { tmpdir } = require('node:os');
const { join, dirname } = require('node:path');
const { test } = require('node:test');

const load = () => import('../scripts/verify-assets.mjs');
const sha256 = text => createHash('sha256').update(text).digest('hex');

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'assets-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}
const base = {
  'index.html': '<!doctype html>',
  'features.js': 'globalThis.MindmapFeatures = Object.freeze({ instructions: false });',
  'vendor/rxdb.js': 'export {}',
  'mediapipe/model.task': 'model',
};
const pinned = { 'model.task': { sha256: sha256('model') } };

test('complete static assets pass', async () => {
  const { verifyAssets } = await load();
  assert.deepEqual(verifyAssets(tree({ ...base, '.DS_Store': 'x', 'a.js.map': 'x' }), pinned), { errors: [], files: 4 });
});

test('missing vendor bundle, hash mismatch and enabled instructions stop the deploy', async () => {
  const { verifyAssets } = await load();
  const { 'vendor/rxdb.js': _, ...rest } = base;
  const { errors } = verifyAssets(tree({ ...rest, 'mediapipe/model.task': 'tampered', 'features.js': '({ instructions: true })' }), pinned);
  assert.deepEqual(errors, [
    'vendor/rxdb.js: 見つかりません',
    'mediapipe/model.task: SHA-256が一致しません',
    'features.js: instructions が false ではありません',
  ]);
});

test('every environment disables workers.dev and preview URLs', () => {
  const config = JSON.parse(readFileSync(join(__dirname, '../wrangler.jsonc'), 'utf8'));
  for (const env of [config, config.env.staging, config.env.production])
    assert.deepEqual([env.workers_dev, env.preview_urls], [false, false]);
  assert.equal(config.env.staging.routes[0].pattern, 'mindmap-stg.luckpoint.jp');
  assert.notEqual(config.env.staging.name, config.env.production.name);
});
