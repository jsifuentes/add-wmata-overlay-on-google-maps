// Page world, google.com/maps only (a no-op elsewhere). Loaded after core.js.
//
// google.com/maps doesn't use the Maps JS API. It renders with WebGL, either in a
// worker it hands the map <canvas> to (transferControlToOffscreen; Chrome) or on the
// main thread (Firefox), and on every frame of a pan/zoom/fling it posts the camera
// to a worker as a protobuf. We watch those messages and expose the map through a
// minimal stand-in for the google.maps API (the parts createCanvasLayer and the
// overlays use), then hand it to core.js like any other map.
(() => {
  if (window.__gmoSiteInstalled) return;
  if (!/^www\.google\.[a-z.]+$/.test(location.hostname) || !location.pathname.startsWith('/maps')) return;
  window.__gmoSiteInstalled = true;

  const { world, LatLng, worldToLatLng, StandInOverlayView, StandInMap } = window.__gmo.util;

  // ---------------------------------------------------------------------------
  // Camera messages
  // ---------------------------------------------------------------------------

  // Minimal protobuf reader: field number -> last value (numbers, or Uint8Array
  // for length-delimited fields).
  function readProto(buf) {
    const out = {};
    if (!(buf instanceof Uint8Array)) return out;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let i = 0;
    const varint = () => {
      let r = 0;
      let mul = 1;
      let b;
      do {
        b = buf[i++];
        r += (b & 0x7f) * mul;
        mul *= 128;
      } while (b & 0x80 && i < buf.length);
      return r;
    };
    while (i < buf.length) {
      const key = varint();
      const field = Math.floor(key / 8);
      switch (key & 7) {
        case 0:
          out[field] = varint();
          break;
        case 1:
          out[field] = view.getFloat64(i, true);
          i += 8;
          break;
        case 2: {
          const n = varint();
          out[field] = buf.subarray(i, i + n);
          i += n;
          break;
        }
        case 5:
          out[field] = view.getFloat32(i, true);
          i += 4;
          break;
        default:
          throw new Error('unsupported wire type');
      }
    }
    return out;
  }

  const isNum = (...v) => v.every((x) => typeof x === 'number' && Number.isFinite(x));

  // Camera for the offscreen (worker-rendered) map, as observed:
  //   {command: 9, methodType: 8, payload: 8 { 2 { 1 { 3 { 1: lat, 2: lng } }, 2: zoom, 5/6: heading/tilt } }}
  function parseRendererCamera(msg) {
    if (msg?.command !== 9 || msg.methodType !== 8) return null;
    const inner = readProto(readProto(readProto(msg.payload)[8])[2]);
    const pos = readProto(readProto(inner[1])[3]);
    if (!isNum(pos[1], pos[2], inner[2])) return null;
    return { lat: pos[1], lng: pos[2], zoom: inner[2], heading: inner[5] || 0, tilt: inner[6] || 0 };
  }

  // Camera sent to the labeling worker by the main-thread renderer, as observed:
  //   {command: 1, viewportUpdateBytes: 1 { 1 { 2: lng, 3: lat }, 2 { 1/2/3: heading/tilt/roll } }, 2: zoom}
  function parseViewportCamera(msg) {
    if (msg?.command !== 1 || !msg.viewportUpdateBytes?.length) return null;
    const root = readProto(msg.viewportUpdateBytes);
    const view = readProto(root[1]);
    const pos = readProto(view[1]);
    const rot = readProto(view[2]);
    if (!isNum(pos[2], pos[3], root[2])) return null;
    return { lat: pos[3], lng: pos[2], zoom: root[2], heading: rot[1] || 0, tilt: rot[2] || 0 };
  }

  const canvasOf = new WeakMap(); // OffscreenCanvas -> <canvas>
  const glCanvases = new Set(); // <canvas>es with a WebGL context on the main thread

  const transfer = HTMLCanvasElement.prototype.transferControlToOffscreen;
  if (transfer) {
    HTMLCanvasElement.prototype.transferControlToOffscreen = function (...args) {
      const off = transfer.apply(this, args);
      canvasOf.set(off, this);
      return off;
    };
  }

  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...args) {
    const ctx = getContext.call(this, type, ...args);
    if (ctx && /webgl/.test(type)) glCanvases.add(this);
    return ctx;
  };

  const post = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (msg, ...rest) {
    try {
      onWorkerMessage(this, msg, rest[0]);
    } catch {}
    return post.call(this, msg, ...rest);
  };

  let current = null;
  let renderer = null; // the worker rendering an offscreen map canvas, if any

  function use(canvas) {
    if (current?.canvas === canvas) return current;
    current?.destroy();
    return (current = new SiteMap(canvas));
  }

  // The main-thread map canvas: the largest visible WebGL canvas.
  function mainCanvas() {
    let best = null;
    let area = 0;
    for (const c of glCanvases) {
      const a = c.isConnected ? c.clientWidth * c.clientHeight : 0;
      if (a > area) [best, area] = [c, a];
    }
    return best;
  }

  function onWorkerMessage(worker, msg, opts) {
    const list = Array.isArray(opts) ? opts : opts?.transfer || [];
    for (const t of list) {
      const canvas = t instanceof OffscreenCanvas && canvasOf.get(t);
      if (!canvas) continue;
      renderer = worker;
      use(canvas);
    }
    // Decode now: the payload's buffer may be transferred to the worker.
    if (renderer) {
      const cam = worker === renderer && parseRendererCamera(msg);
      if (cam) current.setCamera(cam);
      return;
    }
    const cam = parseViewportCamera(msg);
    const canvas = cam && mainCanvas();
    if (canvas) use(canvas).setCamera(cam);
  }

  // ---------------------------------------------------------------------------
  // google.maps stand-in
  // ---------------------------------------------------------------------------
  const STYLE = `
    .gmo-site-layer { position: absolute; pointer-events: none; overflow: hidden; }
    .gmo-site-float > * { pointer-events: auto; }
    .gmo-site-pointer, .gmo-site-pointer * { cursor: pointer !important; }
  `;
  let styled = false;

  class OverlayView extends StandInOverlayView {
    static preventMapHitsAndGesturesFrom(el) {
      for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'wheel', 'touchstart']) {
        el.addEventListener(type, (e) => e.stopPropagation());
      }
    }
  }

  const gm = { LatLng, OverlayView };

  class SiteMap extends StandInMap {
    constructor(canvas) {
      super();
      this.canvas = canvas;
      this.cam = null;
      this.registered = false;

      this.layer = document.createElement('div');
      this.layer.className = 'gmo-site-layer';
      const float = document.createElement('div');
      float.className = 'gmo-site-float';
      float.style.cssText = 'position:absolute;inset:0;z-index:10;';
      this.layer.append(float);
      this._panes = { overlayLayer: this.layer, floatPane: float };

      this.resize = new ResizeObserver(() => this._changed(false));
      this.resize.observe(canvas);
      this.attachTimer = setInterval(() => this._attach(), 1000);

      // The layer ignores the mouse, so listen on the map's container instead.
      const pixel = (e) => {
        const r = this.canvas.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };
      const fire = (name) => (e) => {
        if (!this.cam || this.layer.contains(e.target)) return;
        const [wx, wy] = this._toWorld(pixel(e));
        this._trigger(name, { latLng: worldToLatLng(wx, wy), domEvent: e });
      };
      this.dom = {
        mousemove: fire('mousemove'),
        click: fire('click'),
        mouseleave: () => this._trigger('mouseout', {}),
        pointerdown: () => this._trigger('dragstart', {}),
      };
    }

    // Keeps our layer right above the map canvas (Google's own markers and
    // controls stay on top of it).
    _attach() {
      const parent = this.canvas.parentElement;
      if (!parent || !this.canvas.isConnected) return;
      if (this.layer.parentElement !== parent) {
        if (!styled) {
          const style = document.createElement('style');
          style.textContent = STYLE;
          document.documentElement.append(style);
          styled = true;
        }
        this.container?.classList.remove('gmo-site-pointer');
        for (const [type, fn] of Object.entries(this.dom)) {
          this.container?.removeEventListener(type, fn);
          parent.addEventListener(type, fn);
        }
        this.container = parent;
        this.canvas.after(this.layer);
        this._syncCursor();
        this.registered = false;
      }
      this._fit();
      if (this.cam && !this.registered) {
        this.registered = true;
        window.__gmo.addMap?.(this, gm);
      }
    }

    _fit() {
      const s = this.layer.style;
      s.left = `${this.canvas.offsetLeft}px`;
      s.top = `${this.canvas.offsetTop}px`;
      s.width = `${this.canvas.clientWidth}px`;
      s.height = `${this.canvas.clientHeight}px`;
    }

    setCamera(cam) {
      const zoomChanged = this.cam && this.cam.zoom !== cam.zoom;
      this.cam = cam;
      this.center = world(cam.lng, cam.lat);
      this.scale = 2 ** cam.zoom;
      if (!this.layer.isConnected || !this.registered) this._attach();
      this._changed(zoomChanged);
    }

    _changed(zoomChanged) {
      if (!this.cam) return;
      if (this.layer.isConnected) this._fit();
      if (zoomChanged) this._trigger('zoom_changed');
      this._trigger('bounds_changed');
    }

    _toWorld([x, y]) {
      return [
        this.center[0] + (x - this.canvas.clientWidth / 2) / this.scale,
        this.center[1] + (y - this.canvas.clientHeight / 2) / this.scale,
      ];
    }

    _projection() {
      if (!this.cam) return null;
      const toPixel = (ll) => {
        const [wx, wy] = world(ll.lng(), ll.lat());
        return {
          x: (wx - this.center[0]) * this.scale + this.canvas.clientWidth / 2,
          y: (wy - this.center[1]) * this.scale + this.canvas.clientHeight / 2,
        };
      };
      return { fromLatLngToContainerPixel: toPixel, fromLatLngToDivPixel: toPixel };
    }

    _syncCursor() {
      this.container?.classList.toggle('gmo-site-pointer', this.options.draggableCursor === 'pointer');
    }

    // --- google.maps.Map subset ---
    getDiv() {
      return this.layer;
    }
    getTilt() {
      return this.cam?.tilt || 0;
    }
    getHeading() {
      return this.cam?.heading || 0;
    }
    getZoom() {
      return this.cam?.zoom;
    }

    destroy() {
      window.__gmo.removeMap?.(this);
      for (const ov of [...this.overlays]) ov.setMap(null);
      clearInterval(this.attachTimer);
      this.resize.disconnect();
      for (const [type, fn] of Object.entries(this.dom)) this.container?.removeEventListener(type, fn);
      this.container?.classList.remove('gmo-site-pointer');
      this.layer.remove();
    }
  }
})();
