(function (root) {
  const tr = root.I18n.t;
  class CameraSession {
    constructor(io) { this.io = io; this.closed = false; this.busy = false; this.worker = null; }
    async open(deviceId) {
      const video = { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } };
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...video, ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }) } });
      } catch (error) {
        if (!deviceId || !['OverconstrainedError', 'NotFoundError'].includes(error.name)) throw error;
        return navigator.mediaDevices.getUserMedia({ audio: false, video: { ...video, facingMode: 'user' } });
      }
    }
    async start(mode = 'worker', deviceId) {
      try {
        if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error(tr('cam.needsSecure'));
        this.io.status(tr('cam.waitingPermission'));
        const stream = await this.open(deviceId);
        if (this.closed) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        const cameras = (await navigator.mediaDevices.enumerateDevices?.() || []).filter(d => d.kind === 'videoinput');
        if (this.closed) return;
        this.io.cameras?.(cameras, stream.getVideoTracks()[0].getSettings?.().deviceId);
        stream.getVideoTracks()[0].onended = () => this.fail(new Error(tr('cam.disconnected')));
        this.video = this.io.video;
        this.video.srcObject = stream;
        await this.video.play();
        if (this.closed) return;
        this.io.status(tr('cam.preparing'));
        this.mode = mode;
        if (mode === 'worker') {
          this.worker = new Worker('gestures/hand-worker.js?v=20261025-ipad-canvas');
          await new Promise((resolve, reject) => {
            this.rejectInit = reject;
            this.initTimer = setTimeout(() => reject(new Error(tr('cam.initTimeout'))), 30000);
            this.worker.onerror = () => { const error = new Error(tr('cam.workerFailed')); reject(error); this.fail(error); };
            this.worker.onmessage = ({ data }) => {
              if (this.closed) return;
              if (data.type === 'ready') { clearTimeout(this.initTimer); this.rejectInit = null; resolve(); }
              else if (data.type === 'error') { const error = new Error(data.message); reject(error); this.fail(error); }
              else if (data.type === 'result') this.result(data.result, data.inferenceMs);
            };
            this.worker.postMessage({ type: 'init' });
          });
        } else {
          const { FilesetResolver, HandLandmarker } = await import('../mediapipe/vision_bundle.mjs');
          if (this.closed) return;
          const files = await FilesetResolver.forVisionTasks('mediapipe/wasm');
          const detector = await HandLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: 'mediapipe/hand_landmarker.task', delegate: 'CPU' }, runningMode: 'VIDEO', numHands: 2 });
          if (this.closed) { detector.close(); return; }
          this.detector = detector;
        }
        if (this.closed) return;
        this.io.status('');
        this.lastResult = performance.now();
        this.watchdog = setInterval(() => {
          const elapsed = performance.now() - this.lastResult;
          if (elapsed > root.HandGestures.TRACKING_TIMEOUT_MS) {
            this.io.frame(null, performance.now()); this.io.debug?.(null);
          }
          if (elapsed > 5000) this.fail(new Error(tr('cam.unresponsive')));
        }, 100);
        this.loop();
      } catch (error) { this.fail(error); }
    }
    result(result, inferenceMs) {
      if (this.closed) return;
      this.lastResult = performance.now();
      const sample = root.HandGestures.handFrame(result, this.video.videoWidth, this.video.videoHeight);
      this.io.frame(sample, this.lastResult);
      this.io.debug?.(result, this.video.videoWidth, this.video.videoHeight);
      const sentAt = this.sentAt;
      requestAnimationFrame(() => {
        if (!this.closed) this.io.metrics({ mode: this.mode, inferenceMs, displayMs: performance.now() - sentAt,
          hands: result.landmarks?.length || 0, frameValid: !!sample, revision: "20261025-ipad-canvas" });
      });
      this.busy = false;
    }
    loop() {
      if (this.closed) return;
      this.raf = requestAnimationFrame(() => this.loop());
      const now = performance.now();
      if (this.busy || this.video.readyState < 2 || this.lastVideoTime === this.video.currentTime || now - (this.lastSent || 0) < (this.mode === 'worker' ? 33 : 200)) return;
      this.busy = true; this.lastSent = now; this.sentAt = now; this.lastVideoTime = this.video.currentTime;
      if (this.mode === 'worker') this.sendBitmap(now);
      else {
        try {
          const start = performance.now(), result = this.detector.detectForVideo(this.video, now);
          const duration = performance.now() - start;
          this.slowFrames = duration > 120 ? (this.slowFrames || 0) + 1 : 0;
          if (this.slowFrames >= 3) throw new Error(tr('cam.tooSlow'));
          this.result(result, duration);
        } catch (error) { this.fail(error); }
      }
    }
    async sendBitmap(timestamp) {
      let bitmap;
      try {
        bitmap = await createImageBitmap(this.video);
        if (this.closed) { bitmap.close(); return; }
        this.worker.postMessage({ type: 'frame', bitmap, timestamp }, [bitmap]);
        // Ownership belongs to the worker, which closes every processed image.
      } catch (error) { bitmap?.close(); this.fail(error); }
    }
    fail(error) {
      if (this.closed) return;
      this.stop();
      const key = { NotAllowedError: 'cam.notAllowed', NotFoundError: 'cam.notFound', NotReadableError: 'cam.notReadable' }[error.name];
      const message = key ? tr(key) : error.message;
      this.io.error(message);
    }
    stop() {
      if (this.closed) return;
      this.closed = true;
      this.io.debug?.(null);
      clearTimeout(this.initTimer); clearInterval(this.watchdog); cancelAnimationFrame(this.raf);
      this.rejectInit?.(new Error(tr('cam.stopped'))); this.rejectInit = null;
      this.stream?.getTracks().forEach(t => { t.onended = null; t.stop(); });
      if (this.video) { this.video.pause(); this.video.srcObject = null; }
      this.detector?.close();
      // Give an idle worker a chance to close its detector, then reclaim its heap.
      if (this.worker) {
        const worker = this.worker;
        worker.postMessage({ type: 'stop' });
        setTimeout(() => worker.terminate(), 100);
        this.worker = null;
      }
    }
  }
  root.CameraSession = CameraSession;
  if (typeof module !== 'undefined') module.exports = CameraSession;
})(globalThis);
