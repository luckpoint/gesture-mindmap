const assert = require('node:assert/strict');
const { test } = require('node:test');
const { HandController, TRACKING_TIMEOUT_MS } = require('../ui-prototype/gestures/controller.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
const vm = require('node:vm');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

function setup(options = {}) {
  const timers = new Map(), intervals = new Map(), frames = new Map(), events = [], workers = [];
  let counter = 0, now = 1000;
  const track = { stops: 0, stop() { this.stops++; }, getSettings: () => ({ deviceId: 'front' }) };
  const stream = { getTracks: () => [track], getVideoTracks: () => [track] };
  const video = { currentTime: 1, videoWidth: 640, videoHeight: 480, readyState: 2, async play() {}, pause() { events.push('pause'); } };
  class Worker {
    constructor(url) { this.url = url; this.messages = []; workers.push(this); }
    postMessage(data, transfer) {
      this.messages.push({ data, transfer });
      if (data.type === 'init' && !options.hangInit) queueMicrotask(() => this.onmessage({ data: { type: 'ready' } }));
    }
    terminate() { this.terminated = true; }
  }
  const bitmaps = [];
  const context = vm.createContext({
    isSecureContext: true,
    navigator: { languages: ['ja'], mediaDevices: { getUserMedia: options.getUserMedia || (async () => stream), enumerateDevices: async () => options.devices || [] } },
    Worker, performance: { now: () => now },
    createImageBitmap: options.createImageBitmap || (async () => { const b = { closes: 0, close() { this.closes++; } }; bitmaps.push(b); return b; }),
    requestAnimationFrame: fn => { frames.set(++counter, fn); return counter; }, cancelAnimationFrame: id => frames.delete(id),
    setTimeout: fn => { timers.set(++counter, fn); return counter; }, clearTimeout: id => timers.delete(id),
    setInterval: fn => { intervals.set(++counter, fn); return counter; }, clearInterval: id => intervals.delete(id),
    HandGestures: { TRACKING_TIMEOUT_MS, handFrame: () => ({ pointer: { x: .5, y: .5 }, wrist: { x: .5, y: .7 }, ratio: .8, pose: 'palm', identity: 'Left' }) },
  });
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/i18n.js'), 'utf8'), context);
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/gestures/camera.js'), 'utf8'), context);
  const session = new context.CameraSession({ video, status: s => events.push(s), error: e => events.push(['error', e]), frame: (...args) => events.push(['frame', ...args]), metrics: m => events.push(['metrics', m]), cameras: (...args) => events.push(['cameras', ...args]) });
  return { session, context, timers, intervals, frames, events, workers, track, stream, video, bitmaps, advance: n => { now += n; } };
}

test('camera denial reports an actionable error and does not start a worker', async () => {
  const t = setup({ getUserMedia: async () => { throw Object.assign(new Error('denied'), { name: 'NotAllowedError' }); } });
  await t.session.start();
  assert.equal(t.session.closed, true);
  assert.equal(t.workers.length, 0);
  assert.match(t.events.at(-1)[1], /許可されません/);
});

test('selected camera is requested exactly and available cameras are reported', async () => {
  const requests = [];
  const devices = [{ kind: 'videoinput', deviceId: 'front', label: 'FaceTime' }, { kind: 'audioinput', deviceId: 'mic' }, { kind: 'videoinput', deviceId: 'usb', label: 'USB' }];
  const t = setup({ devices, getUserMedia: async c => { requests.push(c); return t.stream; } });
  await t.session.start('worker', 'usb');
  assert.equal(requests[0].video.deviceId.exact, 'usb');
  const [, cameras, active] = t.events.find(e => e[0] === 'cameras');
  assert.equal(cameras.map(c => c.deviceId).join(), 'front,usb');
  assert.equal(active, 'front');
  t.session.stop();
});

test('a camera that no longer exists falls back to the default camera', async () => {
  const requests = [];
  const t = setup({ getUserMedia: async c => {
    requests.push(c);
    if (c.video.deviceId) throw Object.assign(new Error('gone'), { name: 'OverconstrainedError' });
    return t.stream;
  } });
  await t.session.start('worker', 'unplugged');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].video.facingMode, 'user');
  assert.equal(t.session.closed, false);
  t.session.stop();
});

