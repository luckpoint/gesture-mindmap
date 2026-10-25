/* Optional real-browser regression checks. Requires Playwright and Chromium/--chrome. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');

(async () => {
  const { createRelay } = await import('../server/index.mjs');
  const client = new EventEmitter(); let starts = 0;
  client.status = async () => ({ available: true });
  client.rpc = async (method, params) => {
    if (method === 'model/list') return { data: [{ model: 'mock', isDefault: true }] };
    if (method === 'thread/start') return { thread: { id: 'mock-thread' } };
    if (method === 'turn/start') {
      starts++;
      setTimeout(() => client.emit('notification', 'turn/completed', {
        threadId: params.threadId, turn: { id: 'mock-turn', status: 'completed', items: [{
          id: 'message', type: 'agentMessage', text: JSON.stringify({ status: 'no_change', message: '', operations: [] }),
        }] },
      }), 20);
      return { turn: { id: 'mock-turn' } };
    }
    return {};
  };
  const { server, service } = createRelay(client, undefined, { instructions: true });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ headless: true, ...(process.argv.includes('--chrome') ? { channel: 'chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.waitForLoadState('networkidle');
    await page.waitForFunction(() => library && mapId);
    assert.ok(await page.locator('.node').count() > 0);
    const authenticated = await page.evaluate(async () => {
      const status = await instructionClient.status();
      const proposal = await instructionClient.run({ requestId: 'browser-security', mapSessionId, baseRevision: revision,
        prompt: 'No changes', selectedNodeId: null, map: serializeMap() });
      const badType = await fetch('/api/instructions', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' });
      return { available: status.available, proposal: proposal.status, badType: badType.status, cookieVisible: document.cookie.includes('mindmap_relay_') };
    });
    assert.deepEqual(authenticated, { available: true, proposal: 'no_change', badType: 415, cookieVisible: false });
    assert.equal(starts, 1);
    const privacy = await page.evaluate(async () => {
      const marker = 'PRIVATE_AUTHOR_GPS_TEST', encoder = new TextEncoder();
      const canvas = new OffscreenCanvas(8, 4), ctx = canvas.getContext('2d');
      ctx.fillStyle = 'red'; ctx.fillRect(1, 1, 2, 2);
      const crc32 = bytes => {
        let c = 0xffffffff;
        for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
        return (c ^ 0xffffffff) >>> 0;
      };
      const pixels = await canvas.convertToBlob({ type: 'image/png' }), bytes = new Uint8Array(await pixels.arrayBuffer());
      const payload = encoder.encode('Author\0' + marker), chunk = new Uint8Array(payload.length + 12), v = new DataView(chunk.buffer);
      v.setUint32(0, payload.length); chunk.set(encoder.encode('tEXt'), 4); chunk.set(payload, 8);
      v.setUint32(chunk.length - 4, crc32(chunk.subarray(4, chunk.length - 4)));
      const annotatedPNG = new Blob([bytes.subarray(0, 33), chunk, bytes.subarray(33)], { type: 'image/png' });
      // A valid JPEG EXIF Artist tag, with its ASCII string stored after the IFD.
      const jpeg = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/jpeg' })).arrayBuffer());
      const artist = encoder.encode(marker + '\0'), exif = new Uint8Array(6 + 26 + artist.length), ev = new DataView(exif.buffer);
      exif.set(encoder.encode('Exif\0\0')); exif.set([73, 73, 42, 0, 8, 0, 0, 0], 6);
      ev.setUint16(14, 1, true); ev.setUint16(16, 315, true); ev.setUint16(18, 2, true);
      ev.setUint32(20, artist.length, true); ev.setUint32(24, 26, true); exif.set(artist, 32);
      const app1 = new Uint8Array(4); app1.set([255, 225]); new DataView(app1.buffer).setUint16(2, exif.length + 2);
      const annotatedJPEG = new Blob([jpeg.subarray(0, 2), app1, exif, jpeg.subarray(2)], { type: 'image/jpeg' });
      for (const file of [annotatedPNG, annotatedJPEG]) {
        if (!(await file.text()).includes(marker)) throw Error('Invalid metadata fixture');
        const prepared = await NodeImageUpload.prepare(file);
        if ((await prepared.text()).includes(marker)) throw Error('Upload retained metadata');
        const decoded = await createImageBitmap(prepared); if (decoded.width !== 8 || decoded.height !== 4) throw Error('Wrong dimensions'); decoded.close();
      }
      const transparent = await createImageBitmap(await NodeImageUpload.prepare(annotatedPNG));
      const check = new OffscreenCanvas(8, 4); check.getContext('2d').drawImage(transparent, 0, 0); transparent.close();
      if (check.getContext('2d').getImageData(0, 0, 1, 1).data[3] !== 0) throw Error('Transparency lost');
      // Legacy stored images must also be cleaned without modifying their saved references.
      await attachNodeImage(annotatedPNG, { nodeId: 'root', mapSessionId, revision }, 'legacy image');
      const saved = serializeMap(), originalId = saved.nodes.root.image.assetId;
      const bundle = await NodeImageFormat.exportBundle(saved, imageStore), newId = bundle.map.nodes.root.image.assetId;
      if (newId === originalId || map.nodes.root.image.assetId !== originalId) throw Error('Hash remapping mutated the original');
      const cleaned = new Blob([Uint8Array.from(atob(bundle.assets[newId].data), c => c.charCodeAt(0))], { type: bundle.assets[newId].mime });
      if ((await cleaned.text()).includes(marker)) throw Error('Export retained metadata');
      const roundtrip = await NodeImageFormat.importBundle(bundle, imageStore);
      return { formats: 2, transparent: true, roundtrip: roundtrip.nodes.root.image.assetId === newId };
    });
    assert.deepEqual(privacy, { formats: 2, transparent: true, roundtrip: true });
    const performanceResult = await page.evaluate(async () => {
      const large = { version: 2, title: '2,048 node limit', root: 'n0', seq: 2048, nodes: {} };
      for (let i = 0; i < 2048; i++) large.nodes['n' + i] = { id: 'n' + i, text: 'Node ' + i, parent: i ? 'n0' : null,
        x: (i % 46 - 23) * 220, y: (Math.floor(i / 46) - 22) * 90, order: i };
      const start = performance.now(); await importMap(large);
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const importMs = performance.now() - start;
      select('n100'); const editStart = performance.now(); nudge('ArrowRight');
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const editMs = performance.now() - editStart;
      const before = JSON.stringify(map); addChildAndEdit('n0');
      if (JSON.stringify(map) !== before || editing) throw Error('Limit changed the current map');
      const oversized = JSON.parse(JSON.stringify(large)); oversized.nodes.extra = { ...oversized.nodes.n1, id: 'extra' };
      let rejected = false; try { await NodeImageFormat.importBundle(oversized, imageStore); } catch { rejected = true; }
      if (!rejected) throw Error('Oversized import accepted');
      return { nodes: document.querySelectorAll('.node').length, importMs: Math.round(importMs), editMs: Math.round(editMs) };
    });
    assert.equal(performanceResult.nodes, 2048);
    await page.screenshot({ path: '/tmp/lp-mindmap-security-2048.png' });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ authenticated, privacy, performance: performanceResult }, null, 2));
  } finally {
    await browser?.close(); service.close(); server.closeAllConnections(); server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
