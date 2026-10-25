const speech = new SpeechInput.Controller({ change: updateSpeech });
let speechMessage = '';
function updateSpeech() {
  const active = speech.active,
    fromHand = !!state.editing?.handInput;
  $('#nodeSpeech').hidden = !state.editing;
  $('#nodeSpeechToggle').hidden = fromHand && active;
  $('#nodeSpeechToggle').disabled = !speech.supported || speech.state === 'stopping';
  $('#nodeSpeechToggle').textContent = tr(active ? 'speech.stop' : 'speech.start');
  $('#nodeSpeechDone').disabled = (active && !fromHand) || !!state.editing?.pendingDone;
  $('#nodeSpeechDone').textContent = tr(fromHand ? 'speech.handDone' : 'speech.done');
  $('#nodeSpeechCancel').textContent = tr(fromHand ? 'speech.handCancel' : 'common.cancel');
  $('#speechNote').textContent = tr(fromHand ? 'speech.handNote' : 'speech.note');
  $('#speechStatus').textContent = !speech.supported
    ? tr('speech.unsupported')
    : active
      ? tr('speech.' + speech.state)
      : speechMessage;
  if (!active) $('#speechInterim').textContent = '';
  const t = state.editing && nodeEls.get(state.editing.id)?.nodeText;
  if (t) t.contentEditable = active ? 'false' : 'plaintext-only';
}
function startNodeSpeech() {
  if (!state.editing || readOnly()) return;
  const edit = state.editing,
    session = state.mapSessionId,
    t = nodeEls.get(edit.id).nodeText;
  edit.pendingDone = false;
  speechMessage = '';
  speech.start({
    valid: () => state.editing === edit && session === state.mapSessionId && !readOnly() && !!state.map.nodes[edit.id],
    read: () => t.textContent,
    write: (text, interim) => {
      t.textContent = text;
      $('#speechInterim').textContent = interim;
    },
    end: error => {
      const confirm = edit.pendingDone;
      edit.pendingDone = false;
      speechMessage = error
        ? tr(
            'speech.error.' +
              ([
                'not-allowed',
                'service-not-allowed',
                'audio-capture',
                'network',
                'language-not-supported',
                'no-speech',
                'timeout',
              ].includes(error)
                ? error
                : 'unknown'),
          )
        : tr('speech.ready');
      updateSpeech();
      if (!error && confirm && t.textContent.trim()) {
        finishEdit();
        viewportEl.focus();
      }
    },
  });
}
function confirmNodeSpeech() {
  if (!state.editing || state.editing.pendingDone) return;
  if (speech.active) {
    if (!state.editing.handInput) return;
    state.editing.pendingDone = true;
    speech.stop();
    updateSpeech();
  } else {
    finishEdit();
    viewportEl.focus();
  }
}
$('#nodeSpeechToggle').onclick = () => (speech.active ? speech.stop() : startNodeSpeech());
$('#nodeSpeechDone').onclick = confirmNodeSpeech;
$('#nodeSpeechCancel').onclick = () => {
  cancelEdit();
  viewportEl.focus();
};
for (const id of ['#nodeSpeechToggle', '#nodeSpeechDone', '#nodeSpeechCancel']) {
  $(id).addEventListener('pointerdown', e => {
    if (e.button !== 0 || e.isPrimary === false || e.currentTarget.disabled) return;
    // Safari does not focus buttons on tap/click. Move focus before its default
    // blur can end the edit, and keep recognition in the subsequent user click.
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
  });
}
$('#nodeSpeech').addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    e.preventDefault();
    cancelEdit();
    viewportEl.focus();
  }
});
$('#nodeSpeech').addEventListener('focusout', e => {
  if (
    state.editing &&
    !state.editing.handInput &&
    e.relatedTarget &&
    !$('#nodeSpeech').contains(e.relatedTarget) &&
    e.relatedTarget !== nodeEls.get(state.editing.id)?.nodeText
  )
    finishEdit();
});
updateSpeech();
