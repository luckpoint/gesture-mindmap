// Application dependencies are supplied per instance; evaluation has no screen effects.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindmapAppOperationPolicy = api;
})(globalThis, () => {
  'use strict';
  function create(context, operations) {
    const { state, services } = context;
    function operationState() {
      return {
        editing: !!state.editing,
        gesturing: !!state.gesture,
        reparenting: !!state.mode,
        deleting: !!state.deletion,
        handGrabbing: !!state.hand?.grab,
        readOnly: operations.readOnly(),
        switching: state.switching,
        instructionRunning: !!state.instruction,
        instructionConfirmation: state.instruction?.state === 'awaiting_confirmation',
        instructionDialog: !!operations.$('#instructionDialog').open,
      };
    }
    const OperationPolicy = services.MapOperationPolicy;
    function mapRevisionConflict(expected) {
      return OperationPolicy.mapRevisionConflict({ session: state.mapSessionId, revision: state.revision }, expected);
    }
    return { operationState, OperationPolicy, mapRevisionConflict };
  }
  return { create };
});
