function storeView() {
  clearTimeout(viewTimer);
  if (state.mapId)
    try {
      localStorage.setItem(VIEW_KEY + state.mapId, JSON.stringify(state.view));
    } catch {}
}
function storedView(id) {
  try {
    const v = JSON.parse(localStorage.getItem(VIEW_KEY + id));
    if ([v.x, v.y, v.s].every(Number.isFinite)) return clampView({ x: v.x, y: v.y, s: clamp(v.s, ZMIN, ZMAX) }, false);
  } catch {}
  return null;
}
function useLog(m, log) {
  const { undo, redo, discard } = MapHistory.verify(m, log.cursor, log.entries);
  state.history = undo;
  state.future = redo.reverse();
  unsaved = new Map();
  dropped = new Set(discard);
  lastSeq = log.entries.reduce((max, e) => Math.max(max, e.seq), 0);
}
function showMap(id, m, claim, log = { cursor: 0, entries: [] }) {
  speech.abort();
  stopWatch?.();
  stopWatch = null;
  autosave.reset();
  state.map = m;
  state.mapId = id;
  state.mapClaim = claim;
  state.selectedId = compact.matches ? null : state.map.root;
  useLog(m, log);
  invalidateTree();
  state.mapSessionId = InstructionTransport.id('map_');
  state.revision++;
  state.historyToken++;
  endStaleInstruction();
  try {
    localStorage.setItem(LAST_KEY, id);
  } catch {}
  if (!claim.editable) stopWatch = state.library.watch(id, showRemote);
  $('#title').value = state.map.title;
  // A bundle can repair the same asset ID while an earlier read/decode is
  // still pending. Drop all old states so late failures cannot hide it.
  for (const el of nodeEls.values()) clearNodeImage(el);
  render();
  const stored = storedView(id);
  if (stored && !compact.matches) {
    animId++;
    state.view = stored;
    applyView();
  } else fitAll();
  setSave('saved');
  updateAccess();
  renderMapList();
}
function showRemote(m) {
  if (!readOnly() || state.switching) return;
  if (!m) {
    state.mapClaim.release();
    state.mapClaim = { editable: false, release() {} };
    toast(tr('maps.deletedElsewhere'));
    void openFallback().catch(failOpen);
    return;
  }
  state.map = m;
  invalidateTree();
  state.revision++;
  if (!state.map.nodes[state.selectedId]) state.selectedId = null;
  $('#title').value = state.map.title;
  render();
}
async function grantEdit(id) {
  const [m, log] = await Promise.all([state.library.load(id), state.library.log(id)]);
  if (id !== state.mapId || !state.mapClaim.editable || state.switching) return;
  stopWatch?.();
  stopWatch = null;
  if (m) {
    state.map = m;
    useLog(m, log);
    invalidateTree();
    state.revision++;
    if (!state.map.nodes[state.selectedId]) state.selectedId = state.map.root;
    $('#title').value = state.map.title;
    render();
  }
  setSave('saved');
  updateAccess();
  renderMapList();
  toast(tr('maps.editable'));
}
async function openMap(id) {
  const claim = await MapLocks.claim(id, {
    granted: () => {
      void grantEdit(id);
    },
  });
  try {
    const [m, log] = await Promise.all([state.library.load(id), claim.editable ? state.library.log(id) : undefined]);
    if (!m) throw new Error(tr('maps.loadFailed'));
    showMap(id, m, claim, log);
  } catch (error) {
    claim.release();
    throw error;
  }
}
async function openFallback() {
  const [first] = await state.library.list();
  await openMap(first?.id ?? (await state.library.create(sample())));
}
function failOpen(error) {
  console.error(error);
  toast(tr('maps.openFailed'));
}
async function leaveMap() {
  if (!OperationPolicy.canLeaveMap(operationState())) throw new Error(tr('maps.finishBeforeSwitch'));
  const base = state.revision;
  if (!readOnly()) await flushSave();
  if (autosave.dirty || state.revision !== base) throw new Error(tr('maps.changedNoSwitch'));
  storeView();
  stopWatch?.();
  stopWatch = null;
  state.mapClaim.release();
  state.mapClaim = { editable: false, release() {} };
}
async function switchMap(target) {
  if (!state.library) throw new Error(tr('save.unsupported'));
  if (state.switching) throw new Error(tr('maps.switching'));
  state.switching = true;
  const previous = state.mapId;
  try {
    await leaveMap();
    try {
      await openMap(typeof target === 'function' ? await target() : target);
    } catch (error) {
      await openMap(previous).catch(failOpen);
      throw error;
    }
  } finally {
    state.switching = false;
  }
}
async function deleteMap(id) {
  if (id !== state.mapId) {
    const claim = await MapLocks.claim(id, { wait: false });
    if (!claim.editable) throw new Error(tr('maps.cantDeleteEditing'));
    try {
      await state.library.remove(id);
    } finally {
      claim.release();
    }
  } else {
    if (readOnly()) throw new Error(tr('maps.cantDeleteEditing'));
    if (!OperationPolicy.canLeaveMap(operationState())) throw new Error(tr('maps.finishBeforeDelete'));
    if (state.switching) throw new Error(tr('maps.switching'));
    state.switching = true;
    try {
      const dirty = await autosave.suspend();
      try {
        await state.library.remove(id);
      } catch (error) {
        if (dirty) scheduleSave();
        throw error;
      }
      state.mapClaim.release();
      state.mapClaim = { editable: false, release() {} };
      await openFallback().catch(failOpen);
    } finally {
      state.switching = false;
    }
  }
  try {
    localStorage.removeItem(VIEW_KEY + id);
  } catch {}
}
async function cleanImages(now) {
  const locks = globalThis.navigator?.locks;
  if (!locks) return;
  await locks.request('mindmap:gc', { ifAvailable: true }, async lock => {
    if (!lock || (await MapLocks.others(readOnly() ? null : state.mapId))) return;
    const refs = new Set(),
      add = m => {
        for (const n of Object.values(m?.nodes || {})) if (n.image) refs.add(n.image.assetId);
      };
    add(state.map);
    for (const e of [...state.history, ...state.future]) MapHistory.references(e).forEach(id => refs.add(id));
    for (const { id } of await state.library.list()) {
      add(await state.library.load(id));
      for (const e of (await state.library.log(id)).entries) MapHistory.references(e).forEach(ref => refs.add(ref));
    }
    const removed = await imageStore.gc(refs, now);
    if (removed) console.info(`Removed ${removed} unused images`);
  });
}
let mapList = [],
  busyMaps = new Set(),
  mapSizes = new Map(),
  imageBytes = null;
