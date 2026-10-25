const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Run the actual app scripts, minus the boot in app/main.js, with minimal DOM/storage adapters.
// These tests cover state transitions and import failures, not browser layout or real touch.
const html = readFileSync(join(__dirname, '../ui-prototype/index.html'), 'utf8');
const appScripts = [...html.matchAll(/<script src="(app\/[^"]+)"/g)]
  .map(m => m[1])
  .filter(path => path !== 'app/main.js')
  .map(path => readFileSync(join(__dirname, '../ui-prototype', path), 'utf8'));
// Keeps maps in memory with the same contract as storage/library.js.
function memoryLibrary() {
  const docs = new Map(),
    clone = v => JSON.parse(JSON.stringify(v)),
    watchers = new Map();
  let next = 0,
    clock = 1;
  return {
    docs,
    watchers,
    failSave: false,
    failCreate: false,
    async create(map) {
      if (this.failCreate) throw new Error('作成できませんでした');
      const id = 'm_' + ++next;
      docs.set(id, { map: clone(map), updatedAt: ++clock, cursor: 0, log: new Map() });
      return id;
    },
    async load(id) {
      return docs.has(id) ? clone(docs.get(id).map) : null;
    },
    async log(id) {
      const d = docs.get(id);
      return { cursor: d?.cursor ?? 0, entries: d ? [...d.log.values()].map(clone) : [] };
    },
    async save(id, map, { cursor, put = [], drop = [] } = {}) {
      if (this.failSave) throw new Error('保存できませんでした');
      const d = docs.get(id);
      if (!d) throw new Error('マップが見つかりません');
      for (const seq of drop) d.log.delete(seq);
      for (const e of put) d.log.set(e.seq, clone(e));
      Object.assign(d, { map: clone(map), updatedAt: ++clock }, cursor === undefined ? {} : { cursor });
      watchers.get(id)?.(clone(map));
    },
    async remove(id) {
      docs.delete(id);
    },
    async stats(id) {
      const d = docs.get(id);
      return d ? { bytes: JSON.stringify(d.map).length, images: 0, assets: [] } : null;
    },
    async list() {
      return [...docs]
        .map(([id, d]) => ({ id, title: d.map.title, updatedAt: d.updatedAt }))
        .sort((a, b) => b.updatedAt - a.updatedAt);
    },
    watch(id, fn) {
      watchers.set(id, fn);
      return () => watchers.delete(id);
    },
    watchList() {
      return () => {};
    },
  };
}
function setup({
  renderUI = false,
  handUI = false,
  stored = {},
  instructions = true,
  lang = 'ja',
  paletteUI = false,
  compact = false,
} = {}) {
  const elements = new Map(),
    storage = new Map(Object.entries(stored)),
    timers = new Map(),
    documentHandlers = new Map(),
    windowHandlers = new Map();
  let timerId = 0;
  const frames = new Map(),
    intervals = new Map();
  function element(key) {
    if (!elements.has(key))
      elements.set(key, {
        dataset: {},
        style: {
          setProperty(name, value) {
            this[name] = value;
          },
        },
        classList: {
          add() {},
          remove() {},
          toggle() {},
          contains() {
            return false;
          },
        },
        firstChild: {
          textContent: '',
          dataset: {},
          focus() {
            context.document.activeElement = this;
          },
          closest() {
            return this.contentEditable === 'plaintext-only' ? this : null;
          },
        },
        attributes: {},
        children: [],
        isConnected: false,
        contains(el) {
          return el === this || this.children.includes(el);
        },
        offsetWidth: 120,
        offsetHeight: 50,
        getContext: () => ({ clearRect() {} }),
        getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800 }),
        append(...children) {
          for (const child of children) {
            this.children.push(child);
            child.isConnected = true;
          }
        },
        replaceChildren(...children) {
          this.children = children;
        },
        prepend(child) {
          this.children.unshift(child);
          this.firstChild = child;
          child.isConnected = true;
        },
        remove() {
          this.isConnected = false;
        },
        handlers: {},
        hidden: false,
        value: '',
        disabled: false,
        addEventListener(name, fn) {
          this.handlers[name] = fn;
        },
        setPointerCapture() {},
        focus() {
          context.document.activeElement = this;
        },
        setAttribute(name, value) {
          this.attributes[name] = value;
        },
        removeAttribute(name) {
          delete this.attributes[name];
        },
        showModal() {
          this.open = true;
        },
        close() {
          this.open = false;
        },
        click() {
          this.clicked = (this.clicked || 0) + 1;
        },
        querySelector(selector) {
          return selector === '.node__text' ? this.firstChild : element(selector);
        },
      });
    return elements.get(key);
  }
  const context = vm.createContext({
    MindmapFeatures: { instructions },
    navigator: { languages: [lang] },
    console,
    TextEncoder,
    AbortSignal,
    AbortController,
    Blob,
    innerWidth: 1200,
    innerHeight: 800,
    matchMedia: query => ({ matches: !query.includes('max-width') || compact }),
    document: {
      querySelector: element,
      createElement: () => element(Symbol()),
      createElementNS: () => element(Symbol()),
      createRange: () => ({ selectNodeContents() {} }),
      addEventListener: (name, fn) => documentHandlers.set(name, fn),
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    CameraSession: class {
      constructor(io) {
        this.io = io;
      }
      start() {}
      stop() {
        this.stopped = true;
      }
    },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    setTimeout: fn => {
      timers.set(++timerId, fn);
      return timerId;
    },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => {
      intervals.set(++timerId, fn);
      return timerId;
    },
    clearInterval: id => intervals.delete(id),
    requestAnimationFrame: fn => {
      frames.set(++timerId, fn);
      return timerId;
    },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, fn) => windowHandlers.set(name, fn),
  });
  context.document.body = element('body');
  // Skip only the initial screen draw; all production handlers are registered.
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/speech/controller.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/i18n.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/gestures/controller.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/gestures/debug.js'), 'utf8'), context);
  for (const file of ['privacy.js', 'format.js', 'store.js', 'upload.js'])
    vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/images', file), 'utf8'), context);
  for (const file of ['operations.js', 'client.js'])
    vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/instructions', file), 'utf8'), context);
  for (const file of ['library.js', 'locks.js', 'history.js'])
    vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/storage', file), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/print.js'), 'utf8'), context);
  if (paletteUI)
    for (const file of ['catalog.js', 'palette.js'])
      vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/icons', file), 'utf8'), context);
  for (const script of appScripts) vm.runInContext(script, context);
  context.memoryLibrary = memoryLibrary;
  vm.runInContext(
    `state.library = memoryLibrary(); state.library.docs.set('m_first', { map: sample(), updatedAt: 1, cursor: 0, log: new Map() });
    state.mapId = 'm_first'; state.mapClaim = { editable: true, release() { this.released = true; } };`,
    context,
  );
  vm.runInContext(
    `
    ${renderUI ? '' : 'render = () => {};'} fitAll = () => {}; applyView = () => {};
    ${handUI ? '' : 'updateHand = () => {};'} const notices = []; toast = message => notices.push(message);
  `,
    context,
  );
  if (renderUI) vm.runInContext('render();', context);
  return {
    context,
    elements,
    storage,
    timers,
    frames,
    intervals,
    documentHandlers,
    windowHandlers,
    flushFrame() {
      const queued = [...frames.values()];
      frames.clear();
      queued.forEach(fn => fn());
    },
    run: code => vm.runInContext(code, context),
  };
}

test('validation accepts an exported map and rejects malformed data', () => {
  const { run } = setup();
  assert.equal(run('valid(JSON.parse(JSON.stringify(sample())))'), true);
  for (const mutation of [
    'm = null',
    'm = []',
    'm.version = 3',
    'delete m.title',
    'm.nodes = []',
    'm.root = "absent"',
    'm.nodes.a = null',
    'm.nodes.a.id = "absent"',
    'm.nodes.a.id = "root"',
    'm.nodes.a.x = null',
    'm.nodes.a.x = "12"',
    'm.nodes.a.y = Infinity',
    'm.nodes.a.y = NaN',
    'm.nodes.a.text = 1',
    'delete m.nodes.root.parent',
    'm.nodes.a.parent = null',
    'm.nodes.a.parent = "missing"',
    'm.nodes.a.parent = "toString"',
    'm.nodes.a.parent = "a"',
    'm.nodes.a.parent = "a1"',
    'delete m.nodes.a.order',
    'm.nodes.a.order = -1',
    'm.nodes.a.order = 1.5',
    'm.nodes.a.order = m.seq + 1',
    'm.seq = "7"',
    'm.seq = -1',
    'm.seq = Number.MAX_SAFE_INTEGER',
  ]) {
    assert.equal(run(`{ let m = sample(); ${mutation}; valid(m); }`), false, mutation);
  }
});

test('invalid imports add no map and keep the working map, history and pending save', async () => {
  const { run, timers } = setup();
  run(
    `const original = state.map; state.selectedId = 'a'; state.history.push('undo'); state.future.push('redo'); scheduleSave();`,
  );
  await assert.rejects(run(`{ const m = sample(); m.nodes.a.id = 'missing'; importMap(m); }`), /形式/);
  assert.equal(
    run(
      `state.map === original && state.selectedId === 'a' && state.history[0] === 'undo' && state.future[0] === 'redo' && state.library.docs.size === 1`,
    ),
    true,
  );
  assert.equal(timers.size, 1);
});

test('a failed save keeps the working map open and adds no map', async () => {
  const { run } = setup();
  run(`const original = state.map; commit(() => { state.map.nodes.a.text = '変更'; }); state.library.failSave = true;`);
  await assert.rejects(run('importMap(sample())'), /保存できませんでした/);
  assert.equal(
    run(
      `state.map === original && state.mapId === 'm_first' && state.library.docs.size === 1 && $('#save').dataset.state === 'error' && state.history.length === 1`,
    ),
    true,
  );
});

test('a failed import write reopens the original map and adds nothing', async () => {
  const { run } = setup();
  run(`state.library.failCreate = true;`);
  await assert.rejects(run('importMap(sample())'), /作成できませんでした/);
  assert.equal(run(`state.mapId === 'm_first' && state.library.docs.size === 1 && state.mapClaim.editable`), true);
});

test('valid import adds a new map, opens it and keeps the original', async () => {
  const { run, storage } = setup();
  run(`commit(() => { state.map.nodes.a.text = '保存前'; }); const firstClaim = state.mapClaim;
    const imported = sample(); imported.title = 'imported';`);
  await run('importMap(imported)');
  assert.equal(
    run(
      `state.map.title === 'imported' && state.mapId !== 'm_first' && state.selectedId === state.map.root && state.history.length === 0 && state.future.length === 0 && firstClaim.released`,
    ),
    true,
  );
  assert.equal(
    run(`state.library.docs.size === 2 && state.library.docs.get('m_first').map.nodes.a.text === '保存前'`),
    true,
  );
  assert.equal(storage.get('mindmap:last'), run('state.mapId'));
});

test('import and switching do not replace a map during an active operation', async () => {
  for (const field of ['state.editing', 'state.gesture', 'state.mode', 'state.deletion', 'state.hand']) {
    const { run } = setup();
    run(`const original = state.map; ${field} = ${field === 'state.hand' ? "{ grab: 'a' }" : '{}'};`);
    await assert.rejects(run('importMap(sample())'), /操作を終えて/);
    await assert.rejects(run(`state.library.create(sample()).then(id => switchMap(id))`), /操作を終えて/);
    await assert.rejects(run(`deleteMap('m_first')`), /操作を終えて/);
    assert.equal(run(`state.map === original && state.mapId === 'm_first' && state.mapClaim.editable`), true);
  }
});

test('switching saves first, restores each view, clears history and ends a waiting instruction', async () => {
  const t = setup();
  t.run(`commit(() => { state.map.nodes.a.text = '切替前'; }); state.view = { x: 11, y: 22, s: 1.5 };
    state.instruction = { state: 'awaiting_confirmation', text: '' }; $('#instructionDialog').open = true;`);
  const second = await t.run('state.library.create(blankMap())');
  await t.run(`switchMap('${second}')`);
  assert.equal(
    t.run(
      `state.library.docs.get('m_first').map.nodes.a.text === '切替前' && state.mapId === '${second}' && state.history.length === 0 && $('#undo').disabled && state.instruction === null`,
    ),
    true,
  );
  assert.match(t.elements.get('#instructionToast').textContent, /マップが変わった/);
  assert.equal(JSON.parse(t.storage.get('mindmap:view:m_first')).s, 1.5);
  await t.run(`switchMap('m_first')`);
  assert.equal(
    t.run(
      `state.mapId === 'm_first' && state.view.x === 11 && state.view.y === 22 && state.view.s === 1.5 && state.map.nodes.a.text === '切替前'`,
    ),
    true,
  );
});

test('compact screens open with no selection and refit instead of restoring a saved view', async () => {
  const t = setup({ compact: true });
  t.run(`state.view = { x: 11, y: 22, s: 1.5 }; var fits = 0; fitAll = () => { fits++; };`);
  const second = await t.run('state.library.create(blankMap())');
  await t.run(`switchMap('${second}')`);
  await t.run(`switchMap('m_first')`);
  assert.equal(t.run(`state.selectedId === null && fits === 2 && state.view.s === 1.5`), true);
  assert.equal(JSON.parse(t.storage.get('mindmap:view:m_first')).s, 1.5);
});
test('holding fit resets to 100% without fitting; a tap fits', () => {
  const t = setup();
  t.run(`var fits = 0; fitAll = () => { fits++; }; state.view = { x: 0, y: 0, s: .5 };`);
  const fit = t.elements.get('#fitBtn');
  fit.onpointerdown();
  fit.onclick();
  assert.equal(t.run('fits'), 1);
  fit.onpointerdown();
  [...t.timers.values()].at(-1)();
  fit.onpointerup();
  fit.onclick();
  assert.equal(t.run('fits === 1 && state.view.s === 1'), true);
});
test('deleting the open map opens the newest remaining one; the last map becomes the sample', async () => {
  const t = setup();
  const other = await t.run(`state.library.create(blankMap())`);
  await t.run(`deleteMap('m_first')`);
  assert.equal(t.run(`state.mapId === '${other}' && !state.library.docs.has('m_first')`), true);
  await t.run(`deleteMap('${other}')`);
  assert.equal(
    t.run(`state.library.docs.size === 1 && state.map.title === sample().title && state.mapId !== '${other}'`),
    true,
  );
});

test('read-only tabs cannot edit, undo or instruct, and follow saves from the editing tab', async () => {
  const t = setup();
  t.run(`commit(() => { state.map.nodes.a.text = '編集'; }); state.mapClaim = { editable: false, release() {} }; stopWatch = state.library.watch(state.mapId, showRemote); updateAccess();
    const before = JSON.stringify(state.map);`);
  t.run(
    `startEdit('a'); addChildAndEdit('a'); removeNode('a'); startReparent('a'); undo(); commit(() => { state.map.nodes.a.text = 'x'; });`,
  );
  assert.equal(
    t.run(
      `JSON.stringify(state.map) === before && !state.editing && !state.deletion && !state.mode && state.history.length === 1 && $('#title').readOnly && $('#undo').disabled`,
    ),
    true,
  );
  t.run(`$('#promptInput').value = '変えて';`);
  await t.run('sendInstruction()');
  assert.match(t.elements.get('#instructionToast').textContent, /別のタブで編集中/);
  t.run(`{ const m = sample(); m.nodes.a.text = '別のタブ'; state.library.watchers.get(state.mapId)(m); }`);
  assert.equal(t.run(`state.map.nodes.a.text === '別のタブ'`), true);
});

test('file handler rejects broken JSON and ignores an older async read', async () => {
  const { run, elements } = setup();
  const change = elements.get('#fileInput').onchange;
  const input = text => ({ target: { files: [{ text }], value: 'file.json' } });
  run('const original = state.map;');
  await change(input(async () => '{'));
  assert.equal(run('state.map === original'), true);
  assert.match(run('notices[0]'), /維持/);
  let resolveOld;
  const oldRead = change(
    input(
      () =>
        new Promise(resolve => {
          resolveOld = resolve;
        }),
    ),
  );
  const latest = JSON.parse(run('JSON.stringify(sample())'));
  latest.title = 'latest';
  await change(input(async () => JSON.stringify(latest)));
  latest.title = 'older';
  resolveOld(JSON.stringify(latest));
  await oldRead;
  assert.equal(run('state.map.title'), 'latest');
});

for (const endEvent of ['pointerup', 'pointercancel']) {
  test(`pinch ends safely on ${endEvent} and the remaining finger cannot move the view`, () => {
    const { run, elements } = setup();
    const handlers = elements.get('#viewport').handlers;
    const pointer = (id, x, y) => ({
      pointerId: id,
      clientX: x,
      clientY: y,
      pointerType: 'touch',
      target: { closest: () => null },
    });
    handlers.pointerdown(pointer(1, 100, 100));
    handlers.pointerdown(pointer(2, 200, 200));
    handlers.pointermove(pointer(2, 250, 250));
    const before = run('JSON.stringify(state.view)');
    handlers[endEvent](pointer(2, 250, 250));
    assert.equal(run('state.gesture'), null);
    handlers.pointermove(pointer(1, 130, 130));
    assert.equal(run('JSON.stringify(state.view)'), before);
    handlers.pointerup(pointer(1, 130, 130));
    assert.equal(run('pts.size'), 0);
    handlers.pointerdown(pointer(3, 100, 100));
    handlers.pointermove(pointer(3, 150, 150));
    assert.notEqual(run('JSON.stringify(state.view)'), before);
  });
}

