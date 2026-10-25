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
function commit(fn) {
  if (refuseReadOnly()) return false;
  interruptHand();
  const before = JSON.stringify(state.map);
  try {
    fn();
    const error = NodeImageFormat.mapError(state.map);
    if (error) throw new Error(error);
  } catch (error) {
    state.map = JSON.parse(before);
    invalidateTree();
    if (!Object.hasOwn(state.map.nodes, state.selectedId)) state.selectedId = state.map.root;
    $('#title').value = state.map.title;
    toast(error.message);
    render();
    return false;
  }
  record(before);
  changed();
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
  if (!from.length) return;
  if (state.editing) finishEdit();
  const entry = from.pop();
  state.map = MapHistory.apply(state.map, entry, from === state.history ? 'before' : 'after');
  to.push(entry);
  if (!state.map.nodes[state.selectedId]) state.selectedId = null;
  $('#title').value = state.map.title;
  changed();
}
const undo = () => restore(state.history, state.future),
  redo = () => restore(state.future, state.history);
function scheduleSave() {
  saveDirty = true;
  setSave('saving');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    flushSave().catch(() => {});
  }, 500);
}
async function flushSave() {
  clearTimeout(saveTimer);
  saveTimer = null;
  while (saveWrite) await saveWrite.catch(() => {});
  if (!saveDirty) return;
  saveDirty = false;
  // A drag in progress is not a committed state; store the map from before it.
  const id = state.mapId,
    snapshot = JSON.parse(state.gesture?.pre ?? JSON.stringify(state.map));
  const changes = { cursor: cursor(), put: [...unsaved.values()], drop: [...dropped] };
  unsaved = new Map();
  dropped = new Set();
  saveWrite = (async () => {
    if (!state.library) throw new Error(tr('save.unsupported'));
    if (forceSaveFail) throw new Error(tr('save.error'));
    await state.library.save(id, snapshot, changes);
  })();
  try {
    await saveWrite;
    if (!saveDirty) setSave('saved');
  } catch (error) {
    if (state.mapId === id) {
      for (const e of changes.put) if (!dropped.has(e.seq)) unsaved.set(e.seq, e);
      for (const seq of changes.drop) dropped.add(seq);
    }
    saveDirty = true;
    setSave('error');
    throw error;
  } finally {
    saveWrite = null;
  }
}
function setSave(status) {
  if (status === 'saved' && readOnly()) status = 'readonly';
  $('#save').dataset.state = status;
  $('#saveText').textContent = tr('save.' + status);
  $('#saveExport').hidden = status !== 'error';
  resizeNotices();
}
