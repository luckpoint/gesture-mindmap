/* One editing tab per map, held through Web Locks for as long as the map is open. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapLocks = api;
})(globalThis, () => {
  'use strict';
  const PREFIX = 'mindmap:map:';
  const manager = () => globalThis.navigator?.locks;
  function hold(locks, name, options) {
    return new Promise((resolve, reject) => {
      let release;
      const held = new Promise(r => {
        release = r;
      });
      locks
        .request(name, options, lock => {
          resolve(lock ? release : null);
          return lock && held;
        })
        .catch(reject);
    });
  }
  async function claim(id, { locks = manager(), wait = true, granted = () => {} } = {}) {
    if (!locks) return { editable: true, release() {} };
    const name = PREFIX + id,
      controller = new AbortController();
    let release = await hold(locks, name, { ifAvailable: true }),
      closed = false;
    const result = {
      editable: !!release,
      release() {
        closed = true;
        controller.abort();
        release?.();
      },
    };
    if (!release && wait)
      hold(locks, name, { signal: controller.signal }).then(
        r => {
          if (closed) {
            r();
            return;
          }
          release = r;
          result.editable = true;
          granted();
        },
        () => {},
      );
    return result;
  }
  async function busy(locks = manager()) {
    if (!locks) return new Set();
    const { held = [] } = await locks.query();
    return new Set(held.filter(l => l.name.startsWith(PREFIX)).map(l => l.name.slice(PREFIX.length)));
  }
  // Map locks held or awaited by any tab, except the one this tab holds.
  async function others(own, locks = manager()) {
    if (!locks) return 0;
    const { held = [], pending = [] } = await locks.query(),
      mine = own && PREFIX + own;
    return (
      held.filter(l => l.name.startsWith(PREFIX) && l.name !== mine).length +
      pending.filter(l => l.name.startsWith(PREFIX)).length
    );
  }
  return { claim, busy, others, PREFIX };
});
