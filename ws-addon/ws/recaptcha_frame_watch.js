(() => {
  if (window.__wsRecaptchaFrameWatcherInstalled) return;
  window.__wsRecaptchaFrameWatcherInstalled = true;

  const host = (location.hostname || "").toLowerCase();
  if (!host.includes("google.com") && !host.includes("recaptcha.net")) return;
  if (!(location.pathname || "").includes("/recaptcha/")) return;

  const sent = new Set();
  let lastActivityTs = 0;
  const post = (code, detail) => {
    try {
      if (sent.has(code)) return;
      sent.add(code);
      window.top &&
        window.top.postMessage({ __wsRecaptcha: true, code, detail: detail || null }, "*");
    } catch {}
  };
  const postActivity = (detail) => {
    try {
      const now = Date.now();
      if (now - lastActivityTs < 700) return;
      lastActivityTs = now;
      window.top &&
        window.top.postMessage({ __wsRecaptcha: true, code: "activity", detail: detail || null }, "*");
    } catch {}
  };

  const normalize = (s) => String(s || "").toLowerCase();

  const scan = () => {
    const body = document.body;
    const text = (body && (body.innerText || body.textContent)) || "";
    const t = normalize(text);

    if (t.includes("invalid site key")) return post("invalid_site_key", { text: text.slice(0, 300) }), true;
    if (t.includes("invalid domain")) return post("invalid_domain", { text: text.slice(0, 300) }), true;
    if (t.includes("not supported by default") && t.includes("supported domains")) return post("invalid_domain", { text: text.slice(0, 300) }), true;
    if (t.includes("not in the list of supported domains") && t.includes("site key")) return post("invalid_domain", { text: text.slice(0, 300) }), true;
    if (t.includes("error for site owner")) return post("site_owner_error", { text: text.slice(0, 300) }), true;
    if (t.includes("ip") && t.includes("blocked")) return post("ip_blocked", { text: text.slice(0, 300) }), true;

    const scripts = document.scripts || [];
    let scriptText = "";
    try {
      for (const s of scripts) {
        if (s && typeof s.textContent === "string" && s.textContent) {
          scriptText += s.textContent + "\n";
        }
      }
    } catch {}
    if (!scriptText) return false;

    const st = normalize(scriptText);
    if (st.includes("invalid site key")) return post("invalid_site_key", { source: "script" }), true;
    if (st.includes("invalid domain")) return post("invalid_domain", { source: "script" }), true;
    if (st.includes("not supported by default") && st.includes("supported domains")) return post("invalid_domain", { source: "script" }), true;
    if (st.includes("not in the list of supported domains") && st.includes("site key")) return post("invalid_domain", { source: "script" }), true;
    if (st.includes("error for site owner")) return post("site_owner_error", { source: "script" }), true;
    if (st.includes("ip") && st.includes("blocked")) return post("ip_blocked", { source: "script" }), true;

    return false;
  };

  if (!scan()) {
    const mo = new MutationObserver(() => {
      postActivity({ source: "frame_mutation" });
      if (scan()) mo.disconnect();
    });
    try {
      mo.observe(document.documentElement || document.body, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    } catch {}
  }

  // Track image updates in challenge flow.
  window.addEventListener(
    "load",
    (ev) => {
      try {
        const t = ev && ev.target;
        if (!t || t.tagName !== "IMG") return;
        postActivity({ source: "img_load" });
      } catch {}
    },
    true
  );

  const tryPatch = (recaptchaObj) => {
    try {
      const em = recaptchaObj && recaptchaObj.anchor && recaptchaObj.anchor.ErrorMain;
      if (!em || em.__wsPatched || typeof em.init !== "function") return;
      const orig = em.init;
      em.init = function (...args) {
        try {
          const arg = args[0];
          const s = typeof arg === "string" ? arg : JSON.stringify(arg);
          if (s) {
            const low = normalize(s);
            if (low.includes("invalid site key")) post("invalid_site_key", { source: "init" });
            else if (low.includes("invalid domain")) post("invalid_domain", { source: "init" });
            else if (low.includes("not supported by default") && low.includes("supported domains")) post("invalid_domain", { source: "init" });
            else if (low.includes("not in the list of supported domains") && low.includes("site key")) post("invalid_domain", { source: "init" });
            else if (low.includes("error for site owner")) post("site_owner_error", { source: "init" });
            else if (low.includes("ip") && low.includes("blocked")) post("ip_blocked", { source: "init" });
          }
        } catch {}
        return orig.apply(this, args);
      };
      em.__wsPatched = true;
    } catch {}
  };

  try {
    if (window.recaptcha) tryPatch(window.recaptcha);

    let _recaptcha = window.recaptcha;
    Object.defineProperty(window, "recaptcha", {
      configurable: true,
      get() {
        return _recaptcha;
      },
      set(v) {
        _recaptcha = v;
        tryPatch(v);
      },
    });
  } catch {}
})();
