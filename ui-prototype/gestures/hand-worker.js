/* Classic Worker: MediaPipe's WASM loader uses importScripts. */
let detector;
self.onmessage = async ({ data }) => {
  if (data.type === 'init') {
    try {
      // The pinned package ships CJS and ESM. Expose its CJS exports in this
      // classic worker so the WASM loader can keep using importScripts.
      self.exports = {};
      self.module = { exports: self.exports };
      importScripts('../mediapipe/vision_bundle.js');
      const vision = self.module.exports;
      const files = await vision.FilesetResolver.forVisionTasks(new URL('../mediapipe/wasm', self.location.href).href);
      detector = await vision.HandLandmarker.createFromOptions(files, {
        canvas: new OffscreenCanvas(1, 1),
        baseOptions: {
          modelAssetPath: new URL('../mediapipe/hand_landmarker.task', self.location.href).href,
          delegate: 'CPU',
        },
        runningMode: 'VIDEO',
        numHands: 2,
        minHandDetectionConfidence: 0.6,
        minHandPresenceConfidence: 0.6,
        minTrackingConfidence: 0.6,
      });
      self.postMessage({ type: 'ready' });
    } catch (error) {
      self.postMessage({ type: 'error', message: String(error) });
    }
  } else if (data.type === 'frame') {
    try {
      const start = performance.now();
      const result = detector.detectForVideo(data.bitmap, data.timestamp);
      self.postMessage({ type: 'result', result, inferenceMs: performance.now() - start });
    } catch (error) {
      self.postMessage({ type: 'error', message: String(error) });
    } finally {
      data.bitmap.close();
    }
  } else if (data.type === 'stop') {
    detector?.close();
    self.close();
  }
};
