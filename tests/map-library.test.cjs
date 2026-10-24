const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRxDatabase, addRxPlugin } = require('rxdb');
const { getRxStorageMemory } = require('rxdb/plugins/storage-memory');
const { wrappedValidateAjvStorage } = require('rxdb/plugins/validate-ajv');
const { RxDBDevModePlugin, disableWarnings } = require('rxdb/plugins/dev-mode');
const MapLibrary = require('../ui-prototype/storage/library.js');
const { valid, serialize } = require('../ui-prototype/instructions/operations.js');

disableWarnings(); addRxPlugin(RxDBDevModePlugin);
let names = 0;
const open = (name = 'test' + ++names) => MapLibrary.open({ createRxDatabase, storage: wrappedValidateAjvStorage({ storage: getRxStorageMemory() }), name, ignoreDuplicate: true });
const map = (title, text = '中心') => ({ version: 2, title, root: 'r', seq: 1, nodes: { r: { id: 'r', text, parent: null, x: 0, y: 0, order: 0 }, c: { id: 'c', text: '子', parent: 'r', x: 200, y: 0, order: 1 } } });
const storage = entries => { const s = new Map(Object.entries(entries)); return { s, getItem: k => s.get(k) ?? null, removeItem: k => s.delete(k) }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 50));

test('maps are created, listed newest first, saved, loaded and removed', async () => {
  const lib = await open();
  const a = await lib.create(map('A')); await tick();
  const b = await lib.create(map('B'));
  assert.deepEqual((await lib.list()).map(m => m.title), ['B', 'A']);
  await tick(); await lib.save(a, map('A2', '更新'));
  assert.deepEqual((await lib.list()).map(m => m.id), [a, b]);
  const loaded = await lib.load(a);
  assert.equal(valid(loaded), true);
  assert.deepEqual(serialize(loaded), map('A2', '更新'));
  assert.deepEqual(Object.keys(loaded).sort(), ['nodes', 'root', 'seq', 'title', 'version']);
  await lib.remove(a);
  assert.equal(await lib.load(a), null);
  assert.deepEqual((await lib.list()).map(m => m.id), [b]);
  await assert.rejects(lib.save(a, map('A')), /見つかりません/);
  await lib.close();
});

test('invalid maps are not stored', async () => {
  const lib = await open();
  await assert.rejects(lib.create({ ...map('x'), root: 'missing' }));
  assert.deepEqual(await lib.list(), []);
  await lib.close();
});

test('legacy localStorage migrates once; a failed write keeps the key', async () => {
  const lib = await open(), legacy = storage({ [MapLibrary.LEGACY]: JSON.stringify(map('古いマップ')) });
  const insert = lib.maps.insert;
  lib.maps.insert = async () => { throw new Error('quota'); };
  await assert.rejects(lib.migrateLegacy(legacy), /quota/);
  assert.equal(legacy.s.has(MapLibrary.LEGACY), true);
  lib.maps.insert = insert;
  const id = await lib.migrateLegacy(legacy);
  assert.equal((await lib.load(id)).title, '古いマップ');
  assert.equal(legacy.s.has(MapLibrary.LEGACY), false);
  legacy.s.set(MapLibrary.LEGACY, JSON.stringify(map('もう一度')));
  assert.equal(await lib.migrateLegacy(legacy), null);
  assert.equal((await lib.list()).length, 1);
  assert.equal(await lib.migrateLegacy(storage({ [MapLibrary.LEGACY]: '{' })), null);
  await lib.close();
});

test('a save in one instance reaches the subscriptions of another', async () => {
  const name = 'shared' + ++names, one = await open(name), two = await open(name);
  const lists = [], maps = [];
  const id = await one.create(map('共有'));
  const stopList = two.watchList(list => lists.push(list.map(m => m.title)));
  const stopMap = two.watch(id, m => maps.push(m?.nodes.r.text));
  await tick();
  await one.save(id, map('共有2', '別のタブ')); await tick();
  await one.remove(id); await tick();
  assert.deepEqual(lists.at(-2), ['共有2']);
  assert.deepEqual(lists.at(-1), []);
  assert.equal(maps.includes('別のタブ'), true);
  assert.equal(maps.at(-1), undefined);
  stopList(); stopMap(); await one.close(); await two.close();
});
