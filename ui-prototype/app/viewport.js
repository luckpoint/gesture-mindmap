function applyView() {
  world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.s})`;
  let g = 28 * state.view.s;
  while (g < 16) g *= 2;
  viewportEl.style.backgroundSize = `${g}px ${g}px`;
  viewportEl.style.backgroundPosition = `${state.view.x}px ${state.view.y}px`;
  $('#zoomLabel').textContent = Math.round(state.view.s * 100) + '%';
  positionMenu();
  clearTimeout(viewTimer);
  viewTimer = setTimeout(storeView, 500);
}
function clampView(v = state.view, hint = true) {
  const cx = (viewportWidth() / 2 - v.x) / v.s,
    cy = (innerHeight / 2 - v.y) / v.s;
  const nx = clamp(cx, -BOUND, BOUND),
    ny = clamp(cy, -BOUND, BOUND);
  if (hint && nx !== cx) edgeHint(cx < 0 ? 'left' : 'right');
  if (hint && ny !== cy) edgeHint(cy < 0 ? 'top' : 'bottom');
  v.x = viewportWidth() / 2 - nx * v.s;
  v.y = innerHeight / 2 - ny * v.s;
  return v;
}
function edgeHint(side) {
  const h = $('#edgeHint');
  h.dataset.side = side;
  h.classList.add('is-on');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => h.classList.remove('is-on'), 1200);
}
function zoomAt(sx, sy, s) {
  s = clamp(s, ZMIN, ZMAX);
  const wx = (sx - state.view.x) / state.view.s,
    wy = (sy - state.view.y) / state.view.s;
  state.view = clampView({ x: sx - wx * s, y: sy - wy * s, s });
  applyView();
}
let animId = 0;
function animateTo(target) {
  const my = ++animId;
  target = clampView({ ...target, s: clamp(target.s, ZMIN, ZMAX) }, false);
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    state.view = target;
    applyView();
    return;
  }
  const from = { ...state.view },
    t0 = performance.now();
  const step = now => {
    if (my !== animId) return;
    const k = Math.min(1, (now - t0) / 280),
      e = 1 - (1 - k) ** 3;
    state.view = {
      x: from.x + (target.x - from.x) * e,
      y: from.y + (target.y - from.y) * e,
      s: from.s + (target.s - from.s) * e,
    };
    applyView();
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function centerOn(pt, s = state.view.s) {
  return { x: viewportWidth() / 2 - pt.x * s, y: canvasHeight() / 2 - pt.y * s, s };
}
function mapBounds(tagSpace = 30) {
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity;
  for (const n of Object.values(state.map.nodes)) {
    const { w, h } = nodeSize(n);
    x0 = Math.min(x0, n.x - w / 2);
    x1 = Math.max(x1, n.x + w / 2);
    y0 = Math.min(y0, n.y - h / 2 - tagSpace);
    y1 = Math.max(y1, n.y + h / 2);
  }
  return { x0, y0, x1, y1 };
}
function fitAll() {
  const { x0, y0, x1, y1 } = mapBounds();
  const top = Math.min($('.topbar').getBoundingClientRect().bottom + 16, canvasHeight() / 3),
    side = Math.min(40, viewportWidth() / 10);
  const w = Math.max(1, viewportWidth() - side * 2),
    h = Math.max(1, canvasHeight() - top - 24);
  const s = clamp(Math.min(w / (x1 - x0), h / (y1 - y0)), ZMIN, 1.25);
  animateTo({ s, x: viewportWidth() / 2 - ((x0 + x1) / 2) * s, y: top + h / 2 - ((y0 + y1) / 2) * s });
}
function ensureVisible(pt) {
  const sx = pt.x * state.view.s + state.view.x,
    sy = pt.y * state.view.s + state.view.y;
  const { w, h } = nodeSize(pt),
    mx = Math.min(viewportWidth() / 3, (w * state.view.s) / 2 + 24),
    my = Math.min(canvasHeight() / 3, (h * state.view.s) / 2 + 24);
  if (sx < mx || sx > viewportWidth() - mx || sy < my || sy > canvasHeight() - my) animateTo(centerOn(pt));
}
