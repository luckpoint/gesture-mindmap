import * as AppAccess from './access.js';
import * as AppBootstrap from './bootstrap.js';
import * as AppContext from './context.js';
import * as AppControls from './controls.js';
import * as AppEditing from './editing.js';
import * as AppHand from './hand.js';
import * as AppHistory from './history.js';
import * as AppInstructions from './instructions.js';
import * as AppKeyboard from './keyboard.js';
import * as AppMaps from './maps.js';
import * as AppNodeImages from './node-images.js';
import * as AppOperationPolicy from './operation-policy.js';
import * as AppPersistence from './persistence.js';
import * as AppPointer from './pointer.js';
import * as AppRender from './render.js';
import * as AppSpeech from './speech.js';
import * as AppStartup from './startup.js';
import * as AppState from './state.js';
import * as AppTree from './tree.js';
import * as AppViewport from './viewport.js';
import * as MapTree from '../core/tree.js';
import * as MapOperationPolicy from '../core/operation-policy.js';
import * as MapEditHistory from '../core/history.js';
import * as MapAutosave from '../core/autosave.js';

// Application dependencies are supplied per instance; evaluation has no screen effects.
function create(environment) {
  const services = {
    I18n: environment.I18n,
    InstructionOperations: environment.InstructionOperations,
    InstructionTransport: environment.InstructionTransport,
    NodeImageStore: environment.NodeImageStore,
    NodeImageFormat: environment.NodeImageFormat,
    NodeImageUpload: environment.NodeImageUpload,
    MapLocks: environment.MapLocks,
    MapHistory: environment.MapHistory,
    MapTree,
    MapOperationPolicy,
    SpeechInput: environment.SpeechInput,
    HandDebugOverlay: environment.HandDebugOverlay,
    HandShapeView: environment.HandShapeView,
    HandGestures: environment.HandGestures,
    CameraSession: environment.CameraSession,
    PrintLayout: environment.PrintLayout,
    MapLibrary: environment.MapLibrary,
  };
  Object.assign(services, {
    instructionsEnabled: environment.MindmapFeatures?.instructions === true,
    history: MapEditHistory,
    diffs: environment.MapHistory,
    autosave: MapAutosave,
    imageFormat: environment.NodeImageFormat,
    tr: (...args) => environment.I18n.t(...args),
    imageStore: new environment.NodeImageStore.Store(),
    IconPalette: environment.IconPalette,
    loadRxdb: () => import('../vendor/rxdb.js'),
  });
  services.instructionClient = services.instructionsEnabled ? new environment.InstructionTransport.Client() : null;
  return AppBootstrap.create({
    environment,
    services,
    modules: {
      context: AppContext,
      state: AppState,
      'operation-policy': AppOperationPolicy,
      tree: AppTree,
      maps: AppMaps,
      viewport: AppViewport,
      render: AppRender,
      'node-images': AppNodeImages,
      speech: AppSpeech,
      editing: AppEditing,
      instructions: AppInstructions,
      hand: AppHand,
      pointer: AppPointer,
      keyboard: AppKeyboard,
      controls: AppControls,
      access: AppAccess,
      history: AppHistory,
      persistence: AppPersistence,
      startup: AppStartup,
    },
  });
}
export { create };
