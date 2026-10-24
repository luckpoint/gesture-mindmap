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
  const side = { type: 'object', properties: { meta: { type: 'object' }, nodes: { type: 'object' } }, required: ['meta', 'nodes'] };
  const historySchema = {
    version: 0, primaryKey: { key: 'id', fields: ['mapId', 'seq'], separator: '|' }, type: 'object',
    properties: {
      id: { type: 'string', maxLength: 64 }, mapId: { type: 'string', maxLength: 32 },
      seq: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER, multipleOf: 1 }, prev: { type: 'integer' }, at: time, before: side, after: side,
    },
    required: ['id', 'mapId', 'seq', 'prev', 'at', 'before', 'after'],
    indexes: [['mapId', 'seq']],
  };
  const entryOf = doc => { const { seq, prev, at, before, after } = doc.toJSON(); return JSON.parse(JSON.stringify({ seq, prev, at, before, after })); };
  const newId = () => 'm_' + [...crypto.getRandomValues(new Uint8Array(12))].map(n => n.toString(16).padStart(2, '0')).join('');
  const toMap = doc => { const { version, title, root, seq, nodes } = doc.toJSON(); return JSON.parse(JSON.stringify({ version, title, root, seq, nodes })); };
  const summary = doc => ({ id: doc.id, title: doc.title, updatedAt: doc.updatedAt });
  class Library {
    constructor(db) { this.db = db; this.maps = db.maps; this.history = db.history; }
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
    // Writes in the order history deletions, history additions, then the map
    // with its cursor, so an interrupted save leaves a map that is complete.
    async save(id, map, { cursor, put = [], drop = [] } = {}) {
      const m = F.migrate(map), doc = await this.maps.findOne(id).exec();
      if (!doc) throw new Error('マップが見つかりません');
      if (drop.length) await this.history.bulkRemove(drop.map(seq => id + '|' + seq));
      if (put.length) {
        const { error } = await this.history.bulkUpsert(put.map(e => ({ ...e, id: id + '|' + e.seq, mapId: id })));
        if (error.length) throw new Error('履歴を保存できません');
      }
      await doc.incrementalPatch({ ...m, ...(cursor === undefined ? {} : { cursor }), updatedAt: Date.now() });
    }
    async log(id) {
      const doc = await this.maps.findOne(id).exec();
      const entries = await this.history.find({ selector: { mapId: id }, sort: [{ seq: 'asc' }] }).exec();
      return { cursor: doc?.cursor ?? 0, entries: entries.map(entryOf) };
    }
    async remove(id) {
      await (await this.maps.findOne(id).exec())?.remove();
      await this.history.find({ selector: { mapId: id } }).remove();
    }
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
    await db.addCollections({ maps: { schema }, history: { schema: historySchema } });
    return new Library(db);
  }
  return { open, schema, LEGACY };
});
