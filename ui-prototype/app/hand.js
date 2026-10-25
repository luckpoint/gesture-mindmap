// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services, environment, ui } = context;
  ui.handController = null;
  ui.cameraSession = null;
  ui.handPaintKey = '';
  ui.handMode = 'worker';
  ui.camStatus = '';
  const handDebug = new services.HandDebugOverlay(operations.$('#handSkeleton'), operations.$('#handDebugValues')),
    handShape = new services.HandShapeView(operations.$('#handShape'));
  ui.camVideo = false;
  function setCamVideo(on) {
    ui.camVideo = on;
    operations.$('#cam').classList.toggle('is-video-off', !on);
    const button = operations.$('#camVideoToggle'),
      label = services.tr(on ? 'cam.videoHide' : 'cam.videoShow');
    button.setAttribute('aria-pressed', String(on));
    button.setAttribute('aria-label', label);
    button.title = label;
    button.querySelector('use').setAttribute('href', on ? '#i-eye' : '#i-eye-off');
    try {
      environment.localStorage.setItem(operations.CAM_VIDEO_KEY, on ? '1' : '');
    } catch {}
  }
  function handPose(frame) {
    if (!frame) return '';
    const pose =
      frame.pose && frame.pose !== 'neutral'
        ? frame.pose
        : frame.ratio <= ui.handController?.config.close
          ? 'pinch'
          : 'neutral';
    return services.tr('hand.pose.' + pose);
  }
  function stopHand() {
    ui.cameraSession?.stop();
    ui.cameraSession = null;
    ui.handController?.cancel();
    ui.handController = null;
    state.hand = null;
    ui.camStatus = '';
    operations.$('#cam').hidden = true;
    operations.$('#handCursor').hidden = true;
    operations.$('#handBtn').setAttribute('aria-pressed', 'false');
    operations.render();
  }
  function interruptHand() {
    ui.handController?.cancel();
  }
  function toggleHand(inputMode = 'worker') {
    if (ui.cameraSession) {
      operations.stopHand();
      return;
    }
    ui.handMode = inputMode;
    ui.handController = new services.HandGestures.HandController({
      disable: operations.stopHand,
      blocked: () =>
        (operations.speech.active && !state.editing?.handInput) ||
        ui.palette?.focused() ||
        operations.readOnly() ||
        state.instruction?.state === 'awaiting_confirmation' ||
        (!!state.editing && !state.editing.handInput) ||
        !!state.mode ||
        operations.pts.size > 0 ||
        !!(state.gesture && !state.gesture.hand) ||
        (!state.deletion &&
          !state.editing?.handInput &&
          !!environment.document.activeElement?.closest?.('input, textarea, [contenteditable="plaintext-only"]')),
      dialog: () => !!state.deletion || !!state.editing?.handInput,
      dialogNavigate: step => {
        if (state.deletion) operations.navigateDelete(step);
      },
      dialogChoose: side => {
        if (state.editing?.handInput) {
          if (side === 'left') operations.confirmNodeSpeech();
          else {
            operations.cancelEdit();
            elements.viewportEl.focus();
          }
        } else if (state.deletion) {
          side === 'left' ? operations.closeDelete() : operations.confirmDelete();
        }
      },
      command: action => {
        if (state.deletion || state.editing || state.mode || !state.map.nodes[state.selectedId]) return;
        if (action === 'add')
          operations.addChildAndEdit(state.map.nodes[state.selectedId] ? state.selectedId : state.map.root, true);
        else if (action === 'delete') operations.removeNode(state.selectedId || state.map.root);
      },
      select: id => {
        if (state.selectedId !== id) operations.select(id);
      },
      center: id => {
        if (state.map.nodes[id]) operations.animateTo(operations.centerOn(state.map.nodes[id]));
      },
      nodes: () =>
        [...elements.nodeEls]
          .filter(([id]) => state.map.nodes[id])
          .map(([id, el]) => {
            const r = el.getBoundingClientRect();
            return { id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
          }),
      pan: (dx, dy) => {
        ui.animId++;
        state.view = operations.clampView({ x: state.view.x + dx, y: state.view.y + dy, s: state.view.s });
        operations.applyView();
      },
      zoom: factor => {
        ui.animId++;
        operations.zoomAt(operations.viewportWidth() / 2, operations.canvasHeight() / 2, state.view.s * factor);
      },
      bounds: () => {
        const r = elements.viewportEl.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.left + operations.viewportWidth(),
          bottom: Math.min(r.bottom, operations.canvasHeight()),
        };
      },
      paint: handState => {
        state.hand = handState;
        const key = [handState.state, handState.hover, handState.grab].join(':');
        if (key !== ui.handPaintKey) {
          ui.handPaintKey = key;
          operations.render();
        }
        operations.updateHand();
      },
    });
    state.hand = ui.handController.state;
    operations.$('#cam').hidden = false;
    operations.$('#handBtn').setAttribute('aria-pressed', 'true');
    const session = new services.CameraSession({
      video: operations.$('#camVideo'),
      status: message => {
        ui.camStatus = message;
        operations.updateHand();
      },
      frame: (frame, now) => {
        operations.$('#handPose').textContent = operations.handPose(frame);
        ui.handController?.update(frame, now);
      },
      debug: (result, width, height) => {
        handShape.draw(result, width, height, !ui.camVideo);
        handDebug.draw(result, width, height);
      },
      metrics: m => {
        operations.$('#handMetrics').textContent = services.tr('dev.metrics', m);
      },
      cameras: (cameras, active) => {
        const select = operations.$('#camSelect');
        select.replaceChildren(
          ...cameras.map(
            (c, i) =>
              new environment.Option(
                c.label || services.tr('cam.label', i + 1),
                c.deviceId,
                false,
                c.deviceId === active,
              ),
          ),
        );
        select.hidden = cameras.length < 2;
      },
      error: message => {
        if (ui.cameraSession !== session) return;
        operations.stopHand();
        operations.toast(message);
      },
    });
    ui.cameraSession = session;
    elements.viewportEl.focus({ preventScroll: true });
    let deviceId;
    try {
      deviceId = environment.localStorage.getItem(operations.CAMERA_KEY) || undefined;
    } catch {}
    session.start(inputMode, deviceId);
  }
  const HAND_COMMANDS = ['palm', 'pinch', 'point', 'add', 'delete', 'pan', 'disable'];
  const HAND_TIPS = {
    ready: HAND_COMMANDS,
    waiting: HAND_COMMANDS,
    neutral: ['palm', 'point', 'add', 'delete', 'pan', 'zoom', 'disable'],
    centered: ['palm', 'pinch', 'disable'],
    paused: [],
    panning: ['stop'],
    zooming: ['spread', 'oneHand'],
    disableWaiting: ['disable'],
    dialog: ['dialogLeft', 'dialogRight', 'disable'],
  };
  const tipItems = tips =>
    tips.map(tip =>
      Object.assign(environment.document.createElement('li'), { textContent: services.tr('hand.tip.' + tip) }),
    );
  function updateHand() {
    if (!state.hand) return;
    const cursor = operations.$('#handCursor');
    cursor.hidden = !!ui.camStatus || !state.hand.pointerVisible;
    cursor.style.left = (state.hand.pointer?.x ?? state.hand.x) + 'px';
    cursor.style.top = (state.hand.pointer?.y ?? state.hand.y) + 'px';
    cursor.dataset.state = state.hand.hover ? 'hover' : 'ready';
    operations.$('#handLabel').textContent = state.hand.hover ? state.map.nodes[state.hand.hover]?.text || '' : '';
    const message = services.tr('hand.' + state.hand.state),
      unseen = !!ui.camStatus || state.hand.state === 'nohand' || state.hand.state === 'lost';
    const tips = unseen
      ? []
      : state.editing?.handInput
        ? ['voiceDone', 'voiceCancel']
        : HAND_TIPS[state.hand.state] || [];
    operations.$('#cam').dataset.state = ui.camStatus ? 'starting' : state.hand.state;
    operations.$('#camMsg').hidden = !unseen;
    operations.$('#camMsg').textContent = unseen ? ui.camStatus || message : '';
    operations.$('#handHelp').textContent = unseen ? '' : message;
    operations.$('#handProgress').style.setProperty('--p', state.hand.progress || 0);
    if (operations.$('#handTips').dataset.tips !== tips.join()) {
      operations.$('#handTips').dataset.tips = tips.join();
      operations.$('#handTips').replaceChildren(...operations.tipItems(tips));
    }
    if (state.deletion)
      operations.$('#deleteHandHelp').textContent =
        state.hand.state === 'paused' ? message : services.tr('delete.handHelp');
  }
  function initialize() {
    try {
      ui.camVideo = environment.localStorage.getItem(operations.CAM_VIDEO_KEY) === '1';
    } catch {}
    operations.setCamVideo(ui.camVideo);
    operations.$('#camVideoToggle').onclick = () => operations.setCamVideo(!ui.camVideo);
    operations.$('#handDebugToggle').onclick = () => {
      const enabled = !handDebug.enabled;
      handDebug.setEnabled(enabled);
      operations.$('#cam').classList.toggle('is-debug', enabled);
      operations.$('#handDebugToggle').setAttribute('aria-pressed', String(enabled));
    };
    operations
      .$('#handGuide')
      .replaceChildren(
        ...operations.tipItems(['palm', 'pinch', 'point', 'add', 'delete', 'fist', 'pan', 'zoom', 'disable']),
      );
    operations.$('#handGuideToggle').onclick = () => {
      const open = operations.$('#handGuide').hidden;
      operations.$('#handGuide').hidden = !open;
      operations.$('#handGuideToggle').setAttribute('aria-expanded', String(open));
    };
  }
  return {
    handDebug,
    handShape,
    setCamVideo,
    handPose,
    stopHand,
    interruptHand,
    toggleHand,
    HAND_COMMANDS,
    HAND_TIPS,
    tipItems,
    updateHand,
    initialize,
  };
}
export { create };
