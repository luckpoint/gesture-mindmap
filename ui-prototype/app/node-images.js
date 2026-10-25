function clearNodeImage(el) {
  if (!el.imageState) return;
  imageStore.release(el.imageState.id);
  el.imageState.frame.remove();
  el.imageState = null;
}
function renderNodeImage(el, ref) {
  if (el.imageState?.id !== ref?.assetId) clearNodeImage(el);
  if (!ref) return;
  if (el.imageState) {
    el.imageState.img.alt = ref.alt;
    return;
  }
  const frame = document.createElement('div');
  frame.className = 'node__image';
  const img = document.createElement('img');
  img.alt = ref.alt;
  img.draggable = false;
  img.width = 192;
  img.height = 144;
  const message = document.createElement('span');
  message.textContent = tr('image.loading');
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
      renderEdges();
      positionMenu();
    }
  };
  const failed = () => {
    settle();
    if (el.imageState === imageState) {
      imageState.failed = true;
      img.hidden = true;
      message.hidden = false;
      message.textContent = tr('image.loadFailed');
    }
  };
  img.onerror = failed;
  imageStore.acquire(ref.assetId).then(url => {
    if (el.imageState === imageState) img.src = url;
  }, failed);
}
async function attachNodeImage(blob, target, alt) {
  // The caller captures the target before any slow decode, resize or storage step.
  const { nodeId, child, mapSessionId: session, revision: baseRevision } = target;
  const conflict = () =>
    (target.valid && !target.valid()) ||
    mapRevisionConflict({ session, revision: baseRevision }) ||
    !OperationPolicy.canAttachImage(operationState()) ||
    !Object.hasOwn(state.map.nodes, nodeId);
  if (conflict()) throw new Error(tr('image.conflict'));
  if (typeof alt !== 'string' || alt.length > 4000) throw new Error(tr('image.altTooLong'));
  const asset = await imageStore.put(blob);
  if (conflict()) throw new Error(tr('image.conflictSaved'));
  let id = nodeId;
  if (
    !commit(() => {
      if (child) id = addNode(nodeId, alt, place(nodeId, 208));
      state.map.nodes[id].image = { assetId: asset.assetId, alt, width: asset.width, height: asset.height };
    })
  )
    return;
  if (child) {
    select(id);
    ensureVisible(state.map.nodes[id]);
  }
  toast(tr('image.added'));
}
let imagePick = null;
function pickImage(nodeId, child) {
  if (refuseReadOnly()) return;
  imagePick = { nodeId, child };
  $('#imageInput').click();
}
async function adoptImageFile(file, pick) {
  const target = { ...pick, mapSessionId: state.mapSessionId, revision: state.revision };
  const alt = pick.child ? NodeImageUpload.name(file) : state.map.nodes[pick.nodeId].text || NodeImageUpload.name(file);
  try {
    await attachNodeImage(await NodeImageUpload.prepare(file), target, alt);
  } catch (error) {
    toast(error.message || tr('image.addFailed'));
  }
}
$('#imageInput').onchange = async e => {
  const file = e.target.files[0],
    pick = imagePick;
  e.target.value = '';
  imagePick = null;
  if (!file || !pick || !state.map.nodes[pick.nodeId]) return;
  await adoptImageFile(file, pick);
};
let dropTarget = null;
function setDropTarget(id) {
  if (dropTarget === id) return;
  nodeEls.get(dropTarget)?.classList.remove('is-drop-target');
  dropTarget = id;
  nodeEls.get(id)?.classList.add('is-drop-target');
}
const nodeIdAt = e => document.elementFromPoint(e.clientX, e.clientY)?.closest('.node')?.dataset.id;
viewportEl.addEventListener('dragover', e => {
  const icon = palette?.isDrag(e.dataTransfer);
  if (!icon && !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  const id = icon && !palette.canDrop() ? null : nodeIdAt(e);
  e.dataTransfer.dropEffect = id ? 'copy' : 'none';
  setDropTarget(id ?? null);
});
viewportEl.addEventListener('dragleave', e => {
  if (!viewportEl.contains(e.relatedTarget)) setDropTarget(null);
});
viewportEl.addEventListener('drop', async e => {
  const icon = palette?.isDrag(e.dataTransfer);
  if (!icon && !e.dataTransfer?.types.includes('Files')) return;
  e.preventDefault();
  setDropTarget(null);
  if (icon) {
    const id = nodeIdAt(e);
    if (id && state.map.nodes[id]) await palette.drop(e.dataTransfer, id);
    return;
  }
  const id = nodeIdAt(e),
    file = [...e.dataTransfer.files].find(f => f.type.startsWith('image/'));
  if (!id || !state.map.nodes[id] || refuseReadOnly()) return;
  if (!file) {
    toast(tr('image.dropFile'));
    return;
  }
  await adoptImageFile(file, { nodeId: id, child: false });
});
let viewing = null;
function openImageViewer(id) {
  const ref = state.map.nodes[id]?.image;
  if (!ref || nodeEls.get(id)?.imageState?.failed) return false;
  const img = $('#imageViewerImg'),
    assetId = (viewing = ref.assetId);
  img.alt = ref.alt;
  img.removeAttribute('src');
  imageStore.acquire(assetId).then(
    url => {
      if (viewing === assetId) img.src = url;
    },
    () => {
      if (viewing === assetId) {
        $('#imageDialog').close();
        toast(tr('image.loadFailed'));
      }
    },
  );
  $('#imageDialog').showModal();
  return true;
}
function removeNodeImage(id) {
  if (!state.map.nodes[id]?.image || !OperationPolicy.canRemoveImage(operationState())) return;
  commit(() => {
    delete state.map.nodes[id].image;
  });
  toast(tr('image.removed'));
}
