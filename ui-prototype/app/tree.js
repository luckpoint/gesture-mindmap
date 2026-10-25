let treeCache = null;
function invalidateTree() {
  treeCache = null;
}
function treeInfo() {
  if (treeCache?.map === state.map) return treeCache;
  const children = new Map(),
    colors = new Map([[state.map.root, 'var(--color-ink)']]),
    depths = new Map([[state.map.root, 0]]);
  for (const n of Object.values(state.map.nodes)) {
    if (!children.has(n.parent)) children.set(n.parent, []);
    children.get(n.parent).push(n);
  }
  for (const list of children.values()) list.sort((a, b) => a.order - b.order);
  const roots = children.get(state.map.root) || [],
    queue = [state.map.root];
  roots.forEach((n, i) => colors.set(n.id, `var(--branch-${(i % 6) + 1})`));
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const child of children.get(id) || []) {
      depths.set(child.id, depths.get(id) + 1);
      if (id !== state.map.root) colors.set(child.id, colors.get(id));
      queue.push(child.id);
    }
  }
  return (treeCache = { map: state.map, children, colors, depths });
}
const childrenOf = id => treeInfo().children.get(id) || [];
function subtree(id) {
  const out = new Set([id]);
  for (const n of Object.values(state.map.nodes)) {
    let cur = n;
    while (cur && cur.parent != null) {
      if (cur.parent === id) {
        out.add(n.id);
        break;
      }
      cur = state.map.nodes[cur.parent];
    }
  }
  return out;
}
function branchColor(id) {
  return treeInfo().colors.get(id);
}
function depth(id) {
  return treeInfo().depths.get(id);
}
function nodeSize(n) {
  const el = nodeEls.get(n.id);
  return el
    ? { w: el.offsetWidth, h: el.offsetHeight }
    : n.image
      ? { w: 208, h: 160 }
      : { w: Math.min(260, n.text.length * 18 + 40), h: 52 };
}
function place(pid, w = 160) {
  return InstructionOperations.place(state.map, pid, w, nodeSize);
}
function addNode(pid, text, pos) {
  const id = InstructionOperations.addNode(state.map, pid, text, pos, nodeSize);
  invalidateTree();
  return id;
}
