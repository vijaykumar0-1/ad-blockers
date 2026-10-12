// Converts Adblock Plus / EasyList network filters into Chrome declarativeNetRequest rules.
//
// Supported: block and @@ exception filters using ||, |, ^ and * in the pattern, plus the
// options for resource types, third-party, domain=, match-case, important and document.
// Anything we cannot express faithfully (regex filters, csp=, redirect=, removeparam=,
// popup, ...) is skipped rather than approximated, so a skipped filter never blocks more
// than the list author intended. Cosmetic (##) filters are handled separately.
//
// No dependencies, no network access.

const TYPE_MAP = {
  script: "script",
  image: "image",
  stylesheet: "stylesheet",
  css: "stylesheet",
  object: "object",
  xmlhttprequest: "xmlhttprequest",
  xhr: "xmlhttprequest",
  subdocument: "sub_frame",
  frame: "sub_frame",
  ping: "ping",
  beacon: "ping",
  media: "media",
  font: "font",
  websocket: "websocket",
  other: "other",
};
const ALL_TYPES = [...new Set(Object.values(TYPE_MAP))];

// Options that change what a filter means in ways DNR cannot express. A filter using any
// of these is skipped.
const UNSUPPORTED = new Set([
  "csp", "redirect", "redirect-rule", "rewrite", "removeparam", "queryprune", "replace",
  "header", "permissions", "urltransform", "uritransform", "urlskip", "popup", "popunder",
  "sitekey", "webrtc", "elemhide", "ehide", "generichide", "ghide", "specifichide", "shide",
  "genericblock", "denyallow", "to", "from", "method", "strict1p", "strict3p",
  "inline-script", "inline-font", "empty", "mp4", "cname", "badfilter", "all", "frame-ancestors",
]);

export const PRIORITY = { block: 1, allow: 2, important: 3 };

