const autosave = MapAutosave.create({
  capture() {
    // Save committed state while a node addition or drag is previewed.
    const snapshot = JSON.parse(state.editing?.before ?? state.gesture?.pre ?? JSON.stringify(state.map));
    return { id: state.mapId, library: state.library, snapshot, changes: takeHistoryChanges() };
  },
  async persist({ id, library, snapshot, changes }) {
    if (!library) throw new Error(tr('save.unsupported'));
    if (forceSaveFail) throw new Error(tr('save.error'));
    await library.save(id, snapshot, changes);
  },
  recover({ changes }) {
    retryHistoryChanges(changes);
  },
  status: setSave,
});
function scheduleSave() {
  autosave.schedule();
}
function flushSave() {
  return autosave.flush();
}
function setSave(status) {
  if (status === 'saved' && readOnly()) status = 'readonly';
  $('#save').dataset.state = status;
  $('#saveText').textContent = tr('save.' + status);
  $('#saveExport').hidden = status !== 'error';
  resizeNotices();
}
