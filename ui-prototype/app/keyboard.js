nodesEl.addEventListener('keydown', e => {
  if (!state.editing || !e.target.isContentEditable) return;
  e.stopPropagation();
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    finishEdit();
    viewportEl.focus();
  } else if (e.key === 'Tab') {
    if (!e.shiftKey) {
      e.preventDefault();
      $(speech.supported ? '#nodeSpeechToggle' : '#nodeSpeechDone').focus();
    }
  } else if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
    viewportEl.focus();
  }
});
nodesEl.addEventListener('focusout', e => {
  if (
    state.editing &&
    !state.editing.handInput &&
    e.target === nodeEls.get(state.editing.id)?.nodeText &&
    !$('#nodeSpeech').contains(e.relatedTarget) &&
    (!speech.active || e.relatedTarget)
  )
    finishEdit();
});
addEventListener('keydown', e => {
  if (state.editing && e.key === 'Escape' && !e.isComposing) {
    e.preventDefault();
    cancelEdit();
    viewportEl.focus();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'p' && !e.isComposing) {
    e.preventDefault();
    void printMap();
    return;
  }
  if (state.deletion) {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeDelete();
    }
    return;
  }
  const mod = e.metaKey || e.ctrlKey,
    k = e.key;
  if (instructionsEnabled && mod && k.toLowerCase() === 'k' && !e.isComposing) {
    e.preventDefault();
    if (state.editing) finishEdit();
    setPromptHidden(false);
    $('#promptInput').focus();
    return;
  }
  if (state.editing || e.isComposing || e.target.closest?.('input, textarea')) return;
  if (mod && (k === '=' || k === '+')) {
    e.preventDefault();
    zoomAt(viewportWidth() / 2, innerHeight / 2, state.view.s * 1.25);
    return;
  }
  if (mod && k === '-') {
    e.preventDefault();
    zoomAt(viewportWidth() / 2, innerHeight / 2, state.view.s / 1.25);
    return;
  }
  if (mod && k === '0') {
    e.preventDefault();
    zoomAt(viewportWidth() / 2, innerHeight / 2, 1);
    return;
  }
  if (mod && k.toLowerCase() === 'z') {
    e.preventDefault();
    e.shiftKey ? redo() : undo();
    return;
  }
  if (mod && k.toLowerCase() === 'y') {
    e.preventDefault();
    redo();
    return;
  }
  if (k === 'Escape') {
    if (state.gesture?.hand) {
      interruptHand();
      return;
    }
    if (state.mode) endReparent();
    else if (!$('#fileMenu').hidden) toggleFileMenu(false);
    else if (!$('#mapsMenu').hidden) toggleMapsMenu(false);
    else if (document.activeElement === viewportEl) $('#addChild').focus();
    else viewportEl.focus();
    return;
  }
  if (e.target !== viewportEl && e.target !== document.body) return;
  interruptHand();
  if (state.mode) {
    if (k === 'Enter' && state.mode.candidate) {
      e.preventDefault();
      confirmReparent();
    } else if (k.startsWith('Arrow')) {
      e.preventDefault();
      const from = state.selectedId;
      state.selectedId = state.mode.candidate || state.mode.id;
      navigate(k, Object.values(state.map.nodes));
      setCandidate(state.selectedId);
      state.selectedId = from;
    }
    return;
  }
  if (k === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    addChildAndEdit(state.selectedId || state.map.root);
  } else if (k === 'Enter') {
    e.preventDefault();
    addSiblingAndEdit();
  } else if (k === ' ' && state.selectedId) {
    e.preventDefault();
    startEdit(state.selectedId, false, e.shiftKey);
  } else if (k === 'F2' && state.selectedId) {
    e.preventDefault();
    startEdit(state.selectedId, false, true);
  } else if ((k === 'Delete' || k === 'Backspace') && state.selectedId && state.selectedId !== state.map.root) {
    e.preventDefault();
    removeNode(state.selectedId);
  } else if (k.startsWith('Arrow')) {
    e.preventDefault();
    const selected = state.map.nodes[state.selectedId];
    if (e.altKey) nudge(k);
    else if (e.shiftKey && k === 'ArrowLeft' && selected?.parent != null && branchKey(selected.id) === 'ArrowRight') {
      select(selected.parent);
      ensureVisible(state.map.nodes[selected.parent]);
    } else navigate(k);
  } else if (e.code === 'Digit1' && e.shiftKey) {
    e.preventDefault();
    fitAll();
  } else if (e.code === 'Digit2' && e.shiftKey) {
    e.preventDefault();
    animateTo(centerOn(state.map.nodes[state.selectedId || state.map.root], 1.5));
  } else if (k === '?') {
    e.preventDefault();
    $('#keysDialog').showModal();
  } else if (e.code === 'KeyH' && e.shiftKey && !mod) {
    e.preventDefault();
    toggleHand();
  }
});
