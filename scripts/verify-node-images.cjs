/* Optional real-browser acceptance checks. Requires Playwright + its Chromium. */
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { chromium } = require('playwright');
(async () => {
  const { createRelay } = await import('../server/index.mjs');
  const client = new EventEmitter(); client.status = async () => ({available:false});
  const {server, service} = createRelay(client);
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await chromium.launch({headless:true, ...(process.argv.includes('--chrome') ? {channel:'chrome'} : {})});
    const context = await browser.newContext({viewport:{width:1280,height:900}});
    const page = await context.newPage(), errors=[];
    page.on('pageerror', e => errors.push(e.message));
    const url='http://127.0.0.1:'+server.address().port;
    await page.goto(url); await page.waitForLoadState('networkidle');
    const result = await page.evaluate(async () => {
      const canvas=document.createElement('canvas');canvas.width=32;canvas.height=24;
      const ctx=canvas.getContext('2d');ctx.fillStyle='#53948a';ctx.fillRect(0,0,32,24);
      const blob=await new Promise(r=>canvas.toBlob(r));
      window.fixtureBlob=blob;
      const before=history.length;
      await attachNodeImage(blob,{nodeId:'a',mapSessionId,revision},'海の絵');
      await attachNodeImage(blob,{nodeId:'root',mapSessionId,revision},'中心の絵');
      const bundle=await NodeImageFormat.exportBundle(serializeMap(),imageStore);
      window.fixtureBundle=bundle;
      return {history:history.length-before,assets:Object.keys(bundle.assets).length,mapVersion:map.version};
    });
    assert.deepEqual(result,{history:2,assets:1,mapVersion:2});
    await page.waitForFunction(()=>[...document.querySelectorAll('.node__image img')].every(img=>img.complete&&img.naturalWidth===32));
    await page.evaluate(()=>new Promise(r=>setTimeout(r,650)));
    const dims=await page.locator('[data-id=a] .node__image').evaluate(e=>({w:e.offsetWidth,h:e.offsetHeight}));
    assert.deepEqual(dims,{w:192,h:144});
    await page.screenshot({path:'/tmp/mindmap-node-images-desktop.png'});
    // Image is first in DOM: edit must still select only the dedicated text.
    await page.evaluate(()=>startEdit('a'));
    await page.locator('[data-id=a] .node__text').fill('画像を残して編集');
    await page.locator('[data-id=a] .node__text').press('Enter');
    assert.equal(await page.evaluate(()=>!!map.nodes.a.image),true);
    await page.reload();await page.waitForLoadState('networkidle');
    await page.waitForFunction(()=>document.querySelector('[data-id=a] img')?.naturalWidth===32);
    assert.equal(await page.evaluate(()=>map.nodes.a.text),'画像を残して編集');
    const bundle=await page.evaluate(()=>NodeImageFormat.exportBundle(serializeMap(),imageStore));
    // Missing/corrupt/mismatched images never switch the current map.
    for(const damage of ['hash','mime','missing','extra','dimensions','invalid']) {
      assert.equal(await page.evaluate(async ({bundle,damage})=>{
        const original=JSON.stringify(map);const b=structuredClone(bundle), id=Object.keys(b.assets)[0];
        if(damage==='hash') {const wrong='sha256:'+'f'.repeat(64);b.assets[wrong]=b.assets[id];delete b.assets[id];for(const n of Object.values(b.map.nodes))if(n.image)n.image.assetId=wrong;}
        if(damage==='mime') b.assets[id].mime='image/jpeg';
        if(damage==='missing') delete b.assets[id];
        if(damage==='extra') b.assets['sha256:'+'b'.repeat(64)]=b.assets[id];
        if(damage==='dimensions') b.assets[id].width=31;
        if(damage==='invalid') b.assets[id].data='AAAA';
        try {importMap(await NodeImageFormat.importBundle(b,imageStore));return false;}catch{return JSON.stringify(map)===original;}
      },{bundle,damage}),true,damage);
    }
    // Actual file import is portable into a fresh browser storage context.
    const fresh=await browser.newContext({viewport:{width:768,height:1024},isMobile:true,hasTouch:true});
    const other=await fresh.newPage();other.on('pageerror',e=>errors.push(e.message));
    await other.goto(url);await other.waitForLoadState('networkidle');
    await other.locator('#fileInput').setInputFiles({name:'images.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))});
    await other.waitForFunction(()=>document.querySelector('[data-id=a] img')?.naturalWidth===32);
    await other.evaluate(()=>select('a'));
    await other.screenshot({path:'/tmp/mindmap-node-images-tablet.png'});
    await other.locator('[data-act=remove-image]').click();
    assert.equal(await other.evaluate(()=>!!map.nodes.a.image),false);
    await other.locator('#undo').click();await other.waitForFunction(()=>document.querySelector('[data-id=a] img')?.naturalWidth===32);
    await other.locator('#redo').click();assert.equal(await other.evaluate(()=>!!map.nodes.a.image),false);
    await other.locator('#undo').click();
    // Native IndexedDB transaction failures leave the map/history untouched.
    assert.equal(await other.evaluate(async () => {
      const before=JSON.stringify(map),h=history.length,original=imageStore.open.bind(imageStore);
      imageStore.open=async()=>({transaction(){throw new DOMException('quota','QuotaExceededError');}});
      try {const a=await original();const existing=await new Promise((r,j)=>{const q=a.transaction('assets').objectStore('assets').get(map.nodes.a.image.assetId);q.onsuccess=()=>r(q.result);q.onerror=j;});await attachNodeImage(existing.blob,{nodeId:'a',mapSessionId,revision},'置き換え');return false;}
      catch {return JSON.stringify(map)===before && history.length===h;}
      finally {imageStore.open=original;}
    }),true);
    // Same-byte dedupe and URL release use the real IndexedDB and browser decoder.
    assert.equal(await other.evaluate(async () => {
      const id=map.nodes.a.image.assetId;const a=await imageStore.get(id);
      const urls=await Promise.all([imageStore.acquire(id),imageStore.acquire(id)]);
      imageStore.release(id);imageStore.release(id);
      const wrong=new Blob([a.blob],{type:'image/jpeg'});
      try {await imageStore.put(wrong);return false;}catch {return urls[0]===urls[1];}
    }),true);
    // Broken local asset still leaves text editable inside a fixed frame.
    await other.evaluate(async () => {
      const db=await imageStore.open();await new Promise((r,j)=>{const tx=db.transaction('assets','readwrite');tx.objectStore('assets').clear();tx.oncomplete=r;tx.onerror=j;});
    });
    await other.reload();await other.waitForLoadState('networkidle');
    await other.waitForFunction(()=>document.querySelector('[data-id=a] .node__image span')?.textContent==='画像を読み込めません');
    assert.equal(await other.evaluate(()=>map.nodes.a.text),'画像を残して編集');
    assert.equal(await other.locator('[data-id=a] .node__image').evaluate(e=>e.offsetHeight),144);
    // Restoring the same bundle must recover failed DOM/URL entries immediately,
    // even though neither the node IDs nor the content hashes have changed.
    await other.locator('#fileInput').setInputFiles({name:'restore-images.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(bundle))});
    await other.waitForFunction(()=>document.querySelector('[data-id=a] img')?.naturalWidth===32);
    await other.waitForFunction(()=>document.querySelector('[data-id=root] img')?.naturalWidth===32);
    assert.equal(await other.locator('[data-id=a] .node__image span').isVisible(),false);
    assert.deepEqual(errors,[]);
    console.log('Browser checks passed: IndexedDB, reload, portable JSON, validation failures, editing, Undo/Redo, tablet layout, missing assets and bundle recovery.');
  } finally {
    await browser?.close(); service.close();server.closeAllConnections();await new Promise(r=>server.close(r));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
