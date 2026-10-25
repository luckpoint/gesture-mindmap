// Application dependencies are supplied per instance; evaluation has no screen effects.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindmapAppViewport = api;
})(globalThis, () => {
  'use strict';
  function create(context, operations) {
    const { state, elements, environment, ui } = context;
    function applyView() {
      elements.world.style.transform = `translate(${state.view.x}px, ${state.view.y}px) scale(${state.view.s})`;
      let g = 28 * state.view.s;
      while (g < 16) g *= 2;
      elements.viewportEl.style.backgroundSize = `${g}px ${g}px`;
      elements.viewportEl.style.backgroundPosition = `${state.view.x}px ${state.view.y}px`;
      operations.$('#zoomLabel').textContent = Math.round(state.view.s * 100) + '%';
      operations.positionMenu();
      context.timers.clear(context.timers.view);
      context.timers.view = context.timers.set(operations.storeView, 500);
    }
    function clampView(v = state.view, hint = true) {
      const cx = (operations.viewportWidth() / 2 - v.x) / v.s,
        cy = (environment.innerHeight / 2 - v.y) / v.s;
      const nx = operations.clamp(cx, -operations.BOUND, operations.BOUND),
        ny = operations.clamp(cy, -operations.BOUND, operations.BOUND);
      if (hint && nx !== cx) operations.edgeHint(cx < 0 ? 'left' : 'right');
      if (hint && ny !== cy) operations.edgeHint(cy < 0 ? 'top' : 'bottom');
      v.x = operations.viewportWidth() / 2 - nx * v.s;
      v.y = environment.innerHeight / 2 - ny * v.s;
      return v;
    }
    function edgeHint(side) {
      const h = operations.$('#edgeHint');
      h.dataset.side = side;
      h.classList.add('is-on');
      context.timers.clear(context.timers.hint);
      context.timers.hint = context.timers.set(() => h.classList.remove('is-on'), 1200);
    }
    function zoomAt(sx, sy, s) {
      s = operations.clamp(s, operations.ZMIN, operations.ZMAX);
      const wx = (sx - state.view.x) / state.view.s,
        wy = (sy - state.view.y) / state.view.s;
      state.view = operations.clampView({ x: sx - wx * s, y: sy - wy * s, s });
      operations.applyView();
    }
    ui.animId = 0;
    function animateTo(target) {
      const my = ++ui.animId;
      target = operations.clampView(
        { ...target, s: operations.clamp(target.s, operations.ZMIN, operations.ZMAX) },
        false,
      );
      if (environment.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        state.view = target;
        operations.applyView();
        return;
      }
      const from = { ...state.view },
        t0 = environment.performance.now();
      const step = now => {
        if (my !== ui.animId) return;
        const k = Math.min(1, (now - t0) / 280),
          e = 1 - (1 - k) ** 3;
        state.view = {
          x: from.x + (target.x - from.x) * e,
          y: from.y + (target.y - from.y) * e,
          s: from.s + (target.s - from.s) * e,
        };
        operations.applyView();
        if (k < 1) environment.requestAnimationFrame(step);
      };
      environment.requestAnimationFrame(step);
    }
    function centerOn(pt, s = state.view.s) {
      return { x: operations.viewportWidth() / 2 - pt.x * s, y: operations.canvasHeight() / 2 - pt.y * s, s };
    }
    function mapBounds(tagSpace = 30) {
      let x0 = Infinity,
        y0 = Infinity,
        x1 = -Infinity,
        y1 = -Infinity;
      for (const n of Object.values(state.map.nodes)) {
        const { w, h } = operations.nodeSize(n);
        x0 = Math.min(x0, n.x - w / 2);
        x1 = Math.max(x1, n.x + w / 2);
        y0 = Math.min(y0, n.y - h / 2 - tagSpace);
        y1 = Math.max(y1, n.y + h / 2);
      }
      return { x0, y0, x1, y1 };
    }
    function fitAll() {
      const { x0, y0, x1, y1 } = operations.mapBounds();
      const top = Math.min(operations.$('.topbar').getBoundingClientRect().bottom + 16, operations.canvasHeight() / 3),
        side = Math.min(40, operations.viewportWidth() / 10);
      const w = Math.max(1, operations.viewportWidth() - side * 2),
        h = Math.max(1, operations.canvasHeight() - top - 24);
      const s = operations.clamp(Math.min(w / (x1 - x0), h / (y1 - y0)), operations.ZMIN, 1.25);
      operations.animateTo({
        s,
        x: operations.viewportWidth() / 2 - ((x0 + x1) / 2) * s,
        y: top + h / 2 - ((y0 + y1) / 2) * s,
      });
    }
    function ensureVisible(pt) {
      const sx = pt.x * state.view.s + state.view.x,
        sy = pt.y * state.view.s + state.view.y;
      const { w, h } = operations.nodeSize(pt),
        mx = Math.min(operations.viewportWidth() / 3, (w * state.view.s) / 2 + 24),
        my = Math.min(operations.canvasHeight() / 3, (h * state.view.s) / 2 + 24);
      if (sx < mx || sx > operations.viewportWidth() - mx || sy < my || sy > operations.canvasHeight() - my)
        operations.animateTo(operations.centerOn(pt));
    }
    return {
      applyView,
      clampView,
      edgeHint,
      zoomAt,
      animateTo,
      centerOn,
      mapBounds,
      fitAll,
      ensureVisible,
    };
  }
  return { create };
});