test('coincident touch points do not produce nonfinite view coordinates', () => {
  const { run, elements } = setup();
  const handlers = elements.get('#viewport').handlers;
  const pointer = id => ({
    pointerId: id,
    clientX: 100,
    clientY: 100,
    pointerType: 'touch',
    target: { closest: () => null },
  });
  handlers.pointerdown(pointer(1));
  handlers.pointerdown(pointer(2));
  handlers.pointermove(pointer(2));
  assert.equal(
    run('Number.isFinite(state.view.x) && Number.isFinite(state.view.y) && Number.isFinite(state.view.s)'),
    true,
  );
});

test('tree metadata is reused for movement and refreshed for structural changes and undo', async () => {
  const { run } = setup();
  assert.equal(run(`branchColor('a1') === branchColor('a') && depth('a1') === 2`), true);
  run(`const initialTree = treeInfo(); state.map.nodes.a.x += 10;`);
  assert.equal(run('treeInfo() === initialTree'), true);
  run(`let added; commit(() => { added = addNode('a1', 'child', {x:0,y:0}); });`);
  assert.equal(
    run(`treeInfo() !== initialTree && depth(added) === 3 && branchColor(added) === branchColor('a')`),
    true,
  );
  run(`startReparent('a'); setCandidate('b1'); confirmReparent();`);
  assert.equal(run(`depth('a1') === 4 && branchColor('a1') === branchColor('b')`), true);
  run('undo();');
  assert.equal(run(`depth('a1') === 2 && branchColor('a1') !== branchColor('b')`), true);
  run(`removeNode('b'); chooseDeleteScope('branch'); confirmDelete();`);
  assert.equal(
    run(`childrenOf(state.map.root).map(n => n.id).join(',') === 'a,c' && branchColor('c1') === 'var(--branch-2)'`),
    true,
  );
  await run(`importMap(sample())`);
  assert.equal(run(`childrenOf(state.map.root).length === 3 && branchColor('c1') === 'var(--branch-3)'`), true);
});

const mouse = (x, y, id = null) => ({
  pointerId: 1,
  clientX: x,
  clientY: y,
  pointerType: 'mouse',
  target: { closest: () => (id ? { dataset: { id } } : null) },
});

test('reparent reuses its exclusion set across pointer moves and redraws', () => {
  const { run, elements } = setup({ renderUI: true });
  run(`render();
    const findSubtree = subtree;
    let subtreeCalls = 0;
    subtree = id => { subtreeCalls++; return findSubtree(id); };
    startReparent('a');
    const blocked = state.mode.blocked;
    const drawNode = renderNode;
    renderNode = (n, excluded) => {
      if (state.mode && excluded !== state.mode.blocked) throw new Error('exclusion set not reused');
      drawNode(n, excluded);
    };
  `);
  const move = elements.get('#viewport').handlers.pointermove;
  for (const id of ['a', 'a1', 'b', 'b', 'b1', null, null]) {
    move(mouse(100, 100, id));
    assert.equal(run('state.mode.candidate'), id === 'a' || id === 'a1' ? null : id);
  }
  run('render();');
  assert.equal(
    run(`subtreeCalls === 1 && state.mode.blocked === blocked && blocked.has('a') && blocked.has('a1')`),
    true,
  );
  run(`setCandidate('b'); confirmReparent(); startReparent('b');`);
  assert.equal(run(`subtreeCalls === 2 && state.mode.blocked !== blocked && state.mode.blocked.has('a1')`), true);
  run(`setCandidate('a1');`);
  assert.equal(run('state.mode.candidate'), null);
  run('endReparent(); setCandidate(null);');
  assert.equal(run('state.mode'), null);
});

test('dropping a node on a sibling swaps their subtrees in one undo step', () => {
  const { run, elements } = setup();
  const handlers = elements.get('#viewport').handlers,
    before = run('JSON.stringify(state.map)');
  handlers.pointerdown(mouse(310, -130, 'a'));
  handlers.pointermove(mouse(-320, -110));
  assert.equal(run('state.gesture.swap'), 'b');
  handlers.pointerup(mouse(-320, -110));
  assert.equal(
    run(`[state.map.nodes.a.x, state.map.nodes.a.y, state.map.nodes.b.x, state.map.nodes.b.y].join()`),
    '-320,-110,310,-130',
  );
  assert.equal(run('state.map.nodes.a1.x < state.map.nodes.a.x && state.history.length'), 1);
  run('undo();');
  assert.equal(run('JSON.stringify(state.map)'), before);
  handlers.pointerdown(mouse(310, -130, 'a'));
  handlers.pointermove(mouse(-540, -200));
  handlers.pointerup(mouse(-540, -200));
  assert.equal(run('state.map.nodes.a.x === -540 && state.map.nodes.b.x === -320'), true);
});

test('drags beyond the limit retain only the latest entries and support undo and redo', () => {
  const { run, elements } = setup();
  const handlers = elements.get('#viewport').handlers,
    limit = run('HISTORY_LIMIT'),
    total = limit + 5;
  // Alternate x and y so the node never reaches the canvas bound.
  const drag = i => {
    handlers.pointerdown(mouse(100, 100, 'a'));
    handlers.pointermove(i % 2 ? mouse(100, 110) : mouse(110, 100));
    handlers.pointerup(mouse(100, 100));
  };
  const at = k => [310 + 10 * Math.ceil(k / 2), -130 + 10 * Math.floor(k / 2)];
  for (let i = 0; i < total; i++) drag(i);
  assert.equal(run('state.history.length'), limit);
  assert.deepEqual(
    JSON.parse(run('JSON.stringify([state.history[0].before.nodes.a.x, state.history[0].before.nodes.a.y])')),
    at(5),
  );
  assert.deepEqual(JSON.parse(run('JSON.stringify([state.map.nodes.a.x, state.map.nodes.a.y])')), at(total));
  run(`for (let i = 0; i < ${total}; i++) undo();`);
  assert.deepEqual(
    JSON.parse(
      run('JSON.stringify([state.map.nodes.a.x, state.map.nodes.a.y, state.history.length, state.future.length])'),
    ),
    [...at(5), 0, limit],
  );
  run(`for (let i = 0; i < ${total}; i++) redo();`);
  assert.deepEqual(
    JSON.parse(
      run('JSON.stringify([state.map.nodes.a.x, state.map.nodes.a.y, state.history.length, state.future.length])'),
    ),
    [...at(total), limit, 0],
  );
  run(`commit(() => { state.map.nodes.a.text = 'changed'; });`);
  assert.equal(run('state.history.length'), limit);
  run('undo();');
  drag(0);
  assert.equal(run('state.history.length === HISTORY_LIMIT && state.future.length === 0'), true);
  run('undo();');
  assert.equal(run(`state.map.nodes.a.x === ${at(total)[0]} && state.map.nodes.a.text !== 'changed'`), true);
});

test('history survives reopening: undo and redo continue from the saved cursor', async () => {
  const t = setup({ renderUI: true });
  t.run(`commit(() => { state.map.nodes.a.text = '一'; }); commit(() => { state.map.nodes.b.x += 50; }); addChildAndEdit('c');
    nodeEls.get(state.selectedId).nodeText.textContent = '新しい子'; finishEdit(); undo();`);
  await t.run('flushSave()');
  const other = await t.run('state.library.create(blankMap())');
  await t.run(`switchMap('${other}')`);
  assert.equal(t.run('state.history.length + state.future.length'), 0);
  await t.run(`switchMap('m_first')`);
  assert.equal(
    t.run(
      `state.history.length === 2 && state.future.length === 1 && state.map.nodes.a.text === '一' && !$('#undo').disabled && !$('#redo').disabled`,
    ),
    true,
  );
  t.run('redo();');
  assert.equal(t.run(`Object.values(state.map.nodes).some(n => n.text === '新しい子')`), true);
  t.run('undo(); undo(); undo();');
  assert.equal(
    t.run(`state.map.nodes.a.text === sample().nodes.a.text && state.map.nodes.b.x === sample().nodes.b.x`),
    true,
  );
  t.run(`commit(() => { state.map.title = '別の道'; });`);
  await t.run('flushSave()');
  assert.equal(
    t.run(
      `state.library.docs.get('m_first').log.size === 1 && state.library.docs.get('m_first').cursor === state.history[0].seq`,
    ),
    true,
  );
});

test('an empty new node leaves no history entry, and a failed save keeps entries for the next try', async () => {
  const t = setup({ renderUI: true });
  t.run(`addChildAndEdit('a'); finishEdit();`);
  assert.equal(t.run('state.history.length === 0 && unsaved.size === 0'), true);
  t.run(`state.library.failSave = true; commit(() => { state.map.nodes.a.text = '保存待ち'; });`);
  await assert.rejects(t.run('flushSave()'));
  t.run('state.library.failSave = false;');
  await t.run('scheduleSave(), flushSave()');
  assert.equal(
    t.run(
      `state.library.docs.get('m_first').log.size === 1 && state.library.docs.get('m_first').cursor === state.history[0].seq`,
    ),
    true,
  );
});

for (const branch of [false, true]) {
  test(`failed in-flight saves merge later history changes (${branch ? 'replacement branch' : 'additional edit'})`, async () => {
    const t = setup();
    t.run(`const saveNormally = state.library.save;
      let rejectWrite;
      state.library.save = () => new Promise((resolve, reject) => { rejectWrite = reject; });
      commit(() => { state.map.nodes.a.text = 'first'; });`);
    const saving = t.run('flushSave()');
    await t.run('Promise.resolve()');
    if (branch) t.run('undo();');
    t.run(`commit(() => { state.map.nodes.b.text = 'second'; }); rejectWrite(new Error('offline'));`);
    await assert.rejects(saving, /offline/);
    assert.equal(t.run(`autosave.dirty && $('#save').dataset.state === 'error' && !$('#saveExport').hidden`), true);
    t.run('state.library.save = saveNormally;');
    await t.run('flushSave()');
    assert.equal(t.run(`JSON.stringify(state.library.docs.get('m_first').map) === JSON.stringify(state.map)`), true);
    assert.equal(t.run(`state.library.docs.get('m_first').log.has(1)`), !branch);
    assert.equal(t.run(`state.library.docs.get('m_first').log.has(2)`), true);
    assert.equal(t.run(`state.library.docs.get('m_first').cursor`), 2);
    assert.equal(t.run(`!autosave.dirty && $('#save').dataset.state === 'saved' && $('#saveExport').hidden`), true);
    await t.run(`switchMap(async () => state.library.create(blankMap()))`);
    await t.run(`switchMap('m_first')`);
    assert.equal(t.run('state.history.length'), branch ? 1 : 2);
    t.run('undo();');
    assert.equal(t.run(`state.map.nodes.b.text === sample().nodes.b.text`), true);
    assert.equal(t.run(`state.map.nodes.a.text === 'first'`), !branch);
  });
}

test('a failed deletion reschedules history recovered from a failed in-flight save', async () => {
  const t = setup();
  t.run(`const saveNormally = state.library.save;
    let rejectWrite;
    state.library.save = () => new Promise((resolve, reject) => { rejectWrite = reject; });
    state.library.remove = async () => { throw new Error('cannot delete'); };
    commit(() => { state.map.title = 'keep this edit'; });`);
  const saving = t.run('flushSave()');
  await t.run('Promise.resolve()');
  const deleting = t.run(`deleteMap('m_first')`);
  t.run(`rejectWrite(new Error('offline'));`);
  await assert.rejects(saving, /offline/);
  await assert.rejects(deleting, /cannot delete/);
  assert.equal(
    t.run(`state.mapId === 'm_first' && autosave.dirty && state.mapClaim.editable && !state.switching`),
    true,
  );
  t.run('state.library.save = saveNormally;');
  await t.run('flushSave()');
  assert.equal(
    t.run(
      `state.library.docs.get('m_first').map.title === 'keep this edit' && state.library.docs.get('m_first').log.has(1)`,
    ),
    true,
  );
});

test('drag coalesces events and only updates the moved subtree and incident edges', () => {
  const { run, elements, frames, flushFrame } = setup({ renderUI: true });
  run(`render(); const untouchedEdge = edgeEls.get('b1');
    const drawNode = renderNode, drawEdge = renderEdge;
    let drawnNodes = [], drawnEdges = [];
    renderNode = (n, blocked) => { drawnNodes.push(n.id); drawNode(n, blocked); };
    renderEdge = n => { drawnEdges.push(n.id); drawEdge(n); };
  `);
  const handlers = elements.get('#viewport').handlers;
  handlers.pointerdown(mouse(100, 100, 'a'));
  run('drawnNodes = []; drawnEdges = [];');
  handlers.pointermove(mouse(120, 110));
  handlers.pointermove(mouse(140, 130));
  assert.equal(frames.size, 1);
  assert.equal(run('drawnNodes.length + drawnEdges.length'), 0);
  flushFrame();
  assert.equal(run(`drawnNodes.join(',') === 'a,a1' && drawnEdges.join(',') === 'a,a1'`), true);
  assert.equal(run(`nodeEls.get('a').style['--x'] === '350px' && nodeEls.get('a1').style['--x'] === '580px'`), true);
  assert.equal(
    run(
      `edgeEls.get('a').attributes.d === curve(state.map.nodes.root, state.map.nodes.a) && edgeEls.get('b1') === untouchedEdge`,
    ),
    true,
  );
  handlers.pointerup(mouse(140, 130));
  run('undo();');
  assert.equal(run(`state.map.nodes.a.x === 310 && nodeEls.get('a').style['--x'] === '310px'`), true);
});

for (const endEvent of ['pointerup', 'pointercancel']) {
  test(`pending drag frame is safe when ${endEvent} arrives before paint`, () => {
    const { run, elements, frames, flushFrame } = setup({ renderUI: true });
    run('render();');
    const handlers = elements.get('#viewport').handlers;
    handlers.pointerdown(mouse(100, 100, 'a1'));
    handlers.pointermove(mouse(140, 130));
    assert.equal(frames.size, 1);
    handlers[endEvent](mouse(140, 130));
    assert.equal(frames.size, 0);
    flushFrame();
    const expected = endEvent === 'pointerup' ? 580 : 540;
    assert.equal(run('state.map.nodes.a1.x'), expected);
    assert.equal(run(`nodeEls.get('a1').style['--x']`), `${expected}px`);
    assert.equal(run('state.history.length'), endEvent === 'pointerup' ? 1 : 0);
  });
}

test('SVG paths survive redraws and obsolete paths are removed', () => {
  const { run } = setup({ renderUI: true });
  run(`render(); const originalEdge = edgeEls.get('a'); select('b');`);
  assert.equal(run(`edgeEls.get('a') === originalEdge && edgeEls.size === 6`), true);
  run(`startReparent('a'); setCandidate('b1');`);
  assert.equal(
    run(`previewEdge.isConnected && previewEdge.attributes.d === curve(state.map.nodes.b1, state.map.nodes.a)`),
    true,
  );
  run(`confirmReparent();`);
  assert.equal(
    run(
      `previewEdge === null && edgeEls.get('a') === originalEdge && originalEdge.attributes.d === curve(state.map.nodes.b1, state.map.nodes.a)`,
    ),
    true,
  );
  run(`removeNode('a'); chooseDeleteScope('branch'); confirmDelete();`);
  assert.equal(run(`!originalEdge.isConnected && !edgeEls.has('a') && !edgeEls.has('a1')`), true);
});

function mockInstruction(t, operations) {
  t.run(`var resolveInstruction;
    instructionClient.run = () => new Promise(resolve => { resolveInstruction = resolve; });
    $('#promptInput').value = '指示';
  `);
  const pending = t.run('sendInstruction()');
  return {
    pending,
    finish: () => t.run(`resolveInstruction(${JSON.stringify({ status: 'ok', message: '', operations })});`),
  };
}

test('sending an instruction settles editing, drag previews and reparenting before capturing its snapshot', async () => {
  for (const prepare of [
    `startEdit('a'); nodeEls.get('a').nodeText.textContent = '確定した編集';`,
    `beginNodeDrag('a', 0, 0); moveNodeDrag(state.gesture, 60, 40); pts.set(1, { x: 60, y: 40 });`,
    `startReparent('a'); setCandidate('b');`,
  ]) {
    const t = setup({ renderUI: true });
    t.run(prepare);
    const expectedText = t.run(`state.editing ? '確定した編集' : state.map.nodes.a.text`);
    const request = mockInstruction(t, []);
    assert.equal(t.run(`!state.editing && !state.gesture && !state.mode && pts.size === 0`), true, prepare);
    assert.equal(t.run(`state.instruction.snapshot.nodes.a.text`), expectedText);
    assert.equal(
      t.run(`state.instruction.snapshot.nodes.a.x === 310 && state.instruction.snapshot.nodes.a.parent === 'root'`),
      true,
    );
    assert.equal(t.run(`state.instruction.revision === state.revision`), true);
    request.finish();
    await request.pending;
  }
});