const editedElsewhere = id => busyMaps.has(id) && (id !== state.mapId || readOnly());
const formatBytes = n =>
  n < 1024 ? n + ' B' : n < 1024 ** 2 ? Math.round(n / 1024) + ' KB' : (n / 1024 ** 2).toFixed(1) + ' MB';
function ago(t, now = Date.now()) {
  const min = Math.floor((now - t) / 60000);
  if (min < 1) return tr('time.now');
  if (min < 60) return tr('time.minutes', min);
  if (min < 24 * 60) return tr('time.hours', Math.floor(min / 60));
  if (min < 7 * 24 * 60) return tr('time.days', Math.floor(min / (24 * 60)));
  return new Date(t).toLocaleDateString(I18n.lang, { month: 'numeric', day: 'numeric' });
}
function renderMapList() {
  const list = $('#mapsList');
  list.replaceChildren(
    ...mapList.map(m => {
      const row = Object.assign(document.createElement('li'), {
        className: 'maps__row' + (m.id === state.mapId ? ' maps__row--current' : ''),
      });
      const open = Object.assign(document.createElement('button'), {
        className: 'btn maps__open',
        title: tr('maps.updated', new Date(m.updatedAt).toLocaleString(I18n.lang)),
      });
      open.dataset.open = m.id;
      open.setAttribute('aria-current', m.id === state.mapId);
      const size = mapSizes.get(m.id);
      const name = Object.assign(document.createElement('span'), {
        className: 'maps__name',
        textContent: m.title || tr('maps.untitled'),
      });
      const bytes = Object.assign(document.createElement('span'), {
        className: 'maps__size',
        textContent: size ? formatBytes(size.bytes) : '—',
      });
      const meta = Object.assign(document.createElement('span'), {
        className: 'maps__meta',
        textContent: [
          ago(m.updatedAt),
          size?.images && tr('maps.images', size.images),
          editedElsewhere(m.id) && tr('maps.editedElsewhere'),
        ]
          .filter(Boolean)
          .join(' · '),
      });
      open.append(name, bytes, meta);
      const remove = Object.assign(document.createElement('button'), {
        className: 'btn btn--icon maps__remove',
        innerHTML: '<svg class="i"><use href="#i-trash"/></svg>',
      });
      remove.dataset.remove = m.id;
      remove.disabled = editedElsewhere(m.id);
      remove.setAttribute('aria-label', tr('maps.deleteLabel', m.title || tr('maps.untitled')));
      row.append(open, remove);
      return row;
    }),
  );
  $('#mapsUsage').hidden = imageBytes === null;
  if (imageBytes === null) return;
  $('#mapsUsageText').textContent = `${formatBytes(imageBytes)} / ${formatBytes(NodeImageFormat.MAX_TOTAL)}`;
  $('#mapsUsageBar').style.width = Math.min(100, (imageBytes / NodeImageFormat.MAX_TOTAL) * 100) + '%';
}
async function measureMaps() {
  try {
    const files = await imageStore.files(),
      fileSize = id => files.get(id)?.size || 0;
    const stats = await Promise.all(mapList.map(async m => [m.id, await state.library.stats(m.id)]));
    mapSizes = new Map(
      stats
        .filter(([, s]) => s)
        .map(([id, s]) => [id, { bytes: s.bytes + s.assets.reduce((n, a) => n + fileSize(a), 0), images: s.images }]),
    );
    imageBytes = [...files.values()].reduce((n, f) => n + f.size, 0);
  } catch {
    mapSizes = new Map();
    imageBytes = null;
  }
}
async function refreshMapsMenu() {
  const [busy] = await Promise.all([MapLocks.busy().catch(() => new Set()), measureMaps()]);
  busyMaps = busy;
  renderMapList();
}
function toggleMapsMenu(open) {
  $('#mapsMenu').hidden = !open;
  $('#mapsBtn').setAttribute('aria-expanded', open);
  if (open) void refreshMapsMenu();
}
let mapDeleting = null;
function confirmMapDelete(id) {
  const m = mapList.find(item => item.id === id);
  if (!m) return;
  mapDeleting = id;
  $('#mapDeleteTitle').textContent = tr('delete.title', m.title || tr('maps.untitled'));
  $('#mapDeleteDialog').showModal();
}
