function nodeEl(id) {
  let el = nodeEls.get(id);
  if (!el) {
    el = Object.assign(document.createElement('div'), {
      className: 'node',
      innerHTML: '<span class="node__text"></span>',
    });
    el.nodeText = el.querySelector('.node__text');
    el.dataset.id = id;
    nodesEl.append(el);
    nodeEls.set(id, el);
  }
  return el;
}
function tagFor(id) {
  if (state.hand?.grab === id) return tr(state.hand.state === 'lost' ? 'hand.cantSee' : 'hand.grabbing');
  if (state.hand?.hover === id) return tr('hand.grabbable');
  if (state.mode?.id === id) return tr('reparent.active');
  if (state.mode?.candidate === id) return tr('reparent.ok');
  return '';
}
let dragFrame = null;
function cancelDragRender() {
  if (dragFrame !== null) cancelAnimationFrame(dragFrame);
  dragFrame = null;
}
function scheduleDragRender(g) {
  if (dragFrame !== null) return;
  dragFrame = requestAnimationFrame(() => {
    dragFrame = null;
    if (state.gesture !== g) return;
    for (const id of g.orig.keys()) renderNode(state.map.nodes[id], null);
    for (const id of g.edgeIds) renderEdge(state.map.nodes[id]);
    positionMenu();
  });
}
function renderNode(n, blocked) {
  const el = nodeEl(n.id),
    t = el.nodeText;
  renderNodeImage(el, n.image);
  if (state.editing?.id !== n.id && t.textContent !== n.text) t.textContent = n.text;
  el.style.setProperty('--x', n.x + 'px');
  el.style.setProperty('--y', n.y + 'px');
  el.style.setProperty('--b', branchColor(n.id));
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
  const tag = tagFor(n.id);
  tag ? (el.dataset.tag = tag) : delete el.dataset.tag;
}
function render() {
  palette?.sync();
  cancelDragRender();
  for (const [id, el] of nodeEls)
    if (!state.map.nodes[id]) {
      clearNodeImage(el);
      el.remove();
      nodeEls.delete(id);
    }
  const blocked = state.mode?.blocked || null;
  for (const n of Object.values(state.map.nodes)) renderNode(n, blocked);
  renderEdges();
  positionMenu();
  $('#promptTarget').textContent = state.map.nodes[state.selectedId]
    ? tr('prompt.selected', state.map.nodes[state.selectedId].text)
    : tr('prompt.targetRoot');
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
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  el.setAttribute('class', className);
  edgesEl.append(el);
  return el;
}
function renderEdge(n) {
  if (n.parent == null) return;
  let el = edgeEls.get(n.id);
  if (!el) {
    el = createEdge('edge');
    edgeEls.set(n.id, el);
  }
  el.classList.toggle('is-old', !!(state.mode?.id === n.id && state.mode.candidate));
  el.style.setProperty('--b', branchColor(n.id));
  el.style.strokeWidth = [0, 5, 3.5][depth(n.id)] || 2.5;
  const promote = state.deletion?.scope === 'single' && state.deletion.children.includes(n.id);
  el.classList.toggle('is-promote-preview', promote);
  el.classList.toggle(
    'is-delete-preview',
    !!state.deletion?.scope &&
      (state.deletion.scope === 'branch' ? state.deletion.ids.includes(n.id) : state.deletion.id === n.id),
  );
  el.setAttribute('d', curve(state.map.nodes[promote ? state.deletion.parent : n.parent], n));
}
let previewEdge = null;
function renderEdges() {
  for (const [id, el] of edgeEls) {
    if (!state.map.nodes[id] || state.map.nodes[id].parent == null) {
      el.remove();
      edgeEls.delete(id);
    }
  }
  for (const n of Object.values(state.map.nodes)) renderEdge(n);
  if (state.mode?.candidate) {
    previewEdge ||= createEdge('edge is-preview');
    previewEdge.setAttribute('d', curve(state.map.nodes[state.mode.candidate], state.map.nodes[state.mode.id]));
  } else {
    previewEdge?.remove();
    previewEdge = null;
  }
}
function positionMenu() {
  const menu = $('#nodeMenu'),
    n = state.selectedId && state.map.nodes[state.selectedId];
  const docked = document.body.classList.contains('canvas-narrow');
  if (!n || state.editing || state.mode || state.deletion || state.hand?.grab || (state.gesture?.moved && !docked)) {
    menu.hidden = true;
    return;
  }
  menu.hidden = false;
  menu.querySelector('[data-act=remove-image]').hidden = !n.image;
  const imageKey = n.image ? 'node.changeImage' : 'node.image';
  menu.querySelector('[data-act=image] .btn__label--long').textContent = tr(imageKey);
  menu.querySelector('[data-act=image] .btn__label--short').textContent = tr(`${imageKey}.short`);
  for (const act of ['reparent', 'delete'])
    menu.querySelector(`[data-act=${act}]`).hidden = state.selectedId === state.map.root;
  const el = nodeEls.get(state.selectedId),
    half = el.offsetHeight / 2;
  const mw = menu.offsetWidth,
    mh = menu.offsetHeight;
  const x = clamp(n.x * state.view.s + state.view.x - mw / 2, 8, Math.max(8, viewportWidth() - mw - 8));
  const above = (n.y - half) * state.view.s + state.view.y - mh - 40,
    below = (n.y + half) * state.view.s + state.view.y + 16;
  const covers = top =>
    Object.values(state.map.nodes).some(m => {
      if (m.id === state.selectedId) return false;
      const { w, h } = nodeSize(m),
        left = (m.x - w / 2) * state.view.s + state.view.x,
        mTop = (m.y - h / 2) * state.view.s + state.view.y;
      return left < x + mw && left + w * state.view.s > x && mTop < top + mh && mTop + h * state.view.s > top;
    });
  const y = clamp(
    above >= 72 && (!covers(above) || covers(below)) ? above : below,
    8,
    Math.max(8, (viewportEl.clientHeight || innerHeight) - mh - 8),
  );
  menu.style.transform = `translate(${x}px, ${y}px)`;
}
