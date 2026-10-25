// Application dependencies are supplied per instance; evaluation has no screen effects.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MindmapAppBrowser = api;
})(globalThis, () => {
  'use strict';
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
      MapTree: environment.MapTree,
      MapOperationPolicy: environment.MapOperationPolicy,
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
      history: environment.MapEditHistory,
      diffs: environment.MapHistory,
      autosave: environment.MapAutosave,
      imageFormat: environment.NodeImageFormat,
      tr: (...args) => environment.I18n.t(...args),
      imageStore: new environment.NodeImageStore.Store(),
      IconPalette: environment.IconPalette,
      loadRxdb: () => import('../vendor/rxdb.js'),
    });
    services.instructionClient = services.instructionsEnabled ? new environment.InstructionTransport.Client() : null;
    return environment.MindmapAppBootstrap.create({
      environment,
      services,
      modules: {
        context: environment.MindmapAppContext,
        state: environment.MindmapAppState,
        'operation-policy': environment.MindmapAppOperationPolicy,
        tree: environment.MindmapAppTree,
        maps: environment.MindmapAppMaps,
        viewport: environment.MindmapAppViewport,
        render: environment.MindmapAppRender,
        'node-images': environment.MindmapAppNodeImages,
        speech: environment.MindmapAppSpeech,
        editing: environment.MindmapAppEditing,
        instructions: environment.MindmapAppInstructions,
        hand: environment.MindmapAppHand,
        pointer: environment.MindmapAppPointer,
        keyboard: environment.MindmapAppKeyboard,
        controls: environment.MindmapAppControls,
        access: environment.MindmapAppAccess,
        history: environment.MindmapAppHistory,
        persistence: environment.MindmapAppPersistence,
        startup: environment.MindmapAppStartup,
      },
    });
  }
  return { create };
});
