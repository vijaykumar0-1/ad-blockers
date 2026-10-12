// Scriptlets: small functions that run inside a web page (Chrome's MAIN world) before the
// page's own scripts, to remove ads that network and CSS rules cannot reach, such as the ad
// data YouTube's player receives together with the video.
//
// Each function is self-contained: the build copies its source text into a generated file,
// so it must not use anything from this module. They are driven by "+js(...)" filters from
// uBlock Origin's community lists, using the same names and arguments.
//
// Semantics follow uBlock Origin's scriptlets of the same names (GPL-3.0,
// github.com/gorhill/uBlock); the implementations here are written for LocalBlock.

/* eslint-disable no-new-func */

// ---- set (set-constant) ----------------------------------------------------
// set(chain, value): make window.<chain> always read as value, even if the page assigns
// the parent objects later.
export function setConstant(chain, rawValue) {
  if (!chain) return;
  const values = {
    undefined: undefined,
    false: false,
    true: true,
    null: null,
    "": "",
    "''": "",
    noopFunc: function () {},
    trueFunc: () => true,
    falseFunc: () => false,
    emptyArr: () => [],
    emptyObj: () => ({}),
    "[]": () => [],
    "{}": () => ({}),
  };
  let value;
  if (Object.prototype.hasOwnProperty.call(values, rawValue)) {
    value = values[rawValue];
    if (rawValue === "emptyArr" || rawValue === "[]") value = [];
    if (rawValue === "emptyObj" || rawValue === "{}") value = {};
  } else if (/^-?\d+$/.test(rawValue) && Math.abs(Number(rawValue)) <= 0x7fff) {
    value = Number(rawValue);
  } else {
    return; // unsupported value
  }

  const trapProp = (owner, prop) => {
    const desc = Object.getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        enumerable: desc ? desc.enumerable : true,
        get: () => value,
        set: () => {},
      });
    } catch {}
  };

  const trapChain = (owner, chain) => {
    const pos = chain.indexOf(".");
    if (pos === -1) {
      trapProp(owner, chain);
      return;
    }
    const prop = chain.slice(0, pos);
    const rest = chain.slice(pos + 1);
    let current = owner[prop];
    if (current !== null && (typeof current === "object" || typeof current === "function")) {
      trapChain(current, rest);
      return;
    }
    const desc = Object.getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    if (desc && desc.get) {
      // Already trapped (e.g. by another set filter on the same object): chain onto it.
      const oldGet = desc.get;
      const oldSet = desc.set;
      try {
        Object.defineProperty(owner, prop, {
          configurable: true,
          enumerable: desc.enumerable,
          get: oldGet,
          set(v) {
            if (oldSet) oldSet.call(this, v);
            const cur = oldGet.call(this);
            if (cur !== null && (typeof cur === "object" || typeof cur === "function")) trapChain(cur, rest);
          },
        });
      } catch {}
      return;
    }
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        enumerable: true,
        get: () => current,
        set: (v) => {
          current = v;
          if (v !== null && (typeof v === "object" || typeof v === "function")) trapChain(v, rest);
        },
      });
    } catch {}
  };

  trapChain(window, chain);
}

// ---- shared helpers, inlined into the scriptlets that use them ----------------

// Removes the given property paths from obj. Paths are dot-separated; "[]" walks every
// array element, "[-]" removes array elements that contain the rest of the path, "*" walks
// every key. Returns true if anything was removed.
export function prunePaths(obj, paths) {
  let changed = false;
  const walk = (node, parts, i) => {
    if (node === null || typeof node !== "object") return false;
    const part = parts[i];
    const last = i === parts.length - 1;
    if (part === "[]" || part === "*") {
      if (last) return false;
      let found = false;
      for (const key of Object.keys(node)) if (walk(node[key], parts, i + 1)) found = true;
      return found;
    }
    if (part === "[-]") {
      if (!Array.isArray(node) || last) return false;
      const has = (el) => {
        let n = el;
        for (let j = i + 1; j < parts.length; j++) {
          if (n === null || typeof n !== "object" || !(parts[j] in n)) return false;
          n = n[parts[j]];
        }
        return true;
      };
      let found = false;
      for (let k = node.length - 1; k >= 0; k--) {
        if (has(node[k])) {
          node.splice(k, 1);
          found = true;
        }
      }
      return found;
    }
    if (!(part in node)) return false;
    if (last) {
      delete node[part];
      return true;
    }
    return walk(node[part], parts, i + 1);
  };
  for (const path of paths) if (walk(obj, path.split("."), 0)) changed = true;
  return changed;
}

