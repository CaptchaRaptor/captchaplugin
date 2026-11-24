// background_ws.js (Firefox) — Remote solving via WebSocket (WS mode)
// Firefox port of ws-addon/ws/background_ws.js. Listed in background.scripts.
//
// Differences from the Chrome version:
//  - No offscreen documents in Firefox: the WebSocket client (offscreen.js) runs in a
//    pinned extension tab (ws/service.html). The tab also pings the background every
//    10 s so the non-persistent background page is not suspended while the service runs.
//  - No chrome.debugger (CDP) in Firefox: the managed tab is controlled with blocking
//    webRequest + webRequest.filterResponseData instead of Fetch.requestPaused.
//  - webRequest cannot answer a request without the network (CDP Fetch.fulfillRequest can),
//    and an https document cannot be faked without the site's TLS certificate. So the task
//    page is opened over plain http (http://<site host>/...) and that one request is sent
//    through proxy.onRequest to www.google.com:80 as an HTTP proxy: Google answers any
//    absolute-URI request with a text/html 404, and filterResponseData replaces it with our
//    page. The page origin is the site's host (reCAPTCHA checks the key against the host,
//    the scheme does not matter; siteverify returns hostname = site host). No request goes
//    to the task's site, no DNS lookup of it is made.
//
// Requires manifest permissions: tabs, scripting, proxy, webRequest, webRequestBlocking,
// webRequestFilterResponse + host_permissions <all_urls>. Firefox 128+.

self.WS_MODE_AVAILABLE = true;

