importScripts(chrome.runtime.getURL('background_sqlite.js'));
    var i = chrome;
    var te = "en",
        re = "en";
    {
        let e = function(t, r, o, n) {
            return {
                id: n,
                priority: 1,
                action: {
                    type: "redirect",
                    redirect: {
                        transform: {
                            queryTransform: {
                                addOrReplaceParams: [{
                                    key: t,
                                    value: r
                                }]
                            }
                        }
                    }
                },
                condition: {
                    regexFilter: o,
                    resourceTypes: ["sub_frame"]
                }
            }
        };
        i.declarativeNetRequest.updateDynamicRules({
            addRules: [e("hl", te, "^https?://[^\\.]*\\.(google\\.com|recaptcha\\.net)/recaptcha", 1)],
            removeRuleIds: [1]
        })
    }
    var p = new Map;
    chrome.tabs.onUpdated.addListener((e, t) => {
        p.has(e) && !("url" in t) || p.set(e, new Set)
    });
    chrome.tabs.onRemoved.addListener(e => {
        p.delete(e)
    });
    



    async function U([e], t) {
        let r = t.tab?.id;
        if (!r) return console.warn("[TABS ERROR] unable to figure out tabId");
        p.has(r) || p.set(r, new Set), p.get(r).add(e)
    }
    async function q() {
        let e = await new Promise(t => {
            i.tabs.query({
                active: !0,
                currentWindow: !0
            }, ([r]) => {
                t(r)
            })
        });
        return p.has(e.id) ? [...p.get(e.id)] : []
    }
    var y = {
        version: 18,
        key: "",
        keys: [],
        enabled: !0,
        disabled_hosts: [],
        recaptcha_auto_open: !0,
        recaptcha_auto_solve: !0,
        recaptcha_solve_delay_time: 2e3,
        recaptcha_solve_delay: !0,
    };
    var v = i.action,
        R = !0;

    function P(e) {
        if (e === R) return;
        R = e;
        let t = e ? "" : "g",
            r = [new Promise(o => {
                v.setIcon({
                    path: Object.fromEntries([16, 32, 48, 128].map(n => [n, `/icon/${n}${t}.png`]))
                }, o)
            })];
        return w && r.push(new Promise(o => {
            v.setBadgeText({
                text: e ? w : ""
            }, o)
        })), Promise.all(r)
    }
    var w = "";

    function k(e, t) {
        if (e !== w) return w = e, Promise.all([new Promise(r => {
            if (!R) return r();
            v.setBadgeText({
                text: e
            }, r)
        }), new Promise(r => {
            v.setBadgeBackgroundColor({
                color: t
            }, r)
        })])
    }

    function N(e, t) {
        return t.tab.url
    }

    function B() {
        return new Promise(e => {
            i.tabs.query({
                active: !0,
                currentWindow: !0
            }, ([t]) => e(t))
        })
    }
    async function m() {
        return (await B()).id
    }
    async function J() {
        let e = await B();
        return e && e.url && new URL(e.url).href
    }
    async function M() {
        let e = await B();
        return JSON.stringify(e)
    }
    var I = new Set,
        A = new Set;
    i.runtime.onConnect.addListener(e => {
        e.name === "stream" ? (I.add(e), e.onDisconnect.addListener(() => {
            I.delete(e)
        })) : e.name === "broadcast" && (A.add(e), e.onDisconnect.addListener(() => {
            A.delete(e)
        }))
    });

    function O(e) {
        I.forEach(t => t.postMessage(e))
    }
    async function F(e) {
        let t = await m();
        e = {
            data: e,
            event: "broadcast"
        }, A.forEach(r => {
            r.sender?.tab?.id !== void 0 && t === r.sender?.tab?.id && r.postMessage(e)
        })
    }
    var L = new Promise(e => {
        i.storage.local.get("settings", t => {
            if (!t?.settings) return e(y);
            let {
                settings: r
            } = t;
            r.version !== y.version && (r = {
                ...y,
                key: r.key
            }), r.enabled || P(!1), e(r)
        })
    });

    function f() {
        return L
    }
    async function E(e) {
        let t = {
            ...await L,
            ...e
        };
        return P(t.enabled), new Promise(r => {
            i.storage.local.set({
                settings: t
            }, () => {
                L = Promise.resolve(t), O({
                    event: "settingsUpdate",
                    settings: e
                }), r(null)
            })
        })
    }

    function V() {
        let e;
        return t => e || (e = t().finally(() => e = void 0), e)
    }
    var W, oe = V();

    function T() {
        return oe(() => se())
    }
    async function G() {
        return W
    }
        function h(e) {
        return new Promise(t => setTimeout(t, e))
    }

    function $(e, t = 2166136261) {
        let r = t;
        for (let o of e) r ^= o, r += r << 1;
        return r >>> 0
    }
    async function z([e, t]) {
        let r = await fetch(e, t);
        return {
            headers: Object.fromEntries(r.headers.entries()),
            status: r.status,
            ok: r.ok,
            text: await r.text()
        }
    }
    async function Q([e, t]) {
        let r = await fetch(e, t),
            o = await r.blob(),
            n = new FileReader;
        return await new Promise(a => {
            n.addEventListener("load", a), n.readAsDataURL(o)
        }), {
            headers: Object.fromEntries(r.headers.entries()),
            status: r.status,
            ok: r.ok,
            data: n.result
        }
    }

    function D(e) {
        let t = ("b5b38eb8f40354127a85285f82a51f8b" + e).split("").map(r => r.charCodeAt(0));
        return Z(t)
    }
    var Y = new Uint32Array(256);
    for (let e = 256; e--;) {
        let t = e;
        for (let r = 8; r--;) t = t & 1 ? 3988292384 ^ t >>> 1 : t >>> 1;
        Y[e] = t
    }

    function Z(e) {
        let t = -1;
        for (let r of e) t = t >>> 8 ^ Y[t & 255 ^ r];
        return (t ^ -1) >>> 0
    }


    var ue = {
        "phash::lookup": ([p]) => self.queryPhash(p),
        "settings::get": f,
        "settings::update": ([e]) => E(e),
        "tab::getURL": N,
        "tab::registerDetectedCaptcha": U
    };
    i.runtime.onMessage.addListener((e, t, r) => {
        if (!Array.isArray(e)) return;
        let o = e[1],
            n = ue[o];
        if (typeof n !== 'function') return;
        return Promise.resolve(n(e.slice(2), t)).then(a => {
            r([D(e[0]), a]); void chrome.runtime.lastError;
        }).catch(a => {
            console.error(`[RPC Error] [${o}] errored!`, e.slice(2), a);
            r([D(e[0]), "" + a]); void chrome.runtime.lastError;
        }), !0
    });





