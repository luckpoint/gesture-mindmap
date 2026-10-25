// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services, environment, ui } = context;
  function nodeEl(id) {
    let el = elements.nodeEls.get(id);
    if (!el) {
      el = Object.assign(environment.document.createElement('div'), {
        className: 'node',
        innerHTML: '<span class="node__text"></span>',
      });
      el.nodeText = el.querySelector('.node__text');
      el.dataset.id = id;
      elements.nodesEl.append(el);
      elements.nodeEls.set(id, el);
    }
    return el;
  }
  function tagFor(id) {
    if (state.hand?.grab === id) return services.tr(state.hand.state === 'lost' ? 'hand.cantSee' : 'hand.grabbing');
    if (state.hand?.hover === id) return services.tr('hand.grabbable');
    if (state.mode?.id === id) return services.tr('reparent.active');
    if (state.mode?.candidate === id) return services.tr('reparent.ok');
    return '';
  }
  ui.dragFrame = null;
  function cancelDragRender() {
    if (ui.dragFrame !== null) environment.cancelAnimationFrame(ui.dragFrame);
    ui.dragFrame = null;
  }
  function scheduleDragRender(g) {
    if (ui.dragFrame !== null) return;
    ui.dragFrame = environment.requestAnimationFrame(() => {
      ui.dragFrame = null;
      if (state.gesture !== g) return;
      for (const id of g.orig.keys()) operations.renderNode(state.map.nodes[id], null);
      for (const id of g.edgeIds) operations.renderEdge(state.map.nodes[id]);
      operations.positionMenu();
    });
  }
  function renderNode(n, blocked) {
    const el = operations.nodeEl(n.id),
      t = el.nodeText;
    operations.renderNodeImage(el, n.image);
    if (state.editing?.id !== n.id && t.textContent !== n.text) t.textContent = n.text;
    el.style.setProperty('--x', n.x + 'px');
    el.style.setProperty('--y', n.y + 'px');
    el.style.setProperty('--b', operations.branchColor(n.id));
    const c = el.classList;
    c.toggle('is-root', n.id === state.map.root);
    c.toggle('has-image', !!n.image);
    c.toggle('is-selected', n.id === state.selectedId && !state.mode && !state.editing && !state.hand?.grab);
    c.toggle('is-editing', state.editing?.id === n.id);
    c.toggle(
      'is-dragging',
      state.gesture?.type === 'node' && state.gesture.moved && state.gesture.id === n.id && !state.hand,
    );
    c.toggle('is-grabbable', state.hand?.hover === n.id && !state.hand.grab);
    c.toggle('is-grabbed', state.hand?.grab === n.id && state.hand.state !== 'lost');
    c.toggle('is-lost', state.hand?.grab === n.id && state.hand.state === 'lost');
    c.toggle('is-source', state.mode?.id === n.id);
    c.toggle('is-invalid', !!blocked && blocked.has(n.id) && n.id !== state.mode.id);
    c.toggle('is-candidate', state.mode?.candidate === n.id || state.gesture?.swap === n.id);
    c.toggle(
      'is-delete-preview',
      !!state.deletion?.scope &&
        (state.deletion.scope === 'branch' ? state.deletion.ids.includes(n.id) : state.deletion.id === n.id),
    );
    c.toggle('is-promote-preview', state.deletion?.scope === 'single' && state.deletion.children.includes(n.id));
    const tag = operations.tagFor(n.id);
    tag ? (el.dataset.tag = tag) : delete el.dataset.tag;
  }
  function render() {
    ui.palette?.sync();
    operations.cancelDragRender();
    for (const [id, el] of elements.nodeEls)
      if (!state.map.nodes[id]) {
        operations.clearNodeImage(el);
        el.remove();
        elements.nodeEls.delete(id);
      }
    const blocked = state.mode?.blocked || null;
    for (const n of Object.values(state.map.nodes)) operations.renderNode(n, blocked);
    operations.renderEdges();
    operations.positionMenu();
    operations.$('#promptTarget').textContent = state.map.nodes[state.selectedId]
      ? services.tr('prompt.selected', state.map.nodes[state.selectedId].text)
      : services.tr('prompt.targetRoot');
  }
  function curve(a, b) {
    const dx = b.x - a.x,
      dy = b.y - a.y;
    return Math.abs(dx) >= Math.abs(dy)
      ? `M${a.x},${a.y} C${a.x + dx / 2},${a.y} ${a.x + dx / 2},${b.y} ${b.x},${b.y}`
      : `M${a.x},${a.y} C${a.x},${a.y + dy / 2} ${b.x},${a.y + dy / 2} ${b.x},${b.y}`;
  }
  const edgeEls = new Map();
  function createEdge(className) {
    const el = environment.document.createElementNS('http://www.w3.org/2000/svg', 'path');
    el.setAttribute('class', className);
    elements.edgesEl.append(el);
    return el;
  }
  function renderEdge(n) {
    if (n.parent == null) return;
    let el = edgeEls.get(n.id);
    if (!el) {
      el = operations.createEdge('edge');
      edgeEls.set(n.id, el);
    }
    el.classList.toggle('is-old', !!(state.mode?.id === n.id && state.mode.candidate));
    el.style.setProperty('--b', operations.branchColor(n.id));
    el.style.strokeWidth = [0, 5, 3.5][operations.depth(n.id)] || 2.5;
    const promote = state.deletion?.scope === 'single' && state.deletion.children.includes(n.id);
    el.classList.toggle('is-promote-preview', promote);
    el.classList.toggle(
      'is-delete-preview',
      !!state.deletion?.scope &&
        (state.deletion.scope === 'branch' ? state.deletion.ids.includes(n.id) : state.deletion.id === n.id),
    );
    el.setAttribute('d', operations.curve(state.map.nodes[promote ? state.deletion.parent : n.parent], n));
  }
  ui.previewEdge = null;
  function renderEdges() {
    for (const [id, el] of edgeEls) {
      if (!state.map.nodes[id] || state.map.nodes[id].parent == null) {
        el.remove();
        edgeEls.delete(id);
      }
    }
    for (const n of Object.values(state.map.nodes)) operations.renderEdge(n);
    if (state.mode?.candidate) {
      ui.previewEdge ||= operations.createEdge('edge is-preview');
      ui.previewEdge.setAttribute(
        'd',
        operations.curve(state.map.nodes[state.mode.candidate], state.map.nodes[state.mode.id]),
      );
    } else {
      ui.previewEdge?.remove();
      ui.previewEdge = null;
    }
  }
  function positionMenu() {
    const menu = operations.$('#nodeMenu'),
      n = state.selectedId && state.map.nodes[state.selectedId];
    const docked = environment.document.body.classList.contains('canvas-narrow');
    if (!n || state.editing || state.mode || state.deletion || state.hand?.grab || (state.gesture?.moved && !docked)) {
      menu.hidden = true;
      return;
    }
    menu.hidden = false;
    menu.querySelector('[data-act=remove-image]').hidden = !n.image;
    const imageKey = n.image ? 'node.changeImage' : 'node.image';
    menu.querySelector('[data-act=image] .btn__label--long').textContent = services.tr(imageKey);
    menu.querySelector('[data-act=image] .btn__label--short').textContent = services.tr(`${imageKey}.short`);
    for (const act of ['reparent', 'delete'])
      menu.querySelector(`[data-act=${act}]`).hidden = state.selectedId === state.map.root;
    const el = elements.nodeEls.get(state.selectedId),
      half = el.offsetHeight / 2;
    const mw = menu.offsetWidth,
      mh = menu.offsetHeight;
    const x = operations.clamp(
      n.x * state.view.s + state.view.x - mw / 2,
      8,
      Math.max(8, operations.viewportWidth() - mw - 8),
    );
    const above = (n.y - half) * state.view.s + state.view.y - mh - 40,
      below = (n.y + half) * state.view.s + state.view.y + 16;
    const covers = top =>
      Object.values(state.map.nodes).some(m => {
        if (m.id === state.selectedId) return false;
        const { w, h } = operations.nodeSize(m),
          left = (m.x - w / 2) * state.view.s + state.view.x,
          mTop = (m.y - h / 2) * state.view.s + state.view.y;
        return left < x + mw && left + w * state.view.s > x && mTop < top + mh && mTop + h * state.view.s > top;
      });
    const y = operations.clamp(
      above >= 72 && (!covers(above) || covers(below)) ? above : below,
      8,
      Math.max(8, (elements.viewportEl.clientHeight || environment.innerHeight) - mh - 8),
    );
    menu.style.transform = `translate(${x}px, ${y}px)`;
  }
  return {
    nodeEl,
    tagFor,
    cancelDragRender,
    scheduleDragRender,
    renderNode,
    render,
    curve,
    edgeEls,
    createEdge,
    renderEdge,
    renderEdges,
    positionMenu,
  };
}
export { create };