test('stopping during a pending permission prompt stops a late stream', async () => {
  let resolve;
  const t = setup({ getUserMedia: () => new Promise(r => resolve = r) });
  const started = t.session.start(); t.session.stop(); resolve(t.stream); await started;
  assert.equal(t.track.stops, 1);
  assert.equal(t.workers.length, 0);
});

test('only one frame is in flight, and inference/display timings are separate', async () => {
  const t = setup(); await t.session.start(); await Promise.resolve();
  t.advance(50); t.video.currentTime++; t.session.loop(); await Promise.resolve();
  const worker = t.workers[0], messages = worker.messages.filter(m => m.data.type === 'frame');
  assert.equal(messages.length, 1);
  assert.equal(messages[0].transfer[0], messages[0].data.bitmap);
  t.advance(50);
  worker.onmessage({ data: { type: 'result', result: {}, inferenceMs: 17 } });
  assert.equal(t.session.busy, false);
  const metricFrame = [...t.frames.values()].at(-1); metricFrame();
  const metric = t.events.find(e => e[0] === 'metrics')[1];
  assert.equal(metric.inferenceMs, 17);
  assert.equal(metric.hands, 0);
  assert.equal(metric.frameValid, true); // This test injects a valid frame adapter.
  assert.equal(new URL(t.workers[0].url, 'http://localhost/').searchParams.get('v'), metric.revision);
  assert.equal(metric.displayMs, 100);
  assert.equal(t.events.filter(e => e[0] === 'frame').length, 1);
  t.session.stop();
});

test('stopping while creating a bitmap closes it instead of transferring it', async () => {
  let resolve;
  const bitmap = { closed: false, close() { this.closed = true; } };
  const t = setup({ createImageBitmap: () => new Promise(r => resolve = r) });
  await t.session.start(); t.session.stop(); resolve(bitmap); await tick();
  assert.equal(bitmap.closed, true);
  assert.equal(t.workers[0].messages.some(m => m.data.type === 'frame'), false);
});

test('worker initialization failure releases tracks, video, timers and worker', async () => {
  const t = setup({ hangInit: true });
  const start = t.session.start(); await tick();
  t.workers[0].onmessage({ data: { type: 'error', message: 'model missing' } }); await start;
  assert.equal(t.track.stops, 1);
  assert.equal(t.video.srcObject, null);
  assert.equal(t.intervals.size, 0);
  assert.equal(t.events.filter(e => e[0] === 'error').length, 1);
  for (const callback of t.timers.values()) callback();
  assert.equal(t.workers[0].terminated, true);
});

test('hung worker initialization times out and stops camera', async () => {
  const t = setup({ hangInit: true });
  const start = t.session.start(); await tick();
  [...t.timers.values()][0](); await start;
  assert.equal(t.track.stops, 1);
  assert.match(t.events.at(-1)[1], /タイムアウト/);
});

test('stale frames suspend tracking even if worker never responds', async () => {
  const t = setup(); await t.session.start();
  t.advance(TRACKING_TIMEOUT_MS + 100); [...t.intervals.values()][0]();
  assert.equal(t.events.at(-1)[0], 'frame');
  assert.equal(t.events.at(-1)[1], null);
  t.advance(5000); [...t.intervals.values()][0]();
  assert.equal(t.session.closed, true);
  assert.equal(t.track.stops, 1);
});

