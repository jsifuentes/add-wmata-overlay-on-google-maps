importScripts('settings.js');

const setBadge = (settings) =>
  chrome.action.setBadgeText({ text: settings.enabled ? '' : 'off' }).then(() =>
    chrome.action.setBadgeBackgroundColor({ color: '#666' }));

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-overlays') return;
  const settings = await GMO.load();
  settings.enabled = !settings.enabled;
  await GMO.save(settings);
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === 'sync' && changes.settings) setBadge(await GMO.load());
});
chrome.runtime.onStartup.addListener(async () => setBadge(await GMO.load()));
chrome.runtime.onInstalled.addListener(async () => setBadge(await GMO.load()));
