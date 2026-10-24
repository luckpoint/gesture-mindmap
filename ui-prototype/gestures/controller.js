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
      this.config = { close: .32, open: .55, gain: 1.8, smoothing: .18, fastSmoothing: .7, dragSpeed: 500, deadzone: 6, movingDeadzone: .75, stopStable: 350, referenceHandSize: .15, stable: 100, toggleStable: 2000, toggleDrift: .015, commandStable: 600, commandDrift: .04, threshold: .065, cooldown: 250, zoomDeadzone: .008, zoomGain: 2.5, maxGap: TRACKING_TIMEOUT_MS, ...options };
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
      this.dragScale = 1; this.dragVelocity = { x: 0, y: 0 }; this.dragRaw = null;
      this.dragMoving = false; this.dragStopPoint = null; this.dragStopAt = null; this.dragStillPoint = null;
      this.anchor = null; this.pendingAt = null; this.lastAt = null;
      this.identity = null; this.wrist = null; this.lastSwitch = -Infinity;
      this.zoomDistance = null; this.zoomPendingAt = null; this.zoomLastAt = null;
      this.panLastAt = null; this.panPendingAt = null; this.panRaw = null;
      if (!preserveToggle) {
        this.toggleAt = null; this.toggleReleaseAt = null; this.toggleLastAt = null;
        this.togglePoint = null; this.toggleWrist = null; this.toggleIdentity = null;
      }
      this.commandPose = null; this.commandAt = null; this.commandPoint = null;
      this.choice = null; this.choiceAt = null; this.choicePoint = null;
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
          const hand = frame.toggleHand ?? frame, point = hand.pointer, wrist = hand.wrist;
          if (![point?.x, point?.y, wrist?.x, wrist?.y].every(Number.isFinite)) {
            this.cancel(); s.state = this.paused ? 'paused' : 'neutral'; this.io.paint(s); return;
          }
          // Compare against fixed hold anchors so slow motion accumulates.
          // Small landmark jitter is allowed, but movement restarts the hold.
          if (this.toggleAt === null ||
              Math.hypot(point.x - this.togglePoint.x, point.y - this.togglePoint.y) > c.toggleDrift ||
              Math.hypot(wrist.x - this.toggleWrist.x, wrist.y - this.toggleWrist.y) > c.toggleDrift ||
              (this.toggleIdentity && hand.identity && this.toggleIdentity !== hand.identity)) {
            this.cancel(); this.toggleAt = now; this.toggleLastAt = now;
            this.togglePoint = { ...point }; this.toggleWrist = { ...wrist }; this.toggleIdentity = hand.identity;
          }
          if (!this.toggleHeld && now - this.toggleAt >= c.toggleStable) {
            this.paused = !this.paused; this.toggleHeld = true;
          }
          s.state = this.paused ? 'paused' : 'neutral';
          this.io.paint(s); return;
        }
        this.toggleAt = null;
        if (this.toggleHeld) {
          if (this.toggleReleaseAt === null) this.toggleReleaseAt = now;
          if (now - this.toggleReleaseAt >= c.stable) this.toggleHeld = false;
        }
        if (this.paused || frame.pose === 'fist' || (!dialog && /^thumb(Left|Right)$/.test(frame.pose))) {
          this.cancel(true);
          s.state = this.paused ? 'paused' : 'neutral';
          this.io.paint(s); return;
        }
      }
      if (this.paused) { this.cancel(); return; }
      if (dialog && frame?.hands === 2) {
        this.cancel(); s.state = 'dialog'; this.io.paint(s); return;
      }
      if (frame?.hands === 2 && frame.pose === 'bothFists') {
        this.updatePan(frame.pointer, now); return;
      }
      if (this.panLastAt !== null) this.cancel();
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
            // Apparent palm size approximates camera distance. Freeze the
            // correction per grab so depth/rotation noise cannot pump the gain.
            this.dragScale = Number.isFinite(frame.handSize) && frame.handSize > 0
              ? Math.max(.6, Math.min(1.6, c.referenceHandSize / frame.handSize)) : 1;
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
      const neutral = valid && (frame.pose === 'fist' || frame.pose === 'point' || (!frame.pose && frame.ratio >= c.open));
      if (neutral) {
        if (this.commandResetAt === null) this.commandResetAt = now;
        if (now - this.commandResetAt >= c.stable) this.commandHeld = false;
      } else this.commandResetAt = null;
      if (!valid || !command || this.paused || dialog) {
        this.commandPose = null; this.commandAt = null; s.progress = 0;
        return false;
      }
      if (s.grab || this.zoomLastAt !== null || this.panLastAt !== null) {
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
      const side = frame.pose === 'thumbLeft' ? 'left' : frame.pose === 'thumbRight' ? 'right' : null;
      if (side !== this.choice || (this.choiceAt !== null &&
          Math.hypot(point.x - this.choicePoint.x, point.y - this.choicePoint.y) > c.commandDrift)) {
        this.choice = side; this.choiceAt = side ? now : null; this.choicePoint = side ? { ...point } : null;
      }
      if (side) {
        // A held tilt presses the button on that side once; changing pose rearms it.
        this.anchor = null; this.pendingAt = null; this.pinchAt = null;
        s.progress = this.choiceAt === null ? 0 : Math.min(1, (now - this.choiceAt) / c.commandStable);
        if (s.progress >= 1) { this.choiceAt = null; s.progress = 0; this.io.dialogChoose?.(side); }
        s.state = 'dialog'; this.io.paint(s); return;
      }
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
      this.dragRaw = { ...point }; this.dragVelocity = { x: 0, y: 0 };
      this.dragMoving = false; this.dragStopPoint = null; this.dragStopAt = null;
      this.dragStillPoint = { ...point };
    }
    updatePan(point, now) {
      const s = this.state, c = this.config;
      if (![point?.x, point?.y, now].every(Number.isFinite)) {
        this.cancel(); s.state = 'lost'; this.io.paint(s); return;
      }
      if (this.panLastAt === null || now < this.panLastAt || now - this.panLastAt > c.maxGap ||
          Math.hypot(point.x - this.panRaw.x, point.y - this.panRaw.y) >= .2) {
        this.cancel(); this.panPendingAt = now;
        s.x = 0; s.y = 0;
        this.rebaseDrag(point, now);
      }
      this.panLastAt = now; this.panRaw = { ...point };
      if (now - this.panPendingAt < c.stable) {
        this.rebaseDrag(point, now); s.state = 'panWaiting';
      } else {
        const x = s.x, y = s.y;
        this.moveDrag(point, now, (nextX, nextY) => this.io.pan(nextX - x, nextY - y));
        s.state = 'panning';
      }
      this.io.paint(s);
    }
    moveDrag(point, now, move = this.io.move) {
      const s = this.state, c = this.config, b = this.io.bounds();
      const elapsed = Math.max(0, now - this.dragAt);
      if (!elapsed) return;
      const width = b.right - b.left, height = b.bottom - b.top, gain = c.gain * this.dragScale;
      // Smooth signed velocity before measuring speed: alternating tracking
      // noise must not make the position filter respond like a deliberate move.
      const velocityAlpha = 1 - Math.pow(.8, elapsed / 50);
      this.dragVelocity.x += ((point.x - this.dragRaw.x) * width * gain * 1000 / elapsed - this.dragVelocity.x) * velocityAlpha;
      this.dragVelocity.y += ((point.y - this.dragRaw.y) * height * gain * 1000 / elapsed - this.dragVelocity.y) * velocityAlpha;
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
        const stillAlpha = 1 - Math.pow(.9, elapsed / 50);
        this.dragStillPoint.x += (point.x - this.dragStillPoint.x) * stillAlpha;
        this.dragStillPoint.y += (point.y - this.dragStillPoint.y) * stillAlpha;
        // A fixed anchor (never a per-frame delta) lets slow deliberate motion
        // accumulate, while a brief pause cannot immediately latch the node.
        const stillRadius = c.deadzone * .5 * noiseScale;
        if (!this.dragStopPoint || Math.hypot((this.dragStillPoint.x - this.dragStopPoint.x) * width * gain,
            (this.dragStillPoint.y - this.dragStopPoint.y) * height * gain) > stillRadius) {
          this.dragStopPoint = { ...this.dragStillPoint }; this.dragStopAt = now;
        } else if (now - this.dragStopAt >= c.stopStable) {
          // Freeze at the displayed position and discard filter tail. Changing
          // the deadzone alone would allow residual motion to restart the drag.
          this.rebaseDrag(point, now);
          return;
        }
      }
      const dx = this.dragFiltered.x - s.x, dy = this.dragFiltered.y - s.y, distance = Math.hypot(dx, dy);
      // Far/small hands amplify image noise when movement is normalized.
      const deadzone = (this.dragMoving ? Math.min(c.deadzone, c.movingDeadzone) : c.deadzone * 2) * noiseScale;
      if (distance > deadzone) {
        const scale = 1 - deadzone / distance;
        s.x += dx * scale; s.y += dy * scale;
        if (!this.dragMoving) {
          this.dragMoving = true;
          // Remove the breakaway offset before reducing the deadzone so the
          // next frame cannot jump just because the mode changed.
          this.dragFiltered = { x: s.x, y: s.y };
          this.dragStillPoint = { ...point };
          this.dragStopPoint = null; this.dragStopAt = null;
        }
        move(s.x, s.y);
      }
    }

  }
  const length3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const valid3D = points => points?.length === 21 &&
    points.every(p => [p?.x, p?.y, p?.z].every(Number.isFinite));
  function palmSize(points, stable) {
    const primary = length3(points[0], points[9]);
    if (!stable) return primary;
    // Width is converted to a palm-length equivalent. A median limits the
    // influence of one noisy landmark; depth keeps tilted palms measurable.
    const lengths = [5, 9, 13, 17].map(i => length3(points[0], points[i]));
    lengths.push(length3(points[5], points[17]) * 1.25);
    const usable = lengths.filter(v => v > 1e-8).sort((a, b) => a - b);
    if (!usable.length) return 0;
    const mid = Math.floor(usable.length / 2);
    return usable.length % 2 ? usable[mid] : (usable[mid - 1] + usable[mid]) / 2;
  }
  function bendAngle(a, b, c) {
    const u = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
    const v = { x: c.x - b.x, y: c.y - b.y, z: c.z - b.z };
    const norm = Math.hypot(u.x, u.y, u.z) * Math.hypot(v.x, v.y, v.z);
    if (norm < 1e-10) return null;
    return Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y + u.z * v.z) / norm))) * 180 / Math.PI;
  }
  function singleHandFrame(result, width, height, index, options) {
    const p = result.landmarks?.[index], category = result.handedness?.[index]?.[0];
    if (!p || p.length !== 21 || ![width, height].every(v => Number.isFinite(v) && v > 0) ||
        !p.every(v => Number.isFinite(v?.x) && Number.isFinite(v?.y))) return null;
    const distance = (a, b) => Math.hypot((a.x - b.x) * width, (a.y - b.y) * height);
    const hasDepth = options.depthPinch !== false && valid3D(p);
    // MediaPipe z has x's scale: use image pixels for all three axes.
    // A partial/invalid depth set falls back as a whole, never per landmark.
    const image = p.map(v => ({ x: v.x * width, y: v.y * height, z: hasDepth ? v.z * width : 0 }));
    const stableSize = options.stableHandSize !== false;
    const size = palmSize(image, stableSize);
    if (size < 1) return null;
    const world = result.worldLandmarks?.[index];
    const worldSize = options.depthPinch !== false && valid3D(world) ? palmSize(world, stableSize) : 0;
    // Never combine meters with image pixels. World ratios/angles are computed
    // entirely in world space, with normalized image depth as the fallback.
    const geometry = worldSize > 1e-6 ? world : image;
    const geometrySize = worldSize > 1e-6 ? worldSize : size;
    const ratio2D = distance(p[4], p[8]) / size;
    const ratio3D = length3(geometry[4], geometry[8]) / geometrySize;
    const ratio = Math.max(ratio2D, ratio3D);
    // Finger flexion changes the pinch ratio but must not steer navigation.
    const palm = [0, 5, 9, 13, 17].map(i => p[i]);
    const pointer = { x: palm.reduce((sum, v) => sum + v.x, 0) / palm.length,
      y: palm.reduce((sum, v) => sum + v.y, 0) / palm.length };
    const fingers = [5, 9, 13, 17].map(base => {
      const mcp = geometry[base], pip = geometry[base + 1], dip = geometry[base + 2], tip = geometry[base + 3];
      const ax = pip.x - mcp.x, ay = pip.y - mcp.y, az = pip.z - mcp.z;
      const bx = tip.x - dip.x, by = tip.y - dip.y, bz = tip.z - dip.z;
      const straight = (ax * bx + ay * by + az * bz) /
        (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz) || 1);
      const pipBend = bendAngle(mcp, pip, dip), dipBend = bendAngle(pip, dip, tip);
      const anglesValid = pipBend !== null && dipBend !== null;
      const useAngles = options.jointAngles !== false;
      return { pipBend, dipBend,
        extended: straight > .7 && length3(tip, geometry[0]) > length3(pip, geometry[0]) + geometrySize * .15 &&
          (!useAngles || (anglesValid && pipBend <= 40 && dipBend <= 40)),
        folded: length3(tip, geometry[0]) <= length3(pip, geometry[0]) * 1.15 &&
          (!useAngles || (anglesValid && Math.max(pipBend, dipBend) >= 55)) };
    });
    // Evaluate extension in the selected geometry space, independently of the
    // screen-space direction. A bent/degenerate CMC chain must not delete.
    const mcpBend = bendAngle(geometry[1], geometry[2], geometry[3]);
    const ipBend = bendAngle(geometry[2], geometry[3], geometry[4]);
    const thumbExtended = mcpBend !== null && ipBend !== null && mcpBend <= 40 && ipBend <= 40 &&
      length3(geometry[1], geometry[4]) > geometrySize * .5;
    const thumbX = (p[4].x - p[2].x) * width, thumbY = (p[4].y - p[2].y) * height;
    const thumbAway = distance(p[4], p[5]) > size * .55;
    const thumbPointsDown = thumbY > size * .45 && Math.abs(thumbX) < thumbY * .7 &&
      (p[4].y - p[3].y) * height > size * .15 && thumbAway;
    // Image x is unmirrored: the user's left is +x.
    const tipX = (p[4].x - p[3].x) * width;
    const thumbSide = Math.abs(thumbX) > size * .45 && Math.abs(thumbY) < Math.abs(thumbX) &&
      tipX * thumbX > 0 && Math.abs(tipX) > size * .15 && thumbAway ? (thumbX > 0 ? 'left' : 'right') : null;
    const thumbPose = fingers.every(f => f.folded) && (options.thumbExtension === false || thumbExtended);
    const pose = thumbPose && thumbPointsDown ? 'thumbDown'
      : thumbPose && thumbSide === 'left' ? 'thumbLeft'
      : thumbPose && thumbSide === 'right' ? 'thumbRight'
      : fingers[0].extended && fingers[1].extended && fingers.slice(2).every(f => f.folded) ? 'peace'
      : fingers[0].extended && fingers.slice(1).every(f => f.folded) ? 'point'
      : fingers.every(f => f.folded) ? 'fist' : null;
    return { pointer, tip: p[8], wrist: p[0], handSize: size / width, ratio,
      measurements: { ratio2D, ratio3D, palmSize: size,
        space: worldSize > 1e-6 ? 'world' : hasDepth ? 'image3D' : 'image2D', fingers,
        thumb: { mcpBend, ipBend, extended: thumbExtended, pointsDown: thumbPointsDown, side: thumbSide } },
      pose, identity: category?.score >= .8 ? category.categoryName : null };
  }
  function handFrame(result, width, height, options = {}) {
    const first = singleHandFrame(result, width, height, 0, options);
    if (!first || result.landmarks.length < 2) return first;
    const second = singleHandFrame(result, width, height, 1, options);
    if (!second) return null;
    // Palm centers avoid changes caused by finger flexion. Image-width units
    // preserve the aspect ratio; distance is independent of detection order.
    const frame = { hands: 2, pointer: { x: (first.pointer.x + second.pointer.x) / 2,
      y: (first.pointer.y + second.pointer.y) / 2 }, distance: Math.hypot(first.pointer.x - second.pointer.x,
      (first.pointer.y - second.pointer.y) * height / width) };
    if (first.pose === 'point' || second.pose === 'point') {
      frame.pose = 'point';
      frame.toggleHand = first.pose === 'point' ? first : second;
    }
    else if (first.pose === 'fist' && second.pose === 'fist') frame.pose = 'bothFists';
    else if (first.pose === 'fist' || second.pose === 'fist') frame.pose = 'fist';
    return frame;
  }
  root.HandGestures = { HandController, handFrame, directionalTarget, TRACKING_TIMEOUT_MS };
  if (typeof module !== 'undefined') module.exports = root.HandGestures;
})(globalThis);
