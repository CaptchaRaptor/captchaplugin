
(function(){
  const q = sel => document.querySelector(sel);
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
      q('#rep_enabled').checked = !!cfg.enabled;
      q('#rep_key').value = cfg.key || '';
      renderStatus(st);
    } catch(e){  }
  }
  function renderStatus(st){
    const el = q('#rep_status');
    if (!el) return;
    const s = [];
    if (st.last_success_ts) s.push('Last report sent: ' + new Date(st.last_success_ts).toLocaleString());
    if (st.last_error_ts) s.push('Last error: ' + new Date(st.last_error_ts).toLocaleString());
    if (st.last_error_reason) s.push(String(st.last_error_reason));
    el.textContent = s.join(' · ');
  }
  async function saveRep(){
    const patch = {
      enabled: q('#rep_enabled')?.checked || false,
      key: (q('#rep_key')?.value || '').trim()
    };
    await rpc('reports::update', patch);
    await loadRep();
  }

  document.addEventListener('DOMContentLoaded', () => {
    q('#rep_enabled')?.addEventListener('change', saveRep);
    q('#rep_key')?.addEventListener('input', saveRep);
    q('#rep_send')?.addEventListener('click', async () => {
      const status = q('#rep_status');
      if (status) status.textContent = 'Sending…';
      const _res = await rpc('reports::sendNow');
      const data = await rpc('reports::getState');
      renderStatus(data?.state || {});
    });
    loadRep();
  });
})();

