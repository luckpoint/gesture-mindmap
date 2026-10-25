function select(id) {
  if (state.selectedId !== id) palette?.selectionChanged();
  state.selectedId = id;
  render();
}
function startEdit(id, isNew = false, atEnd = false) {
  if (refuseReadOnly()) return;
  if (state.editing?.id === id) return;
  if (state.editing) finishEdit();
  if (!state.map.nodes[id]) return;
  interruptHand();
  state.editing = { id, isNew, orig: state.map.nodes[id].text, pid: state.map.nodes[id].parent };
  state.selectedId = id;
  render();
  const t = nodeEls.get(id).nodeText;
  t.dataset.placeholder = tr('node.placeholder');
  t.contentEditable = 'plaintext-only';
  t.focus();
  const r = document.createRange();
  r.selectNodeContents(t);
  if (atEnd) r.collapse(false);
  getSelection().removeAllRanges();
  getSelection().addRange(r);
  speechMessage = '';
  updateSpeech();
}
function finishEdit() {
  if (!state.editing) return;
  speech.abort();
  const { id, isNew, orig, pid } = state.editing;
  state.editing = null;
  updateSpeech();
  const t = nodeEls.get(id)?.nodeText;
  let text = (t?.textContent || '').trim();
  if (text) {
    const candidate = serializeMap();
    candidate.nodes[id].text = text;
    const error = NodeImageFormat.mapError(candidate);
    if (error) {
      toast(error);
      text = orig;
      if (t) t.textContent = orig;
    }
  }
  if (t) t.contentEditable = 'false';
  if (isNew) {
    // The add was recorded with empty text; fold the typed text into it, or drop it.
    const added = state.history.pop();
    forget([added]);
    const before = MapHistory.apply(state.map, added, 'before');
    if (!text) {
      state.map = before;
      state.selectedId = pid;
    } else {
      state.map.nodes[id].text = text;
      record(JSON.stringify(before));
    }
    changed();
  } else if (text && text !== orig) {
    commit(() => {
      state.map.nodes[id].text = text;
    });
  } else {
    if (t) t.textContent = orig;
    render();
  }
}
function cancelEdit() {
  if (!state.editing) return;
  nodeEls.get(state.editing.id).nodeText.textContent = state.editing.isNew ? '' : state.editing.orig;
  finishEdit();
}
function addChildAndEdit(pid, handInput = false) {
  if (refuseReadOnly()) return;
  if (state.editing) finishEdit();
  if (!state.map.nodes[pid]) pid = state.map.root;
  let id;
  if (
    !commit(() => {
      id = addNode(pid, '');
    })
  )
    return;
  ensureVisible(state.map.nodes[id]);
  startEdit(id, true);
  if (handInput) {
    state.editing.handInput = true;
    updateSpeech();
    if (speech.supported) startNodeSpeech();
  }
}
function addSiblingAndEdit() {
  const n = state.map.nodes[state.selectedId];
  addChildAndEdit(!n || n.parent == null ? state.map.root : n.parent);
}
function removeNode(id) {
  if (!state.map.nodes[id]) return;
  if (id === state.map.root) {
    toast(tr('delete.root'));
    return;
  }
  if (refuseReadOnly()) return;
  interruptHand();
  if (state.editing) finishEdit();
  if (!state.map.nodes[id]) return;
  if (state.mode) endReparent();
  const ids = [...subtree(id)],
    children = childrenOf(id).map(n => n.id);
  state.deletion = {
    id,
    ids,
    children,
    parent: state.map.nodes[id].parent,
    scope: children.length ? null : 'single',
    snapshot: JSON.stringify(state.map),
  };
  $('#deleteTitle').textContent = tr('delete.title', state.map.nodes[id].text);
  $('#deleteDescription').textContent = tr(children.length ? 'delete.choose' : 'delete.only');
  $('#deleteOptions').hidden = !children.length;
  $('#deleteSingle').checked = false;
  $('#deleteBranch').checked = false;
  $('#deleteSingleDetail').textContent = tr(
    'delete.singleDetail',
    children.length,
    state.map.nodes[state.deletion.parent].text,
  );
  $('#deleteBranchDetail').textContent = tr('delete.branchDetail', ids.length);
  updateDeletePreview();
  if (!$('#deleteDialog').open) $('#deleteDialog').showModal();
  $('#deleteCancel').focus();
  render();
}
function chooseDeleteScope(scope) {
  if (!state.deletion || !['single', 'branch'].includes(scope)) return;
  state.deletion.scope = scope;
  $('#deleteSingle').checked = scope === 'single';
  $('#deleteBranch').checked = scope === 'branch';
  updateDeletePreview();
  render();
}
function updateDeletePreview() {
  const d = state.deletion;
  $('#deleteConfirm').disabled = !d?.scope;
  $('#deleteConfirm').textContent =
    d?.scope === 'branch'
      ? tr('delete.branchConfirm', d.ids.length)
      : tr(d?.scope ? 'delete.singleConfirm' : 'common.delete');
  $('#deletePreview').textContent = !d?.scope
    ? tr('delete.previewEmpty')
    : d.scope === 'branch'
      ? tr('delete.previewBranch', state.map.nodes[d.id].text, d.ids.length, state.map.nodes[d.parent].text)
      : d.children.length
        ? tr(
            'delete.previewReconnect',
            state.map.nodes[d.parent].text,
            d.children.map(id => state.map.nodes[id].text),
          )
        : tr('delete.previewSingle');
}
function closeDelete() {
  if (!state.deletion) return;
  state.deletion = null;
  $('#deleteDialog').close();
  interruptHand();
  render();
  viewportEl.focus({ preventScroll: true });
}
function confirmDelete() {
  const d = state.deletion;
  if (!d?.scope) return;
  if (JSON.stringify(state.map) !== d.snapshot) {
    const id = d.id;
    closeDelete();
    if (state.map.nodes[id]) removeNode(id);
    toast(tr('delete.changed'));
    return;
  }
  closeDelete();
  commit(() => {
    if (d.scope === 'branch') for (const id of d.ids) delete state.map.nodes[id];
    else {
      const siblings = childrenOf(d.parent).flatMap(n => (n.id === d.id ? d.children : [n.id]));
      for (const id of d.children) state.map.nodes[id].parent = d.parent;
      delete state.map.nodes[d.id];
      for (const id of siblings) state.map.nodes[id].order = ++state.map.seq;
    }
    invalidateTree();
    state.selectedId = d.parent;
  });
  toast(tr('delete.done'), tr('common.undo'), undo);
}
function deleteHandItems() {
  return [
    state.deletion?.children.length ? $('#deleteSingle') : null,
    state.deletion?.children.length ? $('#deleteBranch') : null,
    $('#deleteCancel'),
    !$('#deleteConfirm').disabled ? $('#deleteConfirm') : null,
  ].filter(Boolean);
}
function navigateDelete(step) {
  const items = deleteHandItems(),
    index = items.indexOf(document.activeElement);
  const target = items[Math.max(0, Math.min(items.length - 1, (index < 0 ? 0 : index) + step))];
  target.focus();
  if (target === $('#deleteSingle')) chooseDeleteScope('single');
  else if (target === $('#deleteBranch')) chooseDeleteScope('branch');
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
      const [a, b] = along(key, n.x - from.x, n.y - from.y);
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
  const out = branchKey(s.id),
    parent = state.map.nodes[s.parent];
  const angle = (n, origin) => {
    const [a, b] = along(out, n.x - origin.x, n.y - origin.y);
    return Math.atan2(b, a);
  };
  const ordered = origin =>
    [...childrenOf(origin.id)].sort(
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
    ? nearestInDirection(key, s, nodes)
    : ((s.id === state.map.root ? nearestInDirection(key, s, childrenOf(s.id)) : treeTarget(key, s)) ??
      nearestInDirection(key, s, Object.values(state.map.nodes)));
  if (best) {
    select(best);
    ensureVisible(state.map.nodes[best]);
  }
}
function nudge(key) {
  const id = state.selectedId || state.map.root;
  const [dx, dy] = { ArrowRight: [24, 0], ArrowLeft: [-24, 0], ArrowDown: [0, 24], ArrowUp: [0, -24] }[key];
  commit(() => {
    for (const d of subtree(id)) {
      state.map.nodes[d].x += dx;
      state.map.nodes[d].y += dy;
    }
  });
}

/* ---------- reparent ---------- */
function startReparent(id) {
  if (refuseReadOnly()) return;
  interruptHand();
  if (id === state.map.root) return;
  state.mode = { type: 'reparent', id, candidate: null, blocked: subtree(id) };
  $('#modeMsg').innerHTML = tr('reparent.where');
  $('#modeMsg b').textContent = state.map.nodes[id].text;
  $('#modeBanner').hidden = false;
  resizeNotices();
  $('#modeOk').disabled = true;
  render();
}
function endReparent() {
  state.mode = null;
  $('#modeBanner').hidden = true;
  resizeNotices();
  render();
}
function setCandidate(id) {
  if (!state.mode) return;
  if (state.mode.blocked.has(id)) id = null;
  if (state.mode.candidate === id) return;
  state.mode.candidate = id;
  $('#modeOk').disabled = !id;
  render();
}
function confirmReparent() {
  const { id, candidate } = state.mode;
  endReparent();
  if (!candidate || state.map.nodes[id].parent === candidate) return;
  commit(() => {
    state.map.nodes[id].parent = candidate;
    state.map.nodes[id].order = ++state.map.seq;
    invalidateTree();
  });
  state.selectedId = id;
  render();
  toast(tr('reparent.done'), tr('common.undo'), undo);
}
