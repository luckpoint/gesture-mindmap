// Collect interaction facts separately from the rules for each operation.
function operationState() {
  return {
    editing: !!state.editing,
    gesturing: !!state.gesture,
    reparenting: !!state.mode,
    deleting: !!state.deletion,
    handGrabbing: !!state.hand?.grab,
    readOnly: readOnly(),
    switching: state.switching,
    instructionRunning: !!state.instruction,
    instructionConfirmation: state.instruction?.state === 'awaiting_confirmation',
    instructionDialog: !!$('#instructionDialog').open,
  };
}
function busyOperation(s = operationState()) {
  return s.editing || s.gesturing || s.reparenting || s.deleting || s.handGrabbing;
}
function mapRevisionConflict({ session, revision }) {
  return session !== state.mapSessionId || revision !== state.revision;
}
const OperationPolicy = {
  // Switching may cancel an AI run, but must not discard a manual operation.
  canLeaveMap: s => !busyOperation(s),
  // Sending finishes editing and cancels gestures/reparenting in the caller.
  canStartInstruction: s => !s.readOnly && !s.instructionRunning && !s.deleting && !s.instructionDialog,
  canApplyInstruction: s => !busyOperation(s),
  // AI thinking is compatible with images; its deletion confirmation is not.
  canAttachImage: s => !s.readOnly && !busyOperation(s) && !s.instructionConfirmation,
  // Removal is a normal commit, which invalidates an AI deletion confirmation.
  canRemoveImage: s => !busyOperation(s),
  // The palette additionally blocks selection while a map switch is pending.
  paletteBlock: s =>
    s.readOnly || s.switching ? 'save.readonly' : !OperationPolicy.canAttachImage(s) ? 'palette.busy' : '',
};
