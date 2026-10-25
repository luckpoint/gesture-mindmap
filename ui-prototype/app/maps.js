// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services, environment, ui } = context;
  function storeView() {
    context.timers.clear(context.timers.view);
    if (state.mapId)
      try {
        environment.localStorage.setItem(operations.VIEW_KEY + state.mapId, JSON.stringify(state.view));
      } catch {}
  }
  function storedView(id) {
    try {
      const v = JSON.parse(environment.localStorage.getItem(operations.VIEW_KEY + id));
      if ([v.x, v.y, v.s].every(Number.isFinite))
        return operations.clampView(
          { x: v.x, y: v.y, s: operations.clamp(v.s, operations.ZMIN, operations.ZMAX) },
          false,
        );
    } catch {}
    return null;
  }
  function useLog(m, log) {
    operations.editHistory.load(m, log);
  }
  function showMap(id, m, claim, log = { cursor: 0, entries: [] }) {
    operations.speech.abort();
    ui.stopWatch?.();
    ui.stopWatch = null;
    operations.autosave.reset();
    state.map = m;
    state.mapId = id;
    state.mapClaim = claim;
    state.selectedId = operations.compact.matches ? null : state.map.root;
    operations.useLog(m, log);
    operations.invalidateTree();
    state.mapSessionId = services.InstructionTransport.id('map_');
    state.revision++;
    state.historyToken++;
    operations.endStaleInstruction();
    try {
      environment.localStorage.setItem(operations.LAST_KEY, id);
    } catch {}
    if (!claim.editable) ui.stopWatch = state.library.watch(id, operations.showRemote);
    operations.$('#title').value = state.map.title;
    // A bundle can repair the same asset ID while an earlier read/decode is
    // still pending. Drop all old states so late failures cannot hide it.
    for (const el of elements.nodeEls.values()) operations.clearNodeImage(el);
    operations.render();
    const stored = operations.storedView(id);
    if (stored && !operations.compact.matches) {
      ui.animId++;
      state.view = stored;
      operations.applyView();
    } else operations.fitAll();
    operations.setSave('saved');
    operations.updateAccess();
    operations.renderMapList();
  }
  function showRemote(m) {
    if (!operations.readOnly() || state.switching) return;
    if (!m) {
      state.mapClaim.release();
      state.mapClaim = { editable: false, release() {} };
      operations.toast(services.tr('maps.deletedElsewhere'));
      void operations.openFallback().catch(operations.failOpen);
      return;
    }
    state.map = m;
    operations.invalidateTree();
    state.revision++;
    if (!state.map.nodes[state.selectedId]) state.selectedId = null;
    operations.$('#title').value = state.map.title;
    operations.render();
  }
  async function grantEdit(id) {
    const [m, log] = await Promise.all([state.library.load(id), state.library.log(id)]);
    if (id !== state.mapId || !state.mapClaim.editable || state.switching) return;
    ui.stopWatch?.();
    ui.stopWatch = null;
    if (m) {
      state.map = m;
      operations.useLog(m, log);
      operations.invalidateTree();
      state.revision++;
      if (!state.map.nodes[state.selectedId]) state.selectedId = state.map.root;
      operations.$('#title').value = state.map.title;
      operations.render();
    }
    operations.setSave('saved');
    operations.updateAccess();
    operations.renderMapList();
    operations.toast(services.tr('maps.editable'));
  }
  async function openMap(id) {
    const claim = await services.MapLocks.claim(id, {
      granted: () => {
        void operations.grantEdit(id);
      },
    });
    try {
      const [m, log] = await Promise.all([state.library.load(id), claim.editable ? state.library.log(id) : undefined]);
      if (!m) throw new Error(services.tr('maps.loadFailed'));
      operations.showMap(id, m, claim, log);
    } catch (error) {
      claim.release();
      throw error;
    }
  }
  async function openFallback() {
    const [first] = await state.library.list();
    await operations.openMap(first?.id ?? (await state.library.create(operations.sample())));
  }
  function failOpen(error) {
    console.error(error);
    operations.toast(services.tr('maps.openFailed'));
  }
  async function leaveMap() {
    if (!operations.OperationPolicy.canLeaveMap(operations.operationState()))
      throw new Error(services.tr('maps.finishBeforeSwitch'));
    const base = state.revision;
    if (!operations.readOnly()) await operations.flushSave();
    if (operations.autosave.dirty || state.revision !== base) throw new Error(services.tr('maps.changedNoSwitch'));
    operations.storeView();
    ui.stopWatch?.();
    ui.stopWatch = null;
    state.mapClaim.release();
    state.mapClaim = { editable: false, release() {} };
  }
  async function switchMap(target) {
    if (!state.library) throw new Error(services.tr('save.unsupported'));
    if (state.switching) throw new Error(services.tr('maps.switching'));
    state.switching = true;
    const previous = state.mapId;
    try {
      await operations.leaveMap();
      try {
        await operations.openMap(typeof target === 'function' ? await target() : target);
      } catch (error) {
        await operations.openMap(previous).catch(operations.failOpen);
        throw error;
      }
    } finally {
      state.switching = false;
    }
  }
  async function deleteMap(id) {
    if (id !== state.mapId) {
      const claim = await services.MapLocks.claim(id, { wait: false });
      if (!claim.editable) throw new Error(services.tr('maps.cantDeleteEditing'));
      try {
        await state.library.remove(id);
      } finally {
        claim.release();
      }
    } else {
      if (operations.readOnly()) throw new Error(services.tr('maps.cantDeleteEditing'));
      if (!operations.OperationPolicy.canLeaveMap(operations.operationState()))
        throw new Error(services.tr('maps.finishBeforeDelete'));
      if (state.switching) throw new Error(services.tr('maps.switching'));
      state.switching = true;
      try {
        const dirty = await operations.autosave.suspend();
        try {
          await state.library.remove(id);
        } catch (error) {
          if (dirty) operations.scheduleSave();
          throw error;
        }
        state.mapClaim.release();
        state.mapClaim = { editable: false, release() {} };
        await operations.openFallback().catch(operations.failOpen);
      } finally {
        state.switching = false;
      }
    }
    try {
      environment.localStorage.removeItem(operations.VIEW_KEY + id);
    } catch {}
  }
  async function cleanImages(now) {
    const locks = environment.navigator?.locks;
    if (!locks) return;
    await locks.request('mindmap:gc', { ifAvailable: true }, async lock => {
      if (!lock || (await services.MapLocks.others(operations.readOnly() ? null : state.mapId))) return;
      const refs = new Set(),
        add = m => {
          for (const n of Object.values(m?.nodes || {})) if (n.image) refs.add(n.image.assetId);
        };
      add(state.map);
      for (const e of [...state.history, ...state.future])
        services.MapHistory.references(e).forEach(id => refs.add(id));
      for (const { id } of await state.library.list()) {
        add(await state.library.load(id));
        for (const e of (await state.library.log(id)).entries)
          services.MapHistory.references(e).forEach(ref => refs.add(ref));
      }
      const removed = await services.imageStore.gc(refs, now);
      if (removed) console.info(`Removed ${removed} unused images`);
    });
  }
  ui.mapList = [];
  ui.busyMaps = new Set();
  ui.mapSizes = new Map();
  ui.imageBytes = null;
  const editedElsewhere = id => ui.busyMaps.has(id) && (id !== state.mapId || operations.readOnly());
  const formatBytes = n =>
    n < 1024 ? n + ' B' : n < 1024 ** 2 ? Math.round(n / 1024) + ' KB' : (n / 1024 ** 2).toFixed(1) + ' MB';
  function ago(t, now = Date.now()) {
    const min = Math.floor((now - t) / 60000);
    if (min < 1) return services.tr('time.now');
    if (min < 60) return services.tr('time.minutes', min);
    if (min < 24 * 60) return services.tr('time.hours', Math.floor(min / 60));
    if (min < 7 * 24 * 60) return services.tr('time.days', Math.floor(min / (24 * 60)));
    return new Date(t).toLocaleDateString(services.I18n.lang, { month: 'numeric', day: 'numeric' });
  }
  function renderMapList() {
    const list = operations.$('#mapsList');
    list.replaceChildren(
      ...ui.mapList.map(m => {
        const row = Object.assign(environment.document.createElement('li'), {
          className: 'maps__row' + (m.id === state.mapId ? ' maps__row--current' : ''),
        });
        const open = Object.assign(environment.document.createElement('button'), {
          className: 'btn maps__open',
          title: services.tr('maps.updated', new Date(m.updatedAt).toLocaleString(services.I18n.lang)),
        });
        open.dataset.open = m.id;
        open.setAttribute('aria-current', m.id === state.mapId);
        const size = ui.mapSizes.get(m.id);
        const name = Object.assign(environment.document.createElement('span'), {
          className: 'maps__name',
          textContent: m.title || services.tr('maps.untitled'),
        });
        const bytes = Object.assign(environment.document.createElement('span'), {
          className: 'maps__size',
          textContent: size ? operations.formatBytes(size.bytes) : '—',
        });
        const meta = Object.assign(environment.document.createElement('span'), {
          className: 'maps__meta',
          textContent: [
            operations.ago(m.updatedAt),
            size?.images && services.tr('maps.images', size.images),
            operations.editedElsewhere(m.id) && services.tr('maps.editedElsewhere'),
          ]
            .filter(Boolean)
            .join(' · '),
        });
        open.append(name, bytes, meta);
        const remove = Object.assign(environment.document.createElement('button'), {
          className: 'btn btn--icon maps__remove',
          innerHTML: '<svg class="i"><use href="#i-trash"/></svg>',
        });
        remove.dataset.remove = m.id;
        remove.disabled = operations.editedElsewhere(m.id);
        remove.setAttribute('aria-label', services.tr('maps.deleteLabel', m.title || services.tr('maps.untitled')));
        row.append(open, remove);
        return row;
      }),
    );
    operations.$('#mapsUsage').hidden = ui.imageBytes === null;
    if (ui.imageBytes === null) return;
    operations.$('#mapsUsageText').textContent =
      `${operations.formatBytes(ui.imageBytes)} / ${operations.formatBytes(services.NodeImageFormat.MAX_TOTAL)}`;
    operations.$('#mapsUsageBar').style.width =
      Math.min(100, (ui.imageBytes / services.NodeImageFormat.MAX_TOTAL) * 100) + '%';
  }
  async function measureMaps() {
    try {
      const files = await services.imageStore.files(),
        fileSize = id => files.get(id)?.size || 0;
      const stats = await Promise.all(ui.mapList.map(async m => [m.id, await state.library.stats(m.id)]));
      ui.mapSizes = new Map(
        stats
          .filter(([, s]) => s)
          .map(([id, s]) => [id, { bytes: s.bytes + s.assets.reduce((n, a) => n + fileSize(a), 0), images: s.images }]),
      );
      ui.imageBytes = [...files.values()].reduce((n, f) => n + f.size, 0);
    } catch {
      ui.mapSizes = new Map();
      ui.imageBytes = null;
    }
  }
  async function refreshMapsMenu() {
    const [busy] = await Promise.all([services.MapLocks.busy().catch(() => new Set()), operations.measureMaps()]);
    ui.busyMaps = busy;
    operations.renderMapList();
  }
  function toggleMapsMenu(open) {
    operations.$('#mapsMenu').hidden = !open;
    operations.$('#mapsBtn').setAttribute('aria-expanded', open);
    if (open) void operations.refreshMapsMenu();
  }
  ui.mapDeleting = null;
  function confirmMapDelete(id) {
    const m = ui.mapList.find(item => item.id === id);
    if (!m) return;
    ui.mapDeleting = id;
    operations.$('#mapDeleteTitle').textContent = services.tr('delete.title', m.title || services.tr('maps.untitled'));
    operations.$('#mapDeleteDialog').showModal();
  }
  return {
    storeView,
    storedView,
    useLog,
    showMap,
    showRemote,
    grantEdit,
    openMap,
    openFallback,
    failOpen,
    leaveMap,
    switchMap,
    deleteMap,
    cleanImages,
    editedElsewhere,
    formatBytes,
    ago,
    renderMapList,
    measureMaps,
    refreshMapsMenu,
    toggleMapsMenu,
    confirmMapDelete,
  };
}
export { create };
