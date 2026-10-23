const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HandController, handFrame, directionalTarget } = require('../ui-prototype/gestures/controller.js');

function setup(options = {}) {
  const events = [], dragEvents = [], zooms = []; let blocked = false, time = 0;
  const controller = new HandController({
    blocked: () => blocked, activate: () => events.push('activate'),
    navigate: direction => events.push(direction), paint() {},
    zoom: factor => zooms.push(factor),
    bounds: () => ({ left: 0, top: 0, right: 1000, bottom: 800 }),
    begin: (x, y) => { dragEvents.push(['begin', x, y]); return 'a'; },
    move: (x, y) => dragEvents.push(['move', x, y]),
    release: () => dragEvents.push(['release']), cancel: () => dragEvents.push(['cancel']),
  }, options);
  const feed = (x = .5, y = .5, extra = {}) => {
    controller.update({ pointer: { x, y }, wrist: { x: .5, y: .7 }, ratio: .8, identity: 'Left', ...extra }, time);
    time += 50;
  };
  const stable = (x = .5, y = .5, extra = {}) => { for (let i = 0; i < 3; i++) feed(x, y, extra); };
  return { controller, events, dragEvents, zooms, feed, stable, block: value => blocked = value,
    lost: () => { controller.update(null, time); time += 50; },
    advance: duration => time += duration,
    moves: () => events.filter(e => typeof e === 'object') };
}

test('requires a stable open hand before initializing the selection', () => {
  const t = setup(); t.stable(.5, .5, { ratio: .1 });
  assert.equal(t.controller.state.initialized, false);
  t.stable(); assert.deepEqual(t.events, ['activate']);
  assert.equal(t.controller.state.state, 'ready');
});

for (const [name, x, y, dx, dy] of [
  ['right', .4, .5, 1, 0], ['left', .6, .5, -1, 0],
  ['up', .5, .4, 0, -1], ['down', .5, .6, 0, 1],
  ['down-left', .6, .6, -1, 1], ['down-right', .4, .6, 1, 1],
  ['up-left', .6, .4, -1, -1], ['up-right', .4, .4, 1, -1],
]) test(`mirrored palm displacement selects ${name} once and holds when stopped`, () => {
  const t = setup(); t.stable(); t.feed(x, y);
  const [move] = t.moves(); assert.ok(move);
  assert.ok(Math.abs(move.x - dx / Math.hypot(dx, dy)) < 1e-8);
  assert.ok(Math.abs(move.y - dy / Math.hypot(dx, dy)) < 1e-8);
  for (let i = 0; i < 30; i++) t.feed(x, y);
  assert.equal(t.moves().length, 1);
});

test('stationary jitter is ignored but slow deliberate movement accumulates', () => {
  const t = setup(); t.stable();
  for (let i = 0; i < 30; i++) t.feed(i % 2 ? .503 : .497);
  assert.equal(t.moves().length, 0);
  for (let i = 1; i <= 14; i++) t.feed(.5 - i * .005);
  assert.equal(t.moves().length, 1);
});

test('cooldown discards excess motion; a new displacement selects the next node', () => {
  const t = setup(); t.stable(); t.feed(.4);
  t.feed(.3); t.feed(.2); t.feed(.1); t.feed(.1); t.feed(.1);
  assert.equal(t.moves().length, 1);
  t.feed(.02); assert.equal(t.moves().length, 2);
});

test('a large jump emits at most one step and cannot repeat while stationary', () => {
  const t = setup(); t.stable(); t.feed(.05);
  for (let i = 0; i < 20; i++) t.feed(.05);
  assert.equal(t.moves().length, 1);
});

test('pinch freezes direction selection, and reopening resets its baseline', () => {
  const t = setup(); t.stable(); t.stable(.1, .5, { ratio: .1 });
  assert.equal(t.moves().length, 0);
  t.stable(.1); t.stable(.1); assert.equal(t.moves().length, 0);
  t.advance(250); t.feed(.1); t.feed(.02); assert.equal(t.moves().length, 1);
});

