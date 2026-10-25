const BOUND = 8000,
  ZMIN = 0.25,
  ZMAX = 2,
  CAMERA_KEY = 'mindmap-proto:camera',
  CAM_VIDEO_KEY = 'mindmap-proto:camera-video',
  PROMPT_KEY = 'mindmap-proto:prompt-hidden',
  LAST_KEY = 'mindmap:last',
  VIEW_KEY = 'mindmap:view:',
  GC_SKEW_KEY = 'mindmap:gc-skew';
const instructionsEnabled = globalThis.MindmapFeatures?.instructions === true;
const tr = I18n.t;
const $ = s => document.querySelector(s);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const compact = matchMedia('(max-width: 560px)');
const viewportEl = $('#viewport'),
  world = $('#world'),
  edgesEl = $('#edges'),
  nodesEl = $('#nodes');
const nodeEls = new Map();
const viewportWidth = () => viewportEl.clientWidth || innerWidth;
const canvasHeight = () => {
  const top = $($('#prompt').hidden ? '.dock' : '#prompt').getBoundingClientRect().top;
  return Math.max(80, Math.min(viewportEl.clientHeight || innerHeight, top > 150 ? top : innerHeight - 120));
};

const state = {
  map: sample(),
  view: { x: 0, y: 0, s: 1 },
  selectedId: 'root',
  editing: null,
  mode: null,
  hand: null,
  gesture: null,
  deletion: null,
  library: null,
  mapId: null,
  mapClaim: { editable: false, release() {} },
  switching: false,
  history: [],
  future: [],
  revision: 0,
  historyToken: 0,
  mapSessionId: InstructionTransport.id('map_'),
  instruction: null,
  draftVersion: 0,
};
let palette = null,
  stopWatch = null,
  forceSaveFail = false,
  instructionTimer,
  instructionUndoButton = null;
const instructionClient = instructionsEnabled ? new InstructionTransport.Client() : null;
const imageStore = new NodeImageStore.Store();
let toastTimer, hintTimer, viewTimer;

/* ---------- model ---------- */
function sample() {
  const list = [
    ['root', null, 0, 0],
    ['a', 'root', 310, -130],
    ['a1', 'a', 540, -220],
    ['b', 'root', -320, -110],
    ['b1', 'b', -540, -200],
    ['c', 'root', 20, 220],
    ['c1', 'c', 260, 330],
  ];
  const nodes = Object.fromEntries(
    list.map(([id, parent, x, y], order) => [id, { id, text: tr('sample.' + id), parent, x, y, order }]),
  );
  return { version: 2, title: tr('sample.title'), root: 'root', seq: list.length, nodes };
}
function valid(m) {
  return InstructionOperations.valid(m);
}
function blankMap() {
  return {
    version: 2,
    title: tr('maps.new'),
    root: 'root',
    seq: 0,
    nodes: { root: { id: 'root', text: tr('maps.rootText'), parent: null, x: 0, y: 0, order: 0 } },
  };
}
function serializeMap() {
  return InstructionOperations.serialize(state.map);
}
const readOnly = () => !state.mapClaim.editable;
function refuseReadOnly() {
  if (readOnly()) toast(tr('save.readonly'));
  return readOnly();
}