test('manual deletion and instruction dialogs block sending before editing is settled', async () => {
  for (const block of [`state.deletion = {};`, `$('#instructionDialog').open = true;`]) {
    const t = setup({ renderUI: true });
    t.run(`startEdit('a'); nodeEls.get('a').nodeText.textContent = '未確定'; ${block}`);
    const request = mockInstruction(t, []);
    await request.pending;
    assert.equal(t.run(`!!state.editing && !state.instruction && state.history.length === 0`), true);
  }
});

test('instructions apply multiple operations as one undo/redo entry and share export serialization', async () => {
  const t = setup();
  const before = t.run('JSON.stringify(serializeMap())');
  const request = mockInstruction(t, [
    { type: 'add_node', clientId: 'new_1', parentId: 'b', text: '本を借りる' },
    { type: 'add_node', clientId: 'new_2', parentId: 'new_1', text: '返却する' },
  ]);
  assert.equal(t.run('Object.keys(state.map.nodes).length'), 7);
  request.finish();
  await request.pending;
  assert.equal(
    t.run('Object.keys(state.map.nodes).length === 9 && state.history.length === 1 && state.instruction === null'),
    true,
  );
  assert.equal(t.elements.get('#promptInput').value, '');
  t.run('undo()');
  assert.equal(t.run('JSON.stringify(state.map)'), before);
  t.run('redo()');
  assert.equal(t.run('Object.keys(state.map.nodes).length'), 9);
});

test('a bad later instruction leaves the map and history intact', async () => {
  const t = setup();
  const before = t.run('JSON.stringify(state.map)');
  const request = mockInstruction(t, [
    { type: 'add_node', clientId: 'new_1', parentId: 'b', text: '本' },
    { type: 'reparent_node', nodeId: 'root', parentId: 'new_1' },
  ]);
  request.finish();
  await request.pending;
  assert.equal(t.run('JSON.stringify(state.map)'), before);
  assert.equal(t.run('state.history.length'), 0);
  assert.equal(t.elements.get('#promptInput').value, '指示');
});

test('instructions reject edits, undo cycles, imports, and unfinished gestures while selection changes are allowed', async () => {
  for (const action of [
    "commit(() => { state.map.nodes.a.text = '変更'; });",
    "commit(() => { state.map.nodes.a.text = '変更'; }); undo();",
    'importMap(sample());',
    "state.gesture = { type: 'node' };",
    "state.editing = { id: 'a' };",
    'state.mode = {};',
    'state.deletion = {};',
    "state.hand = { grab: 'a' };",
  ]) {
    const t = setup();
    const request = mockInstruction(t, [{ type: 'update_node', nodeId: 'b', text: '新しい本' }]);
    await t.run(action);
    request.finish();
    await request.pending;
    assert.equal(t.run('state.map.nodes.b.text'), '図書館に行く', action);
    assert.match(t.elements.get('#instructionToast').textContent, /マップが変わった/);
  }
  const t = setup();
  const request = mockInstruction(t, [{ type: 'update_node', nodeId: 'b', text: '新しい本' }]);
  t.run("state.selectedId = 'a';");
  request.finish();
  await request.pending;
  assert.equal(t.run("state.map.nodes.b.text === '新しい本' && state.selectedId === 'a'"), true);
});

test('mixed deletion stays atomic and can be cancelled or confirmed after changing scopes', async () => {
  const t = setup();
  const request = mockInstruction(t, [
    { type: 'add_node', clientId: 'new_1', parentId: 'b', text: '本' },
    { type: 'delete_node', nodeId: 'a', scope: 'single' },
  ]);
  request.finish();
  await request.pending;
  assert.equal(
    t.run(
      "state.instruction.state === 'awaiting_confirmation' && Object.keys(state.map.nodes).length === 7 && state.history.length === 0",
    ),
    true,
  );
  t.run("state.instruction.proposal.operations[1].scope = 'subtree'; updateInstructionPreview(); applyInstruction();");
  assert.equal(
    t.run(
      '!state.map.nodes.a && !state.map.nodes.a1 && Object.keys(state.map.nodes).length === 6 && state.history.length === 1',
    ),
    true,
  );
  t.run('undo()');
  assert.equal(t.run('Object.keys(state.map.nodes).length'), 7);
  const second = mockInstruction(t, [{ type: 'delete_node', nodeId: 'a', scope: 'single' }]);
  second.finish();
  await second.pending;
  t.run('cancelInstruction()');
  assert.equal(t.run('!!state.map.nodes.a && state.instruction === null && state.history.length === 0'), true);
});

test('deletion scope validation can recover from an invalid combination', async () => {
  const t = setup();
  const request = mockInstruction(t, [
    { type: 'delete_node', nodeId: 'a', scope: 'single' },
    { type: 'update_node', nodeId: 'a1', text: '残す' },
  ]);
  request.finish();
  await request.pending;
  t.run("state.instruction.proposal.operations[0].scope = 'subtree'; updateInstructionPreview();");
  assert.equal(t.elements.get('#instructionConfirm').disabled, true);
  t.run("state.instruction.proposal.operations[0].scope = 'single'; updateInstructionPreview();");
  assert.equal(t.elements.get('#instructionConfirm').disabled, false);
  t.run('applyInstruction()');
  assert.equal(t.run("state.map.nodes.a1.text === '残す' && state.map.nodes.a1.parent === 'root'"), true);
});

test('late cancelled results cannot apply and an edited draft survives success', async () => {
  const t = setup();
  const request = mockInstruction(t, [{ type: 'update_node', nodeId: 'b', text: '新しい本' }]);
  t.run('cancelInstruction()');
  request.finish();
  await request.pending;
  assert.equal(t.run('state.map.nodes.b.text'), '図書館に行く');
  const next = mockInstruction(t, [{ type: 'update_node', nodeId: 'b', text: '新しい本' }]);
  t.run("$('#promptInput').value = '次の指示'; state.draftVersion++;");
  next.finish();
  await next.pending;
  assert.equal(t.elements.get('#promptInput').value, '次の指示');
  const button = t.run('instructionUndoButton');
  assert.equal(button.disabled, false);
  t.run("commit(() => { state.map.nodes.a.text = '編集'; }); undo();");
  assert.equal(button.disabled, true);
});

test('IME Enter does not submit, Shift Enter stays a newline, plain Enter submits', () => {
  const t = setup();
  t.run('let sends = 0; sendInstruction = () => { sends++; };');
  const key = t.elements.get('#promptInput').onkeydown;
  let prevented = 0;
  const press = opts =>
    key({
      key: 'Enter',
      preventDefault() {
        prevented++;
      },
      ...opts,
    });
  press({ isComposing: true });
  press({ keyCode: 229 });
  press({ shiftKey: true });
  assert.equal(t.run('sends'), 0);
  assert.equal(prevented, 0);
  press({});
  assert.equal(t.run('sends'), 1);
  assert.equal(prevented, 1);
});

function prepareHand(t) {
  t.run(`
    state.map.nodes.root.x = 0; state.map.nodes.root.y = 0;
    state.map.nodes.a.x = 200; state.map.nodes.a.y = 0;
    state.map.nodes.a1.x = 400; state.map.nodes.a1.y = 0;
    state.map.nodes.b.x = -200; state.map.nodes.b.y = 200;
    state.view = { x: 600, y: 340, s: 1 };
    for (const n of Object.values(state.map.nodes)) {
      nodeEl(n.id).getBoundingClientRect = () => ({
        left: state.view.x + n.x * state.view.s - 60 * state.view.s, right: state.view.x + n.x * state.view.s + 60 * state.view.s,
        top: state.view.y + n.y * state.view.s - 25 * state.view.s, bottom: state.view.y + n.y * state.view.s + 25 * state.view.s });
    }
    state.selectedId = 'root'; toggleHand(); let handTime = 0;
    const handSample = (x = .5, y = .5, ratio = .8, pose = ratio >= .55 ? 'palm' : null) => {
      cameraSession.io.frame({ pointer: { x, y }, wrist: { x: .5, y: .7 }, ratio, pose, identity: 'Left' }, handTime);
      handTime += 50;
    };
    const stableHand = (x = .5, y = .5, ratio = .8, pose = ratio >= .55 ? 'palm' : null) => { for (let i = 0; i < 3; i++) handSample(x, y, ratio, pose); };
    stableHand(); const originalMap = JSON.stringify(state.map);
  `);
}

function radialBranch() {
  const t = setup();
  t.run(`Object.assign(state.map.nodes.root, { x: 527, y: 455 }); Object.assign(state.map.nodes.a, { x: 926, y: 438 });
    for (const [id, x, y] of [['math', 777, 306], ['study', 918, 238], ['social', 1064, 294], ['japanese', 1127, 437], ['science', 1054, 585]]) state.map.nodes[id] = { id, text: id, parent: 'a', x, y, order: ++state.map.seq };
    delete state.map.nodes.a1; invalidateTree();`);
  const press = (key, from) => {
    if (from) t.run(`select('${from}')`);
    t.windowHandlers.get('keydown')({ key, target: t.elements.get('#viewport'), preventDefault() {} });
    return t.run('state.selectedId');
  };
  return { t, press };
}

test('Shift Left returns from every right-branch sibling to its actual parent without editing the map', () => {
  const { t, press } = radialBranch();
  t.run('const beforeParentNavigation = JSON.stringify(state.map);');
  for (const id of ['math', 'study', 'social', 'japanese', 'science', 'a']) {
    t.run(`select('${id}')`);
    t.windowHandlers.get('keydown')({
      key: 'ArrowLeft',
      shiftKey: true,
      target: t.elements.get('#viewport'),
      preventDefault() {},
    });
    assert.equal(t.run('state.selectedId'), id === 'a' ? 'root' : 'a');
  }
  assert.equal(
    t.run('JSON.stringify(state.map) === beforeParentNavigation && state.history.length === 0 && !autosave.dirty'),
    true,
  );
  assert.equal(press('ArrowLeft', 'math'), 'a');
  assert.equal(press('ArrowRight', 'a'), 'math');
});

test('Alt Shift Left still moves nodes and Shift Left does not escape editing or reparent mode', () => {
  const { t } = radialBranch();
  const key = options =>
    t.windowHandlers.get('keydown')({
      key: 'ArrowLeft',
      shiftKey: true,
      target: t.elements.get('#viewport'),
      preventDefault() {},
      ...options,
    });
  t.run("select('math'); const originalX = state.map.nodes.math.x;");
  key({ altKey: true });
  assert.equal(
    t.run("state.selectedId === 'math' && state.map.nodes.math.x === originalX - 24 && state.history.length === 1"),
    true,
  );
  t.run("state.editing = { id: 'math' };");
  key();
  assert.equal(t.run('state.selectedId'), 'math');
  t.run(
    "state.editing = null; state.mode = { id: 'math', candidate: null }; let candidateKey = null; navigate = k => { candidateKey = k; }; setCandidate = () => {};",
  );
  key();
  assert.equal(t.run("candidateKey === 'ArrowLeft' && state.selectedId === 'math'"), true);
});

test('right branch enters the first child and walks siblings with Up/Down', () => {
  const { t, press } = radialBranch();
  t.run('const beforeNavigation = JSON.stringify(state.map);');
  assert.deepEqual(
    [press('ArrowRight', 'a'), ...Array.from({ length: 4 }, () => press('ArrowDown'))],
    ['math', 'study', 'social', 'japanese', 'science'],
  );
  assert.equal(press('ArrowDown'), 'science');
  assert.deepEqual(
    Array.from({ length: 4 }, () => press('ArrowUp')),
    ['japanese', 'social', 'study', 'math'],
  );
  assert.equal(press('ArrowUp'), 'math');
  for (const id of ['math', 'study', 'social', 'japanese', 'science']) {
    assert.equal(press('ArrowLeft', id), 'a');
  }
  assert.equal(press('ArrowLeft', 'a'), 'root');
  assert.equal(
    t.run(
      'JSON.stringify(state.map) === beforeNavigation && state.history.length === 0 && state.future.length === 0 && !autosave.dirty',
    ),
    true,
  );
  assert.equal(t.timers.size, 0);
});

test('child entry ignores a previously selected middle or last child', () => {
  const { press } = radialBranch();
  for (const child of ['social', 'science']) {
    assert.equal(press('ArrowLeft', child), 'a');
    assert.equal(press('ArrowRight'), 'math');
  }
});

test('leaves and sibling endpoints stop despite nearby nodes, grandchildren and other branches', () => {
  const { t, press } = radialBranch();
  t.run(`state.map.nodes.near = { id: 'near', text: 'near', parent: 'b', x: 1300, y: 585 };
    state.map.nodes.child = { id: 'child', text: 'child', parent: 'science', x: 1080, y: 650 };
    invalidateTree();`);
  assert.equal(press('ArrowUp', 'math'), 'math');
  assert.equal(press('ArrowDown', 'science'), 'science');
  assert.equal(press('ArrowRight', 'japanese'), 'japanese');
  assert.equal(press('ArrowRight', 'science'), 'child');
  assert.equal(press('ArrowDown', 'social'), 'japanese');
  assert.equal(press('ArrowLeft', 'science'), 'a');
});

test('all four branch directions use one axis for hierarchy and the other for siblings', () => {
  for (const [out, inward, next, previous, transform] of [
    ['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp', '(x, y) => [x, y]'],
    ['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', '(x, y) => [-x, y]'],
    ['ArrowUp', 'ArrowDown', 'ArrowRight', 'ArrowLeft', '(x, y) => [y, -x]'],
    ['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', '(x, y) => [y, x]'],
  ]) {
    const { t, press } = radialBranch();
    t.run(`const rotate = ${transform};
      for (const n of Object.values(state.map.nodes)) {
        const [x, y] = rotate(n.x - 527, n.y - 455); Object.assign(n, { x, y });
      }
      state.map.nodes.child = { id: 'child', text: 'child', parent: 'social', x: state.map.nodes.social.x, y: state.map.nodes.social.y };
      invalidateTree();`);
    assert.deepEqual(
      [press(out, 'a'), ...Array.from({ length: 4 }, () => press(next))],
      ['math', 'study', 'social', 'japanese', 'science'],
      out,
    );
    assert.equal(press(next), 'science');
    assert.deepEqual(
      Array.from({ length: 4 }, () => press(previous)),
      ['japanese', 'social', 'study', 'math'],
    );
    assert.equal(press(previous), 'math');
    for (const child of ['math', 'study', 'social', 'japanese', 'science']) {
      assert.equal(press(inward, child), 'a');
    }
    assert.equal(press(out, 'social'), 'child');
    assert.equal(press(inward), 'social');
    assert.equal(press(next), 'japanese');
    assert.equal(press(out), 'japanese');
    assert.equal(press(inward, 'a'), 'root');
  }
});

test('first-level sibling keys do not enter their children', () => {
  const { t, press } = radialBranch();
  t.run(`state.map.nodes.b.x = 927; state.map.nodes.b.y = 800;`);
  assert.equal(press('ArrowDown', 'a'), 'b');
  assert.equal(press('ArrowUp', 'a'), 'c');
});

test('endpoint ordering follows coordinates with deterministic distance and ID ties', () => {
  const { t, press } = radialBranch();
  t.run(`state.map.nodes.science.x = 600; state.map.nodes.science.y = 400;
    for (const n of childrenOf('a')) n.order = 100 - n.y;
    const storedOrder = JSON.stringify(childrenOf('a').map(n => [n.id, n.order]));`);
  assert.equal(press('ArrowRight', 'a'), 'science');
  assert.equal(press('ArrowDown'), 'math');
  assert.equal(t.run("JSON.stringify(childrenOf('a').map(n => [n.id, n.order])) === storedOrder"), true);
  t.run(`for (const n of childrenOf('a')) Object.assign(n, { x: 926, y: 438 });`);
  assert.deepEqual(
    [press('ArrowRight', 'a'), ...Array.from({ length: 4 }, () => press('ArrowDown'))],
    ['japanese', 'math', 'science', 'social', 'study'],
  );
  assert.equal(press('ArrowDown'), 'study');
  t.run(`for (const n of childrenOf('a')) Object.assign(n, { x: 1126, y: 438 });
    state.map.nodes.study.x = 1026;`);
  assert.equal(press('ArrowRight', 'a'), 'study');
});

test('normal pointer input takes priority and retains undoable subtree dragging', () => {
  const t = setup();
  prepareHand(t);
  const handlers = t.elements.get('#viewport').handlers;
  handlers.pointerdown(mouse(100, 100, 'a'));
  t.run(`stableHand(.1);`);
  handlers.pointermove(mouse(140, 100));
  handlers.pointerup(mouse(140, 100));
  assert.equal(
    t.run(`state.map.nodes.a.x === 240 && state.map.nodes.a1.x === 440 && state.history.length === 1`),
    true,
  );
  t.run('undo();');
  assert.equal(t.run('JSON.stringify(state.map) === originalMap'), true);
});

