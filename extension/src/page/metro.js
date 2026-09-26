// Page world. WMATA Metrorail overlay: colored lines (shared track drawn side by
// side), station dots, optional labels, hover tooltip.
(() => {
  const { world, createCanvasLayer, FONT } = window.__gmo.util;

  window.__gmo.overlays.wmata = ({ gm, map, data, cfg }) => {
    const lines = data.lines.map((l) => ({ ...l, pts: l.coords.map(([lng, lat, off]) => [...world(lng, lat), off]) }));
    const colorOf = Object.fromEntries(data.lines.map((l) => [l.id, l.color]));
    const stations = data.stations.map((s) => ({ ...s, w: world(s.lng, s.lat) }));

    let hover = null; // station (data object) under the mouse
    let screenStations = []; // [{s, x, y, r, n}] from the last render, for hit testing
    const lineOn = (id) => cfg.lines?.[id] !== false;

    const layer = createCanvasLayer({
      gm,
      map,
      className: 'gmo-wmata',
      zIndex: 2,
      opacity: cfg.opacity ?? 0.9,
      render,
      events: {
        mousemove: onMove,
        mouseout: () => setHover(null),
        zoom_changed: () => setHover(null),
        dragstart: () => setHover(null),
      },
    });

    function render(ctx, { W, H, zoom, px }) {
      const width = zoom < 10 ? 2 : zoom < 11 ? 2.5 : zoom < 12 ? 3.5 : zoom < 13 ? 4.5 : zoom < 15 ? 5.5 : 7;

      // Project + offset each line so shared track shows side-by-side colors.
      const paths = lines.filter((l) => lineOn(l.id)).map((l) => {
        const p = l.pts.map(px);
        const out = new Array(p.length);
        for (let i = 0; i < p.length; i++) {
          const a = p[Math.max(0, i - 1)];
          const b = p[Math.min(p.length - 1, i + 1)];
          let dx = b[0] - a[0];
          let dy = b[1] - a[1];
          const len = Math.hypot(dx, dy) || 1;
          dx /= len;
          dy /= len;
          const off = l.pts[i][2] * width;
          out[i] = [p[i][0] - dy * off, p[i][1] + dx * off];
        }
        return { l, out };
      });

      const stroke = (pts) => {
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      };
      ctx.lineJoin = ctx.lineCap = 'round';
      // White casing under everything, then the colored lines.
      ctx.strokeStyle = 'rgba(255,255,255,0.85)';
      ctx.lineWidth = width + 3;
      paths.forEach((p) => stroke(p.out));
      paths.forEach((p) => {
        ctx.strokeStyle = p.l.color;
        ctx.lineWidth = width;
        stroke(p.out);
      });

      screenStations = [];
      if (cfg.stations !== false && zoom >= 10) {
        for (const s of stations) {
          const n = s.lines.filter(lineOn).length;
          if (!n) continue;
          const [x, y] = px(s.w);
          if (x < -40 || y < -40 || x > W + 40 || y > H + 40) continue;
          const r = Math.max(width * 0.9, (n * width) / 2 + 1.5) + (zoom >= 13 ? 1 : 0);
          screenStations.push({ s, x, y, r, n });
        }
        for (const { s, x, y, r, n } of screenStations) {
          ctx.beginPath();
          ctx.arc(x, y, r, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = n > 1 ? 2 : 1.75;
          ctx.strokeStyle = n > 1 ? '#222' : colorOf[s.lines.find(lineOn)];
          ctx.stroke();
        }
        if (cfg.labels && zoom >= 12.5) drawLabels(ctx, W, H, zoom);
      }
      const hovered = hover && screenStations.find((st) => st.s === hover);
      if (hovered) drawTooltip(ctx, W, hovered);
    }

    function drawLabels(ctx, W, H, zoom) {
      const size = zoom >= 15 ? 13 : 11.5;
      ctx.font = `600 ${size}px ${FONT}`;
      ctx.textBaseline = 'middle';
      const taken = [];
      // Transfer stations first so they win collisions.
      for (const st of [...screenStations].sort((a, b) => b.n - a.n)) {
        if (st.s === hover) continue;
        const text = st.s.name;
        const tw = ctx.measureText(text).width;
        for (const [lx, ly] of [[st.x + st.r + 4, st.y], [st.x - st.r - 4 - tw, st.y]]) {
          const box = [lx - 2, ly - size / 2 - 2, lx + tw + 2, ly + size / 2 + 2];
          if (box[2] < 0 || box[0] > W || box[3] < 0 || box[1] > H) break;
          if (taken.some((b) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1])) continue;
          taken.push(box);
          ctx.lineWidth = 3.5;
          ctx.strokeStyle = 'rgba(255,255,255,0.95)';
          ctx.strokeText(text, lx, ly);
          ctx.fillStyle = '#1a1a1a';
          ctx.fillText(text, lx, ly);
          break;
        }
      }
    }

    function drawTooltip(ctx, W, { s, x, y, r }) {
      const pad = 8;
      const dot = 10;
      ctx.font = `600 13px ${FONT}`;
      const nameW = ctx.measureText(s.name).width;
      ctx.font = `12px ${FONT}`;
      const lineLabel = s.lines.map((id) => id[0].toUpperCase() + id.slice(1)).join(' · ');
      const sub = ctx.measureText(lineLabel).width + s.lines.length * (dot + 4);
      const w = Math.max(nameW, sub) + pad * 2;
      const h = 44;
      let bx = x + r + 8;
      if (bx + w > W) bx = x - r - 8 - w;
      const by = Math.max(4, y - h / 2);
      ctx.save();
      ctx.shadowColor = 'rgba(0,0,0,0.25)';
      ctx.shadowBlur = 8;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.roundRect(bx, by, w, h, 6);
      ctx.fill();
      ctx.restore();
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#111';
      ctx.font = `600 13px ${FONT}`;
      ctx.fillText(s.name, bx + pad, by + 14);
      let cx = bx + pad;
      for (const id of s.lines) {
        ctx.beginPath();
        ctx.arc(cx + dot / 2, by + 31, dot / 2, 0, Math.PI * 2);
        ctx.fillStyle = colorOf[id];
        ctx.fill();
        cx += dot + 4;
      }
      ctx.fillStyle = '#555';
      ctx.font = `12px ${FONT}`;
      ctx.fillText(lineLabel, cx, by + 31);
      // Ring the hovered station.
      ctx.beginPath();
      ctx.arc(x, y, r + 3, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#111';
      ctx.stroke();
    }

    function onMove(e) {
      const p = screenStations.length && layer.eventPixel(e);
      if (!p) return setHover(null);
      let best = null;
      let bd = Infinity;
      for (const st of screenStations) {
        const d = Math.hypot(st.x - p[0], st.y - p[1]);
        if (d <= st.r + 5 && d < bd) {
          bd = d;
          best = st;
        }
      }
      setHover(best && best.s);
    }

    function setHover(s) {
      if ((s || null) === hover) return;
      hover = s || null;
      layer.schedule();
    }

    return {
      update(next) {
        cfg = next;
        layer.setOpacity(cfg.opacity ?? 0.9);
        layer.schedule();
      },
      destroy: () => layer.destroy(),
    };
  };
})();
