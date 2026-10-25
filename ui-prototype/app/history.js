// Factories have no application or DOM dependencies until create() is called.
function create({ state, elements, services, effects }) {
  function refuseReadOnly() {
    if (state.mapClaim.editable) return false;
    effects.toast(services.tr('save.readonly'));
    return true;
  }
  const editHistory = services.history.create({ stacks: state, diffs: services.diffs });
  const takeHistoryChanges = () => editHistory.takeChanges();
  const retryHistoryChanges = changes => editHistory.retryChanges(changes);
  function restoreMap(before) {
    state.map = JSON.parse(before);
    effects.invalidateTree();
    if (!Object.hasOwn(state.map.nodes, state.selectedId)) state.selectedId = state.map.root;
    elements.title.value = state.map.title;
  }
  // A preview is validated but does not enter history or trigger persistence.
  // Its final commit supplies the snapshot from before the preview began.
  function commit(fn, { before, preview = false } = {}) {
    if (refuseReadOnly()) {
      if (before !== undefined) {
        restoreMap(before);
        effects.render();
      }
      return false;
    }
    effects.interruptHand();
    if (state.editing && before === undefined && !preview) effects.finishEdit();
    before ??= JSON.stringify(state.map);
    try {
      fn();
      const error = services.imageFormat.mapError(state.map);
      if (error) throw new Error(error);
    } catch (error) {
      restoreMap(before);
      effects.toast(error.message);
      effects.render();
      return false;
    }
    if (!preview && JSON.stringify(state.map) !== before) {
      editHistory.record(JSON.parse(before), state.map);
      changed();
    } else effects.render();
    return true;
  }
  function changed() {
    state.revision++;
    state.historyToken++;
    effects.endStaleInstruction();
    effects.render();
    effects.scheduleSave();
    effects.updateAccess();
  }
  function restore(from) {
    if (state.deletion) {
      effects.closeDelete();
      return;
    }
    if (refuseReadOnly()) return;
    if (state.gesture?.hand) {
      effects.interruptHand();
      return;
    }
    const isUndo = from === state.history;
    if (state.editing) effects.finishEdit();
    from = isUndo ? state.history : state.future;
    if (!from.length) return;
    state.map = editHistory.restore(state.map, isUndo ? 'undo' : 'redo');
    if (!state.map.nodes[state.selectedId]) state.selectedId = null;
    elements.title.value = state.map.title;
    changed();
  }
  const undo = () => restore(state.history),
    redo = () => restore(state.future);

  return { editHistory, takeHistoryChanges, retryHistoryChanges, restoreMap, commit, changed, undo, redo };
}
export { create };
