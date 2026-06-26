
const $  = id  => document.getElementById(id);
const qq = sel => document.querySelector(sel);


function show(page){
  $('page_main').classList.toggle('hidden', page !== 'main');
  $('page_reports').classList.toggle('hidden', page !== 'reports');
}
$('open_reports').addEventListener('click', () => show('reports'));
$('back_main').addEventListener('click',  () => show('main'));


const defaults = { enabled:true, recaptcha:true, autoclick:true, images:true, delay:0 };

chrome.storage.local.get('settings').then(({ settings = {} }) => {
  const ui = { ...defaults };
  ui.enabled   = settings.enabled ?? defaults.enabled;
  ui.autoclick = settings.recaptcha_auto_open  ?? defaults.autoclick;
  ui.images    = settings.recaptcha_auto_solve ?? defaults.images;
  ui.delay     = settings.recaptcha_solve_delay_time ?? defaults.delay;
  ui.recaptcha = ui.autoclick || ui.images;

  $('enabled' ).checked = ui.enabled;
  $('recaptcha').checked = ui.recaptcha;
  $('autoclick').checked = ui.autoclick;
  $('images'   ).checked = ui.images;
  $('delay'    ).value   = ui.delay;
});

['enabled','recaptcha','autoclick','images'].forEach(id => {
  $(id).addEventListener('change', () => save(readUI()));
});
$('delay').addEventListener('input', () => save(readUI()));

function readUI () {
  return {
    enabled:   $('enabled').checked,
    recaptcha: $('recaptcha').checked,
    autoclick: $('autoclick').checked,
    images:    $('images').checked,
    delay:     Number($('delay').value) || 0
  };
}
function save (ui) {
  const out = {
    enabled:                     ui.enabled,
    recaptcha_auto_open:         ui.recaptcha ? ui.autoclick : false,
    recaptcha_auto_solve:        ui.recaptcha ? ui.images    : false,
    recaptcha_solve_delay_time:  ui.delay
  };
  chrome.storage.local.set({ settings: out });
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
    qq('#rep_key').value = cfg.key || '';
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
  const patch = {
    enabled: qq('#rep_enabled')?.checked || false,
    key: (qq('#rep_key')?.value || '').trim()
  };
  await rpc('reports::update', patch);
  await loadRep();
  await loadWsMode(); // re-check WS mode availability after key change
}


qq('#rep_enabled')?.addEventListener('change', saveRep);
qq('#rep_key')?.addEventListener('input',  saveRep);
qq('#rep_send')?.addEventListener('click', async () => {
  const status = qq('#rep_status');
  if (status) status.textContent = 'Sending…';
  await rpc('reports::sendNow');
  const data = await rpc('reports::getState');
  renderStatus(data?.state || {});
});


loadRep();


// ---- WS mode ----
function sendMsg(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (resp) => {
      if (chrome.runtime.lastError) resolve(null);
      else resolve(resp);
    });
  });
}

async function loadWsMode() {
  try {
    const wsToggle = $('ws_mode');
    if (!wsToggle) return;
    const [enabledResp, storageData] = await Promise.all([
      sendMsg({ type: 'get_enabled' }),
      chrome.storage.local.get('reporting'),
    ]);
    const key   = (storageData?.reporting?.key || '').trim();
    const has32 = key.length === 32;
    wsToggle.disabled = !has32;
    wsToggle.checked  = has32 && enabledResp?.enabled === true;
    const label = $('ws_mode_label');
    if (label) label.title = has32 ? '' : 'Requires a 32-character API key';
  } catch {}
}

$('ws_mode')?.addEventListener('change', async () => {
  const wsToggle = $('ws_mode');
  if (!wsToggle || wsToggle.disabled) return;
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
    $('ws_mode_label').classList.remove('hidden');
    $('ws_mode_switch').classList.remove('hidden');
    const keyLabel = $('rep_key_label');
    if (keyLabel) keyLabel.textContent = 'API key (16 or 32 chars)';
  }
  await loadWsMode();
}

initWsMode();

