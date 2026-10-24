const assert = require('node:assert/strict');
const { test } = require('node:test');
const MapLocks = require('../ui-prototype/storage/locks.js');

// Exclusive Web Locks with ifAvailable, signal and query, shared by every "tab".
function lockManager() {
  const held = new Map(), queue = [];
  function grant() {
    for (const entry of [...queue]) if (!held.has(entry.name)) { queue.splice(queue.indexOf(entry), 1); run(entry); }
  }
  function run(entry) {
    held.set(entry.name, entry);
    Promise.resolve(entry.callback({ name: entry.name })).then(entry.resolve, entry.reject).finally(() => { held.delete(entry.name); grant(); });
  }
  return {
    request(name, options, callback) {
      return new Promise((resolve, reject) => {
        const entry = { name, callback, resolve, reject };
        if (!held.has(name)) { run(entry); return; }
        if (options.ifAvailable) { Promise.resolve(callback(null)).then(resolve, reject); return; }
        queue.push(entry);
        options.signal?.addEventListener('abort', () => { const i = queue.indexOf(entry); if (i >= 0) { queue.splice(i, 1); reject(new Error('AbortError')); } });
      });
    },
    async query() { return { held: [...held.keys()].map(name => ({ name })), pending: queue.map(e => ({ name: e.name })) }; },
  };
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('one tab edits a map; the other becomes editable once it is released', async () => {
  const locks = lockManager();
  let granted = 0;
  const first = await MapLocks.claim('a', { locks });
  const second = await MapLocks.claim('a', { locks, granted: () => granted++ });
  assert.equal(first.editable, true);
  assert.equal(second.editable, false);
  assert.deepEqual([...await MapLocks.busy(locks)], ['a']);
  first.release(); await tick();
  assert.equal(second.editable, true);
  assert.equal(granted, 1);
  second.release(); await tick();
  assert.deepEqual([...await MapLocks.busy(locks)], []);
});

test('different maps are editable at the same time', async () => {
  const locks = lockManager();
  const a = await MapLocks.claim('a', { locks }), b = await MapLocks.claim('b', { locks });
  assert.equal(a.editable && b.editable, true);
  assert.deepEqual([...await MapLocks.busy(locks)].sort(), ['a', 'b']);
});

test('a released waiting claim never takes the lock; wait: false does not queue', async () => {
  const locks = lockManager();
  const owner = await MapLocks.claim('a', { locks });
  const waiting = await MapLocks.claim('a', { locks }), probe = await MapLocks.claim('a', { locks, wait: false });
  waiting.release();
  assert.equal(probe.editable, false);
  assert.deepEqual((await locks.query()).pending, []);
  owner.release(); await tick();
  assert.equal(waiting.editable, false);
  assert.equal((await MapLocks.claim('a', { locks })).editable, true);
});

test('without Web Locks every map is editable', async () => {
  assert.equal((await MapLocks.claim('a', { locks: null })).editable, true);
});

test('other tabs holding or waiting for any map lock are counted, excluding this tab', async () => {
  const locks = lockManager();
  const mine = await MapLocks.claim('a', { locks });
  assert.equal(await MapLocks.others('a', locks), 0);
  const elsewhere = await MapLocks.claim('b', { locks });
  assert.equal(await MapLocks.others('a', locks), 1);
  elsewhere.release(); await tick();
  await MapLocks.claim('a', { locks });
  assert.equal(await MapLocks.others('a', locks), 1);
  mine.release();
});
