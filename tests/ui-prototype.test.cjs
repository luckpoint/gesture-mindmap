const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

// Run the actual inline script with minimal DOM/storage adapters. These tests
// cover state transitions and import failures, not browser layout or real touch.
const html = readFileSync(join(__dirname, '../ui-prototype/index.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
function setup({ renderUI = false, handUI = false } = {}) {
  const elements = new Map(), storage = new Map(), timers = new Map(), documentHandlers = new Map(), windowHandlers = new Map();
  let timerId = 0;
  const frames = new Map(), intervals = new Map();
  function element(key) {
    if (!elements.has(key)) elements.set(key, {
      dataset: {}, style: { setProperty(name, value) { this[name] = value; } }, classList: { add() {}, remove() {}, toggle() {} },
      firstChild: { textContent: '', dataset: {}, focus() { context.document.activeElement = this; },
        closest() { return this.contentEditable === 'plaintext-only' ? this : null; } }, attributes: {}, children: [], isConnected: false,
      offsetWidth: 120, offsetHeight: 50,
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 1200, bottom: 800 }),
      append(child) { this.children.push(child); child.isConnected = true; },
      remove() { this.isConnected = false; },
      handlers: {}, hidden: false, value: '', disabled: false,
      addEventListener(name, fn) { this.handlers[name] = fn; },
      setPointerCapture() {}, focus() { context.document.activeElement = this; }, setAttribute(name, value) { this.attributes[name] = value; },
      showModal() { this.open = true; }, close() { this.open = false; },
      querySelector: element,
    });
    return elements.get(key);
  }
  const context = vm.createContext({
    console, TextEncoder, AbortSignal, innerWidth: 1200, innerHeight: 800,
    matchMedia: () => ({ matches: true }),
    document: { querySelector: element, createElement: () => element(Symbol()), createElementNS: () => element(Symbol()), createRange: () => ({ selectNodeContents() {} }), addEventListener: (name, fn) => documentHandlers.set(name, fn) },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
    CameraSession: class { constructor(io) { this.io = io; } start() {} stop() { this.stopped = true; } },
    localStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: key => storage.delete(key),
    },
    setTimeout: fn => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: id => timers.delete(id),
    setInterval: fn => { intervals.set(++timerId, fn); return timerId; },
    clearInterval: id => intervals.delete(id),
    requestAnimationFrame: fn => { frames.set(++timerId, fn); return timerId; },
    cancelAnimationFrame: id => frames.delete(id),
    addEventListener: (name, fn) => windowHandlers.set(name, fn),
  });
  context.document.body = element('body');
  // Skip only the initial screen draw; all production handlers are registered.
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/gestures/controller.js'), 'utf8'), context);
  for (const file of ['operations.js', 'client.js']) vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/instructions', file), 'utf8'), context);
  vm.runInContext(script.slice(0, script.lastIndexOf("\n$('#title').value = map.title;")), context);
  vm.runInContext(`
    ${renderUI ? '' : 'render = () => {};'} fitAll = () => {}; applyView = () => {};
    ${handUI ? '' : 'updateHand = () => {};'} const notices = []; toast = message => notices.push(message);
  `, context);
  if (renderUI) vm.runInContext('render();', context);
  return { context, elements, storage, timers, frames, intervals, documentHandlers, windowHandlers,
    flushFrame() { const queued = [...frames.values()]; frames.clear(); queued.forEach(fn => fn()); },
    run: code => vm.runInContext(code, context) };
}

test('validation accepts an exported map and rejects malformed data', () => {
  const { run } = setup();
  assert.equal(run('valid(JSON.parse(JSON.stringify(sample())))'), true);
  for (const mutation of [
    'm = null', 'm = []', 'm.version = 2', 'delete m.title', 'm.nodes = []',
    'm.root = "absent"', 'm.nodes.a = null', 'm.nodes.a.id = "absent"',
    'm.nodes.a.id = "root"', 'm.nodes.a.x = null', 'm.nodes.a.x = "12"',
    'm.nodes.a.y = Infinity', 'm.nodes.a.y = NaN', 'm.nodes.a.text = 1',
    'delete m.nodes.root.parent', 'm.nodes.a.parent = null',
    'm.nodes.a.parent = "missing"', 'm.nodes.a.parent = "toString"',
    'm.nodes.a.parent = "a"', 'm.nodes.a.parent = "a1"',
    'delete m.nodes.a.order', 'm.nodes.a.order = -1', 'm.nodes.a.order = 1.5',
    'm.nodes.a.order = m.seq + 1', 'm.seq = "7"', 'm.seq = -1',
    'm.seq = Number.MAX_SAFE_INTEGER',
  ]) {
    assert.equal(run(`{ let m = sample(); ${mutation}; valid(m); }`), false, mutation);
  }
});

test('invalid imports preserve map, selection, history, pending save and storage', () => {
  const { run, storage, timers } = setup();
  run(`localStorage.setItem(KEY, JSON.stringify(map));
    const original = map; sel = 'a'; history.push('undo'); future.push('redo');
    scheduleSave(); const pendingSave = saveTimer;
  `);
  const stored = storage.get('mindmap-proto:v1');
  assert.throws(() => run(`{ const m = sample(); m.nodes.a.id = 'missing'; importMap(m); }`));
  assert.equal(run(`map === original && sel === 'a' && history[0] === 'undo' && future[0] === 'redo' && saveTimer === pendingSave`), true);
  assert.equal(storage.get('mindmap-proto:v1'), stored);
  assert.equal(timers.size, 1);
});

test('a failed save preserves the working map and its pending save', () => {
  const { run, timers } = setup();
  run(`const original = map; scheduleSave();
    localStorage.setItem = () => { throw new Error('quota exceeded'); };
  `);
  assert.throws(() => run('importMap(sample())'), /quota exceeded/);
  assert.equal(run('map === original'), true);
  assert.equal(timers.size, 1);
});

