/* Camera-independent directional navigation and landmark extraction. */
(function (root) {
  const TRACKING_TIMEOUT_MS = 1000;
  // A 90-degree cone includes diagonals. Prefer nearby nodes with a penalty
  // for angular deviation; break ties by id, independent of insertion order.
  function directionalTarget(nodes, active, direction) {
    const origin = nodes.find(n => n.id === active);
    const length = Math.hypot(direction.x, direction.y);
    if (!origin || !length) return null;
    let best = null, score = Infinity;
    for (const n of nodes) {
      const dx = n.x - origin.x, dy = n.y - origin.y, distance = Math.hypot(dx, dy);
      if (n.id === active || distance < 1e-6) continue;
      const dot = (dx * direction.x + dy * direction.y) / (distance * length);
      if (dot + 1e-10 < Math.SQRT1_2) continue;
      const value = distance * (1 + 2 * (1 - dot));
      if (value < score - 1e-8 || (Math.abs(value - score) <= 1e-8 && String(n.id) < String(best))) {
        best = n.id; score = value;
      }
    }
    return best;
  }
  class HandController {
    constructor(io, options = {}) {
      this.io = io;
      this.config = { close: .32, open: .55, gain: 1.8, smoothing: .45, deadzone: 3, stable: 100, toggleStable: 300, commandStable: 600, commandDrift: .04, threshold: .065, cooldown: 250, zoomDeadzone: .008, zoomGain: 2.5, maxGap: TRACKING_TIMEOUT_MS, ...options };
      this.state = { state: 'nohand', initialized: false, hover: null, grab: null, x: 0, y: 0 };
      this.paused = false; this.toggleHeld = false;
      this.commandHeld = false; this.commandFrame = null; this.commandResetAt = null;
      this.dialogMode = false;
      this.cancel();
    }
    cancel(preserveToggle = false) {
      if (this.state.grab) this.io.cancel();
      this.state.grab = null; this.closed = false; this.pinchAt = null;
      this.dragPoint = null; this.dragAt = null; this.dragFiltered = null;
      this.anchor = null; this.pendingAt = null; this.lastAt = null;
      this.identity = null; this.wrist = null; this.lastSwitch = -Infinity;
      this.zoomDistance = null; this.zoomPendingAt = null; this.zoomLastAt = null;
      if (!preserveToggle) {
        this.toggleAt = null; this.toggleReleaseAt = null; this.toggleLastAt = null;
      }
      this.commandPose = null; this.commandAt = null; this.commandPoint = null;
      this.state.progress = 0;
      this.state.state = this.paused ? 'paused' : 'nohand'; this.io.paint(this.state);
    }
    update(frame, now) {
      const s = this.state, c = this.config;
      if (this.io.blocked()) { this.cancel(); s.state = 'blocked'; this.io.paint(s); return; }
      const dialog = !!this.io.dialog?.();
      if (dialog !== this.dialogMode) { this.cancel(); this.dialogMode = dialog; }
      if (this.updateCommand(frame, now, dialog)) return;
      // A held pointing pose toggles once. Tracking loss never rearms it;
      // require a stable different pose before accepting another toggle.
      if (frame && Number.isFinite(now)) {
        if (this.toggleLastAt !== null && (now < this.toggleLastAt || now - this.toggleLastAt > c.maxGap)) {
          this.toggleAt = null; this.toggleReleaseAt = null;
        }
        this.toggleLastAt = now;
        if (frame.pose === 'point') {
          this.toggleReleaseAt = null;
          if (this.toggleAt === null) {
            this.cancel(); this.toggleAt = now; this.toggleLastAt = now;
          }
          if (!this.toggleHeld && now - this.toggleAt >= c.toggleStable) {
            this.paused = !this.paused; this.toggleHeld = true;
          }
          s.state = this.paused ? 'paused' : 'toggleWaiting';
          this.io.paint(s); return;
        }
        this.toggleAt = null;
        if (this.toggleHeld) {
          if (this.toggleReleaseAt === null) this.toggleReleaseAt = now;
          if (now - this.toggleReleaseAt >= c.stable) this.toggleHeld = false;
        }
        if (this.paused || frame.pose === 'fist') {
          this.cancel(true);
          s.state = this.paused ? 'paused' : 'neutral';
          this.io.paint(s); return;
        }
      }
      if (this.paused) { this.cancel(); return; }
      if (dialog && frame?.hands === 2) {
        this.cancel(); s.state = 'dialog'; this.io.paint(s); return;
      }
      if (frame?.hands === 2) {
        const distance = frame.distance;
        if (!Number.isFinite(distance) || distance < .05 || !Number.isFinite(now)) {
          this.cancel(); s.state = 'lost'; this.io.paint(s); return;
        }
        if (this.zoomLastAt === null || now < this.zoomLastAt || now - this.zoomLastAt > c.maxGap ||
            Math.abs(distance - this.zoomDistance) > .2) {
          // A second hand cancels a node preview before the viewport changes.
          this.cancel(); this.zoomPendingAt = now; this.zoomDistance = distance;
        }
        this.zoomLastAt = now;
        if (now - this.zoomPendingAt < c.stable) {
          this.zoomDistance = distance; s.state = 'zoomWaiting';
        } else {
          const delta = distance - this.zoomDistance;
          if (Math.abs(delta) >= c.zoomDeadzone) {
            this.io.zoom(Math.exp(-delta * c.zoomGain));
            this.zoomDistance = distance;
          }
          s.state = 'zooming';
        }
        this.io.paint(s); return;
      }
      // Reacquire a stable open hand after leaving two-hand mode.
      if (this.zoomLastAt !== null) this.cancel();
      const point = frame?.pointer ?? frame?.tip;
      if (!frame || ![point?.x, point?.y, frame.wrist?.x, frame.wrist?.y, frame.ratio, now].every(Number.isFinite)) {
        this.cancel(); s.state = s.initialized ? 'lost' : 'nohand'; this.io.paint(s); return;
      }
      const changed = (this.identity && frame.identity && this.identity !== frame.identity) ||
        (this.wrist && Math.hypot(frame.wrist.x - this.wrist.x, frame.wrist.y - this.wrist.y) >= .2);
      if (changed || (this.lastAt !== null && (now - this.lastAt > c.maxGap || now < this.lastAt))) this.cancel();
      this.identity = frame.identity; this.wrist = { ...frame.wrist }; this.lastAt = now;
      if (dialog) { this.updateDialog(frame, point, now); return; }
      if (this.closed) {
        if (frame.ratio >= c.open) {
          if (this.pinchAt === null) this.pinchAt = now;
          if (now - this.pinchAt >= c.stable) {
            if (s.grab) this.io.release();
            s.grab = null; this.closed = false; this.pinchAt = null;
            this.anchor = { ...point }; this.lastSwitch = now;
          }
          this.rebaseDrag(point, now);
        } else if (this.pinchAt !== null) {
          this.pinchAt = null; this.rebaseDrag(point, now);
        } else if (s.grab) this.moveDrag(point, now);
        s.state = s.grab ? 'dragging' : this.closed ? 'pinchWaiting' : 'ready';
      } else if (frame.ratio < c.open) {
        // Freeze direction selection throughout finger closure, before the
        // pinch threshold too. A stable pinch grabs the active node only.
        if (this.anchor && frame.ratio <= c.close) {
          if (this.pinchAt === null) this.pinchAt = now;
          if (now - this.pinchAt >= c.stable) {
            this.closed = true; this.pinchAt = null; s.x = 0; s.y = 0;
            s.grab = this.io.begin?.(s.x, s.y) || null;
            this.rebaseDrag(point, now);
          }
        } else this.pinchAt = null;
        if (this.anchor) this.anchor = { ...point };
        this.pendingAt = null; s.state = s.grab ? 'dragging' : 'pinchWaiting';
      } else if (!this.anchor) {
        if (this.pendingAt === null) this.pendingAt = now;
        if (now - this.pendingAt >= c.stable) {
          this.anchor = { ...point }; s.initialized = true; s.state = 'ready';
          this.io.activate();
        } else s.state = 'waiting';
      } else {
        if (s.state === 'pinchWaiting') this.anchor = { ...point };
        this.pinchAt = null;
        s.state = 'ready';
        const dx = this.anchor.x - point.x, dy = point.y - this.anchor.y;
        if (now - this.lastSwitch < c.cooldown) {
          // Discard movement during cooldown, including filter/tracking noise.
          this.anchor = { ...point };
        } else if (Math.hypot(dx, dy) >= c.threshold) {
          const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * Math.PI / 4;
          this.io.navigate({ x: Math.cos(angle), y: Math.sin(angle) });
          this.anchor = { ...point }; this.lastSwitch = now;
        }
      }
      this.io.paint(s);
    }
    updateCommand(frame, now, dialog) {
      const s = this.state, c = this.config, point = frame?.pointer;
      const valid = frame?.hands !== 2 && [point?.x, point?.y, frame?.wrist?.x, frame?.wrist?.y, frame?.ratio, now].every(Number.isFinite);
      const previous = this.commandFrame;
      const discontinuous = !valid || (previous && (now < previous.now || now - previous.now > c.maxGap ||
        (previous.identity && frame.identity && previous.identity !== frame.identity) ||
        Math.hypot(frame.wrist.x - previous.wrist.x, frame.wrist.y - previous.wrist.y) >= .2));
      if (discontinuous) {
        this.commandPose = null; this.commandAt = null; this.commandResetAt = null; s.progress = 0;
      }
      this.commandFrame = valid ? { now, identity: frame.identity, wrist: { ...frame.wrist } } : null;
      const command = frame?.pose === 'peace' ? 'add' : frame?.pose === 'thumbDown' ? 'delete' : null;
      const neutral = valid && (frame.pose === 'fist' || (!frame.pose && frame.ratio >= c.open));
      if (neutral) {
        if (this.commandResetAt === null) this.commandResetAt = now;
        if (now - this.commandResetAt >= c.stable) this.commandHeld = false;
      } else this.commandResetAt = null;
      if (!valid || !command || this.paused || dialog) {
        this.commandPose = null; this.commandAt = null; s.progress = 0;
        return false;
      }
      if (s.grab || this.zoomLastAt !== null) {
        this.commandHeld = true; this.cancel();
      }
      if (this.commandHeld) {
        this.cancel(); s.state = 'commandReset'; this.io.paint(s); return true;
      }
      if (this.commandPose !== command || Math.hypot(point.x - this.commandPoint?.x, point.y - this.commandPoint?.y) > c.commandDrift) {
        this.cancel(); this.commandPose = command; this.commandAt = now; this.commandPoint = { ...point };
      }
      s.state = command === 'add' ? 'addWaiting' : 'deleteWaiting';
      s.progress = Math.min(1, (now - this.commandAt) / c.commandStable);
      if (s.progress >= 1) {
        this.commandHeld = true;
        this.io.command?.(command);
        s.state = 'commandReset'; s.progress = 0;
      }
      this.io.paint(s); return true;
    }
    updateDialog(frame, point, now) {
      const s = this.state, c = this.config;
      // Opening the dialog or recovering tracking requires a fresh open hand.
      if (frame.pose) {
        this.anchor = null; this.pendingAt = null; this.pinchAt = null;
      } else if (frame.ratio >= c.open) {
        this.pinchAt = null;
        if (!this.anchor) {
          if (this.pendingAt === null) this.pendingAt = now;
          if (now - this.pendingAt >= c.stable) this.anchor = { ...point };
        } else if (now - this.lastSwitch < c.cooldown) this.anchor = { ...point };
        else if (Math.abs(point.y - this.anchor.y) >= c.threshold) {
          this.io.dialogNavigate?.(point.y > this.anchor.y ? 1 : -1);
          this.anchor = { ...point }; this.lastSwitch = now;
        }
      } else if (this.anchor && frame.ratio <= c.close) {
        this.anchor = { ...point };
        if (this.pinchAt === null) this.pinchAt = now;
        if (now - this.pinchAt >= c.commandStable) {
          this.anchor = null; this.pendingAt = null; this.pinchAt = null;
          this.io.dialogSelect?.();
        }
      } else {
        this.pinchAt = null;
        if (this.anchor) this.anchor = { ...point };
      }
      s.state = 'dialog';
      s.progress = this.pinchAt === null ? 0 : Math.min(1, (now - this.pinchAt) / c.commandStable);
      this.io.paint(s);
    }
    rebaseDrag(point, now) {
      this.dragPoint = { ...point }; this.dragAt = now;
      this.dragFiltered = { x: this.state.x, y: this.state.y };
    }
    moveDrag(point, now) {
      const s = this.state, c = this.config, b = this.io.bounds();
      const alpha = 1 - Math.pow(1 - c.smoothing, Math.max(0, now - this.dragAt) / 50);
      this.dragFiltered.x -= (point.x - this.dragPoint.x) * (b.right - b.left) * c.gain * alpha;
      this.dragFiltered.y += (point.y - this.dragPoint.y) * (b.bottom - b.top) * c.gain * alpha;
      this.dragPoint.x += (point.x - this.dragPoint.x) * alpha;
      this.dragPoint.y += (point.y - this.dragPoint.y) * alpha;
      this.dragAt = now;
      const dx = this.dragFiltered.x - s.x, dy = this.dragFiltered.y - s.y, distance = Math.hypot(dx, dy);
      if (distance > c.deadzone) {
        const scale = 1 - c.deadzone / distance;
        s.x += dx * scale; s.y += dy * scale;
        this.io.move(s.x, s.y);
      }
    }

  }
  function singleHandFrame(result, width, height, index) {
    const p = result.landmarks?.[index], category = result.handedness?.[index]?.[0];
    if (!p || p.length !== 21 || ![width, height].every(v => Number.isFinite(v) && v > 0) ||
        !p.every(v => Number.isFinite(v?.x) && Number.isFinite(v?.y))) return null;
    const distance = (a, b) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
    const size = distance(p[0], p[9]);
    if (size < 1) return null;
    // Finger flexion changes the pinch ratio but must not steer navigation.
    const palm = [0, 5, 9, 13, 17].map(i => p[i]);
    const pointer = { x: palm.reduce((sum, v) => sum + v.x, 0) / palm.length,
      y: palm.reduce((sum, v) => sum + v.y, 0) / palm.length };
    // Compare joint distances in image pixels, independent of hand rotation
    // and handedness. Ignore the thumb so a relaxed fist is still neutral.
    const fingers = [5, 9, 13, 17].map(base => {
      const pip = p[base + 1], dip = p[base + 2], tip = p[base + 3];
      const ax = (pip.x - p[base].x) * width, ay = (pip.y - p[base].y) * height;
      const bx = (tip.x - dip.x) * width, by = (tip.y - dip.y) * height;
      const straight = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by) || 1);
      return { extended: straight > .7 && distance(tip, p[0]) > distance(pip, p[0]) + size * .15,
        folded: distance(tip, p[0]) <= distance(pip, p[0]) * 1.15 };
    });
    const thumbDown = fingers.every(f => f.folded) && (p[4].y - p[2].y) * height > size * .45 &&
      Math.abs((p[4].x - p[2].x) * width) < (p[4].y - p[2].y) * height * .7 &&
      (p[4].y - p[3].y) * height > size * .15 && distance(p[4], p[5]) > size * .55;
    const pose = thumbDown ? 'thumbDown'
      : fingers[0].extended && fingers[1].extended && fingers.slice(2).every(f => f.folded) ? 'peace'
      : fingers[0].extended && fingers.slice(1).every(f => f.folded) ? 'point'
      : fingers.every(f => f.folded) ? 'fist' : null;
    return { pointer, tip: p[8], wrist: p[0], ratio: distance(p[4], p[8]) / size,
      pose, identity: category?.score >= .8 ? category.categoryName : null };
  }
  function handFrame(result, width, height) {
    const first = singleHandFrame(result, width, height, 0);
    if (!first || result.landmarks.length < 2) return first;
    const second = singleHandFrame(result, width, height, 1);
    if (!second) return null;
    // Palm centers avoid changes caused by finger flexion. Image-width units
    // preserve the aspect ratio; distance is independent of detection order.
    const frame = { hands: 2, distance: Math.hypot(first.pointer.x - second.pointer.x,
      (first.pointer.y - second.pointer.y) * height / width) };
    if (first.pose === 'point' || second.pose === 'point') frame.pose = 'point';
    else if (first.pose === 'fist' || second.pose === 'fist') frame.pose = 'fist';
    return frame;
  }
  root.HandGestures = { HandController, handFrame, directionalTarget, TRACKING_TIMEOUT_MS };
  if (typeof module !== 'undefined') module.exports = root.HandGestures;
})(globalThis);
