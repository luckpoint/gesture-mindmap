/* Hand sample controls and pointer mapping; landmark recognition lives in recognition.js. */
(function (root) {
  const TRACKING_TIMEOUT_MS = 1000;
  // A 90-degree cone includes diagonals. Prefer nearby nodes with a penalty
  // for angular deviation; break ties by id, independent of insertion order.
  function directionalTarget(nodes, active, direction) {
    const origin = nodes.find(n => n.id === active);
    const length = Math.hypot(direction.x, direction.y);
    if (!origin || !length) return null;
    let best = null,
      score = Infinity;
    for (const n of nodes) {
      const dx = n.x - origin.x,
        dy = n.y - origin.y,
        distance = Math.hypot(dx, dy);
      if (n.id === active || distance < 1e-6) continue;
      const dot = (dx * direction.x + dy * direction.y) / (distance * length);
      if (dot + 1e-10 < Math.SQRT1_2) continue;
      const value = distance * (1 + 2 * (1 - dot));
      if (value < score - 1e-8 || (Math.abs(value - score) <= 1e-8 && String(n.id) < String(best))) {
        best = n.id;
        score = value;
      }
    }
    return best;
  }
  // Camera coordinates are unmirrored; use the same mirror as the preview.
  function mapPointer(point, bounds) {
    return {
      x: bounds.left + (1 - Math.max(0, Math.min(1, point.x))) * (bounds.right - bounds.left),
      y: bounds.top + Math.max(0, Math.min(1, point.y)) * (bounds.bottom - bounds.top),
    };
  }
  function proximityTarget(nodes, point) {
    let best = null,
      bestDistance = Infinity,
      bestCenter = Infinity;
    for (const n of nodes) {
      const width = n.right - n.left,
        height = n.bottom - n.top;
      if (width <= 0 || height <= 0) continue;
      const dx = Math.max(n.left - point.x, 0, point.x - n.right);
      const dy = Math.max(n.top - point.y, 0, point.y - n.bottom);
      // An ellipse around the visible rectangle gives each node a margin
      // of 65% of its own width/height, including at corners.
      if (Math.hypot(dx / (width * 0.65), dy / (height * 0.65)) > 1) continue;
      const distance = Math.hypot(dx, dy);
      const center = Math.hypot(point.x - (n.left + n.right) / 2, point.y - (n.top + n.bottom) / 2);
      if (
        distance < bestDistance ||
        (distance === bestDistance && (center < bestCenter || (center === bestCenter && String(n.id) < String(best))))
      ) {
        best = n.id;
        bestDistance = distance;
        bestCenter = center;
      }
    }
    return best;
  }
  class HandController {
    constructor(io, options = {}) {
      this.io = io;
      this.config = {
        close: 0.32,
        open: 0.55,
        gain: 1.8,
        smoothing: 0.18,
        fastSmoothing: 0.7,
        dragSpeed: 500,
        deadzone: 6,
        movingDeadzone: 0.75,
        stopStable: 350,
        stable: 100,
        disableStable: 300,
        commandStable: 600,
        commandDrift: 0.04,
        threshold: 0.065,
        cooldown: 250,
        zoomDeadzone: 0.008,
        zoomHandDeadzone: 0.003,
        zoomGain: 2.5,
        palmGrace: 220,
        maxGap: TRACKING_TIMEOUT_MS,
        ...options,
      };
      this.state = { state: 'nohand', initialized: false, hover: null, grab: null, x: 0, y: 0 };
      this.paused = false;
      this.commandHeld = false;
      this.commandFrame = null;
      this.commandResetAt = null;
      this.dialogMode = false;
      this.cancel();
    }
    cancel() {
      if (this.state.grab) this.io.cancel();
      this.state.hover = null;
      this.state.pointerVisible = false;
      this.state.grab = null;
      this.centerTarget = null;
      this.dragPoint = null;
      this.dragAt = null;
      this.dragFiltered = null;
      this.dragScale = 1;
      this.dragVelocity = { x: 0, y: 0 };
      this.dragRaw = null;
      this.dragMoving = false;
      this.dragStopPoint = null;
      this.dragStopAt = null;
      this.dragStillPoint = null;
      this.anchor = null;
      this.pendingAt = null;
      this.lastAt = null;
      this.identity = null;
      this.wrist = null;
      this.lastSwitch = -Infinity;
      this.zoomDistance = null;
      this.zoomPendingAt = null;
      this.zoomLastAt = null;
      this.panLastAt = null;
      this.panPendingAt = null;
      this.panRaw = null;
      this.panMoved = false;
      this.palmFrame = null;
      this.zoomPalms = null;
      this.panMode = null;
      this.dialogPoint = false;
      this.commandPose = null;
      this.commandAt = null;
      this.commandPoint = null;
      this.choice = null;
      this.choiceAt = null;
      this.choicePoint = null;
      this.disableAt = null;
      this.disableLastAt = null;
      this.state.progress = 0;
      this.state.state = this.paused ? 'paused' : 'nohand';
      this.io.paint(this.state);
    }
    update(frame, now) {
      if (this.disabled) return;
      // Stopping remains available during dialogs and ordinary-input blocking.
      if (frame?.hands === 2 && frame.pose === 'cross' && Number.isFinite(now)) {
        const since =
          this.disableLastAt !== null && now >= this.disableLastAt && now - this.disableLastAt <= this.config.maxGap
            ? this.disableAt
            : now;
        this.cancel();
        this.disableAt = since;
        this.disableLastAt = now;
        this.state.state = 'disableWaiting';
        this.state.progress = Math.min(1, (now - since) / this.config.disableStable);
        this.io.paint(this.state);
        if (this.state.progress >= 1) {
          this.disabled = true;
          this.io.disable?.();
        }
        return;
      }
      this.disableAt = null;
      this.disableLastAt = null;
      const previous = this.palmFrame;
      const validPalmTrack =
        frame &&
        frame.hands !== 2 &&
        [frame.pointer?.x, frame.pointer?.y, frame.wrist?.x, frame.wrist?.y, frame.ratio, now].every(Number.isFinite);
      const continuous =
        validPalmTrack &&
        previous &&
        now >= previous.now &&
        now - previous.now <= this.config.palmGrace &&
        (!previous.identity || !frame.identity || previous.identity === frame.identity) &&
        Math.hypot(frame.wrist.x - previous.wrist.x, frame.wrist.y - previous.wrist.y) < 0.2;
      // Only bridge uncertain open-hand frames. Explicit poses, pinches and
      // tracking loss must switch immediately; uncertain frames never renew the grace period.
      const palm =
        validPalmTrack && frame.pose === 'palm'
          ? { now, identity: frame.identity, wrist: { ...frame.wrist } }
          : continuous && !frame.pose && frame.ratio > this.config.close
            ? previous
            : null;
      if (palm && frame.pose !== 'palm') frame = { ...frame, pose: 'palm' };
      this.updateInteraction(frame, now);
      this.palmFrame = palm;
      // Pointer feedback is independent of selection, dialogs and zoom mode.
      const point = frame?.pose === 'palm' ? frame.pointer : frame?.palmPointer;
      this.state.pointerVisible = !!point && [point.x, point.y].every(Number.isFinite);
      this.state.pointer = this.state.pointerVisible ? mapPointer(point, this.io.bounds()) : null;
      this.io.paint(this.state);
    }
    updateInteraction(frame, now) {
      const s = this.state,
        c = this.config;
      if (this.io.blocked()) {
        this.cancel();
        s.state = 'blocked';
        this.io.paint(s);
        return;
      }
      const dialog = !!this.io.dialog?.();
      if (dialog !== this.dialogMode) {
        this.cancel();
        this.dialogMode = dialog;
      }
      if (this.updateCommand(frame, now, dialog)) return;
      if (this.paused) {
        this.cancel();
        return;
      }
      if (dialog && frame?.hands === 2) {
        this.cancel();
        s.state = 'dialog';
        this.io.paint(s);
        return;
      }
      if (frame?.pose === 'point') {
        this.cancel();
        s.state = 'neutral';
        this.io.paint(s);
        return;
      }
      if (!dialog && frame?.pose === 'fist') {
        const mode = `${frame.hands || 1}:${frame.pose}:${frame.panHand?.identity || frame.identity || ''}`;
        if (this.panMode !== mode) this.cancel();
        this.updatePan(frame.panHand?.pointer ?? frame.pointer, now);
        this.panMode = mode;
        return;
      }
      if (this.panLastAt !== null) this.cancel();
      if (frame?.hands === 2) {
        this.updateZoom(frame, now);
        return;
      }
      // Reacquire a stable open hand after leaving two-hand mode.
      if (this.zoomLastAt !== null) this.cancel();
      const point = frame?.pointer ?? frame?.tip;
      if (!frame || ![point?.x, point?.y, frame.wrist?.x, frame.wrist?.y, frame.ratio, now].every(Number.isFinite)) {
        this.cancel();
        s.state = s.initialized ? 'lost' : 'nohand';
        this.io.paint(s);
        return;
      }
      const changed =
        (this.identity && frame.identity && this.identity !== frame.identity) ||
        (this.wrist && Math.hypot(frame.wrist.x - this.wrist.x, frame.wrist.y - this.wrist.y) >= 0.2);
      if (changed || (this.lastAt !== null && (now - this.lastAt > c.maxGap || now < this.lastAt))) this.cancel();
      this.identity = frame.identity;
      this.wrist = { ...frame.wrist };
      this.lastAt = now;
      if (dialog) {
        this.updateDialog(frame, point, now);
        return;
      }
      // Capture the last palm-selected node before finger flexion can change
      // the pointer/target. Keep it latched until the hand opens again.
      if (!frame.pose && frame.ratio < c.open && (this.centerTarget || (frame.ratio <= c.close && s.hover))) {
        if (!this.centerTarget) {
          this.centerTarget = s.hover;
          this.io.center?.(this.centerTarget);
        }
        s.hover = this.centerTarget;
        s.state = 'centered';
        this.io.paint(s);
        return;
      }
      if (this.centerTarget) this.cancel();
      const openPalm = frame.pose === 'palm';
      if (!openPalm) {
        this.cancel();
        s.state = 'neutral';
        this.io.paint(s);
        return;
      }
      if (this.pendingAt === null) this.pendingAt = now;
      const mapped = mapPointer(point, this.io.bounds());
      s.x = mapped.x;
      s.y = mapped.y;
      s.pointerVisible = true;
      if (now - this.pendingAt < c.stable) s.state = 'waiting';
      else {
        s.initialized = true;
        s.state = 'ready';
        s.hover = proximityTarget(this.io.nodes?.() || [], mapped);
        this.io.select?.(s.hover);
      }
      this.io.paint(s);
    }
    updateZoom(frame, now) {
      const s = this.state,
        c = this.config,
        distance = frame.distance;
      const palms = frame.palms;
      if (
        !Number.isFinite(distance) ||
        distance < 0.05 ||
        !Number.isFinite(now) ||
        palms?.length !== 2 ||
        !palms.every(p => [p?.x, p?.y].every(Number.isFinite)) ||
        frame.pose !== 'bothFists'
      ) {
        this.cancel();
        s.state = 'neutral';
        this.io.paint(s);
        return;
      }
      const copy = () => palms.map(p => ({ ...p }));
      // Match by proximity so detector order changes cannot look like motion.
      let current = copy();
      if (this.zoomPalms) {
        const cost = order =>
          order.reduce((sum, p, i) => sum + Math.hypot(p.x - this.zoomPalms[i].x, p.y - this.zoomPalms[i].y), 0);
        if (cost([...current].reverse()) < cost(current)) current.reverse();
      }
      if (
        this.zoomLastAt === null ||
        now < this.zoomLastAt ||
        now - this.zoomLastAt > c.maxGap ||
        Math.abs(distance - this.zoomDistance) > 0.2 ||
        current.some(
          (p, i) => this.zoomPalms && Math.hypot(p.x - this.zoomPalms[i].x, p.y - this.zoomPalms[i].y) >= 0.2,
        )
      ) {
        this.cancel();
        this.zoomPendingAt = now;
        this.zoomDistance = distance;
        this.zoomPalms = current;
      }
      this.zoomLastAt = now;
      if (now - this.zoomPendingAt < c.stable) {
        this.zoomDistance = distance;
        this.zoomPalms = current;
        s.state = 'zoomWaiting';
      } else {
        const delta = distance - this.zoomDistance;
        if (Math.abs(delta) >= c.zoomDeadzone) {
          const [a, b] = this.zoomPalms,
            length = Math.hypot(b.x - a.x, b.y - a.y);
          const axis = { x: (b.x - a.x) / length, y: (b.y - a.y) / length };
          const radial = current.map(
            (p, i) =>
              ((p.x - this.zoomPalms[i].x) * axis.x + (p.y - this.zoomPalms[i].y) * axis.y) *
              (i ? 1 : -1) *
              Math.sign(delta),
          );
          // Both palms must move outward/inward; translation and a single moving hand do not zoom.
          if (radial.every(value => value >= c.zoomHandDeadzone)) this.io.zoom(Math.exp(-delta * c.zoomGain));
          this.zoomDistance = distance;
          this.zoomPalms = current;
        }
        s.state = 'zooming';
      }
      this.io.paint(s);
    }
    updateCommand(frame, now, dialog) {
      const s = this.state,
        c = this.config,
        point = frame?.pointer;
      const valid =
        frame?.hands !== 2 &&
        [point?.x, point?.y, frame?.wrist?.x, frame?.wrist?.y, frame?.ratio, now].every(Number.isFinite);
      const previous = this.commandFrame;
      const discontinuous =
        !valid ||
        (previous &&
          (now < previous.now ||
            now - previous.now > c.maxGap ||
            (previous.identity && frame.identity && previous.identity !== frame.identity) ||
            Math.hypot(frame.wrist.x - previous.wrist.x, frame.wrist.y - previous.wrist.y) >= 0.2));
      if (discontinuous) {
        this.commandPose = null;
        this.commandAt = null;
        this.commandResetAt = null;
        s.progress = 0;
      }
      this.commandFrame = valid ? { now, identity: frame.identity, wrist: { ...frame.wrist } } : null;
      const command = frame?.pose === 'peace' ? 'add' : frame?.pose === 'thumbDown' ? 'delete' : null;
      const neutral =
        valid &&
        (frame.pose === 'fist' ||
          frame.pose === 'point' ||
          frame.pose === 'palm' ||
          (!frame.pose && frame.ratio >= c.open));
      if (neutral) {
        if (this.commandResetAt === null) this.commandResetAt = now;
        if (now - this.commandResetAt >= c.stable) this.commandHeld = false;
      } else this.commandResetAt = null;
      if (!valid || !command || this.paused || dialog) {
        this.commandPose = null;
        this.commandAt = null;
        s.progress = 0;
        return false;
      }
      // A stationary fist can be part of forming a command pose, even after
      // the pan stability wait. Require neutral rearming only after movement.
      if (s.grab || this.zoomLastAt !== null || this.panMoved) {
        this.commandHeld = true;
        this.cancel();
      }
      if (this.commandHeld) {
        this.cancel();
        s.state = 'commandReset';
        this.io.paint(s);
        return true;
      }
      if (
        this.commandPose !== command ||
        Math.hypot(point.x - this.commandPoint?.x, point.y - this.commandPoint?.y) > c.commandDrift
      ) {
        this.cancel();
        this.commandPose = command;
        this.commandAt = now;
        this.commandPoint = { ...point };
      }
      s.state = command === 'add' ? 'addWaiting' : 'deleteWaiting';
      s.progress = Math.min(1, (now - this.commandAt) / c.commandStable);
      if (s.progress >= 1) {
        this.commandHeld = true;
        this.io.command?.(command);
        s.state = 'commandReset';
        s.progress = 0;
      }
      this.io.paint(s);
      return true;
    }
    updateDialog(frame, point, now) {
      const s = this.state,
        c = this.config;
      const side = frame.pose === 'thumbLeft' ? 'left' : frame.pose === 'thumbRight' ? 'right' : null;
      if (
        side !== this.choice ||
        (this.choiceAt !== null &&
          Math.hypot(point.x - this.choicePoint.x, point.y - this.choicePoint.y) > c.commandDrift)
      ) {
        this.choice = side;
        this.choiceAt = side ? now : null;
        this.choicePoint = side ? { ...point } : null;
      }
      if (side) {
        // A held tilt presses the button on that side once; changing pose rearms it.
        this.anchor = null;
        this.pendingAt = null;
        s.progress = this.choiceAt === null ? 0 : Math.min(1, (now - this.choiceAt) / c.commandStable);
        if (s.progress >= 1) {
          this.choiceAt = null;
          s.progress = 0;
          this.io.dialogChoose?.(side);
        }
        s.state = 'dialog';
        this.io.paint(s);
        return;
      }
      // An open palm navigates the dialog; tilted thumbs press its buttons.
      const pointing = frame.pose === 'palm' || (!frame.pose && frame.ratio >= c.open);
      if (pointing && !this.dialogPoint) {
        this.anchor = null;
        this.pendingAt = null;
      }
      this.dialogPoint = pointing;
      if (frame.pose && frame.pose !== 'palm') {
        this.anchor = null;
        this.pendingAt = null;
      } else if (frame.pose === 'palm' || (!frame.pose && frame.ratio >= c.open)) {
        if (!this.anchor) {
          if (this.pendingAt === null) this.pendingAt = now;
          if (now - this.pendingAt >= c.stable) this.anchor = { ...point };
        } else if (now - this.lastSwitch < c.cooldown) this.anchor = { ...point };
        else if (pointing && Math.abs(point.y - this.anchor.y) >= c.threshold) {
          this.io.dialogNavigate?.(point.y > this.anchor.y ? 1 : -1);
          this.anchor = { ...point };
          this.lastSwitch = now;
        } else if (!pointing) this.anchor = { ...point };
      } else {
        this.anchor = null;
        this.pendingAt = null;
      }
      s.state = 'dialog';
      s.progress = 0;
      this.io.paint(s);
    }
    rebaseDrag(point, now) {
      this.dragPoint = { ...point };
      this.dragAt = now;
      this.dragFiltered = { x: this.state.x, y: this.state.y };
      this.dragRaw = { ...point };
      this.dragVelocity = { x: 0, y: 0 };
      this.dragMoving = false;
      this.dragStopPoint = null;
      this.dragStopAt = null;
      this.dragStillPoint = { ...point };
    }
    updatePan(point, now) {
      const s = this.state,
        c = this.config;
      if (![point?.x, point?.y, now].every(Number.isFinite)) {
        this.cancel();
        s.state = 'lost';
        this.io.paint(s);
        return;
      }
      if (
        this.panLastAt === null ||
        now < this.panLastAt ||
        now - this.panLastAt > c.maxGap ||
        Math.hypot(point.x - this.panRaw.x, point.y - this.panRaw.y) >= 0.2
      ) {
        this.cancel();
        this.panPendingAt = now;
        s.x = 0;
        s.y = 0;
        this.rebaseDrag(point, now);
      }
      this.panLastAt = now;
      this.panRaw = { ...point };
      if (now - this.panPendingAt < c.stable) {
        this.rebaseDrag(point, now);
        s.state = 'panWaiting';
      } else {
        const x = s.x,
          y = s.y;
        this.moveDrag(point, now, (nextX, nextY) => {
          this.panMoved = true;
          this.io.pan(nextX - x, nextY - y);
        });
        s.state = 'panning';
      }
      this.io.paint(s);
    }
    moveDrag(point, now, move) {
      const s = this.state,
        c = this.config,
        b = this.io.bounds();
      const elapsed = Math.max(0, now - this.dragAt);
      if (!elapsed) return;
      const width = b.right - b.left,
        height = b.bottom - b.top,
        gain = c.gain * this.dragScale;
      // Smooth signed velocity before measuring speed: alternating tracking
      // noise must not make the position filter respond like a deliberate move.
      const velocityAlpha = 1 - Math.pow(0.8, elapsed / 50);
      this.dragVelocity.x +=
        (((point.x - this.dragRaw.x) * width * gain * 1000) / elapsed - this.dragVelocity.x) * velocityAlpha;
      this.dragVelocity.y +=
        (((point.y - this.dragRaw.y) * height * gain * 1000) / elapsed - this.dragVelocity.y) * velocityAlpha;
      const speed = Math.min(1, Math.hypot(this.dragVelocity.x, this.dragVelocity.y) / c.dragSpeed);
      const smoothing = c.smoothing + (Math.max(c.smoothing, c.fastSmoothing) - c.smoothing) * speed;
      const alpha = 1 - Math.pow(1 - smoothing, elapsed / 50);
      this.dragFiltered.x -= (point.x - this.dragPoint.x) * width * gain * alpha;
      this.dragFiltered.y += (point.y - this.dragPoint.y) * height * gain * alpha;
      this.dragPoint.x += (point.x - this.dragPoint.x) * alpha;
      this.dragPoint.y += (point.y - this.dragPoint.y) * alpha;
      this.dragAt = now;
      this.dragRaw = { ...point };
      const noiseScale = Math.max(1, this.dragScale);
      if (this.dragMoving && c.deadzone > 0) {
        // Use a separate, fixed low-pass estimate for rest detection. At low
        // fps the responsive position filter can still follow alternating noise.
        const stillAlpha = 1 - Math.pow(0.9, elapsed / 50);
        this.dragStillPoint.x += (point.x - this.dragStillPoint.x) * stillAlpha;
        this.dragStillPoint.y += (point.y - this.dragStillPoint.y) * stillAlpha;
        // A fixed anchor (never a per-frame delta) lets slow deliberate motion
        // accumulate, while a brief pause cannot immediately latch the node.
        const stillRadius = c.deadzone * 0.5 * noiseScale;
        if (
          !this.dragStopPoint ||
          Math.hypot(
            (this.dragStillPoint.x - this.dragStopPoint.x) * width * gain,
            (this.dragStillPoint.y - this.dragStopPoint.y) * height * gain,
          ) > stillRadius
        ) {
          this.dragStopPoint = { ...this.dragStillPoint };
          this.dragStopAt = now;
        } else if (now - this.dragStopAt >= c.stopStable) {
          // Freeze at the displayed position and discard filter tail. Changing
          // the deadzone alone would allow residual motion to restart the drag.
          this.rebaseDrag(point, now);
          return;
        }
      }
      const dx = this.dragFiltered.x - s.x,
        dy = this.dragFiltered.y - s.y,
        distance = Math.hypot(dx, dy);
      // Far/small hands amplify image noise when movement is normalized.
      const deadzone = (this.dragMoving ? Math.min(c.deadzone, c.movingDeadzone) : c.deadzone * 2) * noiseScale;
      if (distance > deadzone) {
        const scale = 1 - deadzone / distance;
        s.x += dx * scale;
        s.y += dy * scale;
        if (!this.dragMoving) {
          this.dragMoving = true;
          // Remove the breakaway offset before reducing the deadzone so the
          // next frame cannot jump just because the mode changed.
          this.dragFiltered = { x: s.x, y: s.y };
          this.dragStillPoint = { ...point };
          this.dragStopPoint = null;
          this.dragStopAt = null;
        }
        move(s.x, s.y);
      }
    }
  }
  root.HandGestures = {
    HandController,
    directionalTarget,
    mapPointer,
    proximityTarget,
    TRACKING_TIMEOUT_MS,
  };
  if (typeof module !== 'undefined') module.exports = root.HandGestures;
})(globalThis);
