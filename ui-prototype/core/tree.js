/* DOM-free application core. Dependencies are supplied by the caller. */
function create() {
  let treeCache = null;
  function invalidateTree() {
    treeCache = null;
  }
  function treeInfo(map) {
    if (treeCache?.map === map) return treeCache;
    const children = new Map(),
      colors = new Map([[map.root, 'var(--color-ink)']]),
      depths = new Map([[map.root, 0]]);
    for (const n of Object.values(map.nodes)) {
      if (!children.has(n.parent)) children.set(n.parent, []);
      children.get(n.parent).push(n);
    }
    for (const list of children.values()) list.sort((a, b) => a.order - b.order);
    const roots = children.get(map.root) || [],
      queue = [map.root];
    roots.forEach((n, i) => colors.set(n.id, `var(--branch-${(i % 6) + 1})`));
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      for (const child of children.get(id) || []) {
        depths.set(child.id, depths.get(id) + 1);
        if (id !== map.root) colors.set(child.id, colors.get(id));
        queue.push(child.id);
      }
    }
    return (treeCache = { map, children, colors, depths });
  }
  const childrenOf = (map, id) => treeInfo(map).children.get(id) || [];
  function subtree(map, id) {
    const out = new Set([id]);
    for (const n of Object.values(map.nodes)) {
      let cur = n;
      while (cur && cur.parent != null) {
        if (cur.parent === id) {
          out.add(n.id);
          break;
        }
        cur = map.nodes[cur.parent];
      }
    }
    return out;
  }
  function branchColor(map, id) {
    return treeInfo(map).colors.get(id);
  }
  function depth(map, id) {
    return treeInfo(map).depths.get(id);
  }

  return { invalidate: invalidateTree, info: treeInfo, children: childrenOf, subtree, branchColor, depth };
}
export { create };
