const { test } = require('node:test');
const assert = require('node:assert/strict');
const { HandDebugOverlay, previewPoint } = require('../ui-prototype/gestures/debug.js');
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
