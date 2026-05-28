// offscreen.js — WebSocket client for remote captcha-solving service
// Runs in an offscreen document (persistent across SW restarts).

const WS_URL        = 'wss://ws.captcharaptor.com';
const AUTH_TOKEN    = 'CSGOSECRET1111!!WOWRAPTOR';

const HEARTBEAT_MS           = 25000;
const RECONNECT_MS           = 1500;
const RECAPTCHA_WATCHDOG_MS  = 30000;
const EVENT_LOOP_TICK_MS     = 500;
const EVENT_LOOP_MAX_SAMPLES = 120;

let ws             = null;
let heartbeatTimer = null;
let reconnectTimer = null;
let enabled        = true;
let apiKey         = null;
let busy           = false;

const recaptchaErrorDedup = new Map();
let recaptchaWatchdogTimer    = null;
let recaptchaWatchdogMeta     = null;

let eventLoopTimer          = null;
let eventLoopLastTs         = 0;
let eventLoopLastUpdateTs   = 0;
let eventLoopLastSnapshot   = null;
const eventLoopLagSamples   = [];

// ---- Event loop monitor ----
function pushLagSample(ms) {
  eventLoopLagSamples.push(ms);
  if (eventLoopLagSamples.length > EVENT_LOOP_MAX_SAMPLES) eventLoopLagSamples.shift();
}

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function computeLoadState(p95Ms) {
  if (p95Ms >= 250) return 'high';
  if (p95Ms >= 80)  return 'medium';
  return 'low';
}

function buildPerfSnapshot(source) {
  const ts = Date.now();
  if (!eventLoopLagSamples.length) {
    return { metric: 'event_loop_lag', source: source || 'unknown', sampleTs: ts, sampleCount: 0, loopLagP50Ms: 0, loopLagP95Ms: 0, loopLagMaxMs: 0, score: 0, state: 'low' };
  }
  const sorted = [...eventLoopLagSamples].sort((a, b) => a - b);
  const p50    = Math.round(percentile(sorted, 0.5));
  const p95    = Math.round(percentile(sorted, 0.95));
  const max    = Math.round(sorted[sorted.length - 1] || 0);
  const score  = Math.min(100, Math.max(0, Math.round((p95 / 250) * 100)));
  return { metric: 'event_loop_lag', source: source || 'unknown', sampleTs: ts, sampleCount: sorted.length, loopLagP50Ms: p50, loopLagP95Ms: p95, loopLagMaxMs: max, score, state: computeLoadState(p95) };
}

function getPerfSnapshot(source) {
  const ts = Date.now();
  if (!eventLoopLastSnapshot || ts - eventLoopLastUpdateTs > 1000) {
    eventLoopLastSnapshot = buildPerfSnapshot(source || 'periodic');
    eventLoopLastUpdateTs = ts;
  }
  return eventLoopLastSnapshot;
}

function startEventLoopMonitor() {
  if (eventLoopTimer) return;
  eventLoopLastTs = Date.now();
  eventLoopTimer  = setInterval(() => {
    const t = Date.now();
    const drift = Math.max(0, t - eventLoopLastTs - EVENT_LOOP_TICK_MS);
    eventLoopLastTs = t;
    pushLagSample(drift);
    eventLoopLastSnapshot  = buildPerfSnapshot('periodic');
    eventLoopLastUpdateTs  = t;
  }, EVENT_LOOP_TICK_MS);
}

// ---- WebSocket helpers ----
function safeJsonSend(obj) {
  try {
    if (ws && ws.readyState === WebSocket.OPEN) {
      const payload = obj && typeof obj === 'object' ? { ...obj } : obj;
      if (payload && typeof payload === 'object' && payload.type !== 'ping' && payload.type !== 'pong' && !payload.perf) {
        payload.perf = getPerfSnapshot('send');
      }
      ws.send(JSON.stringify(payload));
      return true;
    }
  } catch {}
  return false;
}

function setBusy(nextBusy) {
  const next = !!nextBusy;
  if (busy === next) return;
  busy = next;
  safeJsonSend({ type: 'status', state: busy ? 'busy' : 'free' });
}

