/* Turns a picked local file into a Blob the image store accepts. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('./format.js') : root.NodeImageFormat);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NodeImageUpload = api;
})(globalThis, F => {
  'use strict';
  const MAX_SIDE = 2048, KEEP_BYTES = 2 * 1024 * 1024;
  async function prepare(file) {
    if (!(file instanceof Blob) || !file.size || file.size > F.MAX_TOTAL) throw new Error('画像ファイルは50MiBまでです');
    let bitmap;
    try { bitmap = await createImageBitmap(file); } catch { throw new Error('画像をデコードできません'); }
    const { width, height } = bitmap;
    if (F.mime(file.type) && file.size <= KEEP_BYTES && Math.max(width, height) <= MAX_SIDE) { bitmap.close(); return file; }
    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = new OffscreenCanvas(Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale)));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height); bitmap.close();
    return canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  }
  const name = file => (file.name || '').replace(/\.[^.]*$/, '').trim() || '画像';
  return { MAX_SIDE, KEEP_BYTES, prepare, name };
});
