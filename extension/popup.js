
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
  enabled:true, recaptcha:true, autoclick:true, images:true,
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
  ui.recaptcha    = ui.autoclick || ui.images;

  $('enabled' ).checked = ui.enabled;
  $('recaptcha').checked = ui.recaptcha;
  $('autoclick').checked = ui.autoclick;
  $('images'   ).checked = ui.images;
  $('click_delay' ).value = ui.click_delay;
  $('reveal_delay').value = ui.reveal_delay;
  $('verify_delay').value = ui.verify_delay;
});

['enabled','recaptcha','autoclick','images'].forEach(id => {
  $(id).addEventListener('change', () => save(readUI()));
});
['click_delay','reveal_delay','verify_delay'].forEach(id => {
  $(id).addEventListener('input', () => save(readUI()));
});

function readUI () {
  return {
    enabled:      $('enabled').checked,
    recaptcha:    $('recaptcha').checked,
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
    recaptcha_auto_open:            ui.recaptcha ? ui.autoclick : false,
    recaptcha_auto_solve:           ui.recaptcha ? ui.images    : false,
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