for (const event of ['blur', 'pagehide', 'visibilitychange'])
  test(`${event} stops camera and retains the active node`, () => {
    const t = setup();
    prepareHand(t);
    t.run(`const session = cameraSession; handSample(.4);`);
    if (event === 'visibilitychange') {
      t.run('document.hidden = true;');
      t.documentHandlers.get(event)();
    } else t.windowHandlers.get(event)();
    assert.equal(
      t.run(
        `session.stopped && !state.hand && !cameraSession && !state.gesture && state.selectedId === 'a' && JSON.stringify(state.map) === originalMap`,
      ),
      true,
    );
  });

test('editing and reparent mode block palm selection and pinch', () => {
  for (const block of ["state.editing = { id: 'root' }", "startReparent('b')"]) {
    const t = setup();
    prepareHand(t);
    t.run(block);
    const selected = t.run('state.selectedId');
    t.run(`stableHand(.1); stableHand(.1, .5, .1);`);
    assert.equal(t.run('state.selectedId'), selected);
    assert.equal(
      t.run(`!state.gesture && state.history.length === 0 && JSON.stringify(state.map) === originalMap`),
      true,
    );
  }
});

test('camera UI shows each message in one place with tips for the current state', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  const help = t.elements.get('#handHelp'),
    msg = t.elements.get('#camMsg'),
    tips = () =>
      t.elements
        .get('#handTips')
        .children.map(c => c.textContent)
        .join();
  assert.match(help.textContent, /パーで近くのノードを選択/);
  assert.equal(msg.hidden, true);
  assert.equal(msg.textContent, '');
  assert.match(tips(), /パー.*子を追加.*削除.*マップ移動/);
  assert.equal(t.elements.get('#cam').dataset.state, 'ready');
  assert.equal(t.elements.get('#handCursor').hidden, false);
  t.run('interruptHand(); handSample();');
  assert.match(help.textContent, /パーを少し静止して準備/);
  t.run('handSample(.5, .5, .1);');
  assert.match(help.textContent, /ニュートラル/);
  t.run('cameraSession.io.frame(null, handTime);');
  assert.match(msg.textContent, /見失いました/);
  assert.equal(msg.hidden, false);
  assert.equal(help.textContent, '');
  assert.equal(tips(), '');
  t.run(`cameraSession.io.status(tr('cam.preparing'));`);
  assert.match(msg.textContent, /準備/);
  assert.equal(t.elements.get('#cam').dataset.state, 'starting');
  t.run(`cameraSession.io.status('');`);
  assert.match(msg.textContent, /見失いました/);
});

test('two-hand zoom anchors viewport center, clamps scale and leaves nodes/history intact', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  t.run(`
    const zoomSample = distance => { cameraSession.io.frame({ hands: 2, pose: 'bothFists', distance, palms: [{ x: .5 - distance / 2, y: .5 }, { x: .5 + distance / 2, y: .5 }] }, handTime); handTime += 50; };
    const centerBefore = { x: (viewportWidth()/2-state.view.x)/state.view.s, y: (canvasHeight()/2-state.view.y)/state.view.s };
    const scaleBefore = state.view.s;
    zoomSample(.4); zoomSample(.4); zoomSample(.4); zoomSample(.5);
  `);
  assert.equal(t.run('state.view.s < scaleBefore'), true);
  assert.equal(
    t.run(
      'Math.abs((viewportWidth()/2-state.view.x)/state.view.s-centerBefore.x) < 1e-8 && Math.abs((canvasHeight()/2-state.view.y)/state.view.s-centerBefore.y) < 1e-8',
    ),
    true,
  );
  assert.match(t.elements.get('#handHelp').textContent, /ズーム中/);
  assert.equal(t.elements.get('#camMsg').hidden, true);
  t.run('zoomSample(.4);');
  assert.equal(t.run('Math.abs(state.view.s-scaleBefore) < 1e-8'), true);
  t.run('state.view.s = ZMAX; zoomSample(.3);');
  assert.equal(t.run('state.view.s === ZMAX'), true);
  t.run('state.view.s = ZMIN; zoomSample(.4);');
  assert.equal(
    t.run('state.view.s === ZMIN && state.history.length === 0 && JSON.stringify(state.map) === originalMap'),
    true,
  );
});

test('pinching never moves nodes before zooming, and editing blocks zoom', () => {
  const t = setup();
  prepareHand(t);
  t.run(`stableHand(.5, .5, .1); handSample(.3, .5, .1);
    const zoomSample = distance => { cameraSession.io.frame({ hands: 2, pose: 'bothFists', distance, palms: [{ x: .5 - distance / 2, y: .5 }, { x: .5 + distance / 2, y: .5 }] }, handTime); handTime += 50; };
    zoomSample(.4); zoomSample(.4); zoomSample(.4); zoomSample(.5);`);
  assert.equal(
    t.run('!state.gesture && state.history.length === 0 && JSON.stringify(state.map) === originalMap'),
    true,
  );
  t.run(`const zoomBeforeEditing = state.view.s; state.editing = { id: 'root' }; zoomSample(.4); zoomSample(.3);`);
  assert.equal(t.run('state.view.s === zoomBeforeEditing && state.hand.state === "blocked"'), true);
});

test('single fist pans and opening a hand or pointing stops the view', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  t.run(`
    const poseSample = (pose, x = .5) => { cameraSession.io.frame({ pointer: { x, y: .5 }, wrist: { x: .5, y: .7 }, ratio: .8, pose }, handTime); handTime += 50; };
    const beforeSinglePan = { ...state.view };
    poseSample('fist'); poseSample('fist'); poseSample('fist'); poseSample('fist', .4);
  `);
  assert.equal(
    t.run(
      'state.view.x > beforeSinglePan.x && state.view.s === beforeSinglePan.s && state.history.length === 0 && JSON.stringify(state.map) === originalMap',
    ),
    true,
  );
  assert.match(t.elements.get('#handHelp').textContent, /マップを移動中/);
  t.run(`const afterSinglePan = { ...state.view }; for (let i = 0; i < 10; i++) poseSample(null, .2 + i * .03);`);
  assert.equal(
    t.run('JSON.stringify(state.view) === JSON.stringify(afterSinglePan) && state.hand.state === "neutral"'),
    true,
  );
  t.run(`for (let i = 0; i < 60; i++) poseSample('point');`);
  assert.equal(t.run('state.hand.state === "neutral" && !handController.paused && state.history.length === 0'), true);
});

test('manual deletions and reparenting match instruction preparation and each undo as one change', () => {
  const cases = [
    {
      operation: { type: 'delete_node', nodeId: 'a', scope: 'single' },
      edit: "removeNode('a'); chooseDeleteScope('single'); confirmDelete();",
    },
    {
      operation: { type: 'delete_node', nodeId: 'a', scope: 'subtree' },
      edit: "removeNode('a'); chooseDeleteScope('branch'); confirmDelete();",
    },
    {
      operation: { type: 'reparent_node', nodeId: 'a', parentId: 'b1' },
      edit: "startReparent('a'); setCandidate('b1'); confirmReparent();",
    },
  ];
  for (const { operation, edit } of cases) {
    const { run } = setup();
    run(`
      addNode('a', 'second child', { x: 450, y: 20 });
      addNode('a1', 'grandchild', { x: 600, y: -200 });
      const before = serializeMap();
      const expected = InstructionOperations.prepare(before, ${JSON.stringify({
        status: 'ok',
        message: '',
        operations: [operation],
      })}).map;
      ${edit}
    `);
    assert.equal(run('MapHistory.same(state.map, expected) && valid(state.map)'), true);
    assert.equal(run('state.history.length'), 1);
    run('undo();');
    assert.equal(run('MapHistory.same(state.map, before)'), true);
    run('redo();');
    assert.equal(run('MapHistory.same(state.map, expected)'), true);
  }
});

test('single deletion promotes direct children in place, preserves descendants and sibling order, and undoes atomically', () => {
  const t = setup({ renderUI: true });
  t.run(`render(); let d, secondChild; commit(() => { d = addNode('a1', '孫', { x: 600, y: -200 }); secondChild = addNode('a', '二つ目', { x: 500, y: 20 }); });
    const beforeDelete = JSON.stringify(state.map), beforeHistory = state.history.length;
    removeNode('a');`);
  assert.equal(
    t.run(
      `state.deletion.id === 'a' && state.deletion.scope === null && JSON.stringify(state.map) === beforeDelete && $('#deleteConfirm').disabled`,
    ),
    true,
  );
  assert.equal(t.run(`document.activeElement === $('#deleteCancel')`), true);
  t.run(`confirmDelete();`);
  assert.equal(t.run(`JSON.stringify(state.map) === beforeDelete`), true);
  t.run(`chooseDeleteScope('single');`);
  assert.equal(
    t.run(
      `edgeEls.get('a1').attributes.d === curve(state.map.nodes.root, state.map.nodes.a1) && state.map.nodes.a1.parent === 'a' && state.history.length === beforeHistory`,
    ),
    true,
  );
  t.run(`confirmDelete();`);
  assert.equal(
    t.run(
      `!state.deletion && !state.map.nodes.a && state.map.nodes.a1.parent === 'root' && state.map.nodes[d].parent === 'a1' && state.selectedId === 'root' && valid(state.map) && state.history.length === beforeHistory + 1`,
    ),
    true,
  );
  assert.equal(
    t.run(
      `childrenOf('root').map(n => n.id).join(',') === ['a1', secondChild, 'b', 'c'].join(',') && state.map.nodes[secondChild].parent === 'root'`,
    ),
    true,
  );
  assert.equal(
    t.run(`state.map.nodes.a1.x === 540 && state.map.nodes.a1.y === -220 && state.map.nodes[d].x === 600`),
    true,
  );
  t.run('undo();');
  assert.equal(t.run('MapHistory.same(state.map, JSON.parse(beforeDelete))'), true);
  t.run('redo();');
  assert.equal(t.run(`!state.map.nodes.a && state.map.nodes[d].parent === 'a1' && valid(state.map)`), true);
});

test('branch deletion removes all descendants only after confirmation; cancellation leaves history and saves untouched', () => {
  const t = setup();
  t.run(`const before = JSON.stringify(state.map); removeNode('a'); chooseDeleteScope('branch'); closeDelete();`);
  assert.equal(t.run(`JSON.stringify(state.map) === before && state.history.length === 0 && !state.deletion`), true);
  assert.equal(t.timers.size, 0);
  t.run(`removeNode('a'); chooseDeleteScope('branch'); confirmDelete();`);
  assert.equal(
    t.run(
      `!state.map.nodes.a && !state.map.nodes.a1 && !!state.map.nodes.b && state.history.length === 1 && state.selectedId === 'root'`,
    ),
    true,
  );
  t.run('undo();');
  assert.equal(t.run('MapHistory.same(state.map, JSON.parse(before))'), true);
});

test('leaf deletion, root protection, stale confirmation and fixed target', async () => {
  const t = setup();
  t.run(`removeNode('root');`);
  assert.equal(t.run('state.deletion'), null);
  t.run(`removeNode('a1'); state.selectedId = 'b'; confirmDelete();`);
  assert.equal(t.run(`!state.map.nodes.a1 && !!state.map.nodes.b && state.selectedId === 'a'`), true);
  t.run(`undo(); removeNode('a'); chooseDeleteScope('branch'); state.map.nodes.a.text = '変更後'; confirmDelete();`);
  assert.equal(
    t.run(`!!state.map.nodes.a && state.deletion.scope === null && $('#deleteTitle').textContent.includes('変更後')`),
    true,
  );
  // A queued native close event from the old dialog must not dismiss the refreshed one.
  t.elements.get('#deleteDialog').handlers.close();
  assert.equal(t.run(`!!state.deletion && $('#deleteDialog').open`), true);
  await assert.rejects(t.run('importMap(sample())'), /操作を終えて/);
  t.run(`closeDelete();`);
});

test('delete key opens the shared dialog; Escape cancels without deleting', () => {
  const t = setup();
  t.run(`state.selectedId = 'a';`);
  const target = t.elements.get('#viewport');
  t.windowHandlers.get('keydown')({ key: 'Delete', target, preventDefault() {} });
  assert.equal(t.run(`state.deletion.id === 'a' && !!state.map.nodes.a`), true);
  t.windowHandlers.get('keydown')({ key: 'Escape', target, preventDefault() {} });
  assert.equal(t.run('!state.deletion && !!state.map.nodes.a && state.history.length === 0'), true);
});

test('peace adds and edits one child per hold; empty edit cancels and committed text is undoable', () => {
  const t = setup({ renderUI: true, handUI: true });
  prepareHand(t);
  t.run(`
    const commandSample = pose => { cameraSession.io.frame({ pointer: { x: .5, y: .5 }, wrist: { x: .5, y: .7 }, ratio: .8, pose }, handTime); handTime += 50; };
    for (let i = 0; i < 14; i++) commandSample('peace');
    const newId = state.editing.id;
  `);
  assert.equal(
    t.run(
      `state.editing.isNew && state.map.nodes[newId].parent === 'root' && Object.keys(state.map.nodes).length === 8`,
    ),
    true,
  );
  t.run(`for (let i = 0; i < 20; i++) commandSample('peace'); nodeEls.get(newId).nodeText.textContent = '新しい考え'; finishEdit();
    for (let i = 0; i < 14; i++) commandSample('peace');`);
  assert.equal(
    t.run(`!state.editing && state.history.length === 1 && state.map.nodes[newId].text === '新しい考え'`),
    true,
  );
  t.run(`undo();`);
  assert.equal(t.run('JSON.stringify(state.map) === originalMap'), true);
  t.run(`stableHand(); for (let i = 0; i < 14; i++) commandSample('peace'); cancelEdit();`);
  assert.equal(
    t.run('JSON.stringify(state.map) === originalMap && !state.editing && state.history.length === 0'),
    true,
  );
});

test('thumb-down opens confirmation once, palm chooses scope and thumb-right confirms without pinch', () => {
  const t = setup({ renderUI: true, handUI: true });
  prepareHand(t);
  t.run(`state.selectedId = 'a';
    const dialogSample = (pose = null, ratio = .8, y = .5) => { cameraSession.io.frame({ pointer: { x: .5, y }, wrist: { x: .5, y: .7 }, ratio, pose }, handTime); handTime += 50; };
    for (let i = 0; i < 14; i++) dialogSample('thumbDown');
  `);
  assert.equal(
    t.run(
      `state.deletion.id === 'a' && JSON.stringify(state.map) === originalMap && document.activeElement === $('#deleteCancel')`,
    ),
    true,
  );
  t.run(`for (let i = 0; i < 20; i++) dialogSample('thumbDown');
    for (let i = 0; i < 3; i++) dialogSample('palm'); dialogSample('palm', .8, .4);
    for (let i = 0; i < 14; i++) dialogSample(null, .1, .4);`);
  assert.equal(t.run(`state.deletion.scope === 'branch' && !!state.map.nodes.a && !state.gesture`), true);
  t.run(`for (let i = 0; i < 3; i++) dialogSample('palm'); dialogSample('palm', .8, .6);
    for (let i = 0; i < 6; i++) dialogSample('palm', .8, .6); dialogSample('palm', .8, .7);
    for (let i = 0; i < 14; i++) dialogSample(null, .1, .7);
    if (!state.deletion || !state.map.nodes.a) throw new Error('Pinch confirmed state.deletion');
    for (let i = 0; i < 14; i++) dialogSample('thumbRight');`);
  assert.equal(
    t.run(`!state.deletion && !state.map.nodes.a && !state.map.nodes.a1 && state.history.length === 1`),
    true,
  );
});

for (const fistFrames of [1, 8])
  for (const duringHold of [false, true])
    test(`thumb-down opens confirmation after ${fistFrames} stationary fist frames ${duringHold ? 'during' : 'before'} its hold`, () => {
      const t = setup({ renderUI: true, handUI: true });
      prepareHand(t);
      t.run(`state.selectedId = 'a';
    const dialogSample = pose => { cameraSession.io.frame({ pointer: { x: .5, y: .5 }, wrist: { x: .5, y: .7 }, ratio: .8, pose }, handTime); handTime += 50; };
    if (${duringHold}) for (let i = 0; i < 6; i++) dialogSample('thumbDown');
    for (let i = 0; i < ${fistFrames}; i++) dialogSample('fist');
    for (let i = 0; i < 12; i++) dialogSample('thumbDown');
  `);
      assert.equal(
        t.run(`!state.deletion && state.selectedId === 'a' && JSON.stringify(state.map) === originalMap`),
        true,
      );
      t.run(`dialogSample('thumbDown');`);
      assert.equal(
        t.run(
          `state.deletion.id === 'a' && $('#deleteDialog').open && JSON.stringify(state.map) === originalMap && document.activeElement === $('#deleteCancel')`,
        ),
        true,
      );
    });

