/* Fits map bounds (world px) onto one A4 page: page orientation plus the #world transform. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PrintLayout = api;
})(globalThis, () => {
  'use strict';
  const MM = 96 / 25.4,
    A4 = [297, 210];
  function fit({ x0, y0, x1, y1 }, { margin = 10, maxScale = 1.25 } = {}) {
    const bw = Math.max(1, x1 - x0),
      bh = Math.max(1, y1 - y0);
    const orientation = bw >= bh ? 'landscape' : 'portrait';
    const [long, short] = A4.map(mm => (mm - margin * 2) * MM);
    const [width, height] = orientation === 'landscape' ? [long, short] : [short, long];
    const scale = Math.min(width / bw, height / bh, maxScale);
    return {
      orientation,
      width,
      height,
      scale,
      x: width / 2 - ((x0 + x1) / 2) * scale,
      y: height / 2 - ((y0 + y1) / 2) * scale,
    };
  }
  return { fit };
});
