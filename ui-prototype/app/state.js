// Application dependencies are supplied per instance; evaluation has no screen effects.
function initialMap(tr) {
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

function create(context, operations) {
  const { state, elements, services, environment, ui } = context;
  const BOUND = 8000,
    ZMIN = 0.25,
    ZMAX = 2,
    CAMERA_KEY = 'mindmap-proto:camera',
    CAM_VIDEO_KEY = 'mindmap-proto:camera-video',
    PROMPT_KEY = 'mindmap-proto:prompt-hidden',
    LAST_KEY = 'mindmap:last',
    VIEW_KEY = 'mindmap:view:',
    GC_SKEW_KEY = 'mindmap:gc-skew';
  const $ = elements.$;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const compact = environment.matchMedia('(max-width: 560px)');
  const viewportWidth = () => elements.viewportEl.clientWidth || environment.innerWidth;
  const canvasHeight = () => {
    const top = $($('#prompt').hidden ? '.dock' : '#prompt').getBoundingClientRect().top;
    return Math.max(
      80,
      Math.min(
        elements.viewportEl.clientHeight || environment.innerHeight,
        top > 150 ? top : environment.innerHeight - 120,
      ),
    );
  };
  ui.palette = null;
  ui.stopWatch = null;
  ui.instructionUndoButton = null;
  const sample = () => initialMap(services.tr);
  function valid(m) {
    return services.InstructionOperations.valid(m);
  }
  function blankMap() {
    return {
      version: 2,
      title: services.tr('maps.new'),
      root: 'root',
      seq: 0,
      nodes: { root: { id: 'root', text: services.tr('maps.rootText'), parent: null, x: 0, y: 0, order: 0 } },
    };
  }
  function serializeMap() {
    return services.InstructionOperations.serialize(state.map);
  }
  const readOnly = () => !state.mapClaim.editable;
  function refuseReadOnly() {
    if (operations.readOnly()) operations.toast(services.tr('save.readonly'));
    return operations.readOnly();
  }
  return {
    BOUND,
    ZMIN,
    ZMAX,
    CAMERA_KEY,
    CAM_VIDEO_KEY,
    PROMPT_KEY,
    LAST_KEY,
    VIEW_KEY,
    GC_SKEW_KEY,
    $,
    clamp,
    compact,
    viewportWidth,
    canvasHeight,
    sample,
    valid,
    blankMap,
    serializeMap,
    readOnly,
    refuseReadOnly,
  };
}
export { create, initialMap as sample };