test('render failure rolls back map, selection, history, view and saved data', () => {
  const { run, storage, timers } = setup();
  run(`const original = map; sel = 'a'; history.push('undo'); future.push('redo');
    localStorage.setItem(KEY, JSON.stringify(map));
    view = { x: 12, y: 34, s: 1.5 };
    render = () => { render = () => {}; throw new Error('render failed'); };
  `);
  const stored = storage.get('mindmap-proto:v1');
  assert.throws(() => run(`{ const m = sample(); m.title = 'imported'; importMap(m); }`), /render failed/);
  assert.equal(run(`map === original && sel === 'a' && history[0] === 'undo' && future[0] === 'redo' && view.x === 12 && view.y === 34 && view.s === 1.5`), true);
  assert.equal(storage.get('mindmap-proto:v1'), stored);
  assert.equal(timers.size, 1);
});

test('valid import saves before rendering and resets selection and history', () => {
  const { run, storage, timers } = setup();
  run(`history.push('undo'); future.push('redo'); scheduleSave();
    render = () => { if (JSON.parse(localStorage.getItem(KEY)).title !== 'imported') throw new Error('not saved'); };
    const imported = sample(); imported.title = 'imported'; importMap(imported);
  `);
  assert.equal(run('map === imported && sel === imported.root && history.length === 0 && future.length === 0'), true);
  assert.equal(JSON.parse(storage.get('mindmap-proto:v1')).title, 'imported');
  assert.equal(timers.size, 0);
});

test('import does not replace a map during an active operation', () => {
  for (const state of ['editing', 'gesture', 'mode']) {
    const { run, storage } = setup();
    run(`const original = map; ${state} = {};`);
    assert.throws(() => run('importMap(sample())'), /操作を終えて/);
    assert.equal(run('map === original'), true);
    assert.equal(storage.size, 0);
  }
});

test('file handler rejects broken JSON and ignores an older async read', async () => {
  const { run, elements } = setup();
  const change = elements.get('#fileInput').onchange;
  const input = text => ({ target: { files: [{ text }], value: 'file.json' } });
  run('const original = map;');
  await change(input(async () => '{'));
  assert.equal(run('map === original'), true);
  assert.match(run('notices[0]'), /維持/);
  let resolveOld;
  const oldRead = change(input(() => new Promise(resolve => { resolveOld = resolve; })));
  const latest = JSON.parse(run('JSON.stringify(sample())'));
  latest.title = 'latest';
  await change(input(async () => JSON.stringify(latest)));
  latest.title = 'older';
  resolveOld(JSON.stringify(latest));
  await oldRead;
  assert.equal(run('map.title'), 'latest');
});

for (const endEvent of ['pointerup', 'pointercancel']) {
  test(`pinch ends safely on ${endEvent} and the remaining finger cannot move the view`, () => {
    const { run, elements } = setup();
    const handlers = elements.get('#viewport').handlers;
    const pointer = (id, x, y) => ({ pointerId: id, clientX: x, clientY: y, pointerType: 'touch', target: { closest: () => null } });
    handlers.pointerdown(pointer(1, 100, 100));
    handlers.pointerdown(pointer(2, 200, 200));
    handlers.pointermove(pointer(2, 250, 250));
    const before = run('JSON.stringify(view)');
    handlers[endEvent](pointer(2, 250, 250));
    assert.equal(run('gesture'), null);
    handlers.pointermove(pointer(1, 130, 130));
    assert.equal(run('JSON.stringify(view)'), before);
    handlers.pointerup(pointer(1, 130, 130));
    assert.equal(run('pts.size'), 0);
    handlers.pointerdown(pointer(3, 100, 100));
    handlers.pointermove(pointer(3, 150, 150));
    assert.notEqual(run('JSON.stringify(view)'), before);
  });
}

test('coincident touch points do not produce nonfinite view coordinates', () => {
  const { run, elements } = setup();
  const handlers = elements.get('#viewport').handlers;
  const pointer = id => ({ pointerId: id, clientX: 100, clientY: 100, pointerType: 'touch', target: { closest: () => null } });
  handlers.pointerdown(pointer(1));
  handlers.pointerdown(pointer(2));
  handlers.pointermove(pointer(2));
  assert.equal(run('Number.isFinite(view.x) && Number.isFinite(view.y) && Number.isFinite(view.s)'), true);
});

test('tree metadata is reused for movement and refreshed for structural changes and undo', () => {
  const { run } = setup();
  assert.equal(run(`branchColor('a1') === branchColor('a') && depth('a1') === 2`), true);
  run(`const initialTree = treeInfo(); map.nodes.a.x += 10;`);
  assert.equal(run('treeInfo() === initialTree'), true);
  run(`let added; commit(() => { added = addNode('a1', 'child', {x:0,y:0}); });`);
  assert.equal(run(`treeInfo() !== initialTree && depth(added) === 3 && branchColor(added) === branchColor('a')`), true);
  run(`startReparent('a'); setCandidate('b1'); confirmReparent();`);
  assert.equal(run(`depth('a1') === 4 && branchColor('a1') === branchColor('b')`), true);
  run('undo();');
  assert.equal(run(`depth('a1') === 2 && branchColor('a1') !== branchColor('b')`), true);
  run(`removeNode('b'); chooseDeleteScope('branch'); confirmDelete();`);
  assert.equal(run(`kids(map.root).map(n => n.id).join(',') === 'a,c' && branchColor('c1') === 'var(--branch-2)'`), true);
  run(`importMap(sample());`);
  assert.equal(run(`kids(map.root).length === 3 && branchColor('c1') === 'var(--branch-3)'`), true);
});

const mouse = (x, y, id = null) => ({
  pointerId: 1, clientX: x, clientY: y, pointerType: 'mouse',
  target: { closest: () => id ? { dataset: { id } } : null },
});