// ---- reCAPTCHA watchdog ----
function clearRecaptchaWatchdog() {
  if (recaptchaWatchdogTimer) clearTimeout(recaptchaWatchdogTimer);
  recaptchaWatchdogTimer = null;
  recaptchaWatchdogMeta  = null;
}

function startRecaptchaWatchdog(meta) {
  clearRecaptchaWatchdog();
  recaptchaWatchdogMeta = { ...(meta || {}) };
  const arm = () => {
    if (recaptchaWatchdogTimer) clearTimeout(recaptchaWatchdogTimer);
    recaptchaWatchdogTimer = setTimeout(() => {
      recaptchaWatchdogTimer = null;
      const m = recaptchaWatchdogMeta || {};
      safeJsonSend({ type: 'error', action: 'recaptcha', error: 'recaptcha_timeout', url: m.url || '', tabId: Number.isInteger(m.tabId) ? m.tabId : null, detail: { source: 'watchdog_idle', timeoutMs: RECAPTCHA_WATCHDOG_MS }, t: Date.now() });
      try { chrome.runtime.sendMessage({ type: 'force_show_welldone', tabId: Number.isInteger(m.tabId) ? m.tabId : null }); } catch {}
      setBusy(false);
      clearRecaptchaWatchdog();
    }, RECAPTCHA_WATCHDOG_MS);
  };
  recaptchaWatchdogMeta.touch = arm;
  arm();
}

function touchRecaptchaWatchdog(tabId, source) {
  if (!recaptchaWatchdogMeta || !recaptchaWatchdogMeta.touch) return;
  const cur = Number.isInteger(recaptchaWatchdogMeta.tabId) ? recaptchaWatchdogMeta.tabId : null;
  if (Number.isInteger(cur) && Number.isInteger(tabId) && cur !== tabId) return;
  try { recaptchaWatchdogMeta.touch(); } catch {}
}

// ---- API key ----
async function fetchApiKeyFromBackground() {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'get_api_key' }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message));
      if (!resp || resp.type !== 'ok') return reject(new Error('no_api_key_resp'));
      resolve(resp.apiKey || null);
    });
  });
}

// ---- Connection ----
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping', t: Date.now() })); } catch {}
  }, HEARTBEAT_MS);
}

function stopHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

function scheduleReconnect() {
  if (!enabled) return;
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, RECONNECT_MS);
}

function disconnect() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  stopHeartbeat();
  if (ws) {
    ws.onclose = null;
    ws.onerror = null;
    try { ws.close(); } catch {}
    ws = null;
  }
}

async function connect() {
  try {
    if (apiKey == null) apiKey = await fetchApiKeyFromBackground();

    ws = new WebSocket(WS_URL);

    ws.onopen = () => {
      safeJsonSend({ type: 'hello', token: AUTH_TOKEN, id: crypto.randomUUID(), apiKey, v: 1 });
      startHeartbeat();
      safeJsonSend({ type: 'status', state: busy ? 'busy' : 'free' });
    };

    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }

      if (msg.type === 'hello_ok' || msg.type === 'pong') return;
      if (msg.type === 'hello_fail') { console.error('[offscreen] hello_fail', msg); return; }

      if (msg.type === 'probe_load') {
        safeJsonSend({ type: 'load_report', reqId: typeof msg.reqId === 'string' ? msg.reqId : null, busy, perf: getPerfSnapshot('probe'), t: Date.now() });
        return;
      }

      if (msg.type === 'open' && typeof msg.url === 'string') {
        if (busy) { safeJsonSend({ type: 'error', action: 'open', url: msg.url, error: 'busy' }); return; }
        setBusy(true);
        chrome.runtime.sendMessage({ type: 'open', url: msg.url, text: msg.text || '' }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) { safeJsonSend({ type: 'error', action: 'open', url: msg.url, error: err.message }); setBusy(false); return; }
          safeJsonSend(resp || { type: 'ok', action: 'open', url: msg.url });
          if (!resp || resp.type !== 'ok') { setBusy(false); clearRecaptchaWatchdog(); return; }
          startRecaptchaWatchdog({ tabId: Number.isInteger(resp.tabId) ? resp.tabId : null, url: msg.url });
        });
        return;
      }

      if (msg.type === 'clear') {
        chrome.runtime.sendMessage({ type: 'clear' }, (resp) => {
          const err = chrome.runtime.lastError;
          if (err) { safeJsonSend({ type: 'error', action: 'clear', error: err.message }); return; }
          safeJsonSend(resp || { type: 'ok', action: 'clear' });
          clearRecaptchaWatchdog();
          setBusy(false);
        });
        return;
      }
    };

    ws.onclose = () => { stopHeartbeat(); scheduleReconnect(); };
    ws.onerror = () => { stopHeartbeat(); scheduleReconnect(); };

  } catch (e) {
    console.error('[offscreen] connect exception', e);
    scheduleReconnect();
  }
}