for (const cause of ['loss', 'blocked', 'identity', 'wrist', 'gap', 'malformed']) test(`${cause} resets navigation without a recovery jump`, () => {
  const t = setup(); t.stable(); t.feed(.46);
  if (cause === 'loss') t.lost();
  if (cause === 'blocked') { t.block(true); t.feed(); t.block(false); }
  if (cause === 'gap') t.advance(1500);
  if (cause === 'malformed') t.feed(NaN);
  const extra = cause === 'identity' ? { identity: 'Right' } : cause === 'wrist' ? { wrist: { x: .1, y: .1 } } : {};
  t.stable(.1, .5, extra); t.stable(.1, .5, extra);
  assert.equal(t.moves().length, 0);
  t.feed(.02, .5, extra); assert.equal(t.moves().length, 1);
});

test('uncertain handedness permits navigation without repeated resets', () => {
  const t = setup(); t.stable(.5, .5, { identity: null });
  t.feed(.4, .5, { identity: null }); assert.equal(t.moves().length, 1);
});

test('candidate choice uses distance, angle, a cone, and deterministic ties', () => {
  const origin = { id: 'o', x: 0, y: 0 }, right = { x: 1, y: 0 };
  const nodes = [origin, { id: 'far', x: 100, y: 0 }, { id: 'near', x: 30, y: 10 },
    { id: 'outside', x: 1, y: 30 }, { id: 'behind', x: -1, y: 0 }, { id: 'same', x: 0, y: 0 }];
  assert.equal(directionalTarget(nodes, 'o', right), 'near');
  assert.equal(directionalTarget(nodes, 'o', { x: 0, y: -1 }), null);
  assert.equal(directionalTarget(nodes, 'absent', right), null);
  const tie = [origin, { id: 'b', x: 10, y: 0 }, { id: 'a', x: 10, y: 0 }];
  assert.equal(directionalTarget(tie, 'o', right), 'a');
  assert.equal(directionalTarget(tie.reverse(), 'o', right), 'a');
  assert.equal(directionalTarget([origin, { id: 'diagonal', x: -10, y: 10 }], 'o', { x: -1, y: 1 }), 'diagonal');
});

test('landmark distances account for aspect ratio and hand size', () => {
  const landmarks = Array.from({ length: 21 }, () => ({ x: .5, y: .5 }));
  landmarks[0] = { x: .5, y: .7 }; landmarks[4] = { x: .6, y: .5 };
  const frame = handFrame({ landmarks: [landmarks], handedness: [[{ categoryName: 'Left', score: .95 }]] }, 640, 480);
  assert.ok(Math.abs(frame.ratio - 64 / 96) < 1e-8);
  assert.equal(frame.identity, 'Left');
  assert.equal(handFrame({}, 640, 480), null);
});


test('malformed palm landmarks and invalid image dimensions are rejected', () => {
  const points = Array.from({ length: 21 }, () => ({ x: .5, y: .5 })); points[0].y = .7;
  for (const value of [null, { x: NaN, y: .5 }, { x: .5, y: Infinity }]) {
    const landmarks = points.slice(); landmarks[13] = value;
    assert.equal(handFrame({ landmarks: [landmarks] }, 640, 480), null);
  }
  assert.equal(handFrame({ landmarks: [points] }, 0, 480), null);
});

test('palm coordinates are unchanged by finger flexion', () => {
  const landmarks = Array.from({ length: 21 }, () => ({ x: .5, y: .5 })); landmarks[0].y = .7;
  const before = handFrame({ landmarks: [landmarks] }, 640, 480);
  landmarks[8].x = .7; landmarks[4].x = .71;
  const after = handFrame({ landmarks: [landmarks] }, 640, 480);
  assert.deepEqual(after.pointer, before.pointer);
  assert.notEqual(after.ratio, before.ratio);
});

for (const interval of [200, 300, 450, 800]) test(`open hand becomes ready with ${interval}ms result intervals`, () => {
  const t = setup(); t.feed(); t.advance(interval - 50); t.feed();
  assert.equal(t.controller.state.state, 'ready');
  assert.equal(t.moves().length, 0);
  t.advance(interval - 50); t.feed(.4);
  assert.equal(t.moves().length, 1);
});

test('detected open hand, pinch, blocked input and missing detection have distinct states', () => {
  const t = setup(); t.feed(); assert.equal(t.controller.state.state, 'waiting');
  t.feed(.5, .5, { ratio: .1 }); assert.equal(t.controller.state.state, 'pinchWaiting');
  t.block(true); t.feed(); assert.equal(t.controller.state.state, 'blocked');
  t.block(false); t.lost(); assert.equal(t.controller.state.state, 'nohand');
});

