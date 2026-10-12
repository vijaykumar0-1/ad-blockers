// Compiles $popup filters (ad destinations that pages open in a new tab or window) into
// rules/popup.json. The service worker closes such tabs as soon as they open; Chrome's
// blocking rules can't do this because the request itself is a normal page load.
// No dependencies, no network access.

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

function parseLine(line) {
  let f = line.trim();
  const allow = f.startsWith("@@");
  if (allow) f = f.slice(2);
  const i = f.lastIndexOf("$");
  if (i < 0) return null;
  const pattern = f.slice(0, i);
  const opts = f.slice(i + 1).split(",").map((o) => o.trim());
  if (!opts.some((o) => o.toLowerCase() === "popup" || o.toLowerCase() === "popunder")) return null;
  if (pattern.startsWith("/") && pattern.endsWith("/")) return { skip: "regex" };
  if (/[^\x20-\x7e]/.test(pattern)) return { skip: "non-ascii" };
  const rule = { p: pattern };
  for (const raw of opts) {
    const o = raw.toLowerCase();
    if (o === "popup" || o === "popunder") continue;
    if (o === "third-party" || o === "3p") rule.tp = true;
    else if (o === "~third-party" || o === "1p" || o === "first-party") rule.tp = false;
    else if (o.startsWith("domain=")) {
      for (let d of raw.slice(7).split("|")) {
        d = d.trim().toLowerCase();
        const neg = d.startsWith("~");
        if (neg) d = d.slice(1);
        if (!DOMAIN_RE.test(d)) return { skip: "domain-syntax" };
        (rule[neg ? "x" : "i"] ||= []).push(d);
      }
    } else if (o === "important") {
      rule.imp = true;
    } else {
      return { skip: `option:${o}` };
    }
  }
  if (!pattern || pattern === "*") {
    if (!rule.i) return { skip: "matches-everything" };
  }
  return { allow, rule };
}

export function compilePopups(listTexts) {
  const domains = new Set(); // plain "||domain^$popup" filters: fastest path
  const rules = [];
  const exceptions = [];
  const stats = { block: 0, allow: 0, skipped: {} };
  for (const text of listTexts) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes("$") || line.startsWith("!")) continue;
      if (/#[@?$%]?#/.test(line)) continue;
      const r = parseLine(line);
      if (!r) continue;
      if (r.skip) {
        stats.skipped[r.skip] = (stats.skipped[r.skip] || 0) + 1;
        continue;
      }
      const { allow, rule } = r;
      const plain = /^\|\|([a-z0-9.-]+)\^?$/.exec(rule.p);
      if (!allow && plain && Object.keys(rule).length === 1) domains.add(plain[1]);
      else (allow ? exceptions : rules).push(rule);
      stats[allow ? "allow" : "block"]++;
    }
  }
  return { data: { domains: [...domains].sort(), rules, exceptions }, stats };
}
