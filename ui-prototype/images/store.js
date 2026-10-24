(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./format.js') : root.NodeImageFormat);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NodeImageStore = api;
})(globalThis, F => {
  'use strict';
  function sniff(b) {
    if (b.length >= 24 && [137,80,78,71,13,10,26,10].every((n, i) => b[i] === n)) return 'image/png';
    if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
    if (b.length >= 12 && String.fromCharCode(...b.slice(0,4)) === 'RIFF' && String.fromCharCode(...b.slice(8,12)) === 'WEBP') return 'image/webp';
    throw new Error('PNG・JPEG・WebPの画像が必要です');
  }
  function declaredSize(b, mime) {
    const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
    if (mime === 'image/png') {
      if (String.fromCharCode(...b.slice(12,16)) !== 'IHDR') throw new Error('PNGの形式が正しくありません');
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
    throw new Error('画像の寸法を読み取れません');
  }
  async function verify(blob, expected = {}) {
    if (!(blob instanceof Blob) || !blob.size || blob.size > F.MAX_IMAGE) throw new Error('画像は1枚10MiBまでです');
    const bytes = new Uint8Array(await blob.arrayBuffer()), mime = sniff(bytes);
    if (blob.type !== mime || (expected.mime && expected.mime !== mime)) throw new Error('画像のMIMEが一致しません');
    // Check declared canvas dimensions before decoding potentially oversized input.
    if (!F.dimensions(...declaredSize(bytes, mime))) throw new Error('画像は4096×4096以内です');
    let decoded;
    try { decoded = await createImageBitmap(blob); } catch { throw new Error('画像をデコードできません'); }
    const { width, height } = decoded; decoded.close();
    if (!F.dimensions(width, height)) throw new Error('画像は4096×4096以内です');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    const assetId = 'sha256:' + [...digest].map(n => n.toString(16).padStart(2, '0')).join('');
    if ((expected.assetId && expected.assetId !== assetId) || (expected.width !== undefined && expected.width !== width) || (expected.height !== undefined && expected.height !== height)) throw new Error('画像のハッシュ・寸法が一致しません');
    return { assetId, blob, mime, width, height, createdAt: Date.now() };
  }
  class Store {
    constructor({ indexedDB = globalThis.indexedDB, name = 'mindmap-images' } = {}) { this.indexedDB = indexedDB; this.name = name; this.urls = new Map(); }
    verify(blob, expected) { return verify(blob, expected); }
    open() {
      if (!this.opening) this.opening = new Promise((resolve, reject) => {
        if (!this.indexedDB) { reject(new Error('このブラウザでは画像を保存できません')); return; }
        const req = this.indexedDB.open(this.name, 1); let blocked = false;
        req.onupgradeneeded = () => req.result.createObjectStore('assets', { keyPath: 'assetId' });
        req.onerror = () => reject(new Error('画像ストアを開けません'));
        req.onblocked = () => { blocked = true; reject(new Error('別のタブを閉じて再試行してください')); };
        req.onsuccess = () => { const db = req.result; if (blocked) { db.close(); return; } db.onversionchange = () => { db.close(); this.opening = null; }; resolve(db); };
      }).catch(error => { this.opening = null; throw error; });
      return this.opening;
    }
    async get(id) {
      if (!F.assetId(id)) throw new Error('画像IDが正しくありません');
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readonly'), req = tx.objectStore('assets').get(id);
        tx.oncomplete = () => resolve(req.result);
        tx.onerror = tx.onabort = () => reject(new Error('画像を読み込めません'));
      });
    }
    async putMany(assets) {
      // Revalidate at the storage boundary; callers cannot forge trusted metadata.
      const verified = await Promise.all(assets.map(a => verify(a.blob, a)));
      if (!verified.length) return;
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction('assets', 'readwrite'), table = tx.objectStore('assets');
        let capacity = false;
        const req = table.getAll();
        req.onsuccess = () => {
          const existing = new Map(req.result.map(a => [a.assetId, a]));
          for (const a of verified) if (!existing.has(a.assetId)) existing.set(a.assetId, a);
          if ([...existing.values()].reduce((sum, a) => sum + a.blob.size, 0) > F.MAX_TOTAL) { capacity = true; tx.abort(); return; }
          for (const a of verified) if (!req.result.some(old => old.assetId === a.assetId)) table.put(a);
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(new Error(capacity ? '画像の総容量は50MiBまでです。画像込みで書き出してください' : '画像を保存できません。ブラウザの空き容量を確認してください'));
      });
    }
    async put(blob, expected) { const a = await verify(blob, expected); await this.putMany([a]); return a; }
    acquire(id) {
      let entry = this.urls.get(id);
      if (!entry) {
        entry = { refs: 0 };
        entry.promise = this.get(id).then(async a => {
          if (!a) throw new Error('画像を読み込めません');
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
    close() { for (const [id, e] of this.urls) { e.refs = 1; this.release(id); } this.opening?.then(db => db.close()).catch(() => {}); this.opening = null; }
    // Automatic GC is intentionally disabled until cross-tab references are tracked.
  }
  return { Store, verify };
});
