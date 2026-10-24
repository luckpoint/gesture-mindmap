const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HandController, handFrame, directionalTarget, mapPointer, proximityTarget } = require('../ui-prototype/gestures/controller.js');

function setup(options = {}) {
  const events = [], dragEvents = [], zooms = [], pans = [], commands = [], dialogEvents = [], selections = [], centers = []; let blocked = false, time = 0, dialog = false;
  const controller = new HandController({
    blocked: () => blocked, activate: () => events.push('activate'),
    navigate: direction => events.push(direction), paint() {},
    nodes: () => [{ id: 'a', left: 450, right: 550, top: 360, bottom: 440 }],
    select: id => selections.push(id), center: id => centers.push(id),
    zoom: factor => zooms.push(factor),
    pan: (x, y) => pans.push({ x, y }),
    command: action => commands.push(action), dialog: () => dialog,
    dialogNavigate: step => dialogEvents.push(step), dialogSelect: () => dialogEvents.push('select'), dialogChoose: side => dialogEvents.push(side),
    bounds: () => ({ left: 0, top: 0, right: 1000, bottom: 800 }),
    begin: (x, y) => { dragEvents.push(['begin', x, y]); return 'a'; },
    move: (x, y) => dragEvents.push(['move', x, y]),
    release: () => dragEvents.push(['release']), cancel: () => dragEvents.push(['cancel']),
  }, options);
  const feed = (x = .5, y = .5, extra = {}) => {
    controller.update({ pointer: { x, y }, wrist: { x: .5, y: .7 }, ratio: .8, identity: 'Left', pose: extra.hands === 2 ? 'bothFists' : extra.ratio !== undefined ? null : 'palm',
      ...(extra.hands === 2 ? { palms: [{ x: .5 - extra.distance / 2, y: .5 }, { x: .5 + extra.distance / 2, y: .5 }] } : {}), ...extra }, time);
    time += 50;
  };
  const stable = (x = .5, y = .5, extra = {}) => { for (let i = 0; i < 3; i++) feed(x, y, extra); };
  return { controller, events, dragEvents, zooms, pans, commands, dialogEvents, selections, centers, feed, stable, block: value => blocked = value, dialog: value => dialog = value,
    lost: () => { controller.update(null, time); time += 50; },
    advance: duration => time += duration,
    moves: () => events.filter(e => typeof e === 'object') };
}

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

for (const motion of ['one', 'translation', 'opposite', 'missing', 'invalid']) test(`zoom rejects ${motion} palm motion`, () => {
  const t = setup(); t.stable(.5, .5, { hands: 2, distance: .4 });
  const palms = motion === 'one' ? [{ x: .3, y: .5 }, { x: .8, y: .5 }]
    : motion === 'translation' ? [{ x: .4, y: .5 }, { x: .8, y: .5 }]
    : motion === 'opposite' ? [{ x: .4, y: .5 }, { x: .75, y: .5 }]
    : motion === 'invalid' ? [{ x: NaN, y: .5 }, { x: .75, y: .5 }] : undefined;
  t.feed(.5, .5, { hands: 2, distance: .5, palms }); assert.deepEqual(t.zooms, []);
});

test('zoom follows vertical bilateral motion and detector order changes', () => {
  const t = setup();
  const feed = distance => t.feed(.5, .5, { hands: 2, distance,
    palms: [{ x: .5, y: .5 + distance / 2 }, { x: .5, y: .5 - distance / 2 }] });
  feed(.4); feed(.4); feed(.4); feed(.5);
  assert.ok(t.zooms[0] < 1);
  t.feed(.5, .5, { hands: 2, distance: .5, palms: [{ x: .5, y: .25 }, { x: .5, y: .75 }] });
  assert.equal(t.zooms.length, 1); feed(.4); assert.ok(t.zooms[1] > 1);
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
      assert.equal(frame.pose, pose === 'open' ? 'palm' : pose === 'pinch' ? null : pose);
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
    t.stable(); holdPose(t, pose);
    assert.deepEqual(t.commands, [action, action]);
  });
}

