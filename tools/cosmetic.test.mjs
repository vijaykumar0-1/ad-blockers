import { test } from "node:test";
import assert from "node:assert/strict";
import { compileCosmetic, selectorKey } from "./cosmetic.mjs";
import { hostCandidates, pagePlan, selectorsForTokens, toCss } from "../src/cosmetic-lookup.js";

const list = [
  "! comment",
  "##.ad-banner",
  "###sidebar-ad > div",
  "##div[id^='div-gpt-ad']",
  "##.sponsored",
  "news.com##.promo-box",
  "news.com#@#.sponsored",
  "#@#.ad-banner-allowed",
  "##.ad-banner-allowed",
  "shop.com,~help.shop.com##.deal-ad",
  "~quiet.com##.popup-ad",
  "google.*##.g-ad",
  "site.com#?#div:has(> .ad)",
  "site.com#?#div:-abp-contains(Sponsored)",
  "site.com##+js(set, ads, false)",
  "@@||clean.com^$generichide",
  "@@||bare.com^$elemhide",
  "||ads.example.com^",
].join("\n");

const { data, stats } = compileCosmetic([list]);

test("selector keys", () => {
  assert.equal(selectorKey(".ad-banner"), ".ad-banner");
  assert.equal(selectorKey("#sidebar-ad > div"), "#sidebar-ad");
  assert.equal(selectorKey(".a.b"), ".a");
  assert.equal(selectorKey("div.ad"), null);
  assert.equal(selectorKey("[id^='ad']"), null);
  assert.equal(selectorKey(".a, .b"), null);
});

test("compiles generic, specific and exceptions", () => {
  assert.deepEqual(data.generic.keyed[".ad-banner"], [".ad-banner"]);
  assert.deepEqual(data.generic.keyed["#sidebar-ad"], ["#sidebar-ad > div"]);
  assert.deepEqual(data.generic.unkeyed, ["div[id^='div-gpt-ad']"]);
  assert.equal(data.generic.keyed[".ad-banner-allowed"], undefined, "generic exception removes it");
  assert.deepEqual(data.specific["news.com"], [".promo-box"]);
  assert.deepEqual(data.specific["site.com"], ["div:has(> .ad)"]);
  assert.deepEqual(data.genericHide, ["clean.com"]);
  assert.deepEqual(data.elemHide, ["bare.com"]);
  assert.equal(stats.skipped.procedural, 1);
  assert.equal(stats.skipped.scriptlet, 1);
});

test("page plans respect exceptions and switches", () => {
  const news = pagePlan(data, "www.news.com");
  assert.ok(news.selectors.includes(".promo-box"));
  assert.deepEqual(selectorsForTokens(data, [".sponsored"], news), [], "news.com#@#.sponsored");
  assert.deepEqual(selectorsForTokens(data, [".sponsored"], pagePlan(data, "other.com")), [".sponsored"]);

  assert.ok(pagePlan(data, "shop.com").selectors.includes(".deal-ad"));
  assert.ok(!pagePlan(data, "help.shop.com").selectors.includes(".deal-ad"));
  assert.deepEqual(selectorsForTokens(data, [".popup-ad"], pagePlan(data, "quiet.com")), []);

  assert.ok(pagePlan(data, "www.google.co.uk").selectors.includes(".g-ad"));

  const clean = pagePlan(data, "clean.com");
  assert.equal(clean.generic, false);
  assert.ok(!clean.selectors.includes("div[id^='div-gpt-ad']"));
  assert.equal(pagePlan(data, "bare.com"), null);
});

test("host candidates and css", () => {
  assert.ok(hostCandidates("a.b.example.com").includes("example.com"));
  assert.ok(hostCandidates("example.co.uk").includes("example.*"));
  assert.equal(toCss([".a", "#b"]), ".a{display:none!important}\n#b{display:none!important}");
});

import { parseAction } from "./cosmetic.mjs";
import vm from "node:vm";
import { readFileSync } from "node:fs";

