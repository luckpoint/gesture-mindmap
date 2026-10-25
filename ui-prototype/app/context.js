// Factories have no application or DOM dependencies until create() is called.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindmapAppContext = api;
})(globalThis, () => {
  'use strict';
  function create({ map, sessionId, elements, services, timers, effects, environment }) {
    const state = {
      map,
      view: { x: 0, y: 0, s: 1 },
      selectedId: map.root,
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
      mapSessionId: sessionId,
      instruction: null,
      draftVersion: 0,
    };
    return {
      state,
      environment,
      ui: {},
      elements,
      services,
      timers: { ...timers, toast: null, hint: null, view: null, instruction: null },
      effects,
      controls: { forceSaveFail: false },
    };
  }
  return { create };
});
