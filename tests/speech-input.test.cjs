const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../ui-prototype/speech/controller.js');
function setup() {
  const instances = [], timers = new Map(); let next = 0;
  class Recognition {
    constructor() { instances.push(this); }
    start() { this.started = true; }
    stop() { this.stopped = true; }
    abort() { this.aborted = true; this.onend?.(); }
  }
  const c = new Controller({ Recognition, setTimer: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimer: id => timers.delete(id) });
  let text = 'base', interim = '', valid = true, ended = [];
  const target = { valid: () => valid, read: () => text, write: (t, i) => { text = t; interim = i; }, end: e => ended.push(e) };
  return { c, instances, timers, target, state: () => ({ text, interim, ended }), invalidate: () => { valid = false; } };
}
function result(r, entries, resultIndex = 0) {
  r.onresult({ resultIndex, results: entries.map(([transcript, isFinal]) => Object.assign([{ transcript }], { isFinal })) });
}
test('speech uses one Japanese session, replaces indexed results and separates interim text', () => {
  const s = setup(); s.c.start(s.target); const r = s.instances[0];
  assert.equal(r.lang, 'ja-JP'); assert.equal(r.continuous, false);
  assert.equal(s.c.start(s.target), false); r.onstart();
  result(r, [['one', false]]); assert.deepEqual(s.state(), { text: 'base', interim: 'one', ended: [] });
  result(r, [['first', true], ['next', false]]);
  result(r, [['first', true], ['second', true]], 1);
  result(r, [['first', true], ['second', true]], 1);
  assert.equal(s.state().text, 'basefirstsecond');
  s.c.stop(); assert.equal(r.stopped, true); assert.equal(s.c.state, 'stopping');
  r.onend(); assert.deepEqual(s.state().ended, [null]); assert.equal(s.c.active, false);
});
test('abort invalidates synchronously, including events delivered by abort and older sessions', () => {
  const s = setup(); s.c.start(s.target); const old = s.instances[0];
  s.c.abort(); s.c.start(s.target);
  result(old, [['late', true]]); old.onstart(); old.onerror({ error: 'network' }); old.onend();
  assert.equal(s.state().text, 'base'); assert.equal(s.c.state, 'starting'); assert.deepEqual(s.state().ended, []);
});
test('changing targets cancels results without writing or completing', () => {
  const s = setup(); s.c.start(s.target); s.invalidate(); result(s.instances[0], [['wrong map', true]]);
  assert.equal(s.instances[0].aborted, true); assert.equal(s.c.active, false); assert.equal(s.state().text, 'base');
});
test('errors retain final drafts, reject late results and never report success', () => {
  const s = setup(); s.c.start(s.target); const r = s.instances[0];
  result(r, [['kept', true], ['discard', false]]); r.onerror({ error: 'network' });
  result(r, [['late', true]]); r.onend();
  assert.equal(s.state().text, 'basekept'); assert.deepEqual(s.state().ended, ['network']);
});
test('start and stop deadlines recover without late completion', () => {
  for (const stop of [false, true]) {
    const s = setup(); s.c.start(s.target); const r = s.instances[0];
    if (stop) { r.onstart(); s.c.stop(); }
    const timer = [...s.timers.values()][0]; assert.equal(timer.ms, stop ? 5000 : 15000); timer.fn();
    assert.equal(r.aborted, true); assert.equal(s.c.state, 'idle'); assert.deepEqual(s.state().ended, ['timeout']);
    r.onend(); assert.deepEqual(s.state().ended, ['timeout']);
  }
});
test('empty recognition, synchronous start failure and missing APIs are recoverable', () => {
  const s = setup(); s.c.start(s.target); s.instances[0].onend(); assert.deepEqual(s.state().ended, ['no-speech']);
  s.c.Recognition = class { start() { throw Error('denied'); } abort() {} };
  s.c.start(s.target); assert.equal(s.c.active, false); assert.equal(s.state().ended.at(-1), 'start-failed');
  s.c.Recognition = undefined; assert.equal(s.c.supported, false); assert.equal(s.c.start(s.target), false);
});
