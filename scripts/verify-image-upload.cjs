/* Optional real-browser check of local image upload through the node menu. Requires Playwright + Chromium. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
(async () => {
  const { createRelay } = await import('../server/index.mjs');
  const client = new EventEmitter();
  client.status = async () => ({ available: false });
  const { server, service } = createRelay(client);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const out = process.env.SHOT_DIR || '/tmp';
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.argv.includes('--chrome') ? { channel: 'chrome' } : {}),
    });
    const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForLoadState('networkidle');
    const png = (name, w, h) =>
      page
        .evaluate(
          async ([w, h]) => {
            const c = document.createElement('canvas');
            c.width = w;
            c.height = h;
            const x = c.getContext('2d');
            x.fillStyle = '#53948a';
            x.fillRect(0, 0, w, h);
            x.fillStyle = '#f2c14e';
            x.fillRect(w / 4, h / 4, w / 2, h / 2);
            return [...new Uint8Array(await (await new Promise(r => c.toBlob(r))).arrayBuffer())];
          },
          [w, h],
        )
        .then(b => ({ name, mimeType: 'image/png', buffer: Buffer.from(b) }));
    const upload = async (act, file) => {
      const chooser = page.waitForEvent('filechooser');
      await page.locator(`#nodeMenu [data-act=${act}]`).click();
      await (await chooser).setFiles(file);
    };

    await page.locator('[data-id=a]').click();
    await upload('image-child', await png('海辺の電車.png', 320, 240));
    await page.waitForFunction(
      () =>
        state.map.nodes[state.selectedId]?.text === '海辺の電車' &&
        nodeEls.get(state.selectedId).querySelector('img')?.naturalWidth === 320,
    );
    const child = await page.evaluate(() => state.selectedId);
    assert.equal(await page.locator(`[data-id=${child}] .node__text`).isVisible(), true);
    await page.screenshot({ path: out + '/upload-selected.png' });
    const fit = async () => {
      await page.locator('#fitBtn').click();
      await page.evaluate(() => new Promise(r => setTimeout(r, 700)));
    };
    await fit();
    await page.locator('[data-id=b]').click();
    assert.equal(await page.locator(`[data-id=${child}] .node__text`).isVisible(), false);
    const card = await page.locator(`[data-id=${child}]`).evaluate(e => ({ w: e.offsetWidth, h: e.offsetHeight }));
    assert.ok(card.w <= 210 && card.h <= 162, JSON.stringify(card));
    await page.screenshot({ path: out + '/upload-unselected.png' });

    await fit();
    await page.locator('[data-id=root]').click();
    await upload('image', await png('big.png', 3000, 2200));
    await page.waitForFunction(
      () => state.map.nodes.root.image && nodeEls.get('root').querySelector('img')?.naturalWidth === 2048,
    );
    assert.deepEqual(
      await page.evaluate(async () => {
        const a = await imageStore.get(state.map.nodes.root.image.assetId);
        return [state.map.nodes.root.text, a.mime, a.width, a.height];
      }),
      ['週末にやりたいこと', 'image/jpeg', 2048, 1502],
    );
    assert.equal(await page.locator('#nodeMenu [data-act=image] .btn__label').textContent(), '画像を変更');

    await page.locator('#undo').click();
    assert.equal(await page.evaluate(() => !state.map.nodes.root.image), true);
    await page.locator('#redo').click();

    await page.evaluate(() => new Promise(r => setTimeout(r, 800)));
    await page.reload();
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(
      id =>
        nodeEls.get(id)?.querySelector('img')?.naturalWidth === 320 &&
        nodeEls.get('root').querySelector('img')?.naturalWidth === 2048,
      child,
    );
    await fit();
    await page.locator(`[data-id=${child}] .node__image img`).dblclick();
    await page.waitForFunction(() => $('#imageDialog').open && $('#imageViewerImg').naturalWidth === 320);
    const big = await page.locator('#imageViewerImg').boundingBox();
    assert.ok(big.width > 600, JSON.stringify(big));
    assert.equal(await page.evaluate(() => !state.editing), true);
    await page.screenshot({ path: out + '/image-viewer.png' });
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => !$('#imageDialog').open && !state.editing), true);
    assert.deepEqual(errors, []);
    console.log(
      'Browser checks passed: menu upload as child and onto a node, image-only card, text on selection, resize to 2048px JPEG, reload, double-click viewer.',
    );
  } finally {
    await browser?.close();
    service.close();
    server.closeAllConnections();
    await new Promise(r => server.close(r));
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