test('thumb tilted left cancels the delete confirmation and tilted right confirms it', () => {
  const t = setup({ renderUI: true, handUI: true });
  prepareHand(t);
  t.run(`state.selectedId = 'b1';
    const dialogSample = pose => { cameraSession.io.frame({ pointer: { x: .5, y: .5 }, wrist: { x: .5, y: .7 }, ratio: .8, pose }, handTime); handTime += 50; };
    for (let i = 0; i < 14; i++) dialogSample('thumbDown');
    for (let i = 0; i < 14; i++) dialogSample('thumbLeft');`);
  assert.equal(t.run(`!state.deletion && !!state.map.nodes.b1 && state.history.length === 0`), true);
  t.run(`for (let i = 0; i < 4; i++) dialogSample(null); for (let i = 0; i < 14; i++) dialogSample('thumbDown');
    for (let i = 0; i < 14; i++) dialogSample('thumbRight');`);
  assert.equal(t.run(`!state.deletion && !state.map.nodes.b1 && state.history.length === 1`), true);
});

test('Space edits with all selected, Shift+Space and F2 edit at the end, Enter adds a sibling', () => {
  const t = setup({ renderUI: true });
  t.run(`state.selectedId = 'a';`);
  const press = (key, opts = {}) =>
    t.windowHandlers.get('keydown')({ key, target: t.elements.get('#viewport'), preventDefault() {}, ...opts });
  const collapsed = [];
  t.context.document.createRange = () => ({
    selectNodeContents() {},
    collapse(toStart) {
      collapsed.push(toStart);
    },
  });
  press(' ');
  assert.equal(t.run(`state.editing.id === 'a' && !state.editing.isNew`), true);
  assert.deepEqual(collapsed, []);
  t.run(`cancelEdit();`);
  press(' ', { shiftKey: true });
  assert.deepEqual(collapsed, [false]);
  t.run(`cancelEdit();`);
  press('F2');
  assert.deepEqual(collapsed, [false, false]);
  t.run(`cancelEdit();`);
  press('Enter');
  assert.equal(
    t.run(`state.editing.isNew && state.map.nodes[state.editing.id].parent === state.map.nodes.a.parent`),
    true,
  );
  t.run(`cancelEdit(); state.selectedId = state.map.root;`);
  press('Enter');
  assert.equal(t.run(`state.editing.isNew && state.map.nodes[state.editing.id].parent === state.map.root`), true);
});

test('view and screen shortcuts zoom, focus the prompt and open the key list', () => {
  const t = setup();
  t.run(`state.selectedId = 'a'; state.view = { x: 0, y: 0, s: 1 }; document.body = $('body');`);
  const press = (key, opts = {}) =>
    t.windowHandlers.get('keydown')({ key, target: t.elements.get('#viewport'), preventDefault() {}, ...opts });
  press('=', { metaKey: true });
  assert.equal(t.run('state.view.s'), 1.25);
  press('-', { ctrlKey: true });
  press('-', { ctrlKey: true });
  assert.equal(t.run('state.view.s'), 0.8);
  press('0', { metaKey: true });
  assert.equal(t.run('state.view.s'), 1);
  press('@', { code: 'Digit2', shiftKey: true });
  assert.equal(t.run('state.view.s'), 1.5);
  press('k', { metaKey: true });
  assert.equal(t.context.document.activeElement, t.elements.get('#promptInput'));
  press('?', { shiftKey: true });
  assert.equal(t.elements.get('#keysDialog').open, true);
});

test('Shift+H toggles hand input; plain h and typing in the prompt field do not', () => {
  const t = setup({ handUI: true });
  const press = (target, opts = { key: 'H', code: 'KeyH', shiftKey: true }) =>
    t.windowHandlers.get('keydown')({ target, preventDefault() {}, ...opts });
  press(t.elements.get('#viewport'), { key: 'h', code: 'KeyH' });
  assert.equal(t.run('cameraSession'), null);
  press(t.elements.get('#viewport'));
  assert.equal(t.run('!!cameraSession'), true);
  press(t.elements.get('#viewport'));
  assert.equal(t.run('cameraSession'), null);
  press({ closest: sel => sel === 'input, textarea' });
  assert.equal(t.run('cameraSession'), null);
});

test('two fists with missing palm positions cannot move the view or change nodes, selection or history', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  t.run(`const beforeFists = JSON.stringify(state.view), beforeSelection = state.selectedId;
    for (let i = 0; i < 20; i++) cameraSession.io.frame({ hands: 2, pose: 'bothFists', pointer: { x: .2 + i * .02, y: .3 }, distance: .4 }, handTime += 50);`);
  assert.equal(
    t.run(
      'JSON.stringify(state.view) === beforeFists && state.selectedId === beforeSelection && !state.gesture && JSON.stringify(state.map) === originalMap && state.history.length === 0',
    ),
    true,
  );
  assert.equal(t.elements.get('#handCursor').hidden, true);
});

function mockQuestions(t) {
  t.run(`var resolveConversation, conversationState, cancelledConversation = 0;
    instructionClient.run = (input, onState) => { conversationState = onState; return new Promise(resolve => { resolveConversation = resolve; }); };
    instructionClient.answer = async answer => { conversationState('thinking'); };
    instructionClient.cancel = () => { cancelledConversation++; };
    $('#promptInput').value = 'ノードを整理して';
  `);
  return t.run('sendInstruction()');
}
test('question UI accepts multiple replies and applies the final proposal as one history entry', async () => {
  const t = setup();
  const pending = mockQuestions(t);
  t.run(`conversationState('awaiting_input', {questionId:'q1', message:'対象は？'});`);
  assert.equal(
    t.run(
      `state.instruction.state === 'awaiting_input' && !$('#promptSend').disabled && $('#promptInput').value === '' && state.history.length === 0`,
    ),
    true,
  );
  assert.equal(t.elements.get('#promptQuestion').textContent, '対象は？');
  t.run(`$('#promptInput').value = '図書館'; state.draftVersion++;`);
  await t.run('sendInstruction()');
  assert.equal(t.run(`state.instruction.state === 'thinking' && $('#promptSend').disabled`), true);
  t.run(
    `conversationState('awaiting_input', {questionId:'q2', message:'名前は？'}); $('#promptInput').value = '新しい本'; state.draftVersion++;`,
  );
  await t.run('sendInstruction()');
  t.run(`resolveConversation({status:'ok',message:'',operations:[{type:'update_node',nodeId:'b',text:'新しい本'}]});`);
  await pending;
  assert.equal(
    t.run(
      `state.instruction === null && state.map.nodes.b.text === '新しい本' && state.history.length === 1 && $('#promptInput').value === '' && $('#promptQuestion').hidden`,
    ),
    true,
  );
  t.run('undo()');
  assert.equal(t.run('state.map.nodes.b.text'), '図書館に行く');
});
test('question UI preserves an edited draft and ends continuation when the map changes', async () => {
  const t = setup();
  const pending = mockQuestions(t);
  t.run(
    `$('#promptInput').value = '下書き'; state.draftVersion++; conversationState('awaiting_input', {questionId:'q1',message:'対象は？'});`,
  );
  assert.equal(t.elements.get('#promptInput').value, '下書き');
  t.run(`commit(() => { state.map.nodes.a.text = '変更'; });`);
  assert.equal(t.run(`state.instruction === null && cancelledConversation === 1 && $('#promptQuestion').hidden`), true);
  t.run(
    `resolveConversation({status:'ok',message:'',operations:[{type:'update_node',nodeId:'b',text:'不正な遅延結果'}]});`,
  );
  await pending;
  assert.equal(t.run('state.map.nodes.b.text'), '図書館に行く');
});
test('answer POST failures keep the question and typed answer available', async () => {
  const t = setup();
  const pending = mockQuestions(t);
  t.run(
    `conversationState('awaiting_input', {questionId:'q1',message:'対象は？'}); instructionClient.answer = async () => { throw new Error('通信失敗'); }; $('#promptInput').value = '図書館'; state.draftVersion++;`,
  );
  await t.run('sendInstruction()');
  assert.equal(
    t.run(
      `state.instruction.state === 'awaiting_input' && !$('#promptSend').disabled && !$('#promptQuestion').hidden && $('#promptInput').value === '図書館'`,
    ),
    true,
  );
  t.run(`cancelInstruction(); resolveConversation({status:'no_change',message:'',operations:[]});`);
  await pending;
});

test('image adoption fixes the original target and commits once; removal and node deletion undo references', async () => {
  const t = setup();
  t.run(`const imageRef = {assetId:'sha256:'+'a'.repeat(64),alt:'説明',width:1,height:1};
    imageStore.put = async () => imageRef;
    const imageTarget = {nodeId:'a',mapSessionId: state.mapSessionId,revision: state.revision}; state.selectedId='b';`);
  await t.run(`attachNodeImage(new Blob(['test']), imageTarget, '説明')`);
  assert.equal(t.run(`!!state.map.nodes.a.image && !state.map.nodes.b.image && state.history.length === 1`), true);
  t.run(`removeNodeImage('a'); undo();`);
  assert.equal(t.run(`state.map.nodes.a.image.assetId === imageRef.assetId && state.history.length === 1`), true);
  t.run(`redo();`);
  assert.equal(t.run(`!state.map.nodes.a.image`), true);
  t.run(`undo(); removeNode('a'); chooseDeleteScope('branch'); confirmDelete(); undo();`);
  assert.equal(t.run(`state.map.nodes.a.image.assetId === imageRef.assetId`), true);
});
test('adoption after a storage await rejects edits, undo, import, deletion and active gestures without adding history', async () => {
  for (const change of [
    "commit(()=>state.map.nodes.a.text='変更')",
    'undo()',
    'importMap(sample())',
    'commit(()=>delete state.map.nodes.a1)',
    'state.gesture={type:"node"}',
    'state.hand={grab:"a1"}',
    'state.editing={id:"a"}',
    'state.mode={}',
    'state.deletion={}',
    'state.instruction={state:"awaiting_confirmation"}',
    'state.mapClaim.editable=false',
  ]) {
    const t = setup();
    t.run(`commit(()=>state.map.nodes.b.text='編集'); let saved;
      imageStore.put = () => new Promise(resolve=>saved=resolve);
      const target={nodeId:'a1',mapSessionId: state.mapSessionId,revision: state.revision};`);
    const pending = t.run(`attachNodeImage(new Blob(['test']),target,'説明')`);
    await t.run(change);
    t.run(`var historyAfterChange=state.history.length; saved({assetId:'sha256:'+'a'.repeat(64),width:1,height:1});`);
    await assert.rejects(pending, /保存中/);
    assert.equal(t.run(`!state.map.nodes.a1?.image && state.history.length === historyAfterChange`), true);
  }
});
test('AI deletion confirmation blocks image attachment but image removal invalidates the confirmation', async () => {
  const t = setup();
  t.run(`state.map.nodes.a.image={assetId:'sha256:'+'a'.repeat(64),alt:'旧画像',width:1,height:1};
    let imageWrites=0; imageStore.put=async()=>{imageWrites++;};`);
  const request = mockInstruction(t, [{ type: 'delete_node', nodeId: 'b', scope: 'single' }]);
  request.finish();
  await request.pending;
  await assert.rejects(
    t.run(
      `attachNodeImage(new Blob(['test']), {nodeId:'a',mapSessionId:state.mapSessionId,revision:state.revision}, '画像')`,
    ),
    /操作中/,
  );
  assert.equal(
    t.run(`imageWrites === 0 && state.history.length === 0 && state.instruction.state === 'awaiting_confirmation'`),
    true,
  );
  t.run(`removeNodeImage('a');`);
  assert.equal(
    t.run(
      `!state.map.nodes.a.image && state.history.length === 1 && state.instruction === null && !$('#instructionDialog').open`,
    ),
    true,
  );
});
test('image adoption captures its target before storage and replacement is one undoable change', async () => {
  const t = setup();
  t.run(`const oldImage={assetId:'sha256:'+'a'.repeat(64),alt:'旧画像',width:1,height:1};
    const newImage={assetId:'sha256:'+'b'.repeat(64),width:2,height:3};
    state.map.nodes.a.image=oldImage; let saved;
    imageStore.put=()=>new Promise(resolve=>saved=resolve);
    const target={nodeId:'a',mapSessionId: state.mapSessionId,revision: state.revision};`);
  const pending = t.run(`attachNodeImage(new Blob(['test']),target,'新画像')`);
  assert.equal(t.run(`state.map.nodes.a.image === oldImage && state.history.length === 0`), true);
  t.run(`target.nodeId='b'; target.revision=-1; target.mapSessionId='other'; saved(newImage);`);
  await pending;
  assert.equal(
    t.run(
      `state.map.nodes.a.image.assetId === newImage.assetId && !state.map.nodes.b.image && state.history.length === 1`,
    ),
    true,
  );
  t.run('undo()');
  assert.equal(
    t.run(`state.map.nodes.a.image.assetId === oldImage.assetId && state.map.nodes.a.image.alt === '旧画像'`),
    true,
  );
  t.run('redo()');
  assert.equal(
    t.run(`state.map.nodes.a.image.assetId === newImage.assetId && state.map.nodes.a.image.alt === '新画像'`),
    true,
  );
});
test('an active hand grab blocks image adoption and removal before changing storage or history', async () => {
  const t = setup();
  t.run(`state.map.nodes.a.image={assetId:'sha256:'+'a'.repeat(64),alt:'旧画像',width:1,height:1};
    const beforeGrab=JSON.stringify(state.map); let imageWrites=0;
    imageStore.put=async()=>{imageWrites++;}; state.hand={grab:'a'};`);
  await assert.rejects(
    t.run(
      `attachNodeImage(new Blob(['test']),{nodeId:'a',mapSessionId: state.mapSessionId,revision: state.revision},'説明')`,
    ),
    /操作中/,
  );
  t.run(`removeNodeImage('a')`);
  assert.equal(
    t.run(`JSON.stringify(state.map) === beforeGrab && imageWrites === 0 && state.history.length === 0`),
    true,
  );
});
test('failed image storage never changes map, history or existing reference', async () => {
  const t = setup();
  t.run(`state.map.nodes.a.image={assetId:'sha256:'+'a'.repeat(64),alt:'旧画像',width:1,height:1};
    const beforeImageSave=JSON.stringify(state.map); imageStore.put=async()=>{throw Error('quota');};`);
  await assert.rejects(
    t.run(
      `attachNodeImage(new Blob(['test']),{nodeId:'a',mapSessionId: state.mapSessionId,revision: state.revision},'説明')`,
    ),
    /quota/,
  );
  assert.equal(t.run(`JSON.stringify(state.map) === beforeImageSave && state.history.length === 0`), true);
});

