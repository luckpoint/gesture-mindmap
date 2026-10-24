/* Shared by the browser and the relay. No state, DOM, or model output is trusted. */
(function (root, factory) {
  const api = typeof module === 'object' && module.exports ? factory(require('../images/format.js'), require('../i18n.js')) : factory(root.NodeImageFormat, root.I18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InstructionOperations = api;
})(globalThis, (ImageFormat, I18n) => {
  'use strict';
  const tr = I18n.t;
  const own = (o, k) => Object.hasOwn(o, k);
  const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const clone = v => JSON.parse(JSON.stringify(v));
  const identifier = v => typeof v === 'string' && v.length > 0 && v.length <= 160 && !['__proto__', 'prototype', 'constructor'].includes(v) && !/[\s\x00-\x1f]/.test(v);
  const fail = message => { throw new Error(message); };
  const valid = ImageFormat.validMap;
  function serialize(map) { if (!valid(map)) fail(tr('map.invalid')); return clone(map); }
  function children(m, id) { return Object.values(m.nodes).filter(n => n.parent === id).sort((a, b) => a.order - b.order); }
  function subtree(m, id) {
    const out = new Set([id]); const queue = [id];
    for (let i = 0; i < queue.length; i++) for (const n of children(m, queue[i])) { out.add(n.id); queue.push(n.id); }
    return out;
  }
  const estimate = n => (n.image ? { w: 208, h: 160 } : { w: Math.min(260, n.text.length * 18 + 40), h: 52 });
  function place(m, pid, w = 160, size = estimate) {
    const p = m.nodes[pid]; let base = 0;
    if (p.parent !== null) { const g = m.nodes[p.parent]; base = Math.atan2(p.y - g.y, p.x - g.x); }
    else {
      const angles = children(m, pid).map(c => Math.atan2(c.y - p.y, c.x - p.x)).sort((a, b) => a - b); let gap = -1;
      if (angles.length === 1) base = angles[0] + Math.PI;
      angles.forEach((a, i) => { const next = i === angles.length - 1 ? angles[0] + Math.PI * 2 : angles[i + 1]; if (angles.length > 1 && next - a > gap) { gap = next - a; base = a + gap / 2; } });
    }
    const dist = p.parent === null ? 250 : 200;
    const point = (a, d) => ({ x: Math.round(Math.max(-8000, Math.min(8000, p.x + Math.cos(a) * d))), y: Math.round(Math.max(-8000, Math.min(8000, p.y + Math.sin(a) * d))) });
    for (let ring = 0; ring < 4; ring++) for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6, 7]) {
      const pt = point(base + k * .4, dist + ring * 100);
      if (!Object.values(m.nodes).some(n => { const s = size(n); return Math.abs(n.x - pt.x) < (s.w + w) / 2 + 12 && Math.abs(n.y - pt.y) < (s.h + 52) / 2 + 32; })) return pt;
    }
    return point(base, dist);
  }
  function addNode(m, pid, text, pos, size = estimate) {
    if (!own(m.nodes, pid)) fail(tr('ops.missingParent'));
    let id; do { id = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10); } while (own(m.nodes, id));
    pos ||= place(m, pid, Math.max(160, estimate({ text }).w), size);
    m.nodes[id] = { id, text, parent: pid, x: Math.round(pos.x), y: Math.round(pos.y), order: ++m.seq }; return id;
  }
  const bound = v => Math.round(Math.max(-8000, Math.min(8000, v)));
  function swap(m, a, b) {
    const x = m.nodes[a], y = m.nodes[b];
    if (!x || !y || a === b || x.parent === null || x.parent !== y.parent) fail(tr('ops.swapSiblings'));
    const p = m.nodes[x.parent], angle = n => Math.atan2(n.y - p.y, n.x - p.x);
    const moves = [[x, y], [y, x]].flatMap(([from, to]) => {
      const t = angle(to) - angle(from), cos = Math.cos(t), sin = Math.sin(t);
      return [...subtree(m, from.id)].map(id => { const n = m.nodes[id], dx = n.x - from.x, dy = n.y - from.y; return [n, to.x + dx * cos - dy * sin, to.y + dx * sin + dy * cos]; });
    });
    for (const [n, nx, ny] of moves) { n.x = bound(nx); n.y = bound(ny); }
  }
  const fields = { add_node: ['type', 'clientId', 'parentId', 'text'], update_node: ['type', 'nodeId', 'text'], reparent_node: ['type', 'nodeId', 'parentId'], delete_node: ['type', 'nodeId', 'scope'], swap_nodes: ['type', 'nodeId', 'otherId'] };
  function exact(value, keys) { return record(value) && Object.keys(value).length === keys.length && keys.every(k => own(value, k)); }
  function validateProposal(p) {
    if (!exact(p, ['status', 'message', 'operations']) || !['ok', 'needs_input', 'no_change'].includes(p.status) || typeof p.message !== 'string' || p.message.length > 1000 || !Array.isArray(p.operations) || p.operations.length > 100 ||
        (p.status === 'ok' ? !p.operations.length : p.operations.length)) fail(tr('ops.badProposal'));
    for (const op of p.operations) {
      if (!record(op) || !fields[op.type] || !exact(op, fields[op.type])) fail(tr('ops.notAllowed'));
      for (const k of ['clientId', 'parentId', 'nodeId', 'otherId']) if (own(op, k) && !identifier(op[k])) fail(tr('ops.badId'));
      if (own(op, 'text') && (typeof op.text !== 'string' || !op.text.trim() || op.text.length > 4000)) fail(tr('ops.textLength'));
      if (op.type === 'delete_node' && !['single', 'subtree'].includes(op.scope)) fail(tr('ops.badScope'));
    }
    return p;
  }
  function diff(before, after) {
    const counts = { added: 0, updated: 0, reparented: 0, moved: 0, deleted: 0 };
    for (const [id, n] of Object.entries(after.nodes)) {
      if (!own(before.nodes, id)) counts.added++;
      else { if (n.text !== before.nodes[id].text) counts.updated++; if (n.parent !== before.nodes[id].parent) counts.reparented++; if (n.x !== before.nodes[id].x || n.y !== before.nodes[id].y) counts.moved++; }
    }
    for (const id of Object.keys(before.nodes)) if (!own(after.nodes, id)) counts.deleted++;
    return counts;
  }
  function summary(c) {
    return tr('ops.summary', c);
  }
  function prepare(before, proposal, options = {}) {
    validateProposal(proposal); const m = serialize(before), refs = new Map(), used = new Set(Object.keys(m.nodes)), deletions = [], focus = [];
    const resolve = id => { const key = refs.get(id) || id; if (!own(m.nodes, key)) fail(tr('ops.missingNode')); return key; };
    for (const op of proposal.operations) {
      if (op.type === 'add_node') {
        if (used.has(op.clientId)) fail(tr('ops.duplicateClientId'));
        const parent = resolve(op.parentId), id = addNode(m, parent, op.text, undefined, options.size);
        refs.set(op.clientId, id); used.add(op.clientId); used.add(id); focus.push(id);
      } else {
        const id = resolve(op.nodeId), n = m.nodes[id];
        if (op.type === 'update_node') { n.text = op.text; focus.push(id); }
        if (op.type === 'reparent_node') {
          const parent = resolve(op.parentId);
          if (id === m.root || subtree(m, id).has(parent)) fail(tr('ops.badReparent'));
          if (n.parent !== parent) { n.parent = parent; n.order = ++m.seq; }
        }
        if (op.type === 'swap_nodes') { swap(m, id, resolve(op.otherId)); focus.push(id); }
        if (op.type === 'delete_node') {
          if (id === m.root) fail(tr('delete.root'));
          const ids = op.scope === 'subtree' ? [...subtree(m, id)] : [id];
          deletions.push({ name: n.text, scope: op.scope, count: ids.length, names: ids.map(key => m.nodes[key].text) }); focus.push(n.parent);
          if (op.scope === 'single') {
            const siblings = children(m, n.parent).flatMap(s => s.id === id ? children(m, id) : [s]);
            for (const child of children(m, id)) child.parent = n.parent;
            for (const child of siblings) child.order = ++m.seq;
          }
          for (const key of ids) delete m.nodes[key];
        }
      }
      if (!valid(m)) fail(tr('ops.badResult'));
    }
    if (Object.keys(m.nodes).length > 500) fail(tr('ops.tooManyNodes'));
    const counts = diff(before, m), changed = Object.values(counts).some(Boolean);
    return { map: changed ? m : serialize(before), counts, changed, deletions, focusId: focus.reverse().find(id => own(m.nodes, id)) || m.root };
  }
  function validateInput(input) {
    if (!exact(input, ['requestId', 'clientSessionId', 'mapSessionId', 'baseRevision', 'prompt', 'selectedNodeId', 'map']) ||
        !['requestId', 'clientSessionId', 'mapSessionId'].every(k => identifier(input[k])) || !Number.isSafeInteger(input.baseRevision) || input.baseRevision < 0 ||
        typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 4000) fail(tr('ops.promptLength'));
    if (!valid(input.map) || Object.keys(input.map.nodes).length > 500) fail(tr('ops.badMap'));
    if (input.selectedNodeId !== null && (typeof input.selectedNodeId !== 'string' || !own(input.map.nodes, input.selectedNodeId))) fail(tr('ops.missingSelection'));
    return input;
  }
  const str = { type: 'string', minLength: 1, maxLength: 160 };
  const schemas = Object.entries(fields).map(([type, keys]) => ({ type: 'object', additionalProperties: false, required: keys, properties: Object.fromEntries(keys.map(k => [k, k === 'type' ? { type: 'string', enum: [type] } : k === 'scope' ? { type: 'string', enum: ['single', 'subtree'] } : k === 'text' ? { type: 'string', minLength: 1, maxLength: 4000 } : str])) }));
  const outputSchema = { type: 'object', additionalProperties: false, required: ['status', 'message', 'operations'], properties: { status: { type: 'string', enum: ['ok', 'needs_input', 'no_change'] }, message: { type: 'string', maxLength: 1000 }, operations: { type: 'array', maxItems: 100, items: { anyOf: schemas } } } };
  return { valid, serialize, place, addNode, swap, validateProposal, prepare, diff, summary, validateInput, outputSchema };
});
