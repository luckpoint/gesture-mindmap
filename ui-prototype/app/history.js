const HISTORY_LIMIT = 1000;
let lastSeq = 0,
  unsaved = new Map(),
  dropped = new Set();
const cursor = () => state.history.at(-1)?.seq ?? 0;
function forget(entries) {
  for (const e of entries) {
    unsaved.delete(e.seq);
    dropped.add(e.seq);
  }
}
function record(before) {
  const entry = {
    seq: ++lastSeq,
    prev: cursor(),
    at: Date.now(),
    ...MapHistory.diff(JSON.parse(before), state.map),
  };
  forget(state.future);
  state.future = [];
  state.history.push(entry);
  unsaved.set(entry.seq, entry);
  if (state.history.length > HISTORY_LIMIT) forget(state.history.splice(0, state.history.length - HISTORY_LIMIT));
}
function restoreMap(before) {
  state.map = JSON.parse(before);
  invalidateTree();
  if (!Object.hasOwn(state.map.nodes, state.selectedId)) state.selectedId = state.map.root;
  $('#title').value = state.map.title;
}
// A preview is validated but does not enter history or trigger persistence.
// Its final commit supplies the snapshot from before the preview began.
function commit(fn, { before, preview = false } = {}) {
  if (refuseReadOnly()) {
    if (before !== undefined) {
      restoreMap(before);
      render();
    }
    return false;
  }
  interruptHand();
  if (state.editing && before === undefined && !preview) finishEdit();
  before ??= JSON.stringify(state.map);
  try {
    fn();
    const error = NodeImageFormat.mapError(state.map);
    if (error) throw new Error(error);
  } catch (error) {
    restoreMap(before);
    toast(error.message);
    render();
    return false;
  }
  if (!preview && JSON.stringify(state.map) !== before) {
    record(before);
    changed();
  } else render();
  return true;
}
function changed() {
  state.revision++;
  state.historyToken++;
  endStaleInstruction();
  render();
  scheduleSave();
  updateAccess();
}
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
function restore(from, to) {
  if (state.deletion) {
    closeDelete();
    return;
  }
  if (refuseReadOnly()) return;
  if (state.gesture?.hand) {
    interruptHand();
    return;
  }
  const isUndo = from === state.history;
  if (state.editing) finishEdit();
  from = isUndo ? state.history : state.future;
  to = isUndo ? state.future : state.history;
  if (!from.length) return;
  const entry = from.pop();
  state.map = MapHistory.apply(state.map, entry, from === state.history ? 'before' : 'after');
  to.push(entry);
  if (!state.map.nodes[state.selectedId]) state.selectedId = null;
  $('#title').value = state.map.title;
  changed();
}
const undo = () => restore(state.history, state.future),
  redo = () => restore(state.future, state.history);
// Persistence consumes pending diffs without owning the undo/redo stacks.
function takeHistoryChanges() {
  const changes = { cursor: cursor(), put: [...unsaved.values()], drop: [...dropped] };
  unsaved = new Map();
  dropped = new Set();
  return changes;
}
function retryHistoryChanges(changes) {
  for (const e of changes.put) if (!dropped.has(e.seq)) unsaved.set(e.seq, e);
  for (const seq of changes.drop) dropped.add(seq);
}
