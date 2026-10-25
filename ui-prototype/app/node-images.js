// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(context, operations) {
  const { state, elements, services, environment, ui } = context;
  function clearNodeImage(el) {
    if (!el.imageState) return;
    services.imageStore.release(el.imageState.id);
    el.imageState.frame.remove();
    el.imageState = null;
  }
  function renderNodeImage(el, ref) {
    if (el.imageState?.id !== ref?.assetId) operations.clearNodeImage(el);
    if (!ref) return;
    if (el.imageState) {
      el.imageState.img.alt = ref.alt;
      return;
    }
    const frame = environment.document.createElement('div');
    frame.className = 'node__image';
    const img = environment.document.createElement('img');
    img.alt = ref.alt;
    img.draggable = false;
    img.width = 192;
    img.height = 144;
    const message = environment.document.createElement('span');
    message.textContent = services.tr('image.loading');
    frame.append(img, message);
    el.prepend(frame);
    let settle;
    const imageState = (el.imageState = {
      id: ref.assetId,
      frame,
      img,
      ready: new Promise(resolve => {
        settle = resolve;
      }),
    });
    img.onload = () => {
      settle();
      if (el.imageState === imageState) {
        message.hidden = true;
        operations.renderEdges();
        operations.positionMenu();
      }
    };
    const failed = () => {
      settle();
      if (el.imageState === imageState) {
        imageState.failed = true;
        img.hidden = true;
        message.hidden = false;
        message.textContent = services.tr('image.loadFailed');
      }
    };
    img.onerror = failed;
    services.imageStore.acquire(ref.assetId).then(url => {
      if (el.imageState === imageState) img.src = url;
    }, failed);
  }
  async function attachNodeImage(blob, target, alt) {
    // The caller captures the target before any slow decode, resize or storage step.
    const { nodeId, child, mapSessionId: session, revision: baseRevision } = target;
    const conflict = () =>
      (target.valid && !target.valid()) ||
      operations.mapRevisionConflict({ session, revision: baseRevision }) ||
      !operations.OperationPolicy.canAttachImage(operations.operationState()) ||
      !Object.hasOwn(state.map.nodes, nodeId);
    if (conflict()) throw new Error(services.tr('image.conflict'));
    if (typeof alt !== 'string' || alt.length > 4000) throw new Error(services.tr('image.altTooLong'));
    const asset = await services.imageStore.put(blob);
    if (conflict()) throw new Error(services.tr('image.conflictSaved'));
    let id = nodeId;
    if (
      !operations.commit(() => {
        if (child) id = operations.addNode(nodeId, alt, operations.place(nodeId, 208));
        state.map.nodes[id].image = { assetId: asset.assetId, alt, width: asset.width, height: asset.height };
      })
    )
      return;
    if (child) {
      operations.select(id);
      operations.ensureVisible(state.map.nodes[id]);
    }
    operations.toast(services.tr('image.added'));
  }
  ui.imagePick = null;
  function pickImage(nodeId, child) {
    if (operations.refuseReadOnly()) return;
    ui.imagePick = { nodeId, child };
    operations.$('#imageInput').click();
  }
  async function adoptImageFile(file, pick) {
    const target = { ...pick, mapSessionId: state.mapSessionId, revision: state.revision };
    const alt = pick.child
      ? services.NodeImageUpload.name(file)
      : state.map.nodes[pick.nodeId].text || services.NodeImageUpload.name(file);
    try {
      await operations.attachNodeImage(await services.NodeImageUpload.prepare(file), target, alt);
    } catch (error) {
      operations.toast(error.message || services.tr('image.addFailed'));
    }
  }
  ui.dropTarget = null;
  function setDropTarget(id) {
    if (ui.dropTarget === id) return;
    elements.nodeEls.get(ui.dropTarget)?.classList.remove('is-drop-target');
    ui.dropTarget = id;
    elements.nodeEls.get(id)?.classList.add('is-drop-target');
  }
  const nodeIdAt = e => environment.document.elementFromPoint(e.clientX, e.clientY)?.closest('.node')?.dataset.id;
  ui.viewing = null;
  function openImageViewer(id) {
    const ref = state.map.nodes[id]?.image;
    if (!ref || elements.nodeEls.get(id)?.imageState?.failed) return false;
    const img = operations.$('#imageViewerImg'),
      assetId = (ui.viewing = ref.assetId);
    img.alt = ref.alt;
    img.removeAttribute('src');
    services.imageStore.acquire(assetId).then(
      url => {
        if (ui.viewing === assetId) img.src = url;
      },
      () => {
        if (ui.viewing === assetId) {
          operations.$('#imageDialog').close();
          operations.toast(services.tr('image.loadFailed'));
        }
      },
    );
    operations.$('#imageDialog').showModal();
    return true;
  }
  function removeNodeImage(id) {
    if (!state.map.nodes[id]?.image || !operations.OperationPolicy.canRemoveImage(operations.operationState())) return;
    operations.commit(() => {
      delete state.map.nodes[id].image;
    });
    operations.toast(services.tr('image.removed'));
  }
  function initialize() {
    operations.$('#imageInput').onchange = async e => {
      const file = e.target.files[0],
        pick = ui.imagePick;
      e.target.value = '';
      ui.imagePick = null;
      if (!file || !pick || !state.map.nodes[pick.nodeId]) return;
      await operations.adoptImageFile(file, pick);
    };
    elements.viewportEl.addEventListener('dragover', e => {
      const icon = ui.palette?.isDrag(e.dataTransfer);
      if (!icon && !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      const id = icon && !ui.palette.canDrop() ? null : operations.nodeIdAt(e);
      e.dataTransfer.dropEffect = id ? 'copy' : 'none';
      operations.setDropTarget(id ?? null);
    });
    elements.viewportEl.addEventListener('dragleave', e => {
      if (!elements.viewportEl.contains(e.relatedTarget)) operations.setDropTarget(null);
    });
    elements.viewportEl.addEventListener('drop', async e => {
      const icon = ui.palette?.isDrag(e.dataTransfer);
      if (!icon && !e.dataTransfer?.types.includes('Files')) return;
      e.preventDefault();
      operations.setDropTarget(null);
      if (icon) {
        const id = operations.nodeIdAt(e);
        if (id && state.map.nodes[id]) await ui.palette.drop(e.dataTransfer, id);
        return;
      }
      const id = operations.nodeIdAt(e),
        file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
      if (!id || !state.map.nodes[id] || operations.refuseReadOnly()) return;
      if (!file) {
        operations.toast(services.tr('image.dropFile'));
        return;
      }
      await operations.adoptImageFile(file, { nodeId: id, child: false });
    });
  }
  return {
    clearNodeImage,
    renderNodeImage,
    attachNodeImage,
    pickImage,
    adoptImageFile,
    setDropTarget,
    nodeIdAt,
    openImageViewer,
    removeNodeImage,
    initialize,
  };
}
export { create };
