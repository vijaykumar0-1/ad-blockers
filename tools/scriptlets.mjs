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


// ---- nano-stb (nano-setTimeout-booster) ------------------------------------------------
// (needle, delay, boost): timers whose callback matches needle and whose delay equals delay
// ("*" for any) run with delay * boost. YouTube waits ~17s before playing when ads are gone.
export function nanoSetTimeoutBooster(needle, delay, boost) {
  const wantDelay = delay === undefined || delay === "" ? 1000 : delay === "*" ? null : Number(delay);
  let factor = boost === undefined || boost === "" ? 0.05 : Number(boost);
  if (!Number.isFinite(factor)) return;
  factor = Math.min(50, Math.max(0.001, factor));
  const toRe = (s) => {
    const m = /^\/(.+)\/([gimsu]*)$/.exec(s || "");
    return m ? new RegExp(m[1], m[2].replace("g", "")) : new RegExp((s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  };
  const re = toRe(needle);
  window.setTimeout = new Proxy(window.setTimeout, {
    apply(target, thisArg, args) {
      const [callback, ms] = args;
      if ((wantDelay === null || Number(ms) === wantDelay) && re.test(String(callback))) {
        args[1] = Number(ms) * factor;
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}

// ---- rpnt / rmnt (replace-node-text / remove-node-text) -------------------------------------
// Watches for <script> (or other) nodes as the page is parsed and rewrites or removes their
// text before it runs. Options: condition (text must match), excludes (skip if matches),
// sedCount (stop after this many nodes).
export function watchNodes(nodeName, pattern, options, onMatch) {
  const toRe = (s, flags) => {
    const m = /^\/(.+)\/([gimsu]*)$/.exec(s || "");
    if (m) return new RegExp(m[1], m[2]);
    return new RegExp((s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), flags);
  };
  const name = String(nodeName || "").toUpperCase();
  const re = toRe(pattern, "");
  const condition = options.condition ? toRe(options.condition, "") : null;
  const excludes = options.excludes ? toRe(options.excludes, "") : null;
  let remaining = Number(options.sedCount) > 0 ? Number(options.sedCount) : Infinity;
  const done = new WeakSet();
  const check = (node) => {
    if (!node || remaining <= 0 || done.has(node) || node.nodeName !== name) return;
    if (name === "SCRIPT" && node.src) return;
    const text = node.textContent || "";
    re.lastIndex = 0;
    if (!re.test(text)) return;
    if (condition && !condition.test(text)) return;
    if (excludes && excludes.test(text)) return;
    done.add(node);
    remaining--;
    re.lastIndex = 0;
    onMatch(node, text, re);
    if (remaining <= 0) observer.disconnect();
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) {
      for (const n of r.addedNodes) {
        // The parser may add a <script> before its text: also react when the text arrives.
        if (n.nodeType === 3) check(n.parentNode);
        else check(n);
        if (n.querySelectorAll) for (const c of n.querySelectorAll(nodeName)) check(c);
      }
    }
  });
  observer.observe(document, { childList: true, subtree: true });
  if (document.documentElement) for (const n of document.querySelectorAll(nodeName)) check(n);
}

export function replaceNodeText(nodeName, pattern, replacement, ...rest) {
  if (!nodeName || !pattern) return;
  // Sites like YouTube enforce Trusted Types, which blocks writing script text unless it goes
  // through a policy. Create one (uBlock Origin does the same); fall back to plain text.
  let policy = null;
  try {
    if (window.trustedTypes) {
      policy = window.trustedTypes.createPolicy("localblock", { createScript: (s) => s });
    }
  } catch {}
  watchNodes(nodeName, pattern, varargs(rest), (node, text, re) => {
    const out = text.replace(re, replacement || "");
    node.textContent = policy && node.nodeName === "SCRIPT" ? policy.createScript(out) : out;
  });
}

export function removeNodeText(nodeName, pattern, ...rest) {
  if (!nodeName || !pattern) return;
  watchNodes(nodeName, pattern, varargs(rest), (node) => {
    if (node.nodeName === "SCRIPT") node.remove();
    else node.textContent = "";
  });
}

// ---- trusted-prevent-dom-bypass --------------------------------------------------------------
// (method, property): pages can append a blank iframe and borrow its untouched fetch or
// JSON.parse to get around scriptlets. After method (e.g. Node.prototype.appendChild) adds
// an iframe, give the iframe this page's version of property instead.
export function preventDomBypass(methodPath, propPath) {
  if (!methodPath) return;
  const parts = methodPath.split(".");
  const method = parts.pop();
  let owner = window;
  for (const p of parts) {
    owner = owner?.[p];
    if (!owner) return;
  }
  if (typeof owner[method] !== "function") return;
  const copyInto = (win) => {
    if (!propPath) return;
    const chain = propPath.split(".");
    const last = chain.pop();
    let src = window;
    let dst = win;
    for (const p of chain) {
      src = src?.[p];
      dst = dst?.[p];
    }
    if (src && dst && src[last] !== undefined) {
      try {
        Object.defineProperty(dst, last, { value: src[last], configurable: true, writable: true });
      } catch {}
    }
  };
  owner[method] = new Proxy(owner[method], {
    apply(target, thisArg, args) {
      const result = Reflect.apply(target, thisArg, args);
      try {
        const node = args[0];
        const frames =
          node && node.nodeName === "IFRAME" ? [node] : node && node.querySelectorAll ? node.querySelectorAll("iframe") : [];
        for (const f of frames) {
          let win = null;
          try {
            win = f.contentWindow;
            void win.location.href; // throws for cross-origin frames
          } catch {
            win = null;
          }
          if (win) copyInto(win);
        }
      } catch {}
      return result;
    },
  });
}

// ---- trusted-edit-inbound-object -------------------------------------------------------
// (fnChain, argPos, query): before the page calls fnChain (e.g. JSON.stringify), apply a
// JSON-path edit to argument argPos. Supports the subset of uBlock Origin's JSON-path syntax
// its filters use: .prop steps, [?pred] filters (on arrays: keep matching elements; on objects:
// keep the object if it matches), and the edits "+={json}" (merge), "=json" (assign) and
// "=repl({regex, replacement})". Predicates: .path (exists), !.path, and .path followed by
// ==, !=, *=, ^=, $= with a JSON value, or =/regex/. "${now}" in a value becomes Date.now().
export function makeJsonEditor(query) {
  let i = 0;
  const q = String(query || "");
  const steps = [];
  const readUntilBracketEnd = () => {
    let depth = 0;
    let out = "";
    let quote = null;
    for (; i < q.length; i++) {
      const c = q[i];
      if (quote) {
        if (c === "\\") {
          out += c + q[++i];
          continue;
        }
        if (c === quote) quote = null;
      } else if (c === '"' || c === "/") {
        // a regex literal only starts right after "="
        if (c === '"' || /=$/.test(out)) quote = c;
      } else if (c === "[") depth++;
      else if (c === "]") {
        if (depth === 0) {
          i++;
          return out;
        }
        depth--;
      }
      out += c;
    }
    throw new Error("unterminated [");
  };
  const parsePath = (text) => text.split(".").filter(Boolean);
  const parsePredicate = (text) => {
    let neg = false;
    let t = text.trim();
    if (t.startsWith("!")) {
      neg = true;
      t = t.slice(1);
    }
    if (!t.startsWith(".")) throw new Error("bad predicate");
    const m = /^((?:\.[\w$-]+)+)\s*(?:(==|!=|\*=|\^=|\$=|=)\s*(.+))?$/s.exec(t);
    if (!m) throw new Error("bad predicate");
    const path = parsePath(m[1]);
    const op = m[2];
    let test;
    if (!op) test = (v) => v !== undefined;
    else if (op === "=") {
      const r = /^\/(.+)\/([imsu]*)$/s.exec(m[3]);
      if (!r) throw new Error("bad regex");
      const re = new RegExp(r[1], r[2]);
      test = (v) => typeof v === "string" && re.test(v);
    } else {
      const want = JSON.parse(m[3]);
      test = {
        "==": (v) => v === want,
        "!=": (v) => v !== want,
        "*=": (v) => typeof v === "string" && v.includes(want),
        "^=": (v) => typeof v === "string" && v.startsWith(want),
        "$=": (v) => typeof v === "string" && v.endsWith(want),
      }[op];
    }
    return (node) => {
      let v = node;
      for (const k of path) v = v !== null && typeof v === "object" ? v[k] : undefined;
      return neg ? !test(v) : test(v);
    };
  };

  // steps
  let opText = null;
  while (i < q.length) {
    if (q.startsWith("[?", i)) {
      i += 2;
      steps.push({ filter: parsePredicate(readUntilBracketEnd()) });
    } else if (q.startsWith("..", i)) {
      throw new Error("recursive paths are not supported");
    } else if (q[i] === ".") {
      const m = /^\.([\w$-]+)/.exec(q.slice(i));
      if (!m) throw new Error("bad step");
      steps.push({ prop: m[1] });
      i += m[0].length;
    } else if (q.startsWith("+=", i) || q[i] === "=") {
      opText = q.slice(i);
      break;
    } else {
      throw new Error(`unexpected "${q[i]}"`);
    }
  }
  if (!opText) throw new Error("no edit");

  const fillNow = (v) =>
    typeof v === "string" ? v.replace(/\$\{now\}/g, String(Date.now())) : v;
  let edit;
  if (opText.startsWith("+=")) {
    const patch = JSON.parse(opText.slice(2));
    if (patch === null || typeof patch !== "object") throw new Error("+= needs an object");
    // merge into the selected objects
    edit = { merge: patch };
  } else {
    const rhs = opText.slice(1);
    const repl = /^repl\((.*)\)$/s.exec(rhs);
    if (repl) {
      const spec = JSON.parse(repl[1]);
      const re = new RegExp(spec.regex, spec.flags || "");
      edit = { replace: (old) => (typeof old === "string" ? old.replace(re, spec.replacement ?? "") : old) };
    } else {
      const value = JSON.parse(rhs);
      edit = { replace: () => fillNow(value) };
    }
  }
  // With "=", the last .prop step names the property to set.
  let setKey = null;
  if (edit.replace) {
    const last = steps[steps.length - 1];
    if (!last || !last.prop) throw new Error("= needs a property");
    setKey = steps.pop().prop;
  }

  const select = (root) => {
    let nodes = [root];
    for (const step of steps) {
      const next = [];
      for (const n of nodes) {
        if (n === null || typeof n !== "object") continue;
        if (step.prop !== undefined) {
          if (n[step.prop] !== undefined) next.push(n[step.prop]);
        } else if (Array.isArray(n)) {
          for (const el of n) if (step.filter(el)) next.push(el);
        } else if (step.filter(n)) {
          next.push(n);
        }
      }
      nodes = next;
      if (!nodes.length) return nodes;
    }
    return nodes.filter((n) => n !== null && typeof n === "object");
  };
  const apply = (root) => {
    const nodes = select(root);
    let changed = false;
    for (const n of nodes) {
      if (n === null || typeof n !== "object") continue;
      if (edit.merge) {
        Object.assign(n, JSON.parse(JSON.stringify(edit.merge)));
        changed = true;
      } else {
        n[setKey] = edit.replace(n[setKey]);
        changed = true;
      }
    }
    return changed;
  };
  apply.matches = (root) => select(root).length > 0;
  return apply;
}

export function editInboundObject(fnChain, argPos, query) {
  if (!fnChain || !query) return;
  let editor;
  try {
    editor = makeJsonEditor(query);
  } catch {
    return; // syntax we do not support: do nothing rather than guess
  }
  const pos = Number(argPos) || 0;
  const parts = fnChain.split(".");
  const name = parts.pop();
  let owner = window;
  for (const p of parts) {
    owner = owner?.[p];
    if (!owner) return;
  }
  const original = owner[name];
  if (typeof original !== "function") return;
  // Edit a copy, so the page's own object stays as it was.
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const clone = (v) => Reflect.apply(parse, JSON, [Reflect.apply(stringify, JSON, [v])]);
  owner[name] = new Proxy(original, {
    apply(target, thisArg, args) {
      const arg = args[pos];
      if (arg !== null && typeof arg === "object") {
        try {
          if (!editor.matches(arg)) return Reflect.apply(target, thisArg, args);
          const copy = clone(arg);
          if (editor(copy)) {
            args = args.slice();
            args[pos] = copy;
          }
        } catch {}
      }
      return Reflect.apply(target, thisArg, args);
    },
  });
}

// ---- popup and click-hijack defusers ------------------------------------------------------
// Shared: "" matches everything, "/re/flags" is a regex, otherwise a plain substring; a
// leading "!" inverts the test.
export function makeNeedle(spec) {
  let s = String(spec ?? "");
  let invert = false;
  if (s.startsWith("!")) {
    invert = true;
    s = s.slice(1);
  }
  let test;
  if (s === "") test = () => true;
  else {
    const m = /^\/(.+)\/([gimsu]*)$/.exec(s);
    const re = m ? new RegExp(m[1], m[2].replace("g", "")) : null;
    test = re ? (t) => re.test(t) : (t) => t.includes(s);
  }
  return (text) => test(String(text)) !== invert;
}

// Walks "a.b.c" on window and calls onTrap(owner, prop) on the last link, trapping parents
// that do not exist yet so it still works when the page creates them later.
export function trapChainWith(chain, onTrap) {
  const walk = (owner, rest) => {
    const pos = rest.indexOf(".");
    if (pos === -1) {
      onTrap(owner, rest);
      return;
    }
    const prop = rest.slice(0, pos);
    const tail = rest.slice(pos + 1);
    let current = owner[prop];
    if (current !== null && (typeof current === "object" || typeof current === "function")) {
      walk(current, tail);
      return;
    }
    const desc = Object.getOwnPropertyDescriptor(owner, prop);
    if (desc && desc.configurable === false) return;
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        get: () => current,
        set: (v) => {
          current = v;
          if (v !== null && (typeof v === "object" || typeof v === "function")) walk(v, tail);
        },
      });
    } catch {}
  };
  walk(window, chain);
}

// aopr (abort-on-property-read): reading window.<chain> throws, which stops the ad script
// that reads it.
export function abortOnPropertyRead(chain) {
  if (!chain) return;
  const magic = "LocalBlock-" + Math.random().toString(36).slice(2);
  trapChainWith(chain, (owner, prop) => {
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        get: () => {
          throw new ReferenceError(magic);
        },
        set: () => {},
      });
    } catch {}
  });
}

