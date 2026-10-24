/* Writes and removes image files in OPFS /images for images/store.js. */
onmessage = async ({ data: { id, op, name, bytes } }) => {
  try {
    if (!/^[a-f0-9]{64}$/.test(name)) throw new Error('画像IDが正しくありません');
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('images', { create: true });
    if (op === 'write') {
      const handle = await (await dir.getFileHandle(name, { create: true })).createSyncAccessHandle();
      try { handle.truncate(0); handle.write(new Uint8Array(bytes), { at: 0 }); handle.flush(); } finally { handle.close(); }
    } else if (op === 'remove') await dir.removeEntry(name);
    else throw new Error('不明な操作です');
    postMessage({ id, ok: true });
  } catch (error) { postMessage({ id, ok: false, error: error.message }); }
};
