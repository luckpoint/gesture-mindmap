// Factories have no application or DOM dependencies until create() is called.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindmapAppPersistence = api;
})(globalThis, () => {
  'use strict';
  function create({ state, elements, services, timers, controls, effects }, history) {
    const autosave = services.autosave.create({
      capture() {
        // Save committed state while a node addition or drag is previewed.
        const snapshot = JSON.parse(state.editing?.before ?? state.gesture?.pre ?? JSON.stringify(state.map));
        return { id: state.mapId, library: state.library, snapshot, changes: history.takeHistoryChanges() };
      },
      async persist({ id, library, snapshot, changes }) {
        if (!library) throw new Error(services.tr('save.unsupported'));
        if (controls.forceSaveFail) throw new Error(services.tr('save.error'));
        await library.save(id, snapshot, changes);
      },
      recover({ changes }) {
        history.retryHistoryChanges(changes);
      },
      status: setSave,
      setTimer: timers.set,
      clearTimer: timers.clear,
    });
    function scheduleSave() {
      autosave.schedule();
    }
    function flushSave() {
      return autosave.flush();
    }
    function setSave(status) {
      if (status === 'saved' && !state.mapClaim.editable) status = 'readonly';
      elements.save.dataset.state = status;
      elements.saveText.textContent = services.tr('save.' + status);
      elements.saveExport.hidden = status !== 'error';
      effects.resizeNotices();
    }

    return { autosave, scheduleSave, flushSave, setSave };
  }
  return { create };
});
