const assert = require('node:assert/strict');
const { test } = require('node:test');
const { fit } = require('../ui-prototype/print.js');

const MM = 96 / 25.4;
const placed = (b, p) => ({
  x0: b.x0 * p.scale + p.x,
  y0: b.y0 * p.scale + p.y,
  x1: b.x1 * p.scale + p.x,
  y1: b.y1 * p.scale + p.y,
});
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-6, `${a} ≈ ${b}`);

test('orientation follows the map shape; a square is landscape', () => {
  assert.equal(fit({ x0: 0, y0: 0, x1: 300, y1: 100 }).orientation, 'landscape');
  assert.equal(fit({ x0: 0, y0: 0, x1: 100, y1: 300 }).orientation, 'portrait');
  assert.equal(fit({ x0: 0, y0: 0, x1: 100, y1: 100 }).orientation, 'landscape');
  const p = fit({ x0: 0, y0: 0, x1: 100, y1: 300 });
  near(p.width, 190 * MM);
  near(p.height, 277 * MM);
});

test('the map fits inside the printable area and is centred', () => {
  for (const b of [
    { x0: -700, y0: -300, x1: 900, y1: 450 },
    { x0: 100, y0: -2000, x1: 600, y1: 1500 },
  ]) {
    const p = fit(b),
      r = placed(b, p);
    assert.ok(r.x0 >= -1e-6 && r.y0 >= -1e-6 && r.x1 <= p.width + 1e-6 && r.y1 <= p.height + 1e-6);
    near(r.x0, p.width - r.x1);
    near(r.y0, p.height - r.y1);
  }
});

test('a small map stops at 1.25x', () => {
  assert.equal(fit({ x0: -200, y0: -60, x1: 200, y1: 60 }).scale, 1.25);
});

test('a very large map still fits on one page with no lower scale limit', () => {
  const b = { x0: 0, y0: 0, x1: 20000, y1: 3000 },
    p = fit(b);
  near(p.scale, (277 * MM) / 20000);
  assert.ok(placed(b, p).x1 <= p.width + 1e-6);
});
