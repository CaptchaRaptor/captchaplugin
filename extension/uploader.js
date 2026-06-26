(() => {
  const BASE_URL = 'https://captcharaptor.com';
  const STATUS_URL = BASE_URL + '/status.php';
  const UPLOAD_URL = BASE_URL + '/upload.php';
  const MIN_ROW_AGE_MS = 60_000;


  const DEFAULT_REPORTING = {
    enabled: true,
    key: '',
    client_id: '',
    schedule_minutes: 60,
    backoff_min_minutes: 1,
    backoff_max_minutes: 360,
    
    part_max_bytes: 5 * 1024 * 1024,       
    multipart_max_bytes: 5 * 1024 * 1024,  
    max_parts_per_batch: 3,                
    
    _next_try_ts: 0,
    _backoff_minutes: 0
  };
  const DEFAULT_STATE = {
    uploading: false,
    last_success_ts: 0,
    last_error_ts: 0,
    last_error_reason: '',
    last_batch_info: null
  };

  const STORES = [
    { name: 'cap33plagin', field: 'cap33plagin' },
    { name: 'cap44plagin', field: 'cap44plagin' },
    { name: 'capimg',      field: 'capimg'      },
  ];

  const CAP_DB_NAME = 'caplog';
  const PART_MAX_LINES = 10_000;
  const REQUEST_TIMEOUT_MS = 90_000;
  let __uploadLock = false;

  
  
  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(CAP_DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB ' + CAP_DB_NAME));
    });
  }

  
  
  function readOnePart(db, storeName, partLimitBytes, partLimitLines = PART_MAX_LINES) {
    const MIN_ROW_AGE_MS = 60_000;

    if (!db.objectStoreNames.contains(storeName)) {
      console.warn('[uploader] store not found:', storeName);
      return Promise.resolve(null);
    }

    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeName, 'readonly');
      } catch (e) {
  
        console.warn('[uploader] failed to open tx for', storeName, e);
        return resolve(null);
      }

      const os = tx.objectStore(storeName);
      const req = os.openCursor();
      const enc = new TextEncoder();

      const lines = [];
      const keys  = [];
      let bytes = 0;
      let count = 0;

      req.onsuccess = e => {
        const cursor = e.target.result;
        if (!cursor) {
          if (lines.length) {
            const blob = new Blob(lines, { type: 'application/x-ndjson' });
            resolve({ blob, keys, lines: count, bytes });
          } else {
            resolve(null);
          }
          return;
        }

        const v = cursor.value;
        const ts = typeof v?.ts === 'number' ? v.ts : 0;
        if (ts > 0 && (Date.now() - ts) < MIN_ROW_AGE_MS) {
          cursor.continue();
          return;
        }


        const js = JSON.stringify(cursor.value) + '\n';
        const b  = enc.encode(js).byteLength;

        if (count > 0 && (bytes + b > partLimitBytes || count + 1 > partLimitLines)) {
          const blob = new Blob(lines, { type: 'application/x-ndjson' });
          resolve({ blob, keys, lines: count, bytes });
          return;
        }

        lines.push(js);
        keys.push(cursor.primaryKey);
        bytes += b;
        count += 1;

        cursor.continue();
      };

      req.onerror = () => reject(req.error || new Error('cursor error for ' + storeName));
    });
  }


  function deleteKeys(db, storeName, keys) {
    if (!keys?.length) return Promise.resolve();
    if (!db.objectStoreNames.contains(storeName)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      let tx;
      try {
        tx = db.transaction(storeName, 'readwrite');
      } catch (e) {
        console.warn('[uploader] deleteKeys: tx failed for', storeName, e);
        return resolve();
      }
      const os = tx.objectStore(storeName);
      for (const k of keys) os.delete(k);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('deleteKeys tx error for ' + storeName));
    });
  }

  
  
  async function getReporting() {
    const { reporting = DEFAULT_REPORTING } = await chrome.storage.local.get('reporting');
    return { ...DEFAULT_REPORTING, ...reporting };
  }
  async function setReporting(patch) {
    const reporting = { ...(await getReporting()), ...(patch || {}) };
    await chrome.storage.local.set({ reporting });
    return reporting;
  }
  async function getState() {
    const { reporting_state = DEFAULT_STATE } = await chrome.storage.local.get('reporting_state');
    return { ...DEFAULT_STATE, ...reporting_state };
  }
  async function setState(patch) {
    const state = { ...(await getState()), ...(patch || {}) };
    await chrome.storage.local.set({ reporting_state: state });
    return state;
  }

  
  
  function isWifiPreferred() {
    try {
      const c = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
      if (!c) return true;
      if ('type' in c && (c.type === 'wifi' || c.type === 'ethernet')) return true;
      if ('effectiveType' in c && c.effectiveType === '4g') return true;
      return false;
    } catch { return true; }
  }
  function withTimeout(promise, ms, ac) {
    const t = setTimeout(() => ac?.abort('timeout'), ms);
    return promise.finally(() => clearTimeout(t));
  }
  async function fetchJSON(url, opts, timeoutMs = REQUEST_TIMEOUT_MS) {
    const ac = new AbortController();
    const t0 = Date.now();
    try {
      const res = await withTimeout(fetch(url, { ...opts, signal: ac.signal }), timeoutMs, ac);
      const txt = await res.text();
      let json = null;
      try { json = txt ? JSON.parse(txt) : null; } catch {}
      return { ok: res.ok, status: res.status, json, text: txt, ms: Date.now() - t0 };
    } catch (e) {
      return { ok: false, status: 0, json: null, text: String(e), ms: Date.now() - t0, error: e };
    }
  }

  
  
  async function buildNextBatch(db, cfg) {
    const parts = [];
    const limitPart = cfg?.part_max_bytes || (5 * 1024 * 1024);
    const limitMultipart = cfg?.multipart_max_bytes || limitPart;
    const maxParts = Math.max(1, cfg?.max_parts_per_batch || 3);

    const candidates = [];
    for (const s of STORES) {
      try {
        const value = await readOnePart(db, s.name, limitPart);
        if (value) {
          const filename = (value.lines > PART_MAX_LINES || value.bytes > limitPart)
            ? `${s.name}.part001.ndjson`
            : `${s.name}.ndjson`;
          candidates.push({
            field: s.field,
            filename,
            blob: value.blob,
            keys: value.keys,
            lines: value.lines,
            bytes: value.bytes,
            store: s.name
          });
        }
      } catch (e) {
        console.warn('[uploader] readOnePart failed for', s.name, e);
      }
    }
    if (!candidates.length) return null;

    
    candidates.sort((a,b) => a.bytes - b.bytes);
    let total = 0;
    for (const c of candidates) {
      if (parts.length >= maxParts) break;
      if (total + c.bytes > limitMultipart && parts.length > 0) continue;
      if (total + c.bytes > limitMultipart && parts.length === 0) {
        parts.push(c);
        total += c.bytes;
        break;
      }
      parts.push(c);
      total += c.bytes;
    }

    if (!parts.length) return null;
    const form = new FormData();
    for (const p of parts) form.append(p.field, p.blob, p.filename);
    return { parts, form };
  }

  async function sendBatch(form, key, clientId) {
    const url = `${UPLOAD_URL}?key=${encodeURIComponent(key)}`;
    const headers = new Headers();
    headers.set('X-Auth-Key', key);
    if (clientId) headers.set('X-Client-Id', clientId);
    return await fetchJSON(url, { method: 'POST', headers, body: form });
  }

  async function statusCheck(key) {
    if (!key) return { accepting: true };
    const url = `${STATUS_URL}?key=${encodeURIComponent(key)}`;
    const res = await fetchJSON(url, { method: 'GET' });
    if (res.ok && res.json && typeof res.json.accepting !== 'undefined') return res.json;
    return { accepting: true };
  }

  function computeNextBackoffMinutes(cur, base, max) {
    const next = cur && cur > 0 ? Math.min(max, cur * 3) : base;
    const jitter = Math.random() * next * 0.5;
    return Math.max(base, Math.min(max, Math.floor(next - jitter + Math.random() * jitter)));
  }

  async function scheduleAlarmInMinutes(mins) {
    try { await chrome.alarms.create('reporting:tick', { delayInMinutes: Math.max(1/60, mins) }); } catch {}
  }
  async function ensurePeriodicAlarm(period) {
    try { await chrome.alarms.create('reporting:periodic', { periodInMinutes: Math.max(15, period || 60) }); } catch {}
  }

  function networkOkay() {
    if (navigator.onLine === false) return false;
    return isWifiPreferred();
  }

  async function startUpload(trigger = 'scheduled') {
    const cfg = await getReporting();
    if (!cfg.enabled) return { skipped: true, reason: 'disabled' };
    if (!cfg.key || !/^[0-9a-z]{16}([0-9a-z]{16})?$/.test(cfg.key)) {
      await setState({ last_error_ts: Date.now(), last_error_reason: 'Invalid key (expected 16 or 32 [0-9a-z])' });
      return { skipped: true, reason: 'bad-key' };
    }
    const sendKey = cfg.key.slice(0, 16);
    if (__uploadLock) return { skipped: true, reason: 'already-running' };
    if (!networkOkay()) return { skipped: true, reason: 'network-not-preferred' };

    __uploadLock = true;
    await setState({ uploading: true });

    try {
      const st = await statusCheck(sendKey);
      if (st && st.accepting === false) {
        await setState({ last_error_ts: Date.now(), last_error_reason: 'Server is not accepting uploads (accepting=false)' });
        return { skipped: true, reason: 'server-not-accepting' };
      }
    } catch {}

    const db = await openDB();
    let anySent = false;
    let totalStats = [];

    while (true) {
      const batch = await buildNextBatch(db, cfg);
      if (!batch || !batch.parts.length) break;

      const res = await sendBatch(batch.form, sendKey, cfg.client_id || '');
      const partMetrics = batch.parts.map(p => ({ store: p.store, filename: p.filename, lines: p.lines, bytes: p.bytes }));

      if (res.ok && res.status === 200 && res.json && res.json.ok === true) {
        
        for (const p of batch.parts) {
          try { await deleteKeys(db, p.store, p.keys); } catch {}
        }
        anySent = true;
        totalStats = totalStats.concat(partMetrics);
        await setReporting({ _backoff_minutes: 0, _next_try_ts: 0 });
      } else {
        const reason =
          res.status === 403 ? '403: invalid key' :
          res.status === 400 ? '400: server did not receive data (check multipart)' :
          res.status === 413 ? '413: request too large' :
          res.status >= 500 ? `5xx: server error (${res.status})` :
          res.text || 'Unknown error';
        await setState({ last_error_ts: Date.now(), last_error_reason: `Send error: ${reason}` });


        if (res.status === 413) {
          const curPart = cfg.part_max_bytes || (5 * 1024 * 1024);
          const nextPart = Math.max(256 * 1024, Math.floor(curPart / 2));
          const curMulti = cfg.multipart_max_bytes || curPart;
          const nextMulti = Math.max(nextPart, Math.floor(curMulti / 2));
          await setReporting({ part_max_bytes: nextPart, multipart_max_bytes: nextMulti, max_parts_per_batch: 1, _backoff_minutes: 1, _next_try_ts: Date.now() + 60_000 });
        } else if (res.status === 403) {
          const backoff = cfg.backoff_max_minutes;
          await setReporting({ _backoff_minutes: backoff, _next_try_ts: Date.now() + backoff * 60_000 });
        } else {
          const next = computeNextBackoffMinutes(cfg._backoff_minutes, cfg.backoff_min_minutes, cfg.backoff_max_minutes);
          await setReporting({ _backoff_minutes: next, _next_try_ts: Date.now() + next * 60_000 });
        }
        break;
      }
    }

    if (anySent) {
      await setState({
        last_success_ts: Date.now(),
        last_error_reason: '',
        last_batch_info: { when: Date.now(), parts: totalStats }
      });
    }

    return { ok: true, anySent, totalStats };
  }

  
  
  async function maybeStartByPolicy(trigger) {
    const cfg = await getReporting();
    if (!cfg.enabled) return;
    if (cfg._next_try_ts && Date.now() < cfg._next_try_ts) {
      const mins = Math.max(1, Math.ceil((cfg._next_try_ts - Date.now()) / 60000));
      await scheduleAlarmInMinutes(mins);
      return;
    }
    await startUpload(trigger);
  }

  chrome.alarms.onAlarm.addListener(async alarm => {
    if (alarm.name === 'reporting:tick' || alarm.name === 'reporting:periodic') {
      await maybeStartByPolicy('alarm');
    }
  });

  try {
    chrome.idle.setDetectionInterval(60);
    chrome.idle.onStateChanged.addListener(async newState => {
      if (newState === 'idle' || newState === 'locked') await maybeStartByPolicy('idle');
    });
  } catch {}

  chrome.runtime.onStartup?.addListener(async () => {
    const cfg = await getReporting();
    await ensurePeriodicAlarm(cfg.schedule_minutes);
  });
  chrome.runtime.onInstalled?.addListener(async () => {
    const cfg = await getReporting();
    await ensurePeriodicAlarm(cfg.schedule_minutes);
  });

  
  function exposeRPC() {
    try {
      if (!self.ue) self.ue = {};
      self.ue['reports::getState'] = async () => ({ config: await getReporting(), state: await getState() });
      self.ue['reports::update'] = async ([patch]) => {
        const cfg = await setReporting(patch || {});
        if (patch && ('enabled' in patch || 'schedule_minutes' in patch)) await ensurePeriodicAlarm(cfg.schedule_minutes);
        return cfg;
      };
      self.ue['reports::sendNow'] = async () => {
        try {
          const res = await startUpload('manual');
          return res;
        } catch (e) {
          console.error('[reports::sendNow] errored!', e);
          await setState({ last_error_ts: Date.now(), last_error_reason: String(e) });
          return { error: String(e) };
        }
      };
    } catch (e) { console.error('[uploader] exposeRPC failed', e); }
  }
  exposeRPC();

  
  setInterval(async () => {
    try {
      const st = await getState();
      if (!st.uploading) __uploadLock = false;
      await setState({ uploading: false });
    } catch {}
  }, 30_000);

  self.__reports__ = { startUpload, getReporting, setReporting };
})();

