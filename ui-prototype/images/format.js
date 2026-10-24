/* Shared map/reference validation; image bytes never belong in a map snapshot. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NodeImageFormat = api;
})(globalThis, () => {
  'use strict';
  const MAX_IMAGE = 10 * 1024 * 1024, MAX_TOTAL = 50 * 1024 * 1024, MAX_FILE = 75 * 1024 * 1024;
  const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const assetId = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
  const dimensions = (w, h) => Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096 && w * h <= 16777216;
  const mime = v => ['image/png', 'image/jpeg', 'image/webp'].includes(v);
  function validReference(v) {
    return record(v) && Object.keys(v).length === 4 && assetId(v.assetId) && typeof v.alt === 'string' && v.alt.length <= 4000 && dimensions(v.width, v.height);
  }
  function validMap(m) {
    if (!record(m) || Object.keys(m).some(k => !['version', 'title', 'root', 'seq', 'nodes'].includes(k)) || ![1, 2].includes(m.version) || typeof m.title !== 'string' || typeof m.root !== 'string' || !m.root || !record(m.nodes) ||
        !Number.isSafeInteger(m.seq) || m.seq < 0 || m.seq >= Number.MAX_SAFE_INTEGER || !Object.hasOwn(m.nodes, m.root)) return false;
    for (const [id, n] of Object.entries(m.nodes)) {
      if (!id || !record(n) || Object.keys(n).some(k => !['id', 'text', 'parent', 'x', 'y', 'order', 'image'].includes(k)) || n.id !== id || typeof n.text !== 'string' || !Number.isFinite(n.x) || !Number.isFinite(n.y) ||
          !Number.isSafeInteger(n.order) || n.order < 0 || n.order > m.seq) return false;
      if (Object.hasOwn(n, 'image') && (m.version !== 2 || !validReference(n.image))) return false;
      if (id === m.root ? n.parent !== null : typeof n.parent !== 'string' || !Object.hasOwn(m.nodes, n.parent)) return false;
    }
    const reached = new Set([m.root]);
    for (const id of Object.keys(m.nodes)) {
      const path = new Set(); let cur = id;
      while (!reached.has(cur)) { if (path.has(cur)) return false; path.add(cur); cur = m.nodes[cur].parent; }
      for (const key of path) reached.add(key);
    }
    return true;
  }
  function migrate(map) {
    if (!validMap(map)) throw new Error('マップの形式が正しくありません');
    const copy = JSON.parse(JSON.stringify(map)); copy.version = 2; return copy;
  }
  function references(map) {
    if (!validMap(map)) throw new Error('マップの形式が正しくありません');
    const refs = new Map();
    for (const n of Object.values(map.nodes)) if (n.image) {
      const old = refs.get(n.image.assetId);
      if (old && (old.width !== n.image.width || old.height !== n.image.height)) throw new Error('画像の寸法が一致しません');
      refs.set(n.image.assetId, n.image);
    }
    return refs;
  }
  function base64(bytes) {
    let value = '';
    for (let i = 0; i < bytes.length; i += 32768) value += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return btoa(value);
  }
  function unbase64(value) {
    // A repeated four-character regex over a 10MiB image can overflow V8's stack.
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error('画像データが正しくありません');
    return Uint8Array.from(atob(value), c => c.charCodeAt(0));
  }
  async function exportBundle(map, store) {
    const snapshot = migrate(map), refs = references(snapshot);
    if (!refs.size) return snapshot;
    const assets = {}; let total = 0;
    for (const [id, ref] of refs) {
      const asset = await store.get(id);
      if (!asset) throw new Error('画像を読み込めません。画像込みで書き出せませんでした');
      await store.verify(asset.blob, { ...ref, mime: asset.mime });
      total += asset.blob.size;
      if (total > MAX_TOTAL) throw new Error('画像の総容量は50MiBまでです');
      assets[id] = { mime: asset.mime, width: ref.width, height: ref.height, data: base64(new Uint8Array(await asset.blob.arrayBuffer())) };
    }
    return { format: 'mindmap-bundle', version: 1, map: snapshot, assets };
  }
  async function importBundle(value, store) {
    if (!record(value) || value.format !== 'mindmap-bundle') {
      const map = migrate(value);
      if (references(map).size) throw new Error('画像付きbundleが必要です');
      return map;
    }
    if (value.version !== 1 || !record(value.assets) || value.map?.version !== 2) throw new Error('bundleの形式が正しくありません');
    const map = migrate(value.map), refs = references(map), keys = Object.keys(value.assets);
    if (keys.length !== refs.size || keys.some(id => !refs.has(id))) throw new Error('画像の過不足があります');
    const pending = []; let total = 0;
    for (const [id, ref] of refs) {
      const a = value.assets[id];
      if (!record(a) || !mime(a.mime) || a.width !== ref.width || a.height !== ref.height) throw new Error('画像の形式・寸法が正しくありません');
      const bytes = unbase64(a.data); total += bytes.length;
      if (total > MAX_TOTAL) throw new Error('画像の総容量は50MiBまでです');
      pending.push(await store.verify(new Blob([bytes], { type: a.mime }), { ...ref, mime: a.mime }));
    }
    await store.putMany(pending);
    return map;
  }
  return { MAX_IMAGE, MAX_TOTAL, MAX_FILE, assetId, dimensions, mime, validReference, validMap, migrate, references, exportBundle, importBundle };
});
