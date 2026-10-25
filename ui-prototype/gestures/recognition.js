/* Stateless landmark geometry and pose recognition; no camera, DOM or control state. */
(function (root) {
  const length3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const valid3D = points => points?.length === 21 && points.every(p => [p?.x, p?.y, p?.z].every(Number.isFinite));
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
    return (Math.acos(Math.max(-1, Math.min(1, (u.x * v.x + u.y * v.y + u.z * v.z) / norm))) * 180) / Math.PI;
  }
  function singleHandFrame(result, width, height, index, options) {
    const p = result.landmarks?.[index],
      category = result.handedness?.[index]?.[0];
    if (
      !p ||
      p.length !== 21 ||
      ![width, height].every(v => Number.isFinite(v) && v > 0) ||
      !p.every(v => Number.isFinite(v?.x) && Number.isFinite(v?.y))
    )
      return null;
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
    const pointer = {
      x: palm.reduce((sum, v) => sum + v.x, 0) / palm.length,
      y: palm.reduce((sum, v) => sum + v.y, 0) / palm.length,
    };
    const fingers = [5, 9, 13, 17].map(base => {
      const mcp = geometry[base],
        pip = geometry[base + 1],
        dip = geometry[base + 2],
        tip = geometry[base + 3];
      const ax = pip.x - mcp.x,
        ay = pip.y - mcp.y,
        az = pip.z - mcp.z;
      const bx = tip.x - dip.x,
        by = tip.y - dip.y,
        bz = tip.z - dip.z;
      const straight = (ax * bx + ay * by + az * bz) / (Math.hypot(ax, ay, az) * Math.hypot(bx, by, bz) || 1);
      const pipBend = bendAngle(mcp, pip, dip),
        dipBend = bendAngle(pip, dip, tip);
      const anglesValid = pipBend !== null && dipBend !== null;
      const useAngles = options.jointAngles !== false;
      return {
        pipBend,
        dipBend,
        extended:
          straight > 0.7 &&
          length3(tip, geometry[0]) > length3(pip, geometry[0]) + geometrySize * 0.15 &&
          (!useAngles || (anglesValid && pipBend <= 40 && dipBend <= 40)),
        folded:
          length3(tip, geometry[0]) <= length3(pip, geometry[0]) * 1.15 &&
          (!useAngles || (anglesValid && Math.max(pipBend, dipBend) >= 55)),
      };
    });
    // Measure extension in geometry space and direction in screen space.
    const mcpBend = bendAngle(geometry[1], geometry[2], geometry[3]);
    const ipBend = bendAngle(geometry[2], geometry[3], geometry[4]);
    const thumbX = (p[4].x - p[2].x) * width,
      thumbY = (p[4].y - p[2].y) * height;
    const thumbAway = distance(p[4], p[5]) > size * 0.55;
    // Cover diagonal-down thumbs up to the side-pose boundary (45 degrees).
    const thumbPointsDown =
      thumbY > size * 0.45 && Math.abs(thumbX) <= thumbY && (p[4].y - p[3].y) * height > size * 0.15 && thumbAway;
    // A natural downward thumb can be slightly bent. Keep the stricter side
    // gesture limits and reject strongly curled or degenerate thumbs.
    const thumbExtended =
      mcpBend !== null &&
      ipBend !== null &&
      mcpBend <= (thumbPointsDown ? 55 : 40) &&
      ipBend <= (thumbPointsDown ? 50 : 40) &&
      length3(geometry[1], geometry[4]) > geometrySize * 0.5;
    // Image x is unmirrored: the user's left is +x.
    const tipX = (p[4].x - p[3].x) * width;
    const thumbSide =
      Math.abs(thumbX) > size * 0.45 &&
      Math.abs(thumbY) < Math.abs(thumbX) &&
      tipX * thumbX > 0 &&
      Math.abs(tipX) > size * 0.15 &&
      thumbAway
        ? thumbX > 0
          ? 'left'
          : 'right'
        : null;
    const thumbPose = fingers.every(f => f.folded) && (options.thumbExtension === false || thumbExtended);
    const pose =
      thumbPose && thumbPointsDown
        ? 'thumbDown'
        : thumbPose && thumbSide === 'left'
          ? 'thumbLeft'
          : thumbPose && thumbSide === 'right'
            ? 'thumbRight'
            : fingers[0].extended && fingers[1].extended && fingers.slice(2).every(f => f.folded)
              ? 'peace'
              : fingers[0].extended && fingers.slice(1).every(f => f.folded)
                ? 'point'
                : fingers.every(f => f.folded)
                  ? 'fist'
                  : fingers.every(f => f.extended) && ratio >= 0.55
                    ? 'palm'
                    : null;
    return {
      pointer,
      indexBase: p[5],
      tip: p[8],
      wrist: p[0],
      handSize: size / width,
      ratio,
      measurements: {
        ratio2D,
        ratio3D,
        palmSize: size,
        space: worldSize > 1e-6 ? 'world' : hasDepth ? 'image3D' : 'image2D',
        fingers,
        thumb: { mcpBend, ipBend, extended: thumbExtended, pointsDown: thumbPointsDown, side: thumbSide },
      },
      pose,
      identity: category?.score >= 0.8 ? category.categoryName : null,
    };
  }
  function crossedIndexes(first, second, width, height) {
    if (first.pose !== 'point' || second.pose !== 'point') return false;
    const vector = (a, b) => ({ x: (b.x - a.x) * width, y: (b.y - a.y) * height });
    const a = vector(first.indexBase, first.tip),
      b = vector(second.indexBase, second.tip);
    const offset = vector(first.indexBase, second.indexBase);
    const cross = (u, v) => u.x * v.y - u.y * v.x;
    const determinant = cross(a, b),
      length = Math.hypot(a.x, a.y) * Math.hypot(b.x, b.y);
    // Require at least a 30-degree crossing, within both fingers rather than
    // touching fingertips or intersecting imaginary extensions of the fingers.
    if (!length || Math.abs(determinant) / length < 0.5) return false;
    const t = cross(offset, b) / determinant,
      u = cross(offset, a) / determinant;
    return t >= 0.15 && t <= 0.9 && u >= 0.15 && u <= 0.9;
  }
  // Pure recognition boundary: MediaPipe results + image dimensions + geometry
  // options -> a single/two-hand sample, or null for invalid landmarks.
  // Samples contain pose, normalized pointer/pinch metrics and diagnostics;
  // timing, smoothing, gesture holds and application actions belong to HandController.
  function handFrame(result, width, height, options = {}) {
    const first = singleHandFrame(result, width, height, 0, options);
    if (!first || result.landmarks.length < 2) return first;
    const second = singleHandFrame(result, width, height, 1, options);
    if (!second) return null;
    // Palm centers avoid changes caused by finger flexion. Image-width units
    // preserve the aspect ratio; distance is independent of detection order.
    const frame = {
      hands: 2,
      pointer: { x: (first.pointer.x + second.pointer.x) / 2, y: (first.pointer.y + second.pointer.y) / 2 },
      distance: Math.hypot(first.pointer.x - second.pointer.x, ((first.pointer.y - second.pointer.y) * height) / width),
      palms: [first, second]
        .map(hand => ({ x: hand.pointer.x, y: (hand.pointer.y * height) / width }))
        .sort((a, b) => a.x - b.x || a.y - b.y),
    };
    if (first.pose === 'palm' || second.pose === 'palm') {
      frame.palmPointer =
        first.pose === 'palm' && second.pose === 'palm'
          ? frame.pointer
          : first.pose === 'palm'
            ? first.pointer
            : second.pointer;
    }
    if (crossedIndexes(first, second, width, height)) frame.pose = 'cross';
    else if (first.pose === 'point' || second.pose === 'point') {
      frame.pose = 'point';
      frame.pointHand = first.pose === 'point' ? first : second;
    } else if (first.pose === 'fist' && second.pose === 'fist') frame.pose = 'bothFists';
    else if (first.pose === 'fist' || second.pose === 'fist') {
      frame.pose = 'fist';
      frame.panHand = first.pose === 'fist' ? first : second;
    } else frame.pose = 'neutral';
    return frame;
  }
  root.HandRecognition = { handFrame };
  if (typeof module !== 'undefined') module.exports = root.HandRecognition;
})(globalThis);
