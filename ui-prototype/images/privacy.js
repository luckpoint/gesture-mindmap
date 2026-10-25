/* Re-encode decoded pixels only: EXIF, GPS, XMP, comments and thumbnails never pass through. */
(function (root, factory) {
  const api = factory(typeof module === 'object' && module.exports ? require('../i18n.js') : root.I18n);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ImagePrivacy = api;
})(globalThis, I18n => {
  'use strict';
  async function clean(blob, { maxSide = 4096 } = {}) {
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob);
    } catch {
      throw new Error(I18n.t('image.decodeFailed'));
    }
    try {
      const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
      const canvas = new OffscreenCanvas(
        Math.max(1, Math.round(bitmap.width * scale)),
        Math.max(1, Math.round(bitmap.height * scale)),
      );
      const ctx = canvas.getContext('2d');
      // PNG preserves transparency and avoids repeated lossy compression on export.
      const type = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
      if (type === 'image/jpeg') {
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
      }
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await canvas.convertToBlob({ type, quality: 0.9 });
    } finally {
      bitmap.close();
    }
  }
  return { clean };
});
