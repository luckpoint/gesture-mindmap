(function (root) {
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
        if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('HTTPSまたはlocalhostで開いてください');
        this.io.status('カメラの許可を待っています');
        const stream = await this.open(deviceId);
        if (this.closed) { stream.getTracks().forEach(t => t.stop()); return; }
        this.stream = stream;
        const cameras = (await navigator.mediaDevices.enumerateDevices?.() || []).filter(d => d.kind === 'videoinput');
        if (this.closed) return;
        this.io.cameras?.(cameras, stream.getVideoTracks()[0].getSettings?.().deviceId);
        stream.getVideoTracks()[0].onended = () => this.fail(new Error('カメラが切断されました'));
        this.video = this.io.video;
        this.video.srcObject = stream;
        await this.video.play();
        if (this.closed) return;
        this.io.status('手の認識を準備しています');
        this.mode = mode;
        if (mode === 'worker') {
          this.worker = new Worker('gestures/hand-worker.js?v=20261023-still-point-12');
          await new Promise((resolve, reject) => {
            this.rejectInit = reject;
            this.initTimer = setTimeout(() => reject(new Error('推論の準備がタイムアウトしました')), 30000);
            this.worker.onerror = () => { const error = new Error('Workerを開始できません。認識資産とブラウザを確認してください'); reject(error); this.fail(error); };
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
        this.io.status('片手のグーは待機、両手グーでマップ移動／人差し指だけを立てて静止で一時停止・再開／片手で選択・移動、両手でズーム');
        this.lastResult = performance.now();
        this.watchdog = setInterval(() => {
          const elapsed = performance.now() - this.lastResult;
          if (elapsed > root.HandGestures.TRACKING_TIMEOUT_MS) this.io.frame(null, performance.now());
          if (elapsed > 5000) this.fail(new Error('カメラ認識が応答しません。もう一度開始してください'));
        }, 100);
        this.loop();
      } catch (error) { this.fail(error); }
    }
    result(result, inferenceMs) {
      if (this.closed) return;
      this.lastResult = performance.now();
      const sample = root.HandGestures.handFrame(result, this.video.videoWidth, this.video.videoHeight);
      this.io.frame(sample, this.lastResult);
      const sentAt = this.sentAt;
      requestAnimationFrame(() => {
        if (!this.closed) this.io.metrics({ mode: this.mode, inferenceMs, displayMs: performance.now() - sentAt,
          hands: result.landmarks?.length || 0, frameValid: !!sample, revision: "20261023-still-point-12" });
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
          if (this.slowFrames >= 3) throw new Error('低頻度の認識でも画面操作が止まるため、手操作を停止しました');
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
      const message = { NotAllowedError: 'カメラが許可されませんでした。ブラウザの設定を確認して再試行してください', NotFoundError: '利用できるカメラがありません', NotReadableError: 'カメラを使えません。ほかのアプリの使用状況を確認してください' }[error.name] || error.message;
      this.io.error(message);
    }
    stop() {
      if (this.closed) return;
      this.closed = true;
      clearTimeout(this.initTimer); clearInterval(this.watchdog); cancelAnimationFrame(this.raf);
      this.rejectInit?.(new Error('停止しました')); this.rejectInit = null;
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
