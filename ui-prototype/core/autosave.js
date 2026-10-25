// DOM-free save scheduling. The caller supplies snapshots, storage and status UI.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MapAutosave = api;
})(globalThis, () => {
  'use strict';
  function create({
    capture,
    persist,
    recover,
    status,
    delay = 500,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    let timer = null,
      dirty = false,
      write = null,
      generation = 0;
    function cancelTimer() {
      clearTimer(timer);
      timer = null;
    }
    function schedule() {
      dirty = true;
      status('saving');
      cancelTimer();
      timer = setTimer(() => {
        flush().catch(() => {});
      }, delay);
    }
    async function flush() {
      cancelTimer();
      // Recheck in this continuation: another flush may start the next write
      // while we wait. Returning early could let a map switch outrun that write.
      while (write) await write.catch(() => {});
      if (!dirty) return;
      const current = generation;
      let batch;
      try {
        batch = capture();
      } catch (error) {
        status('error');
        throw error;
      }
      dirty = false;
      write = (async () => {
        try {
          await persist(batch);
          if (generation === current && !dirty) status('saved');
        } catch (error) {
          if (generation === current) {
            recover(batch);
            dirty = true;
            status('error');
          }
          throw error;
        }
      })();
      try {
        await write;
      } finally {
        write = null;
      }
    }
    function reset() {
      cancelTimer();
      dirty = false;
      generation++;
    }
    // Deletion waits for an active write, then cancels pending work. On failure
    // the caller can schedule again using the returned pending-work flag.
    async function suspend() {
      cancelTimer();
      const pending = dirty;
      while (write) await write.catch(() => {});
      const retry = pending || dirty;
      dirty = false;
      return retry;
    }
    return {
      schedule,
      flush,
      reset,
      suspend,
      cancelTimer,
      get dirty() {
        return dirty;
      },
    };
  }
  return { create };
});
