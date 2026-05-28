// background_ws.js — Remote solving via WebSocket (WS mode)
// Loaded via importScripts from background.js (Chrome) or listed in background.scripts (Firefox).
// Requires manifest permissions: debugger, offscreen, tabs, scripting + host_permissions <all_urls>

self.WS_MODE_AVAILABLE = true;

(() => {
  if (typeof chrome === 'undefined') return;

  // ---- Constants ----
  const OFFSCREEN_URL    = 'ws/offscreen.html';
  const WS_ENABLED_KEY   = 'ws_mode_enabled';
  const WS_TAB_KEY       = 'ws_main_tab_id';
  const CDP_VERSION      = '1.3';

  // ---- State ----
  let wsMainTabId = null;
  const wsRecaptchaErrorDedup = new Map();
  const wsCdpTabs             = new Map();

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

  // ---- Offscreen ----
  async function ensureOffscreen() {
    if (!chrome.offscreen) return;
    try {
      if (await chrome.offscreen.hasDocument()) return;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification: 'Keep a persistent WebSocket connection to receive captcha-solving commands.',
      });
    } catch (e) {
      console.warn('[ws] ensureOffscreen:', e);
    }
  }
  async function closeOffscreen() {
    if (!chrome.offscreen) return;
    try {
      if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument();
    } catch {}
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

  // ---- HTML template for CDP-injected page ----
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
  function base64Html(html) {
    return btoa(unescape(encodeURIComponent(String(html || ''))));
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
      if (host.endsWith('google.com') && path.startsWith('/recaptcha/')) return true;
      if (host.endsWith('recaptcha.net') && path.startsWith('/recaptcha/')) return true;
      return false;
    } catch { return false; }
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

  // ---- CDP helpers ----
  async function attachDebugger(tabId) {
    const target = { tabId };
    const state = wsCdpTabs.get(tabId) || {};
    if (state.attached) return;
    await chrome.debugger.attach(target, CDP_VERSION);
    await chrome.debugger.sendCommand(target, 'Network.enable', {});
    await chrome.debugger.sendCommand(target, 'Fetch.enable', {
      patterns: [
        { urlPattern: '*', requestStage: 'Request' },
        { urlPattern: '*://www.google.com/recaptcha/api2/anchor*', requestStage: 'Response' },
        { urlPattern: '*://www.recaptcha.net/recaptcha/api2/anchor*', requestStage: 'Response' },
      ],
    });
    state.anchorReqIds = state.anchorReqIds || new Set();
    state.attached = true;
    wsCdpTabs.set(tabId, state);
  }

  async function detachDebugger(tabId) {
    try { await chrome.debugger.detach({ tabId }); } catch {}
    wsCdpTabs.delete(tabId);
  }

  async function readResponseBodyWithRetry(target, requestId, retries = 20, delayMs = 120) {
    for (let i = 0; i < retries; i++) {
      try {
        return await chrome.debugger.sendCommand(target, 'Network.getResponseBody', { requestId });
      } catch {
        await new Promise(r => setTimeout(r, delayMs));
      }
    }
    throw new Error('response_body_unavailable');
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

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (tabId === wsMainTabId) {
      wsMainTabId = null;
      saveWsTabId(null).catch(() => {});
    }
    if (wsCdpTabs.has(tabId)) detachDebugger(tabId).catch(() => {});
  });

  chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
    if (removedTabId === wsMainTabId) {
      wsMainTabId = addedTabId;
      saveWsTabId(wsMainTabId).catch(() => {});
    }
    if (wsCdpTabs.has(removedTabId)) {
      const state = wsCdpTabs.get(removedTabId);
      wsCdpTabs.delete(removedTabId);
      wsCdpTabs.set(addedTabId, { ...state, attached: false });
      attachDebugger(addedTabId).catch(() => {});
    }
  });

  // ---- CDP event dispatching ----
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (!source || typeof source.tabId !== 'number') return;
    const tabId = source.tabId;
    const state = wsCdpTabs.get(tabId);
    if (!state || !state.attached) return;

    if (method === 'Network.responseReceived') {
      const url    = (params?.response?.url || '').toLowerCase();
      const reqId  = params?.requestId;

      if (url.includes('/recaptcha/')) {
        // Forward activity to offscreen (WS watchdog reset)
        chrome.runtime.sendMessage({ type: 'recaptcha_activity', tabId, url, source: 'network', forwarded: true }).catch(() => {});
      }

      if (url.includes('/recaptcha/api2/anchor') && reqId) {
        state.anchorReqIds = state.anchorReqIds || new Set();
        state.anchorReqIds.add(String(reqId));
        wsCdpTabs.set(tabId, state);
        const target = { tabId };
        (async () => {
          try {
            const bodyRes = await readResponseBodyWithRetry(target, String(reqId));
            let body = (bodyRes && bodyRes.body) || '';
            if (bodyRes && bodyRes.base64Encoded) { try { body = atob(body); } catch {} }
            const code = detectRecaptchaErrorCode(body);
            if (code) {
              chrome.runtime.sendMessage({ type: 'recaptcha_error', code, detail: { source: 'anchor_network' }, url: state.targetUrl || '', tabId, forwarded: true }).catch(() => {});
              await showWellDone(tabId);
            }
          } catch {}
        })();
      }
      return;
    }

    if (method !== 'Fetch.requestPaused') return;

    const requestId    = params.requestId;
    const url          = (params.request && params.request.url) || '';
    const resourceType = params.resourceType || '';
    const stage        = params.requestStage || 'Request';
    const target       = { tabId };

    const fulfill = (body, contentType) =>
      chrome.debugger.sendCommand(target, 'Fetch.fulfillRequest', {
        requestId, responseCode: 200,
        responseHeaders: [{ name: 'Content-Type', value: contentType || 'text/plain; charset=utf-8' }],
        body,
      });
    const continueReq = () => chrome.debugger.sendCommand(target, 'Fetch.continueRequest', { requestId });

    (async () => {
      try {
        if (stage === 'Response' && url.toLowerCase().includes('/recaptcha/api2/anchor')) {
          try {
            const bodyRes = await chrome.debugger.sendCommand(target, 'Fetch.getResponseBody', { requestId });
            let body = (bodyRes && bodyRes.body) || '';
            if (bodyRes && bodyRes.base64Encoded) { try { body = atob(body); } catch {} }
            const code = detectRecaptchaErrorCode(body);
            if (code) {
              chrome.runtime.sendMessage({ type: 'recaptcha_error', code, detail: { source: 'anchor_fetch_response' }, url: state.targetUrl || '', tabId, forwarded: true }).catch(() => {});
              await showWellDone(tabId);
            }
          } catch {}
          await continueReq();
          return;
        }
        if (isAllowedNetUrl(url)) { await continueReq(); return; }
        if (resourceType === 'Document') {
          await fulfill(base64Html(state.html || '<!doctype html><title></title>'), 'text/html; charset=utf-8');
          return;
        }
        await fulfill(btoa(''), 'text/plain; charset=utf-8');
      } catch {}
    })();
  });

  chrome.debugger.onDetach.addListener((source) => {
    if (!source || typeof source.tabId !== 'number') return;
    wsCdpTabs.delete(source.tabId);
  });

  // ---- Navigation ----
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function navigateAndWait(tabId, targetUrl) {
    let done = false;
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId !== tabId) return;
      if (changeInfo.status === 'complete') {
        done = true;
        chrome.tabs.onUpdated.removeListener(listener);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    await chrome.tabs.update(tabId, { url: targetUrl, active: true });
    const started = Date.now();
    while (!done && Date.now() - started < 5000) await sleep(100);
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
  ]);

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // Only handle plain object messages (not our CRC32 array format)
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return false;
    if (!WS_MSG_TYPES.has(msg.type)) return false;

    (async () => {
      try {
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
              await ensureOffscreen();
              await ensureRecaptchaFrameWatcher();
            } else {
              // Key no longer 32 chars — refuse to enable
              await setWsEnabled(false);
              sendResponse({ type: 'error', error: 'requires_32char_key', enabled: false });
              return;
            }
          } else {
            await closeOffscreen();
            await unregisterRecaptchaFrameWatcher();
          }
          try { chrome.runtime.sendMessage({ type: 'enabled_changed', enabled: v }); } catch {}
          sendResponse({ type: 'ok', enabled: v });
          return;
        }

        if (msg.type === 'open' && typeof msg.url === 'string') {
          const u = parseUrl(msg.url);
          if (!u) { sendResponse({ type: 'error', action: 'open', url: msg.url, error: 'bad_url' }); return; }

          await ensureOffscreen();
          const tabId = await ensureMainTab();
          const html  = buildHtml(msg.text || '');

          const prev = wsCdpTabs.get(tabId) || {};
          wsCdpTabs.set(tabId, { targetUrl: u.toString(), html, attached: !!prev.attached });

          try {
            await attachDebugger(tabId);
          } catch (e) {
            sendResponse({ type: 'error', action: 'open', url: msg.url, error: 'debugger_attach_failed' });
            return;
          }

          const ok = await navigateAndWait(tabId, u.toString());
          if (ok) installRecaptchaWatcher(tabId).catch(() => {});

          sendResponse({ type: ok ? 'ok' : 'error', action: 'open', url: msg.url, tabId, oneTab: true, error: ok ? undefined : 'navigate_failed' });
          return;
        }

        if (msg.type === 'clear') {
          for (const tabId of Array.from(wsCdpTabs.keys())) await detachDebugger(tabId).catch(() => {});
          sendResponse({ type: 'ok', action: 'clear' });
          return;
        }

        if (msg.type === 'recaptcha_solved' && typeof msg.token === 'string') {
          if (msg.forwarded === true) { sendResponse({ type: 'ok' }); return; }
          const token = msg.token.trim();
          const tabId = sender?.tab?.id ?? null;
          if (!token || !Number.isInteger(tabId)) { sendResponse({ type: 'error', error: 'bad_payload' }); return; }
          chrome.runtime.sendMessage({ type: 'recaptcha_solved', token, url: msg.url || '', tabId, forwarded: true }).catch(() => {});
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

          const state     = wsCdpTabs.get(tabId);
          const reportUrl = (state && state.targetUrl) ? state.targetUrl : (msg.url || '');
          chrome.runtime.sendMessage({ type: 'recaptcha_error', code, detail: { ...(msg.detail || {}), rawUrl: msg.url || '' }, url: reportUrl, tabId, forwarded: true }).catch(() => {});
          await showWellDone(tabId);
          sendResponse({ type: 'ok', action: 'recaptcha_error', tabId, code });
          return;
        }

        if (msg.type === 'recaptcha_activity') {
          if (msg.forwarded === true) { sendResponse({ type: 'ok' }); return; }
          const tabId = sender?.tab?.id ?? null;
          chrome.runtime.sendMessage({
            type: 'recaptcha_activity',
            tabId: Number.isInteger(tabId) ? tabId : (Number.isInteger(msg.tabId) ? msg.tabId : null),
            url: msg.url || '',
            source: msg.source || 'unknown',
            forwarded: true,
          }).catch(() => {});
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

  // ---- Init on SW startup ----
  async function wsInit() {
    const enabled = await getWsEnabled();
    if (!enabled) return;
    const key = await getApiKey();
    if (!key) {
      // Key is no longer valid (< 32 chars) — disable WS mode
      await setWsEnabled(false);
      return;
    }
    await ensureOffscreen();
    await ensureRecaptchaFrameWatcher();
  }

  chrome.runtime.onStartup?.addListener(() => wsInit().catch(console.error));
  chrome.runtime.onInstalled?.addListener(() => wsInit().catch(console.error));
  wsInit().catch(console.error);
})();
