/* Turns a picked local file into a Blob the image store accepts. */
(function (root, factory) {
  const api =
    typeof module === 'object' && module.exports
      ? factory(require('./format.js'), require('../i18n.js'), require('./privacy.js'))
      : factory(root.NodeImageFormat, root.I18n, root.ImagePrivacy);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.NodeImageUpload = api;
})(globalThis, (F, I18n, Privacy) => {
  'use strict';
  const tr = I18n.t;
  const MAX_SIDE = 2048;
  async function prepare(file) {
    if (!(file instanceof Blob) || !file.size || file.size > F.MAX_TOTAL) throw new Error(tr('image.fileTooLarge'));
    return Privacy.clean(file, { maxSide: MAX_SIDE });
  }
  const name = file => (file.name || '').replace(/\.[^.]*$/, '').trim() || tr('image.defaultName');
  return { MAX_SIDE, prepare, name };
});
