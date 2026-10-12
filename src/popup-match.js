// Decides whether a tab a page just opened is a known ad popup, using rules/popup.json.
// Pure functions, shared by the service worker and the tests.

const cache = new Map();

/** ABP pattern -> RegExp: || domain anchor, | start/end anchor, ^ separator, * wildcard. */
export function patternToRegExp(pattern) {
  if (cache.has(pattern)) return cache.get(pattern);
  let p = pattern;
  let prefix = "";
  let suffix = "";
  if (p.startsWith("||")) {
    prefix = "^[a-z][a-z0-9+.-]*:\\/\\/(?:[^\\/?#]*\\.)?";
    p = p.slice(2);
  } else if (p.startsWith("|")) {
    prefix = "^";
    p = p.slice(1);
  }
  if (p.endsWith("|")) {
    suffix = "$";
    p = p.slice(0, -1);
  }
  const body = p
    .split("")
    .map((c) => (c === "*" ? ".*" : c === "^" ? "(?:[^\\w.%-]|$)" : c.replace(/[.+?${}()|[\]\\/]/g, "\\$&")))
    .join("");
  const re = new RegExp(prefix + body + suffix, "i");
  cache.set(pattern, re);
  return re;
}

function hostChain(host) {
  const labels = String(host || "").toLowerCase().split(".");
  return labels.map((_, i) => labels.slice(i).join("."));
}

// "Same site" is approximated as one host being the other or a subdomain of it, or both
// sharing their last two labels.
function sameSite(a, b) {
  const base = (h) => h.split(".").slice(-2).join(".");
  return a === b || a.endsWith("." + b) || b.endsWith("." + a) || base(a) === base(b);
}

function ruleApplies(rule, url, openerHost, targetHost) {
  if (rule.tp === true && sameSite(openerHost, targetHost)) return false;
  if (rule.tp === false && !sameSite(openerHost, targetHost)) return false;
  const chain = hostChain(openerHost);
  if (rule.i && !rule.i.some((d) => chain.includes(d))) return false;
  if (rule.x && rule.x.some((d) => chain.includes(d))) return false;
  if (!rule.p || rule.p === "*") return true;
  return patternToRegExp(rule.p).test(url);
}

/** true if a tab opened by a page on openerHost and loading url should be closed. */
export function isAdPopup(data, url, openerHost) {
  let target;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  const targetHost = target.hostname.toLowerCase();
  if (sameSite(openerHost, targetHost)) {
    // Opening your own site in a new tab is never treated as an ad popup by domain alone.
    if (!data.rules.some((r) => r.i && ruleApplies(r, url, openerHost, targetHost))) return false;
  }
  const exception = data.exceptions.some((r) => ruleApplies(r, url, openerHost, targetHost));
  const important = data.rules.some((r) => r.imp && ruleApplies(r, url, openerHost, targetHost));
  if (exception && !important) return false;
  const domainSet = (data._set ||= new Set(data.domains));
  if (hostChain(targetHost).some((h) => domainSet.has(h))) return true;
  return data.rules.some((r) => ruleApplies(r, url, openerHost, targetHost));
}