for (const throws of [false, true]) test(`worker closes the transferred image when inference ${throws ? 'fails' : 'succeeds'}`, async () => {
  const messages = []; let closed = false, detectorClosed = false, options;
  class OffscreenCanvas { constructor(w, h) { this.width = w; this.height = h; } }
  const context = vm.createContext({
    URL, OffscreenCanvas, performance: { now: () => 123 },
    location: { href: 'http://localhost/gestures/hand-worker.js' },
    postMessage: m => messages.push(m), close() {},
    importScripts: () => {
      context.module.exports = {
        FilesetResolver: { forVisionTasks: async () => ({}) },
        HandLandmarker: { createFromOptions: async (_, o) => (options = o, { detectForVideo() { if (throws) throw new Error('inference failed'); return { landmarks: [] }; }, close() { detectorClosed = true; } }) },
      };
    },
  });
  context.self = context;
  vm.runInContext(readFileSync(join(__dirname, '../ui-prototype/gestures/hand-worker.js'), 'utf8'), context);
  await context.onmessage({ data: { type: 'init' } });
  assert.equal(messages[0].type, 'ready');
  assert.ok(options.canvas instanceof OffscreenCanvas);
  await context.onmessage({ data: { type: 'frame', bitmap: { close() { closed = true; } }, timestamp: 1 } });
  assert.equal(closed, true);
  assert.equal(messages[1].type, throws ? 'error' : 'result');
  await context.onmessage({ data: { type: 'stop' } }); assert.equal(detectorClosed, true);
});

test('300ms worker results survive the watchdog and arm directional navigation', async () => {
  const t = setup();
  const controller = new HandController({ blocked: () => false, nodes: () => [], select() {}, bounds: () => ({ left: 0, top: 0, right: 1000, bottom: 800 }), paint() {} });
  t.session.io.frame = (frame, at) => controller.update(frame, at);
  await t.session.start();
  const watch = [...t.intervals.values()][0];
  for (let i = 0; i < 5; i++) {
    t.advance(250); watch();
    t.advance(50); t.workers[0].onmessage({ data: { type: 'result', result: {}, inferenceMs: 250 } });
  }
  assert.equal(controller.state.state, 'ready');
  t.advance(TRACKING_TIMEOUT_MS + 100); watch();
  assert.equal(controller.state.state, 'lost');
  t.workers[0].onmessage({ data: { type: 'result', result: {}, inferenceMs: 250 } });
  assert.equal(controller.state.state, 'waiting');
  t.advance(300); t.workers[0].onmessage({ data: { type: 'result', result: {}, inferenceMs: 250 } });
  assert.equal(controller.state.state, 'ready');
  t.session.stop();
});

test('HTML and camera worker use the same revision to avoid mixing cached code', async () => {
  const html = readFileSync(join(__dirname, '../ui-prototype/index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="(gestures\/[^" ]+)"/g)].map(m => new URL(m[1], 'http://localhost/'));
  assert.equal(scripts.length, 3);
  const revisions = scripts.map(url => url.searchParams.get('v'));
  assert.ok(revisions[0]);
  assert.ok(revisions.every(v => v === revisions[0]));
  const t = setup(); await t.session.start();
  assert.equal(new URL(t.workers[0].url, 'http://localhost/').searchParams.get('v'), revisions[0]);
  t.session.stop();
});


test('debug receives raw results and clears on tracking timeout and stop', async () => {
  const t = setup(), debug = [];
  t.session.io.debug = (...args) => debug.push(args);
  await t.session.start();
  const result = { landmarks: [] };
  t.workers[0].onmessage({ data: { type: 'result', result, inferenceMs: 10 } });
  assert.equal(debug[0][0], result);
  assert.equal(debug[0][1], 640); assert.equal(debug[0][2], 480);
  t.advance(TRACKING_TIMEOUT_MS + 1); [...t.intervals.values()][0]();
  assert.equal(debug.at(-1)[0], null);
  t.session.stop(); assert.equal(debug.at(-1)[0], null);
  const count = debug.length;
  t.session.result(result, 10); assert.equal(debug.length, count);
});
