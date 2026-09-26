// Page world. Capital Bikeshare overlay: every dock station from a configurable
// zoom level, hover tooltip with its name, dock count and jurisdiction.
(() => {
  const { world, createCanvasLayer, FONT } = window.__gmo.util;

  const RED = '#E4002B';

  window.__gmo.overlays.cabi = ({ gm, map, data, cfg }) => {
    const stations = data.stations.map(([name, lat, lng, capacity, region]) => ({
      name, capacity, region: data.regions[region], w: world(lng, lat),
    }));

    let hover = null; // station under the mouse
    let screenStations = []; // [{s, x, y, r}] from the last render, for hit testing

    const layer = createCanvasLayer({
      gm,
      map,
      className: 'gmo-cabi',
      zIndex: 1,
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
      screenStations = [];
      if (zoom < (cfg.minZoom ?? 13) - 0.01) return;
      const r = zoom < 14 ? 3.5 : zoom < 16 ? 4.5 : 6;
      for (const s of stations) {
        const [x, y] = px(s.w);
        if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
        screenStations.push({ s, x, y, r });
      }
      for (const { s, x, y, r: rad } of screenStations) {
        ctx.beginPath();
        ctx.arc(x, y, s === hover ? rad + 1.5 : rad, 0, Math.PI * 2);
        ctx.fillStyle = RED;
        ctx.fill();
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
      }
      const hovered = hover && screenStations.find((st) => st.s === hover);
      if (hovered) drawTooltip(ctx, W, hovered);
    }

    function drawTooltip(ctx, W, { s, x, y, r }) {
      const pad = 8;
      const sub = `${s.capacity} dock${s.capacity === 1 ? '' : 's'}${s.region ? ` · ${s.region}` : ''}`;
      ctx.font = `600 13px ${FONT}`;
      const nameW = ctx.measureText(s.name).width;
      ctx.font = `12px ${FONT}`;
      const w = Math.max(nameW, ctx.measureText(sub).width) + pad * 2;
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
      ctx.fillStyle = '#555';
      ctx.font = `12px ${FONT}`;
      ctx.fillText(sub, bx + pad, by + 31);
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