test('double-clicking a node image opens it large; text and failed images still edit', async () => {
  const t = setup();
  t.run(`state.map.nodes.a.image={assetId:'sha256:'+'a'.repeat(64),alt:'海',width:4,height:3};
    const acquired=[], released=[]; imageStore.acquire=async id=>(acquired.push(id),'blob:big'); imageStore.release=id=>released.push(id); nodeEl('a');
    const at=part=>(document.elementFromPoint=()=>({closest:s=>s==='.node'?{dataset:{id:'a'}}:s===part?{}:null}),{target:viewportEl});`);
  await t.run(`$('#viewport').handlers.dblclick(at('.node__image'))`);
  assert.equal(
    t.run(
      `$('#imageDialog').open && $('#imageViewerImg').src==='blob:big' && $('#imageViewerImg').alt==='海' && !state.editing && acquired.length===1`,
    ),
    true,
  );
  t.run(`$('#imageDialog').close(); $('#imageDialog').handlers.close();`);
  assert.equal(t.run(`released.length===1 && released[0]===acquired[0]`), true);
  t.run(`$('#viewport').handlers.dblclick(at('.node__text'))`);
  assert.equal(t.run(`state.editing?.id==='a' && !$('#imageDialog').open`), true);
  t.run(
    `cancelEdit(); nodeEls.get('a').imageState={failed:true}; $('#viewport').handlers.dblclick(at('.node__image'))`,
  );
  assert.equal(t.run(`state.editing?.id==='a' && !$('#imageDialog').open`), true);
});
test('uploading as a child adds one named image node in a single undo and selects it', async () => {
  const t = setup();
  t.run(`const ref={assetId:'sha256:'+'c'.repeat(64),width:4,height:3};
    let prepared; NodeImageUpload.prepare=async f=>(prepared=f,f); imageStore.put=async()=>ref;
    const before=Object.keys(state.map.nodes).length; state.selectedId='a'; pickImage('a', true);`);
  assert.equal(t.run(`$('#imageInput').clicked`), 1);
  await t.run(`$('#imageInput').onchange({target:{files:[new Blob(['x'],{type:'image/png'})], value:'x'}})`);
  t.run(`const file=Object.assign(new Blob(['x'],{type:'image/png'}),{name:'海辺の電車.png'}); pickImage('a', true);`);
  await t.run(`$('#imageInput').onchange({target:{files:[file], value:'x'}})`);
  assert.equal(
    t.run(
      `const added=state.map.nodes[state.selectedId]; added.parent==='a' && added.text==='海辺の電車' && added.image.alt==='海辺の電車' && added.image.assetId===ref.assetId && prepared===file && Object.keys(state.map.nodes).length===before+2`,
    ),
    true,
  );
  t.run('undo()');
  assert.equal(t.run(`Object.keys(state.map.nodes).length===before+1`), true);
});
test('dropping an image file onto a node turns it into an image node; off-node or non-image drops do nothing', async () => {
  const t = setup();
  t.run(`const ref={assetId:'sha256:'+'e'.repeat(64),width:4,height:3};
    NodeImageUpload.prepare=async f=>f; imageStore.put=async()=>ref;
    let hitId='b'; document.elementFromPoint=()=>({closest:s=>s==='.node'&&hitId?{dataset:{id:hitId}}:null});
    const png=Object.assign(new Blob(['x'],{type:'image/png'}),{name:'p.png'});
    const drag=files=>({preventDefault(){}, clientX:0, clientY:0, dataTransfer:{types:['Files'], files}});
    const before=Object.keys(state.map.nodes).length, text=state.map.nodes.b.text;`);
  t.run(`$('#viewport').handlers.dragover(drag([png]))`);
  assert.equal(t.run(`dropTarget`), 'b');
  await t.run(`$('#viewport').handlers.drop(drag([new Blob(['x'],{type:'text/plain'})]))`);
  assert.equal(t.run(`!state.map.nodes.b.image && dropTarget===null && state.history.length===0`), true);
  await t.run(`hitId=null; $('#viewport').handlers.drop(drag([png]))`);
  assert.equal(t.run(`state.history.length`), 0);
  await t.run(`hitId='b'; $('#viewport').handlers.drop(drag([png]))`);
  assert.equal(
    t.run(
      `state.map.nodes.b.image.assetId===ref.assetId && state.map.nodes.b.image.alt===text && state.map.nodes.b.text===text && Object.keys(state.map.nodes).length===before && state.history.length===1`,
    ),
    true,
  );
});
test('uploading onto a node keeps its text, and failures leave the map untouched', async () => {
  const t = setup();
  t.run(`const ref={assetId:'sha256:'+'d'.repeat(64),width:4,height:3};
    NodeImageUpload.prepare=async f=>f; imageStore.put=async()=>ref; pickImage('b', false);`);
  await t.run(`$('#imageInput').onchange({target:{files:[Object.assign(new Blob(['x']),{name:'p.jpg'})], value:'x'}})`);
  assert.equal(
    t.run(
      `state.map.nodes.b.text==='図書館に行く' && state.map.nodes.b.image.alt==='図書館に行く' && state.history.length===1`,
    ),
    true,
  );
  t.run(
    `const beforeFail=JSON.stringify(state.map); NodeImageUpload.prepare=async()=>{throw Error('画像をデコードできません');}; pickImage('a', true);`,
  );
  await t.run(`$('#imageInput').onchange({target:{files:[new Blob(['x'])], value:'x'}})`);
  assert.equal(
    t.run(
      `JSON.stringify(state.map)===beforeFail && state.history.length===1 && notices.at(-1)==='画像をデコードできません'`,
    ),
    true,
  );
});

test('bundle import retries a missing image even when node and asset IDs are unchanged', async () => {
  const t = setup({ renderUI: true });
  t.run(`const restoredImage={assetId:'sha256:'+'a'.repeat(64),alt:'復元する画像',width:1,height:1};
    const releasedImages=[]; imageStore.release=id=>releasedImages.push(id);
    let imageReads=0; imageStore.acquire=async()=>{imageReads++;throw Error('missing');};
    state.map.nodes.a.image=restoredImage; render();`);
  await Promise.resolve();
  assert.equal(t.run(`nodeEls.get('a').imageState.failed`), true);
  t.run(`const brokenImageState=nodeEls.get('a').imageState;
    imageStore.acquire=async()=>{imageReads++;return 'blob:restored';};
    `);
  await t.run('importMap(serializeMap())');
  await Promise.resolve();
  assert.equal(
    t.run(
      `nodeEls.get('a').imageState !== brokenImageState && !nodeEls.get('a').imageState.failed && nodeEls.get('a').imageState.img.src === 'blob:restored' && releasedImages[0] === restoredImage.assetId && imageReads === 2`,
    ),
    true,
  );
});

test('bundle restoration ignores a late failure from an earlier image read with the same ID', async () => {
  const t = setup({ renderUI: true });
  t.run(`const restoredImage={assetId:'sha256:'+'a'.repeat(64),alt:'復元する画像',width:1,height:1};
    let failOldRead; const releases=[];
    imageStore.release=id=>releases.push(id);
    imageStore.acquire=()=>new Promise((resolve,reject)=>{failOldRead=reject;});
    state.map.nodes.a.image=restoredImage; render();
    const pendingState=nodeEls.get('a').imageState;
    imageStore.acquire=async()=> 'blob:repaired';`);
  await t.run('importMap(serializeMap())');
  await Promise.resolve();
  t.run(`failOldRead(new Error('old missing bytes'));`);
  await Promise.resolve();
  assert.equal(
    t.run(
      `nodeEls.get('a').imageState !== pendingState && !nodeEls.get('a').imageState.failed && nodeEls.get('a').imageState.img.src === 'blob:repaired' && releases.length === 1`,
    ),
    true,
  );
});

test('image-first DOM keeps editing the text; cached URLs release on removal, replacement and pagehide', async () => {
  const t = setup({ renderUI: true });
  t.run(`const released=[];imageStore.release=id=>released.push(id); imageStore.acquire=async id=>'blob:'+id;
    const firstImage={assetId:'sha256:'+'a'.repeat(64),alt:'最初の絵',width:1,height:1};
    state.map.nodes.a.image=firstImage;render();startEdit('a');
    const frame=nodeEls.get('a').firstChild;
    nodeEls.get('a').nodeText.textContent='画像の下の文字';finishEdit();`);
  assert.equal(
    t.run(
      `state.map.nodes.a.text === '画像の下の文字' && nodeEls.get('a').firstChild === frame && !!state.map.nodes.a.image`,
    ),
    true,
  );
  t.run(`state.map.nodes.a.image={...firstImage,assetId:'sha256:'+'b'.repeat(64)};render();`);
  assert.equal(t.run(`released.length === 1 && released[0] === firstImage.assetId`), true);
  t.run(`removeNodeImage('a');`);
  assert.equal(t.run('released.length'), 2);
  t.run(`undo();`);
  t.windowHandlers.get('pagehide')();
  assert.equal(t.run('released.length'), 3);
  t.windowHandlers.get('pageshow')();
  assert.equal(t.run(`!!nodeEls.get('a').imageState`), true);
});

test('instruction field toggles from the dock and remembers its state', () => {
  const t = setup();
  t.elements.get('#promptHide').onclick();
  assert.equal(
    t.run(`$('#prompt').hidden && String($('#promptToggle').attributes['aria-expanded']) === 'false'`),
    true,
  );
  assert.equal(t.storage.get('mindmap-proto:prompt-hidden'), '1');
  t.elements.get('#promptToggle').onclick();
  assert.equal(
    t.run(
      `!$('#prompt').hidden && String($('#promptToggle').attributes['aria-expanded']) === 'true' && document.activeElement === $('#promptInput')`,
    ),
    true,
  );
  assert.equal(t.storage.get('mindmap-proto:prompt-hidden'), '');
  t.elements.get('#promptToggle').onclick();
  assert.equal(
    t.run(`$('#prompt').hidden && String($('#promptToggle').attributes['aria-expanded']) === 'false'`),
    true,
  );

  const reloaded = setup({ stored: { 'mindmap-proto:prompt-hidden': '1' } });
  assert.equal(reloaded.run(`$('#prompt').hidden`), true);
});

test('cmd K and a Codex question reopen a hidden instruction field', async () => {
  const t = setup();
  t.run('setPromptHidden(true)');
  t.windowHandlers.get('keydown')({ key: 'k', metaKey: true, preventDefault() {}, target: t.context.document.body });
  assert.equal(t.run(`!$('#prompt').hidden && document.activeElement === $('#promptInput')`), true);
  mockQuestions(t);
  t.run('setPromptHidden(true)');
  t.run(`conversationState('awaiting_input', {questionId:'q1', message:'対象は？'});`);
  assert.equal(t.run(`!$('#prompt').hidden`), true);
});

test('the map menu shows each map size with its images and the total image usage', async () => {
  const t = setup();
  t.run(`state.library.docs.set('m_other', { map: sample(), updatedAt: 2, cursor: 0, log: new Map() });
    state.library.stats = async id => ({ bytes: 1000, images: id === 'm_first' ? 2 : 0, assets: id === 'm_first' ? ['x', 'y'] : ['y'] });
    imageStore.files = async () => new Map([['x', { size: 1024 * 1024 }], ['y', { size: 2048 }]]);
    MapLocks.busy = async () => new Set();
    mapList = [{ id: 'm_first', title: 'A', updatedAt: Date.now() }, { id: 'm_other', title: 'B', updatedAt: Date.now() - 3 * 3600000 }];`);
  await t.run('refreshMapsMenu()');
  const rows = t.elements.get('#mapsList').children,
    cell = (row, i) => row.children[0].children[i].textContent;
  assert.deepEqual(
    rows.map(r => cell(r, 1)),
    ['1.0 MB', '3 KB'],
  );
  assert.deepEqual(
    rows.map(r => cell(r, 2)),
    ['たった今 · 画像 2枚', '3時間前'],
  );
  assert.equal(rows[0].className.includes('maps__row--current'), true);
  assert.equal(t.run(`$('#mapsUsageText').textContent`), '1.0 MB / 50.0 MB');
  assert.equal(t.run(`$('#mapsUsage').hidden`), false);

  t.run(`imageStore.files = async () => { throw Error('no opfs'); }`);
  await t.run('refreshMapsMenu()');
  assert.equal(cell(t.elements.get('#mapsList').children[0], 1), '—');
  assert.equal(t.run(`$('#mapsUsage').hidden`), true);
});

test('bytes and update times read in short units', () => {
  const t = setup();
  assert.deepEqual(JSON.parse(t.run(`JSON.stringify([0, 1023, 1024, 1536 * 1024].map(formatBytes))`)), [
    '0 B',
    '1023 B',
    '1 KB',
    '1.5 MB',
  ]);
  const now = Date.UTC(2026, 9, 24, 12);
  assert.deepEqual(
    JSON.parse(t.run(`JSON.stringify([30e3, 5 * 60e3, 2 * 3600e3, 3 * 86400e3].map(d => ago(${now} - d, ${now})))`)),
    ['たった今', '5分前', '2時間前', '3日前'],
  );
});

test('disabled instructions hide controls, ignore saved visibility, shortcut and submission without a transport', async () => {
  const t = setup({ instructions: false, stored: { 'mindmap-proto:prompt-hidden': '' } });
  assert.equal(t.run('instructionClient'), null);
  assert.equal(t.elements.get('#prompt').hidden, true);
  assert.equal(t.elements.get('#promptToggle').hidden, true);
  assert.equal(t.elements.get('#promptShortcutKey').hidden, true);
  assert.equal(t.elements.get('#promptShortcutHelp').hidden, true);
  t.run('setPromptHidden(false)');
  assert.equal(t.elements.get('#prompt').hidden, true);
  let prevented = false;
  t.windowHandlers.get('keydown')({
    key: 'k',
    metaKey: true,
    target: {
      closest() {
        return null;
      },
    },
    preventDefault() {
      prevented = true;
    },
  });
  assert.equal(prevented, false);
  await t.run("sendInstruction('変更してください')");
  await t.run('checkCodexStatus()');
  assert.equal(t.run('state.instruction'), null);
  assert.equal(t.storage.get('mindmap-proto:prompt-hidden'), '');
  t.run("commit(() => { state.map.nodes.root.text = '通常編集'; });");
  assert.equal(t.run('state.map.nodes.root.text'), '通常編集');
});

test('static feature configuration disables instructions by default', () => {
  const context = vm.createContext({});
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/features.js'), 'utf8'), context);
  assert.equal(context.MindmapFeatures.instructions, false);
});

test('node menu flips below the selection when it would cover a node above', () => {
  const t = setup({ renderUI: true });
  const menuY = () => {
    t.run(`positionMenu()`);
    return Number(t.elements.get('#nodeMenu').style.transform.match(/, (-?[\d.]+)px/)[1]);
  };
  t.run(
    `state.view = { x: 0, y: 0, s: 1 }; Object.assign(state.map.nodes.a, { x: 600, y: 400 }); Object.assign(state.map.nodes.a1, { x: 1000, y: 100 }); select('a');`,
  );
  assert.equal(menuY(), 400 - 25 - 50 - 40);
  t.run(`Object.assign(state.map.nodes.a1, { x: 600, y: 300 });`);
  assert.equal(menuY(), 400 + 25 + 16);
});
for (const narrow of [false, true])
  test(`node menu ${narrow ? 'stays docked' : 'hides'} while panning or dragging on ${narrow ? 'narrow' : 'wide'} canvases`, () => {
    const t = setup({ renderUI: true });
    t.context.document.body.classList.contains = name => narrow && name === 'canvas-narrow';
    const menu = t.elements.get('#nodeMenu');
    for (const type of ['pan', 'node']) {
      t.run(`select('a'); state.gesture = { type: '${type}', moved: true }; positionMenu();`);
      assert.equal(menu.hidden, !narrow);
      t.run(`state.gesture = null; positionMenu();`);
      assert.equal(menu.hidden, false);
    }
  });
test('the image action switches both its full and short labels once the node has an image', () => {
  const t = setup({ renderUI: true });
  const labels = () =>
    ['long', 'short'].map(kind => t.elements.get(`[data-act=image] .btn__label--${kind}`).textContent);
  t.run(`select('a'); positionMenu();`);
  assert.deepEqual(labels(), ['画像にする', '画像']);
  t.run(`state.map.nodes.a.image = 'img_1'; positionMenu();`);
  assert.deepEqual(labels(), ['画像を変更', '画像変更']);
});

test('an English browser gets English samples, dialogs and notices', () => {
  const t = setup({ lang: 'en' });
  assert.equal(t.run(`state.map.title + ' / ' + state.map.nodes.root.text`), 'Weekend map / Things to do this weekend');
  t.run(`removeNode('a');`);
  assert.equal(t.run(`$('#deleteTitle').textContent`), 'Delete “Play in the park”?');
  t.run(`chooseDeleteScope('branch');`);
  assert.equal(t.run(`$('#deleteConfirm').textContent`), 'Delete 2 nodes');
  t.run(`confirmDelete();`);
  assert.equal(t.run('notices.at(-1)'), 'Deleted');
  assert.deepEqual(
    JSON.parse(t.run(`JSON.stringify([30e3, 5 * 60e3, 2 * 3600e3, 86400e3].map(d => ago(1e9 - d, 1e9)))`)),
    ['just now', '5 min ago', '2 hr ago', '1 day ago'],
  );
});

test('palette initializes before the first render; actual apply uses one image history entry with Undo/Redo', async () => {
  const { run, elements, context } = setup({ renderUI: true, paletteUI: true });
  const el = key => elements.get(key);
  assert.equal(el('#paletteToggle').hidden, false);
  assert.equal(el('#paletteDockToggle').hidden, false);
  run("$('#paletteDockToggle').onclick()");
  assert.equal(el('#paletteDockToggle').attributes['aria-expanded'], 'true');
  assert.equal(el('#iconPalette').attributes['aria-hidden'], 'false');
  assert.equal(el('#paletteList').children.length, 72);
  run("$('#palette-daily').onclick(); $('#paletteSearch').value = 'ご飯'; $('#paletteSearch').oninput()");
  assert.equal(el('#paletteList').children.length, 1);
  el('#paletteList').children[0].onclick();
  assert.equal(el('#paletteChild').disabled, false);
  context.fetch = async () => ({ ok: true, blob: async () => new Blob(['original PNG']) });
  run("imageStore.put = async () => ({assetId:'sha256:'+'a'.repeat(64),width:128,height:112})");
  const before = run('Object.keys(state.map.nodes).length');
  run("$('#paletteChild').onclick()");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('Object.keys(state.map.nodes).length'), before + 1);
  assert.equal(run('state.map.nodes[state.selectedId].text'), 'ご飯');
  assert.equal(run('state.history.length'), 1);
  run('undo()');
  assert.equal(run('Object.keys(state.map.nodes).length'), before);
  run('redo(); select(state.map.root)');
  const rootText = run('state.map.nodes[state.map.root].text');
  run("$('#paletteApply').onclick()");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(run('state.map.nodes[state.map.root].image.alt'), 'ご飯');
  assert.equal(run('state.map.nodes[state.map.root].text'), rootText);
  assert.equal(el('#paletteApply').textContent, '画像を置き換える');
  run('undo()');
  assert.equal(run('!!state.map.nodes[state.map.root].image'), false);
  run('redo()');
  assert.equal(run('!!state.map.nodes[state.map.root].image'), true);
  run("$('#paletteClose').onclick()");
  assert.equal(el('#iconPalette').attributes['aria-hidden'], 'true');
  assert.equal(el('#paletteDockToggle').attributes['aria-expanded'], 'false');
});

