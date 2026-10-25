$('#title').value = state.map.title;
function updateViewport() {
  const viewport = globalThis.visualViewport;
  const kb = viewport ? Math.max(0, innerHeight - viewport.height - viewport.offsetTop) : 0;
  document.body.style.setProperty('--kb', kb + 'px');
  document.body.classList.toggle('keyboard-open', kb > 80);
  resizePrompt();
}
globalThis.visualViewport?.addEventListener('resize', updateViewport);
globalThis.visualViewport?.addEventListener('scroll', updateViewport);
addEventListener('resize', updateViewport);
if (typeof ResizeObserver !== 'undefined') new ResizeObserver(resizeNotices).observe($('.topbar'));
addEventListener('pagehide', cancelInstruction);
updateViewport();
void checkCodexStatus();
state.view = centerOn(state.map.nodes[state.map.root], 1);
state.view.y -= 20;
render();
applyView();
void (async () => {
  try {
    const rxdb = await import('../vendor/rxdb.js');
    state.library = await MapLibrary.open({
      createRxDatabase: rxdb.createRxDatabase,
      storage: rxdb.getRxStorageDexie(),
    });
  } catch (error) {
    console.error(error);
    state.mapClaim = { editable: true, release() {} };
    updateAccess();
    setSave('error');
    toast(tr('save.unsupportedExport'));
    return;
  }
  try {
    await state.library.migrateLegacy(localStorage);
  } catch (error) {
    console.error('Migration failed', error);
  }
  try {
    const moved = await imageStore.migrate(NodeImageStore.indexedDBLegacy());
    if (moved?.broken) console.warn(`Skipped ${moved.broken} broken images`);
  } catch (error) {
    console.error('Image migration failed', error);
  }
  navigator.storage?.persist?.().catch(() => {});
  let last = null;
  try {
    last = localStorage.getItem(LAST_KEY);
  } catch {}
  try {
    if (last && (await state.library.load(last))) await openMap(last);
    else await openFallback();
  } catch (error) {
    failOpen(error);
  }
  let skew = 0;
  try {
    if (localStorage.getItem(GC_SKEW_KEY)) skew = NodeImageStore.DAY;
    localStorage.removeItem(GC_SKEW_KEY);
  } catch {}
  cleanImages(Date.now() + skew).catch(error => console.error('Image cleanup failed', error));
  state.library.watchList(list => {
    mapList = list;
    if (!$('#mapsMenu').hidden) void refreshMapsMenu();
    else renderMapList();
  });
  $('#mapsBtn').disabled = false;
})();
