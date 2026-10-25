import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';
import { test } from 'node:test';
import { coreScripts, appScripts } from './helpers/app-scripts.cjs';
import * as Tree from '../ui-prototype/core/tree.js';
import * as Policy from '../ui-prototype/core/operation-policy.js';
import * as History from '../ui-prototype/core/history.js';
import diffs from '../ui-prototype/storage/history.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

const source = path => readFileSync(join(__dirname, '../ui-prototype', path), 'utf8');
const clone = value => JSON.parse(JSON.stringify(value));
function map() {
  return {
    version: 2,
    title: 'map',
    root: 'root',
    seq: 3,
    nodes: {
      root: { id: 'root', text: 'root', parent: null, order: 0, x: 0, y: 0 },
      a: { id: 'a', text: 'a', parent: 'root', order: 2, x: 100, y: 0 },
      b: { id: 'b', text: 'b', parent: 'root', order: 1, x: -100, y: 0 },
      c: { id: 'c', text: 'c', parent: 'a', order: 3, x: 200, y: 0 },
    },
  };
}
function history(options = {}) {
  const stacks = { history: [], future: [] };
  return { stacks, store: History.create({ stacks, diffs, now: () => 123, ...options }) };
}
function edit(store, before, text) {
  const after = clone(before);
  after.nodes.a.text = text;
  store.record(before, after);
  return after;
}

test('HTML uses one module entrypoint whose imports cover every core/app module', async () => {
  const tags = [...source('index.html').matchAll(/<script\b([^>]*)>/g)];
  assert.equal(tags.length, 1);
  assert.match(tags[0][1], /type="module"/);
  assert.match(tags[0][1], /src="app\/main.js"/);
  const { metafile } = await build({
    entryPoints: [join(__dirname, '../ui-prototype/app/main.js')],
    bundle: true,
    write: false,
    metafile: true,
    external: ['../vendor/rxdb.js'],
  });
  const paths = Object.keys(metafile.inputs)
    .map(path => path.split('ui-prototype/')[1])
    .filter(path => /^(core|app)\//.test(path));
  assert.deepEqual(paths.sort(), [...coreScripts, ...appScripts].sort());
});

function importWithoutEnvironment(paths) {
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `
    import assert from 'node:assert/strict';
    const before = Object.keys(globalThis);
    for (const path of ${JSON.stringify(paths)}) {
      const api = await import(new URL(path, ${JSON.stringify(new URL('../ui-prototype/', import.meta.url).href)}));
      assert.equal(typeof api.create, path === 'core/operation-policy.js' ? 'undefined' : 'function');
    }
    assert.deepEqual(Object.keys(globalThis), before);
    assert.equal(globalThis.document, undefined);
    assert.equal(globalThis.state, undefined);
  `,
  ]);
}
for (const paths of [coreScripts, [...coreScripts].reverse()]) {
  test(`core modules import without DOM, state or global exports (${paths[0]} first)`, () => {
    importWithoutEnvironment(paths);
  });
}

test('tree indexes retain identity for position changes and invalidate structural edits', () => {
  const tree = Tree.create(),
    m = map(),
    initial = tree.info(m);
  assert.deepEqual(
    tree.children(m, 'root').map(n => n.id),
    ['b', 'a'],
  );
  assert.equal(tree.depth(m, 'c'), 2);
  assert.equal(tree.branchColor(m, 'c'), tree.branchColor(m, 'a'));
  assert.deepEqual([...tree.subtree(m, 'a')], ['a', 'c']);
  m.nodes.a.x += 20;
  assert.equal(tree.info(m), initial);
  m.nodes.c.parent = 'b';
  tree.invalidate();
  assert.notEqual(tree.info(m), initial);
  assert.equal(tree.branchColor(m, 'c'), tree.branchColor(m, 'b'));
  assert.notEqual(tree.info(clone(m)), tree.info(m));
  const ownIndex = tree.info(m);
  const second = Tree.create();
  assert.notEqual(second.info(m), ownIndex);
  second.invalidate();
  assert.equal(tree.info(m), ownIndex);
});