test('reparent reuses its exclusion set across pointer moves and redraws', () => {
  const { run, elements } = setup({ renderUI: true });
  run(`render();
    const findSubtree = subtree;
    let subtreeCalls = 0;
    subtree = id => { subtreeCalls++; return findSubtree(id); };
    startReparent('a');
    const blocked = mode.blocked;
    const drawNode = renderNode;
    renderNode = (n, excluded) => {
      if (mode && excluded !== mode.blocked) throw new Error('exclusion set not reused');
      drawNode(n, excluded);
    };
  `);
  const move = elements.get('#viewport').handlers.pointermove;
  for (const id of ['a', 'a1', 'b', 'b', 'b1', null, null]) {
    move(mouse(100, 100, id));
    assert.equal(run('mode.candidate'), id === 'a' || id === 'a1' ? null : id);
  }
  run('render();');
  assert.equal(run(`subtreeCalls === 1 && mode.blocked === blocked && blocked.has('a') && blocked.has('a1')`), true);
  run(`setCandidate('b'); confirmReparent(); startReparent('b');`);
  assert.equal(run(`subtreeCalls === 2 && mode.blocked !== blocked && mode.blocked.has('a1')`), true);
  run(`setCandidate('a1');`);
  assert.equal(run('mode.candidate'), null);
  run('endReparent(); setCandidate(null);');
  assert.equal(run('mode'), null);
});

test('205 drags retain only the latest 200 snapshots and support undo and redo', () => {
  const { run, elements } = setup();
  const handlers = elements.get('#viewport').handlers;
  for (let i = 0; i < 205; i++) {
    handlers.pointerdown(mouse(100, 100, 'a'));
    handlers.pointermove(mouse(110, 100));
    handlers.pointerup(mouse(110, 100));
  }
  assert.equal(run('history.length'), 200);
  assert.equal(run('JSON.parse(history[0]).nodes.a.x'), 360);
  assert.equal(run('map.nodes.a.x'), 2360);
  run('for (let i = 0; i < 205; i++) undo();');
  assert.equal(run('map.nodes.a.x === 360 && history.length === 0 && future.length === 200'), true);
  run('for (let i = 0; i < 205; i++) redo();');
  assert.equal(run('map.nodes.a.x === 2360 && history.length === 200 && future.length === 0'), true);
  run(`commit(() => { map.nodes.a.text = 'changed'; });`);
  assert.equal(run('history.length'), 200);
  run('undo();');
  handlers.pointerdown(mouse(100, 100, 'a'));
  handlers.pointermove(mouse(110, 100));
  handlers.pointerup(mouse(110, 100));
  assert.equal(run('history.length === 200 && future.length === 0'), true);
  run('undo();');
  assert.equal(run(`map.nodes.a.x === 2360 && map.nodes.a.text !== 'changed'`), true);
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
  assert.equal(run(`els.get('a').style['--x'] === '350px' && els.get('a1').style['--x'] === '580px'`), true);
  assert.equal(run(`edgeEls.get('a').attributes.d === curve(map.nodes.root, map.nodes.a) && edgeEls.get('b1') === untouchedEdge`), true);
  handlers.pointerup(mouse(140, 130));
  run('undo();');
  assert.equal(run(`map.nodes.a.x === 310 && els.get('a').style['--x'] === '310px'`), true);
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
    assert.equal(run('map.nodes.a1.x'), expected);
    assert.equal(run(`els.get('a1').style['--x']`), `${expected}px`);
    assert.equal(run('history.length'), endEvent === 'pointerup' ? 1 : 0);
  });
}

test('SVG paths survive redraws and obsolete paths are removed', () => {
  const { run } = setup({ renderUI: true });
  run(`render(); const originalEdge = edgeEls.get('a'); select('b');`);
  assert.equal(run(`edgeEls.get('a') === originalEdge && edgeEls.size === 6`), true);
  run(`startReparent('a'); setCandidate('b1');`);
  assert.equal(run(`previewEdge.isConnected && previewEdge.attributes.d === curve(map.nodes.b1, map.nodes.a)`), true);
  run(`confirmReparent();`);
  assert.equal(run(`previewEdge === null && edgeEls.get('a') === originalEdge && originalEdge.attributes.d === curve(map.nodes.b1, map.nodes.a)`), true);
  run(`removeNode('a'); chooseDeleteScope('branch'); confirmDelete();`);
  assert.equal(run(`!originalEdge.isConnected && !edgeEls.has('a') && !edgeEls.has('a1')`), true);
});

function mockInstruction(t, operations) {
  t.run(`var resolveInstruction;
    instructionClient.run = () => new Promise(resolve => { resolveInstruction = resolve; });
    $('#promptInput').value = '指示';
  `);
  const pending = t.run('sendInstruction()');
  return { pending, finish: () => t.run(`resolveInstruction(${JSON.stringify({status:'ok', message:'', operations})});`) };
}

test('instructions apply multiple operations as one undo/redo entry and share export serialization', async () => {
  const t = setup(); const before = t.run('JSON.stringify(serializeMap())');
  const request = mockInstruction(t, [{type:'add_node',clientId:'new_1',parentId:'b',text:'本を借りる'}, {type:'add_node',clientId:'new_2',parentId:'new_1',text:'返却する'}]);
  assert.equal(t.run('Object.keys(map.nodes).length'), 7);
  request.finish(); await request.pending;
  assert.equal(t.run('Object.keys(map.nodes).length === 9 && history.length === 1 && instruction === null'), true);
  assert.equal(t.elements.get('#promptInput').value, '');
  t.run('undo()'); assert.equal(t.run('JSON.stringify(map)'), before);
  t.run('redo()'); assert.equal(t.run('Object.keys(map.nodes).length'), 9);
});

test('a bad later instruction leaves the map and history intact', async () => {
  const t = setup(); const before = t.run('JSON.stringify(map)');
  const request = mockInstruction(t, [{type:'add_node',clientId:'new_1',parentId:'b',text:'本'}, {type:'reparent_node',nodeId:'root',parentId:'new_1'}]);
  request.finish(); await request.pending;
  assert.equal(t.run('JSON.stringify(map)'), before);
  assert.equal(t.run('history.length'), 0);
  assert.equal(t.elements.get('#promptInput').value, '指示');
});

