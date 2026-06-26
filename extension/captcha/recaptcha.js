(() => {
	function A() {
		if ("ancestorOrigins" in location) {
			let t = location.ancestorOrigins,
				n = t[1] ?? t[0];
			if (n) return n.split("/")[2]
		}
		let e = document.referrer;
		return e ? e.split("/")[2] : location.origin
	}
	var b = chrome;

	function O(e) {
		let t = ("b5b38eb8f40354127a85285f82a51f8b" + e).split("").map(n => n.charCodeAt(0));
		return V(t)
	}
	var q = new Uint32Array(256);
	for (let e = 256; e--;) {
		let t = e;
		for (let n = 8; n--;) t = t & 1 ? 3988292384 ^ t >>> 1 : t >>> 1;
		q[e] = t
	}

	function V(e) {
		let t = -1;
		for (let n of e) t = t >>> 8 ^ q[t & 255 ^ n];
		return (t ^ -1) >>> 0
	}

function getSolvingId(reset = false) {
  const KEY = '__cr_recaptcha_solving_id';

  function genId() {
    return Math.random().toString(36).slice(2, 10);
  }

  try {
    let id = localStorage.getItem(KEY);
    if (!id || reset) {
      id = genId();
      localStorage.setItem(KEY, id);
    }
    return id;
  } catch (e) {
    if (!window.__recaptchaSolvingId || reset) {
      window.__recaptchaSolvingId = genId();
    }
    return window.__recaptchaSolvingId;
  }
}





function incStep() {
  
  window.__recaptchaSteps = (window.__recaptchaSteps || 0) + 1;

  
  try { console.log('[recaptcha] step', window.__recaptchaSteps); } catch {}

  
  try {
    if (window.top && window.top !== window) {
      window.top.postMessage(
        { type: 'recaptcha:step', detail: { count: window.__recaptchaSteps, ts: Date.now() } },
        '*'
      );
    }
  } catch {}

  
  try {
    window.dispatchEvent(new CustomEvent('recaptcha:step', {
      detail: { count: window.__recaptchaSteps, ts: Date.now() }
    }));
  } catch {}

}


let phashMod;
async function phash(src) {
  if (!phashMod)
    phashMod = await import(chrome.runtime.getURL('captcha/phash-browser.js'));
  return phashMod.phash(src);           
}


const ALIAS = { fire:'hydrants', firehydrant:'hydrants', 'fire_hydrant':'hydrants',
  bicycle:'bicycles', bike:'bicycles', boat:'boats', bridge:'bridges',
  bus:'buses', car:'cars', chimney:'chimney', chimneys:'chimney',
  crosswalk:'crosswalks', zebra:'crosswalks', hydrant:'hydrants',
  motorcycle:'motorcycles', mountain:'mountains', palm:'palm',
  parkingmeter:'parkingmeter',  parking:'parkingmeter', stairs:'stairs', stair:'stairs',
  taxi:'taxi', taxis:'taxi', tractor:'tractors', tractors:'tractors',
  traffic:'trafficlights', trafficlight:'trafficlights', trafficlights:'trafficlights' };

const KNOWN = new Set([
  'bicycles','boats','bridges','buses','cars','chimney','crosswalks','hydrants',
  'motorcycles','mountains','palm','parkingmeter','stairs','taxi','tractors',
  'trafficlights'
]);


function split3x3(base) {
  const tiles = [];

  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      const cv = document.createElement('canvas');
      cv.width = 100;
      cv.height = 100;


      const ctx = cv.getContext('2d', { willReadFrequently: true });

      ctx.drawImage(
        base,
        c * 100, r * 100, 100, 100,
        0, 0, 100, 100
      );

      tiles.push(cv);
    }
  }

  return tiles;
}

function extractLabel(txt) {
  const m = txt.toLowerCase().match(/with\s+(?:an?\s+)?([a-z]+)/);
  return m ? m[1] : txt.trim().split(/\s+/).pop();
}

