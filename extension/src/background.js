// Chrome runs this as a service worker; Firefox as an event page with settings.js
// already loaded via manifest background.scripts.
if (typeof importScripts === 'function' && !globalThis.GMO) importScripts('settings.js');
const { ext } = GMO;

const setBadge = (settings) =>
  ext.action.setBadgeText({ text: settings.enabled ? '' : 'off' }).then(() =>
    ext.action.setBadgeBackgroundColor({ color: '#666' }));

ext.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-overlays') return;
  const settings = await GMO.load();
  settings.enabled = !settings.enabled;
  await GMO.save(settings);
});

ext.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes.settings) setBadge(await GMO.load());
});
ext.runtime.onStartup.addListener(async () => setBadge(await GMO.load()));
ext.runtime.onInstalled.addListener(async () => setBadge(await GMO.load()));
