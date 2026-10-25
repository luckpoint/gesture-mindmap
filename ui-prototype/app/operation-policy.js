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
const OperationPolicy = MapOperationPolicy;
function mapRevisionConflict(expected) {
  return OperationPolicy.mapRevisionConflict({ session: state.mapSessionId, revision: state.revision }, expected);
}
