// Looks up which cosmetic selectors apply to a page. Pure functions over rules/cosmetic.json,
// shared by the service worker and the tests.

/** "a.b.example.co.uk" -> its own name, every parent domain, and entity forms like "example.*". */
export function hostCandidates(host) {
  const labels = String(host).toLowerCase().replace(/\.$/, "").split(".");
  const out = [];
  for (let i = 0; i < labels.length; i++) {
    out.push(labels.slice(i).join("."));
    // Entity filters ("example.*") match any public suffix; approximate it as the last 1-2 labels.
    for (let r = 1; r <= 2; r++) {
      if (labels.length - i > r) out.push(labels.slice(i, labels.length - r).join(".") + ".*");
    }
  }
  return [...new Set(out)];
}

function anyMatch(list, candidates) {
  if (!list.length) return false;
  const set = new Set(list);
  return candidates.some((c) => set.has(c));
}

/**
 * Everything known about a page up front.
 * Returns null when hiding is switched off for the site ($elemhide).
 */
export function pagePlan(data, host) {
  const candidates = hostCandidates(host);
  if (anyMatch(data.elemHide, candidates)) return null;
  const exceptions = new Set();
  const specific = [];
  for (const c of candidates) {
    for (const s of data.exceptions[c] || []) exceptions.add(s);
    for (const s of data.specific[c] || []) specific.push(s);
  }
  const generic = !anyMatch(data.genericHide, candidates);
  const selectors = [...specific, ...(generic ? data.generic.unkeyed : [])].filter(
    (s) => !exceptions.has(s)
  );
  // Site-specific procedural filters: :style() becomes CSS, the rest run in the content script.
  const styles = [];
  const actions = [];
  for (const c of candidates) {
    for (const a of (data.procedural && data.procedural[c]) || []) {
      if (a.t === "style") styles.push(`${a.s}{${a.a}}`);
      else actions.push(a);
    }
  }
  return { selectors: [...new Set(selectors)], exceptions, generic, styles, actions };
}

/** Generic selectors unlocked by classes/ids seen on the page ("." + class, "#" + id). */
export function selectorsForTokens(data, tokens, plan) {
  if (!plan?.generic) return [];
  const out = [];
  for (const t of tokens) {
    for (const s of data.generic.keyed[t] || []) {
      if (!plan.exceptions.has(s)) out.push(s);
    }
  }
  return out;
}

/** One rule per selector, so a selector the browser does not understand cannot void the others. */
export function toCss(selectors) {
  return selectors.map((s) => `${s}{display:none!important}`).join("\n");
}