// aopw (abort-on-property-write): assigning window.<chain> throws.
export function abortOnPropertyWrite(chain) {
  if (!chain) return;
  const magic = "LocalBlock-" + Math.random().toString(36).slice(2);
  trapChainWith(chain, (owner, prop) => {
    try {
      Object.defineProperty(owner, prop, {
        configurable: true,
        get: () => undefined,
        set: () => {
          throw new ReferenceError(magic);
        },
      });
    } catch {}
  });
}

// acs (abort-current-script): reading window.<chain> throws, but only from a script whose
// text (or src) matches needle, so the site's own scripts keep working.
export function abortCurrentScript(chain, needle) {
  if (!chain) return;
  const matches = makeNeedle(needle);
  const magic = "LocalBlock-" + Math.random().toString(36).slice(2);
  const parts = chain.split(".");
  const last = parts.pop();
  let owner = window;
  for (const p of parts) {
    owner = owner?.[p];
    if (owner === null || owner === undefined) return;
  }
  const desc = Object.getOwnPropertyDescriptor(owner, last);
  if (desc && desc.configurable === false) return;
  let value = owner[last];
  const getter = desc && desc.get;
  const setter = desc && desc.set;
  const shouldAbort = () => {
    const script = document.currentScript;
    if (!script) return false;
    const text = script.src ? script.src : script.textContent || "";
    return matches(text);
  };
  try {
    Object.defineProperty(owner, last, {
      configurable: true,
      get() {
        if (shouldAbort()) throw new ReferenceError(magic);
        return getter ? getter.call(this) : value;
      },
      set(v) {
        if (shouldAbort()) throw new ReferenceError(magic);
        if (setter) setter.call(this, v);
        else value = v;
      },
    });
  } catch {}
}