test('instructions reject edits, undo cycles, imports, and unfinished gestures while selection changes are allowed', async () => {
  for (const action of ["commit(() => { map.nodes.a.text = '変更'; });", "commit(() => { map.nodes.a.text = '変更'; }); undo();", "importMap(sample());", "gesture = { type: 'node' };", "editing = { id: 'a' };"]) {
    const t = setup(); const request = mockInstruction(t, [{type:'update_node',nodeId:'b',text:'新しい本'}]);
    t.run(action); request.finish(); await request.pending;
    assert.equal(t.run("map.nodes.b.text"), '図書館に行く', action);
    assert.match(t.elements.get('#instructionToast').textContent, /マップが変わった/);
  }
  const t = setup(); const request = mockInstruction(t, [{type:'update_node',nodeId:'b',text:'新しい本'}]);
  t.run("sel = 'a';"); request.finish(); await request.pending;
  assert.equal(t.run("map.nodes.b.text === '新しい本' && sel === 'a'"), true);
});

test('mixed deletion stays atomic and can be cancelled or confirmed after changing scopes', async () => {
  const t = setup(); const request = mockInstruction(t, [{type:'add_node',clientId:'new_1',parentId:'b',text:'本'}, {type:'delete_node',nodeId:'a',scope:'single'}]);
  request.finish(); await request.pending;
  assert.equal(t.run("instruction.state === 'awaiting_confirmation' && Object.keys(map.nodes).length === 7 && history.length === 0"), true);
  t.run("instruction.proposal.operations[1].scope = 'subtree'; updateInstructionPreview(); applyInstruction();");
  assert.equal(t.run("!map.nodes.a && !map.nodes.a1 && Object.keys(map.nodes).length === 6 && history.length === 1"), true);
  t.run('undo()'); assert.equal(t.run('Object.keys(map.nodes).length'), 7);
  const second = mockInstruction(t, [{type:'delete_node',nodeId:'a',scope:'single'}]); second.finish(); await second.pending;
  t.run('cancelInstruction()'); assert.equal(t.run("!!map.nodes.a && instruction === null && history.length === 0"), true);
});

test('deletion scope validation can recover from an invalid combination', async () => {
  const t = setup(); const request = mockInstruction(t, [{type:'delete_node',nodeId:'a',scope:'single'}, {type:'update_node',nodeId:'a1',text:'残す'}]);
  request.finish(); await request.pending;
  t.run("instruction.proposal.operations[0].scope = 'subtree'; updateInstructionPreview();");
  assert.equal(t.elements.get('#instructionConfirm').disabled, true);
  t.run("instruction.proposal.operations[0].scope = 'single'; updateInstructionPreview();");
  assert.equal(t.elements.get('#instructionConfirm').disabled, false);
  t.run('applyInstruction()'); assert.equal(t.run("map.nodes.a1.text === '残す' && map.nodes.a1.parent === 'root'"), true);
});

test('late cancelled results cannot apply and an edited draft survives success', async () => {
  const t = setup(); const request = mockInstruction(t, [{type:'update_node',nodeId:'b',text:'新しい本'}]);
  t.run('cancelInstruction()'); request.finish(); await request.pending;
  assert.equal(t.run("map.nodes.b.text"), '図書館に行く');
  const next = mockInstruction(t, [{type:'update_node',nodeId:'b',text:'新しい本'}]);
  t.run("$('#promptInput').value = '次の指示'; draftVersion++;"); next.finish(); await next.pending;
  assert.equal(t.elements.get('#promptInput').value, '次の指示');
  const button = t.run('instructionUndoButton'); assert.equal(button.disabled, false);
  t.run("commit(() => { map.nodes.a.text = '編集'; }); undo();"); assert.equal(button.disabled, true);
});

test('IME Enter does not submit, Shift Enter stays a newline, plain Enter submits', () => {
  const t = setup(); t.run('let sends = 0; sendInstruction = () => { sends++; };');
  const key = t.elements.get('#promptInput').onkeydown;
  let prevented = 0; const press = opts => key({ key: 'Enter', preventDefault() { prevented++; }, ...opts });
  press({isComposing:true}); press({keyCode:229}); press({shiftKey:true});
  assert.equal(t.run('sends'), 0); assert.equal(prevented, 0);
  press({}); assert.equal(t.run('sends'), 1); assert.equal(prevented, 1);
});

function prepareHand(t) {
  t.run(`
    map.nodes.root.x = 0; map.nodes.root.y = 0;
    map.nodes.a.x = 200; map.nodes.a.y = 0;
    map.nodes.a1.x = 400; map.nodes.a1.y = 0;
    map.nodes.b.x = -200; map.nodes.b.y = 200;
    sel = 'root'; toggleHand(); let handTime = 0;
    const handSample = (x = .5, y = .5, ratio = .8) => {
      cameraSession.io.frame({ pointer: { x, y }, wrist: { x: .5, y: .7 }, ratio, identity: 'Left' }, handTime);
      handTime += 50;
    };
    const stableHand = (x = .5, y = .5, ratio = .8) => { for (let i = 0; i < 3; i++) handSample(x, y, ratio); };
    stableHand(); const originalMap = JSON.stringify(map);
  `);
}

test('camera direction changes selection from the current node without changing map/history/save', () => {
  const t = setup({ renderUI: true }); prepareHand(t);
  t.run(`view.s = 2; handSample(.4);`);
  assert.equal(t.run(`sel`), 'a');
  t.run(`for (let i = 0; i < 6; i++) handSample(.4); handSample(.3);`);
  assert.equal(t.run('sel'), 'a1');
  assert.equal(t.run(`JSON.stringify(map) === originalMap && history.length === 0 && future.length === 0 && !gesture`), true);
  assert.equal(t.timers.size, 0); assert.equal(t.storage.size, 0);
});

test('camera down-left selects a diagonal node, no candidate and stopping retain it', () => {
  const t = setup(); prepareHand(t);
  t.run(`handSample(.6, .6); for (let i = 0; i < 6; i++) handSample(.6, .6); handSample(.7, .7);`);
  assert.equal(t.run('sel'), 'b');
  t.run(`for (let i = 0; i < 15; i++) handSample(.7, .7);`);
  assert.equal(t.run(`sel === 'b' && JSON.stringify(map) === originalMap && history.length === 0`), true);
});

