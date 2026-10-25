function toast(msg, label, action) {
  const t = $('#toast');
  t.textContent = msg;
  if (label) {
    const b = Object.assign(document.createElement('button'), { className: 'btn', textContent: label });
    b.onclick = () => {
      action();
      t.hidden = true;
    };
    t.append(b);
  }
  t.hidden = false;
  appContext.timers.clear(appContext.timers.toast);
  appContext.timers.toast = appContext.timers.set(() => {
    t.hidden = true;
  }, 3600);
}
function toggleFileMenu(open) {
  $('#fileMenu').hidden = !open;
  $('#fileBtn').setAttribute('aria-expanded', open);
}
async function exportJson() {
  toggleFileMenu(false);
  try {
    const snapshot = serializeMap();
    const bundle = await NodeImageFormat.exportBundle(snapshot, imageStore);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }));
    a.download = `${snapshot.title || 'map'}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast(tr('file.exported'));
  } catch (error) {
    toast(error.message || tr('file.exportFailed'));
  }
}
let printing = false,
  titleBeforePrint = null;
async function printMap() {
  toggleFileMenu(false);
  if (printing) return;
  printing = true;
  try {
    const images = [...nodeEls.values()].map(el => el.imageState?.ready).filter(Boolean);
    await Promise.race([Promise.all(images), new Promise(resolve => appContext.timers.set(resolve, 3000))]);
    print();
  } finally {
    printing = false;
  }
}
addEventListener('beforeprint', () => {
  const p = PrintLayout.fit(mapBounds(0));
  $('#pageStyle').textContent = `@page { size: A4 ${p.orientation}; margin: 10mm }`;
  viewportEl.style.setProperty('--print-w', p.width + 'px');
  viewportEl.style.setProperty('--print-h', p.height + 'px');
  viewportEl.style.setProperty('--print-transform', `translate(${p.x}px, ${p.y}px) scale(${p.scale})`);
  titleBeforePrint ??= document.title;
  document.title = state.map.title || tr('maps.untitled');
});
addEventListener('afterprint', () => {
  if (titleBeforePrint !== null) document.title = titleBeforePrint;
  titleBeforePrint = null;
});
$('#nodeMenu').addEventListener('click', e => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act || !state.selectedId) return;
  ({
    child: () => addChildAndEdit(state.selectedId),
    edit: () => startEdit(state.selectedId),
    image: () => pickImage(state.selectedId, false),
    'image-child': () => pickImage(state.selectedId, true),
    'remove-image': () => removeNodeImage(state.selectedId),
    reparent: () => startReparent(state.selectedId),
    delete: () => removeNode(state.selectedId),
  })[act]();
});
$('#addChild').onclick = () => addChildAndEdit(state.selectedId || state.map.root);
$('#promptForm').onsubmit = e => {
  e.preventDefault();
  void sendInstruction();
};
$('#promptInput').oninput = () => {
  state.draftVersion++;
  resizePrompt();
};
$('#promptInput').onkeydown = e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    void sendInstruction();
  }
  if (e.key === 'Escape') viewportEl.focus();
};
$('#instructionCancel').onclick = cancelInstruction;
$('#instructionConfirm').onclick = applyInstruction;
$('#instructionDialog').addEventListener('cancel', e => {
  e.preventDefault();
  cancelInstruction();
});
$('#instructionDialog').addEventListener('close', () => {
  if (state.instruction?.state === 'awaiting_confirmation') cancelInstruction();
});
$('#handBtn').onclick = () => toggleHand();
$('#camSelect').onchange = e => {
  try {
    localStorage.setItem(CAMERA_KEY, e.target.value);
  } catch {}
  stopHand();
  toggleHand(handMode);
};
$('#handFallback').onclick = () => {
  stopHand();
  toggleHand('main');
};
let fitTimer,
  fitHeld = false;
$('#fitBtn').onpointerdown = () => {
  fitHeld = false;
  fitTimer = appContext.timers.set(() => {
    fitHeld = true;
    zoomAt(viewportWidth() / 2, innerHeight / 2, 1);
  }, 500);
};
$('#fitBtn').onpointerup =
  $('#fitBtn').onpointerleave =
  $('#fitBtn').onpointercancel =
    () => appContext.timers.clear(fitTimer);
$('#fitBtn').onclick = () => {
  if (!fitHeld) fitAll();
  fitHeld = false;
};
$('#zoomIn').onclick = () => zoomAt(viewportWidth() / 2, innerHeight / 2, state.view.s * 1.25);
$('#zoomOut').onclick = () => zoomAt(viewportWidth() / 2, innerHeight / 2, state.view.s / 1.25);
$('#zoomLabel').onclick = () => zoomAt(viewportWidth() / 2, innerHeight / 2, 1);
$('#undo').onclick = undo;
$('#deleteSingle').onchange = () => chooseDeleteScope('single');
$('#deleteBranch').onchange = () => chooseDeleteScope('branch');
$('#deleteCancel').onclick = closeDelete;
$('#deleteConfirm').onclick = confirmDelete;
$('#deleteDialog').addEventListener('cancel', e => {
  e.preventDefault();
  closeDelete();
});
$('#deleteDialog').addEventListener('close', () => {
  if (!$('#deleteDialog').open) closeDelete();
});
$('#imageDialog').addEventListener('close', () => {
  if (viewing) imageStore.release(viewing);
  viewing = null;
});
$('#imageDialog').onclick = e => {
  if (e.target === e.currentTarget) e.currentTarget.close();
};
$('#redo').onclick = redo;
$('#modeOk').onclick = confirmReparent;
$('#modeCancel').onclick = endReparent;
$('#fileBtn').onclick = () => toggleFileMenu($('#fileMenu').hidden);
$('#exportBtn').onclick = exportJson;
$('#printBtn').onclick = printMap;
$('#saveExport').onclick = exportJson;
$('#importBtn').onclick = () => {
  toggleFileMenu(false);
  $('#fileInput').click();
};
async function importMap(m) {
  if (!valid(m) || m.version !== 2) throw new Error(tr('map.invalid'));
  await switchMap(() => state.library.create(m));
}
let importRequest = 0;
$('#fileInput').onchange = async e => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const request = ++importRequest;
  try {
    if (f.size > NodeImageFormat.MAX_FILE) throw new Error(tr('file.tooLarge'));
    const value = JSON.parse(await f.text());
    if (request !== importRequest) return;
    const m = await NodeImageFormat.importBundle(value, imageStore);
    if (request !== importRequest) return;
    await importMap(m);
    toast(tr('file.imported'));
  } catch (error) {
    if (request === importRequest) toast(tr('file.importKept', error.message || tr('file.importFailed')));
  }
};
$('#mapsBtn').onclick = () => toggleMapsMenu($('#mapsMenu').hidden);
$('#newMapBtn').onclick = async () => {
  toggleMapsMenu(false);
  try {
    await switchMap(() => state.library.create(blankMap()));
    startEdit(state.map.root);
  } catch (error) {
    toast(error.message || tr('maps.createFailed'));
  }
};
$('#mapsList').onclick = async e => {
  const open = e.target.closest('[data-open]')?.dataset.open,
    remove = e.target.closest('[data-remove]')?.dataset.remove;
  if (remove) {
    confirmMapDelete(remove);
    return;
  }
  if (!open) return;
  toggleMapsMenu(false);
  if (open === state.mapId) return;
  try {
    await switchMap(open);
  } catch (error) {
    toast(error.message || tr('maps.switchFailed'));
  }
};
$('#mapDeleteCancel').onclick = () => $('#mapDeleteDialog').close();
$('#mapDeleteDialog').addEventListener('close', () => {
  mapDeleting = null;
});
$('#mapDeleteConfirm').onclick = async () => {
  const id = mapDeleting;
  $('#mapDeleteDialog').close();
  if (!id) return;
  try {
    await deleteMap(id);
    toast(tr('maps.deleted'));
  } catch (error) {
    toast(error.message || tr('maps.deleteFailed'));
  }
};
$('#title').oninput = e => {
  if (state.map.title !== e.target.value)
    commit(() => {
      state.map.title = e.target.value;
    });
};
$('#title').onkeydown = e => {
  if (e.key === 'Enter' && !e.isComposing) viewportEl.focus();
};
$('#devBtn').onclick = () => {
  const open = $('#dev').hidden;
  $('#dev').hidden = !open;
  $('#devBtn').setAttribute('aria-expanded', open);
  $('#devMenuBtn').setAttribute('aria-expanded', open);
};
$('#devMenuBtn').onclick = () => {
  toggleFileMenu(false);
  $('#devBtn').onclick();
};
$('#promptToggle').onclick = () => {
  setPromptHidden(!$('#prompt').hidden);
  if (!$('#prompt').hidden) $('#promptInput').focus();
};
$('#promptHide').onclick = () => {
  setPromptHidden(true);
  viewportEl.focus();
};
$('#promptToggle').hidden = !instructionsEnabled;
$('#promptShortcutKey').hidden = !instructionsEnabled;
$('#promptShortcutHelp').hidden = !instructionsEnabled;
let promptHidden = !instructionsEnabled;
try {
  promptHidden ||= !!localStorage.getItem(PROMPT_KEY);
} catch {}
setPromptHidden(promptHidden, false);
$('#camToggle').onclick = () => {
  const label = tr($('#cam').classList.toggle('is-collapsed') ? 'cam.show' : 'cam.hide');
  $('#camToggle').setAttribute('aria-label', label);
  $('#camToggle').title = label;
};
$('#dev').addEventListener('click', e => {
  const d = e.target.closest('[data-dev]')?.dataset.dev;
  if (!d) return;
  if (d === 's-saving') {
    autosave.cancelTimer();
    setSave('saving');
  }
  if (d === 's-error') {
    appContext.controls.forceSaveFail = true;
    scheduleSave();
  }
  if (d === 's-saved') {
    appContext.controls.forceSaveFail = false;
    scheduleSave();
  }
  if (d === 'edge') {
    animateTo(centerOn({ x: BOUND, y: 0 }));
    appContext.timers.set(() => {
      edgeHint('right');
      toast(tr('dev.edgeToast'));
    }, 300);
  }
  if (d === 'gc-skew') {
    try {
      localStorage.setItem(GC_SKEW_KEY, '1');
    } catch {}
    toast(tr('dev.gcSkewToast'));
  }
  if (d === 'reset' && !readOnly()) {
    commit(() => {
      state.map = sample();
      state.mapSessionId = InstructionTransport.id('map_');
    });
    state.selectedId = state.map.root;
    $('#title').value = state.map.title;
    animateTo(centerOn({ x: 0, y: 0 }, 1));
  }
});
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#viewport')) interruptHand();
  if (!$('#fileMenu').hidden && !e.target.closest('.menu')) toggleFileMenu(false);
  if (!$('#mapsMenu').hidden && !e.target.closest('.menu')) toggleMapsMenu(false);
});
addEventListener('resize', () => {
  interruptHand();
  clampView(state.view, false);
  applyView();
});
addEventListener('blur', () => {
  if (speech.active) return;
  if (state.gesture?.type === 'node') revertGesture();
  pts.clear();
  stopHand();
});
addEventListener('pagehide', () => {
  speech.abort();
  if (state.editing) state.editing.pendingDone = false;
  updateSpeech();
  stopHand();
  for (const el of nodeEls.values()) clearNodeImage(el);
  storeView();
  if (!readOnly()) flushSave().catch(() => {});
  state.mapClaim.release();
});
addEventListener('pageshow', e => {
  render();
  if (e?.persisted && state.library && state.mapId) void openMap(state.mapId).catch(failOpen);
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    speech.abort();
    if (state.editing) state.editing.pendingDone = false;
    updateSpeech();
    stopHand();
  }
});

palette = globalThis.IconPalette?.create({
  state: () => ({
    session: state.mapSessionId,
    revision: state.revision,
    selection: state.map.nodes[state.selectedId] ? state.selectedId : null,
    root: state.map.root,
    targetName: state.map.nodes[state.selectedId]?.text || '',
    hasImage: !!state.map.nodes[state.selectedId]?.image,
    blocked: tr(OperationPolicy.paletteBlock(operationState())),
  }),
  attach: (blob, target, alt) => attachNodeImage(blob, { ...target, mapSessionId: target.session }, alt),
  error: message => toast(message),
  interrupt: interruptHand,
  width: viewportWidth,
  clearDrop: () => setDropTarget(null),
  closeMenu: () => toggleFileMenu(false),
  closeMenus: () => {
    if (!$('#fileMenu').hidden) {
      toggleFileMenu(false);
      return true;
    }
    if (!$('#mapsMenu').hidden) {
      toggleMapsMenu(false);
      return true;
    }
    return false;
  },
  layout: () => {
    animId++;
    resizeNotices();
    if (nodeEls.has(state.selectedId)) {
      positionMenu();
      ensureVisible(state.map.nodes[state.selectedId]);
    }
  },
});
