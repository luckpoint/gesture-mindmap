const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');
const { handFrame } = require('../ui-prototype/gestures/recognition.js');

const source = name => readFileSync(join(__dirname, '../ui-prototype', name), 'utf8');
function landmarks() {
  const points = Array.from({ length: 21 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  points[0].y = 0.7;
  // Coincident in the image, separated in depth.
  points[4].z = 0.3;
  return points;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

test('recognition runs alone without DOM, camera or controller globals', () => {
  const context = vm.createContext({});
  vm.runInContext(source('gestures/recognition.js'), context);
  const result = { landmarks: [landmarks()] };
  assert.equal(context.HandGestures, undefined);
  assert.equal(context.CameraSession, undefined);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.HandRecognition.handFrame(result, 640, 480))),
    handFrame(result, 640, 480),
  );
});

test('recognition leaves inputs untouched and options do not leak between calls', () => {
  const result = freeze({ landmarks: [landmarks()] });
  const options = freeze({ depthPinch: false });
  const baseline = handFrame(result, 640, 480);
  assert.ok(baseline.ratio > 0.55);
  assert.equal(handFrame(result, 640, 480, options).ratio, 0);
  handFrame({}, 640, 480);
  handFrame({ landmarks: [landmarks(), landmarks()] }, 640, 480);
  assert.deepEqual(handFrame(result, 640, 480), baseline);
});

test('entrypoint services wire real recognition into camera samples', () => {
  let sample;
  const context = vm.createContext({
    I18n: { t: key => key },
    performance: { now: () => 100 },
    requestAnimationFrame() {},
  });
  const scripts = [...source('app/main.js').matchAll(/import '\.\.\/(gestures\/[^']+)'/g)].map(m => m[1]);
  assert.equal(scripts.length, 4);
  for (const script of scripts) vm.runInContext(source(script), context);
  const controller = new context.HandGestures.HandController({ paint() {} });
  const session = new context.CameraSession({
    frame(frame, time) {
      sample = frame;
      assert.equal(time, 100);
    },
  });
  session.video = { videoWidth: 640, videoHeight: 480 };
  const result = { landmarks: [landmarks()] };
  session.result(result, 12);
  assert.deepEqual(JSON.parse(JSON.stringify(sample)), handFrame(result, 640, 480));
  assert.equal(controller.state.state, 'nohand');
});