test('stable pinch fixes the target, hysteresis retains it, opening freezes movement', () => {
  const t = setup({ smoothing: 1, gain: 1, deadzone: 0 }); t.stable();
  t.feed(.6, .5, { ratio: .1 }); t.feed(.5); // Aborted short pinch.
  assert.equal(t.dragEvents.length, 0);
  t.stable(.6, .5, { ratio: .1 });
  assert.deepEqual(t.dragEvents, [['begin', 0, 0]]);
  t.feed(.55, .5, { ratio: .4 });
  assert.equal(t.controller.state.grab, 'a');
  assert.ok(Math.abs(t.dragEvents.at(-1)[1] - 50) < 1e-8);
  t.stable(.2); // Opening displacement is not dragging.
  assert.equal(t.dragEvents.filter(e => e[0] === 'move').length, 1);
  assert.equal(t.dragEvents.filter(e => e[0] === 'release').length, 1);
  assert.equal(t.controller.state.grab, null);
  assert.equal(t.moves().length, 0);
});

test('default drag filtering absorbs stationary palm jitter', () => {
  const t = setup(); t.stable(); t.stable(.5, .5, { ratio: .1 });
  for (let i = 0; i < 40; i++) t.feed(i % 2 ? .503 : .497, .5, { ratio: .1 });
  assert.equal(t.dragEvents.some(e => e[0] === 'move'), false);
});

test('two-hand distance uses palm centers, aspect ratio, and ignores result order', () => {
  const points = (x, y) => Array.from({ length: 21 }, (_, i) => ({ x, y: i === 0 ? y + .1 : y }));
  const a = points(.2, .3), b = points(.6, .7);
  const result = handFrame({ landmarks: [a, b] }, 640, 480);
  assert.equal(result.hands, 2);
  assert.ok(Math.abs(result.distance - .5) < 1e-8);
  assert.deepEqual(handFrame({ landmarks: [b, a] }, 640, 480), result);
  b[8].x += .1; b[4].x += .2;
  assert.deepEqual(handFrame({ landmarks: [a, b] }, 640, 480), result);
  b[13].x = NaN;
  assert.equal(handFrame({ landmarks: [a, b] }, 640, 480), null);
});

test('spreading zooms out, approaching zooms in; holding and jitter do not drift', () => {
  const t = setup(), two = distance => t.feed(.5, .5, { hands: 2, distance });
  two(.4); two(.4); two(.4);
  assert.equal(t.controller.state.state, 'zooming');
  assert.equal(t.zooms.length, 0);
  two(.5); assert.ok(t.zooms[0] < 1);
  two(.4); assert.ok(t.zooms[1] > 1);
  assert.ok(Math.abs(t.zooms[0] * t.zooms[1] - 1) < 1e-8);
  for (let i = 0; i < 40; i++) two(i % 2 ? .403 : .397);
  assert.equal(t.zooms.length, 2);
  assert.equal(t.events.length, 0);
});

test('two-hand entry cancels node preview, then returning to one hand reacquires without jumps', () => {
  const t = setup(); t.stable(); t.stable(.5, .5, { ratio: .1 });
  t.stable(.5, .5, { hands: 2, distance: .4 });
  assert.deepEqual(t.dragEvents.map(e => e[0]), ['begin', 'cancel']);
  t.feed(.1, .5, { ratio: .1 });
  assert.equal(t.controller.state.grab, null);
  t.stable(.1); assert.equal(t.controller.state.state, 'ready');
  assert.equal(t.moves().length, 0);
  t.feed(.02); assert.equal(t.moves().length, 1);
});

for (const cause of ['loss', 'blocked', 'gap', 'jump', 'invalid', 'clock']) test(`two-hand ${cause} resets the zoom baseline`, () => {
  const t = setup(), two = distance => t.feed(.5, .5, { hands: 2, distance });
  two(.4); two(.4); two(.4);
  if (cause === 'loss') t.lost();
  if (cause === 'blocked') { t.block(true); two(.4); t.block(false); }
  if (cause === 'gap') t.advance(1500);
  if (cause === 'clock') t.advance(-500);
  if (cause === 'invalid') two(NaN);
  const baseline = cause === 'jump' ? .7 : .5;
  two(baseline); two(baseline); two(baseline);
  assert.equal(t.zooms.length, 0);
  two(baseline + .05); assert.ok(t.zooms[0] < 1);
});