test('keyboard and camera directions only reach parent, children and siblings', () => {
  const t = setup(); prepareHand(t);
  t.run(`map.nodes.b.x = 600; map.nodes.b.y = 0; sel = 'a1';`);
  const press = key => t.windowHandlers.get('keydown')({ key, target: t.elements.get('#viewport'), preventDefault() {} });
  press('ArrowRight');
  assert.equal(t.run('sel'), 'a1');
  t.run(`handSample(.4); for (let i = 0; i < 6; i++) handSample(.4); handSample(.3);`);
  assert.equal(t.run('sel'), 'a1');
  press('ArrowLeft');
  assert.equal(t.run('sel'), 'a');
});

test('no active node initializes to root; pinch grabs root without displacement', () => {
  const t = setup(); prepareHand(t);
  t.run(`sel = null; interruptHand(); stableHand(); stableHand(.1, .5, .1);`);
  assert.equal(t.run(`sel === map.root && gesture.hand && hand.grab === map.root && JSON.stringify(map) === originalMap`), true);
});

test('normal pointer input takes priority and retains undoable subtree dragging', () => {
  const t = setup(); prepareHand(t);
  const handlers = t.elements.get('#viewport').handlers;
  handlers.pointerdown(mouse(100, 100, 'a'));
  t.run(`stableHand(.1);`);
  handlers.pointermove(mouse(140, 100)); handlers.pointerup(mouse(140, 100));
  assert.equal(t.run(`map.nodes.a.x === 240 && map.nodes.a1.x === 440 && history.length === 1`), true);
  t.run('undo();'); assert.equal(t.run('JSON.stringify(map) === originalMap'), true);
});

for (const event of ['blur', 'pagehide', 'visibilitychange']) test(`${event} stops camera and retains the active node`, () => {
  const t = setup(); prepareHand(t);
  t.run(`const session = cameraSession; handSample(.4);`);
  if (event === 'visibilitychange') { t.run('document.hidden = true;'); t.documentHandlers.get(event)(); }
  else t.windowHandlers.get(event)();
  assert.equal(t.run(`session.stopped && !hand && !cameraSession && !gesture && sel === 'a' && JSON.stringify(map) === originalMap`), true);
});

test('editing and reparent mode block directional selection and pinch', () => {
  for (const state of ["editing = { id: 'root' }", "startReparent('b')"]) {
    const t = setup(); prepareHand(t); t.run(state);
    const selected = t.run('sel');
    t.run(`stableHand(.1); stableHand(.1, .5, .1);`);
    assert.equal(t.run('sel'), selected);
    assert.equal(t.run(`!gesture && history.length === 0 && JSON.stringify(map) === originalMap`), true);
  }
});

test('tracking recovery and manual selection reset the directional baseline', () => {
  const t = setup(); prepareHand(t);
  t.run(`handSample(.46); cameraSession.io.frame(null, handTime); handTime += 50; stableHand(.1);`);
  assert.equal(t.run('sel'), 'root');
  t.run(`interruptHand(); select('a'); stableHand(.7);`);
  assert.equal(t.run(`sel === 'a' && JSON.stringify(map) === originalMap`), true);
});

test('camera UI distinguishes detection, readiness, pinch and loss without a cursor', () => {
  const t = setup({ handUI: true }); prepareHand(t);
  assert.match(t.elements.get('#handHelp').textContent, /手を認識しています/);
  assert.equal(t.elements.get('#camMsg').hidden, true);
  assert.equal(t.elements.get('#handCursor').hidden, true);
  t.run('interruptHand(); handSample();');
  assert.match(t.elements.get('#camMsg').textContent, /手を認識しました/);
  t.run('handSample(.5, .5, .1);');
  assert.match(t.elements.get('#camMsg').textContent, /親指と人差し指/);
  t.run('cameraSession.io.frame(null, handTime);');
  assert.match(t.elements.get('#camMsg').textContent, /追跡が途切れました/);
});

test('pinch moves the active subtree, freezes directional selection and commits one undo step', () => {
  const t = setup({ handUI: true }); prepareHand(t);
  t.run(`view.s = 2; handSample(.4); Object.assign(handController.config, { smoothing: 1, gain: 1, deadzone: 0 });
    stableHand(.4, .5, .1);`);
  assert.equal(t.run(`sel === 'a' && hand.grab === 'a' && gesture.hand && JSON.stringify(map) === originalMap`), true);
  assert.match(t.elements.get('#handHelp').textContent, /つかみ中/);
  t.run('handSample(.3, .5, .1);');
  assert.equal(t.run(`sel === 'a' && map.nodes.a.x === 260 && map.nodes.a1.x === 460 && history.length === 0`), true);
  t.run('stableHand(.2);'); // Finger opening motion must not move the node.
  assert.equal(t.run(`!gesture && !hand.grab && map.nodes.a.x === 260 && history.length === 1`), true);
  t.run('undo();'); assert.equal(t.run('JSON.stringify(map) === originalMap'), true);
  t.run('redo();'); assert.equal(t.run('map.nodes.a.x === 260 && map.nodes.a1.x === 460'), true);
});

for (const cause of ['loss', 'stop', 'undo', 'pointer']) test(`${cause} cancels a pinch preview without committing it`, () => {
  const t = setup(); prepareHand(t);
  t.run(`sel = 'a'; stableHand(.5, .5, .1); handSample(.4, .5, .1);`);
  assert.equal(t.run('!!gesture?.hand && map.nodes.a.x > 200'), true);
  if (cause === 'loss') t.run('cameraSession.io.frame(null, handTime);');
  if (cause === 'stop') t.run('stopHand();');
  if (cause === 'undo') t.run('undo();');
  if (cause === 'pointer') t.elements.get('#viewport').handlers.pointerdown(mouse(100, 100, 'b'));
  assert.equal(t.run('JSON.stringify(map) === originalMap && history.length === 0'), true);
  assert.equal(t.run('!!gesture?.hand'), false);
});

