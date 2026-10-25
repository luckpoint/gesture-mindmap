// Application dependencies are supplied per instance; evaluation has no screen effects.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindmapAppControls = api;
})(globalThis, () => {
  'use strict';
  function create(context, operations) {
    const { state, elements, services, environment, ui } = context;
    function toast(msg, label, action) {
      const t = operations.$('#toast');
      t.textContent = msg;
      if (label) {
        const b = Object.assign(environment.document.createElement('button'), { className: 'btn', textContent: label });
        b.onclick = () => {
          action();
          t.hidden = true;
        };
        t.append(b);
      }
      t.hidden = false;
      context.timers.clear(context.timers.toast);
      context.timers.toast = context.timers.set(() => {
        t.hidden = true;
      }, 3600);
    }
    function toggleFileMenu(open) {
      operations.$('#fileMenu').hidden = !open;
      operations.$('#fileBtn').setAttribute('aria-expanded', open);
    }
    async function exportJson() {
      operations.toggleFileMenu(false);
      try {
        const snapshot = operations.serializeMap();
        const bundle = await services.NodeImageFormat.exportBundle(snapshot, services.imageStore);
        const a = environment.document.createElement('a');
        a.href = environment.URL.createObjectURL(
          new environment.Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' }),
        );
        a.download = `${snapshot.title || 'map'}.json`;
        a.click();
        environment.URL.revokeObjectURL(a.href);
        operations.toast(services.tr('file.exported'));
      } catch (error) {
        operations.toast(error.message || services.tr('file.exportFailed'));
      }
    }
    ui.printing = false;
    ui.titleBeforePrint = null;
    async function printMap() {
      operations.toggleFileMenu(false);
      if (ui.printing) return;
      ui.printing = true;
      try {
        const images = [...elements.nodeEls.values()].map(el => el.imageState?.ready).filter(Boolean);
        await Promise.race([Promise.all(images), new Promise(resolve => context.timers.set(resolve, 3000))]);
        environment.print();
      } finally {
        ui.printing = false;
      }
    }
    ui.fitTimer = undefined;
    ui.fitHeld = false;
    async function importMap(m) {
      if (!operations.valid(m) || m.version !== 2) throw new Error(services.tr('map.invalid'));
      await operations.switchMap(() => state.library.create(m));
    }
    ui.importRequest = 0;
    ui.promptHidden = !services.instructionsEnabled;
    function initialize() {
      environment.addEventListener('beforeprint', () => {
        const p = services.PrintLayout.fit(operations.mapBounds(0));
        operations.$('#pageStyle').textContent = `@page { size: A4 ${p.orientation}; margin: 10mm }`;
        elements.viewportEl.style.setProperty('--print-w', p.width + 'px');
        elements.viewportEl.style.setProperty('--print-h', p.height + 'px');
        elements.viewportEl.style.setProperty('--print-transform', `translate(${p.x}px, ${p.y}px) scale(${p.scale})`);
        ui.titleBeforePrint ??= environment.document.title;
        environment.document.title = state.map.title || services.tr('maps.untitled');
      });
      environment.addEventListener('afterprint', () => {
        if (ui.titleBeforePrint !== null) environment.document.title = ui.titleBeforePrint;
        ui.titleBeforePrint = null;
      });
      operations.$('#nodeMenu').addEventListener('click', e => {
        const act = e.target.closest('[data-act]')?.dataset.act;
        if (!act || !state.selectedId) return;
        ({
          child: () => operations.addChildAndEdit(state.selectedId),
          edit: () => operations.startEdit(state.selectedId),
          image: () => operations.pickImage(state.selectedId, false),
          'image-child': () => operations.pickImage(state.selectedId, true),
          'remove-image': () => operations.removeNodeImage(state.selectedId),
          reparent: () => operations.startReparent(state.selectedId),
          delete: () => operations.removeNode(state.selectedId),
        })[act]();
      });
      operations.$('#addChild').onclick = () => operations.addChildAndEdit(state.selectedId || state.map.root);
      operations.$('#promptForm').onsubmit = e => {
        e.preventDefault();
        void operations.sendInstruction();
      };
      operations.$('#promptInput').oninput = () => {
        state.draftVersion++;
        operations.resizePrompt();
      };
      operations.$('#promptInput').onkeydown = e => {
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
          e.preventDefault();
          void operations.sendInstruction();
        }
        if (e.key === 'Escape') elements.viewportEl.focus();
      };
      operations.$('#instructionCancel').onclick = operations.cancelInstruction;
      operations.$('#instructionConfirm').onclick = operations.applyInstruction;
      operations.$('#instructionDialog').addEventListener('cancel', e => {
        e.preventDefault();
        operations.cancelInstruction();
      });
      operations.$('#instructionDialog').addEventListener('close', () => {
        if (state.instruction?.state === 'awaiting_confirmation') operations.cancelInstruction();
      });
      operations.$('#handBtn').onclick = () => operations.toggleHand();
      operations.$('#camSelect').onchange = e => {
        try {
          environment.localStorage.setItem(operations.CAMERA_KEY, e.target.value);
        } catch {}
        operations.stopHand();
        operations.toggleHand(ui.handMode);
      };
      operations.$('#handFallback').onclick = () => {
        operations.stopHand();
        operations.toggleHand('main');
      };
      operations.$('#fitBtn').onpointerdown = () => {
        ui.fitHeld = false;
        ui.fitTimer = context.timers.set(() => {
          ui.fitHeld = true;
          operations.zoomAt(operations.viewportWidth() / 2, environment.innerHeight / 2, 1);
        }, 500);
      };
      operations.$('#fitBtn').onpointerup =
        operations.$('#fitBtn').onpointerleave =
        operations.$('#fitBtn').onpointercancel =
          () => context.timers.clear(ui.fitTimer);
      operations.$('#fitBtn').onclick = () => {
        if (!ui.fitHeld) operations.fitAll();
        ui.fitHeld = false;
      };
      operations.$('#zoomIn').onclick = () =>
        operations.zoomAt(operations.viewportWidth() / 2, environment.innerHeight / 2, state.view.s * 1.25);
      operations.$('#zoomOut').onclick = () =>
        operations.zoomAt(operations.viewportWidth() / 2, environment.innerHeight / 2, state.view.s / 1.25);
      operations.$('#zoomLabel').onclick = () =>
        operations.zoomAt(operations.viewportWidth() / 2, environment.innerHeight / 2, 1);
      operations.$('#undo').onclick = operations.undo;
      operations.$('#deleteSingle').onchange = () => operations.chooseDeleteScope('single');
      operations.$('#deleteBranch').onchange = () => operations.chooseDeleteScope('branch');
      operations.$('#deleteCancel').onclick = operations.closeDelete;
      operations.$('#deleteConfirm').onclick = operations.confirmDelete;
      operations.$('#deleteDialog').addEventListener('cancel', e => {
        e.preventDefault();
        operations.closeDelete();
      });
      operations.$('#deleteDialog').addEventListener('close', () => {
        if (!operations.$('#deleteDialog').open) operations.closeDelete();
      });
      operations.$('#imageDialog').addEventListener('close', () => {
        if (ui.viewing) services.imageStore.release(ui.viewing);
        ui.viewing = null;
      });
      operations.$('#imageDialog').onclick = e => {
        if (e.target === e.currentTarget) e.currentTarget.close();
      };
      operations.$('#redo').onclick = operations.redo;
      operations.$('#modeOk').onclick = operations.confirmReparent;
      operations.$('#modeCancel').onclick = operations.endReparent;
      operations.$('#fileBtn').onclick = () => operations.toggleFileMenu(operations.$('#fileMenu').hidden);
      operations.$('#exportBtn').onclick = operations.exportJson;
      operations.$('#printBtn').onclick = operations.printMap;
      operations.$('#saveExport').onclick = operations.exportJson;
      operations.$('#importBtn').onclick = () => {
        operations.toggleFileMenu(false);
        operations.$('#fileInput').click();
      };
      operations.$('#fileInput').onchange = async e => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        const request = ++ui.importRequest;
        try {
          if (f.size > services.NodeImageFormat.MAX_FILE) throw new Error(services.tr('file.tooLarge'));
          const value = JSON.parse(await f.text());
          if (request !== ui.importRequest) return;
          const m = await services.NodeImageFormat.importBundle(value, services.imageStore);
          if (request !== ui.importRequest) return;
          await operations.importMap(m);
          operations.toast(services.tr('file.imported'));
        } catch (error) {
          if (request === ui.importRequest)
            operations.toast(services.tr('file.importKept', error.message || services.tr('file.importFailed')));
        }
      };
      operations.$('#mapsBtn').onclick = () => operations.toggleMapsMenu(operations.$('#mapsMenu').hidden);
      operations.$('#newMapBtn').onclick = async () => {
        operations.toggleMapsMenu(false);
        try {
          await operations.switchMap(() => state.library.create(operations.blankMap()));
          operations.startEdit(state.map.root);
        } catch (error) {
          operations.toast(error.message || services.tr('maps.createFailed'));
        }
      };
      operations.$('#mapsList').onclick = async e => {
        const open = e.target.closest('[data-open]')?.dataset.open,
          remove = e.target.closest('[data-remove]')?.dataset.remove;
        if (remove) {
          operations.confirmMapDelete(remove);
          return;
        }
        if (!open) return;
        operations.toggleMapsMenu(false);
        if (open === state.mapId) return;
        try {
          await operations.switchMap(open);
        } catch (error) {
          operations.toast(error.message || services.tr('maps.switchFailed'));
        }
      };
      operations.$('#mapDeleteCancel').onclick = () => operations.$('#mapDeleteDialog').close();
      operations.$('#mapDeleteDialog').addEventListener('close', () => {
        ui.mapDeleting = null;
      });
      operations.$('#mapDeleteConfirm').onclick = async () => {
        const id = ui.mapDeleting;
        operations.$('#mapDeleteDialog').close();
        if (!id) return;
        try {
          await operations.deleteMap(id);
          operations.toast(services.tr('maps.deleted'));
        } catch (error) {
          operations.toast(error.message || services.tr('maps.deleteFailed'));
        }
      };
      operations.$('#title').oninput = e => {
        if (state.map.title !== e.target.value)
          operations.commit(() => {
            state.map.title = e.target.value;
          });
      };
      operations.$('#title').onkeydown = e => {
        if (e.key === 'Enter' && !e.isComposing) elements.viewportEl.focus();
      };
      operations.$('#devBtn').onclick = () => {
        const open = operations.$('#dev').hidden;
        operations.$('#dev').hidden = !open;
        operations.$('#devBtn').setAttribute('aria-expanded', open);
        operations.$('#devMenuBtn').setAttribute('aria-expanded', open);
      };
      operations.$('#devMenuBtn').onclick = () => {
        operations.toggleFileMenu(false);
        operations.$('#devBtn').onclick();
      };
      operations.$('#promptToggle').onclick = () => {
        operations.setPromptHidden(!operations.$('#prompt').hidden);
        if (!operations.$('#prompt').hidden) operations.$('#promptInput').focus();
      };
      operations.$('#promptHide').onclick = () => {
        operations.setPromptHidden(true);
        elements.viewportEl.focus();
      };
      operations.$('#promptToggle').hidden = !services.instructionsEnabled;
      operations.$('#promptShortcutKey').hidden = !services.instructionsEnabled;
      operations.$('#promptShortcutHelp').hidden = !services.instructionsEnabled;
      try {
        ui.promptHidden ||= !!environment.localStorage.getItem(operations.PROMPT_KEY);
      } catch {}
      operations.setPromptHidden(ui.promptHidden, false);
      operations.$('#camToggle').onclick = () => {
        const label = services.tr(operations.$('#cam').classList.toggle('is-collapsed') ? 'cam.show' : 'cam.hide');
        operations.$('#camToggle').setAttribute('aria-label', label);
        operations.$('#camToggle').title = label;
      };
      operations.$('#dev').addEventListener('click', e => {
        const d = e.target.closest('[data-dev]')?.dataset.dev;
        if (!d) return;
        if (d === 's-saving') {
          operations.autosave.cancelTimer();
          operations.setSave('saving');
        }
        if (d === 's-error') {
          context.controls.forceSaveFail = true;
          operations.scheduleSave();
        }
        if (d === 's-saved') {
          context.controls.forceSaveFail = false;
          operations.scheduleSave();
        }
        if (d === 'edge') {
          operations.animateTo(operations.centerOn({ x: operations.BOUND, y: 0 }));
          context.timers.set(() => {
            operations.edgeHint('right');
            operations.toast(services.tr('dev.edgeToast'));
          }, 300);
        }
        if (d === 'gc-skew') {
          try {
            environment.localStorage.setItem(operations.GC_SKEW_KEY, '1');
          } catch {}
          operations.toast(services.tr('dev.gcSkewToast'));
        }
        if (d === 'reset' && !operations.readOnly()) {
          operations.commit(() => {
            state.map = operations.sample();
            state.mapSessionId = services.InstructionTransport.id('map_');
          });
          state.selectedId = state.map.root;
          operations.$('#title').value = state.map.title;
          operations.animateTo(operations.centerOn({ x: 0, y: 0 }, 1));
        }
      });
      environment.document.addEventListener('pointerdown', e => {
        if (!e.target.closest('#viewport')) operations.interruptHand();
        if (!operations.$('#fileMenu').hidden && !e.target.closest('.menu')) operations.toggleFileMenu(false);
        if (!operations.$('#mapsMenu').hidden && !e.target.closest('.menu')) operations.toggleMapsMenu(false);
      });
      environment.addEventListener('resize', () => {
        operations.interruptHand();
        operations.clampView(state.view, false);
        operations.applyView();
      });
      environment.addEventListener('blur', () => {
        if (operations.speech.active) return;
        if (state.gesture?.type === 'node') operations.revertGesture();
        operations.pts.clear();
        operations.stopHand();
      });
      environment.addEventListener('pagehide', () => {
        operations.speech.abort();
        if (state.editing) state.editing.pendingDone = false;
        operations.updateSpeech();
        operations.stopHand();
        for (const el of elements.nodeEls.values()) operations.clearNodeImage(el);
        operations.storeView();
        if (!operations.readOnly()) operations.flushSave().catch(() => {});
        state.mapClaim.release();
      });
      environment.addEventListener('pageshow', e => {
        operations.render();
        if (e?.persisted && state.library && state.mapId)
          void operations.openMap(state.mapId).catch(operations.failOpen);
      });
      environment.document.addEventListener('visibilitychange', () => {
        if (environment.document.hidden) {
          operations.speech.abort();
          if (state.editing) state.editing.pendingDone = false;
          operations.updateSpeech();
          operations.stopHand();
        }
      });
      ui.palette = services.IconPalette?.create(
        {
          state: () => ({
            session: state.mapSessionId,
            revision: state.revision,
            selection: state.map.nodes[state.selectedId] ? state.selectedId : null,
            root: state.map.root,
            targetName: state.map.nodes[state.selectedId]?.text || '',
            hasImage: !!state.map.nodes[state.selectedId]?.image,
            blocked: services.tr(operations.OperationPolicy.paletteBlock(operations.operationState())),
          }),
          attach: (blob, target, alt) =>
            operations.attachNodeImage(blob, { ...target, mapSessionId: target.session }, alt),
          error: message => operations.toast(message),
          interrupt: operations.interruptHand,
          width: operations.viewportWidth,
          clearDrop: () => operations.setDropTarget(null),
          closeMenu: () => operations.toggleFileMenu(false),
          closeMenus: () => {
            if (!operations.$('#fileMenu').hidden) {
              operations.toggleFileMenu(false);
              return true;
            }
            if (!operations.$('#mapsMenu').hidden) {
              operations.toggleMapsMenu(false);
              return true;
            }
            return false;
          },
          layout: () => {
            ui.animId++;
            operations.resizeNotices();
            if (elements.nodeEls.has(state.selectedId)) {
              operations.positionMenu();
              operations.ensureVisible(state.map.nodes[state.selectedId]);
            }
          },
        },
        { environment, i18n: services.I18n },
      );
    }
    return { toast, toggleFileMenu, exportJson, printMap, importMap, initialize };
  }
  return { create };
});
