// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services, environment, ui } = context;
  const speech = new services.SpeechInput.Controller({
    change: (...args) => operations.updateSpeech(...args),
    Recognition: environment.SpeechRecognition || environment.webkitSpeechRecognition || null,
    setTimer: context.timers.set,
    clearTimer: context.timers.clear,
  });
  ui.speechMessage = '';
  function updateSpeech() {
    const active = speech.active,
      fromHand = !!state.editing?.handInput;
    operations.$('#nodeSpeech').hidden = !state.editing;
    operations.$('#nodeSpeechToggle').hidden = fromHand && active;
    operations.$('#nodeSpeechToggle').disabled = !speech.supported || speech.state === 'stopping';
    operations.$('#nodeSpeechToggle').textContent = services.tr(active ? 'speech.stop' : 'speech.start');
    operations.$('#nodeSpeechDone').disabled = (active && !fromHand) || !!state.editing?.pendingDone;
    operations.$('#nodeSpeechDone').textContent = services.tr(fromHand ? 'speech.handDone' : 'speech.done');
    operations.$('#nodeSpeechCancel').textContent = services.tr(fromHand ? 'speech.handCancel' : 'common.cancel');
    operations.$('#speechNote').textContent = services.tr(fromHand ? 'speech.handNote' : 'speech.note');
    operations.$('#speechStatus').textContent = !speech.supported
      ? services.tr('speech.unsupported')
      : active
        ? services.tr('speech.' + speech.state)
        : ui.speechMessage;
    if (!active) operations.$('#speechInterim').textContent = '';
    const t = state.editing && elements.nodeEls.get(state.editing.id)?.nodeText;
    if (t) t.contentEditable = active ? 'false' : 'plaintext-only';
  }
  function startNodeSpeech() {
    if (!state.editing || operations.readOnly()) return;
    const edit = state.editing,
      session = state.mapSessionId,
      t = elements.nodeEls.get(edit.id).nodeText;
    edit.pendingDone = false;
    ui.speechMessage = '';
    speech.start({
      valid: () =>
        state.editing === edit &&
        session === state.mapSessionId &&
        !operations.readOnly() &&
        !!state.map.nodes[edit.id],
      read: () => t.textContent,
      write: (text, interim) => {
        t.textContent = text;
        operations.$('#speechInterim').textContent = interim;
      },
      end: error => {
        const confirm = edit.pendingDone;
        edit.pendingDone = false;
        ui.speechMessage = error
          ? services.tr(
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
          : services.tr('speech.ready');
        operations.updateSpeech();
        if (!error && confirm && t.textContent.trim()) {
          operations.finishEdit();
          elements.viewportEl.focus();
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
      operations.updateSpeech();
    } else {
      operations.finishEdit();
      elements.viewportEl.focus();
    }
  }
  function initialize() {
    operations.$('#nodeSpeechToggle').onclick = () => (speech.active ? speech.stop() : operations.startNodeSpeech());
    operations.$('#nodeSpeechDone').onclick = operations.confirmNodeSpeech;
    operations.$('#nodeSpeechCancel').onclick = () => {
      operations.cancelEdit();
      elements.viewportEl.focus();
    };
    for (const id of ['#nodeSpeechToggle', '#nodeSpeechDone', '#nodeSpeechCancel']) {
      operations.$(id).addEventListener('pointerdown', e => {
        if (e.button !== 0 || e.isPrimary === false || e.currentTarget.disabled) return;
        // Safari does not focus buttons on tap/click. Move focus before its default
        // blur can end the edit, and keep recognition in the subsequent user click.
        e.preventDefault();
        e.currentTarget.focus({ preventScroll: true });
      });
    }
    operations.$('#nodeSpeech').addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        operations.cancelEdit();
        elements.viewportEl.focus();
      }
    });
    operations.$('#nodeSpeech').addEventListener('focusout', e => {
      if (
        state.editing &&
        !state.editing.handInput &&
        e.relatedTarget &&
        !operations.$('#nodeSpeech').contains(e.relatedTarget) &&
        e.relatedTarget !== elements.nodeEls.get(state.editing.id)?.nodeText
      )
        operations.finishEdit();
    });
    operations.updateSpeech();
  }
  return { speech, updateSpeech, startNodeSpeech, confirmNodeSpeech, initialize };
}
export { create };