const pointHand = t => { for (let i = 0; i < 8; i++) t.feed(.5, .5, { pose: 'point' }); };

test('point toggles once per hold; fist rearms it and resume starts without a jump', () => {
  const t = setup(); t.stable(); pointHand(t);
  assert.equal(t.controller.state.state, 'paused');
  pointHand(t); assert.equal(t.controller.paused, true);
  t.stable(.1, .5, { pose: 'fist', ratio: .1 });
  assert.equal(t.controller.paused, true);
  pointHand(t); assert.equal(t.controller.paused, false);
  t.stable(.1); assert.equal(t.controller.state.state, 'ready');
  assert.equal(t.moves().length, 0);
  t.feed(.02); assert.equal(t.moves().length, 1);
});

test('short pointing noise does not toggle and a brief pose flicker cannot rearm', () => {
  const t = setup(); t.stable(); t.stable(.5, .5, { pose: 'point' });
  t.stable(); assert.equal(t.controller.paused, false);
  pointHand(t); t.feed(.5, .5, { pose: 'fist' }); pointHand(t);
  assert.equal(t.controller.paused, true);
});

test('pause survives tracking loss, ordinary input and suppresses pinch and zoom', () => {
  const t = setup(); t.stable(); pointHand(t);
  t.lost(); pointHand(t); assert.equal(t.controller.paused, true);
  t.block(true); t.feed(); t.block(false);
  t.stable(.1); t.stable(.1, .5, { ratio: .1 });
  for (const distance of [.4, .4, .4, .5]) t.feed(.5, .5, { hands: 2, distance });
  assert.equal(t.controller.state.state, 'paused');
  assert.deepEqual(t.moves(), []); assert.deepEqual(t.dragEvents, []); assert.deepEqual(t.zooms, []);
  pointHand(t); assert.equal(t.controller.paused, false);
});

for (const pose of ['fist', 'point']) test(`${pose} cancels a drag preview and cannot navigate or grab`, () => {
  const t = setup(); t.stable(); t.stable(.5, .5, { ratio: .1 });
  t.feed(.4, .5, { ratio: .1 });
  t.stable(.1, .5, { pose, ratio: .1 });
  assert.equal(t.controller.state.grab, null);
  assert.deepEqual(t.dragEvents.map(e => e[0]), ['begin', 'move', 'cancel']);
  assert.equal(t.moves().length, 0);
  if (pose === 'fist') {
    assert.equal(t.controller.state.state, 'neutral');
    t.stable(.1); assert.equal(t.moves().length, 0);
  }
});

function poseLandmarks(pose) {
  const p = Array.from({ length: 21 }, () => ({ x: .5, y: .6 }));
  p[0] = { x: .5, y: .85 }; p[4] = { x: .3, y: .6 };
  for (const [i, base] of [5, 9, 13, 17].entries()) {
    const x = .38 + i * .08, extended = pose === 'open' || (pose === 'point' && i === 0);
    p[base] = { x, y: .6 }; p[base + 1] = { x, y: .48 };
    p[base + 2] = { x, y: extended ? .4 : .54 };
    p[base + 3] = { x, y: extended ? .3 : .65 };
  }
  return p;
}

test('landmarks distinguish fist, index-only point, open hand and pinch across orientation', () => {
  for (const pose of ['fist', 'point', 'open', 'pinch']) {
    const points = poseLandmarks(pose === 'pinch' ? 'open' : pose);
    if (pose === 'pinch') points[8] = { ...points[4] };
    for (const transform of [p => p, p => ({ x: 1 - p.x, y: p.y }),
      p => ({ x: .5 - (p.y - .5) * 480 / 640, y: .5 + (p.x - .5) * 640 / 480 })]) {
      const frame = handFrame({ landmarks: [points.map(transform)] }, 640, 480);
      assert.equal(frame.pose, ['open', 'pinch'].includes(pose) ? null : pose);
    }
  }
  const two = handFrame({ landmarks: [poseLandmarks('open'), poseLandmarks('point')] }, 640, 480);
  assert.equal(two.pose, 'point');
});