test('palette cancels a pending PNG on selection change or map switch, and clears icon selection on switching maps', async () => {
  for (const action of [
    "select('b')",
    "state.mapSessionId = 'other'; render()",
    'state.mapClaim.editable=false; updateAccess()',
    "$('#paletteClose').onclick()",
    "$('#palette-daily').onclick()",
  ]) {
    const { run, context, elements } = setup({ renderUI: true, paletteUI: true });
    run("$('#paletteToggle').onclick()");
    elements.get('#paletteList').children[0].onclick();
    let finish;
    context.fetch = () =>
      new Promise(r => {
        finish = r;
      });
    run("$('#paletteChild').onclick()");
    run(action);
    finish({ ok: true, blob: async () => new Blob(['png']) });
    await new Promise(r => setImmediate(r));
    assert.equal(run('state.history.length'), 0, action);
  }
});

test('palette drag applies to an unselected node, replaces its image, and supports Undo/Redo', async () => {
  const { run, context, elements } = setup({ renderUI: true, paletteUI: true });
  run("$('#paletteToggle').onclick(); select('a')");
  const data = new Map(),
    transfer = {
      types: [],
      setData(type, value) {
        data.set(type, value);
        this.types.push(type);
      },
      getData: type => data.get(type),
    };
  context.document.elementFromPoint = () => ({ closest: () => ({ dataset: { id: 'root' } }) });
  context.fetch = async () => ({ ok: true, blob: async () => new Blob(['png']) });
  run(
    "let imageNumber = 0; imageStore.put = async () => ({assetId:'sha256:'+(++imageNumber).toString().repeat(64),width:128,height:112})",
  );
  const event = { dataTransfer: transfer, clientX: 100, clientY: 100, preventDefault() {} };
  const viewport = elements.get('#viewport');
  const before = run('Object.keys(state.map.nodes).length');
  for (const i of [0, 1]) {
    elements.get('#paletteList').children[i].ondragstart(event);
    viewport.handlers.dragover(event);
    assert.equal(transfer.dropEffect, 'copy');
    assert.equal(run('dropTarget'), 'root');
    await viewport.handlers.drop(event);
    elements.get('#paletteList').children[i].ondragend();
    assert.equal(run('dropTarget'), null);
    assert.equal(run('state.selectedId'), 'a');
    assert.equal(run('Object.keys(state.map.nodes).length'), before);
    assert.equal(run('state.history.length'), i + 1);
    assert.equal(run('state.map.nodes.root.image.assetId'), 'sha256:' + String(i + 1).repeat(64));
  }
  run('undo()');
  assert.equal(run('state.map.nodes.root.image.assetId'), 'sha256:' + '1'.repeat(64));
  run('undo()');
  assert.equal(run('!!state.map.nodes.root.image'), false);
  run('redo(); redo()');
  assert.equal(run('state.map.nodes.root.image.assetId'), 'sha256:' + '2'.repeat(64));
});

test('palette drag rejects stale, blocked, cancelled and forged drops without fetching', async () => {
  for (const action of [
    'state.revision++',
    "state.mapSessionId='other'",
    'state.mapClaim.editable=false',
    "$('#paletteClose').onclick()",
    "state.mode='connect'",
    'cancel',
    'forge',
    'outside',
  ]) {
    const { run, context, elements } = setup({ renderUI: true, paletteUI: true });
    run("$('#paletteToggle').onclick()");
    const data = new Map(),
      transfer = {
        types: [],
        setData(type, value) {
          data.set(type, value);
          this.types.push(type);
        },
        getData: type => data.get(type),
      };
    const event = { dataTransfer: transfer, clientX: 100, clientY: 100, preventDefault() {} };
    let fetched = 0;
    context.fetch = async () => {
      fetched++;
      throw Error('unexpected fetch');
    };
    context.document.elementFromPoint = () => ({
      closest: () => (action === 'outside' ? null : { dataset: { id: 'root' } }),
    });
    const button = elements.get('#paletteList').children[0];
    button.ondragstart(event);
    if (action === 'cancel') button.ondragend();
    else if (action === 'forge') data.set(run('IconPalette.DRAG_TYPE'), 'people-02');
    else if (action !== 'outside') run(action);
    await elements.get('#viewport').handlers.drop(event);
    button.ondragend();
    assert.equal(fetched, 0, action);
    assert.equal(run('state.history.length'), 0, action);
    assert.equal(run('dropTarget'), null, action);
  }
});

test('beforeprint fits the whole map on A4 without touching the view; afterprint restores the title', () => {
  const t = setup({ renderUI: true });
  t.run(
    `state.view = { x: 5, y: 6, s: 2 }; document.title = 'App'; state.map.title = 'Plan'; world.style.transform = 'screen';`,
  );
  const timers = t.timers.size,
    stored = [...t.storage];
  t.windowHandlers.get('beforeprint')();
  assert.match(t.run(`$('#pageStyle').textContent`), /size: A4 landscape/);
  assert.match(t.run(`viewportEl.style['--print-transform']`), /^translate\(.+px, .+px\) scale\(0\.\d+\)$/);
  assert.equal(
    t.run(
      `state.view.x === 5 && state.view.y === 6 && state.view.s === 2 && world.style.transform === 'screen' && document.title === 'Plan'`,
    ),
    true,
  );
  assert.equal(t.timers.size, timers);
  assert.deepEqual([...t.storage], stored);
  const p = t.run('PrintLayout.fit(mapBounds(0))'),
    b = t.run('mapBounds(0)');
  assert.ok(Math.abs(b.y0 * p.scale + p.y - (p.height - (b.y1 * p.scale + p.y))) < 1e-6);
  assert.equal(t.run(`viewportEl.style['--print-transform']`), `translate(${p.x}px, ${p.y}px) scale(${p.scale})`);
  t.windowHandlers.get('afterprint')();
  assert.equal(t.run(`document.title === 'App'`), true);
});

test('cmd P prints once, even while deleting, and ignores a second request while waiting', async () => {
  const t = setup();
  let printed = 0,
    prevented = 0;
  t.context.print = () => {
    printed++;
  };
  t.run(`state.deletion = {};`);
  const press = () =>
    t.windowHandlers.get('keydown')({
      key: 'p',
      metaKey: true,
      target: t.context.document.body,
      preventDefault() {
        prevented++;
      },
    });
  press();
  press();
  await new Promise(setImmediate);
  assert.equal(prevented, 2);
  assert.equal(printed, 1);
  press();
  await new Promise(setImmediate);
  assert.equal(printed, 2);
});

test('printing waits for loading images and gives up after three seconds', async () => {
  const t = setup({ renderUI: true });
  let printed = 0;
  t.context.print = () => {
    printed++;
  };
  t.run(`imageStore.acquire = () => new Promise(() => {});
    state.map.nodes.a.image = { assetId: 'sha256:' + 'a'.repeat(64), alt: '', width: 1, height: 1 };
    state.map.nodes.b.image = { assetId: 'sha256:' + 'b'.repeat(64), alt: '', width: 1, height: 1 }; render();`);
  t.run('printMap()');
  await new Promise(setImmediate);
  assert.equal(printed, 0);
  t.run(`nodeEls.get('a').imageState.img.onload(); nodeEls.get('b').imageState.img.onerror();`);
  await new Promise(setImmediate);
  assert.equal(printed, 1);

  t.run(`clearNodeImage(nodeEls.get('a')); render();`);
  t.run('printMap()');
  await new Promise(setImmediate);
  assert.equal(printed, 1);
  t.timers.get(Math.max(...t.timers.keys()))();
  await new Promise(setImmediate);
  assert.equal(printed, 2);
});

test('read-only tabs can print without changing the map or history', async () => {
  const t = setup();
  let printed = 0;
  t.context.print = () => {
    printed++;
  };
  t.run(
    `commit(() => { state.map.nodes.a.text = 'x'; }); state.mapClaim = { editable: false, release() {} }; updateAccess(); const before = JSON.stringify(state.map);`,
  );
  await t.run('printMap()');
  t.windowHandlers.get('beforeprint')();
  t.windowHandlers.get('afterprint')();
  assert.equal(printed, 1);
  assert.equal(
    t.run(`JSON.stringify(state.map) === before && state.history.length === 1 && state.future.length === 0`),
    true,
  );
});

test('debug panel toggle exposes and hides the camera skeleton and values', () => {
  const t = setup();
  t.elements.get('#handDebugToggle').onclick();
  assert.equal(t.elements.get('#handSkeleton').hidden, false);
  assert.equal(t.elements.get('#handDebugValues').hidden, false);
  assert.equal(t.elements.get('#handDebugToggle').attributes['aria-pressed'], 'true');
  t.run('toggleHand(); cameraSession.io.debug(null);');
  assert.equal(t.elements.get('#handDebugValues').textContent, '手を検出していません');
  t.elements.get('#handDebugToggle').onclick();
  assert.equal(t.elements.get('#handSkeleton').hidden, true);
  assert.equal(t.elements.get('#handDebugValues').hidden, true);
  assert.equal(t.elements.get('#handDebugToggle').attributes['aria-pressed'], 'false');
});

function mockSpeech(app) {
  app.run(`speech.Recognition = class {
    constructor() { globalThis.recognizer = this; }
    start() { this.onstart(); }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; this.onend?.(); }
  };`);
}
test('hand add starts voice by default and left thumb confirms after speech with one Undo/Redo', () => {
  const app = setup({ renderUI: true, instructions: false });
  mockSpeech(app);
  app.run(`toggleHand(); handController.io.command('add');
    globalThis.voiceNode = state.editing.id;
    recognizer.onresult({ resultIndex: 0, results: [Object.assign([{transcript: 'Voice child'}], {isFinal: true})] });`);
  assert.equal(app.run('state.map.nodes[voiceNode].text'), '');
  assert.equal(app.run('speech.active && !handController.io.blocked() && handController.io.dialog()'), true);
  assert.equal(app.elements.get('#nodeSpeechToggle').hidden, true);
  assert.equal(app.elements.get('#nodeSpeechDone').disabled, false);
  app.run('recognizer.onend();');
  assert.equal(app.run('!!state.editing'), true);
  app.run(`let voiceTime = 0;
    const voiceFrame = pose => { cameraSession.io.frame({pointer:{x:.5,y:.5}, wrist:{x:.5,y:.7}, ratio:.8, pose}, voiceTime); voiceTime += 50; };
    for (let i = 0; i < 14; i++) voiceFrame('thumbLeft');`);
  assert.equal(app.run('state.editing'), null);
  assert.equal(app.run('state.map.nodes[voiceNode].text'), 'Voice child');
  assert.equal(app.run('state.history.length'), 1);
  app.run('undo();');
  assert.equal(app.run('!!state.map.nodes[voiceNode]'), false);
  app.run('redo();');
  assert.equal(app.run('state.map.nodes[voiceNode].text'), 'Voice child');
});
test('hand left confirmation stops recognition and waits for final text before committing', () => {
  const app = setup({ renderUI: true });
  mockSpeech(app);
  app.run(`toggleHand(); handController.io.command('add'); globalThis.voiceNode = state.editing.id;
    for (let i = 0; i < 14; i++) cameraSession.io.frame({pointer:{x:.5,y:.5}, wrist:{x:.5,y:.7}, ratio:.8, pose:'thumbLeft'}, i * 50);`);
  assert.equal(app.run('recognizer.stopped && state.editing.pendingDone && speech.state === "stopping"'), true);
  app.run(
    `recognizer.onresult({resultIndex:0, results:[Object.assign([{transcript:'Final words'}], {isFinal:true})]}); recognizer.onend();`,
  );
  assert.equal(app.run('state.editing'), null);
  assert.equal(app.run('state.map.nodes[voiceNode].text'), 'Final words');
  assert.equal(app.run('state.history.length'), 1);
});
for (const ended of [false, true])
  test(`hand right thumb cancels ${ended ? 'after speech' : 'while listening'} and ignores late results`, () => {
    const app = setup({ renderUI: true });
    mockSpeech(app);
    app.run(`toggleHand(); handController.io.command('add'); globalThis.voiceNode = state.editing.id;
    recognizer.onresult({resultIndex:0, results:[Object.assign([{transcript:'Discard'}], {isFinal:true})]});`);
    if (ended) app.run('recognizer.onend();');
    app.run(`for (let i = 0; i < 14; i++) cameraSession.io.frame({pointer:{x:.5,y:.5}, wrist:{x:.5,y:.7}, ratio:.8, pose:'thumbRight'}, i * 50);
    recognizer.onresult({resultIndex:0, results:[Object.assign([{transcript:'late'}], {isFinal:true})]}); recognizer.onend();`);
    assert.equal(app.run('state.editing'), null);
    assert.equal(app.run('speech.active || !!state.map.nodes[voiceNode]'), false);
    assert.equal(app.run('state.history.length'), 0);
  });
test('hand voice editing suppresses navigation and focusout; failed confirmation stays recoverable', () => {
  const app = setup({ renderUI: true });
  mockSpeech(app);
  app.run(`toggleHand(); handController.io.command('add'); globalThis.voiceNode = state.editing.id;
    const voiceX = state.map.nodes[voiceNode].x, voiceY = state.map.nodes[voiceNode].y;
    for (let i = 0; i < 20; i++) cameraSession.io.frame({pointer:{x:.5 - i * .01,y:.5}, wrist:{x:.5,y:.7}, ratio:.8}, i * 50);`);
  assert.equal(
    app.run(
      'state.selectedId === voiceNode && state.map.nodes[voiceNode].x === voiceX && state.map.nodes[voiceNode].y === voiceY',
    ),
    true,
  );
  app.elements.get('#nodes').handlers.focusout({
    target: app.run('nodeEls.get(state.editing.id).nodeText'),
    relatedTarget: app.elements.get('#title'),
  });
  assert.equal(app.run('!!state.editing'), true);
  app.run(`confirmNodeSpeech(); recognizer.onerror({error:'network'});`);
  assert.equal(app.run('!!state.editing && !state.editing.pendingDone && !speech.active'), true);
  assert.equal(app.elements.get('#nodeSpeechToggle').hidden, false);
  app.run('startNodeSpeech(); recognizer.onend();');
  assert.equal(app.run('!!state.editing'), true);
});
test('voice failures retain editable nodes; cancel discards new nodes and ignores late results', () => {
  const app = setup({ renderUI: true });
  mockSpeech(app);
  app.run(`addChildAndEdit(state.map.root, true); recognizer.onerror({ error: 'not-allowed' });`);
  assert.equal(app.run('!!state.editing && !speech.active'), true);
  assert.equal(app.run('nodeEls.get(state.editing.id).nodeText.contentEditable'), 'plaintext-only');
  app.run(`startNodeSpeech(true); globalThis.late = recognizer; cancelEdit();
    late.onresult({ resultIndex: 0, results: [Object.assign([{transcript:'late'}], {isFinal:true})] }); late.onend();`);
  assert.equal(app.run('Object.keys(state.map.nodes).length'), 7);
  assert.equal(app.run('state.history.length'), 0);
});
test('node speech controls keep editing on Tab and focusout; outside focus commits only final results', () => {
  const app = setup({ renderUI: true });
  mockSpeech(app);
  app.run('startEdit(state.map.root);');
  const event = {
    target: app.run('nodeEls.get(state.editing.id).nodeText'),
    key: 'Tab',
    preventDefault() {},
    stopPropagation() {},
  };
  event.target.isContentEditable = true;
  app.elements.get('#nodes').handlers.keydown(event);
  assert.equal(app.run('document.activeElement === $("#nodeSpeechToggle")'), true);
  app.elements.get('#nodeSpeech').children.push(app.elements.get('#nodeSpeechToggle'));
  app.elements
    .get('#nodes')
    .handlers.focusout({ target: event.target, relatedTarget: app.elements.get('#nodeSpeechToggle') });
  assert.equal(app.run('!!state.editing'), true);
  app.run(
    `startNodeSpeech(); recognizer.onresult({resultIndex:0, results:[Object.assign([{transcript:' appended'}], {isFinal:true})]});`,
  );
  app.elements.get('#nodes').handlers.focusout({ target: event.target, relatedTarget: app.elements.get('#title') });
  assert.equal(app.run('state.editing'), null);
  assert.match(app.run('state.map.nodes[state.map.root].text'), /appended$/);
});
for (const pointerType of ['mouse', 'touch'])
  test(`Safari ${pointerType} speech controls focus before blur and remain clickable`, () => {
    const app = setup({ renderUI: true });
    mockSpeech(app);
    const panel = app.elements.get('#nodeSpeech');
    const toggle = app.elements.get('#nodeSpeechToggle');
    const done = app.elements.get('#nodeSpeechDone');
    const cancel = app.elements.get('#nodeSpeechCancel');
    panel.children.push(toggle, done, cancel);
    function press(button) {
      let prevented = false;
      const previous = app.context.document.activeElement;
      button.handlers.pointerdown({
        currentTarget: button,
        pointerType,
        button: 0,
        isPrimary: true,
        preventDefault() {
          prevented = true;
        },
      });
      // Model Safari: the native pointer default blurs without focusing a button.
      const relatedTarget = prevented ? app.context.document.activeElement : null;
      app.elements.get('#nodes').handlers.focusout({ target: previous, relatedTarget });
      assert.equal(prevented, true);
      assert.equal(app.context.document.activeElement, button);
      assert.equal(app.run('!!state.editing'), true);
      button.onclick();
    }
    app.run('startEdit(state.map.root);');
    press(toggle);
    assert.equal(app.run('speech.active && speech.state === "listening"'), true);
    assert.equal(panel.hidden, false);
    press(toggle);
    assert.equal(app.run('recognizer.stopped'), true);
    app.run(
      `recognizer.onresult({resultIndex:0, results:[Object.assign([{transcript:' Safari'}], {isFinal:true})]}); recognizer.onend();`,
    );
    press(done);
    assert.equal(app.run('state.editing'), null);
    assert.match(app.run('state.map.nodes[state.map.root].text'), / Safari$/);
    app.run('startEdit(state.map.root);');
    press(cancel);
    assert.equal(app.run('state.editing'), null);
  });