test('operation policies preserve differences between instructions, images and map switching', () => {
  const idle = {
    editing: false,
    gesturing: false,
    reparenting: false,
    deleting: false,
    handGrabbing: false,
    readOnly: false,
    switching: false,
    instructionRunning: false,
    instructionConfirmation: false,
    instructionDialog: false,
  };
  for (const fact of ['editing', 'gesturing', 'reparenting', 'deleting', 'handGrabbing']) {
    const busy = { ...idle, [fact]: true };
    assert.equal(Policy.canLeaveMap(busy), false, fact);
    assert.equal(Policy.canApplyInstruction(busy), false, fact);
    assert.equal(Policy.canAttachImage(busy), false, fact);
    assert.equal(Policy.canStartInstruction(busy), fact !== 'deleting', fact);
  }
  const thinking = { ...idle, instructionRunning: true };
  assert.equal(Policy.canAttachImage(thinking), true);
  assert.equal(Policy.canLeaveMap(thinking), true);
  assert.equal(Policy.canStartInstruction(thinking), false);
  const confirming = { ...thinking, instructionConfirmation: true };
  assert.equal(Policy.canAttachImage(confirming), false);
  assert.equal(Policy.canRemoveImage(confirming), true);
  assert.equal(Policy.paletteBlock({ ...idle, switching: true }), 'save.readonly');
  assert.equal(Policy.paletteBlock({ ...idle, editing: true }), 'palette.busy');
  assert.equal(Policy.paletteBlock(idle), '');
  assert.equal(Policy.canStartInstruction({ ...idle, instructionDialog: true }), false);
  assert.equal(Policy.canAttachImage({ ...idle, readOnly: true }), false);
  assert.equal(Policy.canStartInstruction({ ...idle, readOnly: true }), false);
  const current = { session: 'a', revision: 2 };
  assert.equal(Policy.mapRevisionConflict(current, { ...current }), false);
  assert.equal(Policy.mapRevisionConflict(current, { session: 'b', revision: 2 }), true);
  assert.equal(Policy.mapRevisionConflict(current, { session: 'a', revision: 3 }), true);
});

test('history instances isolate stacks, sequence numbers and pending save changes', () => {
  const a = history(),
    b = history();
  const initial = map();
  const changed = edit(a.store, initial, 'changed');
  assert.equal(a.stacks.history[0].at, 123);
  assert.deepEqual(a.store.restore(changed, 'undo'), initial);
  assert.deepEqual(a.store.restore(initial, 'redo'), changed);
  assert.equal(b.store.restore(initial, 'undo'), null);
  assert.deepEqual(b.store.takeChanges(), { cursor: 0, put: [], drop: [] });
  edit(b.store, initial, 'other');
  assert.equal(b.stacks.history[0].seq, 1);
  assert.equal(a.stacks.history.length, 1);
});

test('a failed save cannot revive a redo entry replaced by a new branch', () => {
  const { store, stacks } = history();
  const first = edit(store, map(), 'first');
  const second = edit(store, first, 'second');
  const inFlight = store.takeChanges();
  assert.deepEqual(store.restore(second, 'undo'), first);
  edit(store, first, 'replacement');
  store.retryChanges(inFlight);
  const batch = store.takeChanges();
  assert.equal(batch.cursor, 3);
  assert.deepEqual(batch.put.map(e => e.seq).sort(), [1, 3]);
  assert.deepEqual(batch.drop, [2]);
  assert.equal(stacks.future.length, 0);
});

test('history limits and verified log loading keep monotonic sequence numbers', () => {
  const { store, stacks } = history({ limit: 2 });
  let current = map();
  for (const text of ['one', 'two', 'three']) current = edit(store, current, text);
  assert.deepEqual(
    stacks.history.map(e => e.seq),
    [2, 3],
  );
  const pending = store.takeChanges();
  assert.deepEqual(
    pending.put.map(e => e.seq),
    [2, 3],
  );
  assert.deepEqual(pending.drop, [1]);
  const discarded = { ...stacks.history[0], seq: 20, prev: 19 };
  store.load(current, { cursor: 3, entries: [...stacks.history, discarded] });
  assert.deepEqual(store.takeChanges(), { cursor: 3, put: [], drop: [20] });
  current = store.restore(current, 'undo');
  const nextMap = edit(store, current, 'new branch');
  assert.equal(stacks.history.at(-1).seq, 21);
  store.load(map(), { cursor: 0, entries: [] });
  assert.equal(stacks.history.length, 0);
  assert.equal(stacks.future.length, 0);
  assert.deepEqual(store.takeChanges(), { cursor: 0, put: [], drop: [] });
  edit(store, nextMap, 'fresh');
  assert.equal(stacks.history[0].seq, 1);
});

const factories = appScripts.filter(path => path !== 'app/main.js');
for (const paths of [factories, [...factories].reverse()]) {
  test(`all screen factories import without DOM, services or global exports (${paths[0]} first)`, () => {
    importWithoutEnvironment(paths);
  });
}
