// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services, environment } = context;

  function initialize() {
    elements.nodesEl.addEventListener('keydown', e => {
      if (!state.editing || !e.target.isContentEditable) return;
      e.stopPropagation();
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        operations.finishEdit();
        elements.viewportEl.focus();
      } else if (e.key === 'Tab') {
        if (!e.shiftKey) {
          e.preventDefault();
          operations.$(operations.speech.supported ? '#nodeSpeechToggle' : '#nodeSpeechDone').focus();
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        operations.cancelEdit();
        elements.viewportEl.focus();
      }
    });
    elements.nodesEl.addEventListener('focusout', e => {
      if (
        state.editing &&
        !state.editing.handInput &&
        e.target === elements.nodeEls.get(state.editing.id)?.nodeText &&
        !operations.$('#nodeSpeech').contains(e.relatedTarget) &&
        (!operations.speech.active || e.relatedTarget)
      )
        operations.finishEdit();
    });
    environment.addEventListener('keydown', e => {
      if (state.editing && e.key === 'Escape' && !e.isComposing) {
        e.preventDefault();
        operations.cancelEdit();
        elements.viewportEl.focus();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p' && !e.isComposing) {
        e.preventDefault();
        void operations.printMap();
        return;
      }
      if (state.deletion) {
        if (e.key === 'Escape') {
          e.preventDefault();
          operations.closeDelete();
        }
        return;
      }
      const mod = e.metaKey || e.ctrlKey,
        k = e.key;
      if (services.instructionsEnabled && mod && k.toLowerCase() === 'k' && !e.isComposing) {
        e.preventDefault();
        if (state.editing) operations.finishEdit();
        operations.setPromptHidden(false);
        operations.$('#promptInput').focus();
        return;
      }
      if (state.editing || e.isComposing || e.target.closest?.('input, textarea')) return;
      if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        operations.zoomAt(operations.viewportWidth() / 2, environment.innerHeight / 2, state.view.s * 1.25);
        return;
      }
      if (mod && k === '-') {
        e.preventDefault();
        operations.zoomAt(operations.viewportWidth() / 2, environment.innerHeight / 2, state.view.s / 1.25);
        return;
      }
      if (mod && k === '0') {
        e.preventDefault();
        operations.zoomAt(operations.viewportWidth() / 2, environment.innerHeight / 2, 1);
        return;
      }
      if (mod && k.toLowerCase() === 'z') {
        e.preventDefault();
        e.shiftKey ? operations.redo() : operations.undo();
        return;
      }
      if (mod && k.toLowerCase() === 'y') {
        e.preventDefault();
        operations.redo();
        return;
      }
      if (k === 'Escape') {
        if (state.gesture?.hand) {
          operations.interruptHand();
          return;
        }
        if (state.mode) operations.endReparent();
        else if (!operations.$('#fileMenu').hidden) operations.toggleFileMenu(false);
        else if (!operations.$('#mapsMenu').hidden) operations.toggleMapsMenu(false);
        else if (environment.document.activeElement === elements.viewportEl) operations.$('#addChild').focus();
        else elements.viewportEl.focus();
        return;
      }
      if (e.target !== elements.viewportEl && e.target !== environment.document.body) return;
      operations.interruptHand();
      if (state.mode) {
        if (k === 'Enter' && state.mode.candidate) {
          e.preventDefault();
          operations.confirmReparent();
        } else if (k.startsWith('Arrow')) {
          e.preventDefault();
          const from = state.selectedId;
          state.selectedId = state.mode.candidate || state.mode.id;
          operations.navigate(k, Object.values(state.map.nodes));
          operations.setCandidate(state.selectedId);
          state.selectedId = from;
        }
        return;
      }
      if (k === 'Tab' && !e.shiftKey) {
        e.preventDefault();
        operations.addChildAndEdit(state.selectedId || state.map.root);
      } else if (k === 'Enter') {
        e.preventDefault();
        operations.addSiblingAndEdit();
      } else if (k === ' ' && state.selectedId) {
        e.preventDefault();
        operations.startEdit(state.selectedId, false, e.shiftKey);
      } else if (k === 'F2' && state.selectedId) {
        e.preventDefault();
        operations.startEdit(state.selectedId, false, true);
      } else if ((k === 'Delete' || k === 'Backspace') && state.selectedId && state.selectedId !== state.map.root) {
        e.preventDefault();
        operations.removeNode(state.selectedId);
      } else if (k.startsWith('Arrow')) {
        e.preventDefault();
        const selected = state.map.nodes[state.selectedId];
        if (e.altKey) operations.nudge(k);
        else if (
          e.shiftKey &&
          k === 'ArrowLeft' &&
          selected?.parent != null &&
          operations.branchKey(selected.id) === 'ArrowRight'
        ) {
          operations.select(selected.parent);
          operations.ensureVisible(state.map.nodes[selected.parent]);
        } else operations.navigate(k);
      } else if (e.code === 'Digit1' && e.shiftKey) {
        e.preventDefault();
        operations.fitAll();
      } else if (e.code === 'Digit2' && e.shiftKey) {
        e.preventDefault();
        operations.animateTo(operations.centerOn(state.map.nodes[state.selectedId || state.map.root], 1.5));
      } else if (k === '?') {
        e.preventDefault();
        operations.$('#keysDialog').showModal();
      } else if (e.code === 'KeyH' && e.shiftKey && !mod) {
        e.preventDefault();
        operations.toggleHand();
      }
    });
  }
  return { initialize };
}
export { create };
