import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { create } from '../../ui-prototype/app/browser.js';
const __dirname = fileURLToPath(new URL('.', import.meta.url));

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
  hostname = '127.0.0.1',
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
    location: { hostname },
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
  // Construct through the production composition; storage startup remains explicit.
  vm.runInContext(readFileSync(join(__dirname, '../../ui-prototype/speech/controller.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../../ui-prototype/i18n.js'), 'utf8'), context);
  for (const file of ['recognition.js', 'controller.js', 'debug.js'])
    vm.runInContext(readFileSync(join(__dirname, '../../ui-prototype/gestures', file), 'utf8'), context);
  for (const file of ['privacy.js', 'format.js', 'store.js', 'upload.js'])
    vm.runInContext(readFileSync(join(__dirname, '../../ui-prototype/images', file), 'utf8'), context);
  for (const file of ['operations.js', 'client.js'])
    vm.runInContext(readFileSync(join(__dirname, '../../ui-prototype/instructions', file), 'utf8'), context);
  for (const file of ['library.js', 'locks.js', 'history.js'])
    vm.runInContext(readFileSync(join(__dirname, '../../ui-prototype/storage', file), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../../ui-prototype/print.js'), 'utf8'), context);
  if (paletteUI)
    for (const file of ['catalog.js', 'palette.js'])
      vm.runInContext(readFileSync(join(__dirname, '../../ui-prototype/icons', file), 'utf8'), context);
  const app = create(context);
  // Compatibility names exist only in the test adapter. Production modules
  // receive their context and connected operation API directly.
  const expose = (object, name, target = name) =>
    Object.defineProperty(context, name, {
      configurable: true,
      get: () => object[target],
      set: value => {
        object[target] = value;
      },
    });
  for (const name of Object.keys(app.operations)) expose(app.operations, name);
  for (const name of Object.keys(app.context.ui)) expose(app.context.ui, name);
  for (const name of ['state']) expose(app.context, name);
  for (const name of ['viewportEl', 'world', 'edgesEl', 'nodesEl', 'nodeEls']) expose(app.context.elements, name);
  for (const name of ['instructionClient', 'imageStore', 'instructionsEnabled', 'tr'])
    expose(app.context.services, name);
  context.appContext = app.context;
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
    app,
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

export { setup, memoryLibrary };
