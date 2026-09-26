// Page world. Leaflet maps (OpenStreetMap widgets, e.g. Craigslist's map view), for
// pages that expose Leaflet as window.L. Loaded after core.js.
//
// Maps are found through an L.Map init hook (and L.Map#fire, for maps created before
// we saw L), wrapped in a minimal stand-in for the google.maps API, and handed to
// core.js like any other map.
(() => {
  if (window.__gmoLeafletInstalled) return;
  window.__gmoLeafletInstalled = true;

  const { LatLng, StandInOverlayView, StandInMap } = window.__gmo.util;

  let L = null;
  const seen = new WeakSet(); // L.Map instances

  function onLeaflet(obj) {
    if (L || typeof obj?.Map?.addInitHook !== 'function') return;
    L = obj;
    L.Map.addInitHook(function () {
      found(this);
    });
    const fire = L.Map.prototype.fire;
    L.Map.prototype.fire = function (...args) {
      found(this);
      return fire.apply(this, args);
    };
  }

  let current = window.L;
  try {
    Object.defineProperty(window, 'L', {
      configurable: true,
      enumerable: true,
      get: () => current,
      set(v) {
        current = v;
        onLeaflet(v);
      },
    });
  } catch {}
  onLeaflet(current);
  // In case the page replaced our accessor.
  let polls = 0;
  const poll = setInterval(() => {
    onLeaflet(window.L);
    if (L || ++polls > 120) clearInterval(poll);
  }, 500);

  function found(lmap) {
    if (seen.has(lmap) || !(lmap instanceof L.Map)) return;
    seen.add(lmap);
    // The overlays assume Web Mercator.
    if (lmap.options.crs && lmap.options.crs !== L.CRS.EPSG3857) return;
    lmap.whenReady(() => {
      if (lmap.getContainer()) new LeafletMap(lmap).register();
    });
  }

  // ---------------------------------------------------------------------------
  // google.maps stand-in
  // ---------------------------------------------------------------------------
  const STYLE = '.gmo-leaflet-pointer, .gmo-leaflet-pointer * { cursor: pointer !important; }';
  let styled = false;

  class OverlayView extends StandInOverlayView {
    static preventMapHitsAndGesturesFrom(el) {
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
    }
  }

  const gm = { LatLng, OverlayView };

  class LeafletMap extends StandInMap {
    constructor(lmap) {
      super();
      this.lmap = lmap;
      this.zooming = false;
      if (!styled) {
        const style = document.createElement('style');
        style.textContent = STYLE;
        document.documentElement.append(style);
        styled = true;
      }

      // Above tiles (200), below Leaflet's own vectors (400) and markers (600).
      const overlay = this._pane('overlay', 350);
      if (lmap._zoomAnimated) overlay.classList.add('leaflet-zoom-animated');
      this._panes = { overlayLayer: overlay, floatPane: this._pane('float', 750) };

      const latLng = (e) => e.latlng && new LatLng(e.latlng.lat, e.latlng.lng);
      this.events = {
        mousemove: (e) => this._trigger('mousemove', { latLng: latLng(e), domEvent: e.originalEvent }),
        click: (e) => this._trigger('click', { latLng: latLng(e), domEvent: e.originalEvent }),
        mouseout: () => this._trigger('mouseout', {}),
        dragstart: () => this._trigger('dragstart', {}),
        zoomstart: () => this._trigger('zoom_changed'),
        zoomanim: (e) => this._zoomAnim(e),
        move: () => this._moved(),
        viewreset: () => this._moved(),
        resize: () => this._moved(),
        unload: () => this.destroy(),
      };
      lmap.on(this.events);
    }

    _pane(name, zIndex) {
      const pane = L.DomUtil.create('div', `leaflet-pane gmo-leaflet-${name}`, this.lmap.getPane('mapPane'));
      pane.style.zIndex = zIndex;
      return pane;
    }

    register() {
      if (!this.destroyed && this.lmap.getContainer().isConnected) window.__gmo.addMap?.(this, gm);
    }

    // Scale the drawn frame along with Leaflet's zoom animation, like its own layers do.
    _zoomAnim(e) {
      const m = this.lmap;
      if (typeof m._latLngToNewLayerPoint !== 'function') return;
      const origin = m.layerPointToLatLng([0, 0]);
      L.DomUtil.setTransform(this._panes.overlayLayer, m._latLngToNewLayerPoint(origin, e.zoom, e.center), m.getZoomScale(e.zoom));
      this.zooming = true;
    }

    _moved() {
      // core.js drops maps whose container left the document; pick them back up.
      this.register();
      if (this.zooming) {
        // End of a zoom animation: swap the scaled frame for a fresh one in one go.
        this.zooming = false;
        this._panes.overlayLayer.style.transform = '';
        for (const ov of this.overlays) ov.draw?.();
      } else {
        this._trigger('bounds_changed');
      }
    }

    _projection() {
      // Mid-animation, Leaflet's view state is already the target's.
      if (this.zooming) return null;
      const m = this.lmap;
      // Unrounded, unlike latLngToLayerPoint.
      const zoom = m.getZoom();
      const origin = m.getPixelOrigin();
      const topLeft = m.containerPointToLayerPoint([0, 0]);
      const layer = (ll) => m.project([ll.lat(), ll.lng()], zoom).subtract(origin);
      return {
        fromLatLngToDivPixel: layer,
        fromLatLngToContainerPixel: (ll) => layer(ll).subtract(topLeft),
      };
    }

    _syncCursor() {
      this.lmap.getContainer().classList.toggle('gmo-leaflet-pointer', this.options.draggableCursor === 'pointer');
    }

    // --- google.maps.Map subset ---
    getDiv() {
      return this.lmap.getContainer();
    }
    getZoom() {
      return this.lmap.getZoom();
    }

    destroy() {
      this.destroyed = true;
      window.__gmo.removeMap?.(this);
      for (const ov of [...this.overlays]) ov.setMap(null);
      this.lmap.off(this.events);
      this.getDiv()?.classList.remove('gmo-leaflet-pointer');
      for (const pane of Object.values(this._panes)) pane.remove();
    }
  }
})();
