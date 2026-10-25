// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services, environment, ui } = context;
  function select(id) {
    if (state.selectedId !== id) ui.palette?.selectionChanged();
    state.selectedId = id;
    operations.render();
  }
  function startEdit(id, isNew = false, atEnd = false) {
    if (operations.refuseReadOnly()) return;
    if (state.editing?.id === id) return;
    if (state.editing) operations.finishEdit();
    if (!state.map.nodes[id]) return;
    operations.interruptHand();
    state.editing = { id, isNew, orig: state.map.nodes[id].text, pid: state.map.nodes[id].parent };
    state.selectedId = id;
    operations.render();
    const t = elements.nodeEls.get(id).nodeText;
    t.dataset.placeholder = services.tr('node.placeholder');
    t.contentEditable = 'plaintext-only';
    t.focus();
    const r = environment.document.createRange();
    r.selectNodeContents(t);
    if (atEnd) r.collapse(false);
    environment.getSelection().removeAllRanges();
    environment.getSelection().addRange(r);
    ui.speechMessage = '';
    operations.updateSpeech();
  }
  function finishEdit() {
    if (!state.editing) return;
    operations.speech.abort();
    const { id, isNew, orig, pid, before } = state.editing;
    state.editing = null;
    operations.updateSpeech();
    const t = elements.nodeEls.get(id)?.nodeText;
    const text = (t?.textContent || '').trim();
    if (t) t.contentEditable = 'false';
    if (isNew) {
      if (!text) state.selectedId = pid;
      operations.commit(
        () => {
          if (text) state.map.nodes[id].text = text;
          else operations.restoreMap(before);
        },
        { before },
      );
    } else if (text && text !== orig) {
      operations.commit(() => {
        state.map.nodes[id].text = text;
      });
    } else {
      if (t) t.textContent = orig;
      operations.render();
    }
  }
  function cancelEdit() {
    if (!state.editing) return;
    elements.nodeEls.get(state.editing.id).nodeText.textContent = state.editing.isNew ? '' : state.editing.orig;
    operations.finishEdit();
  }
  function addChildAndEdit(pid, handInput = false) {
    if (operations.refuseReadOnly()) return;
    if (state.editing) operations.finishEdit();
    if (!state.map.nodes[pid]) pid = state.map.root;
    const before = JSON.stringify(state.map);
    let id;
    if (
      !operations.commit(
        () => {
          id = operations.addNode(pid, '');
        },
        { preview: true },
      )
    )
      return;
    operations.ensureVisible(state.map.nodes[id]);
    operations.startEdit(id, true);
    state.editing.before = before;
    if (handInput) {
      state.editing.handInput = true;
      operations.updateSpeech();
      if (operations.speech.supported) operations.startNodeSpeech();
    }
  }
  function addSiblingAndEdit() {
    const n = state.map.nodes[state.selectedId];
    operations.addChildAndEdit(!n || n.parent == null ? state.map.root : n.parent);
  }
  function removeNode(id) {
    if (!state.map.nodes[id]) return;
    if (id === state.map.root) {
      operations.toast(services.tr('delete.root'));
      return;
    }
    if (operations.refuseReadOnly()) return;
    operations.interruptHand();
    if (state.editing) operations.finishEdit();
    if (!state.map.nodes[id]) return;
    if (state.mode) operations.endReparent();
    const ids = [...operations.subtree(id)],
      children = operations.childrenOf(id).map(n => n.id);
    state.deletion = {
      id,
      ids,
      children,
      parent: state.map.nodes[id].parent,
      scope: children.length ? null : 'single',
      snapshot: JSON.stringify(state.map),
    };
    operations.$('#deleteTitle').textContent = services.tr('delete.title', state.map.nodes[id].text);
    operations.$('#deleteDescription').textContent = services.tr(children.length ? 'delete.choose' : 'delete.only');
    operations.$('#deleteOptions').hidden = !children.length;
    operations.$('#deleteSingle').checked = false;
    operations.$('#deleteBranch').checked = false;
    operations.$('#deleteSingleDetail').textContent = services.tr(
      'delete.singleDetail',
      children.length,
      state.map.nodes[state.deletion.parent].text,
    );
    operations.$('#deleteBranchDetail').textContent = services.tr('delete.branchDetail', ids.length);
    operations.updateDeletePreview();
    if (!operations.$('#deleteDialog').open) operations.$('#deleteDialog').showModal();
    operations.$('#deleteCancel').focus();
    operations.render();
  }
  function chooseDeleteScope(scope) {
    if (!state.deletion || !['single', 'branch'].includes(scope)) return;
    state.deletion.scope = scope;
    operations.$('#deleteSingle').checked = scope === 'single';
    operations.$('#deleteBranch').checked = scope === 'branch';
    operations.updateDeletePreview();
    operations.render();
  }
  function updateDeletePreview() {
    const d = state.deletion;
    operations.$('#deleteConfirm').disabled = !d?.scope;
    operations.$('#deleteConfirm').textContent =
      d?.scope === 'branch'
        ? services.tr('delete.branchConfirm', d.ids.length)
        : services.tr(d?.scope ? 'delete.singleConfirm' : 'common.delete');
    operations.$('#deletePreview').textContent = !d?.scope
      ? services.tr('delete.previewEmpty')
      : d.scope === 'branch'
        ? services.tr('delete.previewBranch', state.map.nodes[d.id].text, d.ids.length, state.map.nodes[d.parent].text)
        : d.children.length
          ? services.tr(
              'delete.previewReconnect',
              state.map.nodes[d.parent].text,
              d.children.map(id => state.map.nodes[id].text),
            )
          : services.tr('delete.previewSingle');
  }
  function closeDelete() {
    if (!state.deletion) return;
    state.deletion = null;
    operations.$('#deleteDialog').close();
    operations.interruptHand();
    operations.render();
    elements.viewportEl.focus({ preventScroll: true });
  }
  function confirmDelete() {
    const d = state.deletion;
    if (!d?.scope) return;
    if (JSON.stringify(state.map) !== d.snapshot) {
      const id = d.id;
      operations.closeDelete();
      if (state.map.nodes[id]) operations.removeNode(id);
      operations.toast(services.tr('delete.changed'));
      return;
    }
    operations.closeDelete();
    operations.commit(() => {
      services.InstructionOperations.deleteNode(state.map, d.id, d.scope === 'branch' ? 'subtree' : 'single');
      operations.invalidateTree();
      state.selectedId = d.parent;
    });
    operations.toast(services.tr('delete.done'), services.tr('common.undo'), operations.undo);
  }
  function deleteHandItems() {
    return [
      state.deletion?.children.length ? operations.$('#deleteSingle') : null,
      state.deletion?.children.length ? operations.$('#deleteBranch') : null,
      operations.$('#deleteCancel'),
      !operations.$('#deleteConfirm').disabled ? operations.$('#deleteConfirm') : null,
    ].filter(Boolean);
  }
  function navigateDelete(step) {
    const items = operations.deleteHandItems(),
      index = items.indexOf(environment.document.activeElement);
    const target = items[Math.max(0, Math.min(items.length - 1, (index < 0 ? 0 : index) + step))];
    target.focus();
    if (target === operations.$('#deleteSingle')) operations.chooseDeleteScope('single');
    else if (target === operations.$('#deleteBranch')) operations.chooseDeleteScope('branch');
  }
  function relatives(id) {
    const parent = state.map.nodes[id].parent;
    return Object.values(state.map.nodes).filter(
      n => n.id === id || n.id === parent || n.parent === id || (parent != null && n.parent === parent),
    );
  }
  const along = (key, dx, dy) =>
    ({ ArrowRight: [dx, dy], ArrowLeft: [-dx, dy], ArrowDown: [dy, dx], ArrowUp: [-dy, dx] })[key];
  const opposite = { ArrowRight: 'ArrowLeft', ArrowLeft: 'ArrowRight', ArrowDown: 'ArrowUp', ArrowUp: 'ArrowDown' };
  function nearestInDirection(key, from, nodes, spreads = [1, 6]) {
    for (const spread of spreads) {
      let best = null,
        bs = Infinity;
      for (const n of nodes) {
        if (n.id === from.id) continue;
        const [a, b] = operations.along(key, n.x - from.x, n.y - from.y);
        if (a <= 10 || Math.abs(b) > a * spread) continue;
        const score = a + Math.abs(b) * 2;
        if (score < bs) {
          bs = score;
          best = n.id;
        }
      }
      if (best) return best;
    }
    return null;
  }
  function branchKey(id) {
    let n = state.map.nodes[id];
    while (state.map.nodes[n.parent].parent != null) n = state.map.nodes[n.parent];
    const root = state.map.nodes[state.map.root],
      dx = n.x - root.x,
      dy = n.y - root.y;
    return Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? 'ArrowLeft' : 'ArrowRight') : dy < 0 ? 'ArrowUp' : 'ArrowDown';
  }
  function treeTarget(key, s) {
    // Descendants inherit the root branch's axis even when the fan curves.
    const out = operations.branchKey(s.id),
      parent = state.map.nodes[s.parent];
    const angle = (n, origin) => {
      const [a, b] = operations.along(out, n.x - origin.x, n.y - origin.y);
      return Math.atan2(b, a);
    };
    const ordered = origin =>
      [...operations.childrenOf(origin.id)].sort(
        (a, b) =>
          angle(a, origin) - angle(b, origin) ||
          Math.hypot(a.x - origin.x, a.y - origin.y) - Math.hypot(b.x - origin.x, b.y - origin.y) ||
          (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      );
    if (key === opposite[out]) return parent.id;
    // Enter at the first endpoint every time, never a middle/remembered child.
    if (key === out) return ordered(s)[0]?.id ?? s.id;
    const siblings = ordered(parent);
    const step = key === 'ArrowDown' || key === 'ArrowRight' ? 1 : -1;
    // An endpoint or leaf must stop rather than fall through to spatial search.
    return siblings[siblings.indexOf(s) + step]?.id ?? s.id;
  }
  function navigate(key, nodes) {
    const s = state.map.nodes[state.selectedId] || state.map.nodes[state.map.root];
    const best = nodes
      ? operations.nearestInDirection(key, s, nodes)
      : ((s.id === state.map.root
          ? operations.nearestInDirection(key, s, operations.childrenOf(s.id))
          : operations.treeTarget(key, s)) ?? operations.nearestInDirection(key, s, Object.values(state.map.nodes)));
    if (best) {
      operations.select(best);
      operations.ensureVisible(state.map.nodes[best]);
    }
  }
  function nudge(key) {
    const id = state.selectedId || state.map.root;
    const [dx, dy] = { ArrowRight: [24, 0], ArrowLeft: [-24, 0], ArrowDown: [0, 24], ArrowUp: [0, -24] }[key];
    operations.commit(() => {
      for (const d of operations.subtree(id)) {
        state.map.nodes[d].x += dx;
        state.map.nodes[d].y += dy;
      }
    });
  }
  function startReparent(id) {
    if (operations.refuseReadOnly()) return;
    operations.interruptHand();
    if (id === state.map.root) return;
    state.mode = { type: 'reparent', id, candidate: null, blocked: operations.subtree(id) };
    operations.$('#modeMsg').innerHTML = services.tr('reparent.where');
    operations.$('#modeMsg b').textContent = state.map.nodes[id].text;
    operations.$('#modeBanner').hidden = false;
    operations.resizeNotices();
    operations.$('#modeOk').disabled = true;
    operations.render();
  }
  function endReparent() {
    state.mode = null;
    operations.$('#modeBanner').hidden = true;
    operations.resizeNotices();
    operations.render();
  }
  function setCandidate(id) {
    if (!state.mode) return;
    if (state.mode.blocked.has(id)) id = null;
    if (state.mode.candidate === id) return;
    state.mode.candidate = id;
    operations.$('#modeOk').disabled = !id;
    operations.render();
  }
  function confirmReparent() {
    const { id, candidate } = state.mode;
    operations.endReparent();
    if (!candidate || state.map.nodes[id].parent === candidate) return;
    operations.commit(() => {
      services.InstructionOperations.reparentNode(state.map, id, candidate);
      operations.invalidateTree();
    });
    state.selectedId = id;
    operations.render();
    operations.toast(services.tr('reparent.done'), services.tr('common.undo'), operations.undo);
  }
  return {
    select,
    startEdit,
    finishEdit,
    cancelEdit,
    addChildAndEdit,
    addSiblingAndEdit,
    removeNode,
    chooseDeleteScope,
    updateDeletePreview,
    closeDelete,
    confirmDelete,
    deleteHandItems,
    navigateDelete,
    relatives,
    along,
    opposite,
    nearestInDirection,
    branchKey,
    treeTarget,
    navigate,
    nudge,
    startReparent,
    endReparent,
    setCandidate,
    confirmReparent,
  };
}
export { create };
