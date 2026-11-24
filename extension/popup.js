
const $  = id  => document.getElementById(id);
const qq = sel => document.querySelector(sel);


function show(page){
  $('page_main').classList.toggle('hidden', page !== 'main');
  $('page_reports').classList.toggle('hidden', page !== 'reports');
  $('page_timeouts').classList.toggle('hidden', page !== 'timeouts');
}
$('open_reports').addEventListener('click', () => show('reports'));
$('open_timeouts').addEventListener('click', () => show('timeouts'));
$('back_main').addEventListener('click',  () => show('main'));
$('back_main_t').addEventListener('click', () => show('main'));


const defaults = {
  enabled:true, autoclick:true, images:true,
  click_delay:300, reveal_delay:850, verify_delay:850
};

chrome.storage.local.get('settings').then(({ settings = {} }) => {
  const ui = { ...defaults };
  ui.enabled      = settings.enabled ?? defaults.enabled;
  ui.autoclick    = settings.recaptcha_auto_open  ?? defaults.autoclick;
  ui.images       = settings.recaptcha_auto_solve ?? defaults.images;
  ui.click_delay  = settings.recaptcha_delay_between_clicks ?? defaults.click_delay;
  ui.reveal_delay = settings.recaptcha_delay_dynamic_reveal ?? defaults.reveal_delay;
  ui.verify_delay = settings.recaptcha_delay_before_verify  ?? defaults.verify_delay;

  $('enabled' ).checked = ui.enabled;
  $('autoclick').checked = ui.autoclick;
  $('images'   ).checked = ui.images;
  $('click_delay' ).value = ui.click_delay;
  $('reveal_delay').value = ui.reveal_delay;
  $('verify_delay').value = ui.verify_delay;
});

['enabled','autoclick','images'].forEach(id => {
  $(id).addEventListener('change', () => save(readUI()));
});
['click_delay','reveal_delay','verify_delay'].forEach(id => {
  $(id).addEventListener('input', () => save(readUI()));
});

function readUI () {
  return {
    enabled:      $('enabled').checked,
    autoclick:    $('autoclick').checked,
    images:       $('images').checked,
    click_delay:  Math.max(0, Number($('click_delay').value)  || 0),
    reveal_delay: Math.max(0, Number($('reveal_delay').value) || 0),
    verify_delay: Math.max(0, Number($('verify_delay').value) || 0)
  };
}
function save (ui) {
  const out = {
    enabled:                        ui.enabled,
    recaptcha_auto_open:            ui.autoclick,
    recaptcha_auto_solve:           ui.images,
    recaptcha_delay_between_clicks: ui.click_delay,
    recaptcha_delay_dynamic_reveal: ui.reveal_delay,
    recaptcha_delay_before_verify:  ui.verify_delay
  };
  // settings::update merges into stored settings in the background (do NOT
  // storage.local.set here — that would wipe keys not present in `out`).
  chrome.runtime.sendMessage([Math.random().toString(36).slice(2),'settings::update',out]);
}


function rpc(name, ...args){
  const token = Math.random().toString(36).slice(2);
  return new Promise(res => {
    chrome.runtime.sendMessage([token, name, ...args], reply => res(reply?.[1]));
  });
}
async function loadRep(){
  try {
    const data = await rpc('reports::getState');
    const cfg = data?.config || {};
    const st  = data?.state  || {};
    qq('#rep_enabled').checked = !!cfg.enabled;
    renderStatus(st);
  } catch(e){  }
}
function renderStatus(st){
  const el = qq('#rep_status');
  if (!el) return;
  const s = [];
  if (st.last_success_ts) s.push('Last report sent: ' + new Date(st.last_success_ts).toLocaleString());
  if (st.last_error_ts)   s.push('Last error: ' + new Date(st.last_error_ts).toLocaleString());
  if (st.last_error_reason) s.push(String(st.last_error_reason));
  el.textContent = s.join(' · ');
}
async function saveRep(){
  // The key is not editable on the Reports page: it is generated automatically
  // or set in the Anti-Captcha service block (WS version).
  await rpc('reports::update', { enabled: qq('#rep_enabled')?.checked || false });
  await loadRep();
}


qq('#rep_enabled')?.addEventListener('change', saveRep);
qq('#rep_send')?.addEventListener('click', async () => {
  const status = qq('#rep_status');
  if (status) status.textContent = 'Sending…';
  await rpc('reports::sendNow');
  const data = await rpc('reports::getState');
  renderStatus(data?.state || {});
});


loadRep();


// ---- Anti-Captcha service (WS mode) ----
// The service needs a 32-char key from captchaplugin.com. A 16-char key is the
// one generated automatically for reports; it is never shown to the user.
const SVC_KEY_RE = /^[0-9a-z]{32}$/;

function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

