// Page world. WMATA Metrobus overlay: every route's shape, every stop from a
// configurable zoom level, and a card listing a stop's routes when it's clicked.
// Clicking a route in the card highlights it (and the stops it serves).
(() => {
  const { world, decodePolyline, createCanvasLayer } = window.__gmo.util;

  const CARD_CSS = `
    :host { all: initial; }
    .card { position: relative; transform: translate(-50%, calc(-100% - 14px)); width: max-content; max-width: 300px;
      background: #fff; color: #1b1b1f; border-radius: 10px; box-shadow: 0 4px 18px rgba(0,0,0,.28);
      font: 13px/1.35 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; padding: 10px 12px 10px; cursor: default; }
    .card::after { content: ""; position: absolute; left: 50%; bottom: -7px; width: 14px; height: 14px; background: #fff;
      transform: translateX(-50%) rotate(45deg); box-shadow: 3px 3px 5px rgba(0,0,0,.08); }
    header { display: flex; align-items: flex-start; gap: 10px; }
    .name { flex: 1; font-weight: 650; font-size: 14px; }
    .x { all: unset; cursor: pointer; font-size: 18px; line-height: 1; color: #666; padding: 0 2px; }
    .x:hover { color: #000; }
    .meta { color: #666; font-size: 12px; margin: 2px 0 8px; }
    ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 3px; max-height: 240px; overflow: auto; }
    .route { all: unset; box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; padding: 3px 4px;
      border-radius: 6px; cursor: pointer; }
    .route:hover { background: #f1f3f4; }
    .route.on { background: #e8f0fe; }
    .route:focus-visible { outline: 2px solid #1a73e8; }
    .id { flex: none; min-width: 34px; text-align: center; padding: 2px 6px; border-radius: 4px; background: var(--c);
      color: #fff; font-weight: 700; font-size: 12px; }
    .long { color: #333; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .hint { color: #888; font-size: 11px; margin-top: 7px; }
  `;

  window.__gmo.overlays.bus = ({ gm, map, data, cfg }) => {
    const routes = data.routes.map((r) => {
      const shapes = r.shapes.map((enc) => {
        const pts = decodePolyline(enc);
        const bbox = [Infinity, Infinity, -Infinity, -Infinity];
        for (const [x, y] of pts) {
          if (x < bbox[0]) bbox[0] = x;
          if (y < bbox[1]) bbox[1] = y;
          if (x > bbox[2]) bbox[2] = x;
          if (y > bbox[3]) bbox[3] = y;
        }
        return { pts, bbox };
      });
      return { id: r.id, name: r.name, color: r.color, shapes };
    });
    const stops = data.stops.map(([code, name, lat, lng, ...rs]) => ({ code, name, w: world(lng, lat), routes: rs }));

    let highlight = null; // route index
    let selected = null; // stop
    let hover = null; // stop
    let screenStops = [];
    let card = null; // { host, root }
    let floatPane = null;
    let savedCursor;

    const layer = createCanvasLayer({
      gm,
      map,
      className: 'gmo-bus',
      zIndex: 1,
      opacity: cfg.opacity ?? 0.85,
      render,
      onAdd: (panes) => {
        floatPane = panes.floatPane;
      },
      onRemove: () => {
        closeCard();
        setCursor(false);
      },
      events: {
        mousemove: onMove,
        mouseout: () => setHover(null),
        click: onClick,
      },
    });

    function render(ctx, view) {
      const { W, H, zoom, px } = view;
      ctx.lineJoin = ctx.lineCap = 'round';

      if (cfg.lines !== false) {
        const width = zoom < 12 ? 1.25 : zoom < 14 ? 2 : zoom < 16 ? 3 : 4;
        // Viewport in world coordinates, for culling shapes.
        const tl = view.toWorld([-20, -20]);
        const br = view.toWorld([W + 20, H + 20]);
        const visible = (b) => b[2] >= tl[0] && b[0] <= br[0] && b[3] >= tl[1] && b[1] <= br[1];
        const strokeShape = (pts) => {
          ctx.beginPath();
          for (let i = 0; i < pts.length; i++) {
            const [x, y] = px(pts[i]);
            if (i) ctx.lineTo(x, y);
            else ctx.moveTo(x, y);
          }
          ctx.stroke();
        };
        ctx.lineWidth = width;
        ctx.globalAlpha = highlight === null ? 0.75 : 0.18;
        routes.forEach((r, i) => {
          if (i === highlight) return;
          ctx.strokeStyle = r.color;
          for (const s of r.shapes) if (visible(s.bbox)) strokeShape(s.pts);
        });
        ctx.globalAlpha = 1;
        if (highlight !== null) {
          const r = routes[highlight];
          const hs = r.shapes.filter((s) => visible(s.bbox));
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = width + 5;
          hs.forEach((s) => strokeShape(s.pts));
          ctx.strokeStyle = r.color;
          ctx.lineWidth = width + 2;
          hs.forEach((s) => strokeShape(s.pts));
        }
      }

      screenStops = [];
      const showStops = cfg.stops !== false && zoom >= (cfg.stopZoom ?? 15) - 0.01;
      if (showStops) {
        const r = zoom < 16 ? 3.5 : zoom < 17 ? 4.5 : 5.5;
        for (const s of stops) {
          const [x, y] = px(s.w);
          if (x < -10 || y < -10 || x > W + 10 || y > H + 10) continue;
          screenStops.push({ s, x, y, r });
        }
        const hlColor = highlight !== null && routes[highlight].color;
        for (const { s, x, y, r: rad } of screenStops) {
          const served = highlight === null || s.routes.includes(highlight);
          ctx.globalAlpha = served ? 1 : 0.3;
          ctx.beginPath();
          ctx.arc(x, y, s === hover ? rad + 1.5 : rad, 0, Math.PI * 2);
          ctx.fillStyle = '#fff';
          ctx.fill();
          ctx.lineWidth = s === hover ? 2.25 : 1.75;
          ctx.strokeStyle = highlight !== null && served ? hlColor : '#0b3a75';
          ctx.stroke();
        }
        ctx.globalAlpha = 1;
      }
      // The selected stop stays marked even below the stop zoom level.
      if (selected) {
        const [x, y] = px(selected.w);
        ctx.beginPath();
        ctx.arc(x, y, 6.5, 0, Math.PI * 2);
        ctx.fillStyle = '#0b3a75';
        ctx.fill();
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#fff';
        ctx.stroke();
        positionCard(view);
      }
    }

    function hit(e) {
      const p = screenStops.length && layer.eventPixel(e);
      if (!p) return null;
      let best = null;
      let bd = Infinity;
      for (const st of screenStops) {
        const d = Math.hypot(st.x - p[0], st.y - p[1]);
        if (d <= st.r + 6 && d < bd) {
          bd = d;
          best = st.s;
        }
      }
      return best;
    }

    function onMove(e) {
      setHover(hit(e));
    }

    function setHover(s) {
      s = s || null;
      if (s === hover) return;
      hover = s;
      setCursor(!!s);
      layer.schedule();
    }

    // Show a pointer over stops via the map's own cursor option; restore after.
    function setCursor(on) {
      if (on) {
        if (savedCursor === undefined) savedCursor = map.get('draggableCursor') ?? null;
        map.setOptions({ draggableCursor: 'pointer' });
      } else if (savedCursor !== undefined) {
        map.setOptions({ draggableCursor: savedCursor });
        savedCursor = undefined;
      }
    }

    function onClick(e) {
      const s = hit(e);
      if (s) openCard(s);
      else if (selected) closeCard();
    }

    function openCard(stop) {
      closeCard(false);
      selected = stop;
      if (highlight !== null && !stop.routes.includes(highlight)) {
        highlight = null;
        layer.dimOthers(false);
      }
      if (!floatPane) return;
      const host = document.createElement('div');
      host.className = 'gmo-bus-card';
      host.style.cssText = 'position:absolute;z-index:1000;';
      const root = host.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = CARD_CSS;
      const el = document.createElement('div');
      el.className = 'card';
      el.setAttribute('role', 'dialog');
      el.innerHTML = `<header><div class="name"></div><button class="x" title="Close" aria-label="Close">×</button></header>
        <div class="meta"></div><ul></ul><div class="hint">Click a route to highlight it on the map</div>`;
      el.querySelector('.name').textContent = stop.name;
      const n = stop.routes.length;
      el.querySelector('.meta').textContent = `Stop #${stop.code} · ${n} route${n === 1 ? '' : 's'}`;
      const ul = el.querySelector('ul');
      for (const ri of stop.routes) {
        const r = routes[ri];
        const li = document.createElement('li');
        const b = document.createElement('button');
        b.className = 'route';
        b.dataset.route = ri;
        b.title = `${r.id}: ${r.name}`;
        b.innerHTML = '<span class="id"></span><span class="long"></span>';
        b.querySelector('.id').textContent = r.id;
        b.querySelector('.id').style.setProperty('--c', r.color);
        b.querySelector('.long').textContent = r.name;
        b.addEventListener('click', () => {
          highlight = highlight === ri ? null : ri;
          layer.dimOthers(highlight !== null);
          syncCard();
          layer.schedule();
        });
        li.append(b);
        ul.append(li);
      }
      el.querySelector('.x').addEventListener('click', () => closeCard());
      root.append(style, el);
      for (const type of ['click', 'dblclick', 'mousedown', 'pointerdown', 'touchstart', 'wheel', 'contextmenu']) {
        host.addEventListener(type, (ev) => ev.stopPropagation());
      }
      gm.OverlayView.preventMapHitsAndGesturesFrom?.(host);
      floatPane.append(host);
      card = { host, root };
      syncCard();
      layer.schedule();
    }

    function syncCard() {
      if (!card) return;
      for (const b of card.root.querySelectorAll('.route')) b.classList.toggle('on', +b.dataset.route === highlight);
    }

    function positionCard(view) {
      if (!card || !selected) return;
      const [x, y] = view.px(selected.w);
      card.host.style.left = `${x + view.left}px`;
      card.host.style.top = `${y + view.top}px`;
    }

    function closeCard(redraw = true) {
      card?.host.remove();
      card = null;
      selected = null;
      highlight = null;
      layer.dimOthers(false);
      if (redraw) layer.schedule();
    }

    return {
      update(next) {
        cfg = next;
        layer.setOpacity(cfg.opacity ?? 0.85);
        layer.schedule();
      },
      destroy: () => layer.destroy(),
    };
  };
})();
