// Connect callbacks after module evaluation; factories never call other screens on load.
Object.assign(appContext.effects, {
  invalidateTree: () => invalidateTree(),
  render: () => render(),
  interruptHand: () => interruptHand(),
  finishEdit: () => finishEdit(),
  endStaleInstruction: () => endStaleInstruction(),
  scheduleSave: () => scheduleSave(),
  updateAccess: () => updateAccess(),
  closeDelete: () => closeDelete(),
  toast: message => toast(message),
  resizeNotices: () => resizeNotices(),
});
const HISTORY_LIMIT = appContext.services.history.HISTORY_LIMIT;
const historyOperations = MindmapAppHistory.create(appContext);
const { editHistory, takeHistoryChanges, retryHistoryChanges, restoreMap, commit, changed, undo, redo } =
  historyOperations;
const { autosave, scheduleSave, flushSave, setSave } = MindmapAppPersistence.create(appContext, historyOperations);
function endStaleInstruction() {
  if (instructionUndoButton) instructionUndoButton.disabled = true;
  if (state.instruction?.state === 'awaiting_confirmation') endInstruction('conflict', tr('instruction.conflictApply'));
  if (state.instruction?.state === 'awaiting_input' || state.instruction?.state === 'answering') {
    endInstruction('conflict', tr('instruction.conflictQuestion'));
    instructionClient.cancel();
  }
}
function updateAccess() {
  palette?.sync();
  $('#title').readOnly = readOnly();
  $('#undo').disabled = readOnly() || !state.history.length;
  $('#redo').disabled = readOnly() || !state.future.length;
}