test('tab hiding aborts voice, restores typing and rejects delayed results', () => {
  const app = setup({ renderUI: true });
  mockSpeech(app);
  app.run('addChildAndEdit(state.map.root, true); confirmNodeSpeech(); document.hidden = true;');
  app.documentHandlers.get('visibilitychange')();
  assert.equal(app.run('speech.active'), false);
  assert.equal(app.run('state.editing.pendingDone'), false);
  assert.equal(app.elements.get('#nodeSpeechDone').disabled, false);
  assert.equal(app.run('nodeEls.get(state.editing.id).nodeText.contentEditable'), 'plaintext-only');
  app.run(
    `recognizer.onresult({resultIndex:0, results:[Object.assign([{transcript:'late'}], {isFinal:true})]}); recognizer.onend();`,
  );
  assert.equal(app.run('nodeEls.get(state.editing.id).nodeText.textContent'), '');
});
test('Escape cancels while speech has made the node non-editable', () => {
  const app = setup({ renderUI: true });
  mockSpeech(app);
  app.run('addChildAndEdit(state.map.root, true);');
  app.windowHandlers.get('keydown')({ key: 'Escape', preventDefault() {} });
  assert.equal(app.run('state.editing'), null);
  assert.equal(app.run('speech.active'), false);
  assert.equal(app.run('state.history.length'), 0);
});
test('editing Tab skips unsupported speech and reaches Done; reediting an empty child keeps it alive', () => {
  const app = setup({ renderUI: true });
  app.run('addChildAndEdit(state.map.root); startEdit(state.editing.id);');
  const target = app.run('nodeEls.get(state.editing.id).nodeText');
  target.isContentEditable = true;
  app.elements.get('#nodes').handlers.keydown({ target, key: 'Tab', stopPropagation() {}, preventDefault() {} });
  assert.equal(app.run('document.activeElement === $("#nodeSpeechDone")'), true);
  assert.equal(app.run('!!state.map.nodes[state.editing.id]'), true);
});

test('palm selects actual screen rectangles after pan/zoom and clears selection beyond node size', () => {
  const t = setup({ renderUI: true, handUI: true });
  prepareHand(t);
  t.run(`handSample(1 - 800/1200);`);
  assert.equal(t.run('state.selectedId'), 'a');
  assert.equal(t.elements.get('#handCursor').hidden, false);
  assert.equal(t.elements.get('#handCursor').dataset.state, 'hover');
  t.run(`state.view = { x: 200, y: 100, s: 2 }; handSample(.5, 100/680);`);
  assert.equal(t.run('state.selectedId'), 'a');
  t.run(`handSample(.01, .95);`);
  assert.equal(t.run('state.selectedId'), null);
  assert.equal(t.run('state.hand.hover'), null);
  assert.equal(t.elements.get('#handCursor').dataset.state, 'ready');
  t.run(`stableHand(.5, .5, .1); handSample(.2, .2, .1);`);
  assert.equal(
    t.run(
      '!state.gesture && !state.hand.grab && JSON.stringify(state.map) === originalMap && state.history.length === 0',
    ),
    true,
  );
});

test('pointing retains selection and never pans, zooms or moves nodes', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  t.run(
    `const beforePoint = JSON.stringify(state.view); for (let i = 0; i < 20; i++) handSample(.1 + i * .03, .2, .8, 'point');`,
  );
  assert.equal(
    t.run(
      'state.selectedId === state.map.root && JSON.stringify(state.view) === beforePoint && JSON.stringify(state.map) === originalMap && !state.gesture && state.history.length === 0',
    ),
    true,
  );
  assert.equal(t.elements.get('#handCursor').hidden, true);
});

test('hand commands do nothing when the pointer has cleared the selection', () => {
  const t = setup();
  prepareHand(t);
  t.run(`handSample(.01, .95); for (const pose of ['peace', 'thumbDown']) {
    for (let i = 0; i < 14; i++) handSample(.5, .5, .8, pose);
    for (let i = 0; i < 3; i++) handSample(.5, .5, .8, 'point');
  }`);
  assert.equal(
    t.run(
      'state.selectedId === null && !state.editing && !state.deletion && JSON.stringify(state.map) === originalMap && state.history.length === 0',
    ),
    true,
  );
});

test('palm cursor remains visible without a target, during dialogs and during two-hand zoom', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  t.run(`handSample(.01, .95);`);
  assert.equal(t.elements.get('#handCursor').hidden, false);
  t.run(`state.selectedId = 'a'; removeNode('a'); handSample(.2, .3);`);
  assert.equal(t.elements.get('#handCursor').hidden, false);
  assert.equal(t.elements.get('#handCursor').style.left, '960px');
  t.run(`closeDelete(); cameraSession.io.frame({ hands: 2, distance: .4,
    pointer: { x: .5, y: .5 }, palmPointer: { x: .5, y: .5 },
    palms: [{ x: .3, y: .5 }, { x: .7, y: .5 }] }, handTime += 50);`);
  assert.equal(t.elements.get('#handCursor').hidden, false);
  assert.equal(t.elements.get('#handCursor').style.left, '600px');
});

test('crossed index fingers stop the camera and clear Hand control until enabled again', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  t.run(`const crossSession = cameraSession;
    const crossSample = () => { crossSession.io.frame({ hands: 2, pose: 'cross' }, handTime); handTime += 50; };
    crossSample(); crossSample();`);
  assert.equal(t.run('cameraSession === crossSession'), true);
  assert.match(t.elements.get('#handHelp').textContent, /人差し指の×/);
  t.run('for (let i = 0; i < 6; i++) crossSample();');
  assert.equal(
    t.run('crossSession.stopped && cameraSession === null && handController === null && state.hand === null'),
    true,
  );
  assert.equal(t.elements.get('#handBtn').attributes['aria-pressed'], 'false');
  assert.equal(t.elements.get('#cam').hidden, true);
  assert.equal(t.elements.get('#handCursor').hidden, true);
  assert.equal(t.run('state.history.length === 0 && JSON.stringify(state.map) === originalMap'), true);
  t.run('toggleHand();');
  assert.equal(t.run('!!cameraSession && !handController.disabled'), true);
});

test('palm selection then pinch centers that node at the same scale without changing the map or history', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  t.run(`state.view.s = 1.5; stableHand(.25, .425); const centeredId = state.selectedId; const centeredScale = state.view.s;
    handSample(.05, .1, .1);`);
  assert.equal(t.run("centeredId === 'a' && state.selectedId === centeredId && state.hand.hover === centeredId"), true);
  assert.equal(
    t.run(
      'state.map.nodes[state.selectedId].x * state.view.s + state.view.x === viewportWidth()/2 && state.map.nodes[state.selectedId].y * state.view.s + state.view.y === canvasHeight()/2 && state.view.s === centeredScale',
    ),
    true,
  );
  assert.match(t.elements.get('#handHelp').textContent, /中央に移動しました/);
  t.run('const centerAnim = animId; stableHand(.1, .1, .1);');
  assert.equal(
    t.run(
      'animId === centerAnim && !state.gesture && state.history.length === 0 && JSON.stringify(state.map) === originalMap',
    ),
    true,
  );
});

test('camera video starts hidden, toggles and persists while the panel stays visible', () => {
  const t = setup({ handUI: true });
  assert.equal(t.run('camVideo'), false);
  const button = t.elements.get('#camVideoToggle');
  assert.equal(button.attributes['aria-pressed'], 'false');
  t.run('toggleHand();');
  button.onclick();
  assert.equal(t.run('camVideo && !$("#cam").hidden'), true);
  assert.equal(button.attributes['aria-pressed'], 'true');
  assert.equal(t.storage.get('mindmap-proto:camera-video'), '1');
  assert.equal(setup({ stored: { 'mindmap-proto:camera-video': '1' } }).run('camVideo'), true);
  button.onclick();
  assert.equal(t.storage.get('mindmap-proto:camera-video'), '');
});

test('the current hand pose is shown large and cleared when the hand is lost', () => {
  const t = setup({ handUI: true });
  prepareHand(t);
  const pose = () => t.elements.get('#handPose').textContent;
  assert.equal(pose(), '✋ パー');
  t.run('handSample(.5, .5, .1);');
  assert.equal(pose(), '🤏 つまみ');
  t.run("handSample(.5, .5, .8, 'peace');");
  assert.equal(pose(), '✌️ ピース');
  t.run("cameraSession.io.frame({ pointer: { x: .5, y: .5 }, ratio: .4, pose: 'neutral', hands: 2 }, handTime);");
  assert.equal(pose(), '❔ 判定なし');
  t.run('cameraSession.io.frame(null, handTime);');
  assert.equal(pose(), '');
});

test('node limits reject new children and image children atomically without recording edits', async () => {
  const t = setup();
  t.run(
    `state.map=blankMap();state.map.seq=2048;for(let i=1;i<2048;i++)state.map.nodes['limit'+i]={id:'limit'+i,text:'n',parent:'root',x:0,y:0,order:i};invalidateTree();const beforeLimit=JSON.stringify(state.map);`,
  );
  t.run(`addChildAndEdit('root');`);
  assert.equal(
    t.run(
      `JSON.stringify(state.map)===beforeLimit && state.history.length===0 && state.editing===null && !autosave.dirty`,
    ),
    true,
  );
  assert.match(t.run('notices.at(-1)'), /2,048/);
  t.run(`imageStore.put=async()=>({assetId:'sha256:'+'a'.repeat(64),width:1,height:1});`);
  await t.run(
    `attachNodeImage(new Blob(['test']),{nodeId:'root',child:true,mapSessionId: state.mapSessionId,revision: state.revision},'image')`,
  );
  assert.equal(t.run(`JSON.stringify(state.map)===beforeLimit && state.history.length===0 && !autosave.dirty`), true);
});
test('oversized text cannot be saved by either existing-node edits or new-node edits', () => {
  const t = setup({ renderUI: true });
  t.run(
    `const beforeLimit=JSON.stringify(state.map);startEdit('a');nodeEls.get('a').nodeText.textContent='x'.repeat(4001);finishEdit();`,
  );
  assert.equal(t.run(`JSON.stringify(state.map)===beforeLimit && state.history.length===0 && !autosave.dirty`), true);
  t.run(`addChildAndEdit('root');nodeEls.get(state.editing.id).nodeText.textContent='x'.repeat(4001);finishEdit();`);
  assert.equal(t.run(`JSON.stringify(state.map)===beforeLimit && state.history.length===0`), true);
  assert.match(t.run('notices.at(-1)'), /4,000/);
});

test('depth and title limits keep the previous map and history unchanged', () => {
  const t = setup();
  t.run(
    `state.map=blankMap();state.map.seq=64;for(let i=1;i<=64;i++)state.map.nodes['d'+i]={id:'d'+i,text:'n',parent:i===1?'root':'d'+(i-1),x:0,y:0,order:i};invalidateTree();const beforeDepth=JSON.stringify(state.map);addChildAndEdit('d64');`,
  );
  assert.equal(
    t.run(
      `JSON.stringify(state.map)===beforeDepth && state.history.length===0 && state.editing===null && !autosave.dirty`,
    ),
    true,
  );
  assert.match(t.run('notices.at(-1)'), /64/);
  t.run(`$('#title').oninput({target:{value:'x'.repeat(1001)}});`);
  assert.equal(
    t.run(
      `JSON.stringify(state.map)===beforeDepth && state.history.length===0 && $('#title').value===state.map.title && !autosave.dirty`,
    ),
    true,
  );
  assert.match(t.run('notices.at(-1)'), /1,000/);
});

test('new-node previews preserve redo and pending saves until confirmation', async () => {
  const t = setup({ renderUI: true });
  t.run(`commit(() => { state.map.nodes.a.text = 'saved edit'; });
    commit(() => { state.map.nodes.b.text = 'redo edit'; }); undo();
    const committed = JSON.stringify(state.map), token = state.historyToken;
    addChildAndEdit('a'); const newId = state.editing.id;`);
  assert.equal(t.run(`state.history.length === 1 && state.future.length === 1 && state.historyToken === token`), true);
  await t.run('flushSave()');
  assert.equal(t.run(`JSON.stringify(state.library.docs.get('m_first').map) === committed`), true);
  t.run('cancelEdit();');
  assert.equal(
    t.run(
      `JSON.stringify(state.map) === committed && state.future.length === 1 && state.historyToken === token && !autosave.dirty`,
    ),
    true,
  );
  t.run(`addChildAndEdit('a'); const confirmedId = state.editing.id;
    nodeEls.get(confirmedId).nodeText.textContent = 'confirmed'; finishEdit();`);
  assert.equal(
    t.run(`state.history.length === 2 && state.future.length === 0 && state.historyToken === token + 1`),
    true,
  );
  t.run('undo();');
  assert.equal(t.run(`JSON.stringify(state.map) === committed`), true);
  t.run('redo();');
  assert.equal(t.run(`state.map.nodes[confirmedId].text === 'confirmed'`), true);
});

test('Undo confirms a first new-node edit before undoing it, and Redo rejects a stale branch', () => {
  const t = setup({ renderUI: true });
  t.run(`const original = JSON.stringify(state.map); addChildAndEdit('a');
    nodeEls.get(state.editing.id).nodeText.textContent = 'first'; undo();`);
  assert.equal(
    t.run(
      `JSON.stringify(state.map) === original && state.history.length === 0 && state.future.length === 1 && !state.editing`,
    ),
    true,
  );
  t.run(`addChildAndEdit('b'); const replacement = state.editing.id;
    nodeEls.get(replacement).nodeText.textContent = 'replacement'; redo();`);
  assert.equal(
    t.run(
      `state.history.length === 1 && state.future.length === 0 && state.map.nodes[replacement].text === 'replacement'`,
    ),
    true,
  );
});

test('drag validation and read-only rejection restore the preview without registering history', () => {
  for (const fail of ['invalid', 'readonly', 'swap']) {
    const t = setup({ renderUI: true });
    t.run(`const original = JSON.stringify(state.map), token = state.historyToken;
      beginNodeDrag('a', 0, 0); const drag = state.gesture;
      moveNodeDrag(drag, 40, 30);`);
    if (fail === 'invalid') t.run(`state.map.nodes.a.x = NaN;`);
    if (fail === 'readonly') t.run(`state.mapClaim.editable = false;`);
    if (fail === 'swap') t.run(`drag.swap = 'missing';`);
    t.run('finishNodeDrag(drag);');
    assert.equal(
      t.run(
        `JSON.stringify(state.map) === original && state.history.length === 0 && state.historyToken === token && !autosave.dirty && !state.gesture`,
      ),
      true,
      fail,
    );
  }
});

test('saving during a drag stores committed positions and confirmation saves one undoable move', async () => {
  const t = setup({ renderUI: true });
  t.run(`commit(() => { state.map.title = 'pending'; }); const original = JSON.stringify(state.map);
    beginNodeDrag('a', 0, 0); const drag = state.gesture; moveNodeDrag(drag, 40, 30);`);
  await t.run('flushSave()');
  assert.equal(t.run(`JSON.stringify(state.library.docs.get('m_first').map) === original`), true);
  t.run('finishNodeDrag(drag);');
  await t.run('flushSave()');
  assert.equal(t.run(`state.history.length === 2 && state.library.docs.get('m_first').map.nodes.a.x === 350`), true);
  t.run('undo();');
  assert.equal(t.run(`JSON.stringify(state.map) === original`), true);
});

test('another committed change settles a new-node preview before recording its own history', () => {
  const t = setup({ renderUI: true });
  t.run(`const original = JSON.stringify(state.map); addChildAndEdit('a', true);
    nodeEls.get(state.editing.id).nodeText.textContent = 'new child';
    commit(() => { state.map.title = 'other change'; });`);
  assert.equal(t.run(`!state.editing && state.history.length === 2 && state.map.title === 'other change'`), true);
  t.run('undo(); undo();');
  assert.equal(t.run(`JSON.stringify(state.map) === original`), true);
});