// Why the toggle cannot be turned on: 'key' (no 32-char key), 'addon' (version
// without the WS add-on) or null (available). The input is not `disabled`, so a
// click on it still arrives and can point to the reason.
let wsBlocked = 'addon';
function setWsBlocked(reason) {
  wsBlocked = reason;
  const on = reason !== null;
  $('ws_mode_switch')?.classList.toggle('is-disabled', on);
  $('ws_mode')?.setAttribute('aria-disabled', on ? 'true' : 'false');
  const label = $('ws_mode_label');
  if (label) label.title = reason === 'key' ? 'Requires a 32-character API key'
                         : reason === 'addon' ? 'Requires the version with the WS add-on' : '';
}
function flash(el) {
  if (!el) return;
  el.classList.remove('attention');
  void el.offsetWidth; // restart the animation
  el.classList.add('attention');
}
function showWsReason() {
  if (wsBlocked === 'key') {
    const input = $('svc_key');
    setKeyStatus('Enter your 32-character key to turn the service on.', true);
    flash(input);
    input?.focus();
  } else if (wsBlocked === 'addon') {
    flash($('svc_need_addon'));
  }
}
$('ws_mode')?.addEventListener('click', (e) => {
  if (wsBlocked === null) return;
  e.preventDefault(); // keep the toggle off
  showWsReason();
});

async function loadWsMode() {
  try {
    const wsToggle = $('ws_mode');
    if (!wsToggle) return;
    const [enabledResp, storageData] = await Promise.all([
      sendMsg({ type: 'get_enabled' }),
      chrome.storage.local.get('reporting'),
    ]);
    const key   = (storageData?.reporting?.key || '').trim();
    const has32 = SVC_KEY_RE.test(key);
    setWsBlocked(has32 ? null : 'key');
    wsToggle.checked = has32 && enabledResp?.enabled === true;
  } catch {}
}

function setKeyStatus(text, isError) {
  const el = $('svc_key_status');
  if (!el) return;
  el.textContent = text;
  el.classList.toggle('error', !!isError);
}

async function loadSvcKey() {
  const input = $('svc_key');
  if (!input) return;
  const { reporting = {} } = await chrome.storage.local.get('reporting');
  const key = (reporting.key || '').trim();
  // Show only a user-entered 32-char key, never the auto-generated short one.
  input.value = SVC_KEY_RE.test(key) ? key : '';
  setKeyStatus(input.value ? '' : 'Enter a key to enable the service.', false);
}

function generateShortKey(len = 16) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const rnd = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(rnd, b => chars[b % chars.length]).join('');
}

async function saveSvcKey() {
  const input = $('svc_key');
  const v = (input?.value || '').trim();
  if (!v) {
    // Key removed: fall back to a fresh auto-generated key (hidden from the
    // user). The service turns itself off because the key is no longer 32 chars.
    const { reporting = {} } = await chrome.storage.local.get('reporting');
    if (SVC_KEY_RE.test((reporting.key || '').trim())) {
      await rpc('reports::update', { key: generateShortKey() });
    }
    setKeyStatus('Enter a key to enable the service.', false);
  } else if (!SVC_KEY_RE.test(v)) {
    $('svc_key')?.classList.remove('attention');
    // Do not save an invalid key; keep the previous one.
    setKeyStatus(`The key must be 32 characters (a–z, 0–9): ${v.length}/32.`, true);
    return;
  } else {
    $('svc_key')?.classList.remove('attention');
    await rpc('reports::update', { key: v });
    setKeyStatus('Key saved.', false);
  }
  await loadWsMode();
}

$('svc_key')?.addEventListener('input', saveSvcKey);

$('ws_mode')?.addEventListener('change', async () => {
  const wsToggle = $('ws_mode');
  if (!wsToggle || wsBlocked !== null) return;
  try {
    const resp = await sendMsg({ type: 'set_enabled', enabled: wsToggle.checked });
    if (resp && resp.type === 'ok') {
      wsToggle.checked = resp.enabled !== false;
    } else {
      await loadWsMode(); // revert on failure
    }
  } catch {
    await loadWsMode();
  }
});

async function isWsModeAvailable() {
  const resp = await sendMsg({ type: 'ws_available' });
  return resp?.available === true;
}

async function initWsMode() {
  if (await isWsModeAvailable()) {
    // WS version: key field next to the toggle.
    $('svc_key_row').classList.remove('hidden');
    await loadSvcKey();
    await loadWsMode();
    // The background may switch the service off (e.g. the key was removed).
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && ('ws_mode_enabled' in changes || 'reporting' in changes)) loadWsMode();
    });
  } else {
    // Basic version: the toggle stays off and points to the WS add-on version.
    setWsBlocked('addon');
    $('ws_mode').checked = false;
    $('svc_need_addon').classList.remove('hidden');
  }
}

initWsMode();

