// Shared settings helpers. Loaded by the bridge content script, the popup and the
// background script (all extension contexts with storage access).
(() => {
  // Firefox exposes promise-based `browser`; Chrome only `chrome` (promise-based in MV3).
  const ext = globalThis.browser ?? globalThis.chrome;

  const DEFAULTS = {
    enabled: true,
    overlays: {
      wmata: {
        enabled: true,
        stations: true,
        labels: false,
        opacity: 0.9,
        lines: { red: true, blue: true, orange: true, silver: true, yellow: true, green: true },
      },
      bus: {
        enabled: false,
        lines: true,
        stops: true,
        stopZoom: 15,
        opacity: 0.85,
      },
    },
  };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function merge(base, over) {
    if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
    const out = { ...base };
    for (const k of Object.keys(over)) out[k] = merge(base[k], over[k]);
    return out;
  }

  async function load() {
    const { settings } = await ext.storage.sync.get('settings');
    return merge(DEFAULTS, settings || {});
  }

  function save(settings) {
    return ext.storage.sync.set({ settings });
  }

  globalThis.GMO = { ext, DEFAULTS, merge, load, save };
})();