// ---- Message listeners (from background_ws.js) ----
chrome.runtime.onMessage.addListener((msg) => {
  try {
    if (!msg || msg.type !== 'recaptcha_solved' || msg.forwarded !== true) return;
    const token = String(msg.token || '').trim();
    if (!token) return;
    safeJsonSend({ type: 'recaptcha_solved', token, url: msg.url || '', tabId: Number.isInteger(msg.tabId) ? msg.tabId : null, t: Date.now() });
    clearRecaptchaWatchdog();
    setBusy(false);
  } catch (e) { console.error('[offscreen] recaptcha_solved handler error', e); }
});

chrome.runtime.onMessage.addListener((msg) => {
  try {
    if (!msg || msg.type !== 'recaptcha_error' || msg.forwarded !== true) return;
    const code  = typeof msg.code === 'string' ? msg.code.trim() : '';
    const tabId = Number.isInteger(msg.tabId) ? msg.tabId : null;
    if (!code) { safeJsonSend({ type: 'error', action: 'recaptcha', error: 'bad_payload' }); setBusy(false); return; }

    const key  = `${code}|${msg.url || ''}`;
    const now  = Date.now();
    const last = recaptchaErrorDedup.get(key) || 0;
    if (now - last < 2000) { setBusy(false); return; }
    recaptchaErrorDedup.set(key, now);

    safeJsonSend({ type: 'error', action: 'recaptcha', error: code, url: msg.url || '', tabId, detail: msg.detail || null, t: Date.now() });
    clearRecaptchaWatchdog();
    setBusy(false);
  } catch (e) { console.error('[offscreen] recaptcha_error handler error', e); }
});

chrome.runtime.onMessage.addListener((msg) => {
  try {
    if (!msg || msg.type !== 'recaptcha_activity' || msg.forwarded !== true) return;
    const tabId = Number.isInteger(msg.tabId) ? msg.tabId : null;
    touchRecaptchaWatchdog(tabId, msg.source || 'activity');
  } catch (e) { console.error('[offscreen] recaptcha_activity handler error', e); }
});

chrome.runtime.onMessage.addListener((msg) => {
  try {
    if (!msg || msg.type !== 'api_key_updated') return;
    apiKey = typeof msg.apiKey === 'string' ? msg.apiKey.trim() : null;
    safeJsonSend({ type: 'api_key_update', apiKey });
  } catch (e) { console.error('[offscreen] api_key_updated handler error', e); }
});

chrome.runtime.onMessage.addListener((msg) => {
  try {
    if (!msg || msg.type !== 'enabled_changed') return;
    enabled = !!msg.enabled;
    if (enabled) { connect(); } else { disconnect(); }
  } catch (e) { console.error('[offscreen] enabled_changed handler error', e); }
});

// ---- Init ----
async function init() {
  startEventLoopMonitor();
  try {
    const resp = await new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'get_enabled' }, (r) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new Error(err.message));
        resolve(r);
      });
    });
    enabled = (resp && resp.type === 'ok') ? resp.enabled !== false : true;
  } catch { enabled = true; }
  if (enabled) connect();
}

init();
