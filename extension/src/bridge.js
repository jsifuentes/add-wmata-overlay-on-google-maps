// Isolated-world content script. Relays settings and overlay data between the
// extension (extension APIs) and the page-world scripts (src/page/*), which are the
// only place that can see the page's google.maps objects.
//
// Page -> bridge events:  gmo:hello, gmo:need-data {ids}, gmo:status {count}
// Bridge -> page events:  gmo:settings <json>, gmo:data <json>
(() => {
  let mapCount = 0;
  const DATASETS = { wmata: 'data/wmata.json', bus: 'data/bus.json' };
  const loading = {};

  const send = (type, payload) =>
    document.dispatchEvent(new CustomEvent(type, { detail: JSON.stringify(payload) }));

  const pushSettings = async () => {
    try {
      send('gmo:settings', await GMO.load());
    } catch {
      // Extension was reloaded/removed; this content script is orphaned.
    }
  };

  document.addEventListener('gmo:hello', pushSettings);

  document.addEventListener('gmo:need-data', (e) => {
    let ids = [];
    try {
      ids = JSON.parse(e.detail).ids.filter((id) => DATASETS[id]);
    } catch {}
    for (const id of ids) {
      loading[id] ||= fetch(GMO.ext.runtime.getURL(DATASETS[id])).then((r) => r.json());
      loading[id].then((d) => send('gmo:data', { [id]: d }));
    }
  });

  document.addEventListener('gmo:status', (e) => {
    try {
      mapCount = JSON.parse(e.detail).count;
    } catch {}
  });

  GMO.ext.storage.onChanged.addListener((changes, area) => {
    if (area === 'sync' && changes.settings) pushSettings();
  });

  // Popup asks every frame; only frames that found a map answer.
  GMO.ext.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'gmo:status' && mapCount > 0) {
      sendResponse({ count: mapCount, url: location.href });
    }
  });

  pushSettings();
})();