// aeld (addEventListener-defuser): drop event listeners whose type and handler code match.
export function addEventListenerDefuser(type, pattern) {
  const typeOk = makeNeedle(type);
  const codeOk = makeNeedle(pattern);
  const proto = window.EventTarget && window.EventTarget.prototype;
  if (!proto) return;
  proto.addEventListener = new Proxy(proto.addEventListener, {
    apply(target, thisArg, args) {
      const [t, handler] = args;
      let code = "";
      try {
        code = typeof handler === "function" ? Function.prototype.toString.call(handler) : String(handler?.handleEvent || "");
      } catch {}
      if (typeOk(t) && codeOk(code)) return undefined;
      return Reflect.apply(target, thisArg, args);
    },
  });
}

// nostif (no-setTimeout-if): don't schedule timers whose callback matches needle (and delay,
// if given). Used to stop delayed redirects.
export function noSetTimeoutIf(needle, delay) {
  const matches = makeNeedle(needle);
  let wantDelay = null;
  let invertDelay = false;
  if (delay !== undefined && delay !== "") {
    let d = String(delay);
    if (d.startsWith("!")) {
      invertDelay = true;
      d = d.slice(1);
    }
    wantDelay = Number(d);
    if (!Number.isFinite(wantDelay)) wantDelay = null;
  }
  window.setTimeout = new Proxy(window.setTimeout, {
    apply(target, thisArg, args) {
      const [cb, ms] = args;
      let code = "";
      try {
        code = typeof cb === "function" ? Function.prototype.toString.call(cb) : String(cb);
      } catch {}
      const delayOk = wantDelay === null || (Number(ms) === wantDelay) !== invertDelay;
      if (matches(code) && delayOk) return 0;
      return Reflect.apply(target, thisArg, args);
    },
  });
}