(function(){
  const CAPLOG_DB_NAME = 'caplog';
  const CAPLOG_DB_VERSION = 4; 
  const CAPIMG_MAX_ROWS = 100000;
  let __caplogDBPromise;
  const __manifestVersion = chrome.runtime.getManifest().version;



  function openCaplogDB(){
    if (__caplogDBPromise) return __caplogDBPromise;
    __caplogDBPromise = new Promise((resolve, reject) => {
      try {
        const req = indexedDB.open(CAPLOG_DB_NAME, CAPLOG_DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;

          
          if (!db.objectStoreNames.contains('cap33plagin')) {
            const s = db.createObjectStore('cap33plagin', { keyPath: 'id', autoIncrement: true });
            try { s.createIndex('solvingid','solvingid',{unique:false}); } catch(e){}
            try { s.createIndex('type','type',{unique:false}); } catch(e){}
          }
          
          if (!db.objectStoreNames.contains('cap44plagin')) {
            const s2 = db.createObjectStore('cap44plagin', { keyPath: 'id', autoIncrement: true });
            try { s2.createIndex('solvingid','solvingid',{unique:false}); } catch(e){}
            try { s2.createIndex('type','type',{unique:false}); } catch(e){}
          }
          
          if (!db.objectStoreNames.contains('capimg')) {
            const s3 = db.createObjectStore('capimg', { keyPath: 'id', autoIncrement: true });
            
            try { s3.createIndex('phash','phash',{unique:true}); } catch(e){}
            
            try { s3.createIndex('ts','ts',{unique:false}); } catch(e){}
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('caplog indexedDB open failed'));
      } catch(err){
        reject(err);
      }
    });
    return __caplogDBPromise;
  }

  function withMeta(row) {
    if (!row || typeof row !== 'object') return row;
    const out = { ...row };
    if (!('version' in out)) out.version = __manifestVersion;
    if (!('ts' in out)) out.ts = Date.now();
    return out;
  }

  async function caplogBulkPut(store, rows){
    const db = await openCaplogDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('caplog tx error'));
      const os = tx.objectStore(store);
      for (const row of (rows || []).map(withMeta)) {
        try { os.add(row); } catch(e){  }
      }
    });
  }

  async function caplogPut(store, row){
    return caplogBulkPut(store, [row]);
  }

  async function caplogGetAll(store){
    const db = await openCaplogDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readonly');
      const os = tx.objectStore(store);
      const req = os.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error || new Error('caplog getAll error'));
    });
  }


  async function caplogMarkSolved({ solvingid, ts }) {
    if (!solvingid) return false;

    const db = await openCaplogDB();
    return new Promise((resolve, reject) => {
      try {
        const tx = db.transaction(['cap33plagin', 'cap44plagin'], 'readwrite');
        tx.oncomplete = () => resolve(true);
        tx.onerror    = () => reject(tx.error || new Error('caplog markSolved tx error'));

        const updateStore = (storeName) => {
          const os  = tx.objectStore(storeName);
          const req = os.openCursor();

          req.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;

            const val = cursor.value || {};
            if (val.solvingid === solvingid) {
              val.tokenOk = true;
              val.tokenTs = ts || Date.now();
              cursor.update(val);
            }
            cursor.continue();
          };
        };

        updateStore('cap33plagin');
        updateStore('cap44plagin');
      } catch (err) {
        reject(err);
      }
    });
  }

  
  async function capimgPut({ phash, img, ts }) {
    if (!phash || !img) return false;
    const db = await openCaplogDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('capimg', 'readwrite');
      const os = tx.objectStore('capimg');
      const byPhash = os.index('phash');

      
      const q = byPhash.get(phash);
      q.onsuccess = () => {
        if (q.result) { 
          resolve(true);
          tx.abort();   
          return;
        }
        
        const row = { phash, img, ts: ts || Date.now() };
        os.add(row);

        tx.oncomplete = async () => {
          try {
            await capimgEnforceLimit(db);
            resolve(true);
          } catch (e) {
            resolve(true); 
          }
        };
        tx.onerror = () => reject(tx.error || new Error('capimg put tx error'));
      };
      q.onerror = () => reject(q.error || new Error('capimg phash lookup error'));
    });
  }

  async function capimgBulkPut(rows) {
    
    for (const r of (rows || [])) {
      try { await capimgPut(r); } catch(e) {}
    }
    return true;
  }

  async function capimgCount(db){
    return new Promise((resolve, reject) => {
      const tx = db.transaction('capimg','readonly');
      const os = tx.objectStore('capimg');
      const req = os.count();
      req.onsuccess = () => resolve(req.result || 0);
      req.onerror   = () => reject(req.error || new Error('capimg count error'));
    });
  }

  async function capimgEnforceLimit(db){
    const total = await capimgCount(db);
    if (total <= CAPIMG_MAX_ROWS) return true;

    return new Promise((resolve, reject) => {
      const toDelete = total - CAPIMG_MAX_ROWS;
      if (toDelete <= 0) return resolve(true);

      
      const tx = db.transaction('capimg','readwrite');
      const os = tx.objectStore('capimg');
      const cursorReq = os.openCursor(); 
      let removed = 0;

      cursorReq.onsuccess = (ev) => {
        const cursor = ev.target.result;
        if (!cursor || removed >= toDelete) return;
        cursor.delete();
        removed++;
        cursor.continue();
      };
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => reject(tx.error || new Error('capimg prune tx error'));
    });
  }

  
  ue['caplog::put33']   = ([row])       => caplogPut('cap33plagin', row);
  ue['caplog::bulk33']  = ([rows])      => caplogBulkPut('cap33plagin', rows);
  ue['caplog::put44']   = ([row])       => caplogPut('cap44plagin', row);
  ue['caplog::bulk44']  = ([rows])      => caplogBulkPut('cap44plagin', rows);
  ue['caplog::getAll']  = ([store])     => caplogGetAll(store);
  ue['caplog::markSolved'] = ([payload]) => caplogMarkSolved(payload);
  ue['caplog::clear']   = ([store])     => (async () => {
    const db = await openCaplogDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error || new Error('caplog clear error'));
      tx.objectStore(store).clear();
    });
  })();

  
  ue['capimg::put']      = ([row])  => capimgPut(row);
  ue['capimg::bulkPut']  = ([rows]) => capimgBulkPut(rows);
})();


function generateSimpleKey(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += chars[Math.floor(Math.random() * chars.length)];
  }
  return out;
}


chrome.runtime.onStartup.addListener(initReportingKey);
chrome.runtime.onInstalled.addListener(initReportingKey);

async function initReportingKey() {
  const data = await chrome.storage.local.get('reporting');
  let reporting = data.reporting || {};
  if (!reporting.key || !/^[a-z0-9]{16}([a-z0-9]{16})?$/.test(reporting.key)) {
    reporting.key = generateSimpleKey();
    await chrome.storage.local.set({ reporting });
    console.log('[Reporting] Key generated:', reporting.key);
  }
}

initReportingKey();

importScripts(chrome.runtime.getURL('uploader.js'));
importScripts(chrome.runtime.getURL('ws/background_ws.js'));
