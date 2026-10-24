/* Maps on RxDB. The app sees plain map objects and never touches RxDB itself. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../images/format.js') : root.NodeImageFormat);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapLibrary = api;
})(globalThis, F => {
  'use strict';
  const LEGACY = 'mindmap-proto:v1';
  const time = { type: 'number', minimum: 0, maximum: 1e15, multipleOf: 1 };
  const schema = {
    version: 0, primaryKey: 'id', type: 'object',
    properties: {
      id: { type: 'string', maxLength: 32 }, version: { type: 'integer' }, title: { type: 'string' }, root: { type: 'string' },
      seq: { type: 'integer' }, nodes: { type: 'object' }, cursor: { type: 'integer' }, createdAt: time, updatedAt: time,
    },
    required: ['id', 'version', 'title', 'root', 'seq', 'nodes', 'cursor', 'createdAt', 'updatedAt'],
    indexes: ['updatedAt'],
  };
  const newId = () => 'm_' + [...crypto.getRandomValues(new Uint8Array(12))].map(n => n.toString(16).padStart(2, '0')).join('');
  const toMap = doc => { const { version, title, root, seq, nodes } = doc.toJSON(); return JSON.parse(JSON.stringify({ version, title, root, seq, nodes })); };
  const summary = doc => ({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt });
  class Library {
    constructor(db) { this.db = db; this.maps = db.maps; }
    newest() { return this.maps.find({ sort: [{ updatedAt: 'desc' }] }); }
    async create(map) {
      const m = F.migrate(map), id = newId(), now = Date.now();
      await this.maps.insert({ id, ...m, cursor: 0, createdAt: now, updatedAt: now });
      return id;
    }
    async load(id) {
      const doc = await this.maps.findOne(id).exec(), m = doc && toMap(doc);
      return m && F.validMap(m) ? F.migrate(m) : null;
    }
    async save(id, map) {
      const m = F.migrate(map), doc = await this.maps.findOne(id).exec();
      if (!doc) throw new Error('マップが見つかりません');
      await doc.incrementalPatch({ ...m, updatedAt: Date.now() });
    }
    async remove(id) { await (await this.maps.findOne(id).exec())?.remove(); }
    async list() { return (await this.newest().exec()).map(summary); }
    watchList(fn) { const s = this.newest().$.subscribe(docs => fn(docs.map(summary))); return () => s.unsubscribe(); }
    watch(id, fn) { const s = this.maps.findOne(id).$.subscribe(doc => fn(doc && toMap(doc))); return () => s.unsubscribe(); }
    async migrateLegacy(storage) {
      const raw = storage.getItem(LEGACY);
      if (raw === null || await this.maps.findOne().exec()) return null;
      let m; try { m = JSON.parse(raw); } catch { return null; }
      if (!F.validMap(m)) return null;
      const id = await this.create(m);
      storage.removeItem(LEGACY);
      return id;
    }
    close() { return this.db.close(); }
  }
  async function open({ createRxDatabase, storage, name = 'mindmap', ...options }) {
    const db = await createRxDatabase({ name, storage, ...options });
    await db.addCollections({ maps: { schema } });
    return new Library(db);
  }
  return { open, schema, LEGACY };
});