// nowoif (no-window-open-if): window.open() for matching URLs returns a harmless fake window
// instead of opening a popup or popunder.
export function noWindowOpenIf(pattern) {
  const matches = makeNeedle(pattern);
  const noop = () => {};
  const fakeWindow = () => {
    const target = { closed: false, location: { href: "about:blank" }, document: {}, opener: null };
    return new Proxy(target, {
      get(t, prop) {
        if (prop in t) return t[prop];
        if (prop === "window" || prop === "self") return t;
        return noop;
      },
      set: () => true,
    });
  };
  window.open = new Proxy(window.open, {
    apply(target, thisArg, args) {
      const url = args[0] === undefined ? "" : String(args[0]);
      if (matches(url)) return fakeWindow();
      return Reflect.apply(target, thisArg, args);
    },
  });
}

// lb-no-anchor-click-if (LocalBlock's own): ignore script-triggered clicks on links whose
// URL matches needle. Popunder scripts create a hidden <a target="_blank"> and click it
// during the user's real click, which slips past popup blockers.
export function noAnchorClickIf(needle) {
  const matches = makeNeedle(needle);
  const proto = window.HTMLElement && window.HTMLElement.prototype;
  if (!proto) return;
  const isBadLink = (el) => {
    const a = el && el.closest ? el.closest("a[href]") : null;
    return !!a && matches(a.href || a.getAttribute("href") || "");
  };
  proto.click = new Proxy(proto.click, {
    apply(target, thisArg, args) {
      if (isBadLink(thisArg)) return undefined;
      return Reflect.apply(target, thisArg, args);
    },
  });
  const ET = window.EventTarget && window.EventTarget.prototype;
  if (ET) {
    ET.dispatchEvent = new Proxy(ET.dispatchEvent, {
      apply(target, thisArg, args) {
        const ev = args[0];
        if (ev && ev.type === "click" && isBadLink(thisArg)) return false;
        return Reflect.apply(target, thisArg, args);
      },
    });
  }
}

