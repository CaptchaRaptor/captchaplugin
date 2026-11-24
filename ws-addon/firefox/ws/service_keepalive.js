// service_keepalive.js (Firefox) — runs in the service tab (ws/service.html).
// Firefox suspends a non-persistent background page after ~30 s without events.
// A message every 10 s is an event for the background, so it stays alive while
// the service tab is open (the tab is open only while the service is on).
setInterval(() => {
  try { Promise.resolve(chrome.runtime.sendMessage({ type: 'keepalive' })).catch(() => {}); } catch {}
}, 10000);