export function hasPaths(obj, paths) {
  return paths.every((path) => {
    let n = obj;
    for (const part of path.split(".")) {
      if (part === "[]" || part === "*") return true; // treat wildcards as present
      if (n === null || typeof n !== "object" || !(part in n)) return false;
      n = n[part];
    }
    return true;
  });
}

// Builds a test for "propsToMatch": "url:/regex/", "/regex/", "method:POST" or a plain
// substring of the URL. Several conditions may be space-separated; all must match.
export function makeRequestMatcher(spec) {
  const toRe = (s) => {
    const m = /^\/(.+)\/([gimsu]*)$/.exec(s);
    if (m) return new RegExp(m[1], m[2].replace("g", ""));
    return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  };
  const tests = [];
  for (const raw of String(spec || "").split(/\s+/).filter(Boolean)) {
    const m = /^(url|method):(.+)$/.exec(raw);
    const key = m ? m[1] : "url";
    const re = toRe(m ? m[2] : raw);
    tests.push((req) => re.test(req[key] || ""));
  }
  return (req) => tests.every((t) => t(req));
}

export function makeReplacer(pattern, replacement) {
  let re;
  const m = /^\/(.+)\/([gimsu]*)$/.exec(pattern);
  if (m) re = new RegExp(m[1], m[2].includes("g") ? m[2] : m[2] + "g");
  else re = new RegExp(pattern.replace(/^'(.*)'$/, "$1").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  const rep = String(replacement ?? "").replace(/^'(.*)'$/, "$1");
  return (text) => text.replace(re, rep);
}

// Reads trailing "name, value" pairs, e.g. "propsToMatch, /player?".
export function varargs(list) {
  const out = {};
  for (let i = 0; i + 1 < list.length; i += 2) out[list[i]] = list[i + 1];
  return out;
}

// Wraps fetch so that responses to matching requests are rewritten by transformText.
export function hookFetch(matches, transformText) {
  const original = window.fetch;
  if (typeof original !== "function") return;
  window.fetch = new Proxy(original, {
    apply(target, thisArg, args) {
      const promise = Reflect.apply(target, thisArg, args);
      let req;
      try {
        const input = args[0];
        const url = input instanceof Request ? input.url : String(input);
        const method = (args[1] && args[1].method) || (input instanceof Request ? input.method : "GET");
        req = { url, method: String(method).toUpperCase() };
      } catch {
        return promise;
      }
      if (!matches(req)) return promise;
      return promise.then((response) =>
        response
          .clone()
          .text()
          .then((text) => {
            const out = transformText(text);
            if (out === text) return response;
            const patched = new Response(out, {
              status: response.status,
              statusText: response.statusText,
              headers: response.headers,
            });
            Object.defineProperties(patched, {
              url: { value: response.url },
              type: { value: response.type },
              redirected: { value: response.redirected },
            });
            return patched;
          })
          .catch(() => response)
      );
    },
  });
}

// Replaces XMLHttpRequest so that responses to matching requests are rewritten.
export function hookXhr(matches, transformText) {
  const Original = window.XMLHttpRequest;
  if (typeof Original !== "function") return;
  const state = new WeakMap();
  window.XMLHttpRequest = class extends Original {
    open(method, url, ...rest) {
      try {
        state.set(this, { req: { url: String(new URL(url, location.href)), method: String(method).toUpperCase() } });
      } catch {}
      return super.open(method, url, ...rest);
    }
    get response() {
      const r = super.response;
      const s = state.get(this);
      if (!s || this.readyState !== 4 || !matches(s.req)) return r;
      if (this.responseType !== "" && this.responseType !== "text") return r;
      if (s.out === undefined) s.out = transformText(super.responseText);
      return s.out;
    }
    get responseText() {
      const r = super.responseText;
      const s = state.get(this);
      if (!s || this.readyState !== 4 || !matches(s.req)) return r;
      if (s.out === undefined) s.out = transformText(r);
      return s.out;
    }
  };
}

// ---- json-prune -----------------------------------------------------------------
// json-prune(pathsToRemove, requiredPaths): strip paths from objects produced by JSON.parse
// and Response.json().
export function jsonPrune(remove, required) {
  const paths = String(remove || "").split(/\s+/).filter(Boolean);
  const need = String(required || "").split(/\s+/).filter(Boolean);
  if (!paths.length) return;
  const prune = (obj) => {
    if (hasPaths(obj, need)) prunePaths(obj, paths);
    return obj;
  };
  JSON.parse = new Proxy(JSON.parse, {
    apply: (target, thisArg, args) => prune(Reflect.apply(target, thisArg, args)),
  });
  Response.prototype.json = new Proxy(Response.prototype.json, {
    apply: (target, thisArg, args) => Reflect.apply(target, thisArg, args).then(prune),
  });
}

// ---- json-prune-fetch-response / json-prune-xhr-response ------------------------------
function makeJsonPruner(remove, required) {
  const paths = String(remove || "").split(/\s+/).filter(Boolean);
  const need = String(required || "").split(/\s+/).filter(Boolean);
  return (text) => {
    let obj;
    try {
      obj = JSON.parse(text);
    } catch {
      return text;
    }
    if (!hasPaths(obj, need) || !prunePaths(obj, paths)) return text;
    return JSON.stringify(obj);
  };
}

export function jsonPruneFetchResponse(remove, required, ...rest) {
  if (!remove) return;
  hookFetch(makeRequestMatcher(varargs(rest).propsToMatch), makeJsonPruner(remove, required));
}

export function jsonPruneXhrResponse(remove, required, ...rest) {
  if (!remove) return;
  hookXhr(makeRequestMatcher(varargs(rest).propsToMatch), makeJsonPruner(remove, required));
}

// ---- trusted-replace-fetch-response / trusted-replace-xhr-response -------------------
// (pattern, replacement, propsToMatch): text replacement in matching responses.
export function replaceFetchResponse(pattern, replacement, propsToMatch) {
  if (!pattern) return;
  hookFetch(makeRequestMatcher(propsToMatch), makeReplacer(pattern, replacement));
}

export function replaceXhrResponse(pattern, replacement, propsToMatch) {
  if (!pattern) return;
  hookXhr(makeRequestMatcher(propsToMatch), makeReplacer(pattern, replacement));
}

// ---- registry --------------------------------------------------------------------------
// name in filters -> { fn, helpers the fn needs }
export const SCRIPTLETS = {
  set: { fn: setConstant, helpers: [] },
  "set-constant": { fn: setConstant, helpers: [] },
  "json-prune": { fn: jsonPrune, helpers: [prunePaths, hasPaths] },
  "json-prune-fetch-response": {
    fn: jsonPruneFetchResponse,
    helpers: [prunePaths, hasPaths, makeRequestMatcher, varargs, hookFetch, makeJsonPruner],
  },
  "json-prune-xhr-response": {
    fn: jsonPruneXhrResponse,
    helpers: [prunePaths, hasPaths, makeRequestMatcher, varargs, hookXhr, makeJsonPruner],
  },
  "trusted-replace-fetch-response": {
    fn: replaceFetchResponse,
    helpers: [makeRequestMatcher, makeReplacer, hookFetch],
  },
  "trusted-rpfr": { fn: replaceFetchResponse, helpers: [makeRequestMatcher, makeReplacer, hookFetch] },
  "trusted-replace-xhr-response": {
    fn: replaceXhrResponse,
    helpers: [makeRequestMatcher, makeReplacer, hookXhr],
  },
};

export { makeJsonPruner };
