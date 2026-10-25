// Application dependencies are supplied per instance; evaluation has no screen effects.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindmapAppAccess = api;
})(globalThis, () => {
  'use strict';
  function create(context, operations) {
    const { state, services, ui } = context;
    function endStaleInstruction() {
      if (ui.instructionUndoButton) ui.instructionUndoButton.disabled = true;
      if (state.instruction?.state === 'awaiting_confirmation')
        operations.endInstruction('conflict', services.tr('instruction.conflictApply'));
      if (state.instruction?.state === 'awaiting_input' || state.instruction?.state === 'answering') {
        operations.endInstruction('conflict', services.tr('instruction.conflictQuestion'));
        services.instructionClient.cancel();
      }
    }
    function updateAccess() {
      ui.palette?.sync();
      operations.$('#title').readOnly = operations.readOnly();
      operations.$('#undo').disabled = operations.readOnly() || !state.history.length;
      operations.$('#redo').disabled = operations.readOnly() || !state.future.length;
    }
    return { endStaleInstruction, updateAccess };
  }
  return { create };
});
