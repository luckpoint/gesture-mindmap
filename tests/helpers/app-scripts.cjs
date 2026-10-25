// Explicit boundaries for integration tests. A separate test checks index.html
// against these paths so a production script cannot silently escape coverage.
const coreScripts = ['core/operation-policy.js', 'core/tree.js', 'core/history.js', 'core/autosave.js'];
const appScripts = [
  'app/context.js',
  'app/state.js',
  'app/operation-policy.js',
  'app/tree.js',
  'app/history.js',
  'app/persistence.js',
  'app/bootstrap.js',
  'app/maps.js',
  'app/viewport.js',
  'app/render.js',
  'app/node-images.js',
  'app/speech.js',
  'app/editing.js',
  'app/instructions.js',
  'app/hand.js',
  'app/pointer.js',
  'app/keyboard.js',
  'app/controls.js',
  'app/main.js',
];
module.exports = { coreScripts, appScripts };
