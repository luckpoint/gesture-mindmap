/* Camera panel overlays: the always-on hand shape and optional diagnostics.
   Preview coordinates follow the mirrored object-fit:cover video; text is
   drawn normally so landmark numbers remain readable. */
(function (root) {
  const chains = [[0, 1, 2, 3, 4], [0, 5, 6, 7, 8], [5, 9, 10, 11, 12],
    [9, 13, 14, 15, 16], [13, 17, 18, 19, 20], [0, 17]];
  function previewPoint(point, width, height, viewWidth, viewHeight) {
    const scale = Math.max(viewWidth / width, viewHeight / height);
    return { x: viewWidth - (point.x * width * scale + (viewWidth - width * scale) / 2),
      y: point.y * height * scale + (viewHeight - height * scale) / 2 };
  }
  // Mirrors all hands and scales them as one group to fill the view.
  function fitPoints(hands, width, height, viewWidth, viewHeight) {
    const flat = hands.flat(), xs = flat.map(p => (1 - p.x) * width), ys = flat.map(p => p.y * height);
    const left = Math.min(...xs), top = Math.min(...ys), w = Math.max(...xs) - left, h = Math.max(...ys) - top;
    if (!(w > 0 && h > 0)) return null;
    const pad = Math.min(viewWidth, viewHeight) * .12;
    const scale = Math.min((viewWidth - pad * 2) / w, (viewHeight - pad * 2) / h);
    const ox = (viewWidth - w * scale) / 2, oy = (viewHeight - h * scale) / 2;
    return hands.map(points => points.map(p => ({ x: ox + ((1 - p.x) * width - left) * scale, y: oy + (p.y * height - top) * scale })));
  }
  function context2d(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const dpr = Math.min(root.devicePixelRatio || 1, 2);
    canvas.width = Math.round(rect.width * dpr);
    canvas.height = Math.round(rect.height * dpr);
    const ctx = canvas.getContext('2d');
    ctx?.scale(dpr, dpr);
    return ctx && { ctx, rect };
  }
  class HandShapeView {
    constructor(canvas) { this.canvas = canvas; }
    clear() { this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height); }
    draw(result, width, height, fit) {
      this.clear();
      const hands = result?.landmarks?.filter(points => points?.length === 21 && points.every(p => Number.isFinite(p?.x) && Number.isFinite(p?.y)));
      if (!hands?.length || !(width > 0 && height > 0)) return;
      const target = context2d(this.canvas);
      if (!target) return;
      const { ctx, rect } = target;
      const projected = fit ? fitPoints(hands, width, height, rect.width, rect.height)
        : hands.map(points => points.map(p => previewPoint(p, width, height, rect.width, rect.height)));
      if (!projected) return;
      ctx.lineCap = ctx.lineJoin = 'round';
      projected.forEach((points, index) => {
        const color = index ? '#ffc857' : '#63ffd5';
        for (const [lineWidth, strokeStyle] of [[fit ? 9 : 6, '#10261f'], [fit ? 5 : 3, color]]) {
          ctx.lineWidth = lineWidth; ctx.strokeStyle = strokeStyle;
          for (const chain of chains) {
            ctx.beginPath();
            chain.forEach((id, i) => ctx[i ? 'lineTo' : 'moveTo'](points[id].x, points[id].y));
            ctx.stroke();
          }
        }
        ctx.fillStyle = color;
        for (const p of points) { ctx.beginPath(); ctx.arc(p.x, p.y, fit ? 4 : 3, 0, Math.PI * 2); ctx.fill(); }
      });
    }
  }
  class HandDebugOverlay {
    constructor(canvas, output) { this.canvas = canvas; this.output = output; this.enabled = false; }
    setEnabled(enabled) {
      this.enabled = enabled;
      this.canvas.hidden = this.output.hidden = !enabled;
      this.clear();
    }
    clear() {
      this.canvas.getContext('2d')?.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.output.textContent = root.I18n.t('cam.debugEmpty');
    }
    draw(result, width, height) {
      if (!this.enabled) return;
      if (!result?.landmarks?.length || !(width > 0 && height > 0)) { this.clear(); return; }
      // A collapsed preview has no drawing area. Don't allocate or measure hands.
      const target = context2d(this.canvas);
      if (!target) { this.clear(); return; }
      const { ctx, rect } = target;
      ctx.lineWidth = 1.5; ctx.font = 'bold 10px monospace';
      const values = [];
      result.landmarks.forEach((points, index) => {
        const frame = root.HandGestures.handFrame({ landmarks: [points],
          worldLandmarks: [result.worldLandmarks?.[index]], handedness: [result.handedness?.[index]] }, width, height);
        if (!frame) { values.push(`${index + 1}: invalid landmarks`); return; }
        const projected = points.map(p => previewPoint(p, width, height, rect.width, rect.height));
        ctx.strokeStyle = index ? '#ffc857' : '#63ffd5';
        for (const chain of chains) {
          ctx.beginPath();
          chain.forEach((id, i) => ctx[i ? 'lineTo' : 'moveTo'](projected[id].x, projected[id].y));
          ctx.stroke();
        }
        projected.forEach((p, id) => {
          ctx.fillStyle = ctx.strokeStyle;
          ctx.beginPath(); ctx.arc(p.x, p.y, 2, 0, Math.PI * 2); ctx.fill();
          ctx.lineWidth = 3; ctx.strokeStyle = '#10261f';
          ctx.strokeText(String(id), p.x + 4, p.y - 4);
          ctx.fillText(String(id), p.x + 4, p.y - 4);
          ctx.strokeStyle = ctx.fillStyle; ctx.lineWidth = 1.5;
        });
        const m = frame.measurements, thumb = m.thumb;
        const angle = v => v === null ? '—' : `${v.toFixed(0)}°`;
        values.push(`${index + 1} ${frame.identity || '?'} · pose: ${frame.pose || 'neutral'}\n` +
          `pinch: ${frame.ratio.toFixed(3)} (XY ${m.ratio2D.toFixed(3)} / 3D ${m.ratio3D.toFixed(3)})\n` +
          `${m.space} · palm: ${m.palmSize.toFixed(1)}px\n` +
          `thumb: MCP ${angle(thumb.mcpBend)} / IP ${angle(thumb.ipBend)} · extended: ${thumb.extended} · down: ${thumb.pointsDown} · side: ${thumb.side || '-'}`);
      });
      this.output.textContent = values.join('\n\n');
    }
  }
  root.HandDebugOverlay = HandDebugOverlay;
  root.HandShapeView = HandShapeView;
  if (typeof module !== 'undefined') module.exports = { HandDebugOverlay, HandShapeView, previewPoint, fitPoints };
})(globalThis);