// ---- registry --------------------------------------------------------------------------
// name in filters -> { fn, helpers the fn needs, trusted: only from uBlock Origin's own lists }
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
    trusted: true,
  },
  "trusted-rpfr": { fn: replaceFetchResponse, helpers: [makeRequestMatcher, makeReplacer, hookFetch], trusted: true },
  "trusted-replace-xhr-response": {
    fn: replaceXhrResponse,
    helpers: [makeRequestMatcher, makeReplacer, hookXhr],
    trusted: true,
  },
  "nano-stb": { fn: nanoSetTimeoutBooster, helpers: [] },
  "nano-setTimeout-booster": { fn: nanoSetTimeoutBooster, helpers: [] },
  // Rewriting a page's own scripts is powerful, so like uBlock Origin we only take it from trusted lists.
  rpnt: { fn: replaceNodeText, helpers: [varargs, watchNodes], trusted: true },
  "replace-node-text": { fn: replaceNodeText, helpers: [varargs, watchNodes], trusted: true },
  "trusted-rpnt": { fn: replaceNodeText, helpers: [varargs, watchNodes], trusted: true },
  rmnt: { fn: removeNodeText, helpers: [varargs, watchNodes] },
  "remove-node-text": { fn: removeNodeText, helpers: [varargs, watchNodes] },
  "trusted-prevent-dom-bypass": { fn: preventDomBypass, helpers: [], trusted: true },
  "trusted-edit-inbound-object": { fn: editInboundObject, helpers: [makeJsonEditor], trusted: true },
  aopr: { fn: abortOnPropertyRead, helpers: [trapChainWith] },
  "abort-on-property-read": { fn: abortOnPropertyRead, helpers: [trapChainWith] },
  aopw: { fn: abortOnPropertyWrite, helpers: [trapChainWith] },
  "abort-on-property-write": { fn: abortOnPropertyWrite, helpers: [trapChainWith] },
  acs: { fn: abortCurrentScript, helpers: [makeNeedle] },
  "abort-current-script": { fn: abortCurrentScript, helpers: [makeNeedle] },
  aeld: { fn: addEventListenerDefuser, helpers: [makeNeedle] },
  "addEventListener-defuser": { fn: addEventListenerDefuser, helpers: [makeNeedle] },
  nostif: { fn: noSetTimeoutIf, helpers: [makeNeedle] },
  "no-setTimeout-if": { fn: noSetTimeoutIf, helpers: [makeNeedle] },
  nowoif: { fn: noWindowOpenIf, helpers: [makeNeedle] },
  "no-window-open-if": { fn: noWindowOpenIf, helpers: [makeNeedle] },
  "lb-no-anchor-click-if": { fn: noAnchorClickIf, helpers: [makeNeedle] },
};

export { makeJsonPruner };
