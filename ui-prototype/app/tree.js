const treeIndex = MapTree.create();
const invalidateTree = () => treeIndex.invalidate();
const treeInfo = () => treeIndex.info(state.map);
const childrenOf = id => treeIndex.children(state.map, id);
const subtree = id => treeIndex.subtree(state.map, id);
const branchColor = id => treeIndex.branchColor(state.map, id);
const depth = id => treeIndex.depth(state.map, id);
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
