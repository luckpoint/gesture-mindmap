const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HandDebugOverlay, HandShapeView, previewPoint, fitPoints } = require('../ui-prototype/gestures/debug.js');
const { handFrame } = require('../ui-prototype/gestures/controller.js');
global.I18n = { t: key => key };
global.HandGestures = { handFrame };

function setup() {
  const labels = [], lines = [], clears = [];
  const ctx = { scale() {}, beginPath() {}, moveTo(x, y) { lines.push([x, y]); }, lineTo(x, y) { lines.push([x, y]); },
    stroke() {}, arc() {}, fill() {}, strokeText() {}, fillText(...args) { labels.push(args); },
    clearRect(...args) { clears.push(args); } };
  const canvas = { width: 320, height: 240, getContext: () => ctx, getBoundingClientRect: () => ({ width: 320, height: 240 }) };
  const output = {}, overlay = new HandDebugOverlay(canvas, output);
  const points = Array.from({ length: 21 }, (_, id) => ({ x: .2 + id * .02, y: .3 + id * .01 }));
  return { canvas, output, overlay, labels, lines, clears, points };
}

test('preview projection mirrors horizontally and matches cover cropping for portrait and landscape', () => {
  assert.deepEqual(previewPoint({ x: .25, y: .75 }, 640, 480, 320, 240), { x: 240, y: 180 });
  assert.deepEqual(previewPoint({ x: .5, y: .5 }, 480, 640, 320, 240), { x: 160, y: 120 });
  assert.ok(Math.abs(previewPoint({ x: .5, y: 0 }, 480, 640, 320, 240).y + 280 / 3) < 1e-8);
  assert.ok(Math.abs(previewPoint({ x: 0, y: .5 }, 1280, 720, 320, 240).x - 1120 / 3) < 1e-8);
});

test('debug draws every landmark and all 21 bones for each hand, with separate measurements', () => {
  const t = setup(); t.overlay.setEnabled(true);
  t.overlay.draw({ landmarks: [t.points, t.points.map(p => ({ x: 1 - p.x, y: p.y }))] }, 640, 480);
  assert.deepEqual(t.labels.map(([id]) => id), [...Array(21).keys(), ...Array(21).keys()].map(String));
  assert.equal(t.lines.length, (21 + 6) * 2); // Six chains, each includes its initial moveTo.
  assert.equal(t.labels[0][1], 260); // Mirrored x=.2 at 320 CSS pixels, plus label offset.
  assert.match(t.output.textContent, /1 \? · pose:/);
  assert.match(t.output.textContent, /2 \? · pose:/);
  assert.match(t.output.textContent, /pinch:.*XY.*3D/);
  assert.match(t.output.textContent, /image2D/);
});

test('disabled and collapsed diagnostics skip drawing; lost hands clear the overlay', () => {
  const t = setup();
  t.overlay.draw({ landmarks: [t.points] }, 640, 480);
  assert.equal(t.labels.length, 0);
  t.overlay.setEnabled(true);
  t.canvas.getBoundingClientRect = () => ({ width: 0, height: 0 });
  t.overlay.draw({ landmarks: [t.points] }, 640, 480);
  assert.equal(t.labels.length, 0);
  t.overlay.draw(null);
  assert.equal(t.output.textContent, 'cam.debugEmpty');
  assert.ok(t.clears.length >= 3);
  t.overlay.setEnabled(false);
  assert.equal(t.canvas.hidden, true); assert.equal(t.output.hidden, true);
});

test('invalid hands are reported without drawing stale skeletons', () => {
  const t = setup(); t.overlay.setEnabled(true);
  t.overlay.draw({ landmarks: [[{ x: NaN, y: .2 }]] }, 640, 480);
  assert.equal(t.labels.length, 0);
  assert.match(t.output.textContent, /invalid landmarks/);
});

test('hand shape fits all hands mirrored inside the padded view, or follows the preview when video is shown', () => {
  const t = setup(), shape = new HandShapeView(t.canvas);
  const fitted = fitPoints([t.points], 640, 480, 320, 240)[0];
  const xs = fitted.map(p => p.x), ys = fitted.map(p => p.y);
  assert.ok(Math.min(...xs) >= 28.8 - 1e-9 && Math.max(...xs) <= 320 - 28.8 + 1e-9);
  assert.ok(Math.abs(Math.min(...ys) - 28.8) < 1e-9 || Math.abs(Math.min(...xs) - 28.8) < 1e-9);
  assert.ok(fitted[0].x > fitted[20].x); // Mirrored like the preview.
  shape.draw({ landmarks: [t.points] }, 640, 480, true);
  assert.equal(t.lines.length, (21 + 6) * 2); // Outline pass and colour pass.
  assert.deepEqual(t.lines[0], [fitted[0].x, fitted[0].y]);
  t.lines.length = 0;
  shape.draw({ landmarks: [t.points] }, 640, 480, false);
  assert.deepEqual(t.lines[0], Object.values(previewPoint(t.points[0], 640, 480, 320, 240)));
});

test('hand shape clears and skips missing, malformed, flat or collapsed hands', () => {
  const t = setup(), shape = new HandShapeView(t.canvas);
  for (const result of [null, { landmarks: [] }, { landmarks: [[{ x: NaN, y: .2 }]] }, { landmarks: [t.points.map(() => ({ x: .5, y: .5 }))] }]) shape.draw(result, 640, 480, true);
  shape.draw({ landmarks: [t.points] }, 0, 480, true);
  t.canvas.getBoundingClientRect = () => ({ width: 0, height: 0 });
  shape.draw({ landmarks: [t.points] }, 640, 480, true);
  assert.equal(t.lines.length, 0);
  assert.equal(t.clears.length, 6);
});
