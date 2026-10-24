/* Edit history as per-node diffs: { seq, prev, at, before, after }, sides being { meta, nodes } with null for absent nodes. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapHistory = api;
})(globalThis, () => {
  'use strict';
  const clone = v => JSON.parse(JSON.stringify(v));
  const canonical = v => v !== null && typeof v === 'object'
    ? Array.isArray(v) ? '[' + v.map(canonical).join(',') + ']' : '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}'
    : JSON.stringify(v ?? null);
  const same = (a, b) => canonical(a) === canonical(b);
  const node = (m, id) => Object.hasOwn(m.nodes, id) ? m.nodes[id] : null;
  function diff(before, after) {
    const out = { before: { meta: {}, nodes: {} }, after: { meta: {}, nodes: {} } };
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (k !== 'nodes' && !same(before[k], after[k])) { out.before.meta[k] = clone(before[k] ?? null); out.after.meta[k] = clone(after[k] ?? null); }
    }
    for (const id of new Set([...Object.keys(before.nodes), ...Object.keys(after.nodes)])) {
      const a = node(before, id), b = node(after, id);
      if (!same(a, b)) { out.before.nodes[id] = clone(a); out.after.nodes[id] = clone(b); }
    }
    return out;
  }
  function apply(map, entry, side) {
    const m = clone(map), change = entry[side];
    Object.assign(m, clone(change.meta));
    for (const [id, n] of Object.entries(change.nodes)) n === null ? delete m.nodes[id] : m.nodes[id] = clone(n);
    return m;
  }
  function matches(map, change) {
    return Object.entries(change.meta).every(([k, v]) => same(map[k], v)) && Object.entries(change.nodes).every(([id, n]) => same(node(map, id), n));
  }
  // The map document is the truth. Keep only the entries that chain back from
  // and forward from it consistently; everything else is reported as discard.
  function verify(map, cursor, entries) {
    const bySeq = new Map(entries.map(e => [e.seq, e])), undo = [], redo = [];
    let state = map, at = cursor;
    for (let e = bySeq.get(at); e && e.prev < e.seq && matches(state, e.after); e = bySeq.get(at)) {
      undo.unshift(e); state = apply(state, e, 'before'); at = e.prev;
    }
    state = map; at = cursor;
    for (;;) {
      const next = entries.filter(e => e.prev === at && e.seq > at).sort((a, b) => b.seq - a.seq)[0];
      if (!next || !matches(state, next.before)) break;
      redo.push(next); state = apply(state, next, 'after'); at = next.seq;
    }
    const kept = new Set([...undo, ...redo].map(e => e.seq));
    return { undo, redo, discard: entries.filter(e => !kept.has(e.seq)).map(e => e.seq) };
  }
  function references(entry) {
    return [entry.before, entry.after].flatMap(side => Object.values(side.nodes)).filter(n => n?.image).map(n => n.image.assetId);
  }
  return { diff, apply, matches, verify, references, same };
});
