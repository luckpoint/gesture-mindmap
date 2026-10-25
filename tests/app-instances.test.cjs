const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setup } = require('./helpers/ui-app.cjs');

function pair(options = {}) {
  const a = setup({ renderUI: true, ...options });
  const b = setup({ renderUI: true, ...options, moduleRuntime: a.context });
  assert.equal(a.context.MindmapAppBootstrap, b.context.MindmapAppBootstrap);
  assert.equal(a.context.MindmapAppEditing, b.context.MindmapAppEditing);
  assert.equal(a.context.MindmapAppInstructions, b.context.MindmapAppInstructions);
  assert.notEqual(a.app.context.services.instructionClient, b.app.context.services.instructionClient);
  assert.notEqual(a.app.context.services.imageStore, b.app.context.services.imageStore);
  return [a, b];
}

function instruction(app, text) {
  const { context, operations } = app.app;
  let finish;
  context.services.instructionClient.run = () =>
    new Promise(resolve => {
      finish = resolve;
    });
  const pending = operations.sendInstruction(text);
  return {
    pending,
    finish: () => finish({ status: 'ok', message: '', operations: [{ type: 'update_node', nodeId: 'a', text }] }),
  };
}

test('shared screen factories isolate editing handlers, history, saving and timer queues', async () => {
  const [a, b] = pair();
  a.app.operations.startEdit('a');
  a.app.context.elements.nodeEls.get('a').nodeText.textContent = 'first editor';
  assert.equal(b.app.context.state.editing, null);
  assert.notEqual(a.app.context.elements.nodeEls.get('a'), b.app.context.elements.nodeEls.get('a'));
  a.elements.get('#nodeSpeechDone').onclick();
  assert.equal(a.app.context.state.map.nodes.a.text, 'first editor');
  assert.equal(a.app.context.state.history.length, 1);
  assert.equal(b.app.context.state.history.length, 0);
  assert.equal(b.timers.size, 0);
  assert.equal(b.app.operations.autosave.dirty, false);

  b.app.operations.startEdit('b');
  b.app.context.elements.nodeEls.get('b').nodeText.textContent = 'second editor';
  b.elements.get('#nodeSpeechDone').onclick();
  a.app.context.state.library.failSave = true;
  await assert.rejects(a.app.operations.flushSave());
  await b.app.operations.flushSave();
  assert.equal(a.elements.get('#save').dataset.state, 'error');
  assert.equal(b.elements.get('#save').dataset.state, 'saved');
  assert.equal(b.app.context.state.library.docs.get('m_first').map.nodes.b.text, 'second editor');
  assert.notEqual(a.app.context.state.library.docs.get('m_first').map.nodes.a.text, 'first editor');
  a.app.operations.undo();
  assert.equal(a.app.context.state.future.length, 1);
  assert.equal(b.app.context.state.future.length, 0);
  assert.equal(b.app.context.state.map.nodes.b.text, 'second editor');
  a.app.context.state.library.failSave = false;
  a.app.operations.redo();
  await a.app.operations.flushSave();
  assert.equal(a.app.context.state.library.docs.get('m_first').map.nodes.a.text, 'first editor');
});

test('switching one map cannot interrupt another editor or recover history into its log', async () => {
  const [a, b] = pair();
  b.app.operations.addChildAndEdit('a');
  const preview = b.app.context.state.editing;
  const snapshot = JSON.stringify(b.app.context.state.map);
  a.app.operations.commit(() => {
    a.app.context.state.map.nodes.a.text = 'saved before switching';
  });
  const id = await a.app.context.state.library.create(a.app.operations.blankMap());
  await a.app.operations.switchMap(id);
  assert.equal(a.app.context.state.mapId, id);
  assert.equal(a.app.context.state.history.length, 0);
  assert.equal(b.app.context.state.mapId, 'm_first');
  assert.equal(b.app.context.state.editing, preview);
  assert.equal(JSON.stringify(b.app.context.state.map), snapshot);
  assert.equal(b.app.context.state.history.length, 0);
  b.app.context.elements.nodeEls.get(preview.id).nodeText.textContent = 'new child';
  b.app.operations.finishEdit();
  await b.app.operations.flushSave();
  assert.equal(b.app.context.state.history.length, 1);
  assert.equal(a.app.context.state.history.length, 0);
  assert.equal(a.app.context.state.library.docs.get('m_first').map.nodes.a.text, 'saved before switching');
});

test('an asynchronous image upload remains bound to its app while the other app switches maps', async () => {
  const [a, b] = pair();
  let finishUpload;
  a.app.context.services.imageStore.put = () =>
    new Promise(resolve => {
      finishUpload = resolve;
    });
  a.app.context.services.imageStore.acquire = async () => 'blob:first-app';
  const target = {
    nodeId: 'a',
    child: false,
    mapSessionId: a.app.context.state.mapSessionId,
    revision: a.app.context.state.revision,
  };
  const pending = a.app.operations.attachNodeImage(new Blob(['image']), target, 'first image');
  const id = await b.app.context.state.library.create(b.app.operations.blankMap());
  await b.app.operations.switchMap(id);
  finishUpload({ assetId: 'sha256:' + 'a'.repeat(64), width: 1, height: 1 });
  await pending;
  assert.equal(a.app.context.state.map.nodes.a.image.alt, 'first image');
  assert.equal(a.app.context.state.history.length, 1);
  assert.equal(b.app.context.state.history.length, 0);
  assert.equal(b.app.context.state.map.nodes.root.image, undefined);
  assert.equal(b.app.operations.autosave.dirty, false);
});

