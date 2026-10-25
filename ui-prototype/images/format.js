/* Shared map/reference validation; image bytes never belong in a map snapshot. */
(function (root, factory) {
  const api = typeof module === 'object' && module.exports ? factory(require('../i18n.js'), require('./privacy.js')) : factory(root.I18n, root.ImagePrivacy);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NodeImageFormat = api;
})(globalThis, (I18n, Privacy) => {
  'use strict';
  const tr = I18n.t;
  const MAX_IMAGE = 10 * 1024 * 1024, MAX_TOTAL = 50 * 1024 * 1024, MAX_FILE = 75 * 1024 * 1024;
  const MAX_NODES = 2048, MAX_DEPTH = 64, MAX_TEXT = 4000, MAX_TITLE = 1000, MAX_TOTAL_TEXT = 262144, MAX_ID = 160;
  const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const assetId = v => typeof v === 'string' && /^sha256:[a-f0-9]{64}$/.test(v);
  const dimensions = (w, h) => Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0 && w <= 4096 && h <= 4096 && w * h <= 16777216;
  const mime = v => ['image/png', 'image/jpeg', 'image/webp'].includes(v);
  function validReference(v) {
    return record(v) && Object.keys(v).length === 4 && assetId(v.assetId) && typeof v.alt === 'string' && v.alt.length <= 4000 && dimensions(v.width, v.height);
  }
  function mapError(m) {
    if (!record(m) || Object.keys(m).some(k => !['version', 'title', 'root', 'seq', 'nodes'].includes(k)) || ![1, 2].includes(m.version) || typeof m.title !== 'string' || typeof m.root !== 'string' || !m.root || !record(m.nodes) ||
        !Number.isSafeInteger(m.seq) || m.seq < 0 || m.seq >= Number.MAX_SAFE_INTEGER || !Object.hasOwn(m.nodes, m.root)) return tr('map.invalid');
    const entries = Object.entries(m.nodes);
    if (entries.length > MAX_NODES) return tr('map.nodeLimit');
    if (m.title.length > MAX_TITLE) return tr('map.titleLimit');
    let totalText = m.title.length;
    for (const [id, n] of entries) {
      if (!id || id.length > MAX_ID || !record(n) || Object.keys(n).some(k => !['id', 'text', 'parent', 'x', 'y', 'order', 'image'].includes(k)) || n.id !== id || typeof n.text !== 'string' || !Number.isFinite(n.x) || !Number.isFinite(n.y) ||
          !Number.isSafeInteger(n.order) || n.order < 0 || n.order > m.seq) return tr('map.invalid');
      if (n.text.length > MAX_TEXT) return tr('map.textLimit');
      if (Object.hasOwn(n, 'image') && (m.version !== 2 || !validReference(n.image))) return tr('map.invalid');
      totalText += n.text.length + (n.image?.alt.length || 0);
      if (totalText > MAX_TOTAL_TEXT) return tr('map.totalTextLimit');
      if (id === m.root ? n.parent !== null : typeof n.parent !== 'string' || !Object.hasOwn(m.nodes, n.parent)) return tr('map.invalid');
    }
    const depths = new Map([[m.root, 0]]);
    for (const [id] of entries) {
      const path = new Set(); let cur = id;
      while (!depths.has(cur)) {
        if (path.has(cur)) return tr('map.invalid');
        path.add(cur); cur = m.nodes[cur].parent;
        if (path.size > MAX_DEPTH) return tr('map.depthLimit');
      }
      let depth = depths.get(cur);
      if (depth + path.size > MAX_DEPTH) return tr('map.depthLimit');
      for (const key of [...path].reverse()) depths.set(key, ++depth);
    }
    return null;
  }
  const validMap = m => mapError(m) === null;
  function migrate(map) {
    const error = mapError(map); if (error) throw new Error(error);
    const copy = JSON.parse(JSON.stringify(map)); copy.version = 2; return copy;
  }
  function references(map) {
    if (!validMap(map)) throw new Error(tr('map.invalid'));
    const refs = new Map();
    for (const n of Object.values(map.nodes)) if (n.image) {
      const old = refs.get(n.image.assetId);
      if (old && (old.width !== n.image.width || old.height !== n.image.height)) throw new Error(tr('image.sizeMismatch'));
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
    if (typeof value !== 'string' || value.length > Math.ceil(MAX_IMAGE / 3) * 4 || value.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error(tr('image.invalidData'));
    return Uint8Array.from(atob(value), c => c.charCodeAt(0));
  }
  async function exportBundle(map, store, { sanitize = Privacy.clean } = {}) {
    const snapshot = migrate(map), refs = references(snapshot);
    if (!refs.size) return snapshot;
    const assets = {}, replacements = new Map(); let total = 0;
    for (const [id, ref] of refs) {
      const asset = await store.get(id);
      if (!asset) throw new Error(tr('image.exportMissing'));
      await store.verify(asset.blob, { ...ref, mime: asset.mime });
      const blob = await sanitize(asset.blob);
      const clean = blob === asset.blob ? { ...ref, blob, mime: asset.mime } : await store.verify(blob, { width: ref.width, height: ref.height, mime: blob.type });
      replacements.set(id, clean.assetId);
      if (Object.hasOwn(assets, clean.assetId)) continue;
      total += blob.size;
      if (total > MAX_TOTAL) throw new Error(tr('image.totalLimit'));
      assets[clean.assetId] = { mime: clean.mime, width: ref.width, height: ref.height, data: base64(new Uint8Array(await blob.arrayBuffer())) };
    }
    for (const n of Object.values(snapshot.nodes)) if (n.image) n.image.assetId = replacements.get(n.image.assetId);
    return { format: 'mindmap-bundle', version: 1, map: snapshot, assets };
  }
  async function importBundle(value, store) {
    if (!record(value) || value.format !== 'mindmap-bundle') {
      const map = migrate(value);
      if (references(map).size) throw new Error(tr('bundle.required'));
      return map;
    }
    if (value.version !== 1 || !record(value.assets) || value.map?.version !== 2) throw new Error(tr('bundle.invalid'));
    const map = migrate(value.map), refs = references(map), keys = Object.keys(value.assets);
    if (keys.length !== refs.size || keys.some(id => !refs.has(id))) throw new Error(tr('bundle.mismatch'));
    const pending = []; let total = 0;
    for (const [id, ref] of refs) {
      const a = value.assets[id];
      if (!record(a) || !mime(a.mime) || a.width !== ref.width || a.height !== ref.height) throw new Error(tr('bundle.assetInvalid'));
      const bytes = unbase64(a.data); total += bytes.length;
      if (total > MAX_TOTAL) throw new Error(tr('image.totalLimit'));
      pending.push(await store.verify(new Blob([bytes], { type: a.mime }), { ...ref, mime: a.mime }));
    }
    await store.putMany(pending);
    return map;
  }
  return { MAX_IMAGE, MAX_TOTAL, MAX_FILE, MAX_NODES, MAX_DEPTH, MAX_TEXT, MAX_TITLE, MAX_TOTAL_TEXT, assetId, dimensions, mime, validReference, mapError, validMap, migrate, references, exportBundle, importBundle };
});
