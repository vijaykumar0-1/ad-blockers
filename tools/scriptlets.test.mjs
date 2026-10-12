import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { prunePaths, makeRequestMatcher } from "./scriptlets.mjs";
import { evalCondition, generateFile, parseArgs, parseScriptletFilters, preparse } from "./scriptlet-build.mjs";

// Builds the generated files for a filter list and runs them in a fake page.
function page(hostname, filters, extra = {}) {
  const { byName, disableAll } = parseScriptletFilters([{ text: filters, trusted: true }]);
  const ctx = {
    location: { hostname, href: `https://${hostname}/` },
    Response,
    Request,
    URL,
    console,
    ...extra,
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  for (const group of Object.values(byName)) vm.runInContext(generateFile(group, disableAll), ctx);
  return ctx;
}

const playerJson = () =>
  JSON.stringify({ adPlacements: [1], adSlots: [2], playerAds: [3], videoDetails: { videoId: "v" } });

test("argument parsing", () => {
  assert.deepEqual(parseArgs("set, a.b, undefined"), ["set", "a.b", "undefined"]);
  assert.deepEqual(parseArgs("x, /a{2\\,4}/, '\"q\"'"), ["x", "/a{2,4}/", '"q"']);
});

test("preparser keeps only blocks for MV3 Chromium", () => {
  assert.equal(evalCondition("env_chromium"), true);
  assert.equal(evalCondition("env_firefox"), false);
  assert.equal(evalCondition("!env_firefox && env_mv3"), true);
  const text = ["a", "!#if env_firefox", "b", "!#else", "c", "!#endif", "!#if cap_html_filtering", "d", "!#endif"].join("\n");
  assert.deepEqual(preparse(text).split("\n"), ["a", "c"]);
});

test("prunePaths handles [] and [-]", () => {
  const o = { a: [{ ad: 1, x: 1 }, { x: 2 }], entries: [{ isAd: true }, { ok: 1 }] };
  assert.equal(prunePaths(o, ["a.[].ad", "entries.[-].isAd"]), true);
  assert.deepEqual(o, { a: [{ x: 1 }, { x: 2 }], entries: [{ ok: 1 }] });
  assert.equal(prunePaths(o, ["missing.path"]), false);
});

test("request matcher", () => {
  assert.ok(makeRequestMatcher("url:/\\/player(\\?|$)/")({ url: "https://y.com/youtubei/v1/player?x=1" }));
  assert.ok(makeRequestMatcher("player?")({ url: "https://y.com/v1/player?x" }));
  assert.ok(!makeRequestMatcher("player?")({ url: "https://y.com/v1/next" }));
});

test("set: several filters on the same object all apply, before and after assignment", () => {
  const ctx = page(
    "www.youtube.com",
    [
      "www.youtube.com##+js(set, ytInitialPlayerResponse.adPlacements, undefined)",
      "www.youtube.com##+js(set, ytInitialPlayerResponse.playerAds, undefined)",
      "www.youtube.com##+js(set, flags.ads, false)",
    ].join("\n")
  );
  vm.runInContext("window.ytInitialPlayerResponse = { adPlacements: [1], playerAds: [2], keep: 3 }", ctx);
  assert.equal(vm.runInContext("ytInitialPlayerResponse.adPlacements", ctx), undefined);
  assert.equal(vm.runInContext("ytInitialPlayerResponse.playerAds", ctx), undefined);
  assert.equal(vm.runInContext("ytInitialPlayerResponse.keep", ctx), 3);
  vm.runInContext("window.flags = { ads: true }; flags.ads = true", ctx);
  assert.equal(vm.runInContext("flags.ads", ctx), false);
});

test("json-prune strips JSON.parse results", () => {
  const ctx = page("m.youtube.com", "m.youtube.com##+js(json-prune, adPlacements playerAds adSlots)");
  const out = vm.runInContext(`JSON.parse(${JSON.stringify(playerJson())})`, ctx);
  assert.deepEqual(Object.keys(out), ["videoDetails"]);
});

test("json-prune-fetch-response only touches matching requests", async () => {
  const ctx = page(
    "www.youtube.com",
    "www.youtube.com##+js(json-prune-fetch-response, adPlacements adSlots, , propsToMatch, /\\/player(\\?|$)/)",
    { fetch: async () => new Response(playerJson()) }
  );
  const player = JSON.parse(await vm.runInContext(`fetch("https://www.youtube.com/youtubei/v1/player?a=1").then(r => r.text())`, ctx));
  assert.equal(player.adPlacements, undefined);
  assert.deepEqual(player.playerAds, [3]);
  const next = JSON.parse(await vm.runInContext(`fetch("https://www.youtube.com/youtubei/v1/next").then(r => r.text())`, ctx));
  assert.deepEqual(next.adPlacements, [1]);
});

test("trusted-replace-xhr-response rewrites matching XHR text", () => {
  class FakeXhr {
    open(method, url) {
      this.url = url;
    }
    get readyState() {
      return 4;
    }
    get responseType() {
      return "";
    }
    get responseText() {
      return '{"adPlacements":[1],"ok":1}';
    }
    get response() {
      return this.responseText;
    }
  }
  const ctx = page(
    "tv.youtube.com",
    `tv.youtube.com##+js(trusted-replace-xhr-response, '"adPlacements"', '"no_ads"', /\\/player(?:\\?.+)?$/)`,
    { XMLHttpRequest: FakeXhr }
  );
  const text = vm.runInContext(
    `const x = new XMLHttpRequest(); x.open("POST", "https://tv.youtube.com/youtubei/v1/player?k=1"); x.responseText`,
    ctx
  );
  assert.equal(text, '{"no_ads":[1],"ok":1}');
});

test("exceptions and untrusted sources", () => {
  const filters = [
    "example.com##+js(set, a, false)",
    "sub.example.com#@#+js(set, a, false)",
    "other.com##+js(set, b, false)",
    "other.com#@#+js()",
  ].join("\n");
  assert.equal(vm.runInContext("typeof a", page("example.com", filters)), "boolean");
  assert.equal(vm.runInContext("typeof a", page("sub.example.com", filters)), "undefined");
  assert.equal(vm.runInContext("typeof b", page("other.com", filters)), "undefined");

  const { stats } = parseScriptletFilters([
    { text: "x.com##+js(trusted-replace-fetch-response, a, b, c)", trusted: false },
  ]);
  assert.equal(stats.skipped["untrusted-source"], 1);
});

test("nano-stb shortens YouTube's ad wait timer only", () => {
  const calls = [];
  const ctx = page("www.youtube.com", "www.youtube.com##+js(nano-stb, [native code], 17000, 0.001)", {
    setTimeout: (cb, ms) => calls.push(ms),
  });
  vm.runInContext("setTimeout(function(){}.bind(null), 17000); setTimeout(() => 1, 17000); setTimeout(function(){}.bind(null), 500)", ctx);
  assert.deepEqual(calls, [17, 17000, 500]);
});

test("trusted-prevent-dom-bypass gives appended iframes this page's fetch", () => {
  const frameWin = { location: { href: "about:blank" }, fetch: "pristine", JSON: { parse: "pristine" } };
  const iframe = { nodeName: "IFRAME", contentWindow: frameWin };
  const Node = function () {};
  Node.prototype.appendChild = (n) => n;
  const ctx = page(
    "www.youtube.com",
    [
      "www.youtube.com##+js(trusted-prevent-dom-bypass, Node.prototype.appendChild, fetch)",
      "www.youtube.com##+js(trusted-prevent-dom-bypass, Node.prototype.appendChild, JSON.parse)",
    ].join("\n"),
    { Node, fetch: "hooked" }
  );
  vm.runInContext("JSON.parse = 'hookedParse'", ctx);
  ctx.Node.prototype.appendChild.call({}, iframe);
  assert.equal(frameWin.fetch, "hooked");
  assert.equal(frameWin.JSON.parse, "hookedParse");
});

test("rpnt rewrites matching inline scripts; untrusted lists cannot use it", () => {
  const script = { nodeName: "SCRIPT", src: "", textContent: "if (window.ytcsi) { start(); }" };
  let observerCallback;
  const ctx = page(
    "www.youtube.com",
    "www.youtube.com##+js(rpnt, script, /^if \\(window\\.ytcsi/, patched();$&, sedCount, 1)",
    {
      MutationObserver: class {
        constructor(cb) {
          observerCallback = cb;
        }
        observe() {}
        disconnect() {}
      },
      document: { documentElement: {}, querySelectorAll: () => [] },
    }
  );
  observerCallback([{ addedNodes: [script] }]);
  assert.equal(script.textContent, "patched();if (window.ytcsi) { start(); }");
  assert.ok(ctx);

  const { stats } = parseScriptletFilters([{ text: "x.com##+js(rpnt, script, a, b)", trusted: false }]);
  assert.equal(stats.skipped["untrusted-source"], 1);
});

test("rpnt also catches a <script> whose text is added after the element", () => {
  const script = { nodeName: "SCRIPT", src: "", textContent: "" };
  const textNode = { nodeType: 3, parentNode: script };
  let observerCallback;
  page(
    "www.youtube.com",
    "www.youtube.com##+js(rpnt, script, /^if \\(window\\.ytcsi/, patched();$&, sedCount, 1, condition, js_ld)",
    {
      MutationObserver: class {
        constructor(cb) {
          observerCallback = cb;
        }
        observe() {}
        disconnect() {}
      },
      document: { documentElement: {}, querySelectorAll: () => [] },
    }
  );
  observerCallback([{ addedNodes: [script] }]); // element first, still empty
  script.textContent = "if (window.ytcsi) { js_ld(); }";
  observerCallback([{ addedNodes: [textNode] }]); // then its text
  assert.equal(script.textContent, "patched();if (window.ytcsi) { js_ld(); }");
});

test("trusted-edit-inbound-object edits a copy of matching JSON.stringify arguments", () => {
  const ctx = page(
    "www.youtube.com",
    [
      `www.youtube.com##+js(trusted-edit-inbound-object, JSON.stringify, 0, [?.attestationRequest][?.context.client.userAgent*="channel"].context.client[?.clientName=="WEB"]+={"clientScreen":"CHANNEL"})`,
      `www.youtube.com##+js(trusted-edit-inbound-object, JSON.stringify, 0, [?.attestationRequest][?.context.client.userAgent=/adunit|channel/].playbackContext.contentPlaybackContext.referer=repl({"regex":"(?:#reloadxhr)?$"\\,"replacement":"#reloadxhr"}))`,
    ].join("\n")
  );
  const out = vm.runInContext(
    `const body = { context: { client: { clientName: "WEB", userAgent: "Mozilla/5.0 (Mac; channel)" } },
       playbackContext: { contentPlaybackContext: { referer: "https://www.youtube.com/watch?v=x" } }, attestationRequest: {} };
     const s = JSON.stringify(body);
     JSON.stringify({ sent: JSON.parse(s), original: body, other: JSON.stringify({ a: 1 }) })`,
    ctx
  );
  const { sent, original, other } = JSON.parse(out);
  assert.equal(sent.context.client.clientScreen, "CHANNEL");
  assert.equal(sent.playbackContext.contentPlaybackContext.referer, "https://www.youtube.com/watch?v=x#reloadxhr");
  assert.equal(original.context.client.clientScreen, undefined, "page object untouched");
  assert.equal(other, '{"a":1}');
});

test("rpnt writes script text through a Trusted Types policy when the site requires it", () => {
  const script = { nodeName: "SCRIPT", src: "", textContent: "if (window.ytcsi) { js_ld(); }" };
  let observerCallback;
  const created = [];
  page(
    "www.youtube.com",
    "www.youtube.com##+js(rpnt, script, /^if \\(window\\.ytcsi/, patched();$&, sedCount, 1)",
    {
      trustedTypes: {
        createPolicy: (name, rules) => ({ createScript: (s) => (created.push(name), { trusted: rules.createScript(s) }) }),
      },
      MutationObserver: class {
        constructor(cb) {
          observerCallback = cb;
        }
        observe() {}
        disconnect() {}
      },
      document: { documentElement: {}, querySelectorAll: () => [] },
    }
  );
  observerCallback([{ addedNodes: [script] }]);
  assert.deepEqual(created, ["localblock"]);
  assert.deepEqual(script.textContent, { trusted: "patched();if (window.ytcsi) { js_ld(); }" });
});

test("nowoif returns a fake window for matching popups only", () => {
  const opened = [];
  const ctx = page("stream.example", "stream.example##+js(nowoif, /adserv|popunder/)", {
    open: (url) => (opened.push(url), { real: true }),
  });
  const fake = vm.runInContext(`window.open("https://adserv.example/x")`, ctx);
  assert.equal(fake.closed, false);
  assert.doesNotThrow(() => fake.focus());
  vm.runInContext(`window.open("https://stream.example/next")`, ctx);
  assert.deepEqual(opened, ["https://stream.example/next"]);
});

test("aopr and aopw stop scripts that touch a property", () => {
  const ctx = page("site.example", ["site.example##+js(aopr, popAds.init)", "site.example##+js(aopw, adBlockDetected)"].join("\n"));
  vm.runInContext("window.popAds = { init() { return 'ran'; } }", ctx);
  assert.throws(() => vm.runInContext("popAds.init()", ctx), /LocalBlock/);
  assert.throws(() => vm.runInContext("window.adBlockDetected = true", ctx), /LocalBlock/);
});

test("acs aborts only scripts whose text matches", () => {
  let current = { src: "", textContent: "" };
  const ctx = page("site.example", "site.example##+js(acs, document.createElement, popunder)", {
    document: {
      createElement: () => "el",
      get currentScript() {
        return current;
      },
    },
  });
  current = { src: "", textContent: "var x = popunder();" };
  assert.throws(() => vm.runInContext("document.createElement('a')", ctx), /LocalBlock/);
  current = { src: "", textContent: "normal site code" };
  assert.equal(vm.runInContext("document.createElement('a')", ctx), "el");
});

test("nostif and aeld drop matching timers and listeners", () => {
  const timers = [];
  const listeners = [];
  function EventTarget() {}
  EventTarget.prototype.addEventListener = function (type) {
    listeners.push(type);
  };
  const ctx = page(
    "site.example",
    ["site.example##+js(nostif, location.href)", "site.example##+js(aeld, click, popMagic)"].join("\n"),
    { setTimeout: (cb, ms) => timers.push(ms), EventTarget }
  );
  vm.runInContext("setTimeout(() => { location.href = 'https://ad.example'; }, 3000); setTimeout(() => 1, 100)", ctx);
  assert.deepEqual(timers, [100]);
  vm.runInContext(
    "const t = new EventTarget(); t.addEventListener('click', function () { popMagic.go(); }); t.addEventListener('click', () => 'menu')",
    ctx
  );
  assert.deepEqual(listeners, ["click"]);
});