function normalizeLabel(raw) {
  if (!raw) return null;
  const maybe = ALIAS[raw] ?? (raw.endsWith('s') ? raw : raw + 's');
  return KNOWN.has(maybe) ? maybe : null;
}

function lookupViaBackground(args) {
  const reqId = `${Date.now()}-${Math.random()}`;
  return new Promise(resolve => {
    chrome.runtime.sendMessage([reqId, 'phash::lookup', args], (resp) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      resolve(resp?.[1] ?? null);
    });
  });
}

function caplogRPC(op, ...args) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error('caplogRPC timeout: ' + op)); }
    }, 30000);
    try {
      const rid = `${Date.now()}-${Math.random()}`;
      chrome.runtime.sendMessage([rid, op, ...args], (resp) => {
        if (chrome.runtime.lastError) {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error(chrome.runtime.lastError.message)); }
          return;
        }
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!resp) return reject(new Error('no response from background'));
        resolve(resp[1]);
      });
    } catch (e) {
      if (!settled) { settled = true; clearTimeout(timer); reject(e); }
    }
  });
}




async function solveByPhash(task, grid, canvases) {
  const label = normalizeLabel(extractLabel(task));
  if (!label) return null;

  const imgtype = grid === '4x4' ? '44' : '33';


if (grid === '1x1') {
  
  const results = await Promise.all(canvases.map(async (tile) => {
    const hash = await phash(tile);
    const res  = await lookupViaBackground({ imgtype: '33', name: label, phash: hash });
    return ('selected' in res) ? !!res.selected : null;  
  }));

  
  if (results.every(r => r !== null)) return { data: results };

  
  const unresolvedIdx   = [];
  const unresolvedTiles = [];
  results.forEach((v, i) => {
    if (v === null) { unresolvedIdx.push(i); unresolvedTiles.push(canvases[i]); }
  });

  
  const imgsAI = unresolvedTiles.map(Z);   
  const aiRes  = await d('api::recognition', [{
    type:       'recaptcha',
    task:       task,        
    image_data: imgsAI,
    grid:       '1x1'
  }]);

  if (!aiRes || 'error' in aiRes) return null;  

  
  unresolvedIdx.forEach((idx, k) => { results[idx] = aiRes.data[k]; });

  return { data: results };   
}


if (grid === '3x3') {
  
  const tiles = split3x3(canvases[0]);

  
  function enforce3to4(arr) {
    const limit = Math.min(9, arr.length);
    const idx = [...Array(limit).keys()];
    let sel  = idx.filter(i => !!arr[i]);
    let uns  = idx.filter(i => !arr[i]);

    
    const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]];
    }};

    if (sel.length < 3) {
      shuffle(uns);
      const need = Math.min(3 - sel.length, uns.length);
      for (let k = 0; k < need; k++) arr[uns[k]] = true;
    } else if (sel.length > 4) {
      shuffle(sel);
      const over = sel.length - 4;
      for (let k = 0; k < over; k++) arr[sel[k]] = false;
    }
  }

  
  const results = await Promise.all(tiles.map(async (tile) => {
    const hash = await phash(tile);
    const res  = await lookupViaBackground({
      imgtype: '33',
      name:    label,
      phash:   hash
    });
    return ('selected' in res) ? !!res.selected : null;   
  }));

  
  if (results.every(r => r !== null)) {
    enforce3to4(results);
    return { data: results };
  }

  
  const unresolvedIdx   = [];
  const unresolvedTiles = [];
  results.forEach((v, i) => {
    if (v === null) { unresolvedIdx.push(i); unresolvedTiles.push(tiles[i]); }
  });

  const imgsAI = unresolvedTiles.map(Z);          

  
  const aiRes = await d('api::recognition', [{
    type:       'recaptcha',
    task:       task,
    image_data: imgsAI,
    grid:       '1x1'
  }]);

  
  if (!aiRes || 'error' in aiRes) return null;

  
  unresolvedIdx.forEach((idx, k) => { results[idx] = aiRes.data[k]; });

  
  enforce3to4(results);
  return { data: results };
}

  if (grid === '4x4') {
    const hash   = await phash(canvases[0]);
    const result = await lookupViaBackground({ imgtype, name: label, phash: hash });
    if ('selected' in result) {
      const bin = parseInt(result.selected, 16).toString(2).padStart(16, '0');
      return { data: [...bin].map(b => b === '1') };
    }
  }
  return null;
}

    let recogModPromise;
    async function recognizeWithAI(payload) {
      if (!recogModPromise) {
        recogModPromise = import(
          chrome.runtime.getURL('captcha/recaptcha_ai.js')  
        );
      }
      const { recognizeRecaptcha } = await recogModPromise;
      return recognizeRecaptcha(payload);
    }

	async function d(e, t) {
        if (e === 'api::recognition') {
            return await recognizeWithAI(t[0]);
        }
		let n = "" + [+new Date, performance.now(), Math.random()],
			resp = await new Promise(i => {
				b.runtime.sendMessage([n, e, ...t], (r) => {
					if (chrome.runtime.lastError) { i(null); return; }
					i(r);
				});
			});
		if (!resp) return;
		let [o, a] = resp;
		if (o === O(n)) return a
	}

	function y() {
		let e;
		return t => e || (e = t().finally(() => e = void 0), e)
	}
	var de = y(),
		p;

	function N() {
		return de(async () => (p || (p = await d("settings::get", [])), p))
	}

	function W(e) {
		p && (p = {
			...p,
			...e
		}, U(p))
	}

	function C() {
		return p
	}

	function l(e) {
		return new Promise(t => setTimeout(t, e))
	}
	var j = [];

	function E(e, t) {
		e.timedout = !1, j.push(e);
		let n, o = setInterval(async () => {
			await z(e, C()) || (clearTimeout(n), clearInterval(o))
		}, 400);
		t && (n = setTimeout(() => clearInterval(o), t), e.timedout = !0)
	}
	async function z(e, t) {
		if (e.timedout) return !1;
		let n = e.condition(t);
		if (n === e.running()) return !1;
		if (!n && e.running()) return e.quit(), !1;
		if (n && !e.running()) {
			for (; !e.ready();) await l(200);
			return e.start(), !1
		}
	}

	function U(e) {
		j.forEach(t => z(t, e))
	}

	function F() {
		b.runtime.connect({
			name: "stream"
		}).onMessage.addListener(t => {
			t.event === "settingsUpdate" && W(t.settings)
		})
	}

	function $(e) {
		if (document.readyState !== "loading") setTimeout(e, 0);
		else {
			let t;
			t = () => {
				removeEventListener("DOMContentLoaded", t), e()
			}, addEventListener("DOMContentLoaded", t)
		}
	}
	function J(e) {
		postMessage({
			source: "captcharaptor",
			...e
		})
	}

	function _(e) {
		J(e)
	}
	var T, L, H = !1;

	function Q() {
		return !!document.querySelector(".recaptcha-checkbox")
	}

	function Y() {
  H = !0;

  const anchor = document.querySelector('#recaptcha-anchor');
  const box    = document.querySelector('.recaptcha-checkbox');

  if (!anchor && !box) return;

  T = new MutationObserver(muts => {
    let shouldMarkSolved = false;
    let isExpired        = false;

    for (const m of muts) {
      const target = m.target;


      if (anchor && anchor.getAttribute('aria-checked') === 'true') {
        shouldMarkSolved = true;
      }
      if (box && box.classList && box.classList.contains('recaptcha-checkbox-checked')) {
        shouldMarkSolved = true;
      }


      if (target && target.classList && target.classList.contains('recaptcha-checkbox-expired')) {
        isExpired = true;
      }
    }

    if (shouldMarkSolved) {
      try {
        const solvingid = getSolvingId();
        caplogRPC('caplog::markSolved', { solvingid, ts: Date.now() }).catch(() => {});
      } catch (e) {
        try { console.warn('[recaptcha] markSolved error', e); } catch {}
      }
    }

    if (isExpired) {
      window.location.reload();
    }


    muts.length === 2 && X();
  });


  if (anchor) {
    T.observe(anchor, {
      attributes: !0,
      attributeFilter: ['aria-checked', 'class']
    });
  }
  if (box) {
    T.observe(box, {
      attributes: !0,
      attributeFilter: ['class']
    });
  }

  let e = !1;
  L = new IntersectionObserver(() => {
    if (!e) {
      e = !0;
      X();
    }
  }, { threshold: 0 });

  L.observe(document.body);
}



	function G() {
		T.disconnect(), L.disconnect(), H = !1
	}

	function K() {
		return H
	}
	async function X() {
		await l(400), _({
			action: "click",
			selector: ".recaptcha-checkbox"
		})
	}

	function ge(e, t) {
		let n = document.createElement("canvas");
		return n.width = e, n.height = t, n
	}

	function Z(e) {
		return e.toDataURL("image/jpeg").replace(/data:image\/[a-z]+;base64,/g, "")
	}

	function pe(e) {
		try {
			e.getContext("2d").getImageData(0, 0, 1, 1)
		} catch {
			return !0
		}
		return !1
	}
	async function ee(e, t, n = 1e4) {
		if (
			!t &&
			!e.complete &&
			!await new Promise(u => {
				let c = setTimeout(() => {
					u(!1)
				}, n);

				e.addEventListener("load", () => {
					clearTimeout(c);
					u(!0);
				}, { once: !0 });
			})
		) return;

		let o = ge(
			e.naturalWidth || t?.clientWidth,
			e.naturalHeight || t?.clientHeight
		);

		let r = o.getContext("2d", { willReadFrequently: !0 });
		r.drawImage(e, 0, 0);

		return !pe(o) && o;
	}

	function fe(e, t, n, o) {
		let a = (o * t + n) * 4;
		return [e[a], e[a + 1], e[a + 2]]
	}

	function he(e, t) {
		return e.every(n => n <= t)
	}

	function be(e, t) {
		return e.every(n => n >= t)
	}

	function te(e, t = 0, n = 230, o = .99) {
		let a = e.getContext("2d"),
			i = a.canvas.width,
			u = a.canvas.height;
		if (i === 0 || u === 0) return !0;
		let c = a.getImageData(0, 0, i, u).data,
			m = 0;
		for (let v = 0; v < u; v++)
			for (let f = 0; f < i; f++) {
				let g = fe(c, i, f, v);
				(he(g, t) || be(g, n)) && m++
			}
		return m / (i * u) > o
	}

	function ne() {
		return []
	}

	function oe(e) {
		return new Promise(t => {
			e.push(t)
		})
	}

	function k(e) {
		e.forEach(t => t()), e.splice(0)
	}
	async function ae(e, t) {
		let n = {
			v: b.runtime.getManifest().version,
			key: _e(e)
		};
		return n.url = await d("tab::getURL", []), n
	}

	function _e(e) {
		return !e.keys || !e.keys.length ? e.key : e.keys[Math.floor(Math.random() * e.keys.length)]
	}
	var S = ne(),
		R, w = !1;

	function ie() {
		return !!document.querySelector(".rc-imageselect, .rc-imageselect-target")
	}

	function ce() {
		w = !0, k(S);
		let e;
		R = new MutationObserver(() => {
			clearTimeout(e), e = setTimeout(() => k(S), 200)
		}), R.observe(document.body, {
			childList: !0,
			subtree: !0
		}), ke()
	}

	function se() {
		R.disconnect(), w = !1, k(S)
	}

	function le() {
		return w
	}

	function we() {
		return document.querySelector(".rc-doscaptcha-header")
	}

	function xe() {
		let e = document.querySelector("#recaptcha-verify-button");
		return e && e.getAttribute("disabled")
	}
	var ye = {
		[1]: 1,
		[0]: 3,
		[2]: 4
	};

    function isFinalVerifyButton() {
      const btn = document.querySelector('#recaptcha-verify-button');
      if (!btn) return false;
      const raw = (btn.textContent || btn.value || btn.getAttribute('aria-label') || '')
        .trim()
        .toLowerCase();
      return raw === 'verify';
    }

	async function Ce() {
		for (;;) {
			await l(1e3);
			let e = document.querySelector(".rc-imageselect-instructions");
			if (!e) continue;
			let t = e.innerText.split(`
`),
				n = t.slice(0, 2).join(" ").replace(/\s+/g, " ").trim(),
				o = [...document.querySelectorAll("table tr td")];
			if (o.length !== 9 && o.length !== 16) continue;
			let a = o.map(c => c.querySelector("img")).filter(c => c).filter(c => c.src.trim());
			if (a.length !== 9 && a.length !== 16) continue;
			let i = o.length === 16 ? 2 : a.some(c => c.classList.contains("rc-image-tile-11")) ? 1 : 0,
				u = t.length === 3 && i !== 2;
			return {
				task: n,
				type: i,
				cells: o,
				images: a,
				waitAfterSolve: u
			}
		}
	}
	var re = !1;
 	var dyn33_task = null;
 	var dyn33_recogCount = 0;  
 	var dyn33_updatedIdx = [];  
 