test('AI results and undo buttons stay with their app and preserve the other app draft', async () => {
  const [a, b] = pair();
  const first = instruction(a, 'first AI result');
  const second = instruction(b, 'second AI result');
  b.elements.get('#promptInput').value = 'keep this draft';
  b.elements.get('#promptInput').oninput();
  first.finish();
  await first.pending;
  assert.equal(a.app.context.state.map.nodes.a.text, 'first AI result');
  assert.equal(b.app.context.state.instruction.state, 'thinking');
  assert.equal(b.app.context.state.history.length, 0);
  second.finish();
  await second.pending;
  assert.equal(b.app.context.state.map.nodes.a.text, 'second AI result');
  assert.equal(b.elements.get('#promptInput').value, 'keep this draft');
  const otherUndo = b.app.context.ui.instructionUndoButton;
  a.app.context.ui.instructionUndoButton.onclick();
  assert.equal(a.app.context.state.future.length, 1);
  assert.equal(b.app.context.state.future.length, 0);
  assert.equal(otherUndo.disabled, false);
  assert.equal(b.app.context.state.map.nodes.a.text, 'second AI result');
});

test('a late AI result after a map switch is ignored while the other AI run stays active', async () => {
  const [a, b] = pair();
  let cancellations = 0;
  a.app.context.services.instructionClient.cancel = () => {
    cancellations++;
  };
  const first = instruction(a, 'stale result');
  const second = instruction(b, 'current result');
  const id = await a.app.context.state.library.create(a.app.operations.blankMap());
  await a.app.operations.switchMap(id);
  // A thinking run may remain in flight; its session guard rejects the old result.
  first.finish();
  await first.pending;
  assert.equal(a.app.context.state.mapId, id);
  assert.equal(a.app.context.state.history.length, 0);
  assert.equal(a.app.context.state.map.nodes.a, undefined);
  assert.equal(b.app.context.state.instruction.state, 'thinking');
  assert.equal(cancellations, 0);
  second.finish();
  await second.pending;
  assert.equal(b.app.context.state.map.nodes.a.text, 'current result');
});

test('palette, camera and pointer state use each app environment', () => {
  const [a, b] = pair({ paletteUI: true, handUI: true });
  assert.notEqual(a.app.context.ui.palette, b.app.context.ui.palette);
  assert.notEqual(a.app.operations.pts, b.app.operations.pts);
  a.elements.get('#iconPalette').setAttribute('aria-hidden', 'true');
  b.elements.get('#iconPalette').setAttribute('aria-hidden', 'true');
  a.elements.get('#paletteToggle').onclick();
  assert.equal(a.elements.get('#iconPalette').attributes['aria-hidden'], 'false');
  assert.equal(b.elements.get('#iconPalette').attributes['aria-hidden'], 'true');
  a.app.operations.toggleHand();
  assert.ok(a.app.context.ui.cameraSession);
  assert.equal(b.app.context.ui.cameraSession, null);
  b.app.operations.toggleHand();
  const other = b.app.context.ui.cameraSession;
  a.app.operations.stopHand();
  assert.equal(other.stopped, undefined);
  assert.equal(b.app.context.ui.cameraSession, other);
  assert.ok(b.app.context.state.hand);
});

test('startup connects each app storage service and list watcher after all screens are ready', async () => {
  const [a, b] = pair();
  const watchers = [];
  for (const app of [a, b]) {
    const { services, state } = app.app.context;
    const library = state.library;
    services.loadRxdb = async () => ({ createRxDatabase() {}, getRxStorageDexie: () => 'test storage' });
    services.MapLibrary = {
      open: async options => {
        assert.equal(options.storage, 'test storage');
        return library;
      },
    };
    services.NodeImageStore = { ...services.NodeImageStore, indexedDBLegacy: () => ({}) };
    services.imageStore.migrate = async () => null;
    services.instructionClient.status = async () => ({ available: true });
    library.migrateLegacy = async () => {};
    library.watchList = callback => {
      watchers.push(callback);
      return () => {};
    };
    await app.app.start();
  }
  assert.equal(watchers.length, 2);
  watchers[0]([{ id: 'm_first', title: 'first library', updatedAt: 1 }]);
  watchers[1]([{ id: 'm_first', title: 'second library', updatedAt: 2 }]);
  assert.equal(a.app.context.ui.mapList[0].title, 'first library');
  assert.equal(b.app.context.ui.mapList[0].title, 'second library');
  assert.notEqual(a.app.context.state.library, b.app.context.state.library);
  assert.equal(a.elements.get('#mapsBtn').disabled, false);
  assert.equal(b.elements.get('#mapsBtn').disabled, false);
});