test('a pending save excludes pinch preview and loss requires reopening before another grab', () => {
  const t = setup(); prepareHand(t);
  t.run(`sel = 'a'; scheduleSave(); stableHand(.5, .5, .1); handSample(.4, .5, .1);`);
  [...t.timers.values()].at(-1)();
  assert.equal(t.storage.get('mindmap-proto:v1'), t.run('originalMap'));
  t.run(`cameraSession.io.frame(null, handTime); handTime += 50; stableHand(.1, .5, .1);`);
  assert.equal(t.run('!gesture && !hand.grab && JSON.stringify(map) === originalMap'), true);
  t.run('stableHand(.1); stableHand(.1, .5, .1);');
  assert.equal(t.run("hand.grab === 'a'"), true);
});

test('two-hand zoom anchors viewport center, clamps scale and leaves nodes/history intact', () => {
  const t = setup({ handUI: true }); prepareHand(t);
  t.run(`
    const zoomSample = distance => { cameraSession.io.frame({ hands: 2, distance }, handTime); handTime += 50; };
    const centerBefore = { x: (W()/2-view.x)/view.s, y: (H()/2-view.y)/view.s };
    const scaleBefore = view.s;
    zoomSample(.4); zoomSample(.4); zoomSample(.4); zoomSample(.5);
  `);
  assert.equal(t.run('view.s < scaleBefore'), true);
  assert.equal(t.run('Math.abs((W()/2-view.x)/view.s-centerBefore.x) < 1e-8 && Math.abs((H()/2-view.y)/view.s-centerBefore.y) < 1e-8'), true);
  assert.match(t.elements.get('#handHelp').textContent, /両手を広げると縮小/);
  assert.equal(t.elements.get('#camMsg').hidden, true);
  t.run('zoomSample(.4);');
  assert.equal(t.run('Math.abs(view.s-scaleBefore) < 1e-8'), true);
  t.run('view.s = ZMAX; zoomSample(.3);');
  assert.equal(t.run('view.s === ZMAX'), true);
  t.run('view.s = ZMIN; zoomSample(.4);');
  assert.equal(t.run('view.s === ZMIN && history.length === 0 && JSON.stringify(map) === originalMap'), true);
});

test('second hand reverts a moved node before zooming, and editing blocks zoom', () => {
  const t = setup(); prepareHand(t);
  t.run(`stableHand(.5, .5, .1); handSample(.3, .5, .1);
    const zoomSample = distance => { cameraSession.io.frame({ hands: 2, distance }, handTime); handTime += 50; };
    zoomSample(.4); zoomSample(.4); zoomSample(.4); zoomSample(.5);`);
  assert.equal(t.run('!gesture && history.length === 0 && JSON.stringify(map) === originalMap'), true);
  t.run(`const zoomBeforeEditing = view.s; editing = { id: 'root' }; zoomSample(.4); zoomSample(.3);`);
  assert.equal(t.run('view.s === zoomBeforeEditing && hand.state === "blocked"'), true);
});

test('camera fist and pause toggle cancel previews, retain map and show resumable status', () => {
  const t = setup({ handUI: true }); prepareHand(t);
  t.run(`
    const poseSample = pose => { cameraSession.io.frame({ pointer: { x: .1, y: .5 }, wrist: { x: .5, y: .7 }, ratio: .1, pose }, handTime); handTime += 50; };
    stableHand(.5, .5, .1); handSample(.3, .5, .1);
    poseSample('fist');
  `);
  assert.equal(t.run('!gesture && !hand.grab && history.length === 0 && JSON.stringify(map) === originalMap'), true);
  assert.match(t.elements.get('#handHelp').textContent, /片手のグーは待機/);
  t.run(`for (let i = 0; i < 20; i++) {
    cameraSession.io.frame({ pointer: { x: .1 + i * .02, y: .5 }, wrist: { x: .5, y: .7 }, ratio: .1, pose: 'point' }, handTime);
    handTime += 50;
  }`);
  assert.equal(t.run('hand.state === "neutral" && !handController.paused && !gesture && sel === "root" && history.length === 0 && JSON.stringify(map) === originalMap'), true);
  assert.match(t.elements.get('#handHelp').textContent, /動かしている間も待機/);
  t.run(`for (let i = 0; i < 42; i++) poseSample('point');`);
  assert.match(t.elements.get('#handHelp').textContent, /一時停止中/);
  t.run(`stableHand(.1); stableHand(.1, .5, .1);`);
  assert.equal(t.run('hand.state === "paused" && !gesture && !!cameraSession && JSON.stringify(map) === originalMap'), true);
  t.run(`for (let i = 0; i < 42; i++) poseSample('point'); stableHand(.1);`);
  assert.equal(t.run('hand.state === "ready" && sel === "root" && history.length === 0'), true);
});

test('single deletion promotes direct children in place, preserves descendants and sibling order, and undoes atomically', () => {
  const t = setup({ renderUI: true });
  t.run(`render(); let d, secondChild; commit(() => { d = addNode('a1', '孫', { x: 600, y: -200 }); secondChild = addNode('a', '二つ目', { x: 500, y: 20 }); });
    const beforeDelete = JSON.stringify(map), beforeHistory = history.length;
    removeNode('a');`);
  assert.equal(t.run(`deletion.id === 'a' && deletion.scope === null && JSON.stringify(map) === beforeDelete && $('#deleteConfirm').disabled`), true);
  assert.equal(t.run(`document.activeElement === $('#deleteCancel')`), true);
  t.run(`confirmDelete();`); assert.equal(t.run(`JSON.stringify(map) === beforeDelete`), true);
  t.run(`chooseDeleteScope('single');`);
  assert.equal(t.run(`edgeEls.get('a1').attributes.d === curve(map.nodes.root, map.nodes.a1) && map.nodes.a1.parent === 'a' && history.length === beforeHistory`), true);
  t.run(`confirmDelete();`);
  assert.equal(t.run(`!deletion && !map.nodes.a && map.nodes.a1.parent === 'root' && map.nodes[d].parent === 'a1' && sel === 'root' && valid(map) && history.length === beforeHistory + 1`), true);
  assert.equal(t.run(`kids('root').map(n => n.id).join(',') === ['a1', secondChild, 'b', 'c'].join(',') && map.nodes[secondChild].parent === 'root'`), true);
  assert.equal(t.run(`map.nodes.a1.x === 540 && map.nodes.a1.y === -220 && map.nodes[d].x === 600`), true);
  t.run('undo();'); assert.equal(t.run('JSON.stringify(map) === beforeDelete'), true);
  t.run('redo();'); assert.equal(t.run(`!map.nodes.a && map.nodes[d].parent === 'a1' && valid(map)`), true);
});

