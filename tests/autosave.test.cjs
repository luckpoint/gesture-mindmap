const assert = require('node:assert/strict');
const { test } = require('node:test');
const { create } = require('../ui-prototype/core/autosave.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function setup() {
  const timers = new Map(),
    statuses = [],
    writes = [],
    recovered = [];
  let value = 0,
    nextTimer = 0;
  const autosave = create({
    capture: () => ({ value }),
    persist(batch) {
      const gate = deferred();
      writes.push({ batch, ...gate });
      return gate.promise;
    },
    recover: batch => recovered.push(batch),
    status: s => statuses.push(s),
    setTimer(fn, delay) {
      timers.set(++nextTimer, { fn, delay });
      return nextTimer;
    },
    clearTimer: id => timers.delete(id),
  });
  return {
    autosave,
    timers,
    statuses,
    writes,
    recovered,
    edit(n) {
      value = n;
      autosave.schedule();
    },
  };
}
// Let a flush pass its idle check without running wall-clock timers.
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

test('autosave debounces edits for 500ms and captures the latest state', async () => {
  const t = setup();
  t.edit(1);
  t.edit(2);
  assert.equal(t.timers.size, 1);
  const timer = [...t.timers.values()][0];
  assert.equal(timer.delay, 500);
  timer.fn();
  await tick();
  assert.equal(t.timers.size, 0);
  assert.deepEqual(t.writes[0].batch, { value: 2 });
  t.writes[0].resolve();
  await tick();
  assert.equal(t.statuses.at(-1), 'saved');
  assert.equal(t.autosave.dirty, false);
  await t.autosave.flush();
  assert.equal(t.writes.length, 1);
});

test('edits during a write remain pending and concurrent flushes serialize writes', async () => {
  const t = setup();
  t.edit(1);
  const first = t.autosave.flush();
  await tick();
  t.edit(2);
  const second = t.autosave.flush(),
    third = t.autosave.flush();
  let thirdFinished = false;
  third.then(() => {
    thirdFinished = true;
  });
  await tick();
  assert.equal(t.writes.length, 1);
  t.writes[0].resolve();
  await first;
  await tick();
  assert.equal(t.writes.length, 2);
  assert.deepEqual(
    t.writes.map(w => w.batch.value),
    [1, 2],
  );
  assert.equal(thirdFinished, false);
  assert.equal(t.statuses.includes('saved'), false);
  t.writes[1].resolve();
  await Promise.all([second, third]);
  assert.equal(t.statuses.at(-1), 'saved');
  assert.equal(t.autosave.dirty, false);
});

test('a failed write recovers its batch and a retry captures edits made during the write', async () => {
  const t = setup();
  t.edit(1);
  const first = t.autosave.flush();
  await tick();
  t.edit(2);
  t.writes[0].reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  assert.deepEqual(t.recovered, [{ value: 1 }]);
  assert.equal(t.autosave.dirty, true);
  assert.equal(t.statuses.at(-1), 'error');
  const retry = t.autosave.flush();
  await tick();
  assert.deepEqual(t.writes[1].batch, { value: 2 });
  t.writes[1].resolve();
  await retry;
  assert.equal(t.statuses.at(-1), 'saved');
});

for (const failure of [false, true]) {
  test(`reset isolates a new map from an old write (${failure ? 'failure' : 'success'})`, async () => {
    const t = setup();
    t.edit(1);
    const old = t.autosave.flush();
    await tick();
    t.edit(2);
    t.autosave.reset();
    assert.equal(t.timers.size, 0);
    assert.equal(t.autosave.dirty, false);
    const statusCount = t.statuses.length;
    if (failure) {
      t.writes[0].reject(new Error('old map'));
      await assert.rejects(old, /old map/);
    } else {
      t.writes[0].resolve();
      await old;
    }
    assert.equal(t.statuses.length, statusCount);
    assert.deepEqual(t.recovered, []);
    assert.equal(t.autosave.dirty, false);
    t.edit(3);
    const next = t.autosave.flush();
    await tick();
    t.writes[1].resolve();
    await next;
    assert.deepEqual(t.writes[1].batch, { value: 3 });
  });
}

test('suspend waits for a write and returns failed work for rescheduling after deletion fails', async () => {
  const t = setup();
  t.edit(1);
  const first = t.autosave.flush();
  await tick();
  const paused = t.autosave.suspend();
  t.writes[0].reject(new Error('offline'));
  await assert.rejects(first, /offline/);
  assert.equal(await paused, true);
  assert.equal(t.autosave.dirty, false);
  assert.equal(t.timers.size, 0);
  t.autosave.schedule();
  const retry = t.autosave.flush();
  await tick();
  t.writes[1].resolve();
  await retry;
  assert.equal(t.statuses.at(-1), 'saved');
});
