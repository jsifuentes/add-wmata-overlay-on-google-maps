// Page-world content script (runs in the page's own JS context at document_start).
// Loaded after canvas-layer.js and the overlay modules, which register themselves
// in window.__gmo.overlays.
//
// 1. Finds Google Maps JS API map instances created by the page:
//    - traps window.google -> google.maps -> google.maps.Map so maps created after
//      the API loads go through a Proxy that records them, and
//    - patches Map/MVCObject prototype methods and google.maps.event helpers so maps
//      created before we got hold of the constructor are caught the next time the
//      page touches them (pans, reads bounds, adds listeners, ...).
// 2. Attaches the overlays enabled in the extension settings to every found map.
//
// Maps that aren't JS API maps (google.com/maps itself, see google-maps-site.js)
// are handed over through window.__gmo.addMap / removeMap.
(() => {
  if (window.__gmoPageInstalled) return;
  window.__gmoPageInstalled = true;

  const maps = new Map(); // map -> the google.maps-like namespace it belongs to
  const attached = new Map(); // map -> { [overlayId]: overlay instance }
  let settings = null;
  const data = {}; // overlay id -> dataset
  const requested = new Set();
  let g = null; // the page's `google` namespace, once seen
  let RealMap = null;
  const proxied = new WeakSet();

  // ---------------------------------------------------------------------------
  // Messaging with the isolated-world bridge
  // ---------------------------------------------------------------------------
  const emit = (type, payload) =>
    document.dispatchEvent(new CustomEvent(type, { detail: payload === undefined ? null : JSON.stringify(payload) }));

  document.addEventListener('gmo:settings', (e) => {
    settings = JSON.parse(e.detail);
    sync();
  });
  document.addEventListener('gmo:data', (e) => {
    Object.assign(data, JSON.parse(e.detail));
    sync();
  });

  // ---------------------------------------------------------------------------
  // Map discovery
  // ---------------------------------------------------------------------------
  function register(map) {
    if (!RealMap || maps.has(map) || !(map instanceof RealMap)) return;
    addMap(map, g.maps);
  }

  function addMap(map, gm) {
    if (maps.has(map)) return;
    maps.set(map, gm);
    emit('gmo:status', { count: maps.size });
    // Defer: we may be inside the page's constructor/method call.
    queueMicrotask(sync);
  }

  function removeMap(map) {
    if (!maps.delete(map)) return;
    detachAll(map);
    emit('gmo:status', { count: maps.size });
  }

  function trap(obj, key, transform, onValue) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    let val = obj[key];
    if (desc && (!desc.configurable || desc.get || desc.set)) {
      if (val) onValue?.(val);
      return;
    }
    if (val && transform) val = transform(val);
    Object.defineProperty(obj, key, {
      configurable: true,
      enumerable: true,
      get: () => val,
      set(v) {
        val = v && transform ? transform(v) : v;
        if (val) onValue?.(val);
      },
    });
    if (val) onValue?.(val);
  }

  function wrapMapClass(Cls) {
    if (typeof Cls !== 'function' || proxied.has(Cls)) return Cls;
    hookMapClass(Cls);
    const P = new Proxy(Cls, {
      construct(target, args, newTarget) {
        const inst = Reflect.construct(target, args, newTarget === P ? target : newTarget);
        register(inst);
        return inst;
      },
    });
    proxied.add(P);
    return P;
  }

  const wrapMethod = (proto, name, check) => {
    const orig = proto && proto[name];
    if (typeof orig !== 'function' || orig.__gmo) return;
    const wrapped = function (...args) {
      check(this, args);
      return orig.apply(this, args);
    };
    wrapped.__gmo = true;
    try {
      proto[name] = wrapped;
    } catch {}
  };

  function hookMapClass(Cls) {
    if (RealMap) return;
    RealMap = Cls;
    const self = (obj) => register(obj);
    for (const name of ['getBounds', 'getCenter', 'getZoom', 'getDiv', 'getProjection', 'setCenter', 'setZoom',
      'panTo', 'panBy', 'panToBounds', 'fitBounds', 'moveCamera', 'getMapTypeId', 'setMapTypeId', 'getHeading', 'getTilt']) {
      wrapMethod(Cls.prototype, name, self);
    }
  }

  function hookNamespace(ns) {
    // Maps created before our hooks existed are caught through these.
    const MVC = ns.MVCObject && ns.MVCObject.prototype;
    for (const name of ['get', 'set', 'setOptions', 'setValues', 'addListener', 'bindTo', 'notify']) {
      wrapMethod(MVC, name, (obj) => register(obj));
    }
    const ev = ns.event;
    for (const name of ['addListener', 'addListenerOnce', 'trigger', 'clearListeners', 'clearInstanceListeners']) {
      wrapMethod(ev, name, (_this, args) => register(args[0]));
    }
    // Anything that gets put on a map (markers, overlays, data layers...).
    const onSetMap = (_this, args) => register(args[0]);
    for (const cls of ['Marker', 'OverlayView', 'Polyline', 'Polygon', 'Circle', 'Rectangle', 'InfoWindow', 'Data',
      'GroundOverlay', 'KmlLayer', 'TrafficLayer', 'TransitLayer']) {
      wrapMethod(ns[cls] && ns[cls].prototype, 'setMap', onSetMap);
    }
    wrapMethod(ns.InfoWindow && ns.InfoWindow.prototype, 'open', (_this, args) => {
      register(args[0]);
      register(args[0]?.map);
    });
  }

  function onMapsNamespace(ns) {
    if (typeof ns !== 'object' && typeof ns !== 'function') return;
    trap(ns, 'Map', wrapMapClass, (Cls) => {
      if (!RealMap) hookMapClass(Cls); // non-configurable Map: fall back to prototype hooks only
      hookNamespace(ns);
    });
    // The event/MVCObject namespaces can show up after Map; poll briefly for them.
    let tries = 0;
    const t = setInterval(() => {
      if (ns.Map) hookNamespace(ns);
      if (++tries > 40) clearInterval(t);
    }, 250);
  }

  function onGoogle(obj) {
    if (typeof obj !== 'object' || !obj) return;
    g = obj;
    trap(obj, 'maps', null, onMapsNamespace);
  }

  try {
    trap(window, 'google', null, onGoogle);
  } catch {}
  // Belt and braces: if the page replaced our accessor, still find the API.
  let polls = 0;
  const poll = setInterval(() => {
    const ns = window.google?.maps;
    if (ns?.Map) {
      g = window.google;
      if (!RealMap) hookMapClass(ns.Map);
      hookNamespace(ns);
    }
    if (++polls > 120) clearInterval(poll);
  }, 500);

  // Drop maps whose element has left the document (SPA navigation etc).
  setInterval(() => {
    for (const map of maps.keys()) {
      let div;
      try {
        div = map.getDiv();
      } catch {}
      if (!div || !div.isConnected) removeMap(map);
    }
  }, 3000);

  // ---------------------------------------------------------------------------
  // Overlay management
  // ---------------------------------------------------------------------------
  const OVERLAYS = window.__gmo.overlays;
  Object.assign(window.__gmo, { addMap, removeMap });

  function detachAll(map) {
    const inst = attached.get(map);
    if (!inst) return;
    for (const o of Object.values(inst)) o.destroy();
    attached.delete(map);
  }

  function sync() {
    if (!settings || !maps.size) return;
    const want = Object.keys(OVERLAYS).filter((id) => settings.enabled && settings.overlays?.[id]?.enabled);
    const missing = want.filter((id) => !data[id] && !requested.has(id));
    if (missing.length) {
      missing.forEach((id) => requested.add(id));
      emit('gmo:need-data', { ids: missing });
    }
    for (const [map, gm] of maps) {
      const inst = attached.get(map) || {};
      for (const id of Object.keys(OVERLAYS)) {
        const cfg = settings.overlays?.[id];
        if (want.includes(id)) {
          if (inst[id]) inst[id].update(cfg);
          else if (data[id]) {
            try {
              inst[id] = OVERLAYS[id]({ gm, map, data: data[id], cfg });
            } catch (err) {
              console.warn('[WMATA Overlay] could not attach', id, err);
            }
          }
        } else if (inst[id]) {
          inst[id].destroy();
          delete inst[id];
        }
      }
      attached.set(map, inst);
    }
  }

  emit('gmo:hello');
})();
