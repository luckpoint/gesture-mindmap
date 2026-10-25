let handController = null,
  cameraSession = null,
  handPaintKey = '',
  handMode = 'worker',
  camStatus = '';
const handDebug = new HandDebugOverlay($('#handSkeleton'), $('#handDebugValues')),
  handShape = new HandShapeView($('#handShape'));
let camVideo = false;
try {
  camVideo = localStorage.getItem(CAM_VIDEO_KEY) === '1';
} catch {}
function setCamVideo(on) {
  camVideo = on;
  $('#cam').classList.toggle('is-video-off', !on);
  const button = $('#camVideoToggle'),
    label = tr(on ? 'cam.videoHide' : 'cam.videoShow');
  button.setAttribute('aria-pressed', String(on));
  button.setAttribute('aria-label', label);
  button.title = label;
  button.querySelector('use').setAttribute('href', on ? '#i-eye' : '#i-eye-off');
  try {
    localStorage.setItem(CAM_VIDEO_KEY, on ? '1' : '');
  } catch {}
}
setCamVideo(camVideo);
$('#camVideoToggle').onclick = () => setCamVideo(!camVideo);
function handPose(frame) {
  if (!frame) return '';
  const pose =
    frame.pose && frame.pose !== 'neutral'
      ? frame.pose
      : frame.ratio <= handController?.config.close
        ? 'pinch'
        : 'neutral';
  return tr('hand.pose.' + pose);
}
$('#handDebugToggle').onclick = () => {
  const enabled = !handDebug.enabled;
  handDebug.setEnabled(enabled);
  $('#cam').classList.toggle('is-debug', enabled);
  $('#handDebugToggle').setAttribute('aria-pressed', String(enabled));
};
function stopHand() {
  cameraSession?.stop();
  cameraSession = null;
  handController?.cancel();
  handController = null;
  state.hand = null;
  camStatus = '';
  $('#cam').hidden = true;
  $('#handCursor').hidden = true;
  $('#handBtn').setAttribute('aria-pressed', 'false');
  render();
}
function interruptHand() {
  handController?.cancel();
}
function toggleHand(inputMode = 'worker') {
  if (cameraSession) {
    stopHand();
    return;
  }
  handMode = inputMode;
  handController = new HandGestures.HandController({
    disable: stopHand,
    blocked: () =>
      (speech.active && !state.editing?.handInput) ||
      palette?.focused() ||
      readOnly() ||
      state.instruction?.state === 'awaiting_confirmation' ||
      (!!state.editing && !state.editing.handInput) ||
      !!state.mode ||
      pts.size > 0 ||
      !!(state.gesture && !state.gesture.hand) ||
      (!state.deletion &&
        !state.editing?.handInput &&
        !!document.activeElement?.closest?.('input, textarea, [contenteditable="plaintext-only"]')),
    dialog: () => !!state.deletion || !!state.editing?.handInput,
    dialogNavigate: step => {
      if (state.deletion) navigateDelete(step);
    },
    dialogChoose: side => {
      if (state.editing?.handInput) {
        if (side === 'left') confirmNodeSpeech();
        else {
          cancelEdit();
          viewportEl.focus();
        }
      } else if (state.deletion) {
        side === 'left' ? closeDelete() : confirmDelete();
      }
    },
    command: action => {
      if (state.deletion || state.editing || state.mode || !state.map.nodes[state.selectedId]) return;
      if (action === 'add')
        addChildAndEdit(state.map.nodes[state.selectedId] ? state.selectedId : state.map.root, true);
      else if (action === 'delete') removeNode(state.selectedId || state.map.root);
    },
    select: id => {
      if (state.selectedId !== id) select(id);
    },
    center: id => {
      if (state.map.nodes[id]) animateTo(centerOn(state.map.nodes[id]));
    },
    nodes: () =>
      [...nodeEls]
        .filter(([id]) => state.map.nodes[id])
        .map(([id, el]) => {
          const r = el.getBoundingClientRect();
          return { id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
        }),
    pan: (dx, dy) => {
      animId++;
      state.view = clampView({ x: state.view.x + dx, y: state.view.y + dy, s: state.view.s });
      applyView();
    },
    zoom: factor => {
      animId++;
      zoomAt(viewportWidth() / 2, canvasHeight() / 2, state.view.s * factor);
    },
    bounds: () => {
      const r = viewportEl.getBoundingClientRect();
      return {
        left: r.left,
        top: r.top,
        right: r.left + viewportWidth(),
        bottom: Math.min(r.bottom, canvasHeight()),
      };
    },
    paint: handState => {
      state.hand = handState;
      const key = [handState.state, handState.hover, handState.grab].join(':');
      if (key !== handPaintKey) {
        handPaintKey = key;
        render();
      }
      updateHand();
    },
  });
  state.hand = handController.state;
  $('#cam').hidden = false;
  $('#handBtn').setAttribute('aria-pressed', 'true');
  const session = new CameraSession({
    video: $('#camVideo'),
    status: message => {
      camStatus = message;
      updateHand();
    },
    frame: (frame, now) => {
      $('#handPose').textContent = handPose(frame);
      handController?.update(frame, now);
    },
    debug: (result, width, height) => {
      handShape.draw(result, width, height, !camVideo);
      handDebug.draw(result, width, height);
    },
    metrics: m => {
      $('#handMetrics').textContent = tr('dev.metrics', m);
    },
    cameras: (cameras, active) => {
      const select = $('#camSelect');
      select.replaceChildren(
        ...cameras.map(
          (c, i) => new Option(c.label || tr('cam.label', i + 1), c.deviceId, false, c.deviceId === active),
        ),
      );
      select.hidden = cameras.length < 2;
    },
    error: message => {
      if (cameraSession !== session) return;
      stopHand();
      toast(message);
    },
  });
  cameraSession = session;
  viewportEl.focus({ preventScroll: true });
  let deviceId;
  try {
    deviceId = localStorage.getItem(CAMERA_KEY) || undefined;
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
  tips.map(tip => Object.assign(document.createElement('li'), { textContent: tr('hand.tip.' + tip) }));
$('#handGuide').replaceChildren(
  ...tipItems(['palm', 'pinch', 'point', 'add', 'delete', 'fist', 'pan', 'zoom', 'disable']),
);
$('#handGuideToggle').onclick = () => {
  const open = $('#handGuide').hidden;
  $('#handGuide').hidden = !open;
  $('#handGuideToggle').setAttribute('aria-expanded', String(open));
};
function updateHand() {
  if (!state.hand) return;
  const cursor = $('#handCursor');
  cursor.hidden = !!camStatus || !state.hand.pointerVisible;
  cursor.style.left = (state.hand.pointer?.x ?? state.hand.x) + 'px';
  cursor.style.top = (state.hand.pointer?.y ?? state.hand.y) + 'px';
  cursor.dataset.state = state.hand.hover ? 'hover' : 'ready';
  $('#handLabel').textContent = state.hand.hover ? state.map.nodes[state.hand.hover]?.text || '' : '';
  const message = tr('hand.' + state.hand.state),
    unseen = !!camStatus || state.hand.state === 'nohand' || state.hand.state === 'lost';
  const tips = unseen
    ? []
    : state.editing?.handInput
      ? ['voiceDone', 'voiceCancel']
      : HAND_TIPS[state.hand.state] || [];
  $('#cam').dataset.state = camStatus ? 'starting' : state.hand.state;
  $('#camMsg').hidden = !unseen;
  $('#camMsg').textContent = unseen ? camStatus || message : '';
  $('#handHelp').textContent = unseen ? '' : message;
  $('#handProgress').style.setProperty('--p', state.hand.progress || 0);
  if ($('#handTips').dataset.tips !== tips.join()) {
    $('#handTips').dataset.tips = tips.join();
    $('#handTips').replaceChildren(...tipItems(tips));
  }
  if (state.deletion)
    $('#deleteHandHelp').textContent = state.hand.state === 'paused' ? message : tr('delete.handHelp');
}
