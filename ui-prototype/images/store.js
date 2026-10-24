(function (root, factory) {
  const api = typeof module === 'object' && module.exports ? factory(require('./format.js'), require('../i18n.js')) : factory(root.NodeImageFormat, root.I18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NodeImageStore = api;
})(globalThis, (F, I18n) => {
  'use strict';
  const tr = I18n.t;
  function sniff(b) {
    if (b.length >= 24 && [137,80,78,71,13,10,26,10].every((n, i) => b[i] === n)) return 'image/png';
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if (b.length >= 12 && String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP') return 'image/webp';
    throw new Error(tr('image.formatRequired'));
  }
  function declaredSize(b, mime) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (mime === 'image/png') {
      if (String.fromCharCode(...b.slice(12,16)) !== 'IHDR') throw new Error(tr('image.badPng'));
      return [v.getUint32(16), v.getUint32(20)];
    }
    if (mime === 'image/jpeg') {
      let i = 2;
      while (i + 4 <= b.length) {
        if (b[i++] !== 255) break;
        while (b[i] === 255) i++;
        const marker = b[i++];
        if (marker === 217 || marker === 218) break;
        if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
        if (i + 2 > b.length) break;
        const length = v.getUint16(i);
        if (length < 2 || i + length > b.length) break;
        if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker) && length >= 8) return [v.getUint16(i+5), v.getUint16(i+3)];
        i += length;
      }
    } else {
      const kind = String.fromCharCode(...b.slice(12,16));
      if (kind === 'VP8X' && b.length >= 30) return [1+b[24]+(b[25]<<8)+(b[26]<<16), 1+b[27]+(b[28]<<8)+(b[29]<<16)];
      if (kind === 'VP8L' && b.length >= 25 && b[20] === 47) return [1+b[21]+((b[22]&63)<<8), 1+(b[22]>>6)+(b[23]<<2)+((b[24]&15)<<10)];
      if (kind === 'VP8 ' && b.length >= 30 && b[23] === 157 && b[24] === 1 && b[25] === 42) return [v.getUint16(26,true)&16383, v.getUint16(28,true)&16383];
    }
    throw new Error(tr('image.noDimensions'));
  }
  async function verify(blob, expected = {}) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > F.MAX_IMAGE) throw new Error(tr('image.tooLarge'));
    const bytes = new Uint8Array(await blob.arrayBuffer()), mime = sniff(bytes);
    if (blob.type !== mime || (expected.mime && expected.mime !== mime)) throw new Error(tr('image.mimeMismatch'));
    // Check declared canvas dimensions before decoding potentially oversized input.
    if (!F.dimensions(...declaredSize(bytes, mime))) throw new Error(tr('image.maxDimensions'));
    let decoded;
    try { decoded = await createImageBitmap(blob); } catch { throw new Error(tr('image.decodeFailed')); }
    const { width, height } = decoded; decoded.close();
    if (!F.dimensions(width, height)) throw new Error(tr('image.maxDimensions'));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const assetId = 'sha256:' + [...digest].map(n => n.toString(16).padStart(2, '0')).join('');
    if ((expected.assetId && expected.assetId !== assetId) || (expected.width !== undefined && expected.width !== width) || (expected.height !== undefined && expected.height !== height)) throw new Error(tr('image.hashMismatch'));
    return { assetId, blob, mime, width, height, createdAt: Date.now() };
  }
  const DAY = 24 * 60 * 60 * 1000;
  const fileName = id => id.slice('sha256:'.length);
  function workerWriter(url) {
    let worker, next = 0; const pending = new Map();
    return (message, transfer) => {
      if (!worker) {
        worker = new Worker(url);
        worker.onmessage = ({ data }) => { const p = pending.get(data.id); pending.delete(data.id); data.ok ? p.resolve() : p.reject(new Error(data.error)); };
        worker.onerror = () => { for (const p of pending.values()) p.reject(new Error(tr('image.saveFailed'))); pending.clear(); worker = null; };
      }
      const id = ++next;
      return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); worker.postMessage({ ...message, id }, transfer); });
    };
  }
  // Image bytes live in OPFS as /images/<sha256 hex>. Writes go through a
  // Worker because createSyncAccessHandle() is the write API every engine has.
  class Store {
    constructor({ directory, send = workerWriter('images/opfs-worker.js') } = {}) {
      this.directory = directory || (async () => {
        if (!globalThis.navigator?.storage?.getDirectory) throw new Error(tr('image.unsupported'));
        return (await navigator.storage.getDirectory()).getDirectoryHandle('images', { create: true });
      });
      this.send = send; this.urls = new Map();
    }
    verify(blob, expected) { return verify(blob, expected); }
    async files() {
      const dir = await this.directory(), out = new Map();
      for await (const handle of dir.values()) if (handle.kind === 'file' && /^[a-f0-9]{64}$/.test(handle.name)) out.set('sha256:' + handle.name, await handle.getFile());
      return out;
    }
    async get(id) {
      if (!F.assetId(id)) throw new Error(tr('image.badId'));
      let file;
      try { file = await (await (await this.directory()).getFileHandle(fileName(id))).getFile(); }
      catch (error) { if (error?.name === 'NotFoundError') return undefined; throw new Error(tr('image.loadFailed')); }
      let mime = '';
      try { mime = sniff(new Uint8Array(await file.slice(0, 32).arrayBuffer())); } catch {}
      return { assetId: id, mime, blob: new Blob([file], { type: mime }) };
    }
    async putMany(assets) {
      // Revalidate at the storage boundary; callers cannot forge trusted metadata.
      const verified = await Promise.all(assets.map(a => verify(a.blob, a)));
      if (!verified.length) return;
      const incoming = new Map(verified.map(a => [a.assetId, a]));
      // Count the verified replacement bytes, including when an existing file
      // is corrupt. The content hash still identifies one asset.
      const sizes = new Map([...await this.files()].map(([id, f]) => [id, f.size]));
      for (const [id, a] of incoming) sizes.set(id, a.blob.size);
      if ([...sizes.values()].reduce((sum, n) => sum + n, 0) > F.MAX_TOTAL) throw new Error(tr('image.totalLimitExport'));
      try {
        // Rewriting validated bytes lets a portable bundle repair local
        // corruption without changing references or adding another asset.
        for (const a of incoming.values()) {
          const bytes = await a.blob.arrayBuffer();
          await this.send({ op: 'write', name: fileName(a.assetId), bytes }, [bytes]);
        }
      } catch { throw new Error(tr('image.saveSpace')); }
    }
    async put(blob, expected) { const a = await verify(blob, expected); await this.putMany([a]); return a; }
    async gc(referenced, now = Date.now()) {
      let removed = 0;
      for (const [id, file] of await this.files()) {
        if (referenced.has(id) || now - file.lastModified < DAY) continue;
        await this.send({ op: 'remove', name: fileName(id) }); removed++;
      }
      return removed;
    }
    // Copies verified images out of the old IndexedDB store, then drops it.
    async migrate(legacy) {
      const records = await legacy.records();
      if (!records) return null;
      const good = [], broken = [];
      for (const r of records) { try { good.push(await verify(r.blob, r)); } catch { broken.push(r.assetId); } }
      await this.putMany(good);
      await legacy.drop();
      return { moved: good.length, broken: broken.length };
    }
    acquire(id) {
      let entry = this.urls.get(id);
      if (!entry) {
        entry = { refs: 0 };
        entry.promise = this.get(id).then(async a => {
          if (!a) throw new Error(tr('image.loadFailed'));
          await verify(a.blob, { ...a, assetId: id });
          const url = URL.createObjectURL(a.blob);
          if (entry.refs) entry.url = url; else URL.revokeObjectURL(url);
          return url;
        });
        this.urls.set(id, entry);
      }
      entry.refs++; return entry.promise;
    }
    release(id) {
      const e = this.urls.get(id); if (!e) return;
      if (--e.refs <= 0) { if (e.url) URL.revokeObjectURL(e.url); this.urls.delete(id); }
    }
    close() { for (const [id, e] of this.urls) { e.refs = 1; this.release(id); } }
  }
  function indexedDBLegacy(indexedDB = globalThis.indexedDB, name = 'mindmap-images') {
    const request = r => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); r.onblocked = () => reject(new Error(tr('image.closeTabs'))); });
    return {
      async records() {
        if (!indexedDB?.databases || !(await indexedDB.databases()).some(d => d.name === name)) return null;
        const db = await request(indexedDB.open(name));
        try { return db.objectStoreNames.contains('assets') ? await request(db.transaction('assets').objectStore('assets').getAll()) : []; }
        finally { db.close(); }
      },
      drop: () => request(indexedDB.deleteDatabase(name)),
    };
  }
  return { Store, verify, indexedDBLegacy, DAY };
});