test("procedural operators: :style, :remove-attr, :remove-class, :watch-attr", () => {
  assert.deepEqual(parseAction('div[id="pi-step-play"]:style(display:block !important)'), {
    t: "style",
    s: 'div[id="pi-step-play"]',
    a: "display:block !important",
  });
  assert.deepEqual(parseAction(".pi-btn--play.pi-btn:remove-attr(disabled)"), {
    t: "remove-attr",
    s: ".pi-btn--play.pi-btn",
    a: "disabled",
  });
  assert.deepEqual(parseAction(".pi-btn--play.pi-btn:watch-attr(disabled):remove-class(is-locked)"), {
    t: "remove-class",
    s: ".pi-btn--play.pi-btn",
    a: "is-locked",
    w: "disabled",
  });
  assert.equal(parseAction("div:style(background:url(https://evil.example/x))"), null, "no url() in styles");
  assert.equal(parseAction("div:has-text(Ad):remove-attr(x)"), null, "selector must be plain CSS");

  const { data } = compileCosmetic([
    [
      "hianime.ms###pi-step-ad",
      'hianime.ms##div[id="pi-step-play"]:style(display:block !important)',
      "hianime.ms##.pi-btn--play.pi-btn:remove-attr(disabled)",
      "hianime.ms##.pi-btn--play.pi-btn:watch-attr(disabled):remove-class(is-locked)",
      "##.generic:remove-attr(x)", // generic procedural filters are not supported
    ].join("\n"),
  ]);
  const plan = pagePlan(data, "hianime.ms");
  assert.ok(plan.selectors.includes("#pi-step-ad"));
  assert.deepEqual(plan.styles, ['div[id="pi-step-play"]{display:block !important}']);
  assert.equal(plan.actions.length, 2);
  assert.deepEqual(pagePlan(data, "other.example").actions, []);
});

test("content script unlocks the player and keeps it unlocked", async () => {
  // A tiny fake DOM: one play button the site keeps locking.
  const button = {
    attrs: new Map([["disabled", ""], ["class", "pi-btn pi-btn--play is-locked"]]),
    classSet: new Set(["pi-btn", "pi-btn--play", "is-locked"]),
    getAttributeNames() { return [...this.attrs.keys()]; },
    hasAttribute(n) { return this.attrs.has(n); },
    removeAttribute(n) { this.attrs.delete(n); },
    get classList() {
      const set = this.classSet;
      return { [Symbol.iterator]: () => set.values(), contains: (c) => set.has(c), remove: (c) => set.delete(c), length: set.size };
    },
  };
  const observers = [];
  const actions = [
    { t: "remove-attr", s: ".pi-btn--play.pi-btn", a: "disabled" },
    { t: "remove-class", s: ".pi-btn--play.pi-btn", a: "is-locked", w: "disabled" },
  ];
  const ctx = {
    globalThis: {},
    setTimeout: (fn) => Promise.resolve().then(fn),
    MutationObserver: class {
      constructor(cb) { this.cb = cb; observers.push(this); }
      observe() {}
      disconnect() {}
    },
    document: {
      documentElement: { nodeType: 1, querySelectorAll: () => [] },
      querySelectorAll: (sel) => (sel === ".pi-btn--play.pi-btn" ? [button] : []),
    },
    chrome: {
      runtime: {
        sendMessage: async (msg) => (msg.type === "cosmetic:page" ? { ok: true, result: { active: true, actions } } : { ok: true }),
      },
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(readFileSync(new URL("../src/cosmetic.js", import.meta.url), "utf8"), ctx);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(button.hasAttribute("disabled"), false, "unlocked");
  assert.equal(button.classSet.has("is-locked"), false);
  // The site locks it again; the watcher undoes it.
  button.attrs.set("disabled", "");
  button.classSet.add("is-locked");
  observers.at(-1).cb([]);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(button.hasAttribute("disabled"), false, "re-unlocked");
  assert.equal(button.classSet.has("is-locked"), false);
});
