// Application dependencies are supplied per instance; evaluation has no screen effects.
function create({ environment, services, modules, map, sessionId }) {
  const document = environment.document;
  const query = selector => document.querySelector(selector);
  const context = modules.context.create({
    map: map ?? modules.state.sample(services.tr),
    sessionId: sessionId ?? services.InstructionTransport.id('map_'),
    elements: {
      $: query,
      viewportEl: query('#viewport'),
      world: query('#world'),
      edgesEl: query('#edges'),
      nodesEl: query('#nodes'),
      nodeEls: new Map(),
      title: query('#title'),
      undo: query('#undo'),
      redo: query('#redo'),
      save: query('#save'),
      saveText: query('#saveText'),
      saveExport: query('#saveExport'),
    },
    environment,
    services,
    timers: { set: (fn, ms) => environment.setTimeout(fn, ms), clear: id => environment.clearTimeout(id) },
    effects: {},
  });
  const operations = {};
  // Resolve mutual screen callbacks only after every factory has returned its API.
  for (const name of [
    'invalidateTree',
    'render',
    'interruptHand',
    'finishEdit',
    'endStaleInstruction',
    'scheduleSave',
    'updateAccess',
    'closeDelete',
    'toast',
    'resizeNotices',
  ]) {
    context.effects[name] = (...args) => operations[name](...args);
  }
  const screens = [];
  for (const name of [
    'state',
    'operation-policy',
    'tree',
    'history',
    'persistence',
    'access',
    'maps',
    'viewport',
    'render',
    'node-images',
    'speech',
    'editing',
    'instructions',
    'hand',
    'pointer',
    'keyboard',
    'controls',
    'startup',
  ]) {
    const api =
      name === 'history'
        ? modules.history.create(context)
        : name === 'persistence'
          ? modules.persistence.create(context, operations)
          : modules[name].create(context, operations);
    const { initialize, ...methods } = api;
    Object.assign(operations, methods);
    if (initialize) screens.push(initialize);
  }
  operations.HISTORY_LIMIT = services.history.HISTORY_LIMIT;
  for (const initialize of screens) initialize();
  return { context, operations, start: () => operations.start() };
}
export { create };