for (const [pose, action] of [['peace', 'add'], ['thumbDown', 'delete']]) {
  for (const duringHold of [false, true]) {
    for (const fistFrames of [1, 2]) test(`${pose} tolerates ${fistFrames} pending pan frames ${duringHold ? 'during' : 'before'} its hold`, () => {
      const t = setup(); t.stable();
      if (duringHold) for (let i = 0; i < 6; i++) t.feed(.5, .5, { pose });
      for (let i = 0; i < fistFrames; i++) t.feed(.5, .5, { pose: 'fist' });
      assert.equal(t.controller.state.state, 'panWaiting');
      for (let i = 0; i < 12; i++) t.feed(.5, .5, { pose });
      assert.deepEqual(t.commands, []);
      t.feed(.5, .5, { pose });
      assert.deepEqual(t.commands, [action]);
      holdPose(t, pose);
      assert.deepEqual(t.commands, [action]);
      assert.deepEqual(t.pans, []);
      t.feed(.5, .5, { pose: 'fist' }); holdPose(t, pose);
      assert.deepEqual(t.commands, [action], 'one fist frame must not rearm a fired command');
    });
  }
  for (const duringHold of [false, true]) test(`${pose} accepts a stationary fist ${duringHold ? 'during' : 'before'} its hold`, () => {
    const t = setup(); t.stable();
    if (duringHold) for (let i = 0; i < 6; i++) t.feed(.5, .5, { pose });
    for (let i = 0; i < 8; i++) t.feed(.5 + (i % 2 ? .001 : -.001), .5, { pose: 'fist' });
    assert.equal(t.controller.state.state, 'panning');
    assert.deepEqual(t.pans, []);
    for (let i = 0; i < 12; i++) t.feed(.5, .5, { pose });
    assert.deepEqual(t.commands, [], 'the command still needs a fresh 600ms hold');
    t.feed(.5, .5, { pose });
    holdPose(t, pose);
    assert.deepEqual(t.commands, [action]);
    t.stable(.5, .5, { pose: 'fist' });
    holdPose(t, pose);
    assert.deepEqual(t.commands, [action, action], 'a stationary fist can rearm a fired command');
  });
  test(`${pose} requires neutral after a moving pan`, () => {
    const t = setup({ smoothing: 1, gain: 1, deadzone: 0 });
    t.stable(.5, .5, { pose: 'fist' });
    t.feed(.45, .5, { pose: 'fist' });
    assert.ok(t.pans.length > 0);
    holdPose(t, pose); holdPose(t, pose);
    assert.deepEqual(t.commands, []);
    assert.equal(t.controller.state.state, 'commandReset');
    t.lost(); holdPose(t, pose);
    assert.deepEqual(t.commands, []);
    t.stable(.5, .5, { pose: 'point' }); holdPose(t, pose);
    assert.deepEqual(t.commands, [action]);
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

test('pause, ordinary input, two hands and zoom transitions cannot issue commands', () => {
  for (const cause of ['paused', 'blocked', 'two', 'zoom']) {
    const t = setup(); t.stable();
    if (cause === 'paused') t.controller.paused = true;
    if (cause === 'blocked') t.block(true);
    if (cause === 'zoom') t.stable(.5, .5, { hands: 2, distance: .4 });
    holdPose(t, 'peace', cause === 'two' ? { hands: 2, distance: .4 } : {});
    assert.deepEqual(t.commands, [], cause);
  }
});

test('dialog palm navigation remains available but pinching never confirms or centers', () => {
  const t = setup(); t.stable(); t.dialog(true);
  holdPose(t, null, { ratio: .1 }); assert.deepEqual(t.dialogEvents, []);
  t.stable(.5, .5, { pose: 'palm' }); t.feed(.5, .6, { pose: 'palm' });
  assert.deepEqual(t.dialogEvents, [1]);
  t.stable(.5, .6, { ratio: .1 }); assert.deepEqual(t.dialogEvents, [1]);
  for (let i = 0; i < 12; i++) t.feed(.5, .6, { ratio: .1 });
  assert.deepEqual(t.dialogEvents, [1]);
  holdPose(t, null, { ratio: .1 }); assert.deepEqual(t.dialogEvents, [1]);
  holdPose(t, 'peace'); holdPose(t, null, { hands: 2, distance: .5 });
  assert.deepEqual(t.commands, []); assert.deepEqual(t.zooms, []); assert.deepEqual(t.dragEvents, []);
  t.controller.paused = true; t.stable(); holdPose(t, null, { ratio: .1 });
  assert.deepEqual(t.dialogEvents, [1]);
  assert.deepEqual(t.centers, []);
});

test('landmarks recognize peace and downward thumb separately from point and fist', () => {
  const peace = poseLandmarks('point');
  for (const index of [10, 11, 12]) peace[index] = { x: peace[9].x, y: ({ 10: .48, 11: .4, 12: .3 })[index] };
  const down = poseLandmarks('fist');
  down[1] = { x: .5, y: .4 };
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

const fists = { hands: 2, pose: 'bothFists', distance: .4 };

test('landmarks identify two fists as a distinct zoom pose and use an order-independent palm midpoint', () => {
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

// Geometry fixtures use pixel-equivalent 3D coordinates, then normalize x/y/z
// separately like MediaPipe. This keeps rotations meaningful on non-square video.
function geometryHand(pose = 'open') {
  return poseLandmarks(pose).map(p => ({ x: p.x * 640, y: p.y * 480, z: 0 }));
}
function geometryResult(points, world) {
  return { landmarks: [points.map(p => ({ x: p.x / 640, y: p.y / 480, z: p.z / 640 }))],
    ...(world ? { worldLandmarks: [world] } : {}) };
}
function rotateHand(points, angle, axis = 'y') {
  const c = Math.cos(angle), s = Math.sin(angle);
  return points.map(p => {
    const x = p.x - 320, y = p.y - 288;
    return axis === 'y' ? { x: 320 + x * c + p.z * s, y: p.y, z: -x * s + p.z * c }
      : { x: p.x, y: 288 + y * c - p.z * s, z: y * s + p.z * c };
  });
}

test('joint angles reject a bent index with parallel first and last segments', () => {
  const points = poseLandmarks('point');
  points[6] = { x: .38, y: .5 }; points[7] = { x: .48, y: .45 }; points[8] = { x: .48, y: .35 };
  const result = { landmarks: [points] };
  assert.equal(handFrame(result, 640, 480, { jointAngles: false }).pose, 'point');
  const frame = handFrame(result, 640, 480);
  assert.equal(frame.pose, null);
  assert.ok(frame.measurements.fingers[0].pipBend > 55);
});

test('short straight fingers near the wrist are not mistaken for a fist', () => {
  const points = poseLandmarks('fist');
  for (const base of [5, 9, 13, 17]) {
    for (const [offset, x] of [[0, .38], [1, .30], [2, .29], [3, .28]]) points[base + offset] = { x, y: .6 };
  }
  assert.equal(handFrame({ landmarks: [points] }, 640, 480, { jointAngles: false }).pose, 'fist');
  assert.equal(handFrame({ landmarks: [points] }, 640, 480).pose, null);
});

for (const pose of ['fist', 'point', 'peace', 'open']) test(`3D ${pose} survives tilt, mirroring and scale`, () => {
  const points = geometryHand(pose === 'peace' ? 'point' : pose);
  if (pose === 'peace') for (const i of [10, 11, 12]) points[i] = geometryHand()[i];
  for (const axis of ['x', 'y']) for (const angle of [0, .7, 1.4]) for (const scale of [.5, 1, 1.5]) for (const mirror of [1, -1]) {
    const rotated = rotateHand(points, angle, axis).map(p => ({ x: 320 + (p.x - 320) * scale * mirror,
      y: 288 + (p.y - 288) * scale, z: p.z * scale }));
    assert.equal(handFrame(geometryResult(rotated), 640, 480).pose, pose === 'open' ? 'palm' : pose);
  }
});

for (const source of ['image3D', 'world']) test(`${source} distinguishes depth separation from an actual pinch`, () => {
  const points = geometryHand(); points[4] = { ...points[8] };
  const world = points.map(p => ({ x: p.x / 1000, y: p.y / 1000, z: p.z / 1000 }));
  if (source === 'world') world[4].z += .12;
  else points[4].z += 120;
  const result = geometryResult(points, source === 'world' ? world : null);
  const apart = handFrame(result, 640, 480);
  assert.equal(apart.measurements.ratio2D, 0);
  assert.ok(apart.ratio > .55);
  assert.equal(apart.measurements.space, source);
  assert.equal(handFrame(result, 640, 480, { depthPinch: false }).ratio, 0);
  points[4].z = points[8].z; world[4] = { ...world[8] };
  assert.equal(handFrame(geometryResult(points, source === 'world' ? world : null), 640, 480).ratio, 0);
});

test('depth overlap cannot confirm a dialog and no pinch can start a node drag', () => {
  const points = geometryHand(); points[4] = { ...points[8], z: 120 };
  const apart = handFrame(geometryResult(points), 640, 480);
  const t = setup(); t.stable(); t.stable(.5, .5, apart);
  assert.equal(t.dragEvents.length, 0);
  t.dialog(true); t.stable(.5, .5, apart); holdPose(t, null, apart);
  assert.equal(t.dialogEvents.length, 0);
  t.dialog(false); t.stable(); points[4].z = points[8].z;
  t.stable(.5, .5, handFrame(geometryResult(points), 640, 480));
  assert.equal(t.controller.state.grab, null);
  assert.deepEqual(t.dragEvents, []);
});

test('palm size and pinch ratios stay invariant under depth rotation and distance scaling', () => {
  const points = geometryHand(); points[4] = { ...points[8], x: points[8].x + 20 };
  const baseline = handFrame(geometryResult(points), 640, 480);
  for (const axis of ['x', 'y']) for (const angle of [.5, 1.3, Math.PI / 2]) for (const scale of [.5, 2]) {
    const transformed = rotateHand(points, angle, axis).map(p => ({ x: p.x * scale, y: p.y * scale, z: p.z * scale }));
    const frame = handFrame(geometryResult(transformed), 640, 480);
    assert.ok(Math.abs(frame.handSize / scale - baseline.handSize) < 1e-8);
    assert.ok(Math.abs(frame.ratio - baseline.ratio) < 1e-8);
  }
});

test('multiple palm lengths limit a noisy middle MCP and retain the old size for comparison', () => {
  const points = geometryHand();
  const before = handFrame(geometryResult(points), 640, 480);
  points[9].y -= 180;
  const after = handFrame(geometryResult(points), 640, 480);
  const legacy = handFrame(geometryResult(points), 640, 480, { stableHandSize: false });
  assert.ok(Math.abs(after.handSize / before.handSize - 1) < .15);
  assert.ok(legacy.handSize > before.handSize * 2);
});

test('invalid world and partial depth fall back to a complete usable coordinate space', () => {
  const points = geometryHand();
  const result = geometryResult(points, points.map(p => ({ ...p })));
  result.worldLandmarks[0][7].z = NaN;
  assert.equal(handFrame(result, 640, 480).measurements.space, 'image3D');
  delete result.landmarks[0][8].z;
  const frame = handFrame(result, 640, 480);
  assert.equal(frame.measurements.space, 'image2D');
  assert.ok(Number.isFinite(frame.ratio));
  result.worldLandmarks[0] = Array.from({ length: 21 }, () => ({ x: 0, y: 0, z: 0 }));
  assert.equal(handFrame(result, 640, 480).measurements.space, 'image2D');
  for (const i of [6, 7, 8]) result.landmarks[0][i] = { ...result.landmarks[0][5] };
  assert.equal(handFrame(result, 640, 480).measurements.fingers[0].extended, false);
});

test('world measurements do not depend on meter scale or normalized image aspect ratio', () => {
  const points = geometryHand(); points[4] = { ...points[8], z: 20 };
  const world = points.map(p => ({ x: p.x / 1000, y: p.y / 1000, z: p.z / 1000 }));
  const first = handFrame(geometryResult(points, world), 640, 480);
  const second = handFrame(geometryResult(points, world.map(p => ({ x: p.x * 100, y: p.y * 100, z: p.z * 100 }))), 640, 480);
  assert.ok(Math.abs(first.ratio - second.ratio) < 1e-8);
  const result = geometryResult(points, world);
  result.landmarks[0] = result.landmarks[0].map(p => ({ x: p.x, y: p.y * .75, z: p.z }));
  assert.ok(Math.abs(handFrame(result, 640, 640).ratio - first.ratio) < 1e-8);
});

function downwardThumb() {
  const points = geometryHand('fist');
  for (const [id, y] of [[1, 192], [2, 264], [3, 346], [4, 456]]) points[id] = { x: 320, y, z: 0 };
  return points;
}

test('straight downward thumb survives mirroring, distance and moderate 3D tilt', () => {
  for (const axis of ['x', 'y']) for (const angle of [0, .6, -.6]) for (const mirror of [1, -1]) for (const scale of [.5, 1.5]) {
    const points = rotateHand(downwardThumb(), angle, axis).map(p => ({
      x: 320 + (p.x - 320) * mirror * scale, y: 288 + (p.y - 288) * scale, z: p.z * scale }));
    const frame = handFrame(geometryResult(points), 640, 480);
    assert.equal(frame.pose, 'thumbDown');
    assert.equal(frame.measurements.thumb.extended, true);
  }
});

test('diagonal downward thumbs reach the side boundary without falling back to fist', () => {
  for (const degrees of [34, 35, 40, 44, 46, 60, 90]) for (const sign of [-1, 1]) for (const scale of [.5, 1.5]) {
    const angle = degrees * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle) * sign;
    const points = downwardThumb().map(p => ({
      x: 320 + ((p.x - 320) * c - (p.y - 288) * s) * scale,
      y: 288 + ((p.x - 320) * s + (p.y - 288) * c) * scale, z: p.z * scale,
    }));
    const frame = handFrame(geometryResult(points), 640, 480);
    assert.equal(frame.pose, degrees < 45 ? 'thumbDown' : sign === 1 ? 'thumbRight' : 'thumbLeft');
    if (degrees < 45) {
      const t = setup(); holdPose(t, frame.pose, frame);
      assert.deepEqual(t.commands, ['delete']);
    }
  }
});

test('slightly bent downward thumbs are accepted in image and world geometry, while side gestures stay strict', () => {
  for (const change of [p => { p[1].x += 90; }, p => { p[3].x += 35; }]) {
    const points = downwardThumb(); change(points);
    for (const world of [undefined, points.map(p => ({ x: p.x / 1000, y: p.y / 1000, z: p.z / 1000 }))]) {
      const frame = handFrame(geometryResult(points, world), 640, 480);
      assert.equal(frame.pose, 'thumbDown');
      assert.ok(Math.max(frame.measurements.thumb.mcpBend, frame.measurements.thumb.ipBend) > 40);
      const t = setup(); holdPose(t, frame.pose, frame);
      assert.deepEqual(t.commands, ['delete']);
    }
    const sideways = points.map(p => ({ x: 320 + p.y - 288, y: 288 - (p.x - 320), z: p.z }));
    assert.equal(handFrame(geometryResult(sideways), 640, 480).pose, 'fist');
  }
});

test('strong CMC and IP bends reject apparent downward thumbs and cannot request deletion', () => {
  for (const change of [p => { p[1].x += 120; }, p => { p[3].x += 55; },
    p => { p[1] = { ...p[2] }; }, p => { p[3].z = 150; }]) {
    const points = downwardThumb(); change(points);
    const result = geometryResult(points);
    assert.equal(handFrame(result, 640, 480, { thumbExtension: false }).pose, 'thumbDown');
    const frame = handFrame(result, 640, 480);
    assert.equal(frame.pose, 'fist');
    assert.equal(frame.measurements.thumb.extended, false);
    const t = setup(); holdPose(t, frame.pose, frame);
    assert.deepEqual(t.commands, []);
  }
});

test('thumb extension uses world geometry and screen direction stays separate', () => {
  const points = downwardThumb();
  const world = points.map(p => ({ x: p.x / 1000, y: p.y / 1000, z: 0 }));
  world[1].z = .15;
  const frame = handFrame(geometryResult(points, world), 640, 480);
  assert.equal(frame.measurements.space, 'world');
  assert.equal(frame.pose, 'fist');
  assert.equal(frame.measurements.thumb.pointsDown, true);
  const sideways = downwardThumb().map(p => ({ x: 320 + p.y - 288, y: 288 - (p.x - 320), z: p.z }));
  const side = handFrame(geometryResult(sideways), 640, 480);
  assert.equal(side.measurements.thumb.extended, true);
  assert.equal(side.measurements.thumb.pointsDown, false);
  assert.equal(side.pose, 'thumbLeft');
});

test('a thumbs-up tilted left or right is recognized by its side, also when mirrored', () => {
  for (const [sign, pose] of [[1, 'thumbLeft'], [-1, 'thumbRight']]) for (const scale of [.5, 1.5]) {
    const points = downwardThumb().map(p => ({ x: 320 + (p.y - 288) * sign * scale, y: 288 - (p.x - 320) * scale, z: p.z * scale }));
    assert.equal(handFrame(geometryResult(points), 640, 480).pose, pose);
  }
  const upright = downwardThumb().map(p => ({ x: p.x, y: 576 - p.y, z: p.z }));
  assert.equal(handFrame(geometryResult(upright), 640, 480).pose, 'fist');
});

test('dialog presses the tilted side once after a stable hold, and rearms through another pose', () => {
  const t = setup(); t.stable(); t.dialog(true);
  t.stable(.5, .5, { pose: 'thumbLeft' });
  assert.deepEqual(t.dialogEvents, []); assert.ok(t.controller.state.progress > 0);
  holdPose(t, 'thumbLeft'); holdPose(t, 'thumbLeft');
  assert.deepEqual(t.dialogEvents, ['left']);
  holdPose(t, 'thumbRight'); assert.deepEqual(t.dialogEvents, ['left', 'right']);
  for (let i = 0; i < 14; i++) t.feed(.5 + (i % 2) * .1, .5, { pose: 'thumbRight' });
  assert.deepEqual(t.dialogEvents, ['left', 'right']);
  t.dialog(false); holdPose(t, 'thumbLeft');
  assert.deepEqual(t.dialogEvents, ['left', 'right']); assert.deepEqual(t.moves(), []); assert.deepEqual(t.commands, []);
});
for (const mode of ['one', 'mixed']) test(`${mode} fist pans using its own palm`, () => {
  const t = setup({ smoothing: 1, gain: 1, deadzone: 0 });
  const result = offset => handFrame({ landmarks: mode === 'one'
    ? [poseLandmarks('fist').map(p => ({ x: p.x + offset, y: p.y }))]
    : [poseLandmarks('fist').map(p => ({ x: p.x - .2 + offset, y: p.y })),
      poseLandmarks(mode === 'both' ? 'fist' : 'open').map(p => ({ x: p.x + .2 + (mode === 'both' ? offset : 0), y: p.y }))] }, 640, 480);
  const feed = offset => t.feed(.5, .5, result(offset));
  feed(0); feed(0); feed(0); feed(-.05);
  assert.ok(Math.abs(t.pans[0].x - 50) < 1e-8);
  assert.deepEqual(t.moves(), []); assert.deepEqual(t.zooms, []);
});


for (const cause of ['open', 'two', 'loss', 'blocked', 'dialog', 'gap', 'clock', 'jump', 'invalid']) test(`single-fist pan ${cause} stops and reacquires without a jump`, () => {
  const t = setup({ smoothing: 1, gain: 1, deadzone: 0 }), fist = { pose: 'fist' };
  t.stable(.5, .5, fist); t.feed(.45, .5, fist);
  if (cause === 'open') t.feed(.2, .2);
  if (cause === 'two') t.feed(.2, .2, fists);
  if (cause === 'loss') t.lost();
  if (cause === 'blocked') { t.block(true); t.feed(.2, .2, fist); t.block(false); }
  if (cause === 'dialog') { t.dialog(true); t.feed(.2, .2, fist); t.dialog(false); }
  if (cause === 'gap') t.advance(1500);
  if (cause === 'clock') t.advance(-500);
  if (cause === 'invalid') t.feed(NaN, .5, fist);
  t.stable(.1, .2, fist);
  assert.equal(t.pans.length, 1);
  t.feed(.08, .2, fist); assert.equal(t.pans.length, 2);
  assert.ok(Math.abs(t.pans[1].x - 20) < 1e-8);
});

test('palm uses mirrored absolute screen coordinates and clears distant targets', () => {
  const t = setup(); t.feed(); assert.equal(t.selections.length, 0);
  t.stable(); assert.equal(t.controller.state.hover, 'a');
  assert.equal(t.controller.state.pointerVisible, true);
  t.feed(.1, .2); assert.equal(t.controller.state.x, 900); assert.equal(t.controller.state.y, 160);
  assert.equal(t.controller.state.hover, null); assert.equal(t.selections.at(-1), null);
  t.feed(.5, .5); assert.equal(t.selections.at(-1), 'a');
});

test('pointer projection accounts for viewport offsets, mirroring and boundaries', () => {
  const bounds = { left: 100, right: 1100, top: 50, bottom: 850 };
  assert.deepEqual(mapPointer({ x: .2, y: .25 }, bounds), { x: 900, y: 250 });
  assert.deepEqual(mapPointer({ x: -1, y: 2 }, bounds), { x: 1100, y: 850 });
});

test('proximity uses actual displayed size, nearest edges and deterministic ties', () => {
  const a = { id: 'a', left: 100, right: 200, top: 100, bottom: 140 };
  const b = { id: 'b', left: 250, right: 350, top: 100, bottom: 140 };
  assert.equal(proximityTarget([b, a], { x: 225, y: 120 }), 'a');
  assert.equal(proximityTarget([a, b], { x: 230, y: 120 }), 'b');
  assert.equal(proximityTarget([a], { x: 150, y: 160 }), 'a');
  assert.equal(proximityTarget([a], { x: 150, y: 165 }), 'a');
  assert.equal(proximityTarget([a], { x: 260, y: 120 }), 'a');
  assert.equal(proximityTarget([a], { x: 150, y: 167 }), null);
  assert.equal(proximityTarget([a], { x: 266, y: 120 }), null);
  const scaled = { id: 'a', left: 200, right: 400, top: 200, bottom: 280 };
  assert.equal(proximityTarget([scaled], { x: 300, y: 320 }), 'a');
});

for (const pose of ['point', 'bothFists']) test(`${pose} without radial hand motion never selects, moves a node or moves the view`, () => {
  const t = setup(); t.stable(); const count = t.selections.length;
  for (let i = 0; i < 20; i++) t.feed(.1 + i * .03, .2, { pose, ratio: .1, ...(pose === 'bothFists' ? { hands: 2, distance: .4 } : {}) });
  assert.equal(t.selections.length, count); assert.equal(t.controller.state.hover, null);
  assert.equal(t.controller.state.pointerVisible, false);
  assert.deepEqual([...t.dragEvents, ...t.zooms, ...t.pans, ...t.moves(), ...t.commands], []);
});

for (const cause of ['loss', 'blocked', 'identity', 'wrist', 'gap', 'clock', 'malformed']) test(`${cause} hides the pointer and requires a stable palm again`, () => {
  const t = setup(); t.stable();
  if (cause === 'loss') t.lost();
  if (cause === 'blocked') { t.block(true); t.feed(); t.block(false); }
  if (cause === 'gap') t.advance(1500);
  if (cause === 'clock') t.advance(-500);
  if (cause === 'malformed') t.feed(NaN);
  const extra = cause === 'identity' ? { identity: 'Right' } : cause === 'wrist' ? { wrist: { x: .1, y: .1 } } : {};
  t.feed(.1, .1, extra); assert.equal(t.controller.state.state, 'waiting'); assert.equal(t.controller.state.hover, null);
  t.stable(.1, .1, extra); assert.equal(t.controller.state.state, 'ready'); assert.equal(t.controller.state.hover, null);
});

for (const mode of ['waiting', 'empty', 'blocked', 'dialog', 'zoom']) test(`palm pointer stays visible during ${mode}`, () => {
  const t = setup();
  if (mode === 'blocked') t.block(true);
  if (mode === 'dialog') t.dialog(true);
  const extra = mode === 'zoom' ? { hands: 2, distance: .4, palmPointer: { x: .2, y: .3 } } : {};
  t.feed(.2, .3, extra);
  assert.equal(t.controller.state.pointerVisible, true);
  assert.deepEqual(t.controller.state.pointer, { x: 800, y: 240 });
  if (mode !== 'waiting') {
    t.stable(.2, .3, extra);
    assert.equal(t.controller.state.pointerVisible, true);
  }
  assert.equal(t.controller.state.hover, null);
  t.lost(); assert.equal(t.controller.state.pointerVisible, false);
});

test('two open or pinching hands cannot zoom or move nodes', () => {
  const t = setup();
  const feed = (distance, pinch) => {
    const hands = [-1, 1].map(sign => {
      const points = poseLandmarks('open');
      if (pinch) points[8] = { ...points[4] };
      return points.map(p => ({ x: p.x + sign * distance / 2, y: p.y }));
    });
    const frame = handFrame({ landmarks: hands }, 640, 480);
    assert.equal(frame.pose, 'neutral');
    t.feed(.5, .5, frame);
  };
  feed(.4, false); feed(.4, false); feed(.4, false);
  feed(.4, true); feed(.5, true);
  feed(.4, true); assert.deepEqual(t.zooms, []);
  assert.deepEqual(t.dragEvents, []); assert.deepEqual(t.pans, []);
  assert.equal(t.controller.state.pointerVisible, false);
  feed(.4, false); assert.equal(t.controller.state.pointerVisible, true);
});

test('two-hand command poses still cannot zoom', () => {
  const t = setup();
  for (const offset of [0, 0, 0, .1]) {
    const peace = poseLandmarks('point');
    for (const i of [10, 11, 12]) peace[i] = poseLandmarks('open')[i];
    const frame = handFrame({ landmarks: [peace.map(p => ({ x: p.x - .2 - offset, y: p.y })),
      poseLandmarks('open').map(p => ({ x: p.x + .2 + offset, y: p.y }))] }, 640, 480);
    assert.equal(frame.pose, 'neutral');
    t.feed(.5, .5, frame);
  }
  assert.deepEqual(t.zooms, []); assert.deepEqual(t.commands, []);
});


test('brief uncertain palm frames keep the pointer, hover and ready state without reacquiring', () => {
  const t = setup(); t.stable();
  for (let i = 0; i < 12; i++) {
    t.feed(.5, .5, { pose: i % 3 ? null : 'palm', ratio: i % 3 ? .5 : .8 });
    assert.equal(t.controller.state.pointerVisible, true);
    assert.equal(t.controller.state.state, 'ready');
    assert.equal(t.controller.state.hover, 'a');
  }
});

test('uncertain palm grace expires and cannot create a pointer without an earlier palm', () => {
  const t = setup();
  t.feed(.5, .5, { pose: null }); assert.equal(t.controller.state.pointerVisible, false);
  t.stable();
  for (let i = 0; i < 4; i++) {
    t.feed(.5, .5, { pose: null }); assert.equal(t.controller.state.pointerVisible, true);
  }
  t.feed(.5, .5, { pose: null });
  assert.equal(t.controller.state.pointerVisible, false);
  assert.equal(t.controller.state.state, 'neutral');
  t.feed(); assert.equal(t.controller.state.state, 'waiting');
});

for (const pose of ['fist', 'point', 'peace', 'thumbDown', 'pinch']) test(`palm grace ends immediately for ${pose}`, () => {
  const t = setup(); t.stable();
  t.feed(.5, .5, { pose: pose === 'pinch' ? null : pose, ratio: pose === 'pinch' ? .1 : .8 });
  assert.equal(t.controller.state.pointerVisible, false);
  t.feed(.5, .5, { pose: null }); assert.equal(t.controller.state.pointerVisible, false);
});

for (const cause of ['loss', 'identity', 'wrist', 'gap', 'clock', 'malformed']) test(`palm grace does not bridge ${cause}`, () => {
  const t = setup(); t.stable();
  if (cause === 'loss') t.lost();
  if (cause === 'gap') t.advance(1500);
  if (cause === 'clock') t.advance(-500);
  t.feed(cause === 'malformed' ? NaN : .5, .5, { pose: null,
    ...(cause === 'identity' ? { identity: 'Right' } : {}),
    ...(cause === 'wrist' ? { wrist: { x: .1, y: .1 } } : {}) });
  assert.equal(t.controller.state.pointerVisible, false);
});

test('landmark-based two-fist zoom stops on opening and reacquires its distance baseline', () => {
  const t = setup();
  const feed = (distance, pose = 'fist') => {
    const frame = handFrame({ landmarks: [-1, 1].map(sign =>
      poseLandmarks(pose).map(p => ({ x: p.x + sign * distance / 2, y: p.y }))) }, 640, 480);
    t.feed(.5, .5, frame);
  };
  feed(.4); feed(.4); feed(.4); feed(.5); assert.ok(t.zooms[0] < 1);
  feed(.4); assert.ok(t.zooms[1] > 1);
  assert.equal(t.controller.state.pointerVisible, false);
  feed(.6, 'open'); feed(.7, 'open'); assert.equal(t.zooms.length, 2);
  feed(.6); feed(.6); feed(.6); assert.equal(t.zooms.length, 2);
  feed(.7); assert.ok(t.zooms[2] < 1);
  assert.deepEqual(t.pans, []); assert.deepEqual(t.dragEvents, []);
});

function crossedIndexLandmarks() {
  return [1, -1].map(sign => poseLandmarks('point').map(p => {
    const x = (p.x - .38) * 640, y = (p.y - .6) * 480;
    return { x: .5 - sign * .08 + (x - sign * y) * Math.SQRT1_2 / 640,
      y: .6 + (sign * x + y) * Math.SQRT1_2 / 480 };
  }));
}

test('crossed index fingers are recognized in either order and mirrored images', () => {
  const hands = crossedIndexLandmarks();
  for (const landmarks of [hands, [...hands].reverse(), hands.map(h => h.map(p => ({ x: 1 - p.x, y: p.y })))]) {
    assert.equal(handFrame({ landmarks }, 640, 480).pose, 'cross');
  }
  for (const landmarks of [
    [poseLandmarks('point'), poseLandmarks('point')],
    hands.map((h, i) => h.map(p => ({ x: p.x + i * .4, y: p.y }))),
    [hands[0], poseLandmarks('open')],
    [hands[0]],
  ]) assert.notEqual(handFrame({ landmarks }, 640, 480).pose, 'cross');
});

for (const mode of ['normal', 'blocked', 'dialog', 'paused']) test(`cross disables once after a short hold during ${mode}`, () => {
  const t = setup(); let disabled = 0;
  t.controller.io.disable = () => disabled++;
  if (mode === 'blocked') t.block(true);
  if (mode === 'dialog') t.dialog(true);
  if (mode === 'paused') t.controller.paused = true;
  const frame = handFrame({ landmarks: crossedIndexLandmarks() }, 640, 480);
  t.stable(.5, .5, frame); assert.equal(disabled, 0);
  assert.equal(t.controller.state.state, 'disableWaiting');
  assert.equal(t.controller.state.pointerVisible, false);
  for (let i = 0; i < 12; i++) t.feed(.5, .5, frame);
  assert.equal(disabled, 1);
  assert.deepEqual([...t.commands, ...t.pans, ...t.zooms, ...t.selections], []);
});

for (const cause of ['loss', 'pose', 'gap', 'clock', 'cancel']) test(`${cause} resets the cross hold`, () => {
  const t = setup(); let disabled = 0;
  t.controller.io.disable = () => disabled++;
  const frame = { hands: 2, pose: 'cross', distance: .2 };
  for (let i = 0; i < 5; i++) t.feed(.5, .5, frame);
  if (cause === 'loss') t.lost();
  if (cause === 'pose') t.feed();
  if (cause === 'gap') t.advance(1500);
  if (cause === 'clock') t.advance(-500);
  if (cause === 'cancel') t.controller.cancel();
  t.stable(.5, .5, frame); assert.equal(disabled, 0);
  for (let i = 0; i < 5; i++) t.feed(.5, .5, frame);
  assert.equal(disabled, 1);
});


test('pinch centers the palm-selected node once, retains it through motion, and rearms on a fresh palm', () => {
  const t = setup(); t.stable();
  t.feed(.1, .2, { ratio: .1 });
  assert.deepEqual(t.centers, ['a']);
  assert.equal(t.controller.state.hover, 'a');
  assert.equal(t.controller.state.state, 'centered');
  for (let i = 0; i < 20; i++) t.feed(.1, .2, { ratio: i % 2 ? .4 : .1 });
  assert.deepEqual(t.centers, ['a']);
  t.stable(); t.feed(.5, .5, { ratio: .1 });
  assert.deepEqual(t.centers, ['a', 'a']);
  assert.deepEqual([...t.dragEvents, ...t.pans, ...t.zooms, ...t.commands], []);
});

for (const cause of ['unarmed', 'waiting', 'empty', 'loss', 'blocked', 'identity', 'wrist', 'gap', 'clock', 'malformed', 'two', 'point', 'paused']) test(`pinch cannot center after ${cause}`, () => {
  const t = setup();
  if (cause === 'waiting') t.feed();
  else if (cause !== 'unarmed') t.stable();
  if (cause === 'empty') t.feed(.1, .1);
  if (cause === 'loss') t.lost();
  if (cause === 'blocked') t.block(true);
  if (cause === 'gap') t.advance(1500);
  if (cause === 'clock') t.advance(-500);
  if (cause === 'point') t.feed(.5, .5, { pose: 'point' });
  if (cause === 'paused') t.controller.paused = true;
  t.feed(cause === 'malformed' ? NaN : .5, .5, { ratio: .1,
    ...(cause === 'identity' ? { identity: 'Right' } : {}),
    ...(cause === 'wrist' ? { wrist: { x: .1, y: .1 } } : {}),
    ...(cause === 'two' ? { hands: 2, distance: .4, pose: 'neutral' } : {}) });
  assert.deepEqual(t.centers, []);
});


test('landmark-derived palm then 3D pinch centers the selected node', () => {
  const t = setup();
  const points = poseLandmarks('open');
  const palm = handFrame({ landmarks: [points] }, 640, 480);
  const point = mapPointer(palm.pointer, t.controller.io.bounds());
  t.controller.io.nodes = () => [{ id: 'landmark', left: point.x - 50, right: point.x + 50, top: point.y - 40, bottom: point.y + 40 }];
  t.stable(.5, .5, palm);
  points[8] = { ...points[4] };
  const pinch = handFrame({ landmarks: [points] }, 640, 480);
  assert.equal(pinch.pose, null);
  t.stable(.5, .5, pinch);
  assert.deepEqual(t.centers, ['landmark']);
});
