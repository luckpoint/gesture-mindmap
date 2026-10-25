// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services } = context;
  const treeIndex = services.MapTree.create();
  const invalidateTree = () => treeIndex.invalidate();
  const treeInfo = () => treeIndex.info(state.map);
  const childrenOf = id => treeIndex.children(state.map, id);
  const subtree = id => treeIndex.subtree(state.map, id);
  const branchColor = id => treeIndex.branchColor(state.map, id);
  const depth = id => treeIndex.depth(state.map, id);
  function nodeSize(n) {
    const el = elements.nodeEls.get(n.id);
    return el
      ? { w: el.offsetWidth, h: el.offsetHeight }
      : n.image
        ? { w: 208, h: 160 }
        : { w: Math.min(260, n.text.length * 18 + 40), h: 52 };
  }
  function place(pid, w = 160) {
    return services.InstructionOperations.place(state.map, pid, w, operations.nodeSize);
  }
  function addNode(pid, text, pos) {
    const id = services.InstructionOperations.addNode(state.map, pid, text, pos, operations.nodeSize);
    operations.invalidateTree();
    return id;
  }
  return {
    treeIndex,
    invalidateTree,
    treeInfo,
    childrenOf,
    subtree,
    branchColor,
    depth,
    nodeSize,
    place,
    addNode,
  };
}
export { create };
