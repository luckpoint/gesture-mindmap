// Application dependencies are supplied per instance; evaluation has no screen effects.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindmapAppStartup = api;
})(globalThis, () => {
  'use strict';
  function create(context, operations) {
    const { state, services, environment, ui } = context;
    function updateViewport() {
      const viewport = environment.visualViewport;
      const kb = viewport ? Math.max(0, environment.innerHeight - viewport.height - viewport.offsetTop) : 0;
      environment.document.body.style.setProperty('--kb', kb + 'px');
      environment.document.body.classList.toggle('keyboard-open', kb > 80);
      operations.resizePrompt();
    }
    function start() {
      operations.$('#title').value = state.map.title;

      environment.visualViewport?.addEventListener('resize', updateViewport);
      environment.visualViewport?.addEventListener('scroll', updateViewport);
      environment.addEventListener('resize', updateViewport);
      if (typeof environment.ResizeObserver !== 'undefined')
        new environment.ResizeObserver(operations.resizeNotices).observe(operations.$('.topbar'));
      environment.addEventListener('pagehide', operations.cancelInstruction);
      updateViewport();
      void operations.checkCodexStatus();
      state.view = operations.centerOn(state.map.nodes[state.map.root], 1);
      state.view.y -= 20;
      operations.render();
      operations.applyView();

      return openLibrary();
    }
    async function openLibrary() {
      try {
        const rxdb = await services.loadRxdb();
        state.library = await services.MapLibrary.open({
          createRxDatabase: rxdb.createRxDatabase,
          storage: rxdb.getRxStorageDexie(),
        });
      } catch (error) {
        console.error(error);
        state.mapClaim = { editable: true, release() {} };
        operations.updateAccess();
        operations.setSave('error');
        operations.toast(services.tr('save.unsupportedExport'));
        return;
      }
      try {
        await state.library.migrateLegacy(environment.localStorage);
      } catch (error) {
        console.error('Migration failed', error);
      }
      try {
        const moved = await services.imageStore.migrate(services.NodeImageStore.indexedDBLegacy());
        if (moved?.broken) console.warn(`Skipped ${moved.broken} broken images`);
      } catch (error) {
        console.error('Image migration failed', error);
      }
      environment.navigator.storage?.persist?.().catch(() => {});
      let last = null;
      try {
        last = environment.localStorage.getItem(operations.LAST_KEY);
      } catch {}
      try {
        if (last && (await state.library.load(last))) await operations.openMap(last);
        else await operations.openFallback();
      } catch (error) {
        operations.failOpen(error);
      }
      let skew = 0;
      try {
        if (environment.localStorage.getItem(operations.GC_SKEW_KEY)) skew = services.NodeImageStore.DAY;
        environment.localStorage.removeItem(operations.GC_SKEW_KEY);
      } catch {}
      operations.cleanImages(Date.now() + skew).catch(error => console.error('Image cleanup failed', error));
      state.library.watchList(list => {
        ui.mapList = list;
        if (!operations.$('#mapsMenu').hidden) void operations.refreshMapsMenu();
        else operations.renderMapList();
      });
      operations.$('#mapsBtn').disabled = false;
    }
    return { start };
  }
  return { create };
});
