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
  assert.deepEqual(verifyAssets(tree({ ...base, '.DS_Store': 'x', 'a.js.map': 'x' }), pinned), {
    errors: [],
    files: 4,
  });
});

test('missing vendor bundle, hash mismatch and enabled instructions stop the deploy', async () => {
  const { verifyAssets } = await load();
  const { 'vendor/rxdb.js': _, ...rest } = base;
  const { errors } = verifyAssets(
    tree({ ...rest, 'mediapipe/model.task': 'tampered', 'features.js': '({ instructions: true })' }),
    pinned,
  );
  assert.deepEqual(errors, [
    'vendor/rxdb.js: 見つかりません',
    'mediapipe/model.task: SHA-256が一致しません',
    'features.js: instructions が false ではありません',
  ]);
});

test('every environment disables workers.dev and preview URLs', () => {
  const config = JSON.parse(readFileSync(join(__dirname, '../wrangler.jsonc'), 'utf8'));
  assert.equal(config.assets.directory, './dist');
  for (const env of [config, config.env.staging, config.env.production])
    assert.deepEqual([env.workers_dev, env.preview_urls], [false, false]);
  assert.equal(config.env.staging.routes[0].pattern, 'mindmap-stg.luckpoint.jp');
  assert.notEqual(config.env.staging.name, config.env.production.name);
});

test('feature validation checks the actual flag, including minified false', async () => {
  const { verifyAssets } = await load();
  for (const value of ['false', '!1', 'true', '!0', '"false"', 'undefined']) {
    const { errors } = verifyAssets(
      tree({
        ...base,
        'features.js': `// instructions: false\nglobalThis.MindmapFeatures = { instructions: ${value} };`,
      }),
      pinned,
    );
    assert.equal(errors.length, ['false', '!1'].includes(value) ? 0 : 1, value);
  }
});

test('deployment build minifies code, preserves assets and removes stale output', async t => {
  const { buildStatic } = await import('../scripts/build-static.mjs');
  const { rmSync, existsSync } = require('node:fs');
  const { runInNewContext } = require('node:vm');
  const html = `<!doctype html><html><head><style id="pageStyle"></style>
    <style>body { color: red; }</style></head><body><pre> A  B\n C </pre>
    <script>globalThis.answer = 20 + 22;</script></body></html>`;
  const source = tree({
    ...base,
    'index.html': html,
    'classic.js': 'var sharedValue = 42; function getSharedValue() { return sharedValue; }',
    'style.css': 'body { color: red; }\n',
    'worker.js': 'self.onmessage = function (event) { self.postMessage(event.data); };',
    'image.png': Buffer.from([0, 255, 127]),
    _headers: '/*\n  X-Content-Type-Options: nosniff\n',
    '.assetsignore': '*.map\n.env*\n',
    'debug.js.map': '{}',
  });
  const output = tree({ 'stale.js': 'old' });
  t.after(() => {
    rmSync(source, { recursive: true });
    rmSync(output, { recursive: true });
  });
  const stats = await buildStatic(source, output);
  assert.ok(stats.after < stats.before);
  assert.equal(existsSync(join(output, 'stale.js')), false);
  assert.equal(existsSync(join(output, 'debug.js.map')), false);
  for (const name of ['vendor/rxdb.js', 'mediapipe/model.task', 'image.png', '_headers', '.assetsignore'])
    assert.deepEqual(readFileSync(join(output, name)), readFileSync(join(source, name)));
  const result = readFileSync(join(output, 'index.html'), 'utf8');
  assert.match(result, /<style id=.?pageStyle.?><\/style>/);
  assert.match(result, /<pre> A  B\n C <\/pre>/);
  assert.ok(result.length < html.length);
  assert.equal(readFileSync(join(source, 'index.html'), 'utf8'), html);
  const inlineContext = {};
  runInNewContext(result.match(/<script>([\s\S]*?)<\/script>/)[1], inlineContext);
  assert.equal(inlineContext.answer, 42);
  const context = {};
  runInNewContext(readFileSync(join(output, 'classic.js'), 'utf8'), context);
  assert.equal(context.getSharedValue(), 42);
  const worker = {
    self: {
      postMessage: value => {
        worker.value = value;
      },
    },
  };
  runInNewContext(readFileSync(join(output, 'worker.js'), 'utf8'), worker);
  worker.self.onmessage({ data: 42 });
  assert.equal(worker.value, 42);
  assert.deepEqual((await load()).verifyAssets(output, pinned).errors, []);
});
