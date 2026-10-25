const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const Context = require('../ui-prototype/app/context.js');
const History = require('../ui-prototype/app/history.js');
const Persistence = require('../ui-prototype/app/persistence.js');
const history = require('../ui-prototype/core/history.js');
const diffs = require('../ui-prototype/storage/history.js');
const autosave = require('../ui-prototype/core/autosave.js');
const imageFormat = require('../ui-prototype/images/format.js');

const clone = value => JSON.parse(JSON.stringify(value));
function setup(id) {
  const timers = new Map(),
    writes = [],
    events = [];
  let timerId = 0;
  const context = Context.create({
    map: {
      version: 2,
      title: id,
      root: 'root',
      seq: 0,
      nodes: { root: { id: 'root', text: id, parent: null, order: 0, x: 0, y: 0 } },
    },
    sessionId: id,
    elements: {
      title: { value: id },
      save: { dataset: {} },
      saveText: {},
      saveExport: {},
    },
    services: { history, diffs, autosave, imageFormat, tr: key => `${id}:${key}` },
    timers: {
      set(fn) {
        const key = ++timerId;
        timers.set(key, fn);
        return key;
      },
      clear(key) {
        timers.delete(key);
      },
    },
    effects: Object.fromEntries(
      [
        'invalidateTree',
        'render',
        'interruptHand',
        'finishEdit',
        'endStaleInstruction',
        'updateAccess',
        'closeDelete',
        'toast',
        'resizeNotices',
      ].map(name => [name, value => events.push([name, value])]),
    ),
  });
  const { state } = context;
  state.mapId = id;
  state.mapClaim.editable = true;
  state.library = {
    async save(...args) {
      writes.push(clone(args));
    },
  };
  const operations = History.create(context);
  const persistence = Persistence.create(context, operations);
  context.effects.scheduleSave = persistence.scheduleSave;
  return { context, state, operations, persistence, timers, writes, events };
}
const edit = (app, text, options) =>
  app.operations.commit(() => {
    app.state.map.nodes.root.text = text;
  }, options);

for (const paths of [
  ['context.js', 'history.js', 'persistence.js'],
  ['persistence.js', 'history.js', 'context.js'],
]) {
  test(`app factories evaluate without DOM, services or shared state (${paths[0]} first)`, () => {
    const sandbox = vm.createContext({});
    for (const path of paths) {
      vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/app', path), 'utf8'), sandbox);
    }
    for (const name of ['MindmapAppContext', 'MindmapAppHistory', 'MindmapAppPersistence']) {
      assert.equal(typeof sandbox[name].create, 'function');
    }
    assert.equal(sandbox.state, undefined);
  });
}

test('two app contexts isolate editing, undo/redo, UI, save destinations and timer queues', async () => {
  const a = setup('a'),
    b = setup('b');
  assert.notEqual(a.state.history, b.state.history);
  edit(a, 'a1');
  assert.equal(a.state.revision, 1);
  assert.equal(b.state.revision, 0);
  assert.equal(a.timers.size, 1);
  assert.equal(b.timers.size, 0);
  assert.equal(b.context.elements.save.dataset.state, undefined);
  edit(b, 'b1');
  a.operations.undo();
  assert.equal(a.state.map.nodes.root.text, 'a');
  assert.equal(b.state.map.nodes.root.text, 'b1');
  assert.equal(b.state.future.length, 0);
  a.operations.redo();
  await a.persistence.flushSave();
  assert.equal(a.timers.size, 0);
  assert.equal(b.timers.size, 1);
  assert.equal(b.writes.length, 0);
  assert.equal(a.writes[0][0], 'a');
  assert.equal(a.writes[0][1].nodes.root.text, 'a1');
  assert.equal(a.context.elements.saveText.textContent, 'a:save.saved');
  await b.persistence.flushSave();
  assert.equal(b.writes[0][0], 'b');
  assert.equal(b.writes[0][1].nodes.root.text, 'b1');
});

test('validation and read-only rollback do not change either app history or save state', () => {
  const a = setup('a'),
    b = setup('b');
  const before = JSON.stringify(a.state.map);
  assert.equal(
    a.operations.commit(() => {
      a.state.map.root = 'missing';
    }),
    false,
  );
  assert.equal(JSON.stringify(a.state.map), before);
  assert.equal(a.state.history.length, 0);
  assert.equal(a.persistence.autosave.dirty, false);
  a.state.mapClaim.editable = false;
  a.state.map.nodes.root.text = 'preview';
  assert.equal(edit(a, 'blocked', { before }), false);
  assert.equal(JSON.stringify(a.state.map), before);
  assert.equal(a.context.elements.title.value, 'a');
  assert.equal(b.events.length, 0);
  assert.equal(b.persistence.autosave.dirty, false);
});

test('saving a committed snapshot during a preview leaves the other app preview and timers alone', async () => {
  const a = setup('a'),
    b = setup('b');
  edit(a, 'committed');
  edit(b, 'other');
  const before = JSON.stringify(a.state.map);
  a.state.editing = { before };
  edit(a, 'preview', { before, preview: true });
  await a.persistence.flushSave();
  assert.equal(a.writes[0][1].nodes.root.text, 'committed');
  assert.equal(a.state.history.length, 1);
  assert.equal(a.state.map.nodes.root.text, 'preview');
  assert.equal(b.timers.size, 1);
  assert.equal(b.writes.length, 0);
  a.state.editing = null;
  edit(a, 'preview', { before });
  assert.equal(a.state.history.length, 2);
  await a.persistence.flushSave();
  assert.equal(a.writes[1][1].nodes.root.text, 'preview');
});

test('a failed save and replacement branch recover only the owning app changes', async () => {
  const a = setup('a'),
    b = setup('b');
  let rejectWrite;
  a.state.library.save = () =>
    new Promise((resolve, reject) => {
      rejectWrite = reject;
    });
  edit(a, 'first');
  edit(a, 'second');
  const saving = a.persistence.flushSave();
  a.operations.undo();
  edit(a, 'replacement');
  edit(b, 'other');
  rejectWrite(new Error('offline'));
  await assert.rejects(saving, /offline/);
  assert.equal(a.context.elements.save.dataset.state, 'error');
  assert.equal(b.context.elements.save.dataset.state, 'saving');
  assert.equal(b.state.history.length, 1);
  a.state.library = {
    async save(...args) {
      a.writes.push(clone(args));
    },
  };
  await a.persistence.flushSave();
  assert.deepEqual(a.writes[0][2].put.map(e => e.seq).sort(), [1, 3]);
  assert.deepEqual(a.writes[0][2].drop, [2]);
  assert.equal(b.writes.length, 0);
  await b.persistence.flushSave();
  assert.deepEqual(
    b.writes[0][2].put.map(e => e.seq),
    [1],
  );
});