test('branch deletion removes all descendants only after confirmation; cancellation leaves history and saves untouched', () => {
  const t = setup();
  t.run(`const before = JSON.stringify(map); removeNode('a'); chooseDeleteScope('branch'); closeDelete();`);
  assert.equal(t.run(`JSON.stringify(map) === before && history.length === 0 && !deletion`), true);
  assert.equal(t.timers.size, 0);
  t.run(`removeNode('a'); chooseDeleteScope('branch'); confirmDelete();`);
  assert.equal(t.run(`!map.nodes.a && !map.nodes.a1 && !!map.nodes.b && history.length === 1 && sel === 'root'`), true);
  t.run('undo();'); assert.equal(t.run('JSON.stringify(map) === before'), true);
});

test('leaf deletion, root protection, stale confirmation and fixed target', () => {
  const t = setup();
  t.run(`removeNode('root');`); assert.equal(t.run('deletion'), null);
  t.run(`removeNode('a1'); sel = 'b'; confirmDelete();`);
  assert.equal(t.run(`!map.nodes.a1 && !!map.nodes.b && sel === 'a'`), true);
  t.run(`undo(); removeNode('a'); chooseDeleteScope('branch'); map.nodes.a.text = '変更後'; confirmDelete();`);
  assert.equal(t.run(`!!map.nodes.a && deletion.scope === null && $('#deleteTitle').textContent.includes('変更後')`), true);
  // A queued native close event from the old dialog must not dismiss the refreshed one.
  t.elements.get('#deleteDialog').handlers.close();
  assert.equal(t.run(`!!deletion && $('#deleteDialog').open`), true);
  assert.throws(() => t.run('importMap(sample());'), /操作を終えて/);
  t.run(`closeDelete();`);
});

test('delete key opens the shared dialog; Escape cancels without deleting', () => {
  const t = setup(); t.run(`sel = 'a';`);
  const target = t.elements.get('#viewport');
  t.windowHandlers.get('keydown')({ key: 'Delete', target, preventDefault() {} });
  assert.equal(t.run(`deletion.id === 'a' && !!map.nodes.a`), true);
  t.windowHandlers.get('keydown')({ key: 'Escape', target, preventDefault() {} });
  assert.equal(t.run('!deletion && !!map.nodes.a && history.length === 0'), true);
});

test('peace adds and edits one child per hold; empty edit cancels and committed text is undoable', () => {
  const t = setup({ renderUI: true, handUI: true }); prepareHand(t);
  t.run(`
    const commandSample = pose => { cameraSession.io.frame({ pointer: { x: .5, y: .5 }, wrist: { x: .5, y: .7 }, ratio: .8, pose }, handTime); handTime += 50; };
    for (let i = 0; i < 14; i++) commandSample('peace');
    const newId = editing.id;
  `);
  assert.equal(t.run(`editing.isNew && map.nodes[newId].parent === 'root' && Object.keys(map.nodes).length === 8`), true);
  t.run(`for (let i = 0; i < 20; i++) commandSample('peace'); els.get(newId).firstChild.textContent = '新しい考え'; finishEdit();
    for (let i = 0; i < 14; i++) commandSample('peace');`);
  assert.equal(t.run(`!editing && history.length === 1 && map.nodes[newId].text === '新しい考え'`), true);
  t.run(`undo();`); assert.equal(t.run('JSON.stringify(map) === originalMap'), true);
  t.run(`stableHand(); for (let i = 0; i < 14; i++) commandSample('peace'); cancelEdit();`);
  assert.equal(t.run('JSON.stringify(map) === originalMap && !editing && history.length === 0'), true);
});

test('thumb-down opens confirmation once, permits hand choice and fresh pinch confirmation, and suppresses map gestures', () => {
  const t = setup({ renderUI: true, handUI: true }); prepareHand(t);
  t.run(`sel = 'a';
    const dialogSample = (pose = null, ratio = .8, y = .5) => { cameraSession.io.frame({ pointer: { x: .5, y }, wrist: { x: .5, y: .7 }, ratio, pose }, handTime); handTime += 50; };
    for (let i = 0; i < 14; i++) dialogSample('thumbDown');
  `);
  assert.equal(t.run(`deletion.id === 'a' && JSON.stringify(map) === originalMap && document.activeElement === $('#deleteCancel')`), true);
  t.run(`for (let i = 0; i < 20; i++) dialogSample('thumbDown');
    for (let i = 0; i < 3; i++) dialogSample(); dialogSample(null, .8, .4);
    for (let i = 0; i < 14; i++) dialogSample(null, .1, .4);`);
  assert.equal(t.run(`deletion.scope === 'branch' && !!map.nodes.a && !gesture`), true);
  t.run(`for (let i = 0; i < 3; i++) dialogSample(); dialogSample(null, .8, .6);
    for (let i = 0; i < 6; i++) dialogSample(null, .8, .6); dialogSample(null, .8, .7);
    for (let i = 0; i < 14; i++) dialogSample(null, .1, .7);`);
  assert.equal(t.run(`!deletion && !map.nodes.a && !map.nodes.a1 && history.length === 1`), true);
});

test('Enter edits the selection, Shift+Enter adds a sibling', () => {
  const t = setup({ renderUI: true }); t.run(`sel = 'a';`);
  const press = (key, opts = {}) => t.windowHandlers.get('keydown')({ key, target: t.elements.get('#viewport'), preventDefault() {}, ...opts });
  press('Enter');
  assert.equal(t.run(`editing.id === 'a' && !editing.isNew`), true);
  t.run(`cancelEdit();`);
  press('Enter', { shiftKey: true });
  assert.equal(t.run(`editing.isNew && map.nodes[editing.id].parent === map.nodes.a.parent`), true);
});