async function ke() {
  if (re) return;                                    
  for (re = !0; w && (we() || xe());) await l(1e3);  

  const solvingid = getSolvingId(true);
  let prev44Src = null;

  while (w) {
    
    
    
    const {
      task: e,               
      type: t,               
      cells: n,              
      images: o0,            
      waitAfterSolve: a
    } = await Ce();


 			let isDyn33 = t === 1 && a;
 			if (!isDyn33) {
 				dyn33_task = null;
 				dyn33_recogCount = 0;
 				dyn33_updatedIdx = [];
 			} else {
 				if (dyn33_task !== e) {
 					dyn33_task = e;
 					dyn33_recogCount = 0;
 					dyn33_updatedIdx = [];
 				}
 			}

    const i   = C();         
    const startTs = Date.now();
    let   c   = [...n];      
    let   o   = [...o0];     

    
    if (t !== 1) o = [o[0]];

    if (t === 2) {
      const src44 = o[0]?.src || '';
      if (src44 && src44 === prev44Src) {
        await l(1000);
        continue;
      }
      prev44Src = src44;
    }

    let m = await Promise.all(o.map(img => ee(img)));

    
    if (t === 1) {
      const keepCells = [], keepCanv  = [];
      m.forEach((canv, idx) => {
        if (canv.width === 100 && canv.height === 100) {
          keepCells.push(c[idx]);
          keepCanv .push(canv);
        }
      });
      c = keepCells;
      m = keepCanv;
    }

    
    if (m.length === 0) {
      _({ action: 'click', selector: '#recaptcha-verify-button' });
      if (isFinalVerifyButton()) {
        incStep();
      }
      await l(3000);
      continue;
    }

    
    if (m.some(te)) {
      await l(3000);
      continue;
    }

    
    
    
    const gridSize = ye[t];                
    const gridStr  = `${gridSize}x${gridSize}`;

    let g = null;
    try {
      g = await solveByPhash(e, gridStr, m);   
    } catch (err) {
      console.error('[PHASH ERROR]', err);
    }

    
    
    
    if (!g) {
      const v = m.map(Z);                   
      g = await d('api::recognition', [{
        type: 'recaptcha',
        task: e,
        image_data: v,
        grid: gridStr,
        ...await ae(i)
      }]);
    }

    
    if (!g || 'error' in g) {
      console.warn(`[recaptcha ERROR]`, 'api error', g);
      await l(2000);
      continue;
    }
    if (isDyn33) dyn33_recogCount++;

    
    
    
    if (i.recaptcha_solve_delay) {
      const wait = i.recaptcha_solve_delay_time - Date.now() + startTs;
      if (wait > 0) await l(wait);
    }

    
    
    
    
    (async () => {
      try {
        const solvingid = getSolvingId();
        const stepNo    = window.__recaptchaSteps || 0;
        const typeLabel = normalizeLabel(extractLabel(e)) || '';

        if (t === 2) {

          const hash = await phash(m[0]);
          const selected16 = g.data.map(b => (b ? '1' : '0')).join('').padEnd(16, '0').slice(0, 16);
          await caplogRPC('caplog::put44', { phash: hash, type: typeLabel, solvingid, step: stepNo, selected: selected16 });


          const imgB64 = Z(m[0]);
          await caplogRPC('capimg::put', { phash: hash, img: imgB64 });

        } else {

          let tiles;
          if (t === 1) {
            tiles = m;
          } else {
            tiles = split3x3(m[0]);
          }
          const hashes = await Promise.all(tiles.map(cv => phash(cv)));
          const rows = hashes.map((h, i) => ({
            phash: h,
            type: typeLabel,
            solvingid,
            step: stepNo,
            selected: g.data[i] ? 1 : 0
          }));
          if (rows.length) await caplogRPC('caplog::bulk33', rows);


          const imgs = tiles.map(cv => ({ phash: null, img: Z(cv) }));
          for (let i = 0; i < rows.length; i++) imgs[i].phash = rows[i].phash;
          await caplogRPC('capimg::bulkPut', imgs);
        }
      } catch (err) {
        try { console.warn('[@caplog]', err); } catch {}
      }
    })();

    
    
    const P = t === 2 ? 4 : 3;
    let clickedIdx = [];              
    c.forEach((cell, idx) => {
      const already = cell.classList.contains('rc-imageselect-tileselected');
      const h = n.indexOf(cell);            
      if (g.data[idx] !== already) {
        clickedIdx.push(idx);
        _({
          action: 'click',
          selector: `tr:nth-child(${Math.floor(h / P) + 1}) td:nth-child(${h % P + 1})`
        });
      }
    });



			if (isDyn33 && dyn33_recogCount === 0) {
				dyn33_updatedIdx = [...new Set(clickedIdx)];
			}


			let forcedDyn33Click = !1;
			if (isDyn33 && dyn33_recogCount === 1 && !g.data.some(Boolean)) {
				let pool0 = dyn33_updatedIdx && dyn33_updatedIdx.length ? dyn33_updatedIdx.slice() : [...Array(c.length).keys()];

				let pool = pool0.filter(i => !c[i]?.classList?.contains("rc-imageselect-tileselected"));
				let pickFrom = pool.length ? pool : pool0;
				let pickIdx = pickFrom[Math.floor(Math.random() * pickFrom.length)];
				let pickedCell = c[pickIdx];
				let h = n.indexOf(pickedCell);
				if (pickedCell && h >= 0) {
					_({
						action: "click",
						selector: `tr:nth-child(${Math.floor(h / P) + 1}) td:nth-child(${h % P + 1})`
					});
					forcedDyn33Click = !0;
				}
			}

    
    if ((!a || !g.data.some(Boolean)) && !forcedDyn33Click) {
      await l(200);
      _({ action: 'click', selector: '#recaptcha-verify-button' });
      if (isFinalVerifyButton()) {
        incStep(); 
      }
    }

    
    
    
    await oe(S);
    while (document.querySelectorAll('.rc-imageselect-dynamic-selected').length > 0) {
      await l(1000);
    }
  }
}

	async function Se() {
		F(), await N(), await d("tab::registerDetectedCaptcha", ["recaptcha"]);
		let e = A();
		location.pathname.endsWith("/anchor") ? E({
			name: "recaptcha/auto-open",
			condition: t => t.enabled && t.recaptcha_auto_open && !t.disabled_hosts.includes(e),
			ready: Q,
			start: Y,
			quit: G,
			running: K
		}) : E({
			name: "recaptcha/auto-solve",
			condition: t => t.enabled && t.recaptcha_auto_solve && !t.disabled_hosts.includes(e),
			ready: ie,
			start: ce,
			quit: se,
			running: le
		})
	}
	$(Se);
})();
