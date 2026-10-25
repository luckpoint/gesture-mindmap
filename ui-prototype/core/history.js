/* DOM-free application core. Dependencies are supplied by the caller. */
const HISTORY_LIMIT = 1000;
function create({ stacks, diffs, limit = HISTORY_LIMIT, now = Date.now }) {
  let lastSeq = 0,
    unsaved = new Map(),
    dropped = new Set();
  const cursor = () => stacks.history.at(-1)?.seq ?? 0;
  function forget(entries) {
    for (const e of entries) {
      unsaved.delete(e.seq);
      dropped.add(e.seq);
    }
  }
  function record(before, after) {
    const entry = {
      seq: ++lastSeq,
      prev: cursor(),
      at: now(),
      ...diffs.diff(before, after),
    };
    forget(stacks.future);
    stacks.future = [];
    stacks.history.push(entry);
    unsaved.set(entry.seq, entry);
    if (stacks.history.length > limit) forget(stacks.history.splice(0, stacks.history.length - limit));
  }
  // Persistence consumes pending diffs without owning the undo/redo stacks.
  function takeHistoryChanges() {
    const changes = { cursor: cursor(), put: [...unsaved.values()], drop: [...dropped] };
    unsaved = new Map();
    dropped = new Set();
    return changes;
  }
  function retryHistoryChanges(changes) {
    for (const e of changes.put) if (!dropped.has(e.seq)) unsaved.set(e.seq, e);
    for (const seq of changes.drop) dropped.add(seq);
  }

  function load(map, log) {
    const { undo, redo, discard } = diffs.verify(map, log.cursor, log.entries);
    stacks.history = undo;
    stacks.future = redo.reverse();
    unsaved = new Map();
    dropped = new Set(discard);
    lastSeq = log.entries.reduce((max, e) => Math.max(max, e.seq), 0);
  }
  function restore(map, direction) {
    const from = direction === 'undo' ? stacks.history : stacks.future;
    const to = direction === 'undo' ? stacks.future : stacks.history;
    if (!from.length) return null;
    const entry = from.pop();
    const restored = diffs.apply(map, entry, direction === 'undo' ? 'before' : 'after');
    to.push(entry);
    return restored;
  }
  return { record, load, restore, takeChanges: takeHistoryChanges, retryChanges: retryHistoryChanges };
}
export { create, HISTORY_LIMIT };
