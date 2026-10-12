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

  start();
  send({ type: "cosmetic:page" }).then((res) => {
    // Paused site, or hiding disabled for this site by the filter lists: stop watching.
    if (res && res.ok && res.result && res.result.active === false) {
      active = false;
      observer?.disconnect();
      pending = [];
    }
  });
})();