const DOMAIN_RE = /^(?=.{1,253}$)(\*\.)?([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Classify one line of a filter list. */
export function lineKind(line) {
  if (!line || line.startsWith("!") || line.startsWith("[")) return "comment";
  if (/#[@?$%]?#|#@[$?]#|#\+js\(/.test(line)) return "cosmetic";
  return "network";
}

function splitOptions(filter) {
  // Regex filters keep their own $; options come after the closing slash.
  if (filter.startsWith("/")) {
    const end = filter.lastIndexOf("/");
    if (end > 0) {
      const rest = filter.slice(end + 1);
      if (rest === "") return [filter, ""];
      if (rest.startsWith("$")) return [filter.slice(0, end + 1), rest.slice(1)];
    }
  }
  const i = filter.lastIndexOf("$");
  if (i < 0) return [filter, ""];
  const opts = filter.slice(i + 1);
  // Only treat it as an options block if it looks like one.
  if (!/^~?[a-z0-9-]+(=|,|$)/i.test(opts)) return [filter, ""];
  return [filter.slice(0, i), opts];
}

function parseDomainList(value, sep) {
  const include = [];
  const exclude = [];
  for (let d of value.split(sep)) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith("~");
    if (neg) d = d.slice(1);
    // Entity matching (example.*) and regex domains are not supported by DNR.
    if (d.endsWith(".*") || d.startsWith("/") || !DOMAIN_RE.test(d) || d.startsWith("*.")) {
      return null;
    }
    (neg ? exclude : include).push(d);
  }
  return { include, exclude };
}

/**
 * Convert one network filter line.
 * Returns { rule } (rule without id) or { skip: reason }.
 */
export function convertFilter(line) {
  let filter = line.trim();
  const allow = filter.startsWith("@@");
  if (allow) filter = filter.slice(2);

  const [pattern, optText] = splitOptions(filter);
  if (pattern.startsWith("/") && pattern.endsWith("/") && pattern.length > 2) {
    return { skip: "regex" };
  }

  const condition = {};
  const types = [];
  const excludedTypes = [];
  let important = false;
  let documentOpt = false;

  if (optText) {
    for (const raw of optText.split(",")) {
      const opt = raw.trim().toLowerCase();
      if (!opt) continue;
      const neg = opt.startsWith("~");
      const name = (neg ? opt.slice(1) : opt).split("=")[0];
      const value = opt.includes("=") ? raw.trim().slice(raw.trim().indexOf("=") + 1) : "";

      if (TYPE_MAP[name]) {
        (neg ? excludedTypes : types).push(TYPE_MAP[name]);
      } else if (name === "third-party" || name === "3p") {
        condition.domainType = neg ? "firstParty" : "thirdParty";
      } else if (name === "first-party" || name === "1p") {
        condition.domainType = neg ? "thirdParty" : "firstParty";
      } else if (name === "domain") {
        if (neg) return { skip: "option:~domain" };
        const d = parseDomainList(value, "|");
        if (!d) return { skip: "domain-syntax" };
        if (d.include.length) condition.initiatorDomains = d.include;
        if (d.exclude.length) condition.excludedInitiatorDomains = d.exclude;
      } else if (name === "match-case") {
        condition.isUrlFilterCaseSensitive = !neg;
      } else if (name === "important") {
        important = true;
      } else if (name === "document" || name === "doc") {
        if (neg) return { skip: "option:~document" };
        documentOpt = true;
      } else if (UNSUPPORTED.has(name)) {
        return { skip: `option:${name}` };
      } else {
        return { skip: `option:${name}` };
      }
    }
  }

  // Pattern -> urlFilter. DNR's urlFilter syntax is ABP's syntax, so the pattern carries over.
  let urlFilter = pattern;
  if (urlFilter === "" || urlFilter === "*" || urlFilter === "|" || urlFilter === "||") {
    urlFilter = "";
  }
  if (/[^\x20-\x7e]/.test(urlFilter)) return { skip: "non-ascii" };
  if (urlFilter.startsWith("||*")) urlFilter = urlFilter.slice(3);
  if (urlFilter.startsWith("|*")) urlFilter = urlFilter.slice(2);
  if (urlFilter.startsWith("*")) urlFilter = urlFilter.replace(/^\*+/, "");
  if (urlFilter.endsWith("*") && !urlFilter.endsWith("|*")) urlFilter = urlFilter.replace(/\*+$/, "");

  // DNR only allows | as an anchor at the very start or end.
  if (urlFilter.replace(/^\|\|?/, "").replace(/\|$/, "").includes("|")) return { skip: "pipe-in-middle" };

  // A filter with no pattern and no domain restriction would match everything. Skip it.
  if (!urlFilter && !condition.initiatorDomains) return { skip: "matches-everything" };

  // Pure "||example.com^" filters become requestDomains, which Chrome matches fastest and
  // which lets us merge many of them into a single rule.
  const domainOnly = /^\|\|([a-z0-9.-]+)\^?(\|)?$/i.exec(urlFilter);
  if (domainOnly && DOMAIN_RE.test(domainOnly[1].toLowerCase()) && !condition.isUrlFilterCaseSensitive) {
    condition.requestDomains = [domainOnly[1].toLowerCase()];
  } else if (urlFilter) {
    condition.urlFilter = urlFilter;
  }

  let action;
  let priority = allow ? PRIORITY.allow : important ? PRIORITY.important : PRIORITY.block;

  if (documentOpt) {
    if (!allow) return { skip: "block-document" };
    // @@||site^$document: allow everything on pages from that site.
    action = { type: "allowAllRequests" };
    condition.resourceTypes = ["main_frame", "sub_frame"];
    if (types.length || excludedTypes.length) return { skip: "document-with-types" };
  } else {
    action = { type: allow ? "allow" : "block" };
    if (types.length) condition.resourceTypes = [...new Set(types)];
    else if (excludedTypes.length) {
      const excl = new Set(excludedTypes);
      // ABP: "~script" means every type except script (documents excluded by default).
      condition.excludedResourceTypes = ["main_frame", ...ALL_TYPES.filter((t) => excl.has(t))];
    }
    // Without resourceTypes, Chrome skips main_frame by default, matching ABP's behaviour.
  }
  if (important && allow) priority = PRIORITY.allow;

  return { rule: { priority, action, condition } };
}

// Two rules can share one rule (with requestDomains merged) if they differ only in
// requestDomains.
function mergeKey(rule) {
  const { requestDomains, ...cond } = rule.condition;
  if (!requestDomains) return null;
  return JSON.stringify([rule.priority, rule.action, cond]);
}

const MAX_DOMAINS_PER_RULE = 1000;

/**
 * Convert a whole filter list. Returns { rules, cosmetic, stats }.
 * rules have ids starting at 1.
 */
export function convertList(text) {
  const stats = { network: 0, converted: 0, cosmetic: 0, skipped: {} };
  const cosmetic = [];
  const merged = new Map();
  const singles = [];
  const seen = new Set();

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    const kind = lineKind(line);
    if (kind === "comment") continue;
    if (kind === "cosmetic") {
      stats.cosmetic++;
      cosmetic.push(line);
      continue;
    }
    stats.network++;
    const { rule, skip } = convertFilter(line);
    if (skip) {
      stats.skipped[skip] = (stats.skipped[skip] || 0) + 1;
      continue;
    }
    const sig = JSON.stringify(rule);
    if (seen.has(sig)) continue;
    seen.add(sig);
    stats.converted++;
    const key = mergeKey(rule);
    if (key) {
      if (!merged.has(key)) merged.set(key, { base: rule, domains: [] });
      merged.get(key).domains.push(rule.condition.requestDomains[0]);
    } else {
      singles.push(rule);
    }
  }

  const rules = [];
  for (const { base, domains } of merged.values()) {
    const unique = [...new Set(domains)].sort();
    for (let i = 0; i < unique.length; i += MAX_DOMAINS_PER_RULE) {
      rules.push({
        ...base,
        condition: { ...base.condition, requestDomains: unique.slice(i, i + MAX_DOMAINS_PER_RULE) },
      });
    }
  }
  rules.push(...singles);
  rules.forEach((r, i) => {
    r.id = i + 1;
  });
  // Put id first for readability.
  return {
    rules: rules.map(({ id, ...rest }) => ({ id, ...rest })),
    cosmetic,
    stats,
  };
}

/** Checks a rule against the constraints Chrome enforces when loading a static ruleset. */
export function validateRule(rule) {
  const c = rule.condition;
  if (!Number.isInteger(rule.id) || rule.id < 1) return "bad id";
  if (!["block", "allow", "allowAllRequests"].includes(rule.action.type)) return "bad action";
  if (c.urlFilter !== undefined) {
    if (c.urlFilter === "") return "empty urlFilter";
    if (/[^\x20-\x7e]/.test(c.urlFilter)) return "non-ascii urlFilter";
    if (c.urlFilter.startsWith("||*")) return "urlFilter starts with ||*";
    if (c.urlFilter.replace(/^\|\|?/, "").replace(/\|$/, "").includes("|")) return "| in middle of urlFilter";
  }
  for (const k of ["requestDomains", "initiatorDomains", "resourceTypes"]) {
    if (c[k] !== undefined && c[k].length === 0) return `empty ${k}`;
  }
  if (rule.action.type === "allowAllRequests") {
    if (!c.resourceTypes || c.resourceTypes.some((t) => t !== "main_frame" && t !== "sub_frame")) {
      return "allowAllRequests needs main_frame/sub_frame resourceTypes";
    }
  }
  if (c.resourceTypes && c.excludedResourceTypes) return "both resourceTypes and excludedResourceTypes";
  return null;
}
