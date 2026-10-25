/* Optional browser acceptance checks; uses the same Playwright setup as verify-node-images.cjs. */
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const { createRelay } = await import('../server/index.mjs');
  const { server } = createRelay();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      ...(process.argv.includes('--chrome') ? { channel: 'chrome' } : {}),
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'ja-JP' });
    const page = await context.newPage(),
      errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const url = `http://127.0.0.1:${server.address().port}`;
    const ready = async p => {
      await p.goto(url);
      await p.waitForFunction(() => document.querySelector('#save').dataset.state === 'saved');
    };
    const open = async p => {
      await p.locator('#fileBtn').click();
      await p.locator('#paletteToggle').click();
    };
    await ready(page);
    assert.equal(await page.locator('#iconPalette').getAttribute('aria-hidden'), 'true');
    await open(page);
    await page.locator('#paletteClose').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#paletteList button').count(), 72);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'paletteClose');
    assert.equal(await page.evaluate(() => viewportWidth()), 960);
    // Native drag from an unselected icon applies to the hovered node, not the selection.
    await page.evaluate(() => select('a'));
    const dragBefore = await page.evaluate(() => ({
      count: Object.keys(map.nodes).length,
      history: history.length,
      selection: selectedId,
    }));
    const rootNode = page.locator('.node[data-id="root"]');
    await page.locator('#paletteList button').first().dragTo(rootNode);
    await page.waitForFunction(() => !!map.nodes[map.root].image);
    const firstDrag = await page.evaluate(() => map.nodes[map.root].image);
    assert.equal(await page.evaluate(() => selectedId), dragBefore.selection);
    assert.equal(await page.evaluate(() => Object.keys(map.nodes).length), dragBefore.count);
    assert.equal(await page.evaluate(() => history.length), dragBefore.history + 1);
    assert.equal(await page.locator('.is-drop-target').count(), 0);
    await page.locator('#paletteList button').nth(1).dragTo(rootNode);
    await page.waitForFunction(id => map.nodes[map.root].image.assetId !== id, firstDrag.assetId);
    await page.evaluate(() => undo());
    assert.equal(await page.evaluate(() => map.nodes[map.root].image.assetId), firstDrag.assetId);
    await page.evaluate(() => redo());
    assert.notEqual(await page.evaluate(() => map.nodes[map.root].image.assetId), firstDrag.assetId);
    await page.evaluate(() => {
      undo();
      undo();
    });
    assert.equal(await page.evaluate(() => !!map.nodes[map.root].image), false);
    // Releasing outside a node makes no history entry and clears the target outline.
    await page.locator('#paletteList button').first().dragTo(page.locator('#paletteSearch'));
    assert.equal(await page.evaluate(() => history.length), dragBefore.history);
    assert.equal(await page.locator('.is-drop-target').count(), 0);
    await page.locator('#palette-daily').click();
    await page.locator('#paletteSearch').fill('ご飯');
    assert.equal(await page.locator('#paletteList button').count(), 1);
    await page.locator('#paletteSearch').fill('home');
    await page.locator('#paletteList button').click();
    const before = await page.evaluate(() => ({ count: Object.keys(map.nodes).length, history: history.length }));
    await page.locator('#paletteChild').click();
    await page.waitForFunction(() => map.nodes[selectedId]?.text === '家' && !!map.nodes[selectedId]?.image);
    const after = await page.evaluate(() => ({
      count: Object.keys(map.nodes).length,
      history: history.length,
      ref: map.nodes[selectedId].image,
    }));
    assert.equal(after.count, before.count + 1);
    assert.equal(after.history, before.history + 1);
    assert.equal(after.ref.width, 128);
    assert.equal(after.ref.height, 112);
    await page.locator('#paletteSearch').press('ControlOrMeta+z');
    assert.equal(await page.evaluate(() => Object.keys(map.nodes).length), after.count);
    await page.evaluate(() => undo());
    assert.equal(await page.evaluate(() => Object.keys(map.nodes).length), before.count);
    await page.evaluate(() => redo());
    await page.evaluate(() => select(map.root));
    await page.locator('#paletteApply').click();
    await page.waitForFunction(() => !!map.nodes[map.root].image);
    assert.equal(await page.locator('#paletteApply').innerText(), '画像を置き換える');
    assert.equal(await page.evaluate(() => map.nodes[map.root].image.assetId), after.ref.assetId);
    await page.evaluate(() => undo());
    assert.equal(await page.evaluate(() => !!map.nodes[map.root].image), false);
    await page.evaluate(() => redo());
    const bundle = await page.evaluate(() => NodeImageFormat.exportBundle(serializeMap(), imageStore));
    assert.equal(Object.keys(bundle.assets).length, 1);
    await page.waitForFunction(() => document.querySelector('#save').dataset.state === 'saved');
    await page.reload();
    await page.waitForFunction(() => !!document.querySelector('.node__image img')?.naturalWidth);
    assert.equal(await page.locator('#iconPalette').getAttribute('aria-hidden'), 'true');
    await open(page);
    await page.screenshot({ path: '/tmp/icon-palette-desktop.png' });
    for (const size of [
      { width: 900, height: 700 },
      { width: 600, height: 900 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(size);
      await page.waitForTimeout(300);
      assert.equal(await page.locator('#iconPalette').getAttribute('aria-hidden'), 'false');
      const layout = await page.evaluate(() => {
        const right = document.querySelector('#iconPalette').getBoundingClientRect().left;
        return ['.topbar', '.dock', '.zoom', '#nodeMenu', '#prompt', '.notices', '#dev'].filter(s => {
          const e = document.querySelector(s),
            r = e.getBoundingClientRect();
          return !e.hidden && getComputedStyle(e).display !== 'none' && r.right > right + 1;
        });
      });
      assert.deepEqual(layout, [], JSON.stringify(size));
    }
    await page.screenshot({ path: '/tmp/icon-palette-small-landscape.png' });
    await page.locator('#paletteClose').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'fileBtn');
    // iPad desktop UA and iPhone: rotation, selection retention, no automatic reopening.
    for (const apple of [
      {
        ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15',
        land: { width: 1024, height: 768 },
        portrait: { width: 768, height: 1024 },
      },
      {
        ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1',
        land: { width: 844, height: 390 },
        portrait: { width: 390, height: 844 },
      },
    ]) {
      const mobile = await browser.newContext({
        userAgent: apple.ua,
        hasTouch: true,
        isMobile: true,
        viewport: apple.land,
        locale: 'ja-JP',
      });
      const p = await mobile.newPage();
      p.on('pageerror', e => errors.push(e.message));
      await ready(p);
      await open(p);
      await p.locator('#paletteList button').first().click();
      await p.locator('#paletteChild').click();
      await p.waitForFunction(() => !!map.nodes[selectedId]?.image);
      await p.locator('#paletteSearch').fill('baby');
      if (apple.land.width === 844)
        assert.equal(
          await p.locator('#paletteList').evaluate(e => getComputedStyle(e).gridTemplateColumns.split(' ').length),
          3,
        );
      await p.locator('#paletteClose').focus();
      await p.setViewportSize(apple.portrait);
      await p.waitForTimeout(300);
      assert.equal(await p.locator('#iconPalette').getAttribute('aria-hidden'), 'true');
      assert.equal(await p.locator('#paletteToggle').isVisible(), false);
      assert.equal(await p.evaluate(() => viewportWidth()), apple.portrait.width);
      assert.equal(await p.evaluate(() => document.activeElement.id), 'fileBtn');
      await p.setViewportSize(apple.land);
      await p.waitForTimeout(100);
      assert.equal(await p.locator('#iconPalette').getAttribute('aria-hidden'), 'true');
      await open(p);
      assert.equal(await p.locator('#paletteSearch').inputValue(), 'baby');
      await mobile.close();
    }
    const fresh = await browser.newContext({ locale: 'ja-JP' });
    const other = await fresh.newPage();
    await ready(other);
    await other
      .locator('#fileInput')
      .setInputFiles({ name: 'icons.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(bundle)) });
    await other.waitForFunction(
      () => !!map.nodes[map.root]?.image && !!document.querySelector('.node__image img')?.naturalWidth,
    );
    assert.equal(await other.evaluate(() => map.nodes[map.root].image.assetId), after.ref.assetId);
    assert.deepEqual(errors, []);
    await fresh.close();
    await context.close();
    console.log(
      'Icon palette: operations, Undo/Redo, persistence, JSON portability, keyboard, layouts and Apple rotation checks passed.',
    );
  } finally {
    await browser?.close();
    await new Promise(r => server.close(r));
  }
})().catch(e => {
  console.error(e);
  process.exitCode = 1;
});