test('view and screen shortcuts zoom, focus the prompt and open the key list', () => {
  const t = setup(); t.run(`sel = 'a'; view = { x: 0, y: 0, s: 1 }; document.body = $('body');`);
  const press = (key, opts = {}) => t.windowHandlers.get('keydown')({ key, target: t.elements.get('#viewport'), preventDefault() {}, ...opts });
  press('=', { metaKey: true });
  assert.equal(t.run('view.s'), 1.25);
  press('-', { ctrlKey: true }); press('-', { ctrlKey: true });
  assert.equal(t.run('view.s'), 0.8);
  press('0', { metaKey: true });
  assert.equal(t.run('view.s'), 1);
  press('@', { code: 'Digit2', shiftKey: true });
  assert.equal(t.run('view.s'), 1.5);
  press('k', { metaKey: true });
  assert.equal(t.context.document.activeElement, t.elements.get('#promptInput'));
  press('?', { shiftKey: true });
  assert.equal(t.elements.get('#keysDialog').open, true);
});

test('Shift+H toggles hand input; plain h and typing in the prompt field do not', () => {
  const t = setup({ handUI: true });
  const press = (target, opts = { key: 'H', code: 'KeyH', shiftKey: true }) => t.windowHandlers.get('keydown')({ target, preventDefault() {}, ...opts });
  press(t.elements.get('#viewport'), { key: 'h', code: 'KeyH' });
  assert.equal(t.run('cameraSession'), null);
  press(t.elements.get('#viewport'));
  assert.equal(t.run('!!cameraSession'), true);
  press(t.elements.get('#viewport'));
  assert.equal(t.run('cameraSession'), null);
  press({ closest: sel => sel === 'input, textarea' });
  assert.equal(t.run('cameraSession'), null);
});

test('two fists pan the viewport, revert node previews and keep scale, nodes and history intact', () => {
  const t = setup({ handUI: true }); prepareHand(t);
  t.run(`stableHand(.5, .5, .1); handSample(.4, .5, .1);
    const panSample = (x, y, pose = 'bothFists') => {
      cameraSession.io.frame({ hands: 2, pose, pointer: { x, y }, distance: .4 }, handTime); handTime += 50;
    };
    const beforePan = { ...view };
    panSample(.5, .5); panSample(.5, .5); panSample(.5, .5);
    panSample(.45, .45);
  `);
  assert.equal(t.run('view.x > beforePan.x && view.y < beforePan.y && view.s === beforePan.s'), true);
  assert.equal(t.run('!gesture && JSON.stringify(map) === originalMap && history.length === 0'), true);
  assert.match(t.elements.get('#handHelp').textContent, /両手グーでマップを移動中/);
  assert.equal(t.elements.get('#camMsg').hidden, true);
  t.run(`const stoppedPan = { ...view }; panSample(.2, .2, 'fist');`);
  assert.equal(t.run('JSON.stringify(view) === JSON.stringify(stoppedPan)'), true);
  t.run(`editing = { id: 'root' }; panSample(.3, .3); panSample(.4, .4);`);
  assert.equal(t.run('hand.state === "blocked" && JSON.stringify(view) === JSON.stringify(stoppedPan)'), true);
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
test('question UI accepts multiple replies and applies the final proposal as one history entry', async()=>{
  const t=setup(); const pending=mockQuestions(t);
  t.run(`conversationState('awaiting_input', {questionId:'q1', message:'対象は？'});`);
  assert.equal(t.run(`instruction.state === 'awaiting_input' && !$('#promptSend').disabled && $('#promptInput').value === '' && history.length === 0`),true);
  assert.equal(t.elements.get('#promptQuestion').textContent,'対象は？');
  t.run(`$('#promptInput').value = '図書館'; draftVersion++;`); await t.run('sendInstruction()');
  assert.equal(t.run(`instruction.state === 'thinking' && $('#promptSend').disabled`),true);
  t.run(`conversationState('awaiting_input', {questionId:'q2', message:'名前は？'}); $('#promptInput').value = '新しい本'; draftVersion++;`);
  await t.run('sendInstruction()');
  t.run(`resolveConversation({status:'ok',message:'',operations:[{type:'update_node',nodeId:'b',text:'新しい本'}]});`); await pending;
  assert.equal(t.run(`instruction === null && map.nodes.b.text === '新しい本' && history.length === 1 && $('#promptInput').value === '' && $('#promptQuestion').hidden`),true);
  t.run('undo()'); assert.equal(t.run('map.nodes.b.text'),'図書館に行く');
});
test('question UI preserves an edited draft and ends continuation when the map changes',async()=>{
  const t=setup(); const pending=mockQuestions(t);
  t.run(`$('#promptInput').value = '下書き'; draftVersion++; conversationState('awaiting_input', {questionId:'q1',message:'対象は？'});`);
  assert.equal(t.elements.get('#promptInput').value,'下書き');
  t.run(`commit(() => { map.nodes.a.text = '変更'; });`);
  assert.equal(t.run(`instruction === null && cancelledConversation === 1 && $('#promptQuestion').hidden`),true);
  t.run(`resolveConversation({status:'ok',message:'',operations:[{type:'update_node',nodeId:'b',text:'不正な遅延結果'}]});`); await pending;
  assert.equal(t.run('map.nodes.b.text'),'図書館に行く');
});
test('answer POST failures keep the question and typed answer available',async()=>{
  const t=setup(); const pending=mockQuestions(t);
  t.run(`conversationState('awaiting_input', {questionId:'q1',message:'対象は？'}); instructionClient.answer = async () => { throw new Error('通信失敗'); }; $('#promptInput').value = '図書館'; draftVersion++;`);
  await t.run('sendInstruction()');
  assert.equal(t.run(`instruction.state === 'awaiting_input' && !$('#promptSend').disabled && !$('#promptQuestion').hidden && $('#promptInput').value === '図書館'`),true);
  t.run(`cancelInstruction(); resolveConversation({status:'no_change',message:'',operations:[]});`); await pending;
});
