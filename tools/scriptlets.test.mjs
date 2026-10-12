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
