// Page world. Shared namespace + a canvas layer that overlays can draw into.
// Loaded before the overlay modules and core.js (see manifest.json).
(() => {
  if (window.__gmo) return;
  const gmo = { overlays: {}, util: {} };
  Object.defineProperty(window, '__gmo', { value: gmo });

  // Web Mercator "world" coordinates (0..256).
  const world = (lng, lat) => {
    const s = Math.min(Math.max(Math.sin((lat * Math.PI) / 180), -0.9999), 0.9999);
    return [((lng + 180) / 360) * 256, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 256];
  };

  // Decodes Google's encoded polyline format into world coordinates.
  const decodePolyline = (str) => {
    const out = [];
    let i = 0, lat = 0, lng = 0;
    while (i < str.length) {
      for (const which of [0, 1]) {
        let b, shift = 0, result = 0;
        do {
          b = str.charCodeAt(i++) - 63;
          result |= (b & 0x1f) << shift;
          shift += 5;
        } while (b >= 0x20);
        const d = result & 1 ? ~(result >> 1) : result >> 1;
        if (which === 0) lat += d;
        else lng += d;
      }
      out.push(world(lng / 1e5, lat / 1e5));
    }
    return out;
  };

  const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  // Reference points used to recover the world -> container pixel transform.
  const REF_A = [38.8, -77.2];
  const REF_B = [39.0, -76.9];
  const wA = world(REF_A[1], REF_A[0]);
  const wB = world(REF_B[1], REF_B[0]);

  /**
   * Creates a full-viewport canvas in the map's overlayLayer pane and redraws it
   * whenever the map moves. `render(ctx, view)` gets a view with:
   *   W, H, zoom, px([wx, wy]) -> [x, y] container pixels, toWorld (inverse), left/top (container
   *   origin in pane coordinates, for positioning DOM in other panes).
   */
  function createCanvasLayer({ gm, map, className, zIndex = 0, opacity = 1, render, onAdd, onRemove, events = {} }) {
    const overlay = new gm.OverlayView();
    let canvas = null;
    let ctx = null;
    let frame = 0;
    let listeners = [];
    let view = null;
    const dpr = () => window.devicePixelRatio || 1;

    function computeView() {
      const proj = overlay.getProjection();
      if (!proj) return null;
      const a = new gm.LatLng(REF_A[0], REF_A[1]);
      const pA = proj.fromLatLngToContainerPixel(a);
      const pB = proj.fromLatLngToContainerPixel(new gm.LatLng(REF_B[0], REF_B[1]));
      const dA = proj.fromLatLngToDivPixel(a);
      if (!pA || !pB || !dA) return null;
      const sx = (pB.x - pA.x) / (wB[0] - wA[0]);
      const sy = (pB.y - pA.y) / (wB[1] - wA[1]);
      const ox = pA.x - sx * wA[0];
      const oy = pA.y - sy * wA[1];
      const div = map.getDiv();
      return {
        W: div.clientWidth,
        H: div.clientHeight,
        zoom: Math.log2(sx),
        px: (w) => [sx * w[0] + ox, sy * w[1] + oy],
        toWorld: ([x, y]) => [(x - ox) / sx, (y - oy) / sy],
        // Container pixel (0,0) in pane (div) coordinates.
        left: dA.x - pA.x,
        top: dA.y - pA.y,
      };
    }

    function draw() {
      if (!canvas) return;
      view = computeView();
      // OverlayView projections don't support tilted/rotated vector maps.
      const tilted = (map.getTilt?.() || 0) > 0 || (map.getHeading?.() || 0) !== 0;
      if (!view || !view.W || !view.H || tilted) {
        canvas.style.display = 'none';
        view = null;
        return;
      }
      const { W, H } = view;
      const r = dpr();
      canvas.style.display = '';
      canvas.style.left = `${view.left}px`;
      canvas.style.top = `${view.top}px`;
      canvas.style.width = `${W}px`;
      canvas.style.height = `${H}px`;
      if (canvas.width !== Math.round(W * r) || canvas.height !== Math.round(H * r)) {
        canvas.width = Math.round(W * r);
        canvas.height = Math.round(H * r);
      }
      ctx.setTransform(r, 0, 0, r, 0, 0);
      ctx.clearRect(0, 0, W, H);
      render(ctx, view);
    }

    function schedule() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(draw);
    }

    overlay.onAdd = function () {
      canvas = document.createElement('canvas');
      canvas.className = className;
      canvas.style.cssText = `position:absolute;pointer-events:none;z-index:${zIndex};opacity:${opacity};`;
      ctx = canvas.getContext('2d');
      const panes = this.getPanes();
      panes.overlayLayer.appendChild(canvas);
      listeners = [map.addListener('bounds_changed', schedule)];
      for (const [name, fn] of Object.entries(events)) listeners.push(map.addListener(name, fn));
      onAdd?.(panes);
    };
    overlay.draw = draw;
    overlay.onRemove = function () {
      listeners.forEach((l) => l.remove());
      listeners = [];
      cancelAnimationFrame(frame);
      canvas?.remove();
      canvas = ctx = view = null;
      onRemove?.();
    };
    overlay.setMap(map);

    return {
      schedule,
      // Last rendered view (null when hidden). Use for hit testing.
      get view() {
        return view;
      },
      // Mouse event -> container pixel, using the current transform.
      eventPixel(e) {
        const v = view || computeView();
        if (!v || !e?.latLng) return null;
        return v.px(world(e.latLng.lng(), e.latLng.lat()));
      },
      setOpacity(o) {
        opacity = o;
        if (canvas) canvas.style.opacity = String(o);
      },
      destroy() {
        overlay.setMap(null);
      },
    };
  }

  Object.assign(gmo.util, { world, decodePolyline, createCanvasLayer, FONT });
})();
