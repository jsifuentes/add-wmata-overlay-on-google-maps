// Shared settings helpers. Loaded by the bridge content script, the popup and the
// service worker (all extension contexts with chrome.storage access).
(() => {
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
    const { settings } = await chrome.storage.sync.get('settings');
    return merge(DEFAULTS, settings || {});
  }

  function save(settings) {
    return chrome.storage.sync.set({ settings });
  }

  globalThis.GMO = { DEFAULTS, merge, load, save };
})();
