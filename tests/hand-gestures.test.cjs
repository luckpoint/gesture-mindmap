const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HandController, handFrame, directionalTarget } = require('../ui-prototype/gestures/controller.js');

function setup(options = {}) {
  const events = [], dragEvents = [], zooms = [], pans = [], commands = [], dialogEvents = []; let blocked = false, time = 0, dialog = false;
  const controller = new HandController({
    blocked: () => blocked, activate: () => events.push('activate'),
    navigate: direction => events.push(direction), paint() {},
    zoom: factor => zooms.push(factor),
    pan: (x, y) => pans.push({ x, y }),
    command: action => commands.push(action), dialog: () => dialog,
    dialogNavigate: step => dialogEvents.push(step), dialogSelect: () => dialogEvents.push('select'),
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
  return { controller, events, dragEvents, zooms, pans, commands, dialogEvents, feed, stable, block: value => blocked = value, dialog: value => dialog = value,
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
  assert.ok(Math.abs(frame.handSize - .15) < 1e-8);
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

test('larger stationary tremor stays still for near and far hands', () => {
  for (const handSize of [.075, .15, .25]) {
    const t = setup(), extra = { ratio: .1, handSize };
    t.stable(); t.stable(.5, .5, extra);
    for (let i = 0; i < 100; i++) t.feed(.5 + (i % 2 ? .006 : -.006), .5, extra);
    assert.equal(t.dragEvents.filter(e => e[0] === 'move').length, 0, `handSize=${handSize}`);
  }
});

test('stationary jitter is suppressed at 20, 10 and 5 fps without drift', () => {
  for (const interval of [50, 100, 200]) {
    const t = setup(); t.stable(); t.stable(.5, .5, { ratio: .1 });
    for (let i = 0; i < 100; i++) {
      t.advance(interval - 50);
      t.feed(.5 + (i % 2 ? .004 : -.004), .5, { ratio: .1 });
    }
    assert.equal(t.dragEvents.filter(e => e[0] === 'move').length, 0, `${interval}ms`);
  }
});

test('slow deliberate drag crosses the deadzone and fast movement follows promptly', () => {
  const slow = setup(); slow.stable(); slow.stable(.5, .5, { ratio: .1 });
  for (let i = 1; i <= 40; i++) slow.feed(.5 - i * .001, .5, { ratio: .1 });
  assert.ok(slow.controller.state.x > 50);
  const fast = setup(); fast.stable(); fast.stable(.5, .5, { ratio: .1 });
  for (let i = 1; i <= 4; i++) fast.feed(.5 - i * .025, .5, { ratio: .1 });
  assert.ok(fast.controller.state.x > 130);
  const stopped = fast.controller.state.x;
  for (let i = 0; i < 40; i++) fast.feed(.4, .5, { ratio: .1 });
  assert.ok(fast.controller.state.x >= stopped && fast.controller.state.x <= 180);
  const settled = fast.controller.state.x;
  for (let i = 0; i < 60; i++) fast.feed(i % 2 ? .406 : .394, .5, { ratio: .1 });
  assert.ok(Math.abs(fast.controller.state.x - settled) < 3);
});

test('distance correction matches relative hand motion and stays fixed until the next grab', () => {
  const run = (handSize, displacement) => {
    const t = setup({ smoothing: 1, deadzone: 0 }); t.stable(); t.stable(.5, .5, { ratio: .1, handSize });
    t.feed(.5 - displacement, .5, { ratio: .1, handSize: handSize * 2 });
    return t;
  };
  const near = run(.2, .04), far = run(.1, .02);
  assert.ok(Math.abs(near.controller.state.x - far.controller.state.x) < 1e-8);
  assert.ok(Math.abs(near.controller.state.x - 54) < 1e-8);
  near.stable(.46); near.stable(.46, .5, { ratio: .1, handSize: .1 });
  near.feed(.44, .5, { ratio: .1, handSize: .1 });
  assert.ok(Math.abs(near.controller.state.x - 54) < 1e-8);
  for (const size of [undefined, NaN, 0, .0001, 10]) {
    const t = run(size, .02);
    assert.ok(Number.isFinite(t.controller.state.x));
    assert.ok(t.controller.dragScale >= .6 && t.controller.dragScale <= 1.6);
  }
});

test('moving drag follows small displacements, then latches and resumes without a mode-change jump', () => {
  const t = setup(); t.stable(); t.stable(.5, .5, { ratio: .1 });
  for (let i = 1; i <= 12; i++) t.feed(.5 - i * .005, .5, { ratio: .1 });
  assert.equal(t.controller.dragMoving, true);
  const before = t.controller.state.x;
  // 0.9 CSS px per sample, smaller than either stationary deadzone.
  for (let i = 1; i <= 30; i++) {
    t.feed(.44 - i * .0005, .5, { ratio: .1 });
    assert.equal(t.controller.dragMoving, true);
  }
  assert.ok(t.controller.state.x - before > 20);
  for (let i = 0; i < 40; i++) t.feed(.425, .5, { ratio: .1 });
  assert.equal(t.controller.dragMoving, false);
  const locked = { x: t.controller.state.x, y: t.controller.state.y };
  for (let i = 0; i < 80; i++) t.feed(.425 + Math.sin(i * .4) * .008,
    .5 + Math.cos(i * .4) * .005, { ratio: .1 });
  assert.deepEqual({ x: t.controller.state.x, y: t.controller.state.y }, locked);
  for (let i = 1; i <= 20; i++) t.feed(.425 - i * .001, .5, { ratio: .1 });
  assert.equal(t.controller.dragMoving, true);
  assert.ok(t.controller.state.x > locked.x + 10);
});

test('stationary latch handles moving tremor and resets through release and loss at different rates', () => {
  for (const interval of [50, 100, 200]) {
    const t = setup(); t.stable(); t.stable(.5, .5, { ratio: .1, handSize: .1 });
    const sample = (x, ratio = .1) => {
      t.advance(interval - 50); t.feed(x, .5, { ratio, handSize: .1 });
    };
    for (let i = 1; i <= 10; i++) sample(.5 - i * .005);
    assert.equal(t.controller.dragMoving, true);
    for (let i = 0; i < 40; i++) sample(.45 + (i % 2 ? .003 : -.003));
    assert.equal(t.controller.dragMoving, false, `${interval}ms`);
    const locked = t.controller.state.x;
    for (let i = 0; i < 40; i++) sample(.45 + (i % 2 ? .003 : -.003));
    assert.equal(t.controller.state.x, locked);
    for (let i = 0; i < 4; i++) sample(.45, .8);
    assert.equal(t.controller.state.grab, null);
    for (let i = 0; i < 4; i++) sample(.45);
    assert.equal(t.controller.dragMoving, false);
    assert.equal(t.controller.state.x, 0);
    t.lost();
    for (let i = 0; i < 4; i++) sample(.3);
    assert.equal(t.controller.state.grab, null);
  }
});

test('leaving the stationary latch does not spend its deadzone again on the next frame', () => {
  const t = setup({ smoothing: 1, gain: 1 }); t.stable(); t.stable(.5, .5, { ratio: .1 });
  t.feed(.48, .5, { ratio: .1 });
  assert.equal(t.controller.dragMoving, true);
  const position = t.controller.state.x;
  t.feed(.48, .5, { ratio: .1 });
  assert.equal(t.controller.state.x, position);
  t.feed(.479, .5, { ratio: .1 });
  assert.ok(t.controller.state.x > position && t.controller.state.x - position < 1);
});

test('two-hand distance uses palm centers, aspect ratio, and ignores result order', () => {
  const points = (x, y) => Array.from({ length: 21 }, (_, i) => ({ x, y: i === 0 ? y + .1 : y }));
  const a = points(.2, .3), b = points(.6, .7);
  const result = handFrame({ landmarks: [a, b] }, 640, 480);
  assert.equal(result.hands, 2);
  assert.ok(Math.abs(result.distance - .5) < 1e-8);
  assert.deepEqual(handFrame({ landmarks: [b, a] }, 640, 480), result);
  b[8].x += .1; b[4].x += .2;
  const flexed = handFrame({ landmarks: [a, b] }, 640, 480);
  assert.equal(flexed.distance, result.distance);
  assert.deepEqual(flexed.pointer, result.pointer);
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

const holdPose = (t, pose, extra = {}) => { for (let i = 0; i < 14; i++) t.feed(.5, .5, { pose, ...extra }); };

for (const [pose, action] of [['peace', 'add'], ['thumbDown', 'delete']]) {
  test(`${pose} commands require a stable hold, fire once, and rearm through neutral`, () => {
    const t = setup(); t.stable(); t.stable(.5, .5, { pose });
    assert.deepEqual(t.commands, []); assert.ok(t.controller.state.progress > 0);
    holdPose(t, pose); holdPose(t, pose);
    assert.deepEqual(t.commands, [action]); assert.deepEqual(t.moves(), []);
    t.lost(); holdPose(t, pose); assert.deepEqual(t.commands, [action]);
    t.stable(.5, .5, { pose: 'fist' }); holdPose(t, pose);
    assert.deepEqual(t.commands, [action, action]);
  });
}

for (const cause of ['loss', 'gap', 'identity', 'wrist', 'motion', 'pose', 'clock']) test(`${cause} interrupts a command hold`, () => {
  const t = setup(); t.stable();
  for (let i = 0; i < 10; i++) t.feed(.5, .5, { pose: 'peace' });
  if (cause === 'loss') t.lost();
  if (cause === 'gap') t.advance(1500);
  if (cause === 'clock') t.advance(-500);
  if (cause === 'pose') t.feed(.5, .5, { pose: 'fist' });
  const extra = cause === 'identity' ? { identity: 'Right' } : cause === 'wrist' ? { wrist: { x: .1, y: .1 } } : {};
  for (let i = 0; i < 4; i++) t.feed(cause === 'motion' ? .6 : .5, .5, { pose: 'peace', ...extra });
  assert.deepEqual(t.commands, []);
});

test('pause, ordinary input, two hands and drag transitions cannot issue commands', () => {
  for (const cause of ['paused', 'blocked', 'two', 'drag', 'zoom']) {
    const t = setup(); t.stable();
    if (cause === 'paused') pointHand(t);
    if (cause === 'blocked') t.block(true);
    if (cause === 'drag') t.stable(.5, .5, { ratio: .1 });
    if (cause === 'zoom') t.stable(.5, .5, { hands: 2, distance: .4 });
    holdPose(t, 'peace', cause === 'two' ? { hands: 2, distance: .4 } : {});
    assert.deepEqual(t.commands, [], cause);
    if (cause === 'drag') assert.deepEqual(t.dragEvents.map(e => e[0]), ['begin', 'cancel']);
  }
});

test('dialog requires an open hand and a fresh long pinch; never drags or zooms', () => {
  const t = setup(); t.stable(); t.dialog(true);
  holdPose(t, null, { ratio: .1 }); assert.deepEqual(t.dialogEvents, []);
  t.stable(); t.feed(.5, .6);
  assert.deepEqual(t.dialogEvents, [1]);
  t.stable(.5, .6, { ratio: .1 }); assert.deepEqual(t.dialogEvents, [1]);
  for (let i = 0; i < 12; i++) t.feed(.5, .6, { ratio: .1 });
  assert.deepEqual(t.dialogEvents, [1, 'select']);
  holdPose(t, null, { ratio: .1 }); assert.deepEqual(t.dialogEvents, [1, 'select']);
  holdPose(t, 'peace'); holdPose(t, null, { hands: 2, distance: .5 });
  assert.deepEqual(t.commands, []); assert.deepEqual(t.zooms, []); assert.deepEqual(t.dragEvents, []);
  pointHand(t); t.stable(); holdPose(t, null, { ratio: .1 });
  assert.deepEqual(t.dialogEvents, [1, 'select']);
});

test('landmarks recognize peace and downward thumb separately from point and fist', () => {
  const peace = poseLandmarks('point');
  for (const index of [10, 11, 12]) peace[index] = { x: peace[9].x, y: ({ 10: .48, 11: .4, 12: .3 })[index] };
  const down = poseLandmarks('fist');
  down[2] = { x: .5, y: .55 }; down[3] = { x: .5, y: .72 }; down[4] = { x: .5, y: .95 };
  for (const [points, pose] of [[peace, 'peace'], [down, 'thumbDown']]) {
    for (const mirror of [false, true]) {
      assert.equal(handFrame({ landmarks: [points.map(p => ({ x: mirror ? 1 - p.x : p.x, y: p.y }))] }, 640, 480).pose, pose);
    }
  }
  down[4] = { x: .38, y: .6 };
  assert.equal(handFrame({ landmarks: [down] }, 640, 480).pose, 'fist');
  const both = handFrame({ landmarks: [peace, poseLandmarks('open')] }, 640, 480);
  assert.equal(both.hands, 2); assert.notEqual(both.pose, 'peace');
});

test('point hold cannot inherit time spent in a command pose', () => {
  const t = setup(); t.stable();
  t.stable(.5, .5, { pose: 'point' });
  t.stable(.5, .5, { pose: 'peace' });
  t.stable(.5, .5, { pose: 'point' });
  assert.equal(t.controller.paused, false);
  pointHand(t); assert.equal(t.controller.paused, true);
});

const fists = { hands: 2, pose: 'bothFists', distance: .4 };

test('both fists pan with the mirrored midpoint, cancel previews and never zoom or select', () => {
  const t = setup({ smoothing: 1, gain: 1, deadzone: 0 });
  t.stable(); t.stable(.5, .5, { ratio: .1 });
  t.stable(.5, .5, fists);
  assert.deepEqual(t.dragEvents.map(e => e[0]), ['begin', 'cancel']);
  assert.equal(t.controller.state.state, 'panning');
  assert.deepEqual(t.pans, []);
  t.feed(.45, .45, { ...fists, distance: .5 });
  assert.ok(Math.abs(t.pans[0].x - 50) < 1e-8);
  assert.ok(Math.abs(t.pans[0].y + 40) < 1e-8);
  t.feed(.5, .5, fists);
  assert.ok(Math.abs(t.pans[1].x + 50) < 1e-8);
  assert.ok(Math.abs(t.pans[1].y - 40) < 1e-8);
  assert.deepEqual(t.zooms, []); assert.deepEqual(t.moves(), []);
});

for (const cause of ['open', 'one', 'loss', 'blocked', 'dialog', 'gap', 'clock', 'jump', 'invalid']) test(`pan ${cause} stops and reacquires without a jump`, () => {
  const t = setup({ smoothing: 1, gain: 1, deadzone: 0 });
  t.stable(.5, .5, fists); t.feed(.45, .5, fists);
  if (cause === 'open') t.feed(.2, .2, { hands: 2, pose: 'fist', distance: .4 });
  if (cause === 'one') t.feed(.2, .2);
  if (cause === 'loss') t.lost();
  if (cause === 'blocked') { t.block(true); t.feed(.2, .2, fists); t.block(false); }
  if (cause === 'dialog') { t.dialog(true); t.feed(.2, .2, fists); t.dialog(false); }
  if (cause === 'gap') t.advance(1500);
  if (cause === 'clock') t.advance(-500);
  if (cause === 'invalid') t.feed(NaN, .5, fists);
  t.stable(.1, .2, fists);
  assert.equal(t.pans.length, 1);
  t.feed(.08, .2, fists); assert.equal(t.pans.length, 2);
  assert.ok(Math.abs(t.pans[1].x - 20) < 1e-8);
});

test('pan jitter is suppressed and pause prevents all pan movement', () => {
  const t = setup(); t.stable(.5, .5, fists);
  for (let i = 0; i < 60; i++) t.feed(.5 + (i % 2 ? .003 : -.003), .5, fists);
  assert.deepEqual(t.pans, []);
  pointHand(t); t.stable(.5, .5, fists); t.feed(.4, .4, fists);
  assert.equal(t.controller.state.state, 'paused'); assert.deepEqual(t.pans, []);
});

test('pan and zoom transitions require fresh baselines', () => {
  const t = setup({ smoothing: 1, gain: 1, deadzone: 0 });
  t.stable(.5, .5, fists); t.feed(.45, .5, fists);
  t.stable(.1, .1, { hands: 2, distance: .7 });
  assert.deepEqual(t.zooms, []);
  t.feed(.1, .1, { hands: 2, distance: .75 }); assert.equal(t.zooms.length, 1);
  t.stable(.1, .1, fists); assert.equal(t.pans.length, 1);
  t.feed(.08, .1, fists); assert.equal(t.pans.length, 2);
});

test('landmarks require two fists for pan and use an order-independent palm midpoint', () => {
  const left = poseLandmarks('fist').map(p => ({ x: p.x - .2, y: p.y - .1 }));
  const right = poseLandmarks('fist').map(p => ({ x: p.x + .2, y: p.y + .1 }));
  const frame = handFrame({ landmarks: [left, right] }, 640, 480);
  assert.equal(frame.pose, 'bothFists');
  assert.deepEqual(frame.pointer, { x: .5, y: .65 });
  assert.deepEqual(handFrame({ landmarks: [right, left] }, 640, 480), frame);
  for (const pose of ['open', 'point']) {
    const mixed = handFrame({ landmarks: [left, poseLandmarks(pose)] }, 640, 480);
    assert.equal(mixed.pose, pose === 'point' ? 'point' : 'fist');
  }
});