(() => {
  if (typeof chrome === 'undefined') return;
  const B = globalThis.browser || chrome;

  // ---- Constants ----
  const SERVICE_URL      = 'ws/service.html';
  const WS_ENABLED_KEY   = 'ws_mode_enabled';
  const WS_TAB_KEY       = 'ws_main_tab_id';
  // HTTP proxy for the task document (see header). Answers with text/html, so the page is
  // rendered as HTML even if Firefox ignored the replaced Content-Type.
  const DOC_PROXY        = { type: 'http', host: 'www.google.com', port: 80 };

  // ---- State ----
  let wsMainTabId   = null;
  let serviceTabId  = null;
  let closingService = false;
  const wsRecaptchaErrorDedup = new Map();
  const wsManagedTabs         = new Map(); // tabId -> { targetUrl, docUrl, host, html }

  // ---- Storage helpers ----
  async function getWsEnabled() {
    const d = await chrome.storage.local.get(WS_ENABLED_KEY);
    return !!d[WS_ENABLED_KEY];
  }
  async function setWsEnabled(v) {
    await chrome.storage.local.set({ [WS_ENABLED_KEY]: !!v });
  }

  async function getApiKey() {
    const { reporting = {} } = await chrome.storage.local.get('reporting');
    const key = typeof reporting.key === 'string' ? reporting.key.trim() : '';
    return key.length === 32 ? key : null;
  }

  async function loadWsTabId() {
    const d = await chrome.storage.local.get(WS_TAB_KEY);
    return Number.isInteger(d[WS_TAB_KEY]) ? d[WS_TAB_KEY] : null;
  }
  async function saveWsTabId(id) {
    await chrome.storage.local.set({ [WS_TAB_KEY]: Number.isInteger(id) ? id : null });
  }

  function notify(msg) {
    try { Promise.resolve(chrome.runtime.sendMessage(msg)).catch(() => {}); } catch {}
  }

  // ---- Service tab (replaces the Chrome offscreen document) ----
  async function findServiceTab() {
    const url = chrome.runtime.getURL(SERVICE_URL);
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => t.url === url) || null;
  }

  async function ensureServiceTab() {
    try {
      const existing = await findServiceTab();
      if (existing) {
        serviceTabId = existing.id;
        // A tab restored by session restore is not loaded until selected.
        if (existing.discarded) await chrome.tabs.reload(existing.id);
        return;
      }
      const created = await chrome.tabs.create({ url: chrome.runtime.getURL(SERVICE_URL), active: false, pinned: true });
      serviceTabId = created.id;
    } catch (e) {
      console.warn('[ws] ensureServiceTab:', e);
    }
  }

  async function closeServiceTab() {
    try {
      const existing = await findServiceTab();
      serviceTabId = null;
      if (existing) {
        closingService = true;
        await chrome.tabs.remove(existing.id);
      }
    } catch {} finally {
      closingService = false;
    }
  }

  // ---- recaptcha_frame_watch.js content script registration ----
  async function ensureRecaptchaFrameWatcher() {
    if (!chrome.scripting) return;
    try {
      try { await chrome.scripting.unregisterContentScripts({ ids: ['ws-recaptcha-frames'] }); } catch {}
      await chrome.scripting.registerContentScripts([{
        id: 'ws-recaptcha-frames',
        matches: [
          'https://www.google.com/recaptcha/*',
          'https://www.recaptcha.net/recaptcha/*',
        ],
        js: ['ws/recaptcha_frame_watch.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
      }]);
    } catch (e) {
      const msg = String(e?.message || e);
      if (!msg.toLowerCase().includes('already registered')) console.warn('[ws] ensureRecaptchaFrameWatcher:', msg);
    }
  }
  async function unregisterRecaptchaFrameWatcher() {
    if (!chrome.scripting) return;
    try { await chrome.scripting.unregisterContentScripts({ ids: ['ws-recaptcha-frames'] }); } catch {}
  }

  async function startService() {
    await ensureServiceTab();
    await ensureRecaptchaFrameWatcher();
    startInterception();
  }
  async function stopService() {
    stopInterception();
    wsManagedTabs.clear();
    await closeServiceTab();
    await unregisterRecaptchaFrameWatcher();
  }

  // ---- HTML template for the replaced page ----
  const OVERRIDE_HTML_TEMPLATE = `<!DOCTYPE html>
<html>
  <head>
    <meta charset="utf-8">
    <title>__OVERRIDDEN__</title>
    <script>
      (function () {
        var report = function(code, detail) {
          try { window.postMessage({ __wsRecaptcha: true, code: code, detail: detail || null }, "*"); } catch(e) {}
        };
        window.__wsReportRecaptcha = report;
        window.addEventListener("message", function(ev) {
          try {
            var raw = typeof ev.data === "string" ? ev.data : JSON.stringify(ev.data);
            var low = String(raw || "").toLowerCase();
            if (!low) return;
            if (low.includes("invalid site key")) report("invalid_site_key", { source: "postmessage" });
            else if (low.includes("invalid domain")) report("invalid_domain", { source: "postmessage" });
            else if (low.includes("ip") && low.includes("blocked")) report("ip_blocked", { source: "postmessage" });
          } catch(e) {}
        });
        window.__wsOnload = function() {
          try {
            if (!window.grecaptcha || typeof window.grecaptcha.render !== "function") {
              report("grecaptcha_missing"); return;
            }
            var el = document.getElementById("recaptcha");
            if (!el) { report("container_missing"); return; }
            try {
              window.grecaptcha.render(el, {
                sitekey: "{{TEXT}}",
                callback: function(token) { report("solved", { token: token }); },
                "expired-callback": function() { report("expired"); },
                "error-callback": function() { report("challenge_error"); }
              });
              report("rendered");
            } catch(e) {
              report("render_exception", { msg: String(e && e.message || e) });
            }
          } catch(e) {
            report("onload_exception", { msg: String(e && e.message || e) });
          }
        };
        setTimeout(function() { try { if (!window.grecaptcha) report("script_not_loaded"); } catch(e) {} }, 15000);
      })();
    <\/script>
    <script src="https://www.google.com/recaptcha/api.js?onload=__wsOnload&render=explicit" async defer onerror="window.__wsReportRecaptcha&&window.__wsReportRecaptcha('script_load_failed')"><\/script>
  </head>
  <body><form><div id="recaptcha" class="g-recaptcha"></div></form></body>
</html>`;

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
  }
  function buildHtml(text) {
    return OVERRIDE_HTML_TEMPLATE.replaceAll('{{TEXT}}', escapeHtml(text || ''));
  }

  // ---- URL helpers ----
  function parseUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
      return u;
    } catch { return null; }
  }
  function isAllowedNetUrl(urlStr) {
    try {
      const u = new URL(urlStr);
      const host = (u.hostname || '').toLowerCase();
      const path = u.pathname || '';
      if (host.endsWith('gstatic.com')) return true;
      if (host === 'fonts.googleapis.com') return true; // widget font (Roboto)
      if (host.endsWith('google.com') && path.startsWith('/recaptcha/')) return true;
      if (host.endsWith('recaptcha.net') && path.startsWith('/recaptcha/')) return true;
      return false;
    } catch { return false; }
  }
  function isAnchorUrl(urlStr) {
    return String(urlStr || '').toLowerCase().includes('/recaptcha/api2/anchor');
  }
  function detectRecaptchaErrorCode(raw) {
    const low = String(raw || '').toLowerCase();
    if (!low) return null;
    if (low.includes('invalid site key')) return 'recaptcha_invalid_site_key';
    if (low.includes('not supported by default') && low.includes('supported domains')) return 'recaptcha_invalid_domain';
    if (low.includes('not in the list of supported domains') && low.includes('site key')) return 'recaptcha_invalid_domain';
    if (low.includes('invalid domain')) return 'recaptcha_invalid_domain';
    if (low.includes('error for site owner')) return 'recaptcha_site_owner_error';
    if (low.includes('ip') && low.includes('blocked')) return 'recaptcha_ip_blocked';
    return null;
  }

  // ---- Request interception (replaces CDP Fetch) ----
  // Only requests of managed tabs are touched; listeners exist only while the service runs.

  // Main document of the managed tab: discard the site's response, serve our page
  // under the site's origin (reCAPTCHA checks the domain of the site key).
  function replaceResponse(requestId, html) {
    let filter;
    try { filter = B.webRequest.filterResponseData(requestId); } catch (e) {
      console.warn('[ws] filterResponseData failed:', e); return;
    }
    const bytes = new TextEncoder().encode(html);
    filter.onstart = () => {
      try { filter.write(bytes); } catch {}
      try { filter.close(); } catch {}
    };
    filter.onerror = () => {};
  }

  // reCAPTCHA anchor frame: pass the data through and look for error texts.
  function scanAnchorResponse(requestId, tabId) {
    let filter;
    try { filter = B.webRequest.filterResponseData(requestId); } catch { return; }
    const dec = new TextDecoder('utf-8');
    let text = '';
    filter.ondata = (ev) => {
      try { filter.write(ev.data); } catch {}
      if (text.length < 2_000_000) { try { text += dec.decode(ev.data, { stream: true }); } catch {} }
    };
    filter.onstop = () => {
      try { filter.close(); } catch {}
      const code = detectRecaptchaErrorCode(text);
      if (!code) return;
      const state = wsManagedTabs.get(tabId) || {};
      notify({ type: 'recaptcha_error', code, detail: { source: 'anchor_filter_response' }, url: state.targetUrl || '', tabId, forwarded: true });
      showWellDone(tabId).catch(() => {});
    };
    filter.onerror = () => { try { filter.disconnect(); } catch {} };
  }

  function onBeforeRequest(details) {
    if (!wsManagedTabs.has(details.tabId)) return {};
    const state = wsManagedTabs.get(details.tabId);
    const url = details.url || '';
    if (isAllowedNetUrl(url) && details.type !== 'main_frame') {
      if (isAnchorUrl(url)) {
        scanAnchorResponse(details.requestId, details.tabId);
      }
      return {};
    }
    if (details.type === 'main_frame') {
      let u = null;
      try { u = new URL(url); } catch {}
      if (u && u.hostname === state.host) {
        // https (e.g. HTTPS-First upgrade) would go to the real site: back to http.
        if (u.protocol === 'https:') return { redirectUrl: state.docUrl };
        replaceResponse(details.requestId, state.html || '<!doctype html><title></title>');
        return {};
      }
      console.warn('[ws] blocked', details.type, url);
      return { cancel: true };
    }
    // Everything else the site would load is not needed to show the widget.
    console.warn('[ws] blocked', details.type, url);
    return { cancel: true };
  }

  // Ask for an uncompressed, uncached document (its body is discarded anyway).
  function onBeforeSendHeaders(details) {
    if (!wsManagedTabs.has(details.tabId) || isAllowedNetUrl(details.url)) return {};
    const headers = (details.requestHeaders || []).filter(h => !['accept-encoding', 'cache-control', 'pragma'].includes(h.name.toLowerCase()));
    headers.push({ name: 'Accept-Encoding', value: 'identity' });
    headers.push({ name: 'Cache-Control', value: 'no-cache' });
    return { requestHeaders: headers };
  }

  // Drop the proxy response's headers that would break or redirect the replaced page.
  const DROP_RESPONSE_HEADERS = new Set([
    'cache-control', 'expires', 'etag', 'last-modified', 'x-content-type-options',
    'content-security-policy', 'content-security-policy-report-only', 'content-type',
    'content-encoding', 'content-length', 'content-disposition', 'location', 'refresh',
    'cross-origin-embedder-policy', 'cross-origin-opener-policy', 'permissions-policy',
  ]);
  function onHeadersReceived(details) {
    if (!wsManagedTabs.has(details.tabId) || isAllowedNetUrl(details.url)) return {};
    const headers = (details.responseHeaders || []).filter(h => !DROP_RESPONSE_HEADERS.has(h.name.toLowerCase()));
    headers.push({ name: 'Content-Type', value: 'text/html; charset=utf-8' });
    headers.push({ name: 'Cache-Control', value: 'no-store' });
    return { responseHeaders: headers };
  }

  // reCAPTCHA network activity resets the WS watchdog in the service tab.
  function onResponseStarted(details) {
    if (!wsManagedTabs.has(details.tabId)) return;
    notify({ type: 'recaptcha_activity', tabId: details.tabId, url: String(details.url || '').toLowerCase(), source: 'network', forwarded: true });
  }

  // The task document (http://<site host>/...) goes to DOC_PROXY, never to the site.
  function onProxyRequest(details) {
    const state = wsManagedTabs.get(details.tabId);
    if (!state || details.type !== 'main_frame') return { type: 'direct' };
    try {
      const u = new URL(details.url);
      if (u.protocol === 'http:' && u.hostname === state.host) return DOC_PROXY;
    } catch {}
    return { type: 'direct' };
  }

  let intercepting = false;
  function startInterception() {
    if (intercepting || !B.webRequest) return;
    intercepting = true;
    if (B.proxy && B.proxy.onRequest) B.proxy.onRequest.addListener(onProxyRequest, { urls: ['http://*/*'], types: ['main_frame'] });
    const all = { urls: ['<all_urls>'] };
    const docs = { urls: ['<all_urls>'], types: ['main_frame'] };
    B.webRequest.onBeforeRequest.addListener(onBeforeRequest, all, ['blocking']);
    B.webRequest.onBeforeSendHeaders.addListener(onBeforeSendHeaders, docs, ['blocking', 'requestHeaders']);
    B.webRequest.onHeadersReceived.addListener(onHeadersReceived, docs, ['blocking', 'responseHeaders']);
    B.webRequest.onResponseStarted.addListener(onResponseStarted, {
      urls: ['*://*.google.com/recaptcha/*', '*://*.recaptcha.net/recaptcha/*'],
    });
  }
  function stopInterception() {
    if (!intercepting) return;
    intercepting = false;
    try { B.proxy.onRequest.removeListener(onProxyRequest); } catch {}
    try { B.webRequest.onBeforeRequest.removeListener(onBeforeRequest); } catch {}
    try { B.webRequest.onBeforeSendHeaders.removeListener(onBeforeSendHeaders); } catch {}
    try { B.webRequest.onHeadersReceived.removeListener(onHeadersReceived); } catch {}
    try { B.webRequest.onResponseStarted.removeListener(onResponseStarted); } catch {}
  }

  // ---- Well done page ----
  async function showWellDone(tabId) {
    if (!Number.isInteger(tabId)) return;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: 'MAIN',
        args: [`<!doctype html><html><head><meta charset="utf-8"><title>WELL DONE</title></head><body style="font:16px/1.4 sans-serif;padding:24px;">WELL DONE</body></html>`],
        func: (h) => { try { window.stop(); } catch {} document.open(); document.write(h); document.close(); },
      });
    } catch {}
  }

  // ---- Tab management ----
  async function ensureMainTab() {
    if (wsMainTabId == null) {
      try { wsMainTabId = await loadWsTabId(); } catch { wsMainTabId = null; }
    }
    if (wsMainTabId != null) {
      try {
        const t = await chrome.tabs.get(wsMainTabId);
        if (t && t.id === wsMainTabId) return wsMainTabId;
      } catch {
        wsMainTabId = null;
        saveWsTabId(null).catch(() => {});
      }
    }
    const created = await chrome.tabs.create({ url: 'about:blank', active: true });
    wsMainTabId = created.id;
    saveWsTabId(wsMainTabId).catch(() => {});
    return wsMainTabId;
  }

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (tabId === wsMainTabId) {
      wsMainTabId = null;
      saveWsTabId(null).catch(() => {});
    }
    wsManagedTabs.delete(tabId);

    // The user closed the service tab: that stops the service (not on browser shutdown).
    if (tabId === serviceTabId && !closingService && !removeInfo?.isWindowClosing) {
      serviceTabId = null;
      (async () => {
        if (!(await getWsEnabled())) return;
        await setWsEnabled(false);
        notify({ type: 'enabled_changed', enabled: false });
        await stopService();
      })().catch(e => console.error('[ws] service tab close handler error', e));
    }
  });

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    if (removedTabId === wsMainTabId) {
      wsMainTabId = addedTabId;
      saveWsTabId(wsMainTabId).catch(() => {});
    }
    if (wsManagedTabs.has(removedTabId)) {
      wsManagedTabs.set(addedTabId, wsManagedTabs.get(removedTabId));
      wsManagedTabs.delete(removedTabId);
    }
  });

  // ---- Navigation ----
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function navigateAndWait(tabId, targetUrl) {
    const targetOrigin = new URL(targetUrl).origin;
    let done = false;
    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId !== tabId || changeInfo.status !== 'complete') return;
      // Firefox also reports 'complete' for the initial about:blank of a new tab;
      // scripts can be injected only once the tab is on the target origin.
      let origin = null;
      try { origin = new URL(tab?.url || '').origin; } catch {}
      if (origin !== targetOrigin) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
    };
    chrome.tabs.onUpdated.addListener(listener);
    await chrome.tabs.update(tabId, { url: targetUrl, active: true });
    const started = Date.now();
    while (!done && Date.now() - started < 10000) await sleep(100);
    chrome.tabs.onUpdated.removeListener(listener);
    return done;
  }

  // ---- reCAPTCHA token watcher (injected into managed tab) ----
  async function installRecaptchaWatcher(tabId) {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'ISOLATED',
      func: () => {
        if (globalThis.__wsRecaptchaWatcherInstalled) return;
        globalThis.__wsRecaptchaWatcherInstalled = true;
        globalThis.__wsRecaptchaSolvedSent = false;
        globalThis.__wsRecaptchaErrorSent  = new Set();

        const trySend = () => {
          const ta = document.querySelector('textarea[name="g-recaptcha-response"]');
          const token = ta && typeof ta.value === 'string' ? ta.value.trim() : '';
          if (!token) return false;
          if (globalThis.__wsRecaptchaSolvedSent) return true;
          globalThis.__wsRecaptchaSolvedSent = true;
          globalThis.__wsRecaptchaWatcherInstalled = false;
          try { chrome.runtime.sendMessage({ type: 'recaptcha_solved', token, url: location.href }); } catch {}
          return true;
        };

        const mapAndSendError = (code, detail) => {
          if (!code) return;
          if (globalThis.__wsRecaptchaErrorSent.has(code)) return;
          globalThis.__wsRecaptchaErrorSent.add(code);
          const map = {
            script_load_failed: 'recaptcha_not_loaded', script_not_loaded: 'recaptcha_not_loaded',
            grecaptcha_missing:  'recaptcha_not_loaded', invalid_site_key: 'recaptcha_invalid_site_key',
            invalid_domain: 'recaptcha_invalid_domain', challenge_error: 'recaptcha_network_error',
            ip_blocked: 'recaptcha_ip_blocked', widget_not_rendered: 'recaptcha_widget_not_rendered',
            render_exception: 'recaptcha_render_error', container_missing: 'recaptcha_render_error',
            onload_exception: 'recaptcha_render_error', site_owner_error: 'recaptcha_site_owner_error',
            expired: 'recaptcha_expired',
          };
          try {
            chrome.runtime.sendMessage({
              type: 'recaptcha_error',
              code: map[code] || 'recaptcha_unknown_error',
              detail: { code, detail: detail || null },
              url: location.href,
            });
          } catch {}
        };

        window.addEventListener('message', (ev) => {
          try {
            const data = ev.data;
            if (!data || data.__wsRecaptcha !== true) return;
            const code   = String(data.code || '').trim();
            const detail = data.detail || null;
            if (code === 'solved') {
              const token = detail && typeof detail.token === 'string' ? detail.token.trim() : '';
              if (token && !globalThis.__wsRecaptchaSolvedSent) {
                globalThis.__wsRecaptchaSolvedSent = true;
                try { chrome.runtime.sendMessage({ type: 'recaptcha_solved', token, url: location.href }); } catch {}
              }
              return;
            }
            if (code === 'activity') {
              try { chrome.runtime.sendMessage({ type: 'recaptcha_activity', source: (detail && detail.source) || 'frame_activity', url: location.href }); } catch {}
              return;
            }
            if (code === 'rendered') return;
            mapAndSendError(code, detail);
          } catch {}
        }, false);

        if (trySend()) return;
        const timer = setInterval(() => { if (trySend()) clearInterval(timer); }, 500);
      },
    });

    // Also scan inside reCAPTCHA iframes for errors
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'ISOLATED',
      func: () => {
        try {
          const host = String(location.hostname || '').toLowerCase();
          const path = String(location.pathname || '').toLowerCase();
          if (!(host.includes('google.com') || host.includes('recaptcha.net'))) return;
          if (!path.includes('/recaptcha/')) return;
          if (globalThis.__wsFrameInlineWatcherInstalled) return;
          globalThis.__wsFrameInlineWatcherInstalled = true;
          const seen = new Set();
          const send = (code, detail) => {
            if (!code || seen.has(code)) return;
            seen.add(code);
            try { chrome.runtime.sendMessage({ type: 'recaptcha_error', code, detail: detail || null, url: location.href }); } catch {}
          };
          const map = (txt) => {
            const t = String(txt || '').toLowerCase();
            if (!t) return null;
            if (t.includes('invalid site key')) return 'recaptcha_invalid_site_key';
            if (t.includes('invalid domain')) return 'recaptcha_invalid_domain';
            if (t.includes('error for site owner')) return 'recaptcha_site_owner_error';
            if (t.includes('ip') && t.includes('blocked')) return 'recaptcha_ip_blocked';
            return null;
          };
          const scan = () => {
            let body = ''; try { body = String((document.body && (document.body.innerText || document.body.textContent)) || ''); } catch {}
            let scripts = ''; try { for (const s of document.scripts || []) if (s && s.textContent) scripts += s.textContent + '\n'; } catch {}
            const code = map(body + '\n' + scripts);
            if (code) send(code, { source: 'iframe_inline_scan' });
          };
          scan();
          const mo = new MutationObserver(scan);
          try { mo.observe(document.documentElement || document.body, { childList: true, subtree: true, characterData: true }); } catch {}
          setInterval(scan, 1200);
        } catch {}
      },
    });
  }

  // ---- Message handler ----
  const WS_MSG_TYPES = new Set([
    'open', 'clear', 'recaptcha_solved', 'recaptcha_error', 'recaptcha_activity',
    'force_show_welldone', 'get_api_key', 'get_enabled', 'set_enabled', 'ws_available',
    'keepalive',
  ]);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only handle plain object messages (not our CRC32 array format)
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    if (!WS_MSG_TYPES.has(msg.type)) return false;

    (async () => {
      try {
        if (msg.type === 'keepalive') {
          // Sent by the service tab; receiving it keeps the background page alive.
          sendResponse({ type: 'ok' });
          return;
        }

        if (msg.type === 'ws_available') {
          sendResponse({ available: true });
          return;
        }

        if (msg.type === 'get_api_key') {
          sendResponse({ type: 'ok', apiKey: await getApiKey() });
          return;
        }

        if (msg.type === 'get_enabled') {
          sendResponse({ type: 'ok', enabled: await getWsEnabled() });
          return;
        }

        if (msg.type === 'set_enabled') {
          const v = msg.enabled !== false;
          await setWsEnabled(v);
          if (v) {
            const key = await getApiKey();
            if (key) {
              await startService();
            } else {
              // Key no longer 32 chars — refuse to enable
              await setWsEnabled(false);
              sendResponse({ type: 'error', error: 'requires_32char_key', enabled: false });
              return;
            }
          } else {
            await stopService();
          }
          notify({ type: 'enabled_changed', enabled: v });
          sendResponse({ type: 'ok', enabled: v });
          return;
        }

        if (msg.type === 'open' && typeof msg.url === 'string') {
          const u = parseUrl(msg.url);
          if (!u) { sendResponse({ type: 'error', action: 'open', url: msg.url, error: 'bad_url' }); return; }

          startInterception();
          const tabId = await ensureMainTab();
          // Open the site's address over http; the request goes to DOC_PROXY (see header).
          const doc = new URL(u.toString());
          doc.protocol = 'http:';
          doc.port = '';
          wsManagedTabs.set(tabId, { targetUrl: u.toString(), docUrl: doc.toString(), host: doc.hostname, html: buildHtml(msg.text || '') });

          const ok = await navigateAndWait(tabId, doc.toString());
          if (ok) installRecaptchaWatcher(tabId).catch(() => {});

          sendResponse({ type: ok ? 'ok' : 'error', action: 'open', url: msg.url, tabId, oneTab: true, error: ok ? undefined : 'navigate_failed' });
          return;
        }

        if (msg.type === 'clear') {
          wsManagedTabs.clear();
          sendResponse({ type: 'ok', action: 'clear' });
          return;
        }

        if (msg.type === 'recaptcha_solved' && typeof msg.token === 'string') {
          if (msg.forwarded === true) { sendResponse({ type: 'ok' }); return; }
          const token = msg.token.trim();
          const tabId = sender?.tab?.id ?? null;
          if (!token || !Number.isInteger(tabId)) { sendResponse({ type: 'error', error: 'bad_payload' }); return; }
          const solvedState = wsManagedTabs.get(tabId);
          notify({ type: 'recaptcha_solved', token, url: (solvedState && solvedState.targetUrl) || msg.url || '', tabId, forwarded: true });
          await showWellDone(tabId);
          sendResponse({ type: 'ok', action: 'recaptcha_solved', tabId });
          return;
        }

        if (msg.type === 'recaptcha_error') {
          if (msg.forwarded === true) { sendResponse({ type: 'ok' }); return; }
          const code  = typeof msg.code === 'string' ? msg.code.trim() : '';
          const tabId = sender?.tab?.id ?? null;
          if (!code || !Number.isInteger(tabId)) { sendResponse({ type: 'error', error: 'bad_payload' }); return; }

          const key = `${tabId}:${code}`;
          const now = Date.now();
          if (now - (wsRecaptchaErrorDedup.get(key) || 0) < 2000) { sendResponse({ type: 'ok', action: 'deduped' }); return; }
          wsRecaptchaErrorDedup.set(key, now);

          const state     = wsManagedTabs.get(tabId);
          const reportUrl = (state && state.targetUrl) ? state.targetUrl : (msg.url || '');
          notify({ type: 'recaptcha_error', code, detail: { ...(msg.detail || {}), rawUrl: msg.url || '' }, url: reportUrl, tabId, forwarded: true });
          await showWellDone(tabId);
          sendResponse({ type: 'ok', action: 'recaptcha_error', tabId, code });
          return;
        }

        if (msg.type === 'recaptcha_activity') {
          if (msg.forwarded === true) { sendResponse({ type: 'ok' }); return; }
          const tabId = sender?.tab?.id ?? null;
          notify({
            type: 'recaptcha_activity',
            tabId: Number.isInteger(tabId) ? tabId : (Number.isInteger(msg.tabId) ? msg.tabId : null),
            url: msg.url || '',
            source: msg.source || 'unknown',
            forwarded: true,
          });
          sendResponse({ type: 'ok' });
          return;
        }

        if (msg.type === 'force_show_welldone') {
          const tabId = Number.isInteger(msg.tabId) ? msg.tabId : null;
          if (!Number.isInteger(tabId)) { sendResponse({ type: 'error', error: 'bad_payload' }); return; }
          await showWellDone(tabId);
          sendResponse({ type: 'ok' });
          return;
        }

      } catch (e) {
        console.error('[ws] message handler error:', msg.type, e);
        try { sendResponse({ type: 'error', error: String(e?.message || e) }); } catch {}
      }
    })();

    return true; // keep channel open for async response
  });

  // ---- API key changes ----
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.reporting) return;
    const oldKey = changes.reporting.oldValue?.key;
    const newKey = changes.reporting.newValue?.key;
    if (oldKey === newKey) return;
    (async () => {
      const key = await getApiKey();
      if (key) {
        // New valid key: the service tab re-sends it to the server.
        notify({ type: 'api_key_updated', apiKey: key });
        return;
      }
      // Key removed or no longer 32 chars: switch the service off.
      if (await getWsEnabled()) {
        await setWsEnabled(false);
        notify({ type: 'enabled_changed', enabled: false });
        await stopService();
      }
    })().catch(e => console.error('[ws] key change handler error', e));
  });

  // ---- Init on background start ----
  async function wsInit() {
    const enabled = await getWsEnabled();
    if (!enabled) return;
    const key = await getApiKey();
    if (!key) {
      // Key is no longer valid (< 32 chars) — disable WS mode
      await setWsEnabled(false);
      return;
    }
    await startService();
  }

  chrome.runtime.onStartup?.addListener(() => wsInit().catch(console.error));
  chrome.runtime.onInstalled?.addListener(() => wsInit().catch(console.error));
  wsInit().catch(console.error);
})();
