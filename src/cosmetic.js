// LocalBlock cosmetic filtering, content script (runs in every frame at document_start).
//
// It only reports the page's class and id names to LocalBlock's own service worker, which
// injects the matching hiding CSS. Nothing is sent anywhere else.

(() => {
  if (globalThis.__localBlockCosmetic) return;
  globalThis.__localBlockCosmetic = true;

  const seen = new Set();
  let pending = [];
  let timer = 0;
  let active = true;
  let observer = null;

  const send = (msg) =>
    chrome.runtime.sendMessage(msg).catch(() => undefined); // extension reloaded or worker asleep

  function collect(el) {
    if (el.nodeType !== 1) return;
    const id = el.id;
    if (id && typeof id === "string") add("#" + id);
    const cls = el.classList;
    if (cls) for (let i = 0; i < cls.length; i++) add("." + cls[i]);
  }

  function add(token) {
    if (seen.has(token)) return;
    seen.add(token);
    pending.push(token);
    if (!timer) timer = setTimeout(flush, 50);
  }

  function flush() {
    timer = 0;
    if (!active || !pending.length) return;
    const tokens = pending;
    pending = [];
    send({ type: "cosmetic:tokens", tokens });
  }

  function scan(root) {
    collect(root);
    if (root.querySelectorAll) for (const el of root.querySelectorAll("[id],[class]")) collect(el);
  }

  function onMutations(records) {
    for (const r of records) {
      if (r.type === "attributes") collect(r.target);
      else for (const n of r.addedNodes) if (n.nodeType === 1) scan(n);
    }
  }

  function start() {
    observer = new MutationObserver(onMutations);
    observer.observe(document, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["class", "id"],
    });
    if (document.documentElement) scan(document.documentElement);
  }

  // Site fixes such as ":remove-attr(disabled)" that unlock a player an ad step had locked.
  // They are re-applied whenever the page changes, since sites often set them again.
  function runActions(actions) {
    const pick = (spec, names) => {
      const m = /^\/(.+)\/([imsu]*)$/.exec(spec);
      if (m) {
        const re = new RegExp(m[1], m[2]);
        return names.filter((n) => re.test(n));
      }
      return spec.split("|").map((n) => n.trim()).filter(Boolean);
    };
    const apply = () => {
      for (const a of actions) {
        let elements;
        try {
          elements = document.querySelectorAll(a.s);
        } catch {
          continue; // a selector this browser doesn't understand
        }
        for (const el of elements) {
          if (a.t === "remove-attr") {
            for (const n of pick(a.a, el.getAttributeNames())) if (el.hasAttribute(n)) el.removeAttribute(n);
          } else if (a.t === "remove-class") {
            for (const c of pick(a.a, [...el.classList])) if (el.classList.contains(c)) el.classList.remove(c);
          }
        }
      }
    };
    let queued = false;
    const schedule = () => {
      if (queued) return;
      queued = true;
      setTimeout(() => {
        queued = false;
        apply();
      }, 0);
    };
    new MutationObserver(schedule).observe(document, { childList: true, subtree: true, attributes: true });
    apply();
  }

  start();
  send({ type: "cosmetic:page" }).then((res) => {
    const result = res && res.ok ? res.result : null;
    if (result && Array.isArray(result.actions) && result.actions.length) runActions(result.actions);
    // Paused site, or generic hiding disabled for this site by the filter lists: stop watching.
    if (result && result.active === false) {
      active = false;
      observer?.disconnect();
      pending = [];
    }
  });
})();
