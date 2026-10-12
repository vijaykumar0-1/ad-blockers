// Compiles "+js(...)" scriptlet filters into injectable scripts:
//
//   rules/scriptlets/<scriptlet>.js   one file per scriptlet: its code plus which sites use
//                                     which arguments
//   rules/scriptlets/index.json       which file runs on which sites; the service worker
//                                     registers each file for exactly those sites
//
// Only scriptlets implemented in tools/scriptlets.mjs are compiled; filters for others are
// counted and skipped. No dependencies, no network access.

import { SCRIPTLETS } from "./scriptlets.mjs";

// uBlock lists use "!#if <expr>" blocks for platform-specific filters. LocalBlock is a
// Manifest V3 Chromium extension without HTML filtering, like uBlock Origin Lite.
const ENV = {
  env_chromium: true,
  env_mv3: true,
  ext_ublock: true,
  ext_ubol: true,
  cap_user_stylesheet: true,
};

export function evalCondition(expr) {
  const js = expr
    .trim()
    .replace(/[a-z_][a-z0-9_]*/gi, (t) => (ENV[t] ? "1" : "0"))
    .replace(/\s+/g, "");
  if (!/^[01!&|()]*$/.test(js)) return false;
  try {
    return Boolean(Function(`return (${js});`)());
  } catch {
    return false;
  }
}

/** Drops lines inside "!#if" blocks whose condition is false. */
export function preparse(text) {
  const out = [];
  const stack = []; // each entry: is this block active?
  const active = () => stack.every(Boolean);
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("!#if ")) {
      stack.push(evalCondition(t.slice(5)));
    } else if (t === "!#else") {
      if (stack.length) stack.push(!stack.pop());
    } else if (t === "!#endif") {
      stack.pop();
    } else if (active()) {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Splits "a, b\, c, 'd'" into ["a", "b, c", "d"]. */
export function parseArgs(inner) {
  const args = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\\" && inner[i + 1] === ",") {
      cur += ",";
      i++;
    } else if (ch === ",") {
      args.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  args.push(cur);
  return args.map((a) => {
    a = a.trim();
    const q = a[0];
    if (a.length >= 2 && (q === "'" || q === '"' || q === "`") && a[a.length - 1] === q) {
      a = a.slice(1, -1);
    }
    return a;
  });
}

const DOMAIN_RE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * Parses the scriptlet filters out of list texts.
 * trusted: whether "trusted-" scriptlets may be used (only from uBlock's own lists).
 */
export function parseScriptletFilters(sources) {
  const byName = {}; // canonical fn name -> { include: {host: Set(argsKey)}, exclude: {...} }
  const disableAll = new Set();
  const stats = { used: 0, skipped: {} };
  const skip = (why) => (stats.skipped[why] = (stats.skipped[why] || 0) + 1);

  for (const { text, trusted } of sources) {
    for (const raw of preparse(text).split(/\n/)) {
      const m = /^([^#]*)#(@?)#\+js\((.*)\)\s*$/.exec(raw.trim());
      if (!m) continue;
      const [, domainText, at, inner] = m;
      const isException = at === "@";
      const domains = domainText
        .split(",")
        .map((d) => d.trim().toLowerCase())
        .filter(Boolean);
      const include = domains.filter((d) => !d.startsWith("~"));

      if (isException && inner.trim() === "") {
        for (const d of include) disableAll.add(d);
        continue;
      }

      const [name, ...args] = parseArgs(inner);
      const entry = SCRIPTLETS[name.replace(/\.js$/, "")];
      if (!entry) {
        skip(`unsupported:${name}`);
        continue;
      }
      if ((entry.trusted || name.startsWith("trusted-")) && !trusted) {
        skip("untrusted-source");
        continue;
      }
      if (!include.length) {
        skip(isException ? "generic-exception" : "generic");
        continue;
      }
      const hosts = include.filter((d) => DOMAIN_RE.test(d));
      if (hosts.length < include.length) skip("entity-or-bad-domain");
      if (!hosts.length) continue;

      const key = entry.fn.name;
      byName[key] ||= { entry, include: {}, exclude: {} };
      const argsKey = JSON.stringify(args);
      const target = isException ? byName[key].exclude : byName[key].include;
      for (const h of hosts) (target[h] ||= new Set()).add(argsKey);
      // Negated domains ("a.com,~b.a.com##+js(...)") act as exceptions for those hosts.
      if (!isException) {
        for (const d of domains.filter((x) => x.startsWith("~"))) {
          const h = d.slice(1);
          if (DOMAIN_RE.test(h)) (byName[key].exclude[h] ||= new Set()).add(argsKey);
        }
      }
      stats.used++;
    }
  }
  return { byName, disableAll: [...disableAll].sort(), stats };
}

// Runtime part of every generated file: decide which argument sets apply to this page.
function selectArgs(table, disableAll) {
  const labels = location.hostname.toLowerCase().split(".");
  const hosts = labels.map((_, i) => labels.slice(i).join("."));
  if (hosts.some((h) => disableAll.includes(h))) return [];
  const excluded = new Set();
  for (const h of hosts) for (const i of table.exclude[h] || []) excluded.add(i);
  const chosen = new Set();
  for (const h of hosts) for (const i of table.include[h] || []) if (!excluded.has(i)) chosen.add(i);
  return [...chosen].map((i) => table.args[i]);
}

/** Generates the source of one injectable file for one scriptlet. */
export function generateFile({ entry, include, exclude }, disableAll) {
  const args = [];
  const index = new Map();
  const idx = (k) => {
    if (!index.has(k)) {
      index.set(k, args.length);
      args.push(JSON.parse(k));
    }
    return index.get(k);
  };
  const toTable = (map) => {
    const out = {};
    for (const h of Object.keys(map).sort()) out[h] = [...map[h]].map(idx);
    return out;
  };
  const table = { include: toTable(include), exclude: toTable(exclude), args };
  const fn = entry.fn;
  const helpers = entry.helpers.map((h) => h.toString()).join("\n\n");
  return `// Generated by tools/scriptlet-build.mjs. Do not edit; run npm run build.
// Scriptlet: ${fn.name}. Runs in the page (MAIN world) on the sites listed below.
(() => {
"use strict";
const table = ${JSON.stringify(table)};
const disableAll = ${JSON.stringify(disableAll)};
${selectArgs.toString()}
${helpers}

${fn.toString()}

for (const args of selectArgs(table, disableAll)) {
  try { ${fn.name}(...args); } catch (e) { /* a broken filter must not break the page */ }
}
})();
`;
}

/** Hosts a file must be registered for (hosts with at least one non-excepted filter). */
export function hostsFor({ include }) {
  return Object.keys(include).sort();
}
