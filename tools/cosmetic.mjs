// Compiles cosmetic (element hiding) filters from ABP-syntax lists into rules/cosmetic.json.
//
//   ##sel              generic: hide on every site
//   a.com,b.com##sel   specific: hide on those sites (and their subdomains)
//   ~a.com##sel        generic, except on a.com
//   a.com#@#sel        exception: do not hide sel on a.com
//   #?#sel             same as ## when sel is plain CSS (e.g. :has); procedural filters skipped
//   @@||a.com^$generichide / $elemhide   turn off generic / all hiding on a.com
//
// Generic selectors that start with a class or id are "keyed": the content script only asks
// for them once it has seen that class or id on the page, which keeps pages fast.
// No dependencies, no network access.

const SEPARATOR = /^(.*?)(#@?#|#@?\?#|#@?\$#|#@?%#|#@?\$\?#)(.+)$/;

// Selector extensions that are not CSS. Filters using them need JavaScript and are skipped.
const PROCEDURAL = /:(-abp-[a-z-]+|has-text|contains|xpath|upward|remove|remove-attr|remove-class|style|matches-attr|matches-css(-before|-after)?|matches-media|matches-path|matches-prop|min-text-length|watch-attr|others|if|if-not|nth-ancestor|shadow)\(|:remove\(\)/;

// The procedural operators LocalBlock supports, on site-specific filters only:
//   sel:style(declarations)          -> CSS
//   sel:remove-attr(name)            -> remove an attribute (e.g. unlock a disabled button)
//   sel:remove-class(name)           -> remove a class
//   sel:watch-attr(attrs):remove-... -> the same, re-applied whenever the page sets them again
// Names may be "a|b" or a /regex/.
export function parseAction(selector) {
  const style = /^(.+?):style\((.+)\)$/s.exec(selector);
  if (style) {
    const [, sel, decls] = style;
    if (PROCEDURAL.test(sel) || /url\(|[{}\\]|@import|expression/i.test(decls)) return null;
    return { t: "style", s: sel, a: decls.trim() };
  }
  const rm = /^(.+?)(?::watch-attr\(([^)]*)\))?:(remove-attr|remove-class)\((.+)\)$/s.exec(selector);
  if (rm) {
    const [, sel, watch, op, arg] = rm;
    if (PROCEDURAL.test(sel) || !arg.trim()) return null;
    return { t: op, s: sel, a: arg.trim(), ...(watch !== undefined ? { w: watch.trim() || "*" } : {}) };
  }
  return null;
}

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.\*)?$/;

/** Returns ".class" or "#id" if every match of sel must carry that class/id, else null. */
export function selectorKey(sel) {
  if (sel.includes(",")) return null;
  const m = /^([.#])((?:[A-Za-z_]|-[A-Za-z_-])[\w-]*)(?=$|[\s.#:[>+~])/.exec(sel);
  return m ? m[1] + m[2] : null;
}

function parseDomains(text) {
  const include = [];
  const exclude = [];
  for (let d of text.split(",")) {
    d = d.trim().toLowerCase();
    if (!d) continue;
    const neg = d.startsWith("~");
    if (neg) d = d.slice(1);
    if (!DOMAIN_RE.test(d)) return null;
    (neg ? exclude : include).push(d);
  }
  return { include, exclude };
}

function push(map, key, value) {
  (map[key] ||= []).push(value);
}

export function compileCosmetic(listTexts) {
  const genericSet = new Set();
  const genericExceptions = new Set();
  const specific = {};
  const exceptions = {};
  const genericHide = new Set();
  const elemHide = new Set();
  const procedural = {};
  const stats = { generic: 0, specific: 0, exceptions: 0, skipped: {} };
  const skip = (why) => (stats.skipped[why] = (stats.skipped[why] || 0) + 1);

  for (const text of listTexts) {
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("!") || line.startsWith("[")) continue;

      // Network exceptions that switch hiding off for a site.
      const off = /^@@\|\|([a-z0-9.-]+)\^?\$(.+)$/i.exec(line);
      if (off) {
        const opts = off[2].toLowerCase().split(",");
        const host = off[1].toLowerCase();
        if (opts.includes("elemhide") || opts.includes("ehide")) elemHide.add(host);
        if (opts.includes("generichide") || opts.includes("ghide")) genericHide.add(host);
        continue;
      }

      const m = SEPARATOR.exec(line);
      if (!m) continue; // a network filter
      const [, domainText, sep, selector] = m;
      const isException = sep.includes("@");
      if (sep.includes("$") || sep.includes("%")) {
        skip("snippet");
        continue;
      }
      if (selector.startsWith("+js(")) {
        skip("scriptlet");
        continue;
      }
      if (selector.startsWith("^")) {
        skip("html-filter");
        continue;
      }
      if (PROCEDURAL.test(selector)) {
        const action = !isException && parseAction(selector);
        const actDomains = action && parseDomains(domainText);
        if (action && actDomains && actDomains.include.length) {
          for (const d of actDomains.include) push(procedural, d, action);
          stats.procedural = (stats.procedural || 0) + 1;
        } else {
          skip("procedural");
        }
        continue;
      }
      if (/[{}]/.test(selector) || /[^\x20-\x7e]/.test(selector)) {
        skip("invalid");
        continue;
      }

      const domains = parseDomains(domainText);
      if (!domains) {
        skip("domain-syntax");
        continue;
      }

      if (isException) {
        if (!domains.include.length) genericExceptions.add(selector);
        for (const d of domains.include) push(exceptions, d, selector);
        stats.exceptions++;
        continue;
      }

      if (domains.include.length) {
        for (const d of domains.include) push(specific, d, selector);
        // "a.com,~b.a.com##x": hide on a.com but not on b.a.com.
        for (const d of domains.exclude) push(exceptions, d, selector);
        stats.specific++;
      } else {
        genericSet.add(selector);
        for (const d of domains.exclude) push(exceptions, d, selector);
        stats.generic++;
      }
    }
  }

  const keyed = {};
  const unkeyed = [];
  for (const sel of [...genericSet].sort()) {
    if (genericExceptions.has(sel)) continue;
    const key = selectorKey(sel);
    if (key) push(keyed, key, sel);
    else unkeyed.push(sel);
  }

  const dedupe = (map) => {
    for (const k of Object.keys(map)) map[k] = [...new Set(map[k])];
    return map;
  };

  return {
    data: {
      generic: { keyed, unkeyed },
      specific: dedupe(specific),
      exceptions: dedupe(exceptions),
      genericHide: [...genericHide].sort(),
      elemHide: [...elemHide].sort(),
      procedural: Object.fromEntries(
        Object.entries(procedural).map(([h, list]) => [h, [...new Map(list.map((a) => [JSON.stringify(a), a])).values()]])
      ),
    },
    stats,
  };
}
