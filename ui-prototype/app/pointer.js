function beginNodeDrag(id, x, y, fromHand = false) {
  animId++;
  state.selectedId = id;
  const orig = new Map([...subtree(id)].map(d => [d, { x: state.map.nodes[d].x, y: state.map.nodes[d].y }]));
  const edgeIds = new Set();
  for (const d of orig.keys()) {
    if (state.map.nodes[d].parent != null) edgeIds.add(d);
    for (const child of childrenOf(d)) edgeIds.add(child.id);
  }
  state.gesture = {
    type: 'node',
    edgeIds,
    id,
    sx: x,
    sy: y,
    moved: false,
    pre: JSON.stringify(state.map),
    orig,
    hand: fromHand,
  };
  render();
}
function moveNodeDrag(g, x, y) {
  const dx = x - g.sx,
    dy = y - g.sy;
  if (!g.moved && Math.hypot(dx, dy) < 4) return;
  let wx = dx / state.view.s,
    wy = dy / state.view.s;
  for (const p of g.orig.values()) {
    wx = clamp(wx, -BOUND - p.x, BOUND - p.x);
    wy = clamp(wy, -BOUND - p.y, BOUND - p.y);
  }
  for (const [id, p] of g.orig) {
    state.map.nodes[id].x = Math.round(p.x + wx);
    state.map.nodes[id].y = Math.round(p.y + wy);
  }
  g.moved = true;
  const target = swapTarget(g, x, y);
  if (target !== g.swap) {
    const prev = g.swap;
    g.swap = target;
    for (const id of [prev, target]) if (id) renderNode(state.map.nodes[id], null);
  }
  scheduleDragRender(g);
}
function swapTarget(g, x, y) {
  const wx = (x - state.view.x) / state.view.s,
    wy = (y - state.view.y) / state.view.s;
  return (
    childrenOf(state.map.nodes[g.id].parent).find(n => {
      const s = nodeSize(n);
      return n.id !== g.id && Math.abs(n.x - wx) < s.w / 2 && Math.abs(n.y - wy) < s.h / 2;
    })?.id ?? null
  );
}
function finishNodeDrag(g) {
  state.gesture = null;
  if (state.hand) state.hand.grab = null;
  if (g.swap) {
    for (const [id, p] of g.orig) Object.assign(state.map.nodes[id], p);
    InstructionOperations.swap(state.map, g.id, g.swap);
    record(g.pre);
    changed();
    toast(tr('swap.done'), tr('common.undo'), undo);
  } else if (JSON.stringify(state.map) !== g.pre) {
    record(g.pre);
    changed();
  } else render();
  updateHand();
}
function revertGesture() {
  if (state.gesture?.type === 'node') for (const [id, p] of state.gesture.orig) Object.assign(state.map.nodes[id], p);
  if (state.hand) state.hand.grab = null;
  state.gesture = null;
  render();
  updateHand();
}

/* ---------- pointer ---------- */
const pts = new Map();
viewportEl.addEventListener('pointerdown', e => {
  if (e.target.isContentEditable) return;
  interruptHand();
  animId++;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  viewportEl.setPointerCapture(e.pointerId);
  if (pts.size === 2) {
    if (state.gesture?.type === 'node') revertGesture();
    const [a, b] = [...pts.values()];
    state.gesture = {
      type: 'pinch',
      d0: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      s0: state.view.s,
      wx: ((a.x + b.x) / 2 - state.view.x) / state.view.s,
      wy: ((a.y + b.y) / 2 - state.view.y) / state.view.s,
    };
    return;
  }
  if (state.editing) finishEdit();
  viewportEl.focus({ preventScroll: true });
  const id = e.target.closest('.node')?.dataset.id;
  if (state.mode) {
    if (!id) return;
    if (e.pointerType === 'mouse' || state.mode.candidate === id) {
      setCandidate(id);
      if (state.mode.candidate) confirmReparent();
    } else setCandidate(id);
    return;
  }
  if (id && !readOnly()) beginNodeDrag(id, e.clientX, e.clientY);
  else
    state.gesture = {
      type: 'pan',
      id: id ?? null,
      sx: e.clientX,
      sy: e.clientY,
      vx: state.view.x,
      vy: state.view.y,
      moved: false,
    };
  palette?.sync();
});
viewportEl.addEventListener('pointermove', e => {
  if (state.mode && e.pointerType === 'mouse') setCandidate(e.target.closest('.node')?.dataset.id || null);
  if (!pts.has(e.pointerId)) return;
  pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const g = state.gesture;
  if (!g) return;
  if (g.type === 'pinch') {
    if (pts.size < 2) {
      state.gesture = null;
      return;
    }
    const [a, b] = [...pts.values()];
    const s = clamp((g.s0 * Math.hypot(a.x - b.x, a.y - b.y)) / g.d0, ZMIN, ZMAX);
    state.view = clampView({ x: (a.x + b.x) / 2 - g.wx * s, y: (a.y + b.y) / 2 - g.wy * s, s });
    applyView();
    return;
  }
  const dx = e.clientX - g.sx,
    dy = e.clientY - g.sy;
  if (!g.moved && Math.hypot(dx, dy) < 4) return;
  g.moved = true;
  if (g.type === 'pan') {
    viewportEl.classList.add('is-panning');
    state.view = clampView({ x: g.vx + dx, y: g.vy + dy, s: state.view.s });
    applyView();
  } else if (g.type === 'node') {
    moveNodeDrag(g, e.clientX, e.clientY);
  }
});
function endPointer(e) {
  pts.delete(e.pointerId);
  const g = state.gesture;
  viewportEl.classList.remove('is-panning');
  if (!g || g.hand) return;
  // Lifting either finger ends the pinch. The remaining finger cannot start
  // a pan or move a node until a new gesture begins.
  if (g.type === 'pinch') {
    state.gesture = null;
    return;
  }
  if (g.type === 'node') {
    finishNodeDrag(g);
    return;
  }
  state.gesture = null;
  if (g.type === 'pan' && !g.moved) select(g.id);
  else render();
  updateHand();
}
viewportEl.addEventListener('pointerup', endPointer);
viewportEl.addEventListener('pointercancel', e => {
  if (state.gesture?.type === 'node') revertGesture();
  endPointer(e);
});
viewportEl.addEventListener('lostpointercapture', e => {
  if (!pts.has(e.pointerId)) return;
  if (state.gesture?.type === 'node') revertGesture();
  endPointer(e);
});
viewportEl.addEventListener('dblclick', e => {
  const hit = document.elementFromPoint(e.clientX, e.clientY),
    id = hit?.closest('.node')?.dataset.id;
  if (!id || state.mode) return;
  if (!(hit.closest('.node__image') && !state.editing && openImageViewer(id))) startEdit(id);
});
viewportEl.addEventListener(
  'wheel',
  e => {
    e.preventDefault();
    interruptHand();
    animId++;
    if (e.ctrlKey || e.metaKey) zoomAt(e.clientX, e.clientY, state.view.s * Math.exp(-e.deltaY * 0.01));
    else {
      state.view = clampView({ x: state.view.x - e.deltaX, y: state.view.y - e.deltaY, s: state.view.s });
      applyView();
    }
  },
  { passive: false },
);
document.addEventListener('gesturestart', e => e.preventDefault());
