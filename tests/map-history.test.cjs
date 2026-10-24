const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRxDatabase, addRxPlugin } = require('rxdb');
const { getRxStorageMemory } = require('rxdb/plugins/storage-memory');
const { wrappedValidateAjvStorage } = require('rxdb/plugins/validate-ajv');
const { RxDBDevModePlugin, disableWarnings } = require('rxdb/plugins/dev-mode');
const H = require('../ui-prototype/storage/history.js');
const MapLibrary = require('../ui-prototype/storage/library.js');
const Ops = require('../ui-prototype/instructions/operations.js');

disableWarnings(); addRxPlugin(RxDBDevModePlugin);
const clone = v => JSON.parse(JSON.stringify(v));
const base = () => ({ version: 2, title: '週末', root: 'r', seq: 2, nodes: {
  r: { id: 'r', text: '中心', parent: null, x: 0, y: 0, order: 0 },
  a: { id: 'a', text: 'A', parent: 'r', x: 200, y: 0, order: 1 },
  a1: { id: 'a1', text: 'A1', parent: 'a', x: 400, y: 0, order: 2 },
} });
// Builds entries the way index.html does: one per committed change.
function chain(start, edits) {
  let map = clone(start), prev = 0, seq = 0; const entries = [];
  for (const edit of edits) {
    const before = clone(map); edit(map);
    const e = { seq: ++seq, prev, at: seq, ...H.diff(before, map) }; entries.push(e); prev = e.seq;
  }
  return { map, entries };
}
const edits = [
  m => { Ops.addNode(m, 'r', '新しい'); },
  m => { m.nodes.a.text = '変更'; },
  m => { for (const id of ['a', 'a1']) m.nodes[id].x += 30; },
  m => { m.nodes.a1.parent = 'r'; m.nodes.a1.order = ++m.seq; },
  m => { delete m.nodes.a1; delete m.nodes.a; },
  m => { m.title = '新しい名前'; },
];

test('each diff reproduces the state after it and, undone, the state before it', () => {
  let map = base();
  for (const edit of edits) {
    const before = clone(map); edit(map);
    const e = H.diff(before, map);
    assert.equal(H.same(H.apply(before, e, 'after'), map), true);
    assert.equal(H.same(H.apply(map, e, 'before'), before), true);
    assert.equal(Ops.valid(H.apply(map, e, 'before')), true);
  }
  assert.deepEqual(H.diff(base(), base()), { before: { meta: {}, nodes: {} }, after: { meta: {}, nodes: {} } });
});

test('verification keeps the consistent undo and redo chains and discards the rest without touching the map', () => {
  const { map, entries } = chain(base(), edits);
  const at = 4; let current = map;
  for (const e of entries.slice(at).reverse()) current = H.apply(current, e, 'before');
  const kept = clone(current), r = H.verify(current, at, entries);
  assert.deepEqual(r.undo.map(e => e.seq), [1, 2, 3, 4]);
  assert.deepEqual(r.redo.map(e => e.seq), [5, 6]);
  assert.deepEqual(r.discard, []);
  assert.deepEqual(current, kept);
  // An after that does not match the map stops the undo chain there.
  const broken = clone(entries); broken[2].after.nodes.a.x = 9999;
  assert.deepEqual(H.verify(current, at, broken).undo.map(e => e.seq), [4]);
  // A missing prev entry stops the chain; orphans are discarded.
  const missing = entries.filter(e => e.seq !== 2);
  const m = H.verify(current, at, missing);
  assert.deepEqual([m.undo.map(e => e.seq), m.discard], [[3, 4], [1]]);
  // A cursor without an entry keeps nothing on the undo side.
  assert.deepEqual(H.verify(current, 42, entries).undo, []);
  // Of competing redo branches, the newer one wins if it matches.
  const branch = { seq: 7, prev: 4, at: 7, ...H.diff(current, { ...clone(current), title: '別の枝' }) };
  const b = H.verify(current, at, [...entries, branch]);
  assert.deepEqual([b.redo.map(e => e.seq), b.discard], [[7], [5, 6]]);
});

test('images referenced only by history entries are reported', () => {
  const ref = { assetId: 'sha256:' + 'a'.repeat(64), alt: '', width: 1, height: 1 };
  const before = base(), after = clone(before); after.nodes.a.image = ref;
  assert.deepEqual(H.references({ seq: 1, prev: 0, at: 0, ...H.diff(before, after) }), [ref.assetId]);
});

let names = 0;
const open = () => MapLibrary.open({ createRxDatabase, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }), name: 'history' + ++names, ignoreDuplicate: true });

for (const [step, expect] of [[1, { undo: [1], redo: [] }], [2, { undo: [1], redo: [2] }], [3, { undo: [1, 2], redo: [] }]]) {
  test(`a save interrupted after step ${step} reopens to a complete map with a consistent history`, async () => {
    const lib = await open(), id = await lib.create(base());
    const { map: m1, entries: [e1] } = chain(base(), [edits[1]]);
    await lib.save(id, m1, { cursor: 1, put: [e1] });
    const m2 = clone(m1); edits[2](m2);
    const e2 = { seq: 2, prev: 1, at: 2, ...H.diff(m1, m2) };
    const stale = { seq: 9, prev: 0, at: 9, ...H.diff(base(), { ...base(), title: '捨てた枝' }) };
    await lib.save(id, m1, { put: [stale] });
    // Steps: 1 drop history, 2 add history, 3 write the map with its cursor.
    const real = { bulkRemove: lib.history.bulkRemove.bind(lib.history), bulkUpsert: lib.history.bulkUpsert.bind(lib.history) };
    const stop = () => { throw new Error('interrupted'); };
    if (step === 1) lib.history.bulkUpsert = stop;
    const findOne = lib.maps.findOne.bind(lib.maps);
    if (step === 2) lib.maps.findOne = () => ({ exec: async () => ({ incrementalPatch: stop }) });
    const write = lib.save(id, m2, { cursor: 2, put: [e2], drop: [9] });
    if (step < 3) await assert.rejects(write, /interrupted/); else await write;
    Object.assign(lib.history, real); lib.maps.findOne = findOne;
    const map = await lib.load(id), log = await lib.log(id), r = H.verify(map, log.cursor, log.entries);
    assert.equal(Ops.valid(map), true);
    assert.equal(H.same(map, step === 3 ? m2 : m1), true);
    assert.deepEqual({ undo: r.undo.map(e => e.seq), redo: r.redo.map(e => e.seq) }, expect);
    assert.equal(log.entries.some(e => e.seq === 9), false);
    await lib.close();
  });
}

test('removing a map removes its history', async () => {
  const lib = await open(), id = await lib.create(base()), keep = await lib.create(base());
  const { map, entries } = chain(base(), edits.slice(0, 2));
  await lib.save(id, map, { cursor: 2, put: entries });
  await lib.save(keep, map, { cursor: 2, put: entries });
  await lib.remove(id);
  assert.deepEqual((await lib.log(id)).entries, []);
  assert.equal((await lib.log(keep)).entries.length, 2);
  await lib.close();
});
